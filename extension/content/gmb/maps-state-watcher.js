/**
 * MIT License
 * Copyright (c) 2026 Ghost Map Pro Team
 *
 * Maps State Watcher — runs in MAIN world (page context).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────────────────
 * Google Maps does NOT render restaurant/pizzeria/pub phones in list-card
 * DOM (empirically 0/12 pizzerie milano + 0/6 pub milano on 2026-05-05).
 * Maps DOES embed phone — and a wealth of other detail-page fields — in
 * `window.APP_INITIALIZATION_STATE`, a deeply-nested structure containing
 * a JSPB-serialized payload (XSSI-prefixed JSON, ~890KB for a typical
 * restaurant search). This watcher decodes the payload and ships a
 * structured business-data map to the ISOLATED-world observer via
 * `window.postMessage`. NO TABS OPENED. NO DOM RENDERING REQUIRED.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * EXTRACTED FIELDS (per business, keyed by CID)
 * ──────────────────────────────────────────────────────────────────────────
 * The structural paths below were reverse-engineered from a live audit
 * (`pizzerie milano` search, 2026-05-05). Each numeric index references
 * `business[1][N]` where N is a JSPB field tag stable for years.
 *
 *   IDENTITY
 *     title              [11]   "Mani in Pasta"
 *     cid                [10]   "0x...:0x..." (canonical Maps CID)
 *     placeId            [78]   "ChIJ..." (Google Places API ID)
 *     knowledgeGraphId   [89]   "/g/11t6ttgf2k"
 *     allIdentifiers     [227][0]  [cid, _, _, kgId, placeId, ownerId1, ownerId2]
 *
 *   GEOGRAPHY
 *     latitude           [9][2]
 *     longitude          [9][3]
 *     addressFormatted   [39]   "Via Giovanni da Procida, 1, 20149 Milano MI"
 *     addressFull        [18]   "Mani in Pasta, Via Giovanni da Procida, 1, 20149 Milano MI"
 *     addressLine1       [2][0]
 *     addressLine2       [2][1]
 *     street             [82][1]
 *     city               [166]
 *     adminRegions       [245][0][*][2][0][0]   ["Italia", "Lombardia", ...]
 *     countryCode        [243]                  "IT"
 *     languageCode       [110]                  "it"
 *     timezone           [30]                   "Europe/Rome"
 *     postcode           [183][1][4]            "20149"
 *     province           [183][1][5]            "Città metropolitana di Milano"
 *
 *   CONTACT
 *     phoneDigits        [178][0][3]            "3342887151"
 *     phoneE164          [178][0][1][i].[0]     "+39 334 288 7151"  (where [1]===2)
 *     phoneDisplay       [178][0][0]            "334 288 7151"
 *     phoneTel           [178][0][5][0]         "tel:3342887151"
 *     website            [7][0]                 "https://..."
 *     websiteDomain      [7][1]                 "maniinpastagroup.com"
 *     reservationUrl     [46][0][0]             "https://...guestplan.io/"
 *     reservationDomain  [46][0][1]             "guestplan.io"
 *
 *   BUSINESS
 *     categoryNames      [13]                   ["Pizzeria", "Ristorante italiano", ...]
 *     categoryCodes      [76]                   [["pizza_restaurant","Pizza",2], ...]
 *     primaryCategory    [13][0]                "Pizzeria"
 *     searchResultType   [88][1]                "SearchResult.TYPE_PIZZA_RESTAURANT"
 *
 *   POPULARITY / PRICE
 *     ratingDecimal      [4][7]                 4.8
 *     reviewsCount       [4][8]                 3898 (integer)
 *     reviewsText        [4][3][1]              "3.898 recensioni"
 *     reviewsUrl         [4][3][0]              link to all reviews
 *     priceRangeText     [4][2]                 "20-30 €"
 *     priceHistogram     [4][9][0]              [{bucket, count, ratio}, ...] (review-perception)
 *     reviewSnippet      [142][1][0][1][0][0]   "Simpatici e alla mano, pizze e tiramisù top!"
 *                        (M4 doc fix 2026-08-18: header used to document a wrong
 *                        4th index (0 instead of 1); the code has always read the
 *                        path above — see extractBusiness)
 *
 *   STATUS / HOURS
 *     openStatusShort    [203][1][8][0]         "Aperto" / "Chiuso"
 *     openStatusFull     [203][1][4][0]         "Aperto · Chiude alle ore 23"
 *     hoursWeekly        [203][0]               [["martedì",2,[Y,M,D],[["12:30–15",[[12,30],[15]]]],0,1], ...]
 *     diningPeriods      [118]                  [["Pranzo",...], ["Cena",...]]
 *
 *   MEDIA / OWNER
 *     primaryPhotoUrl    [37][0][0][6][0]
 *     ownerName          [57][1]                "Mani in Pasta (Proprietario)"
 *     ownerId            [57][2]                Google account ID
 *     ownerPhotoUrl      [157]
 *
 *   AMENITIES (variable count, ~13 categories × N options each)
 *     serviceOptions     [100][1]               flat-extracted as [{category, name, present}]
 *
 * ──────────────────────────────────────────────────────────────────────────
 * COVERAGE NOTES
 * ──────────────────────────────────────────────────────────────────────────
 * Across "pizzerie milano" + scroll, ~9 of 12 visible cards have full
 * detail data; sponsored card + top-2 organic results load from a separate
 * cache without phone (and without most other deep fields). Those 3 still
 * rely on the detail-panel back-fill (extractDetailFields) when the user
 * clicks into them.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SECURITY POSTURE
 * ──────────────────────────────────────────────────────────────────────────
 * - Read-only; never mutates Maps internals.
 * - Posts only the derived business map plus the aggregate drift counters
 *   (`payload.drift` — M2/R3 2026-08-18: canaryFailures/fallbackRecoveries/
 *   recordsChecked, numeri aggregati, MAI contenuto). No raw state blobs.
 * - `targetOrigin: location.origin` blocks cross-frame leaks.
 * - Idempotent install guard.
 */

(function gmpMapsStateWatcher() {
    'use strict';

    if (window.__gmpMapsStateWatcherInstalled) return;
    window.__gmpMapsStateWatcherInstalled = true;

    const CHANNEL = 'gmp:state-map';
    const POLL_INTERVAL_MS = 4000;
    // M5 FIX (2026-08-18): MAX_POLL_MS (5 min self-shutoff) REMOVED. The poll
    // used to clearInterval itself 5 min after the last gmp:state-map-request.
    // The ISOLATED observer's B2-1 re-arm (every 4 min) normally kept it alive
    // — but if the observer dies/restarts or its re-arm timer is throttled
    // (background tab: ISOLATED timers can be clamped to 1/min or worse), the
    // poll died silently and capture stopped while the user kept navigating.
    // Post-S1 the no-change tick is cheap (O(1) publish check), and since
    // R3-C2b (2026-08-18) an unchanged payload is not even re-parsed (string
    // identity gate in mergeFromInitialState), so the poll now runs for the
    // tab's lifetime and is GC'd with the page context.
    const CID_RE = /^0x[0-9a-f]{16}:0x[0-9a-f]{16}$/i;

    // Verbose diagnostic toggle. `info` and `debug` calls are gated behind
    // this flag so the production console isn't noisy with extension chatter.
    // `warn` calls (anemic state, JSPB-with-zero-businesses, auto-reload)
    // are always visible — they signal real problems users should see.
    // Two enable paths:
    //   1. `localStorage.setItem('gmp.stateWatcherDebug','1')` — survives reload
    //   2. `window.__gmpStateWatcherDebug = true` — volatile, lost on reload
    function lsFlag(key) {
        try { return localStorage.getItem(key) === '1'; } catch { return false; }
    }
    const DEBUG = lsFlag('gmp.stateWatcherDebug') || !!window.__gmpStateWatcherDebug;

    // S1 PERF FIX (2026-08-18): the poll used to decide "changed?" by
    // JSON.stringify-ing the ENTIRE accumulator every 4 s and comparing with
    // the previous serialization — multi-MB main-thread work at the 5000-
    // business cap (user-perceivable jank). Replaced with an O(1) version
    // counter bumped at the accumulator's SINGLE mutation point (the
    // first-occurrence-wins insert in mergeFromParsedJspb). Because existing
    // records are never rewritten in place and never deleted, the counter
    // tracks content change EXACTLY: no missed publish (every content change
    // goes through the insert) and no spurious publish (a merge that adds
    // nothing does not bump). If you ever add a NEW accumulator write path
    // (in-place enrichment, deletion), it MUST bump `accumulatorVersion` or
    // that change will never reach the ISOLATED world.
    let accumulatorVersion = 0;      // bumped on every accumulator mutation
    let lastPublishedVersion = -1;   // -1 forces a publish on the next data-bearing tick
    // R3-C2b PERF FIX (2026-08-18): payload-identity gate for the 4 s re-merge.
    // Post-S1 the PUBLISH check was O(1), but every tick still re-ran
    // findJspbPayload + JSON.parse(~890KB) + the full walk on an UNCHANGED
    // payload, forever. findJspbPayload returns a STRING; JS strings are
    // immutable, so `raw === _lastMergedRawPayload` being true guarantees
    // byte-identical content (=== on strings compares content, with an O(1)
    // fast path for the common same-reference case) — skipping the parse can
    // never miss data. A payload that fails JSON.parse fails deterministically,
    // so caching it before the parse attempt is equally safe.
    let _lastMergedRawPayload = null;

    // ──────────────────────────────────────────────────────────────────────
    // DATA SOURCE (M3 doc fix 2026-08-18): Maps populates
    // `APP_INITIALIZATION_STATE` ONCE at document-load with the initial batch
    // of list-card data (~17-19 cards). That state — re-read by the 4 s poll —
    // is the ONLY source feeding this accumulator. The v9.7 XHR/fetch scroll
    // interceptor was REMOVED in v9.8 after empirical refutation (see the
    // SCROLL-CAPTURE post-mortem note near the end of this file); cards beyond
    // the initial batch are enriched by `content/gmb/detail-fetcher.js`, which
    // never writes here.
    //
    // We still accumulate across the session: SPA URL changes + the auto-
    // reload guard can repopulate the state with new businesses under the
    // same tab. First-occurrence wins (the initial batch tends to be the
    // richest variant of a record).
    // ──────────────────────────────────────────────────────────────────────
    const accumulatedBusinesses = {};
    const ACCUMULATOR_CAP = 5000; // safety bound per session

    // BR-2 (ATP 2026-07-17): plausibility canaries against PARTIAL JSPB index
    // drift. A shift that keeps the CID slot intact ships type-correct-but-
    // wrong values into ~27 CSV columns with zero signal. Three anchors are
    // cheap to validate; an implausible anchor is counted AND nulled (never
    // shipped). postcode is IT-gated so foreign postcodes are never dropped.
    const CANARY_POSTCODE_IT_RE = /^\d{5}$/;
    const CANARY_COUNTRY_RE = /^[A-Z]{2}$/;
    // W2 (gosom-hardening 2026-07-22): validator for the orderOnline URL wired
    // through getFirstValid + FIELD_PATHS. http(s) only — a validator-gated
    // fallback path never ships a non-URL (worst case null).
    const HTTP_URL_RE = /^https?:\/\//;
    // Drift LEDGER (W1, gosom-hardening 2026-07-22): two buckets sharing one
    // rate-limited warn channel.
    //   canaryFailures    — an implausible value was DROPPED (last-line defense).
    //   fallbackRecoveries — a primary index path missed but a KNOWN ALTERNATE
    //                        recovered the value. A recovery is the earliest
    //                        signal of a live Google index migration: it means
    //                        the primary path already moved but the record is
    //                        still correct because an alternate caught it. Watch
    //                        this counter climb and you can promote the alternate
    //                        to primary BEFORE exports corrupt.
    const _driftStats = { canaryFailures: {}, fallbackRecoveries: {}, recordsChecked: 0 };
    let _lastCanaryWarnAt = 0;
    function _recordCanaryFailure(field) {
        _driftStats.canaryFailures[field] = (_driftStats.canaryFailures[field] || 0) + 1;
        const now = Date.now();
        if (now - _lastCanaryWarnAt > 30000) {
            _lastCanaryWarnAt = now;
            try {
                console.warn(
                    `[GhostMap state-watcher] JSPB drift canary FAILED on "${field}" — ` +
                    `partial index shift suspected (CID gate still passes). Implausible ` +
                    `value dropped. Counters: ${JSON.stringify(_driftStats.canaryFailures)}`
                );
            } catch { /* ignore */ }
        }
    }
    /**
     * Record that `fieldName` was recovered from candidate #`candidateIndex`
     * (0 = primary; >0 = a fallback path). Routes through the SAME ≤30s warn
     * throttle as `_recordCanaryFailure` — a fallback recovery IS an early
     * drift signal and deserves the same operator-visible channel.
     */
    function _recordFallbackRecovery(fieldName, candidateIndex) {
        const key = `${fieldName}:fellback[${candidateIndex}]`;
        _driftStats.fallbackRecoveries[key] = (_driftStats.fallbackRecoveries[key] || 0) + 1;
        const now = Date.now();
        if (now - _lastCanaryWarnAt > 30000) {
            _lastCanaryWarnAt = now;
            try {
                console.warn(
                    `[GhostMap state-watcher] JSPB drift FALLBACK on "${fieldName}" — ` +
                    `primary index path missed; recovered via alternate candidate #${candidateIndex}. ` +
                    `Google may be migrating this index; promote the alternate before exports break. ` +
                    `Counters: ${JSON.stringify(_driftStats.fallbackRecoveries)}`
                );
            } catch { /* ignore */ }
        }
    }
    /** Validate the 3 canary anchors on an extracted record; null out the implausible ones. */
    function applyDriftCanaries(biz) {
        _driftStats.recordsChecked++;
        if (biz.countryCode != null && !CANARY_COUNTRY_RE.test(biz.countryCode)) {
            _recordCanaryFailure('countryCode');
            biz.countryCode = null;
        }
        if (biz.ratingDecimal != null
            && !(typeof biz.ratingDecimal === 'number' && isFinite(biz.ratingDecimal)
                && biz.ratingDecimal >= 0 && biz.ratingDecimal <= 5)) {
            _recordCanaryFailure('ratingDecimal');
            biz.ratingDecimal = null;
        }
        // IT-gated: only judge the postcode when the record credibly claims Italy.
        if (biz.postcode != null && biz.countryCode === 'IT'
            && !CANARY_POSTCODE_IT_RE.test(biz.postcode)) {
            _recordCanaryFailure('postcode');
            biz.postcode = null;
        }
        return biz;
    }

    function findJspbPayload(state) {
        // CO-9 FIX (2026-05-10): bound the worst-case work. Pre-fix the
        // depth-20 cap was on the recursive call only; the for-loop at each
        // level iterated every child unconditionally. An attacker-controlled
        // APP_INITIALIZATION_STATE (e.g. via same-origin iframe injecting
        // values into a shared global, or a Maps build that surfaces large
        // user-named keys) shaped like a 1000-key object whose every value
        // points to another 1000-key object yields ~1000^20 = 10^60 search
        // invocations before depth saturates. The recursion terminates
        // correctly via depth, but the *work* at depth 19 alone is N^19.
        // For attacker-realistic N≈1000 this hangs the content script.
        //
        // Now: total-work cap (NODE_BUDGET) breaks the loop early if we
        // touch more than the cap; cycle detection (visited WeakSet) skips
        // already-seen objects so revisiting via cyclic refs is O(1).
        const NODE_BUDGET = 200_000;
        let visitedCount = 0;
        const seen = new WeakSet();
        let candidate = null;
        let budgetExhausted = false;

        function search(node, depth) {
            if (budgetExhausted) return;
            if (++visitedCount > NODE_BUDGET) {
                budgetExhausted = true;
                return;
            }
            if (depth > 20) return;
            if (typeof node === 'string') {
                if (node.length > 1000 && node.startsWith(")]}'")) {
                    if (!candidate || node.length > candidate.length) candidate = node;
                }
                return;
            }
            if (Array.isArray(node)) {
                if (seen.has(node)) return;
                seen.add(node);
                for (let i = 0; i < node.length; i++) {
                    if (budgetExhausted) return;
                    search(node[i], depth + 1);
                }
                return;
            }
            if (node && typeof node === 'object') {
                if (seen.has(node)) return;
                seen.add(node);
                for (const k of Object.keys(node)) {
                    if (budgetExhausted) return;
                    search(node[k], depth + 1);
                }
            }
        }
        try { search(state, 0); } catch { /* ignore */ }
        if (budgetExhausted) {
            // Don't silently misreport — log so the operator sees an attack
            // or genuinely huge legitimate state object.
            try { console.warn('[R-STATE] findJspbPayload aborted: node budget exceeded'); } catch {}
        }
        return candidate;
    }

    /**
     * Safe nested getter — returns null on any null/undefined link in the path.
     */
    function get(root, path) {
        let v = root;
        for (const p of path) {
            if (v == null) return null;
            v = v[p];
        }
        return v == null ? null : v;
    }

    /**
     * W1 (gosom-hardening 2026-07-22) — fallback-chain resolver.
     * Return the first candidate path whose value exists AND passes `validate`.
     * `paths` is an array of index-path arrays in preference order (current
     * primary first, known-legacy/alternate next). Records a fallback recovery
     * in the drift ledger IFF a non-primary candidate (i>0) is the one that
     * succeeds — the early-warning signal of a live index migration. Returns
     * null when no candidate is present-and-valid (null-parity with the old
     * per-field guards).
     *
     * NOTE (semantics vs. applyDriftCanaries): for fields whose FIELD_PATHS
     * validator IS the authoritative plausibility predicate (rating, country),
     * an implausible PRIMARY now nulls HERE rather than being nulled+counted
     * later by the canary. To preserve the drift telemetry the canary used to
     * produce, such fields pass `canaryOnMiss=true`: when every candidate is
     * absent-or-implausible AND a value was actually PRESENT (so it is drift,
     * not a legitimately-missing field), getFirstValid records the same
     * `canaryFailures[fieldName]` the old code did — and since the value is
     * already nulled, applyDriftCanaries (unchanged, last line of defense) sees
     * null and does not double-count. The IT-gated postcode deliberately does
     * NOT set canaryOnMiss: its validator here is type-only and its real
     * (\d{5}, IT-only) check stays in applyDriftCanaries so foreign postcodes
     * are never judged. The shipped VALUE is unchanged (null either way).
     */
    function getFirstValid(root, paths, validate = (v) => v != null, fieldName, canaryOnMiss = false) {
        let sawPresentInvalid = false;
        for (let i = 0; i < paths.length; i++) {
            const v = get(root, paths[i]);
            if (v == null) continue;
            if (validate(v)) {
                if (i > 0 && fieldName) _recordFallbackRecovery(fieldName, i);
                return v;
            }
            sawPresentInvalid = true;
        }
        if (sawPresentInvalid && canaryOnMiss && fieldName) _recordCanaryFailure(fieldName);
        return null;
    }

    /**
     * Declarative candidate table for the drift-prone fields wired through
     * getFirstValid. Each entry: { paths: [ [idx...], ... ], validate }.
     *
     * Every field is SINGLE-CANDIDATE today. Empirically probed the real
     * list-state fixture (maps-jspb-pizzerie-milano-2026-05-29, n=18,
     * 2026-07-22): gosom's legacy hours/status alternates do NOT exist here —
     * `[34]` is 0/18 populated and `[88][0]` carries a description string, not
     * status/hours. So no alternate is invented (a validator-less or
     * wrong-shaped fallback would be worse than today). The scaffold + ledger
     * is the deliverable; candidates grow later, verified via the ledger loop.
     */
    const FIELD_PATHS = {
        // finite number in [0,5] — same predicate the canary enforces, so
        // canaryOnMiss preserves the old drift count when the primary drifts.
        ratingDecimal: {
            paths: [[4, 7]],
            validate: (v) => typeof v === 'number' && isFinite(v) && v >= 0 && v <= 5,
            canaryOnMiss: true
        },
        // ISO-3166 alpha-2 — same predicate the canary enforces.
        countryCode: {
            paths: [[243]],
            validate: (v) => typeof v === 'string' && CANARY_COUNTRY_RE.test(v),
            canaryOnMiss: true
        },
        // Type-only + NO canaryOnMiss: the \d{5} check is IT-GATED and stays in
        // applyDriftCanaries (foreign postcodes must never be judged/dropped).
        postcode: {
            paths: [[183, 1, 4]],
            validate: (v) => typeof v === 'string',
            canaryOnMiss: false
        },
        openStatusShort: {
            paths: [[203, 1, 8, 0]],
            validate: (v) => typeof v === 'string',
            canaryOnMiss: false
        },
        openStatusFull: {
            paths: [[203, 1, 4, 0]],
            validate: (v) => typeof v === 'string',
            canaryOnMiss: false
        },
        // Root array of the weekly-hours subtree; extractWeeklyHours parses it.
        hoursWeeklyRoot: {
            paths: [[203, 0]],
            validate: (v) => Array.isArray(v),
            canaryOnMiss: false
        },
        // W2 (gosom-hardening 2026-07-22): the order-online URL, RELATIVE to the
        // selected inner[75][0] action entry (see extractOrderOnline for the
        // type===4 discrimination that no fixed path can express). Probed on the
        // frozen list-state fixture (n=18, 2026-07-22): the URL lives at
        // E[5][1][2][0]. gosom's single-place paths E[1][2] / E[0][2] are BOTH
        // null in list-state (verified) — NOT copied (probe, don't copy gosom;
        // W1 discipline: never invent an unverified alternate). Single-candidate
        // today; the ledger/fallback scaffold grows candidates only when a real
        // alternate is observed. URL-validated so a drift can only null, never
        // ship a non-URL.
        orderOnlineUrl: {
            paths: [[5, 1, 2, 0]],
            validate: (v) => typeof v === 'string' && HTTP_URL_RE.test(v),
            canaryOnMiss: false
        }
    };

    /**
     * Parse `"3.898 recensioni"` / `"3,898 reviews"` → 3898. Italian uses
     * "." as thousands separator; English uses ",". Both are normalized.
     */
    function parseReviewsCount(text) {
        if (!text || typeof text !== 'string') return null;
        const m = text.match(/[\d.,]+/);
        if (!m) return null;
        const n = parseInt(m[0].replace(/[.,]/g, ''), 10);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Extract E.164 from phone subtree. Maps stores variants:
     *   subtree[0][1] = [["3342887151", 1], ["+39 334 288 7151", 2]]
     * Variant `[1]===2` is the international/E.164 form. We prefer it.
     */
    function pickE164(subtree) {
        const variants = get(subtree, [0, 1]);
        if (!Array.isArray(variants)) return null;
        for (const v of variants) {
            if (Array.isArray(v) && v[1] === 2 && typeof v[0] === 'string') return v[0];
        }
        return null;
    }

    /**
     * Build the structured `phone` object from `inner[178]`.
     */
    function extractPhone(inner) {
        const sub = inner[178];
        if (!sub) return null;
        const tel = get(sub, [0, 5, 0]);
        const digits = get(sub, [0, 3]);
        const display = get(sub, [0, 0]);
        const e164 = pickE164(sub);
        if (!digits && !tel && !display) return null;
        return {
            digits: typeof digits === 'string' ? digits : null,
            e164: typeof e164 === 'string' ? e164 : null,
            display: typeof display === 'string' ? display : null,
            tel: typeof tel === 'string' ? tel : null
        };
    }

    /**
     * Service options: flatten `inner[100][1]` (array of categories, each
     * with sub-options). Each option's `[2][0] === 1` means "present", `0`
     * means "absent" (Maps shows them as ✓/✗ in the UI). We keep both.
     */
    function extractServiceOptions(inner) {
        const cats = get(inner, [100, 1]);
        if (!Array.isArray(cats)) return null;
        const out = [];
        for (const cat of cats) {
            if (!Array.isArray(cat)) continue;
            const catName = cat[1];
            const opts = cat[2];
            if (!Array.isArray(opts)) continue;
            for (const opt of opts) {
                if (!Array.isArray(opt)) continue;
                const name = opt[1];
                const present = get(opt, [2, 0]) === 1;
                if (name) out.push({ category: catName, name, present });
            }
        }
        return out.length > 0 ? out : null;
    }

    /**
     * W2 (gosom-hardening 2026-07-22) — order-online link from `inner[75]`.
     *
     * List-state sub-shape (probed on the frozen fixture, n=18, 2026-07-22 — it
     * DIFFERS from gosom's single-place `darray`, so gosom's `[75][0][1][2]` /
     * `[75][0][0][2]` are BOTH null here and must NOT be copied):
     *   inner[75][0] = array of ACTION entries. For each entry `E`:
     *     E[0]          = numeric type code — 4 = "Ordina online" (order-online),
     *                     1 = "Prenota un tavolo" (reservation; already captured
     *                     at inner[46]). The NUMERIC code is the locale-independent
     *                     discriminator (the display label is Italian here).
     *     E[5][1][2][0] = the action URL (wired via FIELD_PATHS.orderOnlineUrl,
     *                     URL-validated through getFirstValid).
     *     E[5][0]       = display label ("Ordina online") — locale-dependent.
     *     E[2][0][0][0] = provider host (reservation aggregators like TheFork /
     *                     guestplan expose it; order-online routes through
     *                     Google's searchviewer redirect and has NO provider tree).
     *
     * Returns { url, source } for the FIRST type===4 entry whose URL validates,
     * else null. `source` is the provider host when present, otherwise the
     * display label (locale-dependent — documented; order-online in list-state
     * carries no distinct provider, so the label is the best available signal).
     */
    function extractOrderOnline(inner) {
        const entries = get(inner, [75, 0]);
        if (!Array.isArray(entries)) return null;
        for (const E of entries) {
            if (!Array.isArray(E)) continue;
            if (get(E, [0]) !== 4) continue; // order-online only; skip reservations (type 1)
            const url = getFirstValid(E, FIELD_PATHS.orderOnlineUrl.paths, FIELD_PATHS.orderOnlineUrl.validate, 'orderOnlineUrl');
            if (url == null) continue;
            const provider = get(E, [2, 0, 0, 0]);
            const label = get(E, [5, 0]);
            const source = (typeof provider === 'string' && provider) ? provider
                : (typeof label === 'string' && label) ? label : null;
            return { url, source };
        }
        return null;
    }

    /**
     * W2 (gosom-hardening 2026-07-22) — accepted payments ("creditCards").
     *
     * RELABEL of the same `inner[100][1]` amenity tree that feeds
     * extractServiceOptions. Category matched on its STABLE code
     * `cat[0] === 'payments'` (locale-independent) — with a locale-fragile
     * display-name fallback (`/pagam|payment/i` on `cat[1]`) ONLY when the code
     * is absent, since a future schema without stable codes would otherwise lose
     * the field entirely. Option `present` uses the SAME convention as
     * extractServiceOptions: `opt[2][0] === 1` means accepted (Maps' ✓); other
     * values (e.g. `3` = "types accepted" sub-node) are excluded. Collects the
     * display NAMES (opt[1]) of accepted options, deduped. Returns a non-empty
     * string[] or null.
     */
    function extractCreditCards(inner) {
        const cats = get(inner, [100, 1]);
        if (!Array.isArray(cats)) return null;
        const out = [];
        const seen = new Set();
        for (const cat of cats) {
            if (!Array.isArray(cat)) continue;
            const code = cat[0];
            const name = cat[1];
            const isPayments = code === 'payments'
                || (code == null && typeof name === 'string' && /pagam|payment/i.test(name));
            if (!isPayments) continue;
            const opts = cat[2];
            if (!Array.isArray(opts)) continue;
            for (const opt of opts) {
                if (!Array.isArray(opt)) continue;
                const optName = opt[1];
                const present = get(opt, [2, 0]) === 1;
                if (present && typeof optName === 'string' && optName && !seen.has(optName)) {
                    seen.add(optName);
                    out.push(optName);
                }
            }
        }
        return out.length > 0 ? out : null;
    }

    /**
     * Price histogram: `inner[4][9][0]` is the array of buckets. Each is:
     *   [["E:EUR_10_TO_20","10-20 €","Da 10 € a 20 €"], [reviewCount, ratio, isPrimary], ...]
     */
    function extractPriceHistogram(inner) {
        const buckets = get(inner, [4, 9, 0]);
        if (!Array.isArray(buckets)) return null;
        const out = [];
        for (const b of buckets) {
            if (!Array.isArray(b)) continue;
            const labelArr = b[0];
            const stats = b[1];
            const bucketLabel = Array.isArray(labelArr) ? labelArr[1] : null;
            const longLabel = Array.isArray(labelArr) ? labelArr[2] : null;
            const reviewCount = Array.isArray(stats) ? stats[0] : null;
            const ratio = Array.isArray(stats) ? stats[1] : null;
            const isPrimary = Array.isArray(stats) && stats[2] === 1;
            if (bucketLabel) out.push({ bucket: bucketLabel, longLabel, reviewCount, ratio, isPrimary });
        }
        return out.length > 0 ? out : null;
    }

    /**
     * Categories with stable codes: `inner[76]` is `[["pizza_restaurant","Pizza",2], ...]`.
     */
    function extractCategoryCodes(inner) {
        const cats = inner[76];
        if (!Array.isArray(cats)) return null;
        const out = [];
        for (const c of cats) {
            if (!Array.isArray(c)) continue;
            out.push({ code: c[0] || null, display: c[1] || null });
        }
        return out.length > 0 ? out : null;
    }

    /**
     * Weekly hours: `inner[203][0]` is per-day:
     *   ["martedì", dayIdx, [Y,M,D], [["12:30–15",[[12,30],[15]]]], 0, 1]
     */
    function extractWeeklyHours(inner) {
        const days = getFirstValid(inner, FIELD_PATHS.hoursWeeklyRoot.paths, FIELD_PATHS.hoursWeeklyRoot.validate, 'hoursWeeklyRoot');
        if (!Array.isArray(days)) return null;
        const out = [];
        for (const d of days) {
            if (!Array.isArray(d)) continue;
            const dayName = d[0];
            const dayIdx = d[1];
            const date = Array.isArray(d[2]) ? { y: d[2][0], m: d[2][1], d: d[2][2] } : null;
            const periods = (d[3] || []).map(p => {
                if (!Array.isArray(p)) return null;
                return { display: p[0], structured: p[1] };
            }).filter(Boolean);
            out.push({ dayName, dayIdx, date, periods });
        }
        return out.length > 0 ? out : null;
    }

    /**
     * Administrative regions: `inner[245][0]` is an array of [_, _, [[name, ...], ...], ...].
     */
    function extractAdminRegions(inner) {
        const arr = get(inner, [245, 0]);
        if (!Array.isArray(arr)) return null;
        const out = [];
        for (const r of arr) {
            const name = get(r, [2, 0, 0]);
            if (typeof name === 'string') out.push(name);
        }
        return out.length > 0 ? out : null;
    }

    /**
     * Build the FULL business record from a single business' inner array.
     * Returns null when the entry isn't a valid business (no CID).
     */
    function extractBusiness(inner) {
        if (!Array.isArray(inner) || inner.length < 11) return null;
        const cid = inner[10];
        if (typeof cid !== 'string' || !CID_RE.test(cid)) return null;

        const phone = extractPhone(inner);
        const orderOnline = extractOrderOnline(inner);
        const reviewsText = get(inner, [4, 3, 1]);
        const reviewsCount = typeof inner[4]?.[8] === 'number' ? inner[4][8] : parseReviewsCount(reviewsText);
        // W1: read drift-prone fields through the fallback-chain resolver.
        const ratingDecimal = getFirstValid(inner, FIELD_PATHS.ratingDecimal.paths, FIELD_PATHS.ratingDecimal.validate, 'ratingDecimal', FIELD_PATHS.ratingDecimal.canaryOnMiss);

        return applyDriftCanaries({
            // identity
            cid: cid.toLowerCase(),
            title: typeof inner[11] === 'string' ? inner[11] : null,
            placeId: typeof inner[78] === 'string' ? inner[78] : null,
            knowledgeGraphId: typeof inner[89] === 'string' ? inner[89] : null,
            // geography
            latitude: typeof get(inner, [9, 2]) === 'number' ? inner[9][2] : null,
            longitude: typeof get(inner, [9, 3]) === 'number' ? inner[9][3] : null,
            addressFormatted: typeof inner[39] === 'string' ? inner[39] : null,
            addressFull: typeof inner[18] === 'string' ? inner[18] : null,
            addressLine1: typeof get(inner, [2, 0]) === 'string' ? inner[2][0] : null,
            addressLine2: typeof get(inner, [2, 1]) === 'string' ? inner[2][1] : null,
            street: typeof get(inner, [82, 1]) === 'string' ? inner[82][1] : null,
            city: typeof inner[166] === 'string' ? inner[166] : null,
            postcode: getFirstValid(inner, FIELD_PATHS.postcode.paths, FIELD_PATHS.postcode.validate, 'postcode', FIELD_PATHS.postcode.canaryOnMiss),
            province: typeof get(inner, [183, 1, 5]) === 'string' ? inner[183][1][5] : null,
            countryCode: getFirstValid(inner, FIELD_PATHS.countryCode.paths, FIELD_PATHS.countryCode.validate, 'countryCode', FIELD_PATHS.countryCode.canaryOnMiss),
            languageCode: typeof inner[110] === 'string' ? inner[110] : null,
            timezone: typeof inner[30] === 'string' ? inner[30] : null,
            adminRegions: extractAdminRegions(inner),
            // contact
            phone,
            website: typeof get(inner, [7, 0]) === 'string' ? inner[7][0] : null,
            websiteDomain: typeof get(inner, [7, 1]) === 'string' ? inner[7][1] : null,
            reservationUrl: typeof get(inner, [46, 0, 0]) === 'string' ? inner[46][0][0] : null,
            reservationDomain: typeof get(inner, [46, 0, 1]) === 'string' ? inner[46][0][1] : null,
            // business
            categoryNames: Array.isArray(inner[13]) ? inner[13].filter(s => typeof s === 'string') : null,
            primaryCategory: typeof get(inner, [13, 0]) === 'string' ? inner[13][0] : null,
            categoryCodes: extractCategoryCodes(inner),
            searchResultType: typeof get(inner, [88, 1]) === 'string' ? inner[88][1] : null,
            // popularity / price
            ratingDecimal,
            reviewsCount,
            reviewsText: typeof reviewsText === 'string' ? reviewsText : null,
            reviewsUrl: typeof get(inner, [4, 3, 0]) === 'string' ? inner[4][3][0] : null,
            priceRangeText: typeof get(inner, [4, 2]) === 'string' ? inner[4][2] : null,
            priceHistogram: extractPriceHistogram(inner),
            // Path: i[142][1][0] = [null, [[snippet_text, offsets], null, photo_url], null, total_reviews, ...]
            reviewSnippet: typeof get(inner, [142, 1, 0, 1, 0, 0]) === 'string' ? inner[142][1][0][1][0][0] : null,
            // status / hours
            openStatusShort: getFirstValid(inner, FIELD_PATHS.openStatusShort.paths, FIELD_PATHS.openStatusShort.validate, 'openStatusShort', FIELD_PATHS.openStatusShort.canaryOnMiss),
            openStatusFull: getFirstValid(inner, FIELD_PATHS.openStatusFull.paths, FIELD_PATHS.openStatusFull.validate, 'openStatusFull', FIELD_PATHS.openStatusFull.canaryOnMiss),
            hoursWeekly: extractWeeklyHours(inner),
            // media / owner
            primaryPhotoUrl: typeof get(inner, [37, 0, 0, 6, 0]) === 'string' ? inner[37][0][0][6][0] : null,
            ownerName: typeof get(inner, [57, 1]) === 'string' ? inner[57][1] : null,
            ownerId: typeof get(inner, [57, 2]) === 'string' ? inner[57][2] : null,
            ownerPhotoUrl: typeof inner[157] === 'string' ? inner[157] : null,
            // amenities
            serviceOptions: extractServiceOptions(inner),
            // W2 (gosom-hardening): order-online link + accepted payments.
            orderOnlineUrl: orderOnline ? orderOnline.url : null,
            orderOnlineSource: orderOnline ? orderOnline.source : null,
            creditCards: extractCreditCards(inner)
        });
    }

    /**
     * Walk a parsed JSPB tree and merge every business entry into the
     * session accumulator (keyed by lowercased CID). First occurrence
     * wins — deeper duplicates are usually the less-rich variant pulled
     * in by "related searches" carousels.
     *
     * Returns the count of NEW businesses added (0 when the payload only
     * contained CIDs already in the accumulator). Used by callers that
     * want to know whether the post-channel needs a fresh dispatch.
     */
    function mergeFromParsedJspb(parsed) {
        if (parsed == null) return 0;
        let added = 0;
        // R3-C1a (2026-08-18): size tracked incrementally so the cap pre-check
        // below stays O(1) per node instead of Object.keys() per candidate.
        let size = Object.keys(accumulatedBusinesses).length;
        function walk(node) {
            if (!Array.isArray(node)) return;
            const inner = node[1];
            if (Array.isArray(inner) && inner.length > 10) {
                // R3-C1a DE-INFLATION FIX (2026-08-18): peek the CID slot and
                // SKIP extraction for records already accumulated (or when the
                // cap is reached). First-occurrence-wins means the extracted
                // result was discarded anyway — but extractBusiness's
                // getFirstValid/applyDriftCanaries calls re-bumped the drift
                // ledger (canaryFailures / fallbackRecoveries / recordsChecked)
                // on EVERY re-merge: one drifted record inflated its counter on
                // each changed-payload merge (and, pre-identity-gate, on every
                // 4 s tick), making the numbers quantitatively meaningless.
                // Post-fix a drift bump is a per-RECORD event: it fires exactly
                // once, when the record is first extracted. Duplicate CIDs
                // deeper in the SAME payload are skipped too (the first
                // occurrence has already inserted by the time they are walked).
                const cidKey = typeof inner[10] === 'string' ? inner[10].toLowerCase() : null;
                const alreadyAccumulated = cidKey != null && !!accumulatedBusinesses[cidKey];
                if (!alreadyAccumulated && size < ACCUMULATOR_CAP) {
                    const biz = extractBusiness(inner);
                    if (biz && biz.cid && !accumulatedBusinesses[biz.cid]) {
                        accumulatedBusinesses[biz.cid] = biz;
                        accumulatorVersion++; // S1: the ONLY accumulator write — dirty-mark for the poll
                        size++;
                        added++;
                    }
                }
            }
            for (let j = 0; j < node.length; j++) walk(node[j]);
        }
        try { walk(parsed); } catch { /* ignore */ }
        return added;
    }

    /**
     * Refresh the accumulator from `APP_INITIALIZATION_STATE`. Idempotent:
     * an unchanged payload short-circuits at the identity gate (R3-C2b) with
     * zero parse/walk cost; a changed payload merges only CIDs not already
     * accumulated (first-occurrence wins, R3-C1a).
     */
    function mergeFromInitialState(state) {
        if (!state) return 0;
        const raw = findJspbPayload(state);
        if (!raw) return 0;
        // R3-C2b (2026-08-18): identity gate — an unchanged payload string is
        // never re-parsed/re-walked (see the _lastMergedRawPayload note above).
        if (raw === _lastMergedRawPayload) return 0;
        _lastMergedRawPayload = raw;
        const trimmed = raw.slice(raw.indexOf('\n') + 1);
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { return 0; }
        return mergeFromParsedJspb(parsed);
    }

    /**
     * Backward-compat shim: the earlier observer.js builds a CID→{formatted,
     * canonical} phone map. We expose that view as `map` AND ship the full
     * business records under `businesses` so newer observer code can pick
     * up the rich fields without breaking older deployments.
     */
    function buildCidPhoneMap(businesses) {
        if (!businesses) return null;
        const map = {};
        for (const [cid, biz] of Object.entries(businesses)) {
            if (!biz.phone) continue;
            const formatted = biz.phone.e164 || biz.phone.display || null;
            const canonical = biz.phone.digits || null;
            if (formatted || canonical) map[cid] = { formatted, canonical };
        }
        return map;
    }

    let lastDiagWarnedAt = 0;
    function tick() {
        try {
            const state = window.APP_INITIALIZATION_STATE;
            // Refresh from initial state (idempotent — re-merges the same CIDs).
            // M3 doc fix (2026-08-18): this IS the only ingestion point — the
            // XHR/fetch network interceptor was removed in v9.8 (post-mortem
            // note at the end of this file). New entries appear only when
            // APP_INITIALIZATION_STATE itself changes (SPA nav / auto-reload).
            mergeFromInitialState(state);
            const businesses = accumulatedBusinesses;
            const sizeB = Object.keys(businesses).length;
            if (sizeB > 0) {
                // S1: O(1) dirty check — publish only when the accumulator
                // actually changed since the last publish (or a fresh
                // gmp:state-map-request forced lastPublishedVersion = -1).
                if (accumulatorVersion !== lastPublishedVersion) {
                    lastPublishedVersion = accumulatorVersion;
                    const map = buildCidPhoneMap(businesses) || {};
                    const sizeP = Object.keys(map).length;
                    window.postMessage({
                        type: CHANNEL,
                        payload: {
                            map,                                  // legacy phone map
                            businesses,                           // full field catalog
                            size: sizeB,
                            phoneSize: sizeP,
                            ts: Date.now(),
                            drift: {
                                canaryFailures: { ..._driftStats.canaryFailures },
                                // M2 FIX (2026-08-18): ship the W1 fallback-
                                // recovery ledger too. It used to live only in
                                // a MAIN-world console.warn, where no operator,
                                // ISOLATED consumer, SW or UI would ever see the
                                // earliest signal of a live Google index
                                // migration. Shipped as a COPY (spread), same as
                                // canaryFailures, on the already-existing drift
                                // channel. Deliberately NOT routed into the H7
                                // `selector_telemetry` SW sink: that sink is
                                // reset-on-ack delta-based — a cumulative ledger
                                // there would re-create the M8 double-counting
                                // shape.
                                fallbackRecoveries: { ..._driftStats.fallbackRecoveries },
                                recordsChecked: _driftStats.recordsChecked
                            }
                        }
                    }, location.origin);
                    if (DEBUG) {
                        try {
                            // eslint-disable-next-line no-console
                            console.info(`[GhostMap state-watcher] posted map: ${sizeB} businesses, ${sizeP} phones`);
                        } catch { /* ignore */ }
                    }
                }
            } else {
                // Discriminating diagnostic — emit AT MOST every 30s so we
                // don't spam the console, and tell the user EXACTLY why
                // there's no map: state missing, JSPB payload absent (most
                // common cause: SPA-navigated to /maps/search/ from /maps
                // homepage — page wasn't initially loaded as a search URL),
                // or state present but no businesses extracted.
                const now = Date.now();
                if (now - lastDiagWarnedAt > 30000) {
                    lastDiagWarnedAt = now;
                    try {
                        if (!state) {
                            if (DEBUG) console.debug('[GhostMap state-watcher] no APP_INITIALIZATION_STATE yet');
                        } else {
                            const sizeKb = Math.round(JSON.stringify(state).length / 1024);
                            const raw = findJspbPayload(state);
                            // URL-aware messaging: on the bare /maps homepage
                            // there is no search active, so there is nothing
                            // to extract — refreshing won't help. Only suggest
                            // a reload on /maps/search/ or /maps/place/.
                            const onSearchOrPlace = /\/maps\/(search|place)\//.test(location.href);
                            if (!raw) {
                                if (onSearchOrPlace) {
                                    console.warn(
                                        `[GhostMap state-watcher] state present (${sizeKb}KB) but NO JSPB payload found. ` +
                                        `Likely cause: page was loaded on /maps (homepage) and search done via SPA — ` +
                                        `state stays at the homepage value. FIX: refresh the page (Cmd+R) so Maps ` +
                                        `reloads APP_INITIALIZATION_STATE with the current search URL's data.`
                                    );
                                } else if (DEBUG) {
                                    // Bare /maps homepage (or other non-search URL): expected idle state.
                                    console.debug(
                                        `[GhostMap state-watcher] idle on Maps homepage (${sizeKb}KB state, no search active). ` +
                                        `Perform a search to begin extracting business data.`
                                    );
                                }
                            } else {
                                console.warn(
                                    `[GhostMap state-watcher] JSPB payload found (${raw.length} chars) but 0 businesses extracted. ` +
                                    `Maps may have changed the field structure — open an issue with the page URL.`
                                );
                            }
                        }
                    } catch { /* ignore */ }
                }
            }
        } catch (e) {
            if (DEBUG) {
                try { console.debug('[GhostMap state-watcher] tick error:', e?.message); } catch { /* ignore */ }
            }
        }
        // M5 FIX (2026-08-18): no self-shutoff here anymore — the poll runs
        // for the tab's lifetime (see the MAX_POLL_MS removal note at the top).
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        // SEC-01 (2026-06-09): this request carries NO payload — it only starts
        // the local APP_INITIALIZATION_STATE poll. The optional-chaining type
        // guard below already rejects any non-object / wrong-type message, so
        // there is no attacker-controlled value to schema-validate here. The
        // data-bearing direction (the gmp:state-map RESPONSE) is validated by
        // its consumer in observer.js (isolated world, CT-4).
        if (event.data?.type !== 'gmp:state-map-request') return;
        // S1: force a republish on the next tick even if content is unchanged
        // (a fresh/re-armed observer needs the current snapshot; the ISOLATED
        // consumer merges idempotently, so an identical re-post is harmless).
        // M5: the poll never self-stops anymore, so a request no longer resets
        // any deadline — it only forces the republish and runs a tick now.
        // R3-C2a (2026-08-18): the former `if (!pollHandle) …` "defensive
        // re-arm" here was dead code — the interval id is assigned
        // synchronously at install (before any message task can be delivered)
        // and nothing in this file ever clears it; even an external
        // clearInterval sweep would leave the id truthy, so the guard could
        // not detect the one scenario it claimed to cover. Removed.
        lastPublishedVersion = -1;
        tick();
    });

    // Loaded — visible signal for diagnostic
    if (DEBUG) {
        try {
            // eslint-disable-next-line no-console
            console.info('[GhostMap state-watcher] installed (MAIN world)');
        } catch { /* ignore */ }
    }

    /**
     * Auto-reload guard for the SPA navigation case.
     *
     * Maps server-renders APP_INITIALIZATION_STATE based on the URL of the
     * INITIAL page load. When the user opens https://www.google.com/maps
     * and then types a search in the in-page search bar, Maps SPA-navigates
     * the URL to /maps/search/<query> WITHOUT refreshing — and the state
     * stays at the homepage's tiny value (~32KB, no JSPB payload). Result:
     * watcher cannot extract business data, CSV columns come up empty.
     *
     * Detection: on a /maps/search/ or /maps/place/ URL, if state size is
     * below the homepage-floor threshold (100KB), do a ONE-TIME reload.
     * After reload Maps re-renders with the current URL and populates the
     * state with the JSPB blob (~890KB for a typical pizzerie search).
     *
     * Anti-loop: a sessionStorage sentinel `gmpAutoReloaded` is set BEFORE
     * the reload and checked at install time. Same-tab repeated triggers
     * are blocked. The sentinel is per-tab (sessionStorage scope) so other
     * tabs aren't affected.
     *
     * Cost to user: a single quick reload at first scrape — much better
     * UX than silent empty-data extractions.
     */
    /**
     * 2026-05-15 FIX (reload loop): pathname normalization for the
     * sentinel. Maps URL pathnames include map state we must NOT key on:
     *   /maps/search/wedding+planner/@44.527,10.873,15z
     *   /maps/search/wedding+planner/@44.527,10.873,15z/data=!3m1!4b1
     *   /maps/search/wedding+planner                    ← clean form
     *
     * The `@lat,lng,zoom` block and `/data=...` suffix mutate every time
     * Maps re-renders (e.g. after our location.replace() landed on a
     * slightly different center, or the user panned). Using the raw
     * pathname as sentinel key meant each post-reload variation got a
     * fresh key and our reload guard fired AGAIN, in a loop. Now we
     * normalize to the search-query stem, so any number of map-view
     * mutations under the same query share one sentinel entry.
     */
    function _normalizedReloadKey() {
        try {
            // Drop /@lat,lng,zoom?-suffix and any /data=... trailing segment.
            const clean = location.pathname
                .replace(/\/@-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,[0-9.]+z\b/g, '')
                .replace(/\/data=[^/]*$/, '')
                .replace(/\/+$/, '');
            return 'gmpAutoReloaded:' + clean;
        } catch {
            return 'gmpAutoReloaded:' + location.pathname;
        }
    }

    function maybeAutoReloadForState() {
        try {
            const url = location.href;
            if (!/\/maps\/(search|place)\//.test(url)) return;
            const pathKey = _normalizedReloadKey();
            try {
                if (sessionStorage.getItem(pathKey) === '1') return;
                // Hard belt-and-suspenders: global per-tab cap. Even if the
                // pathname-key normalization above somehow misfires, we
                // refuse to ever do more than RELOAD_MAX_PER_SESSION in a
                // single tab session. Above this cap the warn still fires
                // (so the user sees the diagnostic), the navigation does
                // not. Defaults to 2: one for the initial SPA-entry case,
                // one buffer for an edge case the normalization missed.
                const RELOAD_MAX_PER_SESSION = 2;
                const countKey = 'gmpAutoReloadCount';
                const currentCount = parseInt(sessionStorage.getItem(countKey) || '0', 10) || 0;
                if (currentCount >= RELOAD_MAX_PER_SESSION) {
                    console.warn(
                        '[GhostMap state-watcher] auto-reload cap reached (' +
                        currentCount + '/' + RELOAD_MAX_PER_SESSION +
                        ') — refusing to reload further this session.'
                    );
                    return;
                }
            } catch { return; /* sessionStorage blocked → bail safely */ }

            // Wait briefly so async hydration has a chance to finish first.
            // If state is genuinely small after the wait, we know it's the
            // SPA quirk — not a slow network race.
            setTimeout(() => {
                try {
                    const state = window.APP_INITIALIZATION_STATE;
                    if (!state) return; // never loaded — likely a non-Maps page race
                    const json = JSON.stringify(state);
                    // Threshold derives from empirical measurement:
                    //   - /maps homepage state: 32 KB (no JSPB)
                    //   - /maps/search/<q>:    ~890 KB (with JSPB)
                    //   - /maps/place/<x>:    ~324 KB (single-place JSPB)
                    // 100 KB is well below the smallest "rich" value and
                    // safely above the largest "anemic" homepage value.
                    if (json.length >= 100_000) return;
                    // Confirm anemia: there's no JSPB payload either
                    if (findJspbPayload(state)) return;
                    // B2-2 fix: raised threshold 5 → 20 to reduce false-positive
                    // reloads on low-yield queries (e.g., "ferramenta in via Roma 1"
                    // legitimately yields 3-4 businesses; the previous threshold
                    // would still trigger a destructive reload, dropping that work).
                    // 20 is well above typical sub-yield queries while still
                    // tolerating the accumulator being mid-fill on the very first
                    // tick of a search where Maps hasn't streamed cards yet.
                    //
                    // NOT IN SCOPE (deferred): explicit scrape-active lock signal
                    // via postMessage from area-search.js → ISO → MAIN. The handoff
                    // template suggests it; threshold raise alone is ~90 % of the
                    // protection at minimal risk. Track as future hardening if the
                    // threshold-raise alone proves insufficient.
                    if (Object.keys(accumulatedBusinesses).length >= 20) return;

                    try {
                        sessionStorage.setItem(pathKey, '1');
                        // Bump the global session-wide reload count too.
                        const cur = parseInt(sessionStorage.getItem('gmpAutoReloadCount') || '0', 10) || 0;
                        sessionStorage.setItem('gmpAutoReloadCount', String(cur + 1));
                    } catch { return; }

                    // 2026-05-15 FIX: location.reload() preserves the URL
                    // verbatim, including SPA-entry query params like
                    // `entry=ttu` and `g_ep=...` that tell Maps' server to
                    // render the lightweight shell WITHOUT the JSPB blob.
                    // Result: the previous fix reloaded into the same anemic
                    // state, the warn appeared to fire only once (sentinel
                    // blocked a second reload) but the page never actually
                    // got rich state — silent failure. Now we strip ALL
                    // query params before navigating; pathname (search query
                    // + lat/lng/zoom) is what Maps needs to render rich
                    // state. location.replace() doesn't add a history entry,
                    // so the back button still goes where the user expects.
                    const cleanUrl = location.origin + location.pathname + location.hash;
                    // Expected SPA recovery — debug only (console.warn lights
                    // chrome://extensions Errors on unpacked installs). Reload below unchanged.
                    // eslint-disable-next-line no-console
                    console.debug(
                        '[GhostMap state-watcher] anemic state (' +
                        Math.round(json.length / 1024) +
                        'KB) on ' + location.pathname +
                        ' — reloading without SPA-entry query params to repopulate APP_INITIALIZATION_STATE.'
                    );
                    // Defer the navigation one tick so the log flushes
                    setTimeout(() => location.replace(cleanUrl), 50);
                } catch { /* never throw from auto-reload */ }
            }, 1500);
        } catch { /* ignore */ }
    }

    /**
     * Re-run the auto-reload check whenever Maps SPA-navigates. Maps does
     * NOT do a real page reload when the user types a new search; it only
     * mutates `location` via `history.pushState/replaceState`. Without this
     * hook, the auto-reload guard fires only once at install time — when
     * the user is still on `/maps` (homepage) — and never again when they
     * search and the URL transitions to `/maps/search/X` (where state is
     * still the anemic homepage value because Maps never re-rendered).
     *
     * We monkey-patch history.pushState/replaceState (idempotent), listen
     * to the synthetic `gmp:urlchange` event we dispatch from inside, and
     * re-evaluate. Per-pathname sentinel above ensures one reload per
     * distinct search URL. NOTE: `gmp:urlchange` is also the R-DETAIL
     * trigger for the ISOLATED-world observer (forensic #2) — DOM events
     * cross isolated-world boundaries, so do not rename or remove it.
     */
    // CO-1 FIX (2026-05-11): pre-fix used `window.__gmpUrlChangeHooked`
    // as the idempotency sentinel — a page-observable string property
    // that maps.google.com (or a colliding extension running on the
    // same page) could pre-set to truthy, causing our installer to
    // early-return and never hook the history methods. Additionally the
    // patch had no defense against Maps re-patching pushState/
    // replaceState AFTER our install (e.g. on SPA route change), which
    // would silently lose our hook.
    //
    // Fix:
    //   1. Idempotency tracked via closure-scoped vars (not window-
    //      observable). The page can't read or pre-set them.
    //   2. Original methods captured ONCE in closure, never re-read.
    //      If the page later re-assigns history.pushState to something
    //      else, we still have the genuine original.
    //   3. Periodic integrity check (every 5s) verifies our wrapper is
    //      still the active history.pushState. If not, re-install.
    //      Low overhead (one identity check + two assignments worst
    //      case) and recoverable: even if Maps re-patches every minute,
    //      we self-heal within 5s.
    let _hookInstalled = false;
    let _ourPushWrapper = null;
    let _ourReplaceWrapper = null;
    let _origPush = null;
    let _origReplace = null;

    function installUrlChangeWatcher() {
        if (_hookInstalled) {
            // Already initialized once; re-verify and re-apply if Maps
            // (or any other actor) overwrote our wrappers.
            try {
                if (history.pushState !== _ourPushWrapper) history.pushState = _ourPushWrapper;
                if (history.replaceState !== _ourReplaceWrapper) history.replaceState = _ourReplaceWrapper;
            } catch { /* ignore */ }
            return;
        }
        try {
            _origPush = history.pushState;
            _origReplace = history.replaceState;
            _ourPushWrapper = function (...args) {
                const r = _origPush.apply(this, args);
                try { window.dispatchEvent(new Event('gmp:urlchange')); } catch { /* ignore */ }
                return r;
            };
            _ourReplaceWrapper = function (...args) {
                const r = _origReplace.apply(this, args);
                try { window.dispatchEvent(new Event('gmp:urlchange')); } catch { /* ignore */ }
                return r;
            };
            history.pushState = _ourPushWrapper;
            history.replaceState = _ourReplaceWrapper;
            const onChange = () => {
                try { maybeAutoReloadForState(); } catch { /* ignore */ }
            };
            window.addEventListener('popstate', onChange);
            window.addEventListener('gmp:urlchange', onChange);
            _hookInstalled = true;
            // Periodic integrity check. 5s interval keeps overhead at
            // ~12 identity-comparisons per minute. setInterval is OK
            // because this script runs in MAIN-world on Maps tabs only
            // (per manifest content_scripts.matches); when the tab is
            // closed the interval is GC'd with the page context.
            setInterval(() => {
                try {
                    if (history.pushState !== _ourPushWrapper) {
                        history.pushState = _ourPushWrapper;
                    }
                    if (history.replaceState !== _ourReplaceWrapper) {
                        history.replaceState = _ourReplaceWrapper;
                    }
                } catch { /* ignore */ }
            }, 5000);
        } catch { /* ignore */ }
    }

    /**
     * SCROLL-CAPTURE: REMOVED in v9.8 (2026-05-06). The premise of v9.7 —
     * "Maps streams new list-cards via JSPB XHR/fetch during scroll" — was
     * empirically REFUTED: the interceptor saw 99 XHRs and 3 fetches during
     * a 60s scroll session, but ZERO of them carried business records
     * (only batchexecute-201B, pegman, passiveassist — autocomplete data).
     * Maps actually loads 17-19 cards into APP_INITIALIZATION_STATE up
     * front and serves the rest of the list-view from a backend that the
     * page only contacts when the user clicks a card detail panel.
     *
     * Phone/website/etc enrichment for the cards beyond the initial 17-19
     * is now handled by `content/gmb/detail-fetcher.js`, which calls
     * `/maps/preview/place` programmatically with the (CID, FID, placeId,
     * lat, lng) tuple extracted from each card's href. See
     * `docs/MAPS_DETAIL_FETCH_REVERSE_ENGINEERING.md`.
     */
    // Test-only internals hook (W1). Attached ONLY when the volatile flag
    // `window.__gmpStateWatcherExposeInternals` is set — production never sets
    // it, so this is a no-op in the extension. The Node test harness sets it
    // before running the source to reach the IIFE internals (extractBusiness,
    // getFirstValid, FIELD_PATHS, and the live drift ledger) without any
    // production-visible surface change. Mirrors the existing DEBUG-flag style.
    if (window.__gmpStateWatcherExposeInternals) {
        window.__gmpStateWatcherTestHooks = {
            extractBusiness,
            getFirstValid,
            get,
            FIELD_PATHS,
            driftStats: _driftStats
        };
    }

    installUrlChangeWatcher();
    maybeAutoReloadForState();

    tick();
    // M5 (2026-08-18): the poll runs for the tab's lifetime — never
    // self-cleared, GC'd with the page context. The interval id is
    // deliberately not kept: nothing may stop this poll (R3-C2a).
    setInterval(tick, POLL_INTERVAL_MS);
})();
