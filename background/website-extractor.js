/**
 * =====================================================
 * WEBSITE EXTRACTOR - Gets websites from GMB detail pages
 * =====================================================
 * 
 * PROBLEM: Hotels don't show website in list view, only in detail panel.
 * SOLUTION: Visit each GMB URL and extract website from detail page.
 * 
 * This module should be integrated into the email scraping flow.
 */

import { logger } from '../lib/utils.js';
import { updateBusiness, getBusinessesWithoutWebsite } from '../lib/db.js';
import { createSessionState } from '../lib/swState.js';

// =====================================================
// CONFIGURATION
// =====================================================

// SW-EVICTION-SAFE: const literal of config values, no mutation, no state.
const WEBSITE_EXTRACTION_CONFIG = {
    pageLoadWait: 3000,      // Wait for GMB page to load
    extractionTimeout: 8000, // Max time to wait for extraction
    batchSize: 5,            // Process 5 at a time
    delayBetween: 1000,      // Delay between extractions
    concurrency: 3           // Parallel tabs (FLAW-008)
};

// =====================================================
// STATE MANAGEMENT — MV3 SW EVICTION-SAFE (B5-1 fix)
// =====================================================
//
// The previous `let websiteExtractionState = {…}` was top-level mutable state
// lost on SW eviction (HANDOFF_ULTRAREVIEW_BLOCKS.md B5-1 P0). Symptom: a
// long-running website-extraction batch could be silently killed mid-flight
// when Chrome evicted the SW (~30s idle); workers + local `queue` array died
// with the function call, but UI still displayed "Running 30/100" because the
// last broadcast was pre-eviction.
//
// Fix: persist {isRunning, isPaused, shouldStop} via chrome.storage.session
// (eviction-safe, ephemeral). At module load, top-level await restores state;
// if isRunning was true at eviction time, respawn extractMissingWebsites() —
// safe because getBusinessesWithoutWebsite() is idempotent and the DB IS the
// queue (no need to persist the queue array separately).

// SW-EVICTION-SAFE: frozen literal, no mutable state.
const STATE_DEFAULTS = Object.freeze({
    isRunning: false,
    isPaused: false,
    shouldStop: false
});

// SW-EVICTION-SAFE: thin handle around chrome.storage.session — no in-memory mutable fields.
const websiteExtractionStateAPI = createSessionState(
    'website_extraction.state',
    { ...STATE_DEFAULTS }
);

// In-memory mirror updated via chrome.storage.onChanged listener so the hot
// worker loop can do sync reads instead of `await api.get()` per iteration
// (100 storage reads per 100-business batch ≈ 10 ms — non-fatal but avoidable).
// The mirror is always behind the storage truth by at most one onChanged tick;
// the worker tolerates that (a missed shouldStop=true delays exit by ≤ 1 iter).
// At eviction the mirror dies with the module; on wake the top-level await
// in _restoreAndMaybeRespawn re-syncs it from storage before any consumer reads.
// SW-EVICTION-SAFE: stale-tolerant cache in front of chrome.storage.session.
let _stateCache = { ...STATE_DEFAULTS };

function _installStateMirror() {
    if (typeof chrome === 'undefined' || !chrome?.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'session') return;
        const change = changes['website_extraction.state'];
        if (!change) return;
        if (change.newValue && typeof change.newValue === 'object') {
            _stateCache = {
                isRunning: !!change.newValue.isRunning,
                isPaused: !!change.newValue.isPaused,
                shouldStop: !!change.newValue.shouldStop
            };
        } else {
            _stateCache = { ...STATE_DEFAULTS };
        }
    });
}
_installStateMirror();

/**
 * Pause website extraction
 */
export async function pauseWebsiteExtraction() {
    const s = await websiteExtractionStateAPI.get();
    if (s.isRunning) {
        await websiteExtractionStateAPI.patch({ isPaused: true });
        _stateCache.isPaused = true;
        logger.info('[WEBSITE EXTRACTOR] Paused by user');
        chrome.runtime.sendMessage({
            action: 'website_extraction_paused'
        }).catch(() => { });
        return { status: 'paused' };
    }
    return { status: 'not_running' };
}

/**
 * Resume website extraction
 */
export async function resumeWebsiteExtraction() {
    const s = await websiteExtractionStateAPI.get();
    if (s.isPaused) {
        await websiteExtractionStateAPI.patch({ isPaused: false });
        _stateCache.isPaused = false;
        logger.info('[WEBSITE EXTRACTOR] Resumed by user');
        chrome.runtime.sendMessage({
            action: 'website_extraction_resumed'
        }).catch(() => { });
        return { status: 'resumed' };
    }
    return { status: 'not_paused' };
}

/**
 * Stop website extraction completely
 */
export async function stopWebsiteExtraction() {
    await websiteExtractionStateAPI.patch({ shouldStop: true, isPaused: false });
    _stateCache.shouldStop = true;
    _stateCache.isPaused = false;
    logger.info('[WEBSITE EXTRACTOR] Stopped by user');
    return { status: 'stopped' };
}

/**
 * Get website extraction status (UI poll)
 */
export async function getWebsiteExtractionStatus() {
    const s = await websiteExtractionStateAPI.get();
    return {
        isRunning: !!s.isRunning,
        isPaused: !!s.isPaused
    };
}

// =====================================================
// MAIN FUNCTION: Extract websites for businesses missing them
// =====================================================

/**
 * Extract websites from Google Maps for businesses that don't have one
 * @returns {Promise<{processed: number, found: number, errors: number}>}
 */
export async function extractMissingWebsites() {
    logger.info('[WEBSITE EXTRACTOR] Starting extraction for businesses without websites...');

    const stats = { processed: 0, found: 0, errors: 0 };

    // Reset state — eviction-safe via chrome.storage.session.
    // _stateCache is the sync mirror used in the hot worker loop; storage
    // is the truth and is updated atomically here.
    await websiteExtractionStateAPI.set({
        isRunning: true,
        isPaused: false,
        shouldStop: false
    });
    _stateCache = { isRunning: true, isPaused: false, shouldStop: false };

    try {
        // Get businesses without website (idempotent; survives eviction-respawn)
        const businesses = await getBusinessesWithoutWebsite();

        if (!businesses || businesses.length === 0) {
            logger.info('[WEBSITE EXTRACTOR] No businesses without website found');
            await websiteExtractionStateAPI.set({ ...STATE_DEFAULTS });
            _stateCache = { ...STATE_DEFAULTS };
            return stats;
        }

        logger.info(`[WEBSITE EXTRACTOR] Found ${businesses.length} businesses without website`);

        // Broadcast initial progress
        chrome.runtime.sendMessage({
            action: 'website_extraction_progress',
            payload: {
                current: 0,
                total: businesses.length,
                currentItem: 'Starting extraction...'
            }
        }).catch(() => { });

        // Process in parallel using worker pool (FLAW-008)
        const queue = [...businesses]; // Create queue
        const total = businesses.length;
        let completed = 0;

        // B5-5 fix: shared circuit-breaker counter across workers. JS is
        // single-threaded so async cooperative concurrency makes this counter
        // safely shared via closure capture. On 5 consecutive failures (e.g.,
        // Maps rate-limit, login wall, sustained CAPTCHA), we abort the batch
        // by writing shouldStop=true to storage AND _stateCache, broadcast a
        // progress message explaining the abort, and let the workers drain.
        //
        // BG-11 FIX (2026-05-10): pre-fix this used a SINGLE shared closure
        // variable `let consecutiveFailures = 0`, written by both the success
        // (=0) and failure (++) paths across N concurrent workers. A success
        // in one worker would reset the counter to 0, erasing the alarm
        // signal from N simultaneous failures in other workers. Net effect:
        // when Maps started rate-limiting, the breaker rarely tripped.
        //
        // Now per-worker counters via Map<workerId, count>. Reset on success
        // only for the same worker; abort fires when ANY worker accumulates
        // MAX_CONSECUTIVE_FAILURES consecutive errors itself. Real-world
        // rate-limit affects all workers ~simultaneously, so the per-worker
        // counters all rise together and the breaker still trips quickly —
        // but transient hiccups in a single worker don't get masked by
        // unrelated successes elsewhere.
        const MAX_CONSECUTIVE_FAILURES = 5;
        const workerFailures = new Map();

        const worker = async (workerId) => {
            while (queue.length > 0) {
                // Check for stop signal — sync read from in-memory mirror
                // updated by chrome.storage.onChanged listener.
                if (_stateCache.shouldStop) break;

                // Check for pause - wait until resumed
                while (_stateCache.isPaused && !_stateCache.shouldStop) {
                    await sleep(500);
                }

                if (_stateCache.shouldStop) break;

                const business = queue.shift();
                if (!business) break;

                try {
                    completed++;
                    const index = total - queue.length - 1; // Approx index

                    logger.info(`[WEBSITE EXTRACTOR] Worker ${workerId} processing: ${business.title} (${completed}/${total})`);

                    // Broadcast progress
                    chrome.runtime.sendMessage({
                        action: 'website_extraction_progress',
                        payload: {
                            current: completed,
                            total: total,
                            currentItem: `${business.title} (Worker ${workerId})`
                        }
                    }).catch(() => { });

                    const website = await extractWebsiteFromGMB(business.googleMapsUrl);

                    if (website) {
                        // Update database - pass complete business object
                        await updateBusiness({ ...business, website });
                        stats.found++;
                        logger.info(`[WEBSITE EXTRACTOR] ✓ Found website: ${website}`);
                    } else {
                        logger.info(`[WEBSITE EXTRACTOR] ✗ No website found`);
                    }
                    // B5-5 + BG-11: success (or graceful no-website) resets THIS
                    // worker's failure streak only. Other workers' streaks are
                    // unaffected — preserves the alarm signal across workers.
                    workerFailures.set(workerId, 0);

                    stats.processed++;

                    // Delay between extractions (per worker)
                    await sleep(WEBSITE_EXTRACTION_CONFIG.delayBetween);

                } catch (error) {
                    logger.error(`[WEBSITE EXTRACTOR] Error processing ${business.title}:`, error.message);
                    stats.errors++;

                    // B5-5 + BG-11: increment THIS worker's streak counter and
                    // abort batch if MAX_CONSECUTIVE_FAILURES hit on this worker.
                    // Per-worker isolation: a success in another worker no
                    // longer erases this worker's alarm signal.
                    const cnt = (workerFailures.get(workerId) || 0) + 1;
                    workerFailures.set(workerId, cnt);
                    if (cnt >= MAX_CONSECUTIVE_FAILURES) {
                        logger.error(
                            `[WEBSITE EXTRACTOR] ${MAX_CONSECUTIVE_FAILURES} consecutive failures on Worker ${workerId} — aborting batch`
                        );
                        await websiteExtractionStateAPI.patch({ shouldStop: true });
                        _stateCache.shouldStop = true;
                        chrome.runtime.sendMessage({
                            action: 'website_extraction_progress',
                            payload: {
                                current: completed,
                                total: total,
                                currentItem: `⚠️ Aborted: ${MAX_CONSECUTIVE_FAILURES} consecutive failures on Worker ${workerId} (Maps rate-limit / login / CAPTCHA)`
                            }
                        }).catch(() => { });
                        break;
                    }
                }
            }
        };

        // Start workers
        const workers = [];
        const concurrency = WEBSITE_EXTRACTION_CONFIG.concurrency || 1;
        logger.info(`[WEBSITE EXTRACTOR] Starting ${concurrency} concurrent workers`);

        for (let i = 0; i < concurrency; i++) {
            workers.push(worker(i + 1));
        }

        await Promise.all(workers);

        // Broadcast completion
        chrome.runtime.sendMessage({
            action: 'website_extraction_finished',
            payload: stats
        }).catch(() => { });

        logger.info(`[WEBSITE EXTRACTOR] Complete! Processed: ${stats.processed}, Found: ${stats.found}, Errors: ${stats.errors}`);
        return stats;

    } catch (error) {
        logger.error('[WEBSITE EXTRACTOR] Fatal error:', error);
        throw error;
    } finally {
        // Always reset running state — both storage (truth) AND mirror.
        await websiteExtractionStateAPI.set({ ...STATE_DEFAULTS });
        _stateCache = { ...STATE_DEFAULTS };
    }
}

// =====================================================
// MV3 ECVICTION RECOVERY: top-level await respawn
// =====================================================
//
// At module load (after SW wake), restore state from storage and re-attach
// the extraction loop if it was running at eviction time. The DB IS the
// queue: getBusinessesWithoutWebsite() re-derives the work set; we don't
// persist the queue array.
//
// Guard `_runLoopActive` prevents double-spawn if a queued user message
// (e.g., another `extractMissingWebsites()` call) fires during the same
// wake cycle as this respawn. Cross-eviction semantics: "no carry-over"
// (variable is fresh-false on wake; top-level await re-claims it cleanly).
// SW-EVICTION-SAFE: guard scoped to a single SW lifetime by design.
let _runLoopActive = false;

async function _restoreAndMaybeRespawn() {
    try {
        const restored = await websiteExtractionStateAPI.get();
        _stateCache = {
            isRunning: !!restored.isRunning,
            isPaused: !!restored.isPaused,
            shouldStop: !!restored.shouldStop
        };
        if (!restored.isRunning) return;
        // shouldStop=true means user pressed Stop pre-eviction; honor it.
        if (restored.shouldStop) {
            logger.info('[WEBSITE EXTRACTOR] Restore: shouldStop=true, clearing state without respawn');
            await websiteExtractionStateAPI.set({ ...STATE_DEFAULTS });
            _stateCache = { ...STATE_DEFAULTS };
            return;
        }
        logger.info('[WEBSITE EXTRACTOR] Eviction recovery: respawning extractMissingWebsites');
        // Defer to next microtask so module init can finish before re-entry.
        queueMicrotask(() => {
            if (_runLoopActive) return;
            _runLoopActive = true;
            extractMissingWebsites()
                .catch(err => logger.error('[WEBSITE EXTRACTOR] Re-attached run crashed:', err))
                .finally(() => { _runLoopActive = false; });
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('[WEBSITE EXTRACTOR] State restore failed:', msg);
    }
}

// 2026-05-15 REVERT (top-level-await ban): Chrome MV3 stable rejects SW
// modules with top-level `await` ("Top-level await is disallowed in
// service workers" — Status code: 3). Fire-and-forget: respawn dispatch
// is already queued via queueMicrotask inside _restoreAndMaybeRespawn,
// so module init no longer needs to block on restore.
_restoreAndMaybeRespawn()
    .catch(err => logger.warn('[WEBSITE EXTRACTOR] restore failed:', err?.message || err));

// =====================================================
// EXTRACT WEBSITE FROM SINGLE GMB PAGE
// =====================================================

/**
 * Extract website from a Google Maps business page.
 *
 * B5-3 P0 FIX (2026-05-10): switched from `chrome.tabs.create({active:false})`
 * to `chrome.windows.create({type:'popup', state:'minimized'})`. Pre-fix,
 * processing 100 businesses opened+closed 100 tabs in the user's main
 * window — visible flickering, tab strip overflow, browsing disruption.
 * Post-fix: each tab is in its own minimized popup window — separated
 * from user's browsing, doesn't pollute the tab strip. Same pattern as
 * area-search.js multi-window scroll (line ~785).
 *
 * @param {string} googleMapsUrl - The Google Maps URL
 * @returns {Promise<string|null>} - Website URL or null
 */
async function extractWebsiteFromGMB(googleMapsUrl) {
    let windowId = null;
    let tabId = null;

    try {
        // B5-3 fix: popup window instead of tab in user's main window
        // (avoids tab-strip pollution and visible flicker during bulk
        // enrichment).
        //
        // 2026-05-15 FIX #3: previous attempt put the popup off-screen
        // (left/top: -10000) to hide it; Chrome 116+ rejects bounds that
        // place <50% of the window outside any visible display
        // ("Invalid value for bounds. Bounds must be at least 50%
        // within visible screen space"). And state:'minimized' throttles
        // JS so scripting.executeScript never resolves.
        //
        // Pragmatic landing zone: small 200×200 popup at (0,0) — fully
        // visible (passes the 50% rule), small enough to be unobtrusive,
        // focused:false so it doesn't steal user input. JS runs at full
        // throttle because the window is normal-state. Trade-off:
        // a small popup briefly appears in the top-left corner per
        // business. Better than a broken fallback.
        const popupWindow = await chrome.windows.create({
            url: googleMapsUrl,
            type: 'popup',
            focused: false,
            left: 0,
            top: 0,
            width: 200,
            height: 200
        });
        windowId = popupWindow.id;
        tabId = popupWindow.tabs?.[0]?.id;

        if (!tabId) {
            throw new Error('Popup window created but no tab id returned');
        }

        // Wait for page load
        await waitForTabLoad(tabId, WEBSITE_EXTRACTION_CONFIG.pageLoadWait);

        // B5-2 FIX (2026-05-10): wrap chrome.scripting.executeScript in
        // Promise.race so a hung page (CAPTCHA / infinite redirect /
        // blocked JS) cannot block this worker indefinitely. Pre-fix
        // `extractionTimeout` was declared in WEBSITE_EXTRACTION_CONFIG
        // but never enforced — chrome.scripting.executeScript has no
        // built-in timeout and no AbortSignal support in MV3.
        //
        // On timeout: throw EXTRACTION_TIMEOUT, fall through to existing
        // catch block which closes the tab and re-throws. clearTimeout
        // in finally so the success path doesn't keep the SW alive
        // unnecessarily.
        let extractionTimer;
        const extractionTimeoutP = new Promise((_, reject) => {
            extractionTimer = setTimeout(
                () => reject(new Error('EXTRACTION_TIMEOUT')),
                WEBSITE_EXTRACTION_CONFIG.extractionTimeout
            );
        });
        let results;
        try {
            results = await Promise.race([
                chrome.scripting.executeScript({
                    target: { tabId },
                    func: extractWebsiteFromPage
                }),
                extractionTimeoutP
            ]);
        } finally {
            clearTimeout(extractionTimer);
        }

        // Close popup window (closes the inner tab too)
        await chrome.windows.remove(windowId).catch(() => { });
        windowId = null;

        if (results && results[0] && results[0].result) {
            return results[0].result;
        }

        return null;

    } catch (error) {
        // Clean up popup window if still open (B5-3: window-level cleanup)
        if (windowId) {
            await chrome.windows.remove(windowId).catch(() => { });
        }
        throw error;
    }
}

/**
 * Function to inject into page to extract website
 * This runs in the context of the Google Maps page
 */
function extractWebsiteFromPage() {
    // Helper: Check if domain should be excluded
    // =========================================================================
    // ⚠️ BLOCK-M3: INLINE CONFIGURATION (Cannot import from CONFIG)
    // This function is injected into page context via chrome.scripting.executeScript
    // and cannot access ES6 imports. Keep in sync with CONFIG.extraction.email.blacklist
    // when adding new excluded domains.
    // =========================================================================
    function isExcluded(domain) {
        const excluded = [
            'google.', 'goo.gl', 'maps.', 'facebook.', 'instagram.',
            'twitter.', 'youtube.', 'booking.com', 'tripadvisor.',
            'expedia.', 'airbnb.', 'yelp.', 'paginegialle.'
        ];
        return excluded.some(ex => domain.toLowerCase().includes(ex));
    }

    // Helper: Check if string looks like a domain
    // B5-6 fix: TLD upper bound raised 6 → 24 to cover ICANN modern TLDs
    // (.museum, .versicherung, .construction, …). 24 chars covers all
    // currently-registered TLDs as of 2026.
    function looksLikeDomain(str) {
        if (!str || str.length < 4 || !str.includes('.')) return false;
        str = str.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
        const parts = str.split('.');
        if (parts.length < 2) return false;
        const tld = parts[parts.length - 1];
        return tld.length >= 2 && tld.length <= 24 && /^[a-z]+$/.test(tld);
    }

    // Strategy 1: Look for website button/link with data-item-id="authority"
    const authorityLink = document.querySelector('a[data-item-id="authority"]');
    if (authorityLink && authorityLink.href && !isExcluded(authorityLink.href)) {
        return authorityLink.href;
    }

    // Strategy 2: Look for "Sito web" or "Website" button
    const websiteButtons = document.querySelectorAll('a[aria-label*="sito" i], a[aria-label*="website" i], button[aria-label*="sito" i], button[aria-label*="website" i]');
    for (const btn of websiteButtons) {
        if (btn.href && !isExcluded(btn.href)) {
            return btn.href;
        }
        // Check data attributes
        const dataValue = btn.getAttribute('data-value') || btn.getAttribute('data-url');
        if (dataValue && !isExcluded(dataValue)) {
            return dataValue.startsWith('http') ? dataValue : 'https://' + dataValue;
        }
    }

    // Strategy 3: Look for direct links in the detail panel
    const mainPanel = document.querySelector('[role="main"]');
    if (mainPanel) {
        const links = mainPanel.querySelectorAll('a[href^="http"]');
        for (const a of links) {
            if (a.href && !isExcluded(a.href)) {
                return a.href;
            }
        }
    }

    // Strategy 4: Look for domain-like text (hotels often show "galzignano.it")
    const pageText = document.body.innerText || '';
    const domainPatterns = [
        /\b([a-z0-9][-a-z0-9]{0,62}\.it)\b/gi,
        /\b([a-z0-9][-a-z0-9]{0,62}\.com)\b/gi,
        /\b([a-z0-9][-a-z0-9]{0,62}\.eu)\b/gi,
        /\b([a-z0-9][-a-z0-9]{0,62}\.net)\b/gi,
        /\b([a-z0-9][-a-z0-9]{0,62}\.org)\b/gi
    ];

    for (const pattern of domainPatterns) {
        const matches = pageText.match(pattern);
        if (matches) {
            for (const match of matches) {
                if (looksLikeDomain(match) && !isExcluded(match)) {
                    return 'https://' + match.toLowerCase();
                }
            }
        }
    }

    // Strategy 5: Look for globe icon adjacent elements
    const infoRows = document.querySelectorAll('[data-item-id]');
    for (const row of infoRows) {
        const text = row.textContent || '';
        for (const pattern of domainPatterns) {
            const matches = text.match(pattern);
            if (matches) {
                for (const match of matches) {
                    if (looksLikeDomain(match) && !isExcluded(match)) {
                        return 'https://' + match.toLowerCase();
                    }
                }
            }
        }
    }

    return null;
}

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Wait for tab to finish loading
 */
async function waitForTabLoad(tabId, timeout) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab.status === 'complete') {
                // Extra wait for dynamic content
                await sleep(1000);
                return;
            }
        } catch (e) {
            // Tab might have been closed
            throw new Error('Tab closed during load');
        }
        await sleep(200);
    }

    // Timeout - proceed anyway
    await sleep(500);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =====================================================
// EXPORT
// =====================================================

export { extractWebsiteFromGMB, WEBSITE_EXTRACTION_CONFIG };
export default {
    extractMissingWebsites,
    extractWebsiteFromGMB,
    pauseWebsiteExtraction,
    resumeWebsiteExtraction,
    stopWebsiteExtraction,
    getWebsiteExtractionStatus
};
