/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Sanitization Utilities
 * Prevents XSS via DOM-extracted strings and prototype pollution via Object.assign
 *
 * Step 03-03: M1-SEC Content script injection safety hardening
 */

/**
 * Dangerous keys that enable prototype pollution when present
 * in objects merged via Object.assign or spread operator.
 */
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Sanitize a string value extracted from the DOM.
 * Strips HTML tags and control characters while preserving
 * legitimate business text (unicode, accents, punctuation).
 *
 * @param {string|any} value - Raw string from DOM extraction
 * @returns {string} Sanitized string safe for messaging
 */
export function sanitizeString(value) {
    if (value === null || value === undefined) {
        return '';
    }

    let str = String(value);

    // Strip HTML tags
    str = str.replace(/<[^>]*>/g, '');

    // Strip control characters (C0 control chars except tab, newline, carriage return)
    // \x00-\x08, \x0B, \x0C, \x0E-\x1F, \x7F
    str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    return str;
}

/**
 * Safely merge source object into target, stripping dangerous keys
 * that could cause prototype pollution (__proto__, constructor, prototype).
 * Deep merges nested objects recursively.
 *
 * Replacement for Object.assign when merging external/untrusted data.
 *
 * @param {Object} target - Target object to merge into
 * @param {Object} source - Source object (potentially untrusted)
 * @returns {Object} Target with safe properties merged
 */
export function safeMerge(target, source) {
    if (!source || typeof source !== 'object') {
        return target;
    }

    for (const key of Object.keys(source)) {
        if (DANGEROUS_KEYS.includes(key)) {
            continue;
        }

        const sourceValue = source[key];

        if (sourceValue !== null && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
            // Recursive merge for nested objects
            if (!target[key] || typeof target[key] !== 'object') {
                target[key] = {};
            }
            safeMerge(target[key], sourceValue);
        } else {
            target[key] = sourceValue;
        }
    }

    return target;
}

/**
 * Fill-holes merge for the business de-dup path. Returns a new object equal to
 * `existing` plus any fields `incoming` carries that `existing` is MISSING.
 * Never overwrites a populated value — so a later, leaner save can back-fill
 * holes (e.g. area-search radius stamp, late-arriving coordinates) without
 * clobbering the richer first-saved record.
 *
 * `changed` is false when nothing was added, letting the caller skip a
 * redundant DB write on the hot de-dup path (the same Maps card re-fires
 * `business_found` many times during a single scroll).
 *
 * "Empty" = undefined | null | '' (empty string). A non-null array/object is
 * treated as present (no deep merge — a populated field always wins).
 * Prototype-pollution keys are never copied.
 *
 * @param {Object} existing - current DB record (wins on every populated field)
 * @param {Object} incoming - newly-arrived record (donor for missing fields)
 * @param {string[]} [skipKeys] - extra keys never copied (e.g. saveBusiness-managed)
 * @returns {{ merged: Object, changed: boolean }}
 */
export function fillHolesMerge(existing, incoming, skipKeys = []) {
    const merged = { ...(existing || {}) };
    let changed = false;
    if (!incoming || typeof incoming !== 'object') {
        return { merged, changed };
    }
    const isEmpty = (v) => v === undefined || v === null || v === '';
    const skip = new Set([...DANGEROUS_KEYS, ...skipKeys]);
    for (const key of Object.keys(incoming)) {
        if (skip.has(key)) continue;
        const inVal = incoming[key];
        if (isEmpty(inVal)) continue;          // donor has nothing useful here
        if (!isEmpty(merged[key])) continue;   // recipient already populated → keep
        merged[key] = inVal;
        changed = true;
    }
    return { merged, changed };
}

// ─────────────────────────────────────────────────────────────────────────────
// R15 (TIER A): Italian VAT (Partita IVA) checksum validation.
//
// The pipeline already EXTRACTS partitaIva from website pages via regex
// (offscreen/parser.js → PARTITA_IVA_PATTERNS). What was missing was a
// CHECK-DIGIT validation: an 11-digit string can match the regex without
// being a valid VAT number. This function rejects malformed PIVAs before
// they enter the database, improving data quality with zero dependencies.
//
// Algorithm (Agenzia delle Entrate / DM 23/12/1976):
//   1. PIVA = 11 digits.
//   2. The first 7 digits identify the issuing province / sequence,
//      digits 8-10 identify the office, digit 11 is the check digit.
//   3. Check digit derivation:
//      - Sum the digits in odd positions (1,3,5,7,9) directly.
//      - For digits in even positions (2,4,6,8,10): double them; if the
//        result is >9, subtract 9 (or sum the digits of the result).
//      - Add both sums; check digit = (10 - sum % 10) % 10.
//   4. Reject all-zero PIVA ("00000000000") and all-same-digit patterns —
//      these pass the math but are administratively invalid sentinels.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip non-digit characters and (optional) leading "IT" country prefix.
 * Returns the canonical 11-digit form, or the original input if normalization
 * cannot produce 11 digits.
 *
 * @param {string|any} value
 * @returns {string} Normalized PIVA string (digits only) or empty string
 */
export function normalizePartitaIva(value) {
    if (value === null || value === undefined) return '';
    let s = String(value).trim().toUpperCase();
    // Drop the EU country prefix if present
    if (s.startsWith('IT')) s = s.slice(2).trim();
    // Keep only digits
    s = s.replace(/\D+/g, '');
    return s;
}

/**
 * Validate Italian Partita IVA via Luhn-style checksum.
 *
 * Returns true ONLY if:
 *   - normalized form is exactly 11 digits
 *   - not a sentinel (all zeros, all same digit)
 *   - the 11th digit equals the computed check digit
 *
 * @param {string|any} value - Raw input (with or without "IT" prefix, spaces, dots)
 * @returns {boolean}
 */
export function validatePartitaIva(value) {
    const piva = normalizePartitaIva(value);
    if (piva.length !== 11) return false;
    if (!/^\d{11}$/.test(piva)) return false;

    // Reject sentinel patterns: all zeros, all same digit
    if (/^(\d)\1{10}$/.test(piva)) return false;

    let sum = 0;
    for (let i = 0; i < 10; i++) {
        const d = piva.charCodeAt(i) - 48; // ASCII '0' = 48
        if (i % 2 === 0) {
            // Odd position (1-indexed) → add digit directly
            sum += d;
        } else {
            // Even position (1-indexed) → double, subtract 9 if >9
            const doubled = d * 2;
            sum += doubled > 9 ? doubled - 9 : doubled;
        }
    }
    const expected = (10 - (sum % 10)) % 10;
    const actual = piva.charCodeAt(10) - 48;
    return expected === actual;
}

/**
 * Sanitize and validate a Partita IVA in one call.
 *
 * Returns the canonical 11-digit form if valid, else null. Use this at
 * the data-ingest boundary (before db.saveBusiness) to keep invalid PIVAs
 * out of the database entirely.
 *
 * @param {string|any} value
 * @returns {string|null} 11-digit PIVA or null if invalid
 */
export function sanitizePartitaIva(value) {
    const piva = normalizePartitaIva(value);
    return validatePartitaIva(piva) ? piva : null;
}

/**
 * Sanitize a business data object extracted from the Google Maps DOM.
 * Applies sanitizeString to all string fields and strips dangerous keys.
 *
 * @param {Object} business - Raw business data from DOM extraction
 * @returns {Object} Sanitized business object safe for chrome.runtime.sendMessage
 */
export function sanitizeBusinessData(business) {
    if (!business || typeof business !== 'object') {
        return {};
    }

    const sanitized = {};

    for (const key of Object.keys(business)) {
        if (DANGEROUS_KEYS.includes(key)) {
            continue;
        }

        const value = business[key];

        if (typeof value === 'string') {
            sanitized[key] = sanitizeString(value);
        } else {
            sanitized[key] = value;
        }
    }

    // R15: validate Italian VAT at the ingest boundary. An invalid PIVA is
    // dropped (set to null) rather than thrown, because the surrounding
    // business record is still useful — only the PIVA column is wrong.
    // The original raw extraction is preserved on `partitaIvaRaw` so a future
    // pass (e.g., VIES active-check) can revisit the input.
    if (typeof sanitized.partitaIva === 'string' && sanitized.partitaIva.length > 0) {
        const validated = sanitizePartitaIva(sanitized.partitaIva);
        if (validated === null) {
            sanitized.partitaIvaRaw = sanitized.partitaIva;
            sanitized.partitaIva = null;
            sanitized.partitaIvaInvalid = true;
        } else {
            sanitized.partitaIva = validated;
            sanitized.partitaIvaInvalid = false;
        }
    }

    return sanitized;
}
