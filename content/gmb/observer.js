/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - DOM Observer
 * Robust business listing detection with selector fallbacks
 * Optimized for manual scrolling workflow
 * 
 * PATCHED: Added website text extraction fallback for hotels
 */

import { CONFIG, getElements } from '../../lib/config.js';
import { logger, debounce, isInViewport, isValidPhone } from '../../lib/utils.js';
import { SelectorEngine } from '../../lib/SelectorEngine.js';
// BUG #12 FIX: Use centralized phone normalization
import { normalizePhone } from '../../lib/phone-normalizer.js';
// Step 03-03: Sanitize DOM-extracted data before messaging
import { sanitizeBusinessData } from '../../lib/sanitize.js';

/**
 * Simple LRU Cache to prevent memory leaks
 */
class LRUCache {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    add(key) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, true);
    }

    has(key) {
        return this.cache.has(key);
    }

    clear() {
        this.cache.clear();
    }

    get size() {
        return this.cache.size;
    }
}

export class DOMObserver {
    // BLOCK-3 FIX (MED-009): Maximum queue size - extreme safety limit
    // Very high (50k) - only triggers if something goes catastrophically wrong
    static MAX_PROCESSING_QUEUE_SIZE = 50000;
    // BLOCK-3 FIX (CRIT-006): Max time (ms) to wait for IntersectionObserver before cleanup
    static PENDING_ELEMENT_TIMEOUT = 60000; // 60 seconds

    constructor(config, onNewBusiness) {
        this.config = config;
        this.onNewBusiness = onNewBusiness;
        this.observer = null;
        this.intersectionObserver = null;
        // BUG-012 FIX: Use CONFIG value instead of hardcoded 10000
        this.processedUrls = new LRUCache(CONFIG.limits.LRU_CACHE_SIZE || 10000);
        this.processingQueue = [];
        this.isProcessing = false;

        this.debouncedProcess = debounce(() => this.processQueue(), 500);
        this.selectorEngine = new SelectorEngine(config);
        this.elementToUrl = new WeakMap();
        // BLOCK-3 FIX (CRIT-006): Track pending elements with timestamps for cleanup
        this._pendingElements = new Map(); // element -> { url, addedAt }
        this._cleanupInterval = null;
        // R10: telemetry flush interval. Content scripts cannot directly access
        // the SW's Statistics singleton; we batch the engine's per-strategy
        // hit/miss counts and ship them via chrome.runtime every 60s, which the
        // SW handler hands to recordSelectorTelemetry.
        this._telemetryFlushInterval = null;

        // R-DETAIL (2026-05-05): detail-panel deep-extraction.
        // When the user opens a /maps/place/X URL (either via list click or
        // direct navigation), we run extractDetailFields on `[role="main"]`
        // and ship the 6 CSV-only enrichment fields to the SW. These fields
        // are NOT shown in the sidepanel UI — they only land in CSV export.
        // Dedup: one enrichment per (normalized URL) per session.
        this._enrichedUrls = new Set();
        this._lastDetailUrl = null;
        this._detailDebounceTimer = null;

        // R-STATE (2026-05-05): list-card phone via APP_INITIALIZATION_STATE.
        // For restaurants/pizzerie/pub Maps does NOT render the phone in the
        // list-card DOM, but it embeds it in window.APP_INITIALIZATION_STATE.
        // The MAIN-world content script `maps-state-watcher.js` decodes the
        // JSPB payload and posts a CID→phone map back via postMessage. We
        // cache the latest map here and consult it during extractBusinessData.
        // Coverage: ~75% of visible list-cards (sponsored + top-2 organic
        // results are loaded from a separate cache without phone — those
        // still rely on the detail-panel back-fill when the user clicks).
        this._stateCidPhoneMap = new Map();
        this._stateCidPhoneMapSize = 0;
        // R-STATE-FULL (2026-05-05): in addition to the phone-only legacy
        // map, the watcher now ships the FULL field catalog per business
        // (32+ fields including ratingDecimal, reviewsCount, hoursWeekly,
        // serviceOptions, priceHistogram, owner info, etc). We cache it
        // here and expose `_lookupStateBusiness(url)` for callers that
        // want richer data than the phone fallback alone.
        this._stateBusinessMap = new Map();
        this._stateBusinessMapSize = 0;
        this._stateMessageListener = null;
    }

    /**
     * Start observing
     */
    start() {
        logger.info('Starting DOM observer...');

        this.observer = new MutationObserver((mutations) => {
            this.handleMutations(mutations);
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // BUG-013 FIX: Increased randomization range (50-500px) for better anti-detection
        // Original was 100-300px which was too narrow and could form detectable patterns
        const randomMargin = Math.floor(Math.random() * 450) + 50;
        this.intersectionObserver = new IntersectionObserver(
            (entries) => this.handleIntersection(entries),
            {
                // BUG-013 FIX: Also randomize threshold slightly
                threshold: 0.05 + Math.random() * 0.1, // 0.05 to 0.15
                rootMargin: `${randomMargin}px`
            }
        );

        this.processExistingBusinesses();

        // BLOCK-3 FIX (CRIT-006): Start cleanup interval for orphaned pending elements
        this._cleanupInterval = setInterval(() => this._cleanupOrphanedElements(), 30000);

        // R10: periodic selector-telemetry flush to background. Reset of
        // local counters happens after a successful send so we never lose
        // data on transient message failures.
        this._telemetryFlushInterval = setInterval(() => this._flushSelectorTelemetry(), 60000);

        // R-DETAIL: arm the detail-panel watcher. It piggy-backs on the same
        // MutationObserver via handleMutations + handles SPA URL changes.
        this._setupDetailWatcher();

        // R-STATE: arm the APP_INITIALIZATION_STATE listener and request a
        // first refresh from the MAIN-world watcher.
        this._setupStateMapListener();

        logger.info('DOM observer started');
    }

    /**
     * R-STATE (2026-05-05): listen for CID→phone map posts from the MAIN-
     * world content script (`maps-state-watcher.js`). The watcher polls
     * `window.APP_INITIALIZATION_STATE` every 4s and posts the derived map
     * via `window.postMessage`. We dedupe via JSON-equality on the watcher
     * side so we only get a message when the map actually changes.
     * @private
     */
    _setupStateMapListener() {
        try {
            this._stateMessageListener = (event) => {
                // Cross-world postMessage filter: in Chrome MV3, a content
                // script in ISOLATED world receives messages from the MAIN
                // world. The `event.source === window` identity check is
                // unreliable across the world boundary (Chrome wraps the
                // window proxy differently per world). The robust filter is
                // origin-based — same-origin messages cannot be spoofed by
                // a cross-frame attacker, and our payload schema is
                // additionally validated below.
                // CT-4 FIX (2026-05-27): strict origin equality. The previous
                // guard used a truthy short-circuit on event.origin, which
                // allowed messages with a falsy origin (empty string, null)
                // to bypass the same-origin check. Every legitimate sender
                // in the codebase calls window.postMessage(..., location.origin),
                // so the browser always sets event.origin to a non-empty
                // string for valid traffic — removing the short-circuit has
                // zero behavioural cost on valid flows and closes the bypass.
                if (event.origin !== location.origin) return;
                const data = event.data;
                // R-DETAIL-FETCH (v9.8): bridge MAIN→ISOLATED for the
                // detail-fetcher feature flag. detail-fetcher.js (MAIN)
                // reads window.__gmpEnableDetailFetch and broadcasts the
                // value here at install + on demand. We cache it on the
                // observer instance so _maybeFireDetailFetch can consult
                // it across the world boundary.
                if (data && data.type === 'gmp:detail:flag-state') {
                    this._detailFetchFlagFromMain = !!data.enabled;
                    logger.debug(`[R-DETAIL-FETCH] flag from MAIN world: ${this._detailFetchFlagFromMain}`);
                    return;
                }
                // B2-4 FIX (2026-05-10): forward detail-fetcher kill-switch
                // state changes from MAIN world to SW. Pre-fix the kill switch
                // was silent — sidepanel showed "scraping in progress" while
                // ALL subsequent enrichment failed silently. Forwarded
                // payload reaches sidepanel via chrome.runtime.sendMessage
                // broadcast (auto-delivered to all listeners).
                if (data && data.type === 'gmp:detail:kill-switch') {
                    try {
                        chrome.runtime.sendMessage({
                            action: 'detail_fetcher_kill_switch',
                            payload: {
                                tripped: !!data.tripped,
                                consecutiveFails: typeof data.consecutiveFails === 'number' ? data.consecutiveFails : 0,
                                timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now()
                            }
                        }).catch(() => { /* sidepanel/SW closed — acceptable */ });
                    } catch (err) {
                        logger.debug(`[R-DETAIL-FETCH] kill-switch forward failed: ${err?.message}`);
                    }
                    return;
                }
                if (!data || data.type !== 'gmp:state-map') return;
                const payload = data.payload;
                if (!payload) return;
                // Phone-only map (legacy compat)
                if (payload.map && typeof payload.map === 'object') {
                    this._stateCidPhoneMap = new Map();
                    for (const [cid, entry] of Object.entries(payload.map)) {
                        if (cid && entry && (entry.formatted || entry.canonical)) {
                            this._stateCidPhoneMap.set(cid.toLowerCase(), entry);
                        }
                    }
                    this._stateCidPhoneMapSize = this._stateCidPhoneMap.size;
                }
                // Full business field catalog
                if (payload.businesses && typeof payload.businesses === 'object') {
                    this._stateBusinessMap = new Map();
                    for (const [cid, biz] of Object.entries(payload.businesses)) {
                        if (cid && biz && typeof biz === 'object') {
                            this._stateBusinessMap.set(cid.toLowerCase(), biz);
                        }
                    }
                    this._stateBusinessMapSize = this._stateBusinessMap.size;
                }
                // Visible diagnostic (info level) so users can confirm in
                // DevTools console that state extraction is wired up.
                logger.info(`[R-STATE] map updated: ${this._stateCidPhoneMapSize} phones, ${this._stateBusinessMapSize} full businesses`);
            };
            window.addEventListener('message', this._stateMessageListener);

            // Kick the watcher: ask for a fresh extraction now so we don't
            // wait the 4s poll interval before the first map arrives.
            window.postMessage({ type: 'gmp:state-map-request' }, location.origin);
            // R-DETAIL-FETCH (v9.8): also ask the detail-fetcher (MAIN
            // world) to re-broadcast the current value of its feature
            // flag — covers the case where the install-time broadcast
            // landed before our listener was armed.
            window.postMessage({ type: 'gmp:detail:flag-request' }, location.origin);

            // B2-1 FIX (2026-05-10): periodic re-arm of the watcher poll.
            // The MAIN-world watcher (maps-state-watcher.js:115,542) caps
            // polling at MAX_POLL_MS = 5 min. After 5 min of polling, the
            // setInterval is cleared and the watcher goes silent — meaning
            // any new business cards loaded via SPA scroll/navigation are
            // NOT captured into _stateBusinessMap. The watcher only re-arms
            // when it receives a `gmp:state-map-request` postMessage. Pre-
            // fix that request was sent ONCE at observer start, so 5 min
            // later the state map went stale.
            //
            // Fix: send the request every 4 minutes (50 % below MAX_POLL_MS)
            // so `pollStartedAt` is always reset before the watcher times
            // out. The watcher's lastMapJson dedupe ensures repeated
            // requests with no new data don't post duplicate maps.
            //
            // Defensive: null-check before assigning to avoid leaking timers
            // if _setupStateMapListener is somehow called twice. Inside the
            // interval callback, also guard on `_stateMessageListener` so a
            // leaked timer post-teardown silently no-ops.
            const STATE_REARM_MS = 4 * 60 * 1000;
            if (!this._stateRearmTimer) {
                this._stateRearmTimer = setInterval(() => {
                    // Guard: don't post if listener was torn down (defensive
                    // against leaked timers, e.g. if clearInterval missed).
                    if (!this._stateMessageListener) return;
                    try {
                        window.postMessage({ type: 'gmp:state-map-request' }, location.origin);
                    } catch (err) {
                        logger.debug(`[R-STATE] re-arm postMessage failed: ${err?.message}`);
                    }
                }, STATE_REARM_MS);
            }

            // R-STATE FALLBACK (2026-05-05): if the manifest-declared MAIN-
            // world content script failed to install (Chrome version, race
            // condition, or extension reload without page refresh), self-
            // inject the watcher as a `<script src=…>` element. Web-accessible
            // resources can be loaded as scripts and execute in MAIN world.
            //
            // We arm a 3-second probe: if the watcher hasn't posted by then,
            // we inject. This makes the integration robust to MV3 quirks.
            this._stateFallbackTimer = setTimeout(() => {
                if (this._stateBusinessMapSize > 0 || this._stateCidPhoneMapSize > 0) return;
                try {
                    const url = chrome.runtime.getURL('content/gmb/maps-state-watcher.js');
                    const script = document.createElement('script');
                    script.src = url;
                    script.onload = () => {
                        script.remove();
                        // Re-request a tick now that the watcher is loaded
                        window.postMessage({ type: 'gmp:state-map-request' }, location.origin);
                    };
                    script.onerror = (err) => {
                        logger.warn(`[R-STATE] fallback inject failed: ${err?.message || err}`);
                        script.remove();
                    };
                    (document.head || document.documentElement).appendChild(script);
                    logger.info('[R-STATE] manifest watcher silent — injected fallback script');
                } catch (err) {
                    logger.debug(`[R-STATE] fallback inject error: ${err?.message}`);
                }
            }, 3000);
        } catch (err) {
            logger.debug(`[R-STATE] listener setup skipped: ${err?.message}`);
        }
    }

    /**
     * R-STATE: detach the postMessage listener (called from stop()).
     * @private
     */
    _teardownStateMapListener() {
        try {
            if (this._stateMessageListener) {
                window.removeEventListener('message', this._stateMessageListener);
                this._stateMessageListener = null;
            }
            if (this._stateFallbackTimer) {
                clearTimeout(this._stateFallbackTimer);
                this._stateFallbackTimer = null;
            }
            // B2-1 FIX (2026-05-10): clear the periodic re-arm timer so it
            // doesn't continue posting requests at a dead listener.
            if (this._stateRearmTimer) {
                clearInterval(this._stateRearmTimer);
                this._stateRearmTimer = null;
            }
            this._stateCidPhoneMap.clear();
            this._stateCidPhoneMapSize = 0;
            this._stateBusinessMap.clear();
            this._stateBusinessMapSize = 0;
        } catch { /* best-effort */ }
    }

    /**
     * R-STATE-FULL: lookup the FULL business field record by URL.
     * Returns the catalog object (title, ratingDecimal, reviewsCount,
     * categoryCodes, priceHistogram, hoursWeekly, serviceOptions, owner*,
     * adminRegions, postcode, …) or null when no entry is cached. Used
     * by callers that need richer data than the phone fallback alone.
     * @public
     */
    lookupStateBusiness(url) {
        if (!this._stateBusinessMap || this._stateBusinessMap.size === 0) return null;
        const cid = this._cidFromUrl(url);
        if (!cid) return null;
        return this._stateBusinessMap.get(cid) || null;
    }

    /**
     * R-STATE: extract Maps CID from a place URL. Matches all three Maps URL
     * shapes a list-card may have AND all post-normalization shapes the SW
     * stores (so calling this on a saved URL also works):
     *
     *   1. `/maps/place/X/data=!4m…!1s0xHEX:0xHEX!8m…` — long form (list-card href)
     *   2. `/maps/place/X?cid=0xHEX:0xHEX`            — short form, raw `:`
     *   3. `/maps/place/X?cid=0xHEX%3A0xHEX`          — short form, URL-encoded
     *
     * The third form is what `lib/urlNormalizer.js` + `db._normalizeGoogleMapsUrl`
     * produce as the canonical stored URL: extract from `data=`, rebuild as
     * `?cid=`, then `new URL().toString()` percent-encodes `:` → `%3A`. This
     * caused all state-derived columns to come up empty in CSVs.
     *
     * Returns lowercased CID `0xhex:0xhex` (canonical state-map key) or null.
     * @private
     */
    _cidFromUrl(url) {
        if (!url || typeof url !== 'string') return null;
        // Form 1: data=…!1s0xHEX:0xHEX (long form)
        let m = url.match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/i);
        if (m) return m[1].toLowerCase();
        // Form 2 + 3: ?cid=0xHEX(:|%3A)0xHEX (short form, raw or encoded `:`)
        m = url.match(/[?&]cid=(0x[a-f0-9]+)(?::|%3A)(0x[a-f0-9]+)/i);
        if (m) return `${m[1]}:${m[2]}`.toLowerCase();
        return null;
    }

    /**
     * R-DETAIL-FETCH: extract every identifier needed to call
     * /maps/preview/place programmatically (CID, FID, placeId, lat,
     * lng) from the long-form list-card href. Returns null when the
     * href lacks any required field.
     *
     * Long form: /maps/place/<name>/data=!4m7!3m6
     *   !1s<CID>!8m2!3d<lat>!4d<lng>!16s<FID>!19s<placeId>
     *
     * @private
     */
    _idsFromUrl(url) {
        if (!url || typeof url !== 'string') return null;
        const cid = this._cidFromUrl(url);
        if (!cid) return null;
        const fidMatch = url.match(/!16s([^!?&#]+)/);
        const pidMatch = url.match(/!19s([A-Za-z0-9_-]+)/);
        const latMatch = url.match(/!8m2!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
        if (!fidMatch || !pidMatch || !latMatch) return null;
        const fidRaw = decodeURIComponent(fidMatch[1]);
        return {
            cid,
            fid: fidRaw.startsWith('/') ? fidRaw : `/${fidRaw}`,
            placeId: pidMatch[1],
            lat: parseFloat(latMatch[1]),
            lng: parseFloat(latMatch[2]),
        };
    }

    /**
     * R-DETAIL-FETCH: programmatically pull the place detail (phone,
     * address, website, ...) via the /maps/preview/place endpoint
     * without simulating a DOM click. The fetch runs in the MAIN-world
     * helper (`detail-fetcher.js`); we relay the request via
     * postMessage and resolve when the response arrives or after
     * `timeoutMs`. Returns `{ ok, fields, error }`.
     *
     * @public
     */
    /**
     * R-DETAIL-FETCH: opportunistic auto-fire of the place-detail fetcher
     * for a discovered card. Fire-and-forget — the result is dispatched
     * to the SW via the existing `business_enrichment` action, which
     * fills phone/website/address/rating holes in the saved record.
     *
     * Skips when:
     *   - feature flag disabled (CONFIG.detailFetch.enabled === false AND
     *     window.__gmpEnableDetailFetch !== true)
     *   - business already has a phone (nothing to enrich for the most
     *     valuable field — rating/address are usually populated from
     *     state-map already)
     *   - href doesn't parse to all 5 ids (rare, but skip rather than
     *     send a known-bad request)
     *   - this URL was already submitted in the current session (dedup)
     *
     * @private
     */
    _maybeFireDetailFetch(business) {
        try {
            // 4 ways to enable, in priority order:
            //   1. CONFIG.detailFetch.enabled = true (file-based, requires extension reload)
            //   2. localStorage `gmp.detailFetchEnabled === '1'` (per-origin, survives page reload)
            //   3. _detailFetchFlagFromMain (cached from MAIN→ISOLATED postMessage bridge —
            //      set when user did `window.__gmpEnableDetailFetch=true` then page reload)
            //   4. window.__gmpEnableDetailFetch (ISOLATED-world only — volatile, redundant
            //      with #3 when MAIN→ISOLATED bridge is intact)
            let lsEnabled = false;
            try { lsEnabled = localStorage.getItem('gmp.detailFetchEnabled') === '1'; } catch { /* ignore */ }
            const flagOn = (CONFIG.detailFetch && CONFIG.detailFetch.enabled === true)
                || lsEnabled
                || this._detailFetchFlagFromMain === true
                || (typeof window !== 'undefined' && window.__gmpEnableDetailFetch === true);
            if (!flagOn) return;
            if (!business || !business.googleMapsUrl) return;
            if (business.phone) return;       // common path, no log noise
            const ids = this._idsFromUrl(business.googleMapsUrl);
            if (!ids) {
                logger.debug(`[R-DETAIL-FETCH] skip ${business.title?.slice(0,40)}: href ids unparseable`);
                return;
            }
            if (!this._detailFetchAttempted) this._detailFetchAttempted = new Set();
            if (this._detailFetchAttempted.has(business.googleMapsUrl)) return;
            this._detailFetchAttempted.add(business.googleMapsUrl);

            logger.info(`[R-DETAIL-FETCH] FIRE for ${business.title?.slice(0,40)} (cid=${ids.cid.slice(0,20)}...)`);

            // Async fire-and-forget. Errors are swallowed — the kill-switch
            // and backoff inside detail-fetcher.js handle systemic failures;
            // single-card failures should not noise the console.
            this.fetchDetailViaNetwork(business.googleMapsUrl).then((result) => {
                if (!result || !result.ok || !result.fields) {
                    logger.info(`[R-DETAIL-FETCH] no-result for ${business.title?.slice(0,40)}: ok=${result?.ok} status=${result?.status} err=${result?.error}`);
                    return;
                }
                const fields = {};
                if (result.fields.phone)   fields.phone   = result.fields.phone;
                if (result.fields.website) fields.website = result.fields.website;
                if (result.fields.address) fields.address = result.fields.address;
                if (result.fields.rating != null) fields.rating = result.fields.rating;
                // EXP-01 FIX (2026-06-10): propagate the card-URL coordinates
                // (already parsed into `ids` and REQUIRED by the detail-fetch
                // payload) into the enrichment. Pre-fix only the JSPB state
                // catalog populated latitude/longitude (~21% of rows), so the
                // export radius filter ran fail-open on the other ~79%. Named
                // latitude/longitude to match the record schema consumed by
                // data-exporter's DISCARD_OUT_OF_RADIUS. Added BEFORE the
                // empty-check on purpose: a coords-only enrichment is now
                // worth shipping — closing that coverage gap is the point.
                if (Number.isFinite(ids.lat) && Number.isFinite(ids.lng)) {
                    fields.latitude = ids.lat;
                    fields.longitude = ids.lng;
                }
                if (Object.keys(fields).length === 0) {
                    logger.info(`[R-DETAIL-FETCH] empty fields for ${business.title?.slice(0,40)}`);
                    return;
                }
                logger.info(`[R-DETAIL-FETCH] enriched ${business.title?.slice(0,40)}: phone=${fields.phone || 'n/a'} website=${fields.website ? 'yes' : 'no'} (${result.latencyMs}ms)`);
                try {
                    chrome.runtime.sendMessage({
                        action: 'business_enrichment',
                        payload: {
                            googleMapsUrl: business.googleMapsUrl,
                            fields,
                        },
                    });
                } catch (err) {
                    logger.debug('[R-DETAIL-FETCH] sendMessage failed:', err?.message);
                }
            }).catch(() => { /* best-effort */ });
        } catch (err) {
            logger.debug('[R-DETAIL-FETCH] fire skipped:', err?.message);
        }
    }

    fetchDetailViaNetwork(href, { timeoutMs = 12000, query = 'place' } = {}) {
        return new Promise((resolve) => {
            const ids = this._idsFromUrl(href);
            if (!ids) { resolve({ ok: false, error: 'href_missing_ids' }); return; }
            const id = `gmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const handler = (event) => {
                if (event.source !== window) return;
                const data = event.data;
                if (!data || data.type !== 'gmp:detail:response' || data.id !== id) return;
                window.removeEventListener('message', handler);
                clearTimeout(timer);
                resolve({ ok: !!data.ok, fields: data.fields || null, status: data.status, latencyMs: data.latencyMs, error: data.error || null });
            };
            const timer = setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve({ ok: false, error: 'timeout' });
            }, timeoutMs);
            window.addEventListener('message', handler);
            window.postMessage({
                type: 'gmp:detail:request',
                id,
                payload: { ...ids, query },
            }, location.origin);
        });
    }

    /**
     * R-STATE: lookup a list-card phone in the cached state map.
     * Prefers the formatted phone ("+39 02 8645 3482") when available,
     * falls back to the canonical digit string ("0286453482"). Returns null
     * when no entry is cached (caller falls through to selector / regex /
     * detail-panel back-fill paths).
     * @private
     */
    _lookupStatePhone(url) {
        if (!this._stateCidPhoneMap || this._stateCidPhoneMap.size === 0) return null;
        const cid = this._cidFromUrl(url);
        if (!cid) return null;
        const entry = this._stateCidPhoneMap.get(cid);
        if (!entry) return null;
        // Prefer formatted (locale-aware, +39 prefix already applied);
        // canonical is a digit-only string suitable for tel: but less
        // human-friendly in CSV.
        return entry.formatted || entry.canonical || null;
    }

    /**
     * R-DETAIL: install URL change + initial-state hooks.
     * Maps is a SPA — `history.pushState`/`replaceState` mutate the URL
     * without firing `popstate`. We monkey-patch them once, plus listen
     * to `popstate`, and finally fire once for the current URL on start.
     * @private
     */
    _setupDetailWatcher() {
        try {
            // Bound trigger so we can remove the listener on stop().
            this._detailTrigger = () => this._onDetailUrlMaybeChanged();

            // History API hooks (idempotent across observer.start/stop cycles)
            if (!window.__ghostMapHistoryHooked) {
                const origPush = history.pushState;
                const origReplace = history.replaceState;
                history.pushState = function (...args) {
                    const r = origPush.apply(this, args);
                    window.dispatchEvent(new Event('ghostmap:locationchange'));
                    return r;
                };
                history.replaceState = function (...args) {
                    const r = origReplace.apply(this, args);
                    window.dispatchEvent(new Event('ghostmap:locationchange'));
                    return r;
                };
                window.__ghostMapHistoryHooked = true;
            }

            window.addEventListener('popstate', this._detailTrigger);
            window.addEventListener('ghostmap:locationchange', this._detailTrigger);

            // Initial fire (Maps may already be on a /maps/place/X URL)
            this._onDetailUrlMaybeChanged();
        } catch (err) {
            logger.debug(`[R-DETAIL] watcher setup skipped: ${err?.message}`);
        }
    }

    /**
     * R-DETAIL: remove watcher listeners (called from stop()).
     * @private
     */
    _teardownDetailWatcher() {
        try {
            if (this._detailTrigger) {
                window.removeEventListener('popstate', this._detailTrigger);
                window.removeEventListener('ghostmap:locationchange', this._detailTrigger);
                this._detailTrigger = null;
            }
            if (this._detailDebounceTimer) {
                clearTimeout(this._detailDebounceTimer);
                this._detailDebounceTimer = null;
            }
        } catch { /* best-effort */ }
    }

    /**
     * R-DETAIL: react to URL change. Debounce so SPA transitions settle.
     * @private
     */
    _onDetailUrlMaybeChanged() {
        try {
            const url = window.location.href;
            // Only act on /maps/place/ pages — list/search pages have no detail panel.
            if (!url.includes('/maps/place/')) return;
            // Skip if we've already enriched this URL this session.
            const normalized = this._sessionEnrichmentKey(url);
            if (!normalized || this._enrichedUrls.has(normalized)) return;
            // Debounce — Maps re-renders the panel in chunks; wait for it to settle.
            if (this._detailDebounceTimer) {
                clearTimeout(this._detailDebounceTimer);
            }
            this._lastDetailUrl = normalized;
            this._detailDebounceTimer = setTimeout(() => this._tryEnrichDetail(normalized), 1200);
        } catch (err) {
            logger.debug(`[R-DETAIL] url-change handler error: ${err?.message}`);
        }
    }

    /**
     * R-DETAIL: extract the 6 deep-fields and ship to SW for DB merge.
     * Never throws; failures are logged at debug level.
     * @param {string} normalizedUrl - canonical URL key
     * @private
     */
    _tryEnrichDetail(normalizedUrl) {
        try {
            // Re-check URL — user may have navigated away during the debounce.
            if (this._sessionEnrichmentKey(window.location.href) !== normalizedUrl) return;

            const main = document.querySelector('div[role="main"][aria-label]')
                      || document.querySelector('[role="main"]');
            if (!main) {
                logger.debug('[R-DETAIL] no [role=main] yet; skipping enrich');
                return;
            }
            // Sanity: aria-label must look like a place name (not "Google Maps")
            const ariaLabel = main.getAttribute('aria-label') || '';
            if (!ariaLabel || /^google maps$/i.test(ariaLabel)) return;

            const fields = this.selectorEngine.extractDetailFields(main, window.location.href);
            // Require at least one non-default field — otherwise the panel
            // hasn't rendered yet (placeId from URL counts as a real signal).
            if (!fields.placeId
                && !fields.description
                && fields.claimStatus === 'unknown'
                && !fields.lastUpdatedByOwner
                && fields.reviewThemes.length === 0
                && !fields.reviewDistribution
                && !fields.phone) {
                logger.debug('[R-DETAIL] panel not populated; deferring');
                return;
            }

            // 2026-05-05: normalize+validate the detail-panel phone before
            // shipping. Pizzerie/pub list cards regressed because their phones
            // never appeared in list-text — the detail panel is the only DOM
            // surface where the canonical number is reliable.
            let phoneNormalized = null;
            if (fields.phone) {
                if (isValidPhone(fields.phone)) {
                    phoneNormalized = normalizePhone(fields.phone, { country: 'IT' });
                } else {
                    logger.debug(`[R-DETAIL] phone "${fields.phone}" rejected by isValidPhone`);
                }
            }

            // Step 03-03: re-use the central sanitizer on string fields.
            // We deliberately keep arrays/objects as-is — the CSV layer
            // will serialize them (sanitizeBusinessData ignores non-string
            // values). placeId/description/lastUpdatedByOwner are strings.
            const stringPart = sanitizeBusinessData({
                placeId: fields.placeId || null,
                description: fields.description || null,
                claimStatus: fields.claimStatus,
                lastUpdatedByOwner: fields.lastUpdatedByOwner || null,
                phone: phoneNormalized
            });
            const payload = {
                googleMapsUrl: normalizedUrl,
                fields: {
                    placeId: stringPart.placeId,
                    description: stringPart.description,
                    claimStatus: stringPart.claimStatus,
                    lastUpdatedByOwner: stringPart.lastUpdatedByOwner,
                    reviewThemes: fields.reviewThemes,
                    reviewDistribution: fields.reviewDistribution,
                    phone: stringPart.phone
                }
            };
            // EXP-01 FIX (2026-06-10): best-effort coordinates from the
            // detail-panel URL (!8m2!3d<lat>!4d<lng>). Added AFTER the
            // "panel not populated" gate above — URL-derived coords must
            // never satisfy that gate, or the defer-retry would be skipped
            // and the real panel fields lost.
            try {
                const urlIds = this._idsFromUrl(window.location.href);
                if (urlIds && Number.isFinite(urlIds.lat) && Number.isFinite(urlIds.lng)) {
                    payload.fields.latitude = urlIds.lat;
                    payload.fields.longitude = urlIds.lng;
                }
            } catch { /* coords are opportunistic — never block the enrichment */ }

            chrome.runtime.sendMessage(
                { action: 'business_enrichment', payload },
                (response) => {
                    if (chrome.runtime.lastError) {
                        logger.debug(`[R-DETAIL] enrich send: ${chrome.runtime.lastError.message}`);
                        return;
                    }
                    // Mark as enriched only when SW confirmed it (or no listener — best-effort).
                    this._enrichedUrls.add(normalizedUrl);
                    if (response && response.status) {
                        logger.info(`[R-DETAIL] ${response.status} for ${ariaLabel}`);
                    }
                }
            );
        } catch (err) {
            logger.debug(`[R-DETAIL] enrich error: ${err?.message}`);
        }
    }

    /**
     * R-DETAIL: session-level enrichment dedup key (origin + pathname only).
     *
     * NOT a DB key. The DB key is produced by `urlNormalizer.getCanonicalDbKey`
     * (used in the SW). This is intentionally coarser — it groups together
     * different `?cid=...` shapes of the same `/maps/place/X` path so that
     * scrolling through SPA-nav variations doesn't re-fire enrichment N times.
     *
     * Renamed from `_normalizeMapsUrl` (v9.10, 2026-05-07) — old name implied
     * "canonical normalize" but the function deliberately drops the query.
     * @private
     */
    _sessionEnrichmentKey(url) {
        try {
            const u = new URL(url);
            return u.origin + u.pathname;
        } catch {
            return url || null;
        }
    }

    /**
     * R10: ship selector telemetry to the SW Statistics singleton via
     * chrome.runtime. Resets the local engine counters only on success.
     * Designed to never throw — telemetry must not break extraction.
     * @private
     */
    _flushSelectorTelemetry() {
        try {
            if (!this.selectorEngine || typeof this.selectorEngine.getTelemetry !== 'function') return;
            const snapshot = this.selectorEngine.getTelemetry();
            if (!snapshot || snapshot.length === 0) return;

            chrome.runtime.sendMessage(
                { action: 'selector_telemetry', payload: { snapshot } },
                (response) => {
                    // Treat both an explicit ack AND a missing response (port closed
                    // because no listener) as best-effort delivery. Never throw.
                    if (chrome.runtime.lastError) {
                        logger.debug(`[R10] telemetry send: ${chrome.runtime.lastError.message}`);
                        return;
                    }
                    if (response && response.ok) {
                        // Success: reset local counters so we don't double-send.
                        this.selectorEngine.resetTelemetry?.();
                    }
                }
            );
        } catch (err) {
            logger.debug(`[R10] telemetry flush skipped: ${err.message}`);
        }
    }

    /**
     * Stop observing
     */
    stop() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }

        // BLOCK-3 FIX (CRIT-006): Clear cleanup interval
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
        this._pendingElements.clear();

        // R10: stop the telemetry flush + send final snapshot before tear-down.
        if (this._telemetryFlushInterval) {
            clearInterval(this._telemetryFlushInterval);
            this._telemetryFlushInterval = null;
        }
        try { this._flushSelectorTelemetry(); } catch { /* best-effort */ }

        // R-DETAIL: detach detail-panel watcher.
        this._teardownDetailWatcher();

        // R-STATE: detach postMessage listener.
        this._teardownStateMapListener();

        // CO-4 FIX (2026-05-10): clear unbounded dedup Sets on stop().
        // Pre-fix `_enrichedUrls` (line 89) and `_detailFetchAttempted` (lazy
        // init at ~471) grew with every distinct business URL the user
        // encountered and were never pruned — neither here nor in reset().
        // On a long Maps session scrolling thousands of businesses (area
        // search across multiple Italian provinces, ~50k+ businesses), each
        // Set accumulated tens of thousands of URL strings (~200 chars each
        // = ~10 MB per Set per tab). On a low-RAM machine the tab eventually
        // crashed, losing in-progress scrape state.
        this._enrichedUrls.clear();
        if (this._detailFetchAttempted) {
            this._detailFetchAttempted.clear();
        }

        logger.info('DOM observer stopped');
    }

    /**
     * Handle mutations
     */
    handleMutations(mutations) {
        for (const mutation of mutations) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        this.checkForBusinesses(node);
                    }
                });
            }
        }
    }

    /**
     * Handle intersection (viewport visibility)
     */
    handleIntersection(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const url = this.elementToUrl.get(entry.target);
                if (url && !this.processedUrls.has(url)) {
                    this.addToProcessingQueue(entry.target, url);
                    if (this.intersectionObserver) {
                        this.intersectionObserver.unobserve(entry.target);
                    }
                    this.elementToUrl.delete(entry.target);
                    // BLOCK-3 FIX (CRIT-006): Remove from pending tracking
                    this._pendingElements.delete(entry.target);
                }
            }
        });
    }

    /**
     * Process existing businesses on page load
     */
    processExistingBusinesses() {
        logger.info('Processing existing businesses...');
        this.checkForBusinesses(document.body);
    }

    /**
     * Check element and its children for businesses
     */
    checkForBusinesses(element) {
        const allLinks = element.querySelectorAll('a[href*="/maps/place/"]');

        allLinks.forEach(link => {
            const url = this.extractBusinessUrl(link);

            if (url && !this.processedUrls.has(url)) {
                this.elementToUrl.set(link, url);
                // BLOCK-3 FIX (CRIT-006): Track pending element with timestamp
                this._pendingElements.set(link, { url, addedAt: Date.now() });
                this.intersectionObserver.observe(link);
            }
        });

        const fallbackLinks = getElements(CONFIG.selectors.businessLink, element);
        fallbackLinks.forEach(link => {
            const url = this.extractBusinessUrl(link);
            if (url && !this.processedUrls.has(url)) {
                this.addToProcessingQueue(link, url);
            }
        });
    }

    /**
     * Extract business URL from element
     */
    extractBusinessUrl(element) {
        let url = element.getAttribute('href');

        if (!url) {
            url = element.getAttribute('data-value');
        }

        if (!url || !url.includes('/maps/place/')) {
            return null;
        }

        try {
            const urlObj = new URL(url, window.location.href);
            return urlObj.origin + urlObj.pathname;
        } catch (e) {
            logger.warn('Invalid URL:', url);
            return null;
        }
    }

    /**
     * Add to processing queue
     */
    addToProcessingQueue(element, url) {
        // BLOCK-3 FIX (MED-009): Prevent unbounded queue growth
        if (this.processingQueue.length >= DOMObserver.MAX_PROCESSING_QUEUE_SIZE) {
            logger.warn(`[Queue] Max size (${DOMObserver.MAX_PROCESSING_QUEUE_SIZE}) reached, dropping oldest entries`);
            // Remove oldest 10% of queue to make room
            const removeCount = Math.floor(DOMObserver.MAX_PROCESSING_QUEUE_SIZE * 0.1);
            this.processingQueue.splice(0, removeCount);
        }
        this.processingQueue.push({ element, url });
        this.debouncedProcess();
    }

    /**
     * Process queue
     */
    async processQueue() {
        if (this.isProcessing) {
            return;
        }

        if (this.processingQueue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;

        while (this.processingQueue.length > 0) {
            const { element, url } = this.processingQueue.shift();

            if (this.processedUrls.has(url)) {
                continue;
            }

            this.processedUrls.add(url);

            try {
                const business = await this.extractBusinessData(element, url);

                if (business) {
                    this.onNewBusiness(business);
                    // R-DETAIL-FETCH (v9.8): if the card has no phone after
                    // DOM + state-watcher lookups, fire a network detail-fetch
                    // and merge the result via business_enrichment. Fire-and-
                    // forget — the call queues on the MAIN-world fetcher's
                    // 3-slot concurrency limiter, so card-discovery is never
                    // blocked. Gated behind CONFIG.detailFetch.enabled or
                    // window.__gmpEnableDetailFetch (console toggle).
                    this._maybeFireDetailFetch(business);
                }
            } catch (error) {
                logger.error('Error extracting business:', error);
            }

            await new Promise(resolve => setTimeout(resolve, 10));
        }

        this.isProcessing = false;
    }

    /**
     * Extract comprehensive business data
     * PATCHED: Added website text fallback for hotels
     */
    async extractBusinessData(element, url) {
        try {
            // ═════════════════════════════════════════════════════════════
            // CS-001 FIX: Log which container strategy succeeded
            // Helps debugging when extraction fails
            // ═════════════════════════════════════════════════════════════
            let container = null;
            let containerStrategy = 'none';

            // Strategy 1: Semantic role (most reliable)
            container = element.closest('[role="article"]');
            if (container) {
                containerStrategy = 'role=article';
            } else {
                // Strategy 2: jsaction attribute (common in GMB)
                container = element.closest('div[jsaction]');
                if (container) {
                    containerStrategy = 'jsaction';
                } else {
                    // Strategy 3: Parent traversal fallback
                    container = element.parentElement?.parentElement;
                    if (container) {
                        containerStrategy = 'parent²';
                    }
                }
            }

            if (!container) {
                logger.warn('[CS-001] No container found for business - all strategies failed');
                return null;
            }

            logger.debug(`[CS-001] Container found via strategy: ${containerStrategy}`);

            const extractedData = this.selectorEngine.extractAll(container);

            // R-STATE (2026-05-05): consult APP_INITIALIZATION_STATE for
            // fields Maps doesn't render in the list-card DOM. The watcher
            // posts both a phone-only map (legacy) and the full business
            // catalog (32+ fields). DOM-extracted values always win when
            // present — state fills the holes.
            const statePhone = this._lookupStatePhone(url);
            const stateBiz = this.lookupStateBusiness(url);

            // Choose state-derived rating only when DOM didn't extract one.
            // ratingDecimal is a number (e.g. 4.8); DOM rating may be string ("4,8") → parsed.
            const stateRating = (stateBiz && typeof stateBiz.ratingDecimal === 'number') ? stateBiz.ratingDecimal : null;
            const stateReviews = (stateBiz && typeof stateBiz.reviewsCount === 'number') ? stateBiz.reviewsCount : null;
            const stateAddress = stateBiz?.addressFormatted || null;
            const stateWebsite = stateBiz?.website || null;
            const stateCategory = stateBiz?.primaryCategory || null;
            const stateTitle = stateBiz?.title || null;

            const business = {
                googleMapsUrl: url,
                timestamp: Date.now(),
                emailScraped: false,
                title: extractedData.title || stateTitle || 'Unknown',
                rating: extractedData.rating ? parseFloat(extractedData.rating) : stateRating,
                reviews: extractedData.reviews ? parseInt(extractedData.reviews) : stateReviews,
                website: extractedData.website || stateWebsite,
                // State-map phone wins over DOM extraction when the latter
                // is null/empty (the typical case for pizzerie). When DOM
                // extraction succeeded (e.g. amministrazioni pubbliche have
                // phone in list-card text), we keep the DOM value — it
                // reflects exactly what the user sees.
                phone: extractedData.phone || statePhone,
                address: extractedData.address || stateAddress,
                category: extractedData.category || stateCategory || 'Uncategorized'
            };

            // R-STATE-FULL: attach extra state-derived fields. Sanitization
            // below treats unknown fields conservatively (string-only path)
            // so non-string fields (arrays, numbers, nested objects) pass
            // through unchanged into the business record. They land in the
            // SW for storage and CSV export.
            if (stateBiz) {
                if (stateBiz.placeId) business.placeId = business.placeId || stateBiz.placeId;
                if (stateBiz.knowledgeGraphId) business.knowledgeGraphId = stateBiz.knowledgeGraphId;
                if (typeof stateBiz.latitude === 'number') business.latitude = stateBiz.latitude;
                if (typeof stateBiz.longitude === 'number') business.longitude = stateBiz.longitude;
                if (stateBiz.city) business.city = stateBiz.city;
                if (stateBiz.addressFormatted) business.addressFormatted = stateBiz.addressFormatted;
                if (stateBiz.postcode) business.postcode = stateBiz.postcode;
                if (stateBiz.province) business.province = stateBiz.province;
                if (stateBiz.countryCode) business.countryCode = stateBiz.countryCode;
                if (stateBiz.timezone) business.timezone = stateBiz.timezone;
                if (Array.isArray(stateBiz.adminRegions)) business.adminRegions = stateBiz.adminRegions;
                if (Array.isArray(stateBiz.categoryNames)) business.categoryNames = stateBiz.categoryNames;
                if (Array.isArray(stateBiz.categoryCodes)) business.categoryCodes = stateBiz.categoryCodes;
                if (stateBiz.priceRangeText) business.priceRange = stateBiz.priceRangeText;
                if (Array.isArray(stateBiz.priceHistogram)) business.priceHistogram = stateBiz.priceHistogram;
                if (stateBiz.openStatusFull) business.openStatusFull = stateBiz.openStatusFull;
                if (stateBiz.openStatusShort) business.openStatusShort = stateBiz.openStatusShort;
                if (Array.isArray(stateBiz.hoursWeekly)) business.hoursWeekly = stateBiz.hoursWeekly;
                if (stateBiz.reservationUrl) business.reservationUrl = stateBiz.reservationUrl;
                if (stateBiz.reservationDomain) business.reservationDomain = stateBiz.reservationDomain;
                if (stateBiz.websiteDomain) business.websiteDomain = stateBiz.websiteDomain;
                if (stateBiz.primaryPhotoUrl) business.primaryPhotoUrl = stateBiz.primaryPhotoUrl;
                if (stateBiz.ownerName) business.ownerName = stateBiz.ownerName;
                if (stateBiz.ownerId) business.ownerId = stateBiz.ownerId;
                if (stateBiz.ownerPhotoUrl) business.ownerPhotoUrl = stateBiz.ownerPhotoUrl;
                if (stateBiz.reviewSnippet) business.reviewSnippet = stateBiz.reviewSnippet;
                if (Array.isArray(stateBiz.serviceOptions)) business.serviceOptions = stateBiz.serviceOptions;
                if (stateBiz.searchResultType) business.searchResultType = stateBiz.searchResultType;
            }

            // ========== PATCH: Website fallback for hotels ==========
            // Now handled by SelectorEngine strategies

            // Normalize phone
            if (business.phone) {
                if (Array.isArray(business.phone)) {
                    const validPhones = business.phone
                        .filter(p => isValidPhone(p))
                        .map(p => normalizePhone(p, { country: 'IT' }));
                    business.phone = [...new Set(validPhones)].join(' / ');
                } else {
                    if (isValidPhone(business.phone)) {
                        business.phone = normalizePhone(business.phone, { country: 'IT' });
                    } else {
                        business.phone = null;
                    }
                }
            }

            // M1-PERF1: Cache container.innerText to avoid double reflow
            const containerText = container.innerText || '';

            // Phone fallback
            if (!business.phone) {
                const extractedPhone = this.extractPhone(containerText);
                if (extractedPhone) {
                    business.phone = extractedPhone;
                    logger.debug(`Phone extracted via fallback regex: ${extractedPhone}`);
                }
            }

            // ========== ITALIAN B2B FEATURE: Extract Opening Hours ==========
            // Hours appear in list view as: "Chiuso · Apre mar alle ore 09:30"
            // Or: "Aperto · Chiude alle ore 19:30"
            // Or: "Aperto 24 ore"
            const hoursPatterns = [
                // Italian: "Chiuso · Apre [day] alle ore HH:MM"
                /(?:Chiuso|Aperto)\s*[·•]\s*(?:Apre|Chiude)\s+(?:\w+\s+)?alle\s+ore\s+(\d{1,2}[:.]\d{2})/i,
                // Italian: "Aperto 24 ore"
                /(Aperto\s+24\s+ore)/i,
                // Italian: "Orario: Lun-Ven 9-13 / 15-19"
                /Orario[:\s]+([^\n]+)/i,
                // Generic time range: "09:00 - 18:00" or "9:00-18:00"
                /(\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2})/
            ];

            for (const pattern of hoursPatterns) {
                const match = containerText.match(pattern);
                if (match) {
                    // For patterns that capture full context, use match[0]
                    // For "Chiuso/Aperto" pattern, reconstruct the full string
                    if (pattern === hoursPatterns[0]) {
                        // Find the full hours context
                        const fullMatch = containerText.match(/(?:Chiuso|Aperto)\s*[·•]\s*(?:Apre|Chiude)\s+(?:\w+\s+)?alle\s+ore\s+\d{1,2}[:.]\d{2}/i);
                        if (fullMatch) {
                            business.openingHours = fullMatch[0].trim();
                        }
                    } else {
                        business.openingHours = match[0].trim();
                    }
                    break;
                }
            }

            // ═══════════════════════════════════════════════════════════════════════════════
            // CS-004 FIX: Use strict boolean check to prevent data leak
            // If CONFIG.isDevelopment is undefined (not explicitly false), rawText won't leak
            // rawText is only useful for debugging extraction issues in development
            // ═══════════════════════════════════════════════════════════════════════════════
            if (CONFIG.isDevelopment === true) {
                business.rawText = containerText.substring(0, 500);
            }

            // Step 03-03: Sanitize all string fields before messaging
            const safeBusiness = sanitizeBusinessData(business);

            logger.info('Extracted business:', safeBusiness.title, safeBusiness.website ? `(${safeBusiness.website})` : '(no website)');
            return safeBusiness;

        } catch (error) {
            logger.error('Business extraction error:', error);
            return null;
        }
    }

    /**
     * Force collect ALL businesses on page immediately
     * Bypasses IntersectionObserver for Turbo mode
     */
    forceCollectAll() {
        logger.info('[FORCE COLLECT] Starting immediate collection of all businesses...');

        // Find ALL business links on the page
        const allLinks = document.querySelectorAll('a[href*="/maps/place/"]');

        logger.info(`[FORCE COLLECT] Found ${allLinks.length} business links`);

        let addedCount = 0;

        allLinks.forEach(link => {
            const url = this.extractBusinessUrl(link);

            if (url && !this.processedUrls.has(url)) {
                // Add directly to processing queue (skip IntersectionObserver)
                this.addToProcessingQueue(link, url);
                addedCount++;
            }
        });

        logger.info(`[FORCE COLLECT] Added ${addedCount} new businesses to queue`);

        // Process queue immediately (don't wait for debounce)
        this.processQueue();

        return {
            found: allLinks.length,
            added: addedCount,
            alreadyProcessed: allLinks.length - addedCount
        };
    }

    /**
     * Extract phone number from text (GMB only)
     */
    extractPhone(text) {
        if (!text) return null;

        const patterns = CONFIG.extraction.phone.gmbPatterns;

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const phone = match[0];
                if (isValidPhone(phone)) {
                    return normalizePhone(phone, { country: 'IT' });
                }
            }
        }

        return null;
    }

    // BUG #12 FIX: Phone validation methods moved to lib/phone-normalizer.js

    /**
     * BLOCK-3 FIX (CRIT-006): Cleanup orphaned pending elements
     * Elements that were added to IntersectionObserver but never fired
     * (e.g., user scrolled away before they became visible)
     */
    _cleanupOrphanedElements() {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [element, data] of this._pendingElements.entries()) {
            if (now - data.addedAt > DOMObserver.PENDING_ELEMENT_TIMEOUT) {
                // Element has been pending too long - clean it up
                this.elementToUrl.delete(element);
                this._pendingElements.delete(element);
                if (this.intersectionObserver) {
                    this.intersectionObserver.unobserve(element);
                }
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            logger.debug(`[Cleanup] Removed ${cleanedCount} orphaned pending elements`);
        }
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            processed: this.processedUrls.size,
            queued: this.processingQueue.length,
            isProcessing: this.isProcessing
        };
    }

    /**
     * Reset (clear processed URLs and dedup Sets)
     */
    reset() {
        this.processedUrls.clear();
        this.processingQueue = [];
        // CO-4 FIX: also clear the unbounded enrichment / detail-fetch dedup
        // Sets so a manual "reset scrape" actually frees memory, matching
        // the user's expectation of a clean state.
        this._enrichedUrls.clear();
        if (this._detailFetchAttempted) {
            this._detailFetchAttempted.clear();
        }
        logger.info('Observer reset');
    }
}

export default DOMObserver;
