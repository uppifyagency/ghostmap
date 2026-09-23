/**
 * Partita IVA extraction — SINGLE SOURCE OF TRUTH.
 *
 * Previously this regex set was triplicated (offscreen/parser.js,
 * background/index.js, background/TabScraperFallback.js) and drifted. It also
 * could NOT capture the very common Italian "composite label" footers where
 * extra text sits between the P.IVA label and the 11 digits:
 *
 *   "P.IVA/C.F. 01234567890"                          (azienda esempio)
 *   "Cod.Fisc./Part.IVA/R.I. di Modena 01234567890"   (azienda esempio)
 *   "P.IVA e C.F.: 01234567890"
 *
 * The strict patterns require the digits to follow the label with only spaces/
 * colons in between, so any "/C.F.", "/R.I. di Modena", " e C.F.:" defeats them.
 *
 * Empirical diagnosis (2026-05-29, docs/runtime-verification/diagnose-piva-misses.mjs)
 * on 57 real sites: 4% of misses were this regex gap; DB and CSV export were clean.
 *
 * Every extracted candidate is now validated with the Italian P.IVA checksum
 * (lib/sanitize.js validatePartitaIva — previously dead code, now wired in), so
 * the looser composite pattern cannot inject an unrelated 11-digit run, and no
 * invalid/garbage P.IVA reaches the database or the CSV. Verified safe: all 35
 * P.IVAs in the user's real exports pass the checksum (zero real data dropped).
 */
import { validatePartitaIva } from './sanitize.js';

// Strict, label-anchored patterns. The digits must immediately follow the label
// (only spaces/colons/optional "IT" between). Canonical union of the three former
// copies — at least as permissive as each. Tried first, in order.
//
// ReDoS hardening (2026-06-11, forensic #1): every [:\s] gap is BOUNDED to {0,20}.
// The old unbounded `[:\s]*(?:IT)?[:\s]*` pair was ambiguous (two adjacent star
// quantifiers over the same class) → quadratic backtracking on adversarial input:
// 'P.IVA' + 100k spaces stalled the service worker ~15.7s (measured), and the
// offscreen 15s timeout then failed over to parseHTMLDirect which re-ran the same
// pattern in the SW thread with NO timeout. Bounded gaps measure <1ms on the same
// input.
//
// NOTE on the effective bound (adversarial review 2026-06-11): the two bounded
// gaps around (?:IT)? COMBINE, so the de-facto strict gap is ≤40 chars. Callers
// pass raw textContent where label and digits can sit in sibling elements with
// deep indentation (>40 chars of \n+spaces), and the composite fallback below
// deliberately does NOT cross newlines — so extractPartitaIva() first collapses
// runs of HORIZONTAL whitespace to a single space (newlines preserved, keeping
// the composite's line-boundary semantics intact). After collapsing, any
// legitimate gap fits comfortably in the bound. Locked by
// tests/run-piva-redos-timing-node.mjs — keep every gap quantifier bounded.
const STRICT_PATTERNS = [
    /(?:P\.?\s*IVA|Partita\s*IVA|VAT(?:\s*(?:IT|Number))?)[:\s]{0,20}(?:IT)?[:\s]{0,20}(\d{11})\b/gi,
    /\bIT[:\s]{0,20}(\d{11})\b/g,
    /(?:Numero\s*IVA|N\.?\s*IVA)[:\s]{0,20}(\d{11})\b/gi,
    /\bPI[:\s]{1,20}(\d{11})\b/gi,
];

// Composite-label fallback: a P.IVA/C.F. label followed by up to 30 non-digit,
// non-newline characters (absorbs "/C.F.", "/R.I. di Modena", " e C.F.: ") then
// the 11 digits. Lazy + bounded + digit-free gap → grabs the nearest number and
// cannot skip across an unrelated number. Negated char class, no nesting → no
// catastrophic backtracking (ReDoS-safe). Only consulted via the checksum gate.
const COMPOSITE_PATTERN =
    /(?:P\.?\s*IVA|Part(?:ita)?\.?\s*IVA|Cod(?:ice)?\.?\s*Fisc(?:ale)?|C\.?\s*F\.?)[^\d\r\n]{0,30}?(\d{11})\b/gi;

const ALL_PATTERNS = [...STRICT_PATTERNS, COMPOSITE_PATTERN];

/**
 * Extract an Italian Partita IVA (11 digits) from free text, surfacing BOTH the
 * checksum-valid result AND — when validation fails — the rejected raw candidate.
 *
 * Scans strict label-anchored patterns first, then the composite-label fallback,
 * returning the FIRST checksum-VALID 11-digit match. If none pass the checksum,
 * `partitaIva` is null and `partitaIvaRaw` carries the FIRST invalid candidate
 * seen in that same precedence order.
 *
 * BUG-8 #8.1 (2026-07-07): previously the rejected candidate was discarded inside
 * this function, so a real P.IVA carrying an OCR/typo (checksum false negative)
 * vanished with no trace — the "Partita IVA (Raw/Unvalidated)" export column
 * (col 54) was structurally always empty because nothing on a production path
 * ever populated `partitaIvaRaw` (its only writer, lib/sanitize.js, sits on the
 * observer path, which does not extract P.IVA). Surfacing the raw here is the
 * point of first knowledge, so it can be propagated (buildBusinessUpdates →
 * merge → DB → export) and the user finally sees the number to fix by hand.
 *
 * Precedence note: STRICT patterns run before the looser COMPOSITE fallback, so a
 * candidate anchored to an explicit "P.IVA"/"VAT"/"IT" label is preferred as the
 * raw over a composite match (which may pick an 11-digit run after a bare "C.F."
 * label). This keeps col 54 as low-noise as the confidence ordering allows; the
 * value is still explicitly labeled "Unvalidated" and escaped at export time.
 *
 * @param {string|any} text
 * @returns {{partitaIva: string|null, partitaIvaRaw: string|null}}
 */
export function extractPartitaIvaWithRaw(text) {
    if (!text || typeof text !== 'string') return { partitaIva: null, partitaIvaRaw: null };
    // Collapse horizontal whitespace runs (spaces/tabs — NOT newlines, the
    // composite pattern relies on line boundaries). Linear-time pre-pass; see
    // the effective-bound note above STRICT_PATTERNS.
    text = text.replace(/[^\S\r\n]{2,}/g, ' ');
    let firstInvalid = null;
    for (const pattern of ALL_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text)) !== null) {
            const candidate = m[1];
            if (validatePartitaIva(candidate)) return { partitaIva: candidate, partitaIvaRaw: null };
            // Remember the first rejected candidate (strict-first ordering makes
            // the most label-confident one win) so BUG-8 col 54 is never empty
            // when SOMETHING that looks like a P.IVA was present but failed.
            if (firstInvalid === null) firstInvalid = candidate;
            // Defensive: a zero-width match would loop forever. All patterns
            // capture \d{11} (non-zero-width), but guard anyway.
            if (pattern.lastIndex <= m.index) pattern.lastIndex = m.index + 1;
        }
    }
    return { partitaIva: null, partitaIvaRaw: firstInvalid };
}

/**
 * Extract an Italian Partita IVA (11 digits) from free text (page textContent,
 * meta, or raw HTML — the caller decides what to pass).
 *
 * Returns the first checksum-VALID 11-digit match, trying strict label-anchored
 * patterns first, then the composite-label fallback. Returns null if none match
 * or none pass the checksum (so a wrong number is never delivered).
 *
 * Thin wrapper over extractPartitaIvaWithRaw() — behaviour is byte-identical to
 * the pre-BUG-8-#8.1 implementation. Callers that also want the rejected raw
 * candidate (for the export "Raw/Unvalidated" column) should call
 * extractPartitaIvaWithRaw() directly.
 *
 * @param {string|any} text
 * @returns {string|null} canonical 11-digit P.IVA, or null
 */
export function extractPartitaIva(text) {
    return extractPartitaIvaWithRaw(text).partitaIva;
}
