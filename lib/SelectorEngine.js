/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Dynamic Selector Engine
 * Robust field extraction using multiple strategies
 * Prioritizes semantic attributes over brittle CSS classes
 * 
 * UPDATED: Added text pattern strategies for Hotels & Embedded sites
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * CS-002 SELECTOR MAINTENANCE GUIDE
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * VERSION: 2.1.0 (2024-12-17)
 * LAST VERIFIED: Google Maps UI as of December 2024
 * 
 * HOW TO UPDATE WHEN GOOGLE CHANGES UI:
 * 1. Open Chrome DevTools on Google Maps search results
 * 2. Find working element (e.g., business title, rating, website)
 * 3. Identify stable selectors in order of preference:
 *    - [data-*] attributes (most stable)
 *    - [aria-*] attributes (accessibility, rarely changes)
 *    - [role=*] attributes (semantic, stable)
 *    - [jsaction=*] patterns (Google-specific but stable)
 *    - CSS classes (LAST RESORT - change frequently!)
 * 4. Add new selector to FRONT of strategy array (higher priority)
 * 5. Keep old selectors as fallbacks
 * 6. Update VERSION above and test with 100+ businesses
 * 
 * STRATEGY TYPES:
 * - 'attribute': Extract attribute value (href, aria-label, data-*)
 * - 'selector': Extract textContent from element
 * - 'content': Pattern match within text
 * - 'text_pattern': Full container text scan (last resort)
 * 
 * KNOWN BRITTLE CLASSES (avoid if possible):
 * - .DUwDvf, .qBF1Pd, .NrDZNb (titles - change every ~6 months)
 * - .MW4etd, .ceNzKf (ratings)
 * - .UY7F9, .F7nice (review counts)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from './utils.js';

/**
 * R10 (TIER A): Selector telemetry.
 *
 * Each `extractField()` call records WHICH strategy (data-attr / aria-label /
 * role / hardcoded class / text-pattern) actually produced the value. The
 * SelectorEngine itself does not depend on Statistics — it exposes a per-
 * instance counter map that callers (or background/index.js startup) can
 * forward to Statistics. This avoids a circular import from a leaf utility
 * back to the Statistics singleton.
 *
 * Why telemetry here matters: the Google Maps DOM ships hardcoded class
 * names that change every ~6 months (`.DUwDvf`, `.qBF1Pd`, `.NrDZNb`, …).
 * Without per-strategy hit counts you only learn the selectors are dead
 * once extraction-rate cratergates. With this counter, an operator can
 * watch the proportion of `class` hits vs. `attribute|aria-label` hits
 * and replace classes BEFORE they break.
 *
 * Performance: each hit is a single Map.get/.set + integer increment.
 * Negligible vs. the DOM walk.
 */
const STRATEGY_TYPES = ['attribute', 'selector', 'content', 'text_pattern'];

/**
 * Strategy hit signature. We aggregate by (field, strategy_type, selector_or_pattern_signature).
 * For selector strategies, the signature is the selector string. For text_pattern,
 * the signature is the pattern's source string (without flags). For attribute
 * strategies with a selector, the key is `attribute:<attrName>@<selector>`.
 */
function strategySignature(field, strategy) {
    if (strategy.type === 'attribute') {
        const sel = strategy.selector ? `@${strategy.selector}` : '';
        return `${field}|attribute:${strategy.value}${sel}`;
    }
    if (strategy.type === 'selector') {
        return `${field}|selector:${strategy.value}`;
    }
    if (strategy.type === 'content') {
        const sel = strategy.selector ? `@${strategy.selector}` : '';
        const pat = strategy.pattern ? `[${String(strategy.pattern.source).slice(0, 32)}]` : '';
        return `${field}|content${sel}${pat}`;
    }
    if (strategy.type === 'text_pattern') {
        return `${field}|text_pattern:${String(strategy.pattern.source).slice(0, 48)}`;
    }
    return `${field}|unknown`;
}

export class SelectorEngine {
    constructor(config = {}) {
        this.config = config;
        // R10: per-instance hit/miss counters. Read via getTelemetry().
        // hits[signature] = { hits, attempts, lastHitAt }
        this._telemetry = new Map();

        // R16 (TIER B): per-strategy circuit breaker.
        // After `breakerThreshold` consecutive misses on a given strategy
        // signature, that strategy is skipped for the next `breakerSkipCount`
        // calls. A single subsequent hit closes the breaker. The goal is
        // pure CPU savings: when `.DUwDvf` has been dead for the last 200
        // pages, don't keep paying for `querySelector` on it.
        //
        // Tunables (overridable via constructor config):
        //   breakerThreshold: 30   — consecutive misses before opening
        //   breakerSkipCount: 100  — how many calls to skip while open
        //   breakerEnabled: true   — escape hatch; can be turned off
        //
        // Telemetry continues to record skip-attempts so the decay report
        // remains meaningful (skipped strategies count as "attempted-then-
        // not-tried", visible via getCircuitState()).
        this._circuitState = new Map(); // signature → { consecutiveMisses, openSkipsLeft }
        this._breakerThreshold = config.breakerThreshold ?? 30;
        this._breakerSkipCount = config.breakerSkipCount ?? 100;
        this._breakerEnabled = config.breakerEnabled !== false;

        // Selectors validated 2026-05-05 against live Maps DOM (3 pizzerie sample).
        // See opportuni-poc/scripts/maps_audit/audit-report.json for hit rates.
        this.strategies = {
            title: [
                { type: 'attribute', value: 'aria-label' },
                { type: 'selector', value: 'h1.DUwDvf' }, // 3/3 hits 2026-05-05
                // Stale selectors kept as last-resort fallback (0/3 hits but cheap to test)
                { type: 'selector', value: '.fontHeadlineLarge' },
                { type: 'selector', value: '[role="heading"][aria-level="1"]' },
                { type: 'selector', value: '.qBF1Pd' },
                { type: 'selector', value: '.NrDZNb' }
            ],
            rating: [
                // Comma-or-dot decimal: Maps IT renders "4,7 stelle", US renders "4.7 stars"
                { type: 'attribute', value: 'aria-label', pattern: /(\d+(?:[.,]\d+)?)\s*stars?/i },
                { type: 'attribute', value: 'aria-label', pattern: /(\d+(?:[.,]\d+)?)\s*stelle/i },
                { type: 'content', pattern: /^(\d+(?:[.,]\d+)?)$/, context: 'span[aria-hidden="true"]' },
                // Plausibility validator added in extractField — only accepts X.Y or X,Y where 0<=X<=5
                { type: 'selector', value: 'span.ceNzKf', validate: 'rating' }, // 3/3 hits
                { type: 'selector', value: '.MW4etd', validate: 'rating' }       // 3/3 hits, returns "4,7"
            ],
            reviews: [
                { type: 'attribute', value: 'aria-label', pattern: /(\d+)\s*reviews?/i },
                { type: 'attribute', value: 'aria-label', pattern: /(\d+)\s*recensioni/i },
                { type: 'content', pattern: /\(?(\d+)\)?/, validate: 'integer' },
                { type: 'content', selector: 'span.F7nice', pattern: /\((\d[\d.,]*)\)/, validate: 'integer' },
                { type: 'content', selector: '.UY7F9', pattern: /\((\d[\d.,]*)\)/, validate: 'integer' }   // 3/3 hits, returns "(165)"
            ],
            website: [
                // Strategy 1: Direct links (High confidence)
                { type: 'attribute', value: 'href', selector: 'a[data-item-id="authority"]' },
                { type: 'attribute', value: 'href', selector: 'a[aria-label*="website" i]' },
                { type: 'attribute', value: 'href', selector: 'a[aria-label*="sito web" i]' },
                { type: 'selector', value: 'a.CsEnBe' },

                // Strategy 2: Data attributes (Buttons)
                { type: 'attribute', value: 'data-value', selector: '[data-value^="http"]' },
                { type: 'attribute', value: 'data-url', selector: '[data-url^="http"]' },

                // Strategy 3: Text Patterns (Hotels/Embedded) - Lower priority but essential
                { type: 'text_pattern', pattern: /\b([a-z0-9][-a-z0-9]{0,62}\.(?:it|com|net|org|eu|info|hotel))\b/i },
                { type: 'text_pattern', pattern: /\b(www\.[a-z0-9][-a-z0-9]{0,62}\.[a-z]{2,6})\b/i }
            ],
            phone: [
                // Detail page selectors. aria-label observed format: "Telefono: 02 5830 6292"
                { type: 'attribute', value: 'href', selector: 'button[data-item-id^="phone"]', pattern: /tel:(.*)/, multi: true },
                { type: 'attribute', value: 'aria-label', selector: 'button[data-item-id^="phone"]', pattern: /(?:call|chiama|telefono)\s*:?\s*(.+)/i, multi: true },
                { type: 'content', selector: 'button[data-item-id^="phone"] .Io6YTe', multi: true },   // 3/3 hits

                // LISTING CARD selectors. Italian Maps uses "telefono" aria-label, NOT "phone".
                // 2026-05-05: pizzerie/pub list cards regressed because the EN-only selector below
                // never matched the IT locale. Both variants kept for cross-locale support.
                { type: 'content', selector: 'span[role="img"][aria-label*="phone" i] + div', multi: true },
                { type: 'content', selector: 'span[role="img"][aria-label*="telefono" i] + div', multi: true },
                { type: 'content', selector: 'span.UsdlK', multi: true },

                // Text Patterns (Fallback). 2026-05-05: original observer patterns had a single
                // `\s*` slot for landlines, which could not span Italian-formatted subscriber
                // numbers like "050 123 4567" (two internal spaces). Maps formats restaurant
                // phones with internal spacing while public-admin phones often render compact —
                // explaining why pizzerie/pub cards regressed and amministrazioni did not. The
                // expanded set mirrors background/area-search.js which already worked in the
                // wild. Order: most specific (with country code) first, generic last.
                //
                // Italian mobile, +39 3xx (3-3-4 and 3-2-2-3 splits)
                { type: 'text_pattern', pattern: /(\+39\s*3\d{2}\s*\d{3}\s*\d{4})/, multi: true },
                { type: 'text_pattern', pattern: /(\+39\s*3\d{2}\s*\d{2}\s*\d{2}\s*\d{3})/, multi: true },
                // Italian landline, +39 0xx — MOST SPECIFIC FIRST.
                // 4+4 split (Rome/Milan: "+39 02 5830 6292")
                { type: 'text_pattern', pattern: /(\+39\s*0\d{1,4}\s*\d{4}\s*\d{4})/, multi: true },
                // 3+4 split ("+39 050 123 4567")
                { type: 'text_pattern', pattern: /(\+39\s*0\d{1,4}\s*\d{3}\s*\d{4})/, multi: true },
                // Single-segment subscriber ("+39 050 1234567")
                { type: 'text_pattern', pattern: /(\+39\s*0\d{1,4}\s*\d{4,8})/, multi: true },
                // Italian mobile without prefix
                { type: 'text_pattern', pattern: /\b(3\d{2}\s*\d{3}\s*\d{4})\b/, multi: true },
                { type: 'text_pattern', pattern: /\b(3\d{2}\s*\d{2}\s*\d{2}\s*\d{3})\b/, multi: true },
                // Italian landline without prefix.
                // 4+4 split ("02 5830 6292") — covers Rome/Milan formal format
                { type: 'text_pattern', pattern: /\b(0\d{1,4}\s*\d{4}\s*\d{4})\b/, multi: true },
                // 3+4 split ("050 123 4567") — restaurants/pizzerie typical
                { type: 'text_pattern', pattern: /\b(0\d{1,3}\s*\d{3}\s*\d{4})\b/, multi: true },
                // Single-segment subscriber ("06 12345678" / "050 1234567")
                { type: 'text_pattern', pattern: /\b(0\d{1,4}\s*\d{4,8})\b/, multi: true },
                // Compact form ("0501234567" / "0295039140")
                { type: 'text_pattern', pattern: /\b(0\d{2,4}\s*\d{5,8})\b/, multi: true },
                // Generic international fallback
                { type: 'text_pattern', pattern: /(\+\d{1,3}\s*\d{2,4}\s*\d{4,8})/, multi: true }
            ],
            address: [
                { type: 'attribute', value: 'aria-label', selector: 'button[data-item-id="address"]' },
                { type: 'content', selector: 'button[data-item-id="address"] .Io6YTe' },
                { type: 'text_pattern', pattern: /(?:Via|Viale|Corso|Piazza|Piazzale|Strada|Largo|Vicolo)[^·\n]+/i }
            ],
            category: [
                // 2026-05-05 audit: only button[jsaction*="category"] is reliable.
                // Other selectors (span.DkEaL, .fontBodyMedium > span > span) leak rating/price/UI
                // text. Plausibility validator below rejects rating-shaped strings (\d+[.,]\d+)
                // and currency strings ("·10-20 €") — see extractField below.
                { type: 'content', selector: 'button[jsaction*="category"]', validate: 'category' },
                { type: 'content', selector: 'span.DkEaL', validate: 'category' },
                { type: 'content', selector: '.fontBodyMedium > span > span', validate: 'category' },
                { type: 'content', selector: '.W4Efsd:last-child .W4Efsd:first-child span:first-child', validate: 'category' }
            ]
        };
    }

    /**
     * Extract all fields from a container.
     * R10: each field's extraction is tagged with the winning strategy in
     * a parallel `_strategies` object, so callers can record decay metrics.
     */
    extractAll(container) {
        const result = {};
        const meta = {};

        for (const [field, strategies] of Object.entries(this.strategies)) {
            const tagged = this.extractField(container, strategies, field);
            result[field] = tagged.value;
            meta[field] = tagged.strategy; // null if no strategy matched
        }

        // Non-enumerable so JSON.stringify(result) stays clean for storage,
        // but callers that want telemetry can access it via Object.getOwn...
        Object.defineProperty(result, '_strategies', {
            value: meta,
            enumerable: false,
            configurable: true,
            writable: true
        });

        return result;
    }

    /**
     * Extract a single field using defined strategies.
     *
     * R10: when a `field` label is supplied, hits/attempts are recorded in
     * the instance telemetry map. Backward-compatible signature: callers
     * passing only (container, strategies) get a plain value (legacy callers
     * unaffected); the new (container, strategies, field) signature returns
     * `{ value, strategy }` where strategy is the signature of the winning
     * strategy or null.
     *
     * The legacy two-arg form is preserved by detecting `field === undefined`
     * and returning the plain value; the new three-arg form is the one
     * `extractAll()` uses internally.
     */
    extractField(container, strategies, field) {
        const wantTelemetry = field !== undefined;
        for (const strategy of strategies) {
            const sig = wantTelemetry ? strategySignature(field, strategy) : null;

            // R16: skip if this strategy's circuit is open. We still record
            // an attempt so telemetry math (hitRate, classShare) remains
            // honest — a skipped strategy is one that we *would have* tried.
            if (sig && this._isCircuitOpen(sig)) {
                this._recordAttempt(sig);
                continue;
            }
            if (sig) this._recordAttempt(sig);
            try {
                const rawValue = this.executeStrategy(container, strategy);
                if (rawValue) {
                    // R17 (2026-05-05): plausibility validation per field.
                    // Catches stale selectors that match wrong DOM nodes (e.g. category
                    // selector grabbing rating "4,7" or price "·10-20 €").
                    const validated = this._validateFieldValue(rawValue, strategy.validate);
                    if (validated === null) {
                        if (sig) this._recordMiss(sig);
                        continue;   // try next strategy
                    }
                    const value = validated;

                    if (this.looksLikeUrl(value)) {
                        if (this.isExcludedDomain(value)) continue;
                        const final = value.startsWith('http') ? value : 'https://' + value;
                        if (sig) {
                            this._recordHit(sig);
                            this._closeCircuit(sig);
                        }
                        return wantTelemetry ? { value: final, strategy: sig } : final;
                    }
                    if (sig) {
                        this._recordHit(sig);
                        this._closeCircuit(sig);
                    }
                    return wantTelemetry ? { value, strategy: sig } : value;
                }
                // Strategy ran but returned no value — count as miss for breaker.
                if (sig) this._recordMiss(sig);
            } catch (e) {
                if (sig) this._recordMiss(sig);
            }
        }
        return wantTelemetry ? { value: null, strategy: null } : null;
    }

    /**
     * R17 (2026-05-05): plausibility validation for selector hits.
     *
     * Returns the (possibly transformed) value if it plausibly belongs to the
     * declared field, or null to skip the strategy.
     *
     * Validators:
     *  - 'rating'   → must parse to a float in [0, 5]; converts comma → dot
     *  - 'integer'  → strips parentheses/commas/dots, must parse to int >= 0
     *  - 'category' → rejects strings that look like rating (\d+[.,]\d+),
     *                 currency ranges (·10-20 €), CTA labels (Aggiungi/Add ...),
     *                 or empty boilerplate. Returns trimmed string otherwise.
     *
     * @param {*} value - raw extraction
     * @param {string|undefined} validator - one of 'rating'/'integer'/'category' or undefined
     * @returns {string|number|null} validated value, or null if rejected
     * @private
     */
    _validateFieldValue(value, validator) {
        if (!validator) return value;
        if (Array.isArray(value)) {
            // multi:true fields — validate each, drop nulls
            const filtered = value
                .map(v => this._validateFieldValue(v, validator))
                .filter(v => v != null);
            return filtered.length > 0 ? filtered : null;
        }
        const s = String(value).trim();
        if (!s) return null;

        switch (validator) {
            case 'rating': {
                // Accept "4,7" or "4.7" — normalize to "4.7"
                const m = s.match(/^(\d+)(?:[.,](\d+))?$/);
                if (!m) return null;
                const n = parseFloat(m[1] + (m[2] ? '.' + m[2] : ''));
                if (!isFinite(n) || n < 0 || n > 5) return null;
                return n.toFixed(1);
            }
            case 'integer': {
                // Strip parens/commas/dots used as thousands separators ("1.537", "(165)")
                const cleaned = s.replace(/[()\s.,]/g, '');
                if (!/^\d+$/.test(cleaned)) return null;
                const n = parseInt(cleaned, 10);
                if (!isFinite(n) || n < 0) return null;
                return String(n);
            }
            case 'category': {
                // Reject rating-shaped values
                if (/^\d+[.,]\d+$/.test(s)) return null;
                // Reject currency / price ranges with euro sign or hyphen
                if (/[€$£]/.test(s)) return null;
                if (/^[·•]?\s*\d+\s*[-–]\s*\d+/.test(s)) return null;
                // Reject CTAs / Maps action chrome
                const ctaTokens = /^(aggiungi|add|claim|reclama|suggerisci|edit|modifica|condividi|share|salva|save|indicazioni|directions)\b/i;
                if (ctaTokens.test(s)) return null;
                // Reject obviously-too-long blobs (categories are usually <60 chars)
                if (s.length > 80) return null;
                return s;
            }
            default:
                return value;
        }
    }

    /**
     * R16: inspect circuit state for a strategy signature.
     * @private
     */
    _isCircuitOpen(signature) {
        if (!this._breakerEnabled) return false;
        const state = this._circuitState.get(signature);
        if (!state) return false;
        if (state.openSkipsLeft > 0) {
            state.openSkipsLeft--;
            return true;
        }
        return false;
    }

    /**
     * R16: record a strategy miss; open the breaker if threshold reached.
     * @private
     */
    _recordMiss(signature) {
        let state = this._circuitState.get(signature);
        if (!state) {
            state = { consecutiveMisses: 0, openSkipsLeft: 0 };
            this._circuitState.set(signature, state);
        }
        state.consecutiveMisses++;
        if (state.consecutiveMisses >= this._breakerThreshold && state.openSkipsLeft === 0) {
            state.openSkipsLeft = this._breakerSkipCount;
        }
    }

    /**
     * R16: any successful hit fully closes the breaker.
     * @private
     */
    _closeCircuit(signature) {
        const state = this._circuitState.get(signature);
        if (state) {
            state.consecutiveMisses = 0;
            state.openSkipsLeft = 0;
        }
    }

    /**
     * R16: snapshot of breaker state (test seam + ops introspection).
     * @returns {Array<{signature, consecutiveMisses, openSkipsLeft}>}
     */
    getCircuitState() {
        const out = [];
        for (const [signature, state] of this._circuitState.entries()) {
            out.push({
                signature,
                consecutiveMisses: state.consecutiveMisses,
                openSkipsLeft: state.openSkipsLeft,
                isOpen: state.openSkipsLeft > 0
            });
        }
        return out;
    }

    /**
     * R16: clear circuit state (for tests + manual recovery).
     */
    resetCircuits() {
        this._circuitState.clear();
    }

    /**
     * R10: record that a strategy was tried (hit or not).
     * @private
     */
    _recordAttempt(signature) {
        let entry = this._telemetry.get(signature);
        if (!entry) {
            entry = { hits: 0, attempts: 0, lastHitAt: null };
            this._telemetry.set(signature, entry);
        }
        entry.attempts++;
    }

    /**
     * R10: record that a strategy succeeded.
     * @private
     */
    _recordHit(signature) {
        const entry = this._telemetry.get(signature);
        if (entry) {
            entry.hits++;
            entry.lastHitAt = Date.now();
        }
    }

    /**
     * R10: snapshot of per-strategy hit counts. Caller may forward to
     * Statistics for cross-extraction aggregation.
     *
     * @returns {Array<{signature, hits, attempts, hitRate, lastHitAt}>}
     */
    getTelemetry() {
        const out = [];
        for (const [signature, entry] of this._telemetry.entries()) {
            out.push({
                signature,
                hits: entry.hits,
                attempts: entry.attempts,
                hitRate: entry.attempts > 0 ? entry.hits / entry.attempts : 0,
                lastHitAt: entry.lastHitAt
            });
        }
        return out;
    }

    /**
     * R10: aggregate telemetry as { field → { strategy_type → { hits, attempts } } }
     * for a quick per-field decay view. `class` strategies (the brittle ones)
     * are flagged separately so dashboards can highlight when they dominate.
     *
     * @returns {Object} { byField: {...}, classDominance: {...} }
     */
    getTelemetryDigest() {
        const byField = {};
        const classDominance = {};
        for (const [signature, entry] of this._telemetry.entries()) {
            const [field, rest] = signature.split('|');
            // Mirror the Statistics-side rule: brittle = has class, no semantic anchor.
            const isSelector = /^selector:/.test(rest || '');
            const sel = isSelector ? rest.slice('selector:'.length) : '';
            const isBrittleClass = isSelector
                && /\.[A-Za-z0-9_-]+/.test(sel)
                && !/\[(?:aria-|role|data-)/i.test(sel);
            if (!byField[field]) byField[field] = {};
            byField[field][rest] = { hits: entry.hits, attempts: entry.attempts };
            if (isBrittleClass && entry.hits > 0) {
                classDominance[field] = (classDominance[field] || 0) + entry.hits;
            }
        }
        return { byField, classDominance };
    }

    /**
     * R10: clear telemetry counters. Test seam.
     */
    resetTelemetry() {
        this._telemetry.clear();
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * R-DETAIL (2026-05-05): CSV-only deep-extraction from Google Maps detail panel
     * ─────────────────────────────────────────────────────────────────────────────
     * Extracts six lead-qualification fields that are ONLY present in the
     * detail panel (`[role="main"][aria-label="<place name>"]`), NEVER in the
     * search-result list cards. These fields are wired to CSV export only —
     * they are NOT rendered in the sidepanel UI.
     *
     *   1. placeId            — derived from URL data param `1s<HEX>:<HEX>`
     *   2. description        — short business summary (Italian/English)
     *   3. claimStatus        — 'claimed' | 'unclaimed' | 'unknown'
     *   4. lastUpdatedByOwner — relative time string ("6 giorni fa") or null
     *   5. reviewThemes       — array of {theme, count} from review filter chips
     *   6. reviewDistribution — object {5,4,3,2,1} → review count per star
     *
     * Each strategy is tried in priority order; first plausible match wins.
     * Validation rules below mirror the live audit on 2026-05-05 against
     * Antica Pizzeria Fiorentina + Pizzeria Sapò Milano (it_IT locale).
     *
     * Additionally extracts phone (since 2026-05-05): the LIST CARD for
     * Italian restaurants/pizzerie/pub does not surface a phone number in its
     * inner text — Maps requires opening the detail panel where the canonical
     * `button[data-item-id^="phone"]` lives. We extract it here and let the
     * SW-side enrichment merge it back into the existing list-scraped record.
     * Telemetry from `opportuni-poc/scripts/maps_audit/audit-report.json`
     * confirmed 3/3 hits across the audit sample for the chosen selectors.
     *
     * @param {Element} container - detail-panel root, typically `[role="main"]`
     * @param {string} [pageUrl] - current page URL (for placeId extraction);
     *                             defaults to `globalThis.location?.href`.
     * @returns {{
     *   placeId: string|null,
     *   description: string|null,
     *   claimStatus: 'claimed'|'unclaimed'|'unknown',
     *   lastUpdatedByOwner: string|null,
     *   reviewThemes: Array<{theme: string, count: number}>,
     *   reviewDistribution: {5:number,4:number,3:number,2:number,1:number}|null,
     *   phone: string|null
     * }}
     */
    extractDetailFields(container, pageUrl) {
        const result = {
            placeId: null,
            description: null,
            claimStatus: 'unknown',
            lastUpdatedByOwner: null,
            reviewThemes: [],
            reviewDistribution: null,
            phone: null
        };

        if (!container) return result;

        // ─── 1. placeId (from URL) ────────────────────────────────────────────
        // Maps URL data param: `!1s0x<HEX>:0x<HEX>` is the canonical place CID.
        // Stable since 2018; survives URL re-canonicalization.
        const url = pageUrl || (typeof globalThis !== 'undefined' && globalThis.location?.href) || '';
        try {
            const cidMatch = url.match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/i);
            if (cidMatch) {
                result.placeId = cidMatch[1];
            } else {
                // Fallback: some URLs use `data=...` differently. Try `cid=` param.
                const cidParam = url.match(/[?&]cid=(\d+)/);
                if (cidParam) result.placeId = cidParam[1];
            }
        } catch { /* ignore */ }

        // ─── 2. description ───────────────────────────────────────────────────
        // The description sits inside `region[aria-label^="Informazioni su"]`
        // as a button WITHOUT data-item-id, WITHOUT aria-expanded, and whose
        // surface text is not a structured field.
        //
        // Live audit (2026-05-05) caveats baked in here:
        //  (a) Maps now ships TWO regions sharing the same aria-label —
        //      one for the description, one for the address/hours/phone
        //      structured-info block. We can't pick "first region" blindly.
        //  (b) The description button often LACKS an aria-label of its own
        //      (the a11y tree synthesizes it from inner text + service
        //      flags). We must fall back to button.textContent and strip
        //      the trailing "· Consumazione sul posto · Asporto · …" flags.
        //  (c) Inside the description button, decorative `<div aria-label="…">`
        //      flags ("Prevede la consumazione…", "Offre il servizio…") are
        //      siblings of the prose. They survive textContent — we strip
        //      them via `_cleanDescription` tail patterns AND a bullet (·) cut.
        try {
            const descRegions = container.querySelectorAll(
                'region[aria-label^="Informazioni"], [role="region"][aria-label^="Informazioni"]'
            );
            // Reject prefixes that mark structured-info buttons rather than prose:
            //   - field labels: Indirizzo:/Telefono:/Sito web:/Plus Code:/...
            //   - actions: Copia/Apri/Suggerisci/Aggiungi/...
            //   - weekday hour buttons (appear when Orari is expanded), IT + EN
            // Italian weekdays use a grave-accented "ì" (U+00EC); we accept any
            // of the i-variants and use a lookahead instead of `\b` because
            // JS regex word-boundary doesn't treat accented chars as word chars.
            const structuredPrefix = /^(?:Indirizzo|Telefono|Sito web|Orari|Plus Code|Copia|Apri|Suggerisci|Aggiungi|Ulteriori|Sei il proprietario|Address|Phone|Website|Hours|More information|Lunedi|Lunedì|Lunedí|Martedi|Martedì|Martedí|Mercoledi|Mercoledì|Mercoledí|Giovedi|Giovedì|Giovedí|Venerdi|Venerdì|Venerdí|Sabato|Domenica|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:[,\s:]|$)/i;
            // Live audit (2026-05-05): the description, when present, is ALWAYS
            // in the FIRST `region[aria-label^="Informazioni"]`. Later regions
            // host structured info (address/hours/phone/website/plus code) and
            // their generic-info CTAs ("Ulteriori informazioni sui plus code")
            // can falsely pass content filters. Restricting to the first region
            // is the most reliable defense and matches Maps' DOM stability.
            const firstRegion = descRegions[0];
            if (firstRegion) {
                for (const btn of firstRegion.querySelectorAll('button')) {
                    if (btn.hasAttribute && btn.hasAttribute('data-item-id')) continue;
                    if (btn.hasAttribute && btn.hasAttribute('aria-expanded')) continue;
                    const aria = (btn.getAttribute && btn.getAttribute('aria-label')) || '';
                    const text = (btn.textContent || '').trim();
                    const raw = aria || text;
                    if (!raw) continue;
                    if (structuredPrefix.test(raw.trim())) continue;
                    const cleaned = this._cleanDescription(raw);
                    if (cleaned && cleaned.length >= 12) {
                        result.description = cleaned;
                        break;
                    }
                }
            }
        } catch { /* ignore */ }

        // ─── 3. claimStatus ───────────────────────────────────────────────────
        // Heuristic: an unclaimed listing exposes "Aggiungi info mancanti" /
        // "Sei il proprietario di questa attività?" / "Rivendica" CTAs.
        // A claimed listing usually shows "Aggiornato da questa attività…"
        // and offers no Rivendica CTA.
        //
        // Important: many of these signals live in `aria-label` attributes
        // (icon-only buttons, image-with-label histogram bars). textContent
        // alone misses them. We concatenate both surfaces before scanning.
        try {
            const corpus = this._claimSignalCorpus(container);
            const unclaimedSignals = /(rivendica|sei il proprietario|claim this business)/i;
            const ownerActiveSignal = /aggiornato da questa attivit[àa]|updated by this business/i;
            if (unclaimedSignals.test(corpus)) {
                result.claimStatus = 'unclaimed';
            } else if (ownerActiveSignal.test(corpus)) {
                result.claimStatus = 'claimed';
            } else {
                // Soft signal: "Aggiungi info mancanti" alone is ambiguous (it
                // appears on both claimed-but-incomplete and unclaimed).
                // Default to 'unknown' rather than guessing wrong.
                result.claimStatus = 'unknown';
            }
        } catch { /* ignore */ }

        // ─── 4. lastUpdatedByOwner ────────────────────────────────────────────
        // Live: <button aria-label="Orari … Aggiornato da questa attività 6 giorni fa">
        // Pattern handles: "6 giorni fa", "una settimana fa", "2 mesi fa", "un anno fa".
        try {
            const buttons = container.querySelectorAll('[aria-label]');
            for (const el of buttons) {
                const aria = el.getAttribute('aria-label') || '';
                if (!/aggiornato da questa attivit[àa]/i.test(aria) && !/updated by this business/i.test(aria)) continue;
                const m = aria.match(
                    /aggiornato da questa attivit[àa]\s+(\d+\s+(?:minuti?|ore?|giorni?|settimane?|mesi?|anni?)\s+fa|un[ao]?\s+(?:minuto|ora|giorno|settimana|mese|anno)\s+fa)/i
                );
                if (m) {
                    result.lastUpdatedByOwner = m[1].trim();
                    break;
                }
                // English fallback: "Updated by this business 6 days ago"
                const me = aria.match(/updated by this business\s+(\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago|an?\s+(?:minute|hour|day|week|month|year)\s+ago)/i);
                if (me) {
                    result.lastUpdatedByOwner = me[1].trim();
                    break;
                }
            }
        } catch { /* ignore */ }

        // ─── 5. reviewThemes ──────────────────────────────────────────────────
        // Live: radio[aria-label="pizza al trancio, citato in 187 recensioni"]
        // Capped at 50 themes (defensive — Maps usually shows ≤10).
        try {
            const themeNodes = container.querySelectorAll(
                '[role="radio"][aria-label*="citato in"], [role="radio"][aria-label*="mentioned in"]'
            );
            const themes = [];
            for (const el of themeNodes) {
                if (themes.length >= 50) break;
                const aria = el.getAttribute('aria-label') || '';
                // Italian: "<theme>, citato in <N> recensioni"
                let m = aria.match(/^(.+?),\s*citato in\s+(\d[\d.,]*)\s+recension[ie]/i);
                // English: "<theme>, mentioned in <N> reviews"
                if (!m) m = aria.match(/^(.+?),\s*mentioned in\s+(\d[\d.,]*)\s+reviews?/i);
                if (m) {
                    const theme = m[1].trim();
                    const count = parseInt(String(m[2]).replace(/[.,]/g, ''), 10);
                    if (theme && Number.isFinite(count) && count >= 0) {
                        themes.push({ theme, count });
                    }
                }
            }
            result.reviewThemes = themes;
        } catch { /* ignore */ }

        // ─── 6. reviewDistribution ────────────────────────────────────────────
        // Live: image[aria-label="5 stelle,953 recensioni"] (5/4/3/2/1).
        // The histogram appears in the "Riepilogo recensione" section.
        try {
            const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
            let foundAny = false;
            const histNodes = container.querySelectorAll(
                '[role="img"][aria-label]'
            );
            for (const el of histNodes) {
                const aria = el.getAttribute('aria-label') || '';
                // Italian: "5 stelle,953 recensioni"  | English: "5 stars, 953 reviews"
                const m = aria.match(/^([1-5])\s*(?:stelle|stars?),\s*(\d[\d.,]*)\s*(?:recension[ie]|reviews?)/i);
                if (m) {
                    const star = parseInt(m[1], 10);
                    const count = parseInt(String(m[2]).replace(/[.,]/g, ''), 10);
                    if (star >= 1 && star <= 5 && Number.isFinite(count) && count >= 0) {
                        // Take the FIRST occurrence per star bucket (defends
                        // against "Ricerche correlate" leak — those don't
                        // expose per-star histograms).
                        if (dist[star] === 0) {
                            dist[star] = count;
                            foundAny = true;
                        }
                    }
                }
            }
            if (foundAny) result.reviewDistribution = dist;
        } catch { /* ignore */ }

        // ─── 7. phone (from detail panel — back-fill for restaurants) ────────
        // Audit (2026-05-05) confirms `button[data-item-id^="phone"]` hit 3/3
        // pizzeria samples. Tried in order:
        //   1. href tel:NNN... — canonical, never localized
        //   2. aria-label "Telefono: 02 5830 6292" — IT locale
        //   3. .Io6YTe text content — visible label
        // We deliberately keep extraction localized to this method (rather than
        // re-running this.extractField) so the detail-panel phone signal stays
        // independent of the list-card strategy chain and circuit-breaker.
        try {
            const phoneBtns = container.querySelectorAll('button[data-item-id^="phone"]');
            for (const btn of phoneBtns) {
                let raw = '';
                // (a) href tel:
                const tel = btn.getAttribute && btn.getAttribute('href');
                if (tel && /^tel:/i.test(tel)) {
                    raw = tel.replace(/^tel:/i, '').trim();
                }
                // (b) aria-label  "(?:Call|Chiama|Telefono)\s*:?\s*<number>"
                if (!raw) {
                    const aria = btn.getAttribute && btn.getAttribute('aria-label');
                    if (aria) {
                        const m = aria.match(/(?:call|chiama|telefono)\s*:?\s*(.+)/i);
                        if (m && m[1]) raw = m[1].trim();
                    }
                }
                // (c) .Io6YTe surface text
                if (!raw) {
                    const surface = btn.querySelector('.Io6YTe');
                    if (surface) raw = (surface.textContent || '').trim();
                }
                if (raw) {
                    // Validate: must contain at least 9 digits (matches loosened
                    // isValidPhone bound for short Italian landlines like Rome 06+7).
                    const digits = raw.replace(/\D/g, '');
                    if (digits.length >= 9 && digits.length <= 15) {
                        result.phone = raw;
                        break;
                    }
                }
            }
        } catch { /* ignore */ }

        return result;
    }

    /**
     * R-DETAIL helper: build a corpus from `container.textContent` plus all
     * descendant `aria-label` attributes. Maps places signals such as
     * "Rivendica" or "Aggiornato da questa attività" inside aria-labels of
     * icon-only buttons; textContent alone would miss them.
     *
     * Cap at 16k chars to avoid pathological detail panels. Scan order is
     * stable (DOM order), which keeps results deterministic across calls.
     * @private
     */
    _claimSignalCorpus(container) {
        if (!container) return '';
        const parts = [];
        const text = container.textContent || '';
        if (text) parts.push(text);
        try {
            const labeled = container.querySelectorAll('[aria-label]');
            for (const el of labeled) {
                const v = el.getAttribute('aria-label');
                if (v) parts.push(v);
            }
        } catch { /* ignore */ }
        let corpus = parts.join('\n');
        if (corpus.length > 16000) corpus = corpus.slice(0, 16000);
        return corpus;
    }

    /**
     * Helper: clean description aria-label by stripping trailing service
     * boilerplate ("Prevede la consumazione sul posto Offre il servizio di
     * asporto Effettua consegne a domicilio"). Keeps the first sentence/body.
     * @private
     */
    _cleanDescription(raw) {
        if (!raw || typeof raw !== 'string') return null;
        let s = raw.trim();
        if (!s) return null;

        // ─── Strip Material-Symbols icon glyphs ─────────────────────────────
        // Maps renders inline icons via Material Symbols / private-use Unicode
        // (e.g. U+E5CA before "Consumazione sul posto"). textContent picks
        // those up as garbage codepoints. We strip the entire private-use
        // areas (BMP: U+E000–U+F8FF) plus a few well-known supplementary
        // private-use glyphs that survived. Result: clean Latin prose.
        s = s.replace(/[\uE000-\uF8FF]/g, '').replace(/\s{2,}/g, ' ').trim();

        // Strip well-known IT/EN service-flag tails (aria-label form)
        const tailPatterns = [
            /\s*Prevede la consumazione[\s\S]*$/i,
            /\s*Offre il servizio[\s\S]*$/i,
            /\s*Effettua consegne[\s\S]*$/i,
            /\s*Dine-in[\s\S]*$/i,
            /\s*Takeout[\s\S]*$/i,
            /\s*Delivery[\s\S]*$/i
        ];
        for (const p of tailPatterns) {
            s = s.replace(p, '').trim();
        }
        // textContent form: "<prose>. · Consumazione sul posto · Asporto · …"
        // Cut at the first standalone bullet that introduces a service flag.
        // Heuristic: a bullet followed (with optional whitespace) by a service
        // keyword (Consumazione/Asporto/Consegna/Dine-in/Takeout/Delivery).
        const bulletCut = s.match(/^([\s\S]*?)\s*[·•]\s*(?:Consumazione|Asporto|Consegna|Dine-in|Takeout|Delivery|Wi-Fi|Servizio)\b/i);
        if (bulletCut) {
            s = bulletCut[1].trim();
        }
        // ─── Reject "service-flag chips only" placeholders ─────────────────
        // Some places (e.g. Pizzeria Sapò Milano on 2026-05-05) have NO
        // narrative description, only a chip row "· Consumazione sul posto
        // · Asporto". After bullet-cut these collapse to empty / very short
        // strings — but if cleanup still leaves a flag-shaped fragment we
        // reject it explicitly so a caller's `length >= 12` filter can't be
        // tricked by a leftover keyword (e.g. "Consumazione sul posto").
        if (s.length === 0) return null;
        if (/^[·•]?\s*(?:Consumazione|Asporto|Consegna|Dine-in|Takeout|Delivery|Wi-Fi|Servizio)\b/i.test(s)) {
            return null;
        }
        // Final cap (descriptions are short prose)
        if (s.length > 400) s = s.slice(0, 397) + '…';
        return s || null;
    }

    /**
     * Execute a specific strategy
     */
    executeStrategy(container, strategy) {
        if (strategy.type === 'attribute') {
            return this.extractAttribute(container, strategy);
        } else if (strategy.type === 'selector') {
            return this.extractSelector(container, strategy);
        } else if (strategy.type === 'content') {
            return this.extractContent(container, strategy);
        } else if (strategy.type === 'text_pattern') {
            return this.extractTextPattern(container, strategy);
        }
        return null;
    }

    /**
     * Strategy: Attribute Extraction
     */
    extractAttribute(container, { value: attrName, selector, pattern, multi }) {
        if (multi && selector) {
            const elements = container.querySelectorAll(selector);
            const values = [];
            elements.forEach(el => {
                const val = this._extractAttrFromElement(el, attrName, pattern);
                if (val) values.push(val);
            });
            return values.length > 0 ? values : null;
        }

        let element = container;
        if (selector) {
            element = container.querySelector(selector);
        }

        return this._extractAttrFromElement(element, attrName, pattern);
    }

    _extractAttrFromElement(element, attrName, pattern) {
        if (!element) return null;
        const attrValue = element.getAttribute(attrName);
        if (!attrValue) return null;

        if (pattern) {
            const match = attrValue.match(pattern);
            return match ? (match[1] || match[0]) : null;
        }
        return attrValue.trim();
    }

    /**
     * Strategy: Selector Text Extraction
     */
    extractSelector(container, { value: selector, multi }) {
        if (multi) {
            const elements = container.querySelectorAll(selector);
            const values = Array.from(elements).map(el => el.textContent.trim()).filter(t => t);
            return values.length > 0 ? values : null;
        }

        const element = container.querySelector(selector);
        return element ? element.textContent.trim() : null;
    }

    /**
     * Strategy: Content Pattern Matching
     */
    extractContent(container, { pattern, selector, context, multi }) {
        if (multi && selector) {
            const elements = container.querySelectorAll(selector);
            const values = [];
            elements.forEach(el => {
                const text = el.textContent.trim();
                if (pattern) {
                    const match = text.match(pattern);
                    if (match) values.push(match[1] || match[0]);
                } else {
                    values.push(text);
                }
            });
            return values.length > 0 ? values : null;
        }

        let target = container;
        if (selector) {
            target = container.querySelector(selector);
        } else if (context) {
            const elements = container.querySelectorAll(context);
            for (const el of elements) {
                const text = el.textContent.trim();
                if (pattern.test(text)) {
                    const match = text.match(pattern);
                    return match ? (match[1] || match[0]) : text;
                }
            }
            return null;
        }

        if (!target) return null;

        const text = target.textContent.trim();
        if (pattern) {
            const match = text.match(pattern);
            return match ? (match[1] || match[0]) : null;
        }
        return text;
    }

    /**
     * Strategy: Text Pattern Matching (Scan entire container text)
     */
    extractTextPattern(container, { pattern, multi }) {
        const text = container.innerText || '';

        if (multi) {
            const matches = text.match(new RegExp(pattern, 'g'));
            return matches ? [...new Set(matches)] : null;
        }

        const match = text.match(pattern);
        return match ? (match[1] || match[0]) : null;
    }

    /**
     * Helper: Check if string looks like a URL/Domain
     */
    looksLikeUrl(str) {
        if (!str || typeof str !== 'string' || str.length < 4) return false;
        if (str.includes(' ')) return false;
        return str.includes('.') || str.startsWith('http');
    }

    /**
     * Helper: Check excluded domains
     */
    isExcludedDomain(domain) {
        const excluded = [
            'google.', 'goo.gl', 'maps.', 'googleapis.',
            'facebook.', 'fb.com', 'instagram.', 'twitter.', 'x.com',
            'youtube.', 'linkedin.', 'tiktok.', 'pinterest.',
            'booking.com', 'tripadvisor.', 'expedia.', 'hotels.com',
            'airbnb.', 'yelp.', 'paginegialle.', 'tuttocitta.',
            'apple.com', 'play.google', 'android.com'
        ];
        return excluded.some(ex => domain.toLowerCase().includes(ex));
    }
}

