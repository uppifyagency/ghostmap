/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Content Script (Manual Scrolling Mode)
 * User scrolls manually, we just observe and capture data
 */

import { DOMObserver } from './observer.js';
import { CONFIG, loadConfig } from '../../lib/config.js';
import { createBusinessFoundDedupe } from '../../lib/businessFoundGuards.js';
import { logger } from '../../lib/utils.js';

logger.info('Content script loaded');

// State
let observer = null;
let isMonitoring = false;
const businessFoundDedupe = createBusinessFoundDedupe();

/**
 * Initialize observer
 */
function initialize() {
    if (observer) {
        // Expected on SPA re-inject / area-search tab reuse — not an extension fault.
        // console.warn is surfaced on chrome://extensions → Errors; keep at debug.
        logger.debug('Observer already initialized');
        return;
    }

    try {
        observer = new DOMObserver(CONFIG, handleNewBusiness);
        logger.info('Observer initialized');
    } catch (error) {
        logger.error('Failed to initialize observer:', error);
    }
}

/**
 * Start monitoring
 */
function startMonitoring() {
    if (!observer) {
        initialize();
    }

    if (isMonitoring) {
        logger.info('Already monitoring');
        return { status: 'already_running' };
    }

    try {
        observer.start();
        isMonitoring = true;
        logger.info('Monitoring started - Scroll manually to discover businesses');

        return { status: 'started' };
    } catch (error) {
        logger.error('Failed to start monitoring:', error);
        return { status: 'error', error: error.message };
    }
}

/**
 * Stop monitoring
 */
function stopMonitoring() {
    if (!isMonitoring) {
        return { status: 'not_running' };
    }

    try {
        if (observer) {
            observer.stop();
        }
        isMonitoring = false;
        logger.info('Monitoring stopped');

        return { status: 'stopped', stats: observer?.getStats() };
    } catch (error) {
        logger.error('Failed to stop monitoring:', error);
        return { status: 'error', error: error.message };
    }
}

// B12-5 FIX (2026-05-29): removed dead helpers getStatus() and reset() — their
// only callers were the deprecated 'get_status'/'reset' message cases (also
// removed below). Audited 2026-05-07 as DevTools-console-only with no UI caller;
// a repo-wide grep confirmed zero senders before removal.

// ─── B2-7 FIX: localStorage queue for failed business sends ──────────────
// Pre-fix: if all 3 sendMessage retries failed (200+400+800ms = 1.4s),
// the business was lost silently. Most common cause: SW eviction during
// scrape burst (race window between SW dying and SW being woken up).
// Fix: persist failed sends to localStorage queue, drain on next success
// + periodic interval + visibilitychange + module load.
//
// Cap: 100 entries (~100KB JSON, well below 5MB localStorage quota).
// Single-flight via _flushing flag to avoid concurrent flush RMW races.
const PENDING_BUSINESSES_KEY = 'gmp:pending_businesses';
const PENDING_BUSINESSES_CAP = 100;
let _flushingPendingBusinesses = false;

// ─── S4 FIX (2026-08-18): cross-tab lock for every queue RMW ──────────────
// The single-flight flag above is PER-TAB. With 2 Maps tabs on the same
// origin, tab A's flush (read → send → rewrite) raced tab B's append
// (read-modify-write): whichever wrote last erased the other's entries.
// Fix: every read-modify-write of the key — append AND the flush's final
// write — runs under an exclusive, origin-scoped Web Lock (navigator.locks:
// cross-tab, FIFO grant order, auto-released if the holding tab dies).
// The lock is held ONLY around the synchronous localStorage sections, never
// across the sendMessage awaits — otherwise a concurrent tab's append would
// block for minutes during a drain (and be lost if that tab closed while
// waiting). Data format is unchanged (compatible with queues already
// persisted by older versions).
// Fallback: if navigator.locks is unavailable (very old Chrome / exotic
// context), run the section directly — exactly the pre-S4 per-tab behavior.
const PENDING_BUSINESSES_LOCK = 'gmp:pending_businesses:lock';
async function _withQueueLock(fn) {
    const locks = globalThis.navigator?.locks;
    if (!locks || typeof locks.request !== 'function') return fn();
    let started = false;
    try {
        return await locks.request(PENDING_BUSINESSES_LOCK, () => {
            started = true;
            return fn();
        });
    } catch (err) {
        if (started) throw err; // fn itself threw — propagate
        // Lock machinery failed before running fn (e.g. document not fully
        // active) — degrade to the per-tab behavior rather than lose data.
        return fn();
    }
}

function _readPendingBusinesses() {
    try {
        const raw = localStorage.getItem(PENDING_BUSINESSES_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        // localStorage unavailable (private browsing) or corrupt JSON.
        // Degrade silently — queue is best-effort.
        return [];
    }
}

function _writePendingBusinesses(arr) {
    try {
        // Cap to prevent quota exceeded. FIFO drop: keep last N entries
        // (newer entries more likely to still be relevant).
        const capped = arr.length > PENDING_BUSINESSES_CAP
            ? arr.slice(arr.length - PENDING_BUSINESSES_CAP)
            : arr;
        localStorage.setItem(PENDING_BUSINESSES_KEY, JSON.stringify(capped));
    } catch (err) {
        // Quota exceeded or localStorage disabled — degrade silently.
        // (We could clear the entire queue here, but that would cause more
        // data loss than just letting subsequent writes fail.)
    }
}

function _appendPendingBusiness(business) {
    // R6 FIX (2026-08-19): write SYNCHRONOUSLY first, reconcile under the
    // lock second.
    // S4 moved this whole read-modify-write inside _withQueueLock, which
    // closed the cross-tab clobber but opened a new loss window: the
    // setItem then happened only after the lock was GRANTED, and every
    // caller is fire-and-forget, so a tab killed while another tab held the
    // lock lost the business entirely — pre-S4 it was already on disk.
    // Durability first: the record hits localStorage in this tick, so a
    // navigation/close/crash from here on cannot lose it.
    const record = { business, ts: Date.now() };
    const pending = _readPendingBusinesses();
    pending.push(record);
    _writePendingBusinesses(pending);
    if (pending.length >= PENDING_BUSINESSES_CAP) {
        logger.warn(`[B2-7] Pending businesses queue at cap (${PENDING_BUSINESSES_CAP}); oldest entries will be dropped`);
    }
    // S4 guarantee, preserved: this sync write is an unlocked RMW, so a
    // concurrent tab's write can still clobber it. Re-read under the lock and
    // restore the record if it is gone. Identity is the JSON of the record
    // ({business, ts} with ms-precision ts).
    // Trade-off (accepted, same reasoning as S4's two-concurrent-flushes
    // case): if the record was legitimately DELIVERED and dequeued inside
    // this window, the reconcile re-appends it and it may be sent twice —
    // benign, because business_found is an idempotent fill-holes upsert that
    // answers 'duplicate' and self-dequeues. Losing it would be irreversible.
    // Returns a promise that never rejects (read/write are fully try/catch'd;
    // lock failures degrade to a direct run) — callers stay fire-and-forget.
    const recordKey = JSON.stringify(record);
    return _withQueueLock(() => {
        const current = _readPendingBusinesses();
        if (!current.some((e) => JSON.stringify(e) === recordKey)) {
            current.push(record);
            _writePendingBusinesses(current);
        }
    });
}

// ─── S3 FIX (2026-08-18): response-status taxonomy ────────────────────────
// Pre-fix, ANY non-exception sendMessage response counted as delivery, so
// application-level error responses from the SW ({status:'init_pending'},
// {status:'error'}) dequeued the business without it ever being saved —
// silent, permanent data loss.
// Taxonomy (from background/index.js handleMessage/handleBusinessFound):
//   DELIVERED (remove from queue):
//     'saved'     — row inserted (~L1556)
//     'duplicate' — row already exists / fill-holes merged (~L1499-1502)
//     'rejected'  — M2-SEC1 sender-validation refusal (~L809). Deterministic:
//                   the same sender gets the same refusal forever, so a retry
//                   can never succeed — dropping is correct (retrying would
//                   only burn cap-100 slots and evict recoverable entries).
//   TRANSIENT (keep in queue for retry):
//     'init_pending' — SW init gate not open after 10s (~L821); NOT saved.
//     'error'        — handler threw (~L1364-1372), e.g. IndexedDB failure
//                      during SW shutdown; plausibly transient.
//     undefined / unknown future statuses — safe default is retry:
//                      business_found is an idempotent fill-holes upsert, so
//                      re-sending an already-saved business returns
//                      'duplicate' (self-healing dequeue), while a wrong
//                      removal is irreversible loss.
const DELIVERED_STATUSES = new Set(['saved', 'duplicate', 'rejected']);
function _isDeliveredResponse(response) {
    return DELIVERED_STATUSES.has(response?.status);
}

async function flushPendingBusinesses() {
    // Single-flight: avoid concurrent RMW races on localStorage.
    if (_flushingPendingBusinesses) return;
    _flushingPendingBusinesses = true;
    try {
        const pending = _readPendingBusinesses();
        if (pending.length === 0) return;

        logger.info(`[B2-7] Draining pending businesses queue: ${pending.length} entries`);
        const remaining = [];
        let processedCount = 0;
        for (const item of pending) {
            processedCount++;
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'business_found',
                    payload: item.business
                });
                // S3 FIX: only a DELIVERED response dequeues. Transient
                // application-level responses (init_pending/error/unknown)
                // are re-queued for the next flush attempt.
                if (!_isDeliveredResponse(response)) {
                    remaining.push(item);
                    if (response?.status === 'init_pending') {
                        // S3 FIX: the SW init gate blocks each send ~10s
                        // (_waitForInit) before answering init_pending —
                        // draining a full queue would hold the single-flight
                        // lock for minutes. Re-queue the rest untouched and
                        // let a later trigger retry.
                        // Expected SW-wake path — use debug (not warn) so
                        // unpacked installs don't light chrome://extensions Errors.
                        logger.debug('[S3] SW init_pending — deferring remaining queue entries');
                        remaining.push(...pending.slice(processedCount));
                        break;
                    }
                }
                // delivered (saved/duplicate) or permanently refused
                // (rejected) — don't re-queue
            } catch (err) {
                // SW still dead — re-queue for next flush attempt.
                remaining.push(item);
            }
        }
        // S4 FIX: the final write is a lock-protected MERGE, not a blind
        // rewrite. Between our snapshot read above and this point, another
        // tab (or this tab's own append path) may have appended entries to
        // the shared key; a blind rewrite with `remaining` would erase them.
        // Under the lock: re-read the key, keep every entry that was NOT in
        // our flushed snapshot (identity by JSON — entries are {business,ts}
        // and ts is ms-precision, so collisions are negligible; a false
        // positive only drops an exact byte-identical duplicate, which is
        // benign because business_found is an idempotent upsert), then write
        // remaining (old, FIFO order preserved) followed by those new
        // appends (newer, so last). _writePendingBusinesses re-applies the
        // cap-100 (drops oldest first). Entries stayed persisted throughout
        // the send phase — a tab killed mid-drain loses nothing (re-sends
        // self-heal as 'duplicate'). Web Locks auto-release if the holding
        // tab dies inside the critical section.
        await _withQueueLock(() => {
            const current = _readPendingBusinesses();
            const flushedSnapshot = new Set(pending.map((e) => JSON.stringify(e)));
            const appendedMeanwhile = current.filter((e) => !flushedSnapshot.has(JSON.stringify(e)));
            remaining.push(...appendedMeanwhile);
            _writePendingBusinesses(remaining);
        });
        if (remaining.length === 0) {
            logger.info('[B2-7] Pending queue drained successfully');
        } else {
            // Expected while SW is waking — debug only (avoid Errors badge noise).
            logger.debug(`[B2-7] Partial drain: ${remaining.length} entries still pending`);
        }
    } finally {
        _flushingPendingBusinesses = false;
    }
}

/**
 * Handle new business found
 */
function handleNewBusiness(business) {
    if (!businessFoundDedupe.shouldSend(business)) {
        logger.debug('Duplicate business observation suppressed:', business?.title);
        return;
    }
    logger.info('New business found:', business?.title);
    // BLOCK-8 FIX (MED-008): Add retry logic for sendMessage with exponential backoff
    const maxRetries = 3;
    const sendWithRetry = async (attempt = 1) => {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'business_found',
                payload: business
            });

            // S3 FIX: a resolved sendMessage is NOT proof of delivery — the
            // SW answers {status:'init_pending'} (init gate, NOT saved) and
            // {status:'error'} (handler threw, NOT saved) as normal
            // resolutions. Queue those for durable retry instead of logging
            // "saved" and dropping the business forever. No in-band backoff
            // here: init_pending already waited ~10s inside the SW's
            // _waitForInit, so an immediate retry adds nothing.
            if (!_isDeliveredResponse(response)) {
                // Expected while SW init/eviction races — queue + retry unchanged.
                // debug (not warn): console.warn surfaces on chrome://extensions Errors.
                logger.debug(`[S3] Non-delivered response (status=${response?.status}); queuing for retry`);
                _appendPendingBusiness(business);
                return;
            }
            logger.debug('Business saved:', response);

            // B2-7 FIX: opportunistic flush on success — if SW just came
            // back online, drain whatever was queued during the outage.
            // Fire-and-forget; flushPendingBusinesses is single-flight.
            flushPendingBusinesses().catch(() => { /* logged inside */ });
        } catch (error) {
            // CO-10 FIX (2026-05-10): the retry-trigger condition was
            // `chrome.runtime.lastError || error.message?.includes('Extension
            // context invalidated')`. Two issues:
            //   1) `chrome.runtime.lastError` is set by Chrome only inside
            //      callback-style sendMessage callbacks. Here we use the
            //      Promise form (`await chrome.runtime.sendMessage(...)`) —
            //      when the Promise rejects, lastError is NOT set, so the
            //      first half of the OR is effectively always false.
            //   2) "Extension context invalidated" is the message thrown
            //      when the extension itself was reloaded/uninstalled.
            //      When the SW is merely evicted (the common transient
            //      case), Chrome rejects with "The message port closed
            //      before a response was received" or
            //      "Could not establish connection. Receiving end does not
            //      exist." Neither matches the substring above, so the
            //      retry path NEVER fired for the most common SW-eviction
            //      transient — the code went straight to
            //      _appendPendingBusiness, which is correct as a fallback
            //      but skipped the in-band 200/400/800 ms backoff that
            //      could have recovered without touching localStorage.
            // Now we recognize the SW-eviction shapes too. We keep the
            // legacy "Extension context invalidated" check for true
            // reload-during-scrape cases.
            const msg = error?.message || '';
            const isTransient = (
                msg.includes('Extension context invalidated')
                || msg.includes('message port closed')
                || msg.includes('Could not establish connection')
                || msg.includes('Receiving end does not exist')
                || chrome.runtime.lastError  // legacy callback-form belt-and-suspenders
            );
            if (isTransient && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 100; // 200ms, 400ms, 800ms
                logger.debug(`sendMessage retry ${attempt}/${maxRetries} in ${delay}ms (${msg.slice(0, 60)})`);
                await new Promise(r => setTimeout(r, delay));
                return sendWithRetry(attempt + 1);
            }
            logger.error('Failed to save business after retries:', error);

            // B2-7 FIX: persist to localStorage queue. Pre-fix this was
            // silent data loss; now it's recoverable on next SW availability.
            _appendPendingBusiness(business);
        }
    };

    sendWithRetry();
}

// ─── B2-7 FIX: kick flush on multiple triggers ───────────────────────────
// (1) Module load — recover any queue from a previous tab session.
// (2) Periodic 60s interval — drains opportunistically without waiting
//     for the next handleNewBusiness call.
// (3) visibilitychange to 'visible' — covers tab close/reopen scenarios
//     where the user closed the tab mid-scrape.
// (4) CO-5 FIX (2026-05-10): pagehide / beforeunload — clear the interval
//     when the tab is about to be discarded so we don't leave a 60-s tick
//     queued in the tab's task queue right before Chrome reclaims it.
//     Pre-fix the interval was started at module load and never cleared
//     anywhere; on long Maps sessions (multi-hour open tab) it fired
//     ~60 times/hour even after the user clicked Stop, each tick reading
//     the localStorage queue and attempting sendMessage to the SW.
// All triggers go through the single-flight flushPendingBusinesses().
flushPendingBusinesses().catch(() => { });
const _pendingBusinessesFlushInterval = setInterval(() => {
    flushPendingBusinesses().catch(() => { });
}, 60000);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        flushPendingBusinesses().catch(() => { });
    }
});

// CO-5: tear down the interval on tab unload so we don't have a dangling
// task fired while Chrome is discarding the content-script context.
// `pagehide` is preferred over `beforeunload` (Safari/Chrome both fire
// it on bfcache + close); we still register beforeunload as a fallback.
function _teardownFlushInterval() {
    try {
        clearInterval(_pendingBusinessesFlushInterval);
        // One last opportunistic flush before the tab disappears.
        flushPendingBusinesses().catch(() => {});
    } catch { /* the page is being torn down — nothing to do */ }
}
window.addEventListener('pagehide', _teardownFlushInterval, { once: true });
window.addEventListener('beforeunload', _teardownFlushInterval, { once: true });

/**
 * Message listener
 * AUDIT FIX #2: Ignore offscreen-targeted messages to prevent race condition
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // AUDIT FIX #2: Ignore messages targeted to offscreen document
    if (message.target === 'offscreen') {
        return false; // Not for us
    }

    // Ignore internal messages that are not for this content script
    if (message.action === 'parse_html' || message.action === 'ping') {
        return false; // Don't respond
    }

    logger.debug('Message received:', message.action);

    try {
        let response;

        switch (message.action) {
            case 'start_scraping':
                response = startMonitoring();
                break;

            case 'stop_scraping':
                response = stopMonitoring();
                break;

            // B12-5 FIX (2026-05-29): removed deprecated cases 'force_collect_all',
            // 'get_status', 'reset' (audited 2026-05-07 as DevTools-only, zero UI
            // callers; repo-wide grep confirmed zero senders). start/stop_scraping
            // are the live message contract.

            default:
                // Don't respond to unknown actions to avoid race conditions
                return false;
        }

        sendResponse(response);
    } catch (error) {
        logger.error('Message handler error:', error);
        sendResponse({ status: 'error', error: error.message });
    }

    return true; // Keep channel open for async responses
});

// Auto-initialize on load.
// Forensic #12 (2026-06-11): loadConfig() was never invoked ANYWHERE, so any
// userConfig.selectors override saved by the settings UI was dead. CONFIG.selectors
// is consumed HERE in the content-script context (observer.js getElements(
// CONFIG.selectors.businessLink, ...)), NOT in the service worker — the two run
// in separate JS realms with separate CONFIG instances, so calling loadConfig()
// in the SW (the report's first suggestion) would have been a no-op for DOM
// extraction. We invoke it here and merge BEFORE constructing the observer.
// loadConfig() mutates CONFIG.selectors in place via safeMerge (prototype-
// pollution-safe), so the captured CONFIG reference sees the overrides.
//
// KNOWN LIMITATION: only CONFIG.selectors.businessLink is consumed by the content script; scrollContainer and businessCard remain configuration defaults but are not consumed by the current content-script runtime.
(async () => {
    try {
        await loadConfig();
    } catch (err) {
        logger.warn(`[CONFIG] loadConfig() failed, using defaults: ${err?.message || err}`);
    }
    initialize();
})();

logger.info('Content script ready');
