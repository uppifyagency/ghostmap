/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Tab-Based Scraper Fallback
 * 
 * CRAWLEE-INSPIRED: JavaScript Rendering Fallback
 * https://crawlee.dev/js/docs/guides/javascript-rendering
 * 
 * This module provides a fallback mechanism for email scraping when
 * fetch-based requests fail (timeout, Cloudflare, JavaScript-rendered sites).
 * It uses real Chrome tabs to render pages and extract emails from the DOM.
 * 
 * Key Features:
 * - Timeout protection (30s max per business)
 * - Page prioritization (homepage → contact → about)
 * - Detailed logging for viewlog visibility
 * - Anti-detection with SessionPool fingerprinting
 * - Graceful tab cleanup on success or failure
 */

import { CONFIG } from '../lib/config.js';
import { extractPartitaIva } from '../lib/partitaIva.js';
import { logger, sleep } from '../lib/utils.js';
import { getSessionPool } from '../lib/SessionPool.js';
import { getStatistics } from '../lib/Statistics.js';
// HIGH-003 FIX: Import circuit breaker from email-scraper-v2
import emailScraper from './email-scraper-v2.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const TAB_CONFIG = {
    // Timeouts (milliseconds) - P1-001 FIX: Reduced for better UX
    PAGE_LOAD_TIMEOUT: 10000,      // Max wait for page to load (reduced from 15s)
    EXTRACTION_TIMEOUT: 5000,      // Max wait for extraction script
    TOTAL_TIMEOUT: 30000,          // Max total time per business (reduced from 45s)
    BATCH_TIMEOUT: 300000,         // 5 min max for entire tab fallback batch

    // Delays (for human-like behavior) - FIX: Increased to reduce CAPTCHA triggers
    PAGE_SETTLE_DELAY: 2000,       // Wait after page load for JS to execute (increased from 1500)
    BETWEEN_PAGES_DELAY: 2000,     // Wait between page navigations (increased from 1000)

    // Limits - FIX: Reduced to minimize detection
    MAX_PAGES_TO_TRY: 4,           // Max pages to visit per business (reduced from 6)
    MAX_RETRIES_PER_PAGE: 1        // Retries per page on error
};

// BLOCK-L2 FIX: Page priorities moved to CONFIG for centralized configuration
// Access via CONFIG.tabFallback.pagePriorities
const getPagePriorities = () => CONFIG.tabFallback.pagePriorities;

// Errors that qualify for tab-based retry
// M4 FIX: Expanded to cover more connection failure scenarios
const RETRY_ELIGIBLE_ERRORS = [
    'timeout',
    'timed out',
    'cloudflare',
    'cf_protected',
    'cf-',
    'http 403',
    'http 503',
    'http 429',
    'failed to fetch',
    'network error',
    'net::err',
    'aborted',
    // M4 FIX: Added common connection errors
    'ssl',
    'certificate',
    'dns',
    'enotfound',
    'connection refused',
    'econnrefused',
    'econnreset',
    'socket hang up',
    'session retired',  // When session gets blocked
    // LOG-001 FIX: Empty HTML indicates SPA/JS-rendered site needing tab fallback
    'empty_html',
    // FIX-MISSING: Add captcha to eligible retry errors
    'captcha'
];

// Get shared singletons
const sessionPool = getSessionPool();
const statistics = getStatistics();

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT — B5-4 P0 FIX (eviction-safe)
// ─────────────────────────────────────────────────────────────────────────────
// Pre-fix: `activeTabs` was a module-scope `Set<number>` populated when the
// fallback opened a Chrome tab and read by `forceCleanupAllTabs()`. On SW
// eviction the Set was lost — `forceCleanupAllTabs` then ran with size 0
// and silently no-op'd, leaving open tabs as orphans. Each eviction during
// a batch added 1-N orphan tabs to the user's Chrome window.
//
// Fix: persist the set as an array in chrome.storage.session via
// lib/swState.js. Reads cross-eviction; writes are debounced through the
// helper. Cleanup queries the persisted ledger, not the in-memory Set.
//
// Type guard: only finite numbers accepted as tabIds.
// ═══════════════════════════════════════════════════════════════════════════════

import { createSessionState } from '../lib/swState.js';

// SW-EVICTION-SAFE: backed by chrome.storage.session via createSessionState.
// Stored as Array (storage-friendly); we treat it as a Set in API surface.
const _activeTabsState = createSessionState('tab_fallback.active_tabs', []);

/**
 * Add a tab id to the persisted active-tabs ledger. Called immediately after
 * chrome.tabs.create succeeds.
 *
 * BG-16 FIX (2026-05-27): returns a boolean so the caller (createTab) can
 * roll back the just-created popup window on definitive storage failure.
 * Pre-fix the function swallowed any storage.session.set() error at debug
 * level and returned void; the in-memory mirror still contained the tabId
 * but the persisted ledger did not, so a subsequent SW eviction + rehydrate
 * lost the entry and forceCleanupAllTabs (which reads the persisted ledger)
 * left the popup as an orphan invisible to the user.
 *
 * Behaviour:
 *   - returns true on successful persist (including idempotent already-present)
 *   - returns false on definitive failure after one transient retry
 *   - retries once with a small backoff to absorb transient I/O glitches
 *   - logs at WARN (not debug) so production telemetry surfaces the failure
 *
 * @private
 * @param {number} tabId
 * @returns {Promise<boolean>} true on persist success, false on definitive failure
 */
async function _trackActiveTab(tabId) {
    if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return false;
    // OBS-2: keep in-memory mirror in sync for sync onRemoved listener.
    _activeTabsInMemory.add(tabId);

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const current = await _activeTabsState.get();
            const arr = Array.isArray(current) ? current : [];
            if (!arr.includes(tabId)) {
                await _activeTabsState.set([...arr, tabId]);
            }
            return true;
        } catch (e) {
            lastErr = e;
            if (attempt === 0) {
                // Brief backoff for transient errors (storage quota momentarily
                // saturated, IndexedDB lock, etc.). 50ms is short enough to not
                // delay the happy path observably if the retry succeeds.
                await new Promise(r => setTimeout(r, 50));
            }
        }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    logger.warn('[TAB FALLBACK] _trackActiveTab definitive failure after retry, tab will orphan if caller does not rollback:', msg);
    return false;
}

/**
 * Remove a tab id from the persisted active-tabs ledger. Called from
 * cleanupTab regardless of whether the close succeeded.
 * @private
 * @param {number} tabId
 */
async function _untrackActiveTab(tabId) {
    if (typeof tabId !== 'number') return;
    // OBS-2: keep in-memory mirror in sync.
    _activeTabsInMemory.delete(tabId);
    try {
        const current = await _activeTabsState.get();
        const arr = Array.isArray(current) ? current : [];
        if (!arr.includes(tabId)) return;
        await _activeTabsState.set(arr.filter(id => id !== tabId));
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.debug('[TAB FALLBACK] _untrackActiveTab failed:', msg);
    }
}

/**
 * Read the active-tabs ledger. Filters to finite numbers only (defensive
 * against malformed payloads).
 * @private
 * @returns {Promise<number[]>}
 */
async function _getActiveTabs() {
    try {
        const arr = await _activeTabsState.get();
        if (!Array.isArray(arr)) return [];
        return arr.filter(t => typeof t === 'number' && Number.isFinite(t));
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.debug('[TAB FALLBACK] _getActiveTabs failed:', msg);
        return [];
    }
}

// B5-3 P0 FIX (2026-05-10): map tabId → windowId for popup-based cleanup.
// Each entry mirrors a `_trackActiveTab(tabId)` from createTab so cleanupTab
// can close the *whole* popup window via chrome.windows.remove (which also
// closes the inner tab atomically). Without this map we'd have to call
// chrome.tabs.get(tabId) at cleanup time to recover the windowId — extra
// RPC + risk of orphan popups if the tab was already closed.
/** @type {Map<number, number>} */
const activeTabWindows = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// TAB-CLOSE TELEMETRY — OBS-2 (2026-05-17), TELEMETRY-ONLY
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEM (Finding 2 from dogfooding 2026-05-17): tabs created by this module
// were occasionally closed externally — observed log line `[TAB] Tab N was
// closed (before extraction) - aborting`. 5 events in a 20-min scrape window,
// clustered in pairs (tab IDs +2 apart) which strongly suggests *Chrome* is
// killing popups when too many small popup windows live concurrently. We
// CANNOT confirm without observing `chrome.tabs.onRemoved` and correlating
// against our own `chrome.windows.remove` / `chrome.tabs.remove` calls.
//
// DESIGN:
//   1. `_activeTabsInMemory: Set<number>` — sync mirror of the persisted
//      `_activeTabsState` ledger, updated on _trackActiveTab/_untrackActiveTab.
//      The persisted ledger is async (chrome.storage.session); the onRemoved
//      listener runs sync and needs an instant lookup.
//   2. `_recentOurRemoves: Map<tabId, ts>` and `_recentOurWindowRemoves:
//      Map<windowId, ts>` — record our own remove calls so the listener can
//      correlate. 5s correlation window per senior-voice advice (Chrome
//      onRemoved for popup window removal has been observed to lag up to ~2s).
//   3. `_recordOwnRemove({tabId, windowId}, source)` — called BEFORE every
//      `chrome.tabs.remove` / `chrome.windows.remove` in this module so the
//      listener attributes that close to us.
//   4. `_tabCloseTelemetry` counters — exposed via `getTabCloseTelemetry()`
//      AND attached to `globalThis` so the SW console can inspect them.
//
// CLASSIFICATIONS emitted to log:
//   - OWNED_TAB_REMOVE      = we called chrome.tabs.remove(tabId) within 5s
//   - OWNED_WINDOW_REMOVE   = we called chrome.windows.remove(windowId) within 5s
//   - EXTERNAL              = tab was in our ledger but no recent our-remove
//                             → Chrome / user / other extension closed it
//                             (this is the smoking-gun signal we're after)
//   - UNTRACKED             = tab not in our ledger (silenced; counter only)
//
// SCOPE LIMITS: instruments ONLY tabs/windows created by this module. Other
// background tab paths (area-search) are NOT instrumented to keep blast radius
// minimal. If Chrome-popup-limit is the actor, the signal will appear in this
// module's tabs anyway.
//
// FOLLOW-UPS (out of scope here, tracked):
//   - Step 2: if EXTERNAL > 0 confirms, add `maxConcurrentPopupTabs=5` semaphore.
//   - Step 3: wire tab-close rate as downscale signal to AutoScaler.
//   - Pure-Node test mocking chrome.tabs.onRemoved + assertion on classification.
// ═══════════════════════════════════════════════════════════════════════════════
/** @type {Set<number>} sync mirror of `_activeTabsState` for listener-time lookup */
const _activeTabsInMemory = new Set();
/** @type {Map<number, number>} tabId → ts of our most recent chrome.tabs.remove */
const _recentOurRemoves = new Map();
/** @type {Map<number, number>} windowId → ts of our most recent chrome.windows.remove */
const _recentOurWindowRemoves = new Map();
// OBS-2 FIX (2026-05-17 follow-up): pre-fix, `_untrackActiveTab` ran in
// cleanupTab BEFORE the chrome.windows.remove(). The listener checked
// `_activeTabsInMemory.has(tabId)` and got false → classified as UNTRACKED
// (silent counter), so OWNED_TAB_REMOVE / OWNED_WINDOW_REMOVE counters
// were always 0. Empirically confirmed in scrape 2026-05-17 19:15: 20
// OUR_REMOVE pre-records, 0 listener `class=` log lines.
//
// These two maps preserve identity AFTER untrack but BEFORE Chrome fires
// onRemoved. Listener now does a SECOND-PASS check against them with the
// same 5s correlation window. GC at 30s like the other recency maps.
//
// FOLLOW-UP TODO: collapse `_activeTabsInMemory` + `_recentlyOurTabIds` +
// `_recentlyOurWindowIds` into a single `_tabRegistry: Map<tabId, ...>`
// with explicit state fields. Multi-mirror is anti-pattern; tracking now,
// not blocking this fix.
/** @type {Map<number, number>} tabId → ts of our most recent track-removal (cleanupTab path) */
const _recentlyOurTabIds = new Map();
/** @type {Map<number, number>} windowId → ts inferred from `_recordOwnRemove` window-target */
const _recentlyOurWindowIds = new Map();
const _CORRELATION_WINDOW_MS = 5000;
const _CORRELATION_GC_THRESHOLD_MS = 30000;
const _tabCloseTelemetry = {
    ownedTabRemove: 0,
    ownedWindowRemove: 0,
    external: 0,
    untracked: 0,
    sinceTs: Date.now()
};
let _telemetryInstalled = false;

/**
 * Record an our-initiated remove BEFORE calling chrome.tabs.remove or
 * chrome.windows.remove. The onRemoved listener uses these timestamps to
 * classify subsequent close events as OWNED_* vs EXTERNAL.
 *
 * @param {{tabId?: number, windowId?: number}} target
 * @param {string} source - free-form label (e.g. "cleanupTab-main") for log triage
 * @private
 */
function _recordOwnRemove(target, source) {
    const now = Date.now();
    if (typeof target.tabId === 'number') {
        _recentOurRemoves.set(target.tabId, now);
        // OBS-2 follow-up: also populate identity-preserving map. Listener uses
        // this when _activeTabsInMemory.has() returns false because _untrackActiveTab
        // already deleted the entry (cleanupTab order: untrack → recordOwnRemove → remove).
        _recentlyOurTabIds.set(target.tabId, now);
    }
    if (typeof target.windowId === 'number') {
        _recentOurWindowRemoves.set(target.windowId, now);
        _recentlyOurWindowIds.set(target.windowId, now);
    }
    // GC: bound memory by dropping entries older than 30s. Listener correlation
    // window is 5s, so 30s is generous safety.
    for (const [k, ts] of _recentOurRemoves) {
        if (now - ts > _CORRELATION_GC_THRESHOLD_MS) _recentOurRemoves.delete(k);
    }
    for (const [k, ts] of _recentOurWindowRemoves) {
        if (now - ts > _CORRELATION_GC_THRESHOLD_MS) _recentOurWindowRemoves.delete(k);
    }
    for (const [k, ts] of _recentlyOurTabIds) {
        if (now - ts > _CORRELATION_GC_THRESHOLD_MS) _recentlyOurTabIds.delete(k);
    }
    for (const [k, ts] of _recentlyOurWindowIds) {
        if (now - ts > _CORRELATION_GC_THRESHOLD_MS) _recentlyOurWindowIds.delete(k);
    }
    // Side-effect-free debug log; only emitted under debug to avoid noise.
    logger.debug?.(`[TAB CLOSE TELEMETRY] OUR_REMOVE source=${source} tabId=${target.tabId ?? '-'} windowId=${target.windowId ?? '-'}`);
}

/**
 * Install the chrome.tabs.onRemoved listener. Idempotent via closure guard
 * (NOT a window-observable property). Safe to call multiple times across SW
 * wake. Also populates `_activeTabsInMemory` from the persisted ledger on
 * first install.
 * @private
 */
function _installTabCloseTelemetry() {
    if (_telemetryInstalled) return;
    if (typeof chrome === 'undefined' || !chrome?.tabs?.onRemoved?.addListener) return;
    _telemetryInstalled = true;

    // Initial cache populate from persisted ledger. Async, but the listener
    // doesn't await — events arriving before this resolves will misclassify
    // as UNTRACKED (acceptable: rare race at SW startup).
    _getActiveTabs().then(arr => {
        for (const t of arr) _activeTabsInMemory.add(t);
    }).catch(() => { /* ignore */ });

    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
        try {
            const now = Date.now();

            // OBS-2 FIX: identity check is two-pass. _activeTabsInMemory is the
            // live ledger of OUR tabs; _recentlyOurTabIds is a TTL'd shadow that
            // preserves "this was ours" identity for ~30s after _untrackActiveTab
            // has removed the live entry. Either match counts as ours.
            const liveTracked = _activeTabsInMemory.has(tabId);
            const recentlyTrackedTabTs = _recentlyOurTabIds.get(tabId);
            const recentlyTrackedTab = recentlyTrackedTabTs !== undefined
                && (now - recentlyTrackedTabTs) < _CORRELATION_GC_THRESHOLD_MS;

            // Window-level identity: if the window was ours (recorded in
            // _recentlyOurWindowIds when we called chrome.windows.remove), this
            // tab close is ours-by-window even if the tabId never matched.
            const recentlyTrackedWinTs = typeof removeInfo?.windowId === 'number'
                ? _recentlyOurWindowIds.get(removeInfo.windowId)
                : undefined;
            const recentlyTrackedWindow = recentlyTrackedWinTs !== undefined
                && (now - recentlyTrackedWinTs) < _CORRELATION_GC_THRESHOLD_MS;

            const tracked = liveTracked || recentlyTrackedTab || recentlyTrackedWindow;
            if (!tracked) {
                _tabCloseTelemetry.untracked++;
                return; // silent: we don't care about tabs we never created
            }

            const tabRemoveTs = _recentOurRemoves.get(tabId);
            const winRemoveTs = typeof removeInfo?.windowId === 'number'
                ? _recentOurWindowRemoves.get(removeInfo.windowId)
                : undefined;
            const ourTabRemove = tabRemoveTs !== undefined && (now - tabRemoveTs) < _CORRELATION_WINDOW_MS;
            const ourWinRemove = winRemoveTs !== undefined && (now - winRemoveTs) < _CORRELATION_WINDOW_MS;

            let classification;
            if (ourTabRemove) {
                classification = 'OWNED_TAB_REMOVE';
                _tabCloseTelemetry.ownedTabRemove++;
            } else if (ourWinRemove) {
                classification = 'OWNED_WINDOW_REMOVE';
                _tabCloseTelemetry.ownedWindowRemove++;
            } else {
                // Tab was ours (live or recently) but no recent our-remove call
                // matches. This is the smoking gun: Chrome, user, or other
                // extension closed our popup. Finding 2 confirmation signal.
                classification = 'EXTERNAL';
                _tabCloseTelemetry.external++;
            }

            logger.warn(
                `[TAB CLOSE TELEMETRY] tabId=${tabId} class=${classification} ` +
                `windowClosing=${!!removeInfo?.isWindowClosing} ` +
                `windowId=${removeInfo?.windowId ?? '-'} ` +
                `live=${liveTracked} recentTab=${recentlyTrackedTab} recentWin=${recentlyTrackedWindow}`
            );

            // Keep caches hygienic: tab is gone, drop from all mirrors.
            _activeTabsInMemory.delete(tabId);
            _recentlyOurTabIds.delete(tabId);
            // Note: don't delete window from _recentlyOurWindowIds here — a single
            // popup window can contain only one tab in our usage, but Chrome may
            // fire tabs.onRemoved for multiple tabs in the same window in theory.
            // GC at 30s handles cleanup.
        } catch (e) {
            // Never let telemetry crash the listener.
            const msg = e instanceof Error ? e.message : String(e);
            logger.debug?.(`[TAB CLOSE TELEMETRY] listener error: ${msg}`);
        }
    });

    // Operator-facing snapshot accessor. Attach to globalThis so the SW
    // DevTools console can inspect counters mid-scrape without imports.
    try { globalThis.getTabCloseTelemetry = getTabCloseTelemetry; } catch { /* ignore */ }

    logger.info?.('[TAB CLOSE TELEMETRY] listener installed');
}

/**
 * Return a snapshot of the tab-close telemetry counters. Operator-facing.
 * @returns {{ownedTabRemove:number, ownedWindowRemove:number, external:number, untracked:number, sinceTs:number, sinceMs:number}}
 */
export function getTabCloseTelemetry() {
    const now = Date.now();
    return {
        ownedTabRemove: _tabCloseTelemetry.ownedTabRemove,
        ownedWindowRemove: _tabCloseTelemetry.ownedWindowRemove,
        external: _tabCloseTelemetry.external,
        untracked: _tabCloseTelemetry.untracked,
        sinceTs: _tabCloseTelemetry.sinceTs,
        sinceMs: now - _tabCloseTelemetry.sinceTs
    };
}

// Install at module-load. Safe under SW wake (idempotent).
_installTabCloseTelemetry();

/**
 * Check if a tab still exists
 * @param {number} tabId - Tab ID to check
 * @returns {Promise<boolean>} True if tab exists
 */
async function tabExists(tabId) {
    try {
        await chrome.tabs.get(tabId);
        return true;
    } catch {
        return false;
    }
}

/**
 * STRANGE-BEHAVIOR-FIX-001: Check if tab is showing an error page
 * Chrome displays error pages for unreachable sites (DNS failure, SSL error, connection refused)
 * These pages block script injection with "Frame with ID 0 is showing error page"
 * @param {number} tabId - Tab ID to check
 * @returns {Promise<{isError: boolean, reason: string|null}>} Error status and reason
 */
async function isErrorPage(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        const url = tab.url || '';

        // Chrome error pages have specific URL patterns
        if (url.startsWith('chrome-error://')) {
            // Extract error type from URL if possible
            // Format: chrome-error://chromewebdata/#<error_code>
            const errorMatch = url.match(/#(.+)/);
            return {
                isError: true,
                reason: errorMatch ? `CHROME_ERROR_${errorMatch[1]}` : 'CHROME_ERROR'
            };
        }

        // Other unreachable page indicators
        if (url.startsWith('chrome://') && url !== 'chrome://newtab/') {
            return { isError: true, reason: 'CHROME_INTERNAL_PAGE' };
        }

        if (url === 'about:blank') {
            return { isError: true, reason: 'BLANK_PAGE' };
        }

        // Check for common error indicators in page title
        const title = (tab.title || '').toLowerCase();
        const errorTitles = [
            'this site cannot be reached',
            'err_connection_refused',
            'err_name_not_resolved',
            'err_ssl_protocol_error',
            'err_cert_',
            'dns_probe_finished',
            'net::err_',
            'connection timed out',
            'server not found'
        ];

        for (const errorTitle of errorTitles) {
            if (title.includes(errorTitle)) {
                return { isError: true, reason: 'CONNECTION_ERROR' };
            }
        }

        return { isError: false, reason: null };

    } catch (error) {
        // Tab doesn't exist or can't be accessed
        return { isError: true, reason: 'TAB_ACCESS_ERROR' };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if an error qualifies for tab-based retry
 * @param {Error|string|null} error - The error from fetch-based scraping
 * @returns {boolean} True if should retry with tab
 */
export function shouldRetryWithTab(error) {
    // HIGH-004 FIX: Only retry on actual fetch/network errors
    // null/undefined = clean fetch with no emails, don't waste resources on tab
    if (!error) {
        logger.debug('[TAB FALLBACK] No error provided - fetch succeeded, skipping tab retry');
        return false;
    }

    const errorStr = (typeof error === 'string' ? error : error.message || '').toLowerCase();

    // Check against eligible errors
    const isEligible = RETRY_ELIGIBLE_ERRORS.some(pattern => errorStr.includes(pattern));

    if (isEligible) {
        logger.debug(`[TAB FALLBACK] Error eligible for retry: "${errorStr.substring(0, 50)}..."`);
    }

    return isEligible;
}

/**
 * Main entry point: Scrape emails using a Chrome tab
 * @param {Object} business - Business object with website property
 * @param {Object} options - Optional configuration overrides
 * @returns {Promise<{emails: string[], socialLinks: Object, successfulPage: string|null, duration: number}>}
 */
export async function scrapeWithTab(business, options = {}) {
    const startTime = Date.now();
    const config = { ...TAB_CONFIG, ...options };

    // Validate input
    if (!business?.website) {
        logger.warn('[TAB FALLBACK] No website provided, skipping');
        return { emails: [], socialLinks: {}, successfulPage: null, duration: 0 };
    }

    // HIGH-003 FIX: Check circuit breaker before opening tab
    try {
        const url = new URL(business.website.startsWith('http') ? business.website : 'https://' + business.website);
        const domain = url.hostname;
        if (await emailScraper.isCircuitOpen(domain)) {
            logger.warn(`[TAB FALLBACK] ⏭️ Skipping - domain ${domain} is circuit-open`);
            return {
                emails: [],
                socialLinks: {},
                italianTaxCodes: { partitaIva: null, codiceFiscale: null },
                successfulPage: null,
                duration: Date.now() - startTime,
                skipped: true
            };
        }
    } catch (e) {
        // URL parse error - proceed with tab attempt
    }

    // Normalize website URL
    let baseUrl = business.website;
    if (!baseUrl.startsWith('http')) {
        baseUrl = 'https://' + baseUrl;
    }

    // Log start with visible separator
    logger.info('');
    logger.info('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`┃ [TAB FALLBACK] 🔄 Starting for "${business.title}"`);
    logger.info('┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`┃ [URL] ${baseUrl}`);
    logger.info(`┃ [REASON] Fetch-based scraping failed`);
    logger.info('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('');

    let tab = null;
    const foundEmails = new Set();
    let socialLinks = {};
    let italianTaxCodes = { partitaIva: null, codiceFiscale: null };  // ITALIAN B2B FEATURE
    let successfulPage = null;

    try {
        // Create timeout promise for total operation
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('TAB_TOTAL_TIMEOUT')), config.TOTAL_TIMEOUT);
        });

        // Main scraping logic wrapped in race with timeout
        const scrapePromise = (async () => {
            // ═══════════════════════════════════════════════════
            // STEP 1: Create Tab
            // ═══════════════════════════════════════════════════
            logger.info('[TAB] Creating new tab...');
            tab = await createTab(baseUrl, config);

            if (!tab) {
                throw new Error('Failed to create tab');
            }

            logger.info(`[TAB] ✓ Tab created (id: ${tab.id})`);

            // ═══════════════════════════════════════════════════
            // STEP 2: Wait for Initial Page Load
            // ═══════════════════════════════════════════════════
            logger.info('[TAB] Waiting for page to load...');
            await waitForPageLoad(tab.id, config);

            // Short delay for JavaScript execution
            logger.info(`[TAB] Waiting ${config.PAGE_SETTLE_DELAY}ms for JS execution...`);
            await sleep(config.PAGE_SETTLE_DELAY);

            // ═══════════════════════════════════════════════════
            // STRANGE-BEHAVIOR-FIX-001: Check for error pages
            // Chrome shows error pages for unreachable sites which
            // block script injection with "Frame with ID 0 is showing error page"
            // ═══════════════════════════════════════════════════
            const errorPageCheck = await isErrorPage(tab.id);
            if (errorPageCheck.isError) {
                const domain = new URL(baseUrl).hostname;
                logger.warn(`[TAB] ⚠️ Site unreachable - Chrome showing error page (${errorPageCheck.reason})`);
                logger.warn(`[TAB] Recording circuit breaker failure for domain: ${domain}`);

                // Record failure in circuit breaker via imported module
                // B4-2: now async (chrome.storage.session-backed)
                await emailScraper.recordCircuitFailure?.(domain, 'CONNECTION_ERROR');

                return {
                    emails: [],
                    socialLinks: {},
                    italianTaxCodes: { partitaIva: null, codiceFiscale: null },
                    successfulPage: null,
                    duration: Date.now() - startTime,
                    error: errorPageCheck.reason
                };
            }

            // ═══════════════════════════════════════════════════
            // STEP 3: Try Each Page in Priority Order
            // ═══════════════════════════════════════════════════
            const pagesToTry = getOrderedPages(baseUrl, config.MAX_PAGES_TO_TRY);

            for (let i = 0; i < pagesToTry.length; i++) {
                const { url, label } = pagesToTry[i];
                const pageNum = i + 1;

                logger.info(`[TAB] [${pageNum}/${pagesToTry.length}] ${label}: ${url}`);

                try {
                    // Navigate if not already on this page (homepage is i=0, already loaded)
                    if (i > 0) {
                        // FIX: Check tab still exists before navigating
                        if (!await tabExists(tab.id)) {
                            logger.warn(`[TAB] Tab ${tab.id} was closed - aborting`);
                            break;
                        }
                        logger.info(`[TAB] Navigating to ${label}...`);
                        await navigateToPage(tab.id, url, config);

                        // Wait for JS to execute
                        await sleep(config.PAGE_SETTLE_DELAY);
                    }

                    // FIX: Check tab still exists before extraction
                    if (!await tabExists(tab.id)) {
                        logger.warn(`[TAB] Tab ${tab.id} was closed before extraction - aborting`);
                        break;
                    }

                    // Extract emails from rendered DOM
                    logger.info(`[TAB] Extracting emails from DOM...`);
                    const result = await extractEmailsFromTab(tab.id, url, config);

                    if (result.emails && result.emails.length > 0) {
                        logger.info(`[TAB] ✓✓✓ FOUND ${result.emails.length} email(s): ${result.emails.join(', ')}`);

                        result.emails.forEach(email => foundEmails.add(email.toLowerCase().trim()));
                        successfulPage = `${url} (Tab Fallback)`;

                        // Store social links if found
                        if (result.socialLinks && Object.keys(result.socialLinks).length > 0) {
                            socialLinks = { ...socialLinks, ...result.socialLinks };
                        }

                        // HIGH CONFIDENCE: Stop immediately if we found emails on contact page
                        if (label.includes('Contact') || label.includes('ontatt')) {
                            logger.info(`[TAB] 🎯 High-confidence email found on contact page, stopping`);
                            break;
                        }
                    } else {
                        logger.info(`[TAB] ✗ No emails on ${label}`);
                    }

                    // Store social links even without emails
                    if (result.socialLinks && Object.keys(socialLinks).length === 0) {
                        socialLinks = result.socialLinks;
                    }

                    // ITALIAN B2B FEATURE: Extract P.IVA/C.F. ALWAYS, regardless of email success
                    // This ensures tax codes are captured even when emails aren't found
                    if (result.italianTaxCodes) {
                        if (result.italianTaxCodes.partitaIva && !italianTaxCodes.partitaIva) {
                            italianTaxCodes.partitaIva = result.italianTaxCodes.partitaIva;
                            logger.info(`[TAB] ✓ Found P.IVA: ${italianTaxCodes.partitaIva}`);
                        }
                        if (result.italianTaxCodes.codiceFiscale && !italianTaxCodes.codiceFiscale) {
                            italianTaxCodes.codiceFiscale = result.italianTaxCodes.codiceFiscale;
                            logger.info(`[TAB] ✓ Found C.F.: ${italianTaxCodes.codiceFiscale}`);
                        }
                    }

                    // Small delay between pages
                    if (i < pagesToTry.length - 1) {
                        await sleep(config.BETWEEN_PAGES_DELAY);
                    }

                } catch (pageError) {
                    logger.warn(`[TAB] Error on ${label}: ${pageError.message}`);
                    // Continue to next page
                }
            }

            return { emails: Array.from(foundEmails), socialLinks, italianTaxCodes, successfulPage };
        })();

        // Race between scraping and timeout
        const result = await Promise.race([scrapePromise, timeoutPromise]);

        const duration = Date.now() - startTime;

        // Log result
        logger.info('');
        logger.info('┌────────────────────────────────────────────────────');
        logger.info(`│ [TAB FALLBACK] ✓ Complete for "${business.title}"`);
        logger.info('├────────────────────────────────────────────────────');
        logger.info(`│ Emails found: ${result.emails.length}`);
        if (result.emails.length > 0) {
            logger.info(`│ Email(s): ${result.emails.join(', ')}`);
            logger.info(`│ Found on: ${result.successfulPage}`);
        }
        logger.info(`│ Duration: ${(duration / 1000).toFixed(1)}s`);
        logger.info('└────────────────────────────────────────────────────');
        logger.info('');

        // Record statistics
        if (result.emails.length > 0) {
            statistics.recordEmail(true);
        }

        return {
            emails: result.emails,
            socialLinks: result.socialLinks,
            italianTaxCodes: result.italianTaxCodes,  // ITALIAN B2B FEATURE
            successfulPage: result.successfulPage,
            duration
        };

    } catch (error) {
        const duration = Date.now() - startTime;

        logger.error(`[TAB FALLBACK] ✗ Failed for "${business.title}": ${error.message}`);
        logger.info(`[TAB FALLBACK] Duration: ${(duration / 1000).toFixed(1)}s`);

        return {
            emails: Array.from(foundEmails),
            socialLinks,
            italianTaxCodes,  // ITALIAN B2B FEATURE
            successfulPage,
            duration
        };

    } finally {
        // ═══════════════════════════════════════════════════════════════════════════
        // H1-001 FIX VERIFIED: Tab Leak on Abort Prevention
        // ─────────────────────────────────────────────────────────────────────────────
        // This try/finally pattern ensures tabs are ALWAYS cleaned up regardless of:
        // - User abort (clicking Stop button)
        // - Timeout expiration (TAB_TOTAL_TIMEOUT)
        // - Any exception during scraping
        // - Promise.race() cancellation
        // 
        // Combined with _trackActiveTab() in createTab() and forceCleanupAllTabs()
        // export, this provides comprehensive tab leak prevention.
        // ═══════════════════════════════════════════════════════════════════════════
        if (tab) {
            await cleanupTab(tab.id);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB MANAGEMENT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new Chrome tab inside a minimized popup window with the given URL.
 *
 * B5-3 P0 FIX (2026-05-10): switched from `chrome.tabs.create({active:false})`
 * to `chrome.windows.create({type:'popup', state:'minimized'})`. Pre-fix
 * each fallback opened a tab in the user's main window — visible flicker,
 * tab strip pollution, browsing disruption when many tabs were opened.
 * Post-fix: tab is in its own minimized popup window, doesn't touch the
 * user's main window. Same pattern as area-search.js (line ~785) and
 * website-extractor.js extractWebsiteFromGMB (B5-3 sibling fix).
 *
 * The returned object exposes `id` (tab id, used by all callers for
 * scripting.executeScript / sendMessage) and `_windowId` (internal —
 * used by cleanupTab to close the popup window).
 *
 * @param {string} url - URL to open
 * @param {Object} config - Configuration object
 * @returns {Promise<{id: number, _windowId: number} | null>} Created tab or null on failure
 */
async function createTab(url, config) {
    try {
        // B5-3 fix: popup window instead of tab in user's main window.
        // 2026-05-15 FIX #3: Chrome rejects off-screen bounds (50% must
        // be visible) AND throttles JS in minimized windows. Landing
        // zone: 200×200 at (0,0), focused:false. See sibling fix in
        // website-extractor.js for full reasoning.
        const popupWindow = await chrome.windows.create({
            url,
            type: 'popup',
            focused: false,
            left: 0,
            top: 0,
            width: 200,
            height: 200
        });

        const innerTab = popupWindow.tabs?.[0];
        if (!innerTab?.id) {
            // Cleanup: orphan popup with no tab id is unrecoverable.
            if (popupWindow.id) {
                _recordOwnRemove({ windowId: popupWindow.id }, 'createTab-orphan-cleanup');
                await chrome.windows.remove(popupWindow.id).catch(() => { });
            }
            logger.error('[TAB] Popup created but no inner tab id returned');
            return null;
        }

        // Track for cleanup (B5-4: persisted ledger, eviction-safe)
        // BG-16 FIX (2026-05-27): consume the return value so we can roll
        // back the just-created popup window if the persisted ledger write
        // failed definitively. Pre-fix this was fire-and-forget — a storage
        // failure left an in-memory-only entry that was lost on SW eviction,
        // turning the popup into an orphan that forceCleanupAllTabs could
        // not see (it reads from the persisted ledger).
        const tracked = await _trackActiveTab(innerTab.id);
        if (!tracked) {
            logger.warn(`[TAB] _trackActiveTab failed for tab ${innerTab.id}; closing popup to avoid orphan`);
            // Mark the close as ours so the onRemoved telemetry doesn't
            // misclassify it as an external removal.
            _recordOwnRemove({ windowId: popupWindow.id }, 'createTab-track-rollback');
            await chrome.windows.remove(popupWindow.id).catch(() => { });
            _activeTabsInMemory.delete(innerTab.id);
            return null;
        }

        // BG-1 FIX (2026-05-10): removed dead `activeTabs.add(innerTab.id)` —
        // `activeTabs` was an in-memory Set superseded by the B5-4 persisted
        // ledger above; the declaration was already dropped but the writer
        // remained, throwing ReferenceError swallowed by the outer try/catch.
        // The window id is still tracked separately in activeTabWindows
        // (B5-3) so cleanupTab can close the whole popup atomically.
        activeTabWindows.set(innerTab.id, popupWindow.id);
        innerTab._windowId = popupWindow.id;

        return innerTab;
    } catch (error) {
        logger.error(`[TAB] Failed to create popup window: ${error.message}`);
        return null;
    }
}

/**
 * Wait for a tab to complete loading
 * @param {number} tabId - Tab ID to wait for
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 */
async function waitForPageLoad(tabId, config) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            // P1-003 FIX: Resolve instead of reject on timeout
            // Page may be partially loaded and still extractable
            logger.warn('[TAB] Page load timeout - proceeding with partial content');
            resolve();
        }, config.PAGE_LOAD_TIMEOUT);

        const listener = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        };

        chrome.tabs.onUpdated.addListener(listener);

        // Also check if already complete
        chrome.tabs.get(tabId).then(tab => {
            if (tab.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }).catch(() => {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            // P1-003 FIX: Resolve even on tab error - let main flow handle cleanup
            logger.warn('[TAB] Tab not found during wait - proceeding');
            resolve();
        });
    });
}

/**
 * Navigate an existing tab to a new URL
 * @param {number} tabId - Tab ID to navigate
 * @param {string} url - URL to navigate to
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 */
async function navigateToPage(tabId, url, config) {
    try {
        await chrome.tabs.update(tabId, { url });
        await waitForPageLoad(tabId, config);
    } catch (error) {
        throw new Error(`Navigation failed: ${error.message}`);
    }
}

/**
 * Extract emails from a tab's rendered DOM
 * @param {number} tabId - Tab ID to extract from
 * @param {string} url - Current URL (for context)
 * @param {Object} config - Configuration object
 * @returns {Promise<{emails: string[], socialLinks: Object}>}
 */
async function extractEmailsFromTab(tabId, url, config) {
    try {
        // Inject and execute email extraction script
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: extractEmailsFromDOM,
            args: [CONFIG.extraction.email.pattern.source, CONFIG.extraction.email.blacklist]
        });

        if (results && results[0] && results[0].result) {
            return results[0].result;
        }

        return { emails: [], socialLinks: {} };

    } catch (error) {
        // Common error: cannot inject into chrome:// or restricted pages
        if (error.message.includes('Cannot access')) {
            logger.debug(`[TAB] Cannot inject into restricted page: ${url}`);
        } else {
            logger.warn(`[TAB] Extraction failed: ${error.message}`);
        }
        return { emails: [], socialLinks: {} };
    }
}

/**
 * DOM extraction function - runs in page context
 * This function is serialized and injected into the tab
 * @param {string} emailPatternSource - Regex pattern source for emails
 * @param {string[]} blacklist - Domains to ignore
 * @returns {{emails: string[], socialLinks: Object, italianTaxCodes: Object}}
 */
function extractEmailsFromDOM(emailPatternSource, blacklist) {
    const emails = new Set();
    const socialLinks = {};
    const italianTaxCodes = { partitaIva: null, codiceFiscale: null };

    // FIX: Valid TLDs sorted by length descending to prevent truncation (e.g., .com → .co)
    const VALID_TLDS = ['info', 'name', 'tech', 'shop', 'site', 'com', 'org', 'net', 'biz', 'pro', 'app', 'dev', 'it', 'de', 'fr', 'es', 'uk', 'eu', 'io', 'co', 'me', 'tv'];

    // ─── NEW-3 (BUG-4 post-audit, 2026-05-27): nested _stripIdentifierPrefix ──
    // LAST-SYNCED with lib/EmailExtractor.js:_stripIdentifierPrefix
    // (commit 3ce8b1d, 2026-05-17 OBS-3 fix; backported to
    // offscreen/parser.js + background/index.js in commit 40a9368 BUG-4).
    //
    // This function is serialized by Function.prototype.toString and
    // injected into the page context via chrome.scripting.executeScript at
    // TabScraperFallback.js:928 (extractEmailsFromTab → ScriptInjection).
    // The page context has no access to module imports — closures from the
    // outer scope are dropped during serialization. The helper MUST be a
    // nested function so it survives the serialize→inject round-trip.
    //
    // Any change to lib/EmailExtractor.js:_stripIdentifierPrefix MUST be
    // mirrored here, in offscreen/parser.js:_stripIdentifierPrefix, AND in
    // background/index.js:_stripIdentifierPrefix. Strategic fix (single
    // source of truth) is tracked as DEBT-1 next sprint.
    function _stripIdentifierPrefix(email) {
        if (typeof email !== 'string') return email;
        const at = email.indexOf('@');
        if (at <= 0) return email;
        const local = email.slice(0, at);
        const domain = email.slice(at);
        // Italian Codice Fiscale: 16 chars, [A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]
        const cfMatch = local.match(/^([A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z])(.+)$/i);
        if (cfMatch) return cfMatch[2] + domain;
        // Italian P.IVA: 11 digits. Only strip if local-part length > 11
        // (so "01234567890@example.it" — pure P.IVA local-part — is preserved).
        if (local.length > 11 && /^\d{11}/.test(local)) {
            return local.slice(11) + domain;
        }
        return email;
    }

    /**
     * Clean email by removing concatenated URLs, P.IVA, and other garbage
     * CRITICAL FIX (18 Dec 2025 - NSA Level): Scan ALL segments LEFT-TO-RIGHT
     * Examples:
     *   agenzia@hotmail.comwww.agenzia-esempio.com → agenzia@hotmail.com
     *   info@dove.itp.iva → info@dove.it
     *   marco@site.itwww.site.it → marco@site.it
     */
    function cleanTLD(email) {
        const parts = email.split('@');
        if (parts.length !== 2) return email;
        const [localPart, domainPart] = parts;
        const domainSegments = domainPart.split('.');
        if (domainSegments.length < 2) return email;

        // ═══════════════════════════════════════════════════════════════════════════════
        // CRITICAL FIX: Scan ALL segments LEFT-TO-RIGHT, stop at FIRST valid TLD
        // Previous logic only checked LAST segment, allowing intermediate garbage:
        //   agenzia@hotmail.comwww.agenzia-esempio.com
        //   → segments: ["hotmail", "comwww", "agenzia-esempio", "com"]
        //   → old code: checked only "com" (valid) → returned dirty email!
        //
        // New logic: Find FIRST valid TLD from left, cut everything after it
        // ═══════════════════════════════════════════════════════════════════════════════

        // OF-1 / BG-13 FIX (2026-05-27): the pre-fix version trimmed at the
        // FIRST valid TLD found left-to-right, corrupting both legitimate
        // subdomain chains like info@app.dev.example.com (→ info@app.dev)
        // and uncommon last-segment TLDs like ceo@tech.app.foo.xyz
        // (→ ceo@tech.app). This logic is the page-context twin of the
        // offscreen/parser.js cleanTLD — same fix applied here. Exact-match
        // branch preserves the email unconditionally; true garbage like
        // "comwww" or "ittel" is still caught by the starts-with branch
        // below, which is unambiguous regardless of last-segment shape.
        for (let i = 1; i < domainSegments.length; i++) {
            const segment = domainSegments[i].toLowerCase();

            // Exact valid TLD match → preserve the email (see OF-1 / BG-13
            // FIX above). We cannot safely distinguish "garbage subdomain
            // with TLD-mid" from "uncommon TLD at end" without a full
            // Public Suffix List, so the conservative choice is preserve.
            if (VALID_TLDS.includes(segment)) {
                return email;
            }

            // Check if segment STARTS with a valid TLD (e.g., "comwww" starts with "com")
            for (const validTLD of VALID_TLDS) {
                if (segment.startsWith(validTLD) && segment.length > validTLD.length) {
                    // Found concatenated TLD: "comwww" → "com"
                    // Replace this segment with the clean TLD and cut everything after
                    const cleanSegments = domainSegments.slice(0, i + 1);
                    cleanSegments[i] = validTLD;
                    return `${localPart}@${cleanSegments.join('.')}`;
                }
            }
        }

        // No valid TLD found anywhere, return as-is
        return email;
    }

    try {
        // Create regex from source
        const emailPattern = new RegExp(emailPatternSource, 'gi');

        // ═══════════════════════════════════════════════════
        // 1. Extract from mailto: links (highest confidence)
        // ═══════════════════════════════════════════════════
        const mailtoLinks = document.querySelectorAll('a[href^="mailto:"]');
        mailtoLinks.forEach(link => {
            const href = link.getAttribute('href');
            if (href) {
                let email = href.replace('mailto:', '').split('?')[0].toLowerCase().trim();
                email = _stripIdentifierPrefix(email);  // NEW-3 BUG-4 backport: strip CF/P.IVA prefix before TLD cleanup
                email = cleanTLD(email);  // FIX: Apply TLD cleaning
                if (email && email.includes('@') && !email.includes(' ')) {
                    const domain = email.split('@')[1];
                    if (!blacklist.some(bl => domain && domain.includes(bl))) {
                        emails.add(email);
                    }
                }
            }
        });

        // ═══════════════════════════════════════════════════
        // 2. Extract from visible text content
        // ═══════════════════════════════════════════════════
        const bodyText = document.body?.innerText || '';
        const textMatches = bodyText.match(emailPattern) || [];
        textMatches.forEach(email => {
            let clean = email.toLowerCase().trim();
            clean = _stripIdentifierPrefix(clean);  // NEW-3 BUG-4 backport: strip CF/P.IVA prefix before TLD cleanup
            clean = cleanTLD(clean);  // FIX: Apply TLD cleaning
            const domain = clean.split('@')[1];
            if (domain && !blacklist.some(bl => domain.includes(bl))) {
                // Filter out CSS-like patterns
                if (!clean.includes('..') && !clean.startsWith('.') && !clean.endsWith('.')) {
                    emails.add(clean);
                }
            }
        });

        // ═══════════════════════════════════════════════════
        // 3. Extract from data attributes and hidden fields
        // ═══════════════════════════════════════════════════
        const elements = document.querySelectorAll('[data-email], [data-mail], input[type="hidden"]');
        elements.forEach(el => {
            const value = el.getAttribute('data-email') ||
                el.getAttribute('data-mail') ||
                el.getAttribute('value') || '';
            const matches = value.match(emailPattern) || [];
            matches.forEach(email => {
                let clean = email.toLowerCase().trim();
                clean = _stripIdentifierPrefix(clean);  // NEW-3 BUG-4 backport: strip CF/P.IVA prefix before TLD cleanup
                clean = cleanTLD(clean);  // FIX: Apply TLD cleaning
                const domain = clean.split('@')[1];
                if (domain && !blacklist.some(bl => domain.includes(bl))) {
                    emails.add(clean);
                }
            });
        });

        // ═══════════════════════════════════════════════════
        // 4. Extract social media links
        // ═══════════════════════════════════════════════════
        const socialPatterns = {
            facebook: /facebook\.com\/[^\/\s"'<>]+/gi,
            instagram: /instagram\.com\/[^\/\s"'<>]+/gi,
            twitter: /(?:twitter|x)\.com\/[^\/\s"'<>]+/gi,
            linkedin: /linkedin\.com\/(?:company|in)\/[^\/\s"'<>]+/gi
        };

        const html = document.body?.innerHTML || '';
        for (const [platform, pattern] of Object.entries(socialPatterns)) {
            const matches = html.match(pattern);
            if (matches && matches.length > 0) {
                // Take the first valid match
                socialLinks[platform] = 'https://' + matches[0];
            }
        }

        // ═══════════════════════════════════════════════════
        // 5. ITALIAN B2B FEATURE: Extract Partita IVA and Codice Fiscale
        // ═══════════════════════════════════════════════════
        const fullText = bodyText + ' ' + html;

        // Partita IVA — shared SSOT (lib/partitaIva.js): checksum-validated, handles
        // composite labels like "P.IVA/C.F. NNN" / "Cod.Fisc./Part.IVA/... NNN".
        italianTaxCodes.partitaIva = extractPartitaIva(fullText);
        if (italianTaxCodes.partitaIva) console.log('[Ghost Map Tab] ✓ Found P.IVA:', italianTaxCodes.partitaIva);

        // Codice Fiscale pattern (16 alphanumeric chars)
        const cfPattern = /(?:C\.?\s*F\.?|Codice\s*Fiscale|Fiscal\s*Code)[:\s]*([A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z])\b/gi;
        cfPattern.lastIndex = 0;
        const cfMatch = cfPattern.exec(fullText.toUpperCase());
        if (cfMatch && cfMatch[1]) {
            italianTaxCodes.codiceFiscale = cfMatch[1].toUpperCase();
            console.log('[Ghost Map Tab] ✓ Found C.F.:', cfMatch[1]);
        }

    } catch (error) {
        console.error('[Ghost Map] DOM extraction error:', error);
    }

    return {
        emails: Array.from(emails),
        socialLinks,
        italianTaxCodes
    };
}

/**
 * Safely close a tab and its enclosing popup window.
 *
 * B5-3 P0 FIX (2026-05-10): when the tab was created via createTab() it
 * lives inside a minimized popup window — closing only the tab leaves
 * the popup window orphaned (empty popup window in user's window list).
 * This function now prefers `chrome.windows.remove(windowId)` which
 * closes the popup AND its inner tab atomically.
 *
 * Fallback to `chrome.tabs.remove(tabId)` is kept as a safety net in
 * case `cleanupTab` ever runs against a tab id that was NOT created via
 * createTab (currently no such call site exists, but the fallback
 * preserves correct behavior if one is ever introduced — and avoids
 * silently dropping cleanup work).
 *
 * Note for `tabs.onRemoved` listeners: window-level removal triggers
 * onRemoved for every contained tab — listeners must be idempotent.
 *
 * @param {number} tabId - Tab ID to close
 * @returns {Promise<void>}
 */
async function cleanupTab(tabId) {
    try {
        // Remove from persisted ledger (B5-4: eviction-safe) + activeTabWindows map (B5-3).
        // Extract windowId BEFORE deleting so popup-close path has it.
        // BG-1 FIX: removed dead `activeTabs.delete(tabId)` (undefined identifier).
        await _untrackActiveTab(tabId);
        const windowId = activeTabWindows.get(tabId);
        activeTabWindows.delete(tabId);

        if (windowId !== undefined) {
            // Fast path: tab was created by our createTab() in this SW
            // lifetime — close the whole popup window (closes inner tab
            // atomically).
            logger.info(`[TAB] Closing popup window (windowId: ${windowId}, tabId: ${tabId})...`);
            _recordOwnRemove({ tabId, windowId }, 'cleanupTab-main');
            await chrome.windows.remove(windowId).catch((err) => {
                // Window may already be closed (user closed it manually,
                // or a sibling cleanupTab raced us). Acceptable.
                logger.debug(`[TAB] Window remove note: ${err?.message || err}`);
            });
            logger.info(`[TAB] ✓ Popup window closed`);
        } else {
            // Recovery path: activeTabWindows lookup returned undefined.
            // Reasons: (a) SW eviction wiped the in-memory Map but the
            // persisted active-tabs ledger (B5-4) preserved the tabId;
            // (b) concurrent cleanupTab drained the map first; or (c)
            // anomaly. We log WARN here so production telemetry surfaces
            // unexpected fallback rates.
            //
            // CRITICAL SAFETY: do NOT blindly chrome.windows.remove(tab.windowId)
            // — if the tab somehow lives in the user's main window, that
            // would close the user's entire browsing window. Verify the
            // window's type === 'popup' before removing.
            logger.warn(`[TAB] cleanupTab fallback path (tabId: ${tabId}) — Map missing windowId`);
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab) {
                // Tab already gone — nothing to do.
                return;
            }
            const recoveredWindowId = tab.windowId;
            if (typeof recoveredWindowId === 'number') {
                const win = await chrome.windows.get(recoveredWindowId).catch(() => null);
                if (win && win.type === 'popup') {
                    logger.info(`[TAB] Closing recovered popup window (windowId: ${recoveredWindowId})...`);
                    _recordOwnRemove({ tabId, windowId: recoveredWindowId }, 'cleanupTab-recovery');
                    await chrome.windows.remove(recoveredWindowId).catch((err) => {
                        logger.debug(`[TAB] Window remove note (recovery): ${err?.message || err}`);
                    });
                    return;
                }
                // Window exists but is NOT a popup → don't touch it. Close
                // only the tab.
                logger.warn(`[TAB] Recovered window is type=${win?.type ?? 'unknown'} — closing tab only`);
            }
            _recordOwnRemove({ tabId }, 'cleanupTab-tab-fallback');
            await chrome.tabs.remove(tabId).catch((err) => {
                logger.debug(`[TAB] Tab remove note (fallback): ${err?.message || err}`);
            });
        }
    } catch (error) {
        // Tab/window might already be closed
        logger.debug(`[TAB] Cleanup note: ${error.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get ordered list of pages to try based on URL and priority
 * @param {string} baseUrl - Base website URL
 * @param {number} maxPages - Maximum pages to return
 * @returns {Array<{url: string, label: string}>}
 */
function getOrderedPages(baseUrl, maxPages) {
    try {
        const urlObj = new URL(baseUrl);
        const hostname = urlObj.hostname.toLowerCase();

        // Detect language from domain
        const isItalian = hostname.endsWith('.it') || hostname.includes('italy') || hostname.includes('italia');
        const isGerman = hostname.endsWith('.de') || hostname.endsWith('.at') || hostname.endsWith('.ch');
        const isSpanish = hostname.endsWith('.es');

        // Build prioritized list - BLOCK-L2 FIX: Use getter for CONFIG priority
        let pages = [...getPagePriorities()];

        // Boost language-specific pages
        if (isItalian) {
            pages = pages.map(p => ({
                ...p,
                priority: (p.path.includes('contatti') || p.path.includes('chi-siamo') || p.path.includes('chi-sono')) ? 0.5 : p.priority
            }));
        } else if (isGerman) {
            pages = pages.map(p => ({
                ...p,
                priority: p.path.includes('kontakt') ? 0.5 : p.priority
            }));
        } else if (isSpanish) {
            pages = pages.map(p => ({
                ...p,
                priority: p.path.includes('contacto') ? 0.5 : p.priority
            }));
        }

        // Sort by priority
        pages.sort((a, b) => a.priority - b.priority);

        // Build full URLs
        const result = [];
        const seen = new Set();

        for (const page of pages) {
            if (result.length >= maxPages) break;

            const fullUrl = new URL(page.path, baseUrl).toString().replace(/\/$/, '');

            // Skip duplicates
            if (seen.has(fullUrl.toLowerCase())) continue;
            seen.add(fullUrl.toLowerCase());

            result.push({
                url: fullUrl,
                label: page.label
            });
        }

        return result;

    } catch (error) {
        logger.warn(`[TAB] URL parsing error: ${error.message}`);
        return [{ url: baseUrl, label: '🏠 Homepage' }];
    }
}

/**
 * Force cleanup of all active tabs (for emergency shutdown)
 * @returns {Promise<void>}
 */
export async function forceCleanupAllTabs() {
    // B5-4 P0 FIX: read from persisted ledger so tabs left orphaned by SW
    // eviction (during a previous SW lifetime) are also closed. Pre-fix the
    // in-memory Set was empty after eviction → forceCleanup was a no-op
    // → orphan tabs accumulated.
    const tabIds = await _getActiveTabs();
    logger.info(`[TAB FALLBACK] Force cleanup: ${tabIds.length} active tab(s) from ledger`);

    const promises = tabIds.map(tabId => cleanupTab(tabId));
    await Promise.allSettled(promises);

    // Defensive clear: persisted ledger (B5-4) + activeTabWindows map (B5-3).
    // cleanupTab already untracks each id; this is belt-and-suspenders.
    // BG-1 FIX: removed dead `activeTabs.clear()` (undefined identifier).
    await _activeTabsState.set([]);
    activeTabWindows.clear();

    logger.info(`[TAB FALLBACK] ✓ Force cleanup complete`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    scrapeWithTab,
    shouldRetryWithTab,
    forceCleanupAllTabs,
    getTabCloseTelemetry,
    TAB_CONFIG,
    RETRY_ELIGIBLE_ERRORS
};
