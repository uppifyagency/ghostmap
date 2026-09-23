/**
 * Ghost Map Pro - URL Normalization Utilities
 * AUDIT FIX #6: Normalize Google Maps URLs to prevent duplicates
 * MEDIUM FIX #8: Added website URL normalization
 */

import { logger } from './utils.js';

/**
 * Normalize Google Maps URL by extracting the place identifier
 * Ensures consistent format for database deduplication (MEDIUM FIX #8)
 * 
 * Examples:
 * - https://www.google.com/maps/place/.../@41.9028,12.4964,17z -> normalized
 * - https://google.com/maps/place/.../@41.9028,12.4964,15z -> same normalized
 * - http://www.google.com/maps/place/... -> same normalized
 * 
 * @param {string} url - Google Maps URL
 * @returns {string|null} - Normalized URL or null if invalid (MEDIUM FIX #8: now returns null on invalid)
 */
export function normalizeGoogleMapsUrl(url) {
    if (!url || typeof url !== 'string') {
        return null;
    }

    // IO7 FIX: Pass through synthetic import:// URLs unchanged
    // These are used for bulk URL imports and should not be normalized
    if (url.startsWith('import://')) {
        return url;
    }

    try {
        const urlObj = new URL(url);

        // Must be Google Maps place URL (MEDIUM FIX #8)
        if (!urlObj.pathname.includes('/maps/place/')) {
            return null;
        }

        // Extract the place identifier from the URL
        const placeMatch = url.match(/\/maps\/place\/([^\/\?#@]+)/);

        if (placeMatch) {
            // Extract the place name/ID (URL-encoded business name or place ID)
            const placeIdentifier = placeMatch[1];

            // BUG-URL-Idempotency-Cid (D.3 audit, 2026-05-09):
            // Check for the place ID in two equivalent forms — `!1s0xABC:0xDEF`
            // (Maps SERP/data-param shape) OR `?cid=0xABC:0xDEF` / `?cid=0xABC%3A0xDEF`
            // (the form THIS function emits as canonical output).
            //
            // Pre-fix the regex only matched `!1s`, so the SECOND call to
            // getCanonicalDbKey on an already-canonical URL would not find
            // the cid in the `cid=` query param, fall through to the
            // placeIdentifier-only fallback, and silently DROP the cid.
            // This produced lookup-vs-write key mismatch in
            // handleBusinessFound → saveBusiness pipeline (saveBusiness
            // re-canonicalizes via _normalizeGoogleMapsUrl, dropping cid).
            // Identical class to v9.8.1 BUG #4 (commit eb60ab4) silent
            // duplicate-detection failure.
            //
            // The %3A→: normalization on the captured group ensures step 3
            // (searchParams.delete percent-encode) produces the SAME canonical
            // string regardless of which form the input had.
            // Test: tests/run-h01-strip-on-question-node.mjs (idempotence section).
            //
            // LIB-10 BACKPORT + truncation hardening (BUG-2, 2026-05-26):
            // - `[0-9a-fA-Fx]+` → `[0-9a-fA-F]+` removes the literal `x` from
            //   the hex character class (identical to fix in opportuni-auth.js
            //   commit ad41f1e, never backported here).
            // - Riga 67 also missed the `0x` literal prefix in second group
            //   (asymmetric vs riga 68 and canonical `0xHEX:0xHEX` Maps form).
            // - Positive lookahead `(?=[!&/?#]|$)` requires the captured CID
            //   to be terminated by a canonical Maps URL delimiter or
            //   end-of-string. This rejects greedy-truncated matches like
            //   `0xdeadbeef:0xfooxbar` that would otherwise propagate a
            //   corrupt truncated CID `0xdeadbeef:0xf` into the IDB key.
            const dataMatch =
                url.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)(?=[!&/?#]|$)/) ||
                url.match(/[?&]cid=(0x[0-9a-fA-F]+(?::|%3A)0x[0-9a-fA-F]+)(?=[!&/?#]|$)/i);
            if (dataMatch) {
                // Normalize captured group: %3A → : (raw form). Step 3
                // (URL parse + searchParams.delete) will percent-encode
                // back to %3A on output, yielding the canonical byte sequence.
                const placeId = dataMatch[1].replace(/%3A/gi, ':');
                logger.debug(`[URL NORMALIZE] Extracted place ID: ${placeId}`);
                return `https://www.google.com/maps/place/${placeIdentifier}?cid=${placeId}`;
            }

            // Fallback: Use the place name/identifier
            // MEDIUM FIX #8: Decode and re-encode for consistency
            let normalizedIdentifier = placeIdentifier;
            try {
                normalizedIdentifier = encodeURIComponent(decodeURIComponent(placeIdentifier));
            } catch (e) {
                // Keep original if decode fails
            }

            logger.debug(`[URL NORMALIZE] Using place identifier: ${normalizedIdentifier}`);
            return `https://www.google.com/maps/place/${normalizedIdentifier}`;
        }

        // If no place pattern found but URL is valid Maps URL
        // Remove query params and hash, normalize
        urlObj.search = '';
        urlObj.hash = '';

        let normalizedPath = urlObj.pathname.replace(/\/+$/, '');
        const normalized = `https://www.google.com${normalizedPath}`;

        logger.debug(`[URL NORMALIZE] Fallback normalization: ${normalized}`);
        return normalized;

    } catch (error) {
        logger.warn(`[URL NORMALIZE] Failed to normalize URL: ${url}`, error.message);
        return null; // MEDIUM FIX #8: Return null instead of original URL
    }
}

/**
 * Normalize website URL for email scraping (MEDIUM FIX #8)
 * Removes tracking parameters and normalizes format
 * @param {string} url - Raw website URL
 * @returns {string|null} Normalized URL or null if invalid
 */
export function normalizeWebsiteUrl(url) {
    if (!url || typeof url !== 'string') return null;

    try {
        // Add protocol if missing
        let urlStr = url.trim();
        if (!urlStr.match(/^https?:\/\//i)) {
            urlStr = 'https://' + urlStr;
        }

        const urlObj = new URL(urlStr);

        // Remove common tracking parameters
        const trackingParams = [
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            'fbclid', 'gclid', 'ref', 'source', 'mc_cid', 'mc_eid',
            '_ga', '_gl', 'hsCtaTracking', 'hsa_'
        ];
        trackingParams.forEach(param => {
            urlObj.searchParams.delete(param);
            // Also delete params that start with these prefixes
            for (const [key] of urlObj.searchParams) {
                if (key.startsWith('utm_') || key.startsWith('hsa_')) {
                    urlObj.searchParams.delete(key);
                }
            }
        });

        // Remove hash
        urlObj.hash = '';

        // Normalize to lowercase hostname
        urlObj.hostname = urlObj.hostname.toLowerCase();

        // Remove trailing slash from pathname
        if (urlObj.pathname.endsWith('/') && urlObj.pathname.length > 1) {
            urlObj.pathname = urlObj.pathname.slice(0, -1);
        }

        return urlObj.toString();
    } catch (e) {
        logger.warn(`[URL NORMALIZE] Failed to normalize website URL: ${url}`, e.message);
        return null;
    }
}

/**
 * Check if two Google Maps URLs refer to the same business
 * @param {string} url1 - First URL
 * @param {string} url2 - Second URL
 * @returns {boolean} - True if same business
 */
export function isSameGoogleMapsPlace(url1, url2) {
    const normalized1 = normalizeGoogleMapsUrl(url1);
    const normalized2 = normalizeGoogleMapsUrl(url2);

    // Both must be valid (MEDIUM FIX #8)
    if (!normalized1 || !normalized2) return false;

    return normalized1 === normalized2;
}

/**
 * SINGLE SOURCE OF TRUTH for the IndexedDB primary key derived from a
 * Google Maps URL. Canonical pipeline (added v9.10, 2026-05-07):
 *
 *   1. `normalizeGoogleMapsUrl(url)` — extract place identifier, build
 *      `?cid=0xHEX:0xHEX` form (raw `:`).
 *   2. Force https + strip trailing slash.
 *   3. URL parse + `searchParams.delete(hl|authuser|biw|bih|dpr)`. The
 *      delete forces re-serialization through URLSearchParams which
 *      percent-encodes `:` → `%3A`. Even if none of the params are
 *      present, the call still triggers re-serialization.
 *
 * The 3-step combo was previously split across `normalizeGoogleMapsUrl`
 * + `db._normalizeGoogleMapsUrl`, with `handleBusinessEnrichment`
 * manually replicating both. Fatal v9.8.1 bug (commit eb60ab4): forgot
 * step 3 → DB key mismatch → 80+ enrichments silently dropped. This
 * helper collapses both into one call.
 *
 * NEVER returns null. Input that cannot be parsed degrades to a
 * basic-form fallback (force https + strip trailing slash) so callers
 * of `saveBusiness` / `getBusiness` always get a string key. The
 * `import://` synthetic protocol used by IO7 bulk import passes through
 * unchanged.
 *
 * Idempotent: calling twice produces the same string.
 *
 * @param {string} url - Raw Google Maps URL (or `import://...` synthetic)
 * @returns {string} - Canonical DB key. Empty input → returns input as-is
 *                     (caller's existing contract; they validate before
 *                     calling).
 */
export function getCanonicalDbKey(url) {
    if (!url || typeof url !== 'string') {
        return url;
    }

    // IO7 passthrough — synthetic bulk-import URL, must NOT be normalized.
    if (url.startsWith('import://')) {
        return url;
    }

    // Step 1: place-identifier extraction (raw `:` form). May return null
    // when the URL is not a /maps/place/ URL — in that case we fall back
    // to the basic-form transforms so saveBusiness still gets a string.
    const step1 = normalizeGoogleMapsUrl(url);
    const seed = step1 || url;

    try {
        // Step 2: force https + strip trailing slash.
        let s = String(seed).replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
        // Step 3: URL parse + searchParams.delete forces re-serialization
        // (percent-encodes `:` → `%3A` even if none of the params exist).
        //
        // ⚠️ DO NOT REFACTOR to encodeURIComponent or any "explicit" encoder
        // without a migration. This implicit behavior is the de-facto canonical
        // contract — thousands of existing IndexedDB rows are keyed by the
        // exact byte sequence URL.toString() produces here. Any encoding diff
        // (Unicode handling, fragment encoding, param ordering) silently
        // orphans existing data. Verified stable on Chrome 120-136 (audit 2026-05-07).
        // If a refactor becomes necessary, REQUIRED preconditions:
        //   (a) full key-migration script that reads old records and rewrites
        //       to the new key shape under a transaction;
        //   (b) regression corpus of ≥100 representative URLs pinning
        //       old==new output;
        //   (c) rollback path (keep old code behind a flag for ≥1 release).
        const u = new URL(s);
        u.searchParams.delete('hl');
        u.searchParams.delete('authuser');
        u.searchParams.delete('biw');
        u.searchParams.delete('bih');
        u.searchParams.delete('dpr');
        return u.toString();
    } catch (error) {
        // Degraded fallback — preserve legacy contract: never return null.
        logger.warn(`[URL NORMALIZE] getCanonicalDbKey degraded fallback for: ${url}`, error?.message);
        return String(seed).replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
    }
}

export default {
    normalizeGoogleMapsUrl,
    normalizeWebsiteUrl,
    isSameGoogleMapsPlace,
    getCanonicalDbKey
};
