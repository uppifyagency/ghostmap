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
import { logger } from '../../lib/utils.js';

logger.info('Content script loaded');

// State
let observer = null;
let isMonitoring = false;

/**
 * Initialize observer
 */
function initialize() {
    if (observer) {
        logger.warn('Observer already initialized');
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
    const pending = _readPendingBusinesses();
    pending.push({ business, ts: Date.now() });
    _writePendingBusinesses(pending);
    if (pending.length >= PENDING_BUSINESSES_CAP) {
        logger.warn(`[B2-7] Pending businesses queue at cap (${PENDING_BUSINESSES_CAP}); oldest entries will be dropped`);
    }
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
        for (const item of pending) {
            try {
                await chrome.runtime.sendMessage({
                    action: 'business_found',
                    payload: item.business
                });
                // success — don't re-queue
            } catch (err) {
                // SW still dead — re-queue for next flush attempt.
                remaining.push(item);
            }
        }
        _writePendingBusinesses(remaining);
        if (remaining.length === 0) {
            logger.info('[B2-7] Pending queue drained successfully');
        } else {
            logger.warn(`[B2-7] Partial drain: ${remaining.length} entries still pending`);
        }
    } finally {
        _flushingPendingBusinesses = false;
    }
}

/**
 * Handle new business found
 */
function handleNewBusiness(business) {
    logger.info('New business found:', business.title);

    // BLOCK-8 FIX (MED-008): Add retry logic for sendMessage with exponential backoff
    const maxRetries = 3;
    const sendWithRetry = async (attempt = 1) => {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'business_found',
                payload: business
            });
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
                logger.warn(`sendMessage retry ${attempt}/${maxRetries} in ${delay}ms (${msg.slice(0, 60)})`);
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
// KNOWN LIMITATION (flagged for product decision, see FINDINGS): the settings
// UI currently exposes title/phone/website/address selector fields, but those
// keys are NOT consumed anywhere (SelectorEngine uses its own hardcoded
// strategies; only businessLink/scrollContainer/businessCard are read here).
// Wiring loadConfig() makes the MECHANISM real for the consumed keys; making
// the 4 UI fields effective is a separate feature (or they should be removed).
(async () => {
    try {
        await loadConfig();
    } catch (err) {
        logger.warn(`[CONFIG] loadConfig() failed, using defaults: ${err?.message || err}`);
    }
    initialize();
})();

logger.info('Content script ready');
