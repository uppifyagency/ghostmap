/**
 * R1 (TIER B): Browser version table.
 *
 * Source of truth for fingerprint generation. Refreshed by
 * `scripts/update-fingerprint-versions.mjs` against:
 *   - https://chromiumdash.appspot.com/fetch_releases?platform=Win64
 *   - https://product-details.mozilla.org/1.0/firefox_versions.json
 *   - Manual: Edge tracks Chromium; Safari tracks Apple stable
 *
 * Hand-edits between automated runs are fine — keep entries chronological
 * (newest at top within each browser block).
 *
 * lastUpdated is an ISO date string. Stale data (>120 days) is not a
 * security issue but increases fingerprint detectability; the auto-update
 * script flags it.
 */

export const BROWSER_VERSIONS = {
    lastUpdated: '2026-05-03',
    chrome: {
        // Most-recent stable major versions on each desktop OS.
        // We keep the last 4 majors so the pool retains realistic spread.
        majors: [136, 135, 134, 133],
        // Sec-CH-UA token shapes vary slightly by version. We encode the
        // pattern at generation time (see _buildChromeProfile).
    },
    firefox: {
        majors: [136, 135, 134, 128],   // 128 is current ESR
    },
    edge: {
        majors: [136, 135, 134, 133],
    },
    safari: {
        // Safari tracks WebKit/Version differently. We encode (major, minor).
        versions: [
            { major: 18, minor: 0, webkit: '618.1.15' },
            { major: 17, minor: 6, webkit: '605.1.15' },
            { major: 17, minor: 5, webkit: '605.1.15' }
        ]
    }
};

export default BROWSER_VERSIONS;
