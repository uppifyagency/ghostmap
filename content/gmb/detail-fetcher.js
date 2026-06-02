/**
 * Ghost Map — detail fetcher (MAIN world)
 *
 * Reverse-engineered detail endpoint `/maps/preview/place` lets us pull
 * the full place record (phone, address, website, hours, ...) for any
 * known CID without the user having to open the detail panel manually.
 *
 * Architecture:
 *   - Runs in MAIN world (same-origin fetch + first-party cookies, no
 *     SAPISIDHASH required — verified empirically 2026-05-06).
 *   - ISOLATED world (observer.js) sends `gmp:detail:request`
 *     postMessage with {id, cid, fid, placeId, lat, lng}; we reply
 *     with `gmp:detail:response` carrying the parsed fields.
 *   - Concurrency hard-cap = 3, jitter 50-150ms, exponential backoff
 *     on rate-limit signals (429 / HTML response / non-XSSI body).
 *
 * Failure modes guarded:
 *   - 429 / 503: retry up to MAX_RETRIES with exponential backoff.
 *   - Body is HTML (not JSON): treat as soft rate-limit, backoff.
 *   - Three consecutive failures: trip kill-switch, refuse new
 *     requests until reset() is called from ISOLATED side.
 *
 * See `docs/MAPS_DETAIL_FETCH_REVERSE_ENGINEERING.md` for the pb
 * structure decode and the empirical performance baseline.
 */

(function () {
    'use strict';

    if (window.__ghostMapDetailFetcherInstalled) return;
    window.__ghostMapDetailFetcherInstalled = true;

    const REQUEST_CHANNEL = 'gmp:detail:request';
    const RESPONSE_CHANNEL = 'gmp:detail:response';
    // Bridge channel — MAIN-world flag → ISOLATED-world consumers.
    // Observer (ISOLATED) cannot read `window.__gmpEnableDetailFetch`
    // set by the DevTools console (MAIN world), so we broadcast the
    // flag value at install time and on demand.
    const FLAG_STATE_CHANNEL = 'gmp:detail:flag-state';
    const FLAG_REQUEST_CHANNEL = 'gmp:detail:flag-request';

    // Read a localStorage flag without throwing if storage is blocked
    // (some private-browsing modes). Falls back to false on any failure.
    function lsFlag(key) {
        try { return localStorage.getItem(key) === '1'; } catch { return false; }
    }

    // Verbose diagnostic toggle. Two enable paths:
    //   1. `localStorage.setItem('gmp.detailFetcherDebug','1')` — survives reload
    //   2. `window.__gmpDetailFetcherDebug = true` — volatile, lost on reload
    const DEBUG = lsFlag('gmp.detailFetcherDebug') || !!window.__gmpDetailFetcherDebug;

    // Feature flag — re-read on every broadcast so DevTools toggles
    // mid-session are reflected on the next observer query. Two paths:
    //   1. `localStorage.setItem('gmp.detailFetchEnabled','1')` — survives reload
    //   2. `window.__gmpEnableDetailFetch = true` — volatile, lost on reload
    // Either path works; localStorage is the persistent dev-test path.
    function isFeatureEnabled() {
        return lsFlag('gmp.detailFetchEnabled') || !!window.__gmpEnableDetailFetch;
    }

    const CONFIG = {
        concurrency: 3,
        jitterMinMs: 50,
        jitterMaxMs: 150,
        timeoutMs: 10000,
        maxRetries: 2,
        backoffBaseMs: 2000,         // 2s, 4s, 8s
        killSwitchAfterFails: 3,     // consecutive failures
    };

    // B2-4 FIX (2026-05-10): channel for kill-switch state broadcast.
    // Posted to ISOLATED world (observer.js) which forwards to SW/UI via
    // chrome.runtime.sendMessage as `detail_fetcher_kill_switch`.
    const KILL_SWITCH_CHANNEL = 'gmp:detail:kill-switch';

    /** Active in-flight count + queue (concurrency limiter). */
    const queue = [];
    let inflight = 0;

    /** Kill switch — set true after N consecutive failures. */
    let killSwitchTripped = false;
    let consecutiveFails = 0;

    /** Diagnostic counters (logged on demand). */
    const stats = {
        requested: 0,
        succeeded: 0,
        failed: 0,
        retried: 0,
        rateLimited: 0,
        latencyMs: [],
    };

    /** Encode CID/FID for pb (URL-safe) — matches Maps' own encoding. */
    function buildDetailUrl({ cid, fid, placeId, lat, lng, locale = 'it', country = 'it', query = 'place' }) {
        const cidEnc = encodeURIComponent(cid);
        const fidEnc = encodeURIComponent(fid);
        const pidSafe = String(placeId || '');
        const querySafe = String(query || 'place').replace(/[^a-zA-Z0-9_-]/g, '');
        const pb =
            `!1m21` +
            `!1s${cidEnc}` +
            `!3m9!1m3!1d11022!2d${lng}!3d${lat}!2m0!3m2!1i624!2i744!4f13.1` +
            `!4m2!3d${lat}!4d${lng}` +
            `!15m6` +
            `!1m5!1s${cidEnc}!4s${fidEnc}!5s${pidSafe}!6s0!7s0` +
            `!6s${querySafe}`;
        return (
            `https://www.google.com/maps/preview/place` +
            `?authuser=0&hl=${locale}&gl=${country}` +
            `&pb=${pb}` +
            `&q=${encodeURIComponent(querySafe)}`
        );
    }

    /**
     * Strip XSSI prefix `)]}'\n` and parse JSON.
     * Returns null on parse failure (caller treats as rate-limit / shape change).
     */
    function parseXssiJson(text) {
        if (typeof text !== 'string') return null;
        if (!text.startsWith(")]}'")) return null;
        try {
            return JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
        } catch {
            return null;
        }
    }

    /**
     * Extract fields from the place-detail response. Uses regex on the
     * stringified JSON because the JSPB shape is fragile and changes
     * between place types (restaurant vs retail vs services). Regex on
     * known-stable patterns (E.164, address prefixes) is more durable.
     */
    function extractFieldsFromBody(text) {
        const fields = {};
        // Phone — try E.164 (+CC ...) first, then plain national format.
        const e164 = text.match(/"\+\d{1,3}\s[\d\s]{6,18}"/);
        if (e164) {
            fields.phone = e164[0].slice(1, -1).trim();
        } else {
            // National formats: leading 0 (IT), 1-4 digits prefix, then 4+ digits
            const nat = text.match(/"(0\d{1,4}[\s\-]?\d{4,}[\s\d]*)"/);
            if (nat) fields.phone = nat[1].trim();
        }
        // Address — ZIP-anchor first (BUG FIX 2026-05-08, MCP-A capture):
        //
        // The previous layer order (prefix regex first) matched "Via X" /
        // "Piazza Y" inside review prose when reviews appeared earlier in the
        // body than the structural pb tuple — same archetype as the hours
        // review-text-trap (a user writes "abbiamo cenato in Via Garibaldi 5"
        // and the regex grabs that before the real address block). The fix
        // inverts the order: lock onto the structural pb 2-element tuple
        // ["<street>","<5digits> <City> <PR>"] first; review prose cannot
        // match this shape because the postal block is always digit-anchored.
        //
        // Layer 1: ZIP-anchored — Italian postal pattern, structural.
        // Layer 2: full IT/EU prefix — fallback for places without IT ZIP
        //          (foreign places, partial captures, shape drift).
        // Layer 3: italian abbreviated prefixes (Str., V.le, P.zza, ...).
        // Telemetry counter (addressFound/addressMissing) is the safety net
        // if Maps changes shape and Layer 1 regresses.
        const zipAnchor = text.match(/"([^"\\]{4,80})","\d{5}\s[A-Z][^"\\]{2,40}\s[A-Z]{2}"/);
        if (zipAnchor) {
            fields.address = zipAnchor[1].trim();
        } else {
            // Layer 2: full IT/EU street prefix — extended in Wave 1.3 (MCP-A
            // side-finding) with regional Italian prefixes (Salita, Vico,
            // Calata, Discesa, Traversa, Galleria, Riva) commonly used in
            // Naples/Venice/Genoa. \b word-boundary prevents matching prefix-
            // of-word (e.g. "Vico" must not match "Vicolo" or "Vicovaro").
            let addr = text.match(/(\b(?:Viale|Vicolo|Via|Piazzale|Piazza|Corso|Largo|Strada|Lungomare|Salita|Vico|Calata|Discesa|Traversa|Galleria|Riva)\s[^"\\]{4,120})/);
            if (!addr) {
                addr = text.match(/(\b(?:Str\.|V\.le|Vle|P\.zza|P\.za|Pza|C\.so|Cso|Vic\.|L\.go|Lgo)\s[^"\\]{2,120})/);
            }
            if (addr) fields.address = addr[1].trim();
        }
        // Website — exclude google.com / gstatic / googleapis subdomain AND
        // ad/tracking networks (googlesyndication, doubleclick, ...). A real
        // business website is never on these. Sponsored places have ad-asset
        // URLs first in the response — without these exclusions we'd
        // misreport the asset.
        //
        // BUG FIX 2026-05-08 (validated against Bar Pizzeria Anna fixture):
        // the original regex had `[^"\\]+` excluding `\` from URL chars. But
        // Maps serializes URLs with `=` (=) and `&` (&) escapes, so
        // the match aborted at the first `\`. Result: ALL URLs that have a
        // query string (i.e. nearly all real business sites with social/etc)
        // were silently dropped. Loop scanned 25 URLs, accepted zero.
        // Fix: drop the `\` exclusion from the char class, then post-decode
        // the two ASCII escapes minimally (no general-purpose decoder).
        const sites = [...text.matchAll(/"(https?:\/\/[^"]+?)"/g)];
        for (const m of sites) {
            let u = m[1];
            if (u.length > 300) continue;  // raised cap — escaped URLs are longer
            // Decode the only two escapes Maps emits in serialized URLs
            u = u.replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&');
            if (/^https?:\/\/(?:[a-z0-9-]+\.)*(?:google\.com|gstatic\.com|googleapis\.com|googleusercontent\.com|youtube\.com|youtu\.be|ggpht\.com|googlemapsurl\.com|googlesyndication\.com|doubleclick\.net|googleadservices\.com|googletagmanager\.com|google-analytics\.com)\b/i.test(u)) continue;
            fields.website = u;
            break;
        }
        // Rating — anchor-based extraction.
        //
        // BUG FIX 2026-05-08: the original `\b([1-5][.,]\d)\b` regex matched
        // "1,4" at idx 198 in `[null,1,4.9]` (array commas, NOT decimals!),
        // returning a wrong rating of 1.4 for places whose actual rating was
        // 4.3 (Bar Pizzeria Anna fixture). The body has 6+ false positives
        // before the real rating block.
        // Fix: anchor on the structural pb pattern where rating is always
        // followed by review count: `null,null,null,<rating>,<reviewCount>`.
        // The decimal-with-DOT form `4.3` is what Maps serializes (despite
        // showing `4,3` in italian UI — the storage uses dot).
        // PROVISIONAL anchor: schema may evolve; telemetry counts ratingFound
        // hits.
        const ratingAnchor = text.match(/null,null,null,([1-5]\.\d),(\d{1,7})\b/);
        if (ratingAnchor) {
            fields.rating = parseFloat(ratingAnchor[1]);
            fields.reviewCount = parseInt(ratingAnchor[2], 10);
        }
        // TODO Wave 2 (long-term): consider subject-sub-tree extraction —
        // locate the place's pb sub-array first, then parse fields from it
        // only. This would eliminate the residual risk that any future field
        // regex matches in unrelated body regions.

        // Hours — opening hours grouped by day. We ship RAW STRING capture,
        // not structured {monday: open/close} — pb shape varies wildly (split
        // lunch, "Aperto 24 ore", today-first ordering). V2 normalizes later.
        //
        // CLUSTER-DETECTION (validated against real /preview/place capture
        // 2026-05-08, see tests/fixtures/preview-place-bar-anna-hours.json):
        // a real Maps response also contains day names INSIDE review text
        // ("Siamo stati qui un sabato"), so a firstIdx-based slice would
        // grab the wrong block. We find the 600-char window with the most
        // distinct day-name keys — review mentions are sparse, the real
        // hours block is dense (~82 chars per day on observed fixture).
        //
        // \b after italian day names with ì FAILS in JS regex because ì is
        // not a \w char (ASCII word). Use (?![a-zA-Z]) lookahead instead.
        const DAY_KEYS = {
            luned: 'mon', monday: 'mon',
            marted: 'tue', tuesday: 'tue',
            mercoled: 'wed', wednesday: 'wed',
            gioved: 'thu', thursday: 'thu',
            venerd: 'fri', friday: 'fri',
            sabato: 'sat', saturday: 'sat',
            domenica: 'sun', sunday: 'sun'
        };
        const dayRegex = /\b(Luned[ìi]|Marted[ìi]|Mercoled[ìi]|Gioved[ìi]|Venerd[ìi]|Sabato|Domenica|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?![a-zA-Z])/gi;
        const dayMatches = [...text.matchAll(dayRegex)];
        function _hoursDayKey(name) {
            const lower = name.toLowerCase().replace('ì', 'i');
            for (const pref of Object.keys(DAY_KEYS)) {
                if (lower.startsWith(pref)) return DAY_KEYS[pref];
            }
            return null;
        }
        let bestCluster = { count: 0, start: -1, end: -1 };
        for (let i = 0; i < dayMatches.length; i++) {
            const winStart = dayMatches[i].index;
            const seen = new Set();
            let lastIdx = winStart;
            for (let j = i; j < dayMatches.length && dayMatches[j].index < winStart + 600; j++) {
                const k = _hoursDayKey(dayMatches[j][1]);
                if (k) seen.add(k);
                lastIdx = dayMatches[j].index + dayMatches[j][0].length;
            }
            if (seen.size > bestCluster.count) {
                bestCluster = { count: seen.size, start: winStart, end: lastIdx };
            }
        }
        if (bestCluster.count >= 7) {
            const cap = Math.min(bestCluster.end + 100, bestCluster.start + 1000);
            fields.hoursRaw = text.slice(bestCluster.start, cap);
            fields.hoursDaysFound = 7;
        } else {
            fields.hoursDaysFound = bestCluster.count;
            // hoursRaw stays undefined for partial — telemetry catches it.
        }

        return fields;
    }

    /**
     * Sleep with jitter. The jitter is applied BEFORE the call (not after)
     * to spread out the start of bursty parallel calls.
     */
    function jitter() {
        const { jitterMinMs, jitterMaxMs } = CONFIG;
        const ms = jitterMinMs + Math.random() * (jitterMaxMs - jitterMinMs);
        return new Promise(r => setTimeout(r, ms));
    }

    /** AbortController-backed timeout for fetch. */
    function fetchWithTimeout(url, ms) {
        const ctrl = new AbortController();
        // OBS-1 (2026-05-17): explicit reason. line 328 branches on
        // `e?.name === 'AbortError'` to classify timeouts — name preserved.
        // Message goes to dev-log bridge via console for triage.
        const t = setTimeout(
            () => ctrl.abort(new DOMException(`detail fetch timeout ${ms}ms`, 'AbortError')),
            ms
        );
        return fetch(url, { credentials: 'include', signal: ctrl.signal })
            .finally(() => clearTimeout(t));
    }

    /**
     * One attempt. Returns { ok, status, text, fields?, latencyMs }
     * or { ok:false, error, status }.
     */
    async function tryFetchOnce(url) {
        const t0 = performance.now();
        try {
            const r = await fetchWithTimeout(url, CONFIG.timeoutMs);
            const text = await r.text();
            const latencyMs = Math.round(performance.now() - t0);
            const ct = r.headers.get('content-type') || '';
            // Rate-limit signals
            if (r.status === 429 || r.status === 503) {
                return { ok: false, status: r.status, latencyMs, rateLimited: true, error: 'http_' + r.status };
            }
            if (!ct.includes('application/json') || !text.startsWith(")]}'")) {
                // Soft rate-limit / CAPTCHA / 400 with HTML body
                return { ok: false, status: r.status, latencyMs, rateLimited: r.status !== 400, error: 'non_json_body', bodyKB: Math.round(text.length / 1024) };
            }
            if (r.status !== 200) {
                return { ok: false, status: r.status, latencyMs, error: 'http_' + r.status };
            }
            const fields = extractFieldsFromBody(text);
            return { ok: true, status: 200, latencyMs, fields, bodyKB: Math.round(text.length / 1024) };
        } catch (e) {
            return { ok: false, latencyMs: Math.round(performance.now() - t0), error: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) };
        }
    }

    /**
     * Fetch with retry + exponential backoff on rate-limit signals.
     */
    async function fetchPlaceDetail(payload) {
        if (killSwitchTripped) {
            return { ok: false, error: 'kill_switch_tripped' };
        }
        const url = buildDetailUrl(payload);
        let attempt = 0;
        let lastResult = null;
        while (attempt <= CONFIG.maxRetries) {
            await jitter();
            const result = await tryFetchOnce(url);
            lastResult = result;
            if (result.ok) {
                consecutiveFails = 0;
                stats.succeeded++;
                stats.latencyMs.push(result.latencyMs);
                if (stats.latencyMs.length > 200) stats.latencyMs.shift();
                return result;
            }
            // Non-retryable (CT-1 FIX 2026-05-27): break only — the post-loop
            // code below counts the failure exactly once. Pre-fix this branch
            // incremented stats.failed + consecutiveFails AND then fell through
            // to the post-loop which incremented them again, causing the
            // kill-switch to trip after 2 non-retryable failures instead of 3.
            if (result.status === 400 && !result.rateLimited) {
                break;
            }
            if (result.rateLimited) stats.rateLimited++;
            attempt++;
            if (attempt > CONFIG.maxRetries) break;
            stats.retried++;
            const backoff = CONFIG.backoffBaseMs * Math.pow(2, attempt - 1);
            await new Promise(r => setTimeout(r, backoff));
        }
        consecutiveFails++;
        stats.failed++;
        if (consecutiveFails >= CONFIG.killSwitchAfterFails) {
            killSwitchTripped = true;
            try { console.warn('[GhostMap detail-fetcher] kill switch tripped after', consecutiveFails, 'consecutive failures'); } catch { /* ignore */ }

            // B2-4 FIX (2026-05-10): broadcast kill-switch state to ISOLATED
            // world (observer.js) which forwards to SW + sidepanel UI. Pre-fix
            // the kill switch was a silent state — sidepanel showed
            // "scraping in progress" while ALL subsequent enrichment failed.
            try {
                window.postMessage({
                    type: KILL_SWITCH_CHANNEL,
                    tripped: true,
                    consecutiveFails,
                    timestamp: Date.now()
                }, location.origin);
            } catch { /* ignore */ }
        }
        return lastResult || { ok: false, error: 'unknown' };
    }

    /** Concurrency-limited dispatcher. Returns when slot frees. */
    function dispatch(task) {
        return new Promise((resolve) => {
            queue.push(async () => {
                try {
                    const r = await task();
                    resolve(r);
                } catch (e) {
                    resolve({ ok: false, error: e?.message || String(e) });
                }
            });
            pump();
        });
    }

    function pump() {
        while (inflight < CONFIG.concurrency && queue.length > 0) {
            const fn = queue.shift();
            inflight++;
            fn().finally(() => {
                inflight--;
                pump();
            });
        }
    }

    /**
     * Bridge MAIN→ISOLATED: announce the current value of the
     * `window.__gmpEnableDetailFetch` MAIN-world flag to ISOLATED
     * consumers (observer.js). The observer cannot read MAIN-world
     * window state directly because content scripts run in an
     * isolated execution context. This bridge lets the documented
     * console-toggle path (`window.__gmpEnableDetailFetch = true`)
     * work end-to-end after a Maps page reload.
     */
    function broadcastFlagState() {
        const enabled = isFeatureEnabled();
        try {
            window.postMessage({ type: FLAG_STATE_CHANNEL, enabled }, location.origin);
            if (DEBUG) {
                // eslint-disable-next-line no-console
                console.info('[GhostMap detail-fetcher] flag broadcast: enabled=' + enabled);
            }
        } catch { /* ignore */ }
    }

    // Announce the flag at install. Observer is set up to listen
    // unconditionally and cache the value, so it doesn't matter
    // which side wins the install race.
    broadcastFlagState();

    // Re-broadcast on demand — observer asks at start() in case it
    // missed the install-time broadcast (race condition between
    // ISOLATED-world DOMContentLoaded and MAIN-world document_start).
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data?.type === FLAG_REQUEST_CHANNEL) {
            broadcastFlagState();
        }
    });

    /** Public message API — observer.js sends here. */
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.type !== REQUEST_CHANNEL) return;
        const { id, payload } = msg;
        if (!id || !payload) return;
        if (!payload.cid || !payload.fid || !payload.placeId || payload.lat == null || payload.lng == null) {
            window.postMessage({
                type: RESPONSE_CHANNEL,
                id,
                ok: false,
                error: 'missing_fields',
            }, location.origin);
            return;
        }
        stats.requested++;
        dispatch(() => fetchPlaceDetail(payload)).then((result) => {
            window.postMessage({
                type: RESPONSE_CHANNEL,
                id,
                ok: result.ok,
                status: result.status || null,
                fields: result.fields || null,
                latencyMs: result.latencyMs || null,
                bodyKB: result.bodyKB || null,
                error: result.error || null,
            }, location.origin);
        });
    });

    /**
     * Diagnostic — exposed as window.__ghostMapDetailFetcherStats for
     * console debugging. Includes the kill-switch state and reset hook.
     */
    window.__ghostMapDetailFetcherStats = function () {
        const lat = stats.latencyMs.slice().sort((a, b) => a - b);
        const p = (q) => lat[Math.floor(lat.length * q)] || null;
        return {
            ...stats,
            inflight,
            queued: queue.length,
            killSwitch: killSwitchTripped,
            consecutiveFails,
            latencyP50: p(0.5),
            latencyP95: p(0.95),
            latencyP99: p(0.99),
            avgLatency: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        };
    };
    window.__ghostMapDetailFetcherReset = function () {
        killSwitchTripped = false;
        consecutiveFails = 0;
        try { console.info('[GhostMap detail-fetcher] kill switch reset'); } catch { /* ignore */ }

        // B2-4 FIX (2026-05-10): broadcast reset event so UI can clear the
        // warning banner. Without this, banner stays stuck after a manual
        // DevTools reset, creating "why is the warning still there" confusion.
        try {
            window.postMessage({
                type: KILL_SWITCH_CHANNEL,
                tripped: false,
                consecutiveFails: 0,
                timestamp: Date.now()
            }, location.origin);
        } catch { /* ignore */ }
    };

    if (DEBUG) {
        try {
            // eslint-disable-next-line no-console
            console.info('[GhostMap detail-fetcher] installed (MAIN world, conc=' + CONFIG.concurrency + ')');
        } catch { /* ignore */ }
    }
})();
