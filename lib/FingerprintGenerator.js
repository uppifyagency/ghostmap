/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 * 
 * INSPIRED BY: Crawlee fingerprint-generator
 * https://docs.apify.com/academy/anti-scraping/mitigation/generating-fingerprints
 */

/**
 * Ghost Map Pro - Fingerprint Generator
 * Generates coherent browser fingerprints for anti-detection
 * 
 * Key principles from Crawlee:
 * - All headers must be internally consistent
 * - User-Agent must match Sec-CH-* headers
 * - Accept headers must match browser type
 * - Language/locale must be consistent
 */

import { logger } from './utils.js';
import { BROWSER_VERSIONS } from './data/browser-versions.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SL-007 FIX: BROWSER VERSION MAINTENANCE GUIDE
// ═══════════════════════════════════════════════════════════════════════════════
// VERSION: 3.0.0
// LAST UPDATED: 2026-03-29
// CURRENT VERSIONS: Chrome 132-134, Firefox 134, Edge 132, Safari 17.6
//
// HOW TO UPDATE BROWSER VERSIONS:
// 1. Check current stable Chrome version: https://chromestatus.com/features/schedule
// 2. Update FINGERPRINT_PROFILES with new versions (keep last 4-5 major versions)
// 3. Ensure Sec-CH-UA headers match the Chrome version number exactly
// 4. Test fingerprint.validate() passes for all new profiles
// 5. Update VERSION and LAST UPDATED above
//
// RECOMMENDED UPDATE FREQUENCY: Every 2-3 months or when Chrome releases major version
//
// NOTE: These versions affect anti-detection capability. Outdated versions may
// be flagged as suspicious by anti-bot systems. Chrome 132-134 covers ~95% of
// real Chrome users as of March 2026.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Browser fingerprint profiles
 * Each profile contains all details needed to impersonate a real browser
 * CRITICAL: Headers must be internally consistent to avoid detection
 */
const FINGERPRINT_PROFILES = [
    // ─────────────────────────────────────────────────────────────────────
    // Chrome on Windows 10 (v134) - Latest
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'chrome_win10_134',
        browser: 'Chrome',
        browserVersion: '134.0.0.0',
        os: 'Windows',
        osVersion: '10',
        platform: 'Win32',
        mobile: false,
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'max-age=0',
            'Sec-CH-UA': '"Not-A.Brand";v="99", "Chromium";v="134", "Google Chrome";v="134"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    },
    // ─────────────────────────────────────────────────────────────────────
    // Chrome on Windows 11 (v134) - Latest
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'chrome_win11_134',
        browser: 'Chrome',
        browserVersion: '134.0.0.0',
        os: 'Windows',
        osVersion: '11',
        platform: 'Win32',
        mobile: false,
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'max-age=0',
            'Sec-CH-UA': '"Not-A.Brand";v="99", "Chromium";v="134", "Google Chrome";v="134"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    },
    // ─────────────────────────────────────────────────────────────────────
    // Chrome on Windows 10 (v132) - Common
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'chrome_win10_132',
        browser: 'Chrome',
        browserVersion: '132.0.0.0',
        os: 'Windows',
        osVersion: '10',
        platform: 'Win32',
        mobile: false,
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'max-age=0',
            'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    },
    // ─────────────────────────────────────────────────────────────────────
    // Chrome on Windows 11 (v133)
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'chrome_win11_133',
        browser: 'Chrome',
        browserVersion: '133.0.0.0',
        os: 'Windows',
        osVersion: '11',
        platform: 'Win32',
        mobile: false,
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'max-age=0',
            'Sec-CH-UA': '"Not A(Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    },
    // ─────────────────────────────────────────────────────────────────────
    // Chrome on macOS (v132)
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'chrome_macos_132',
        browser: 'Chrome',
        browserVersion: '132.0.0.0',
        os: 'macOS',
        osVersion: '14.0',
        platform: 'MacIntel',
        mobile: false,
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'max-age=0',
            'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"macOS"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    },
    // ─────────────────────────────────────────────────────────────────────
    // Firefox on Windows (v134) (No Sec-CH-* headers - Firefox specific!)
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'firefox_win_134',
        browser: 'Firefox',
        browserVersion: '134.0',
        os: 'Windows',
        osVersion: '10',
        platform: 'Win32',
        mobile: false,
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.5',
            'Cache-Control': 'max-age=0',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
            // NOTE: Firefox does NOT send Sec-CH-* headers
        }
    },
    // ─────────────────────────────────────────────────────────────────────
    // Edge on Windows (v132)
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'edge_win_132',
        browser: 'Edge',
        browserVersion: '132.0.0.0',
        os: 'Windows',
        osVersion: '10',
        platform: 'Win32',
        mobile: false,
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'max-age=0',
            'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="132", "Microsoft Edge";v="132"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    },
    // ─────────────────────────────────────────────────────────────────────
    // Safari on macOS (v17.6) (No Sec-CH-* headers - Safari specific!)
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'safari_macos_17',
        browser: 'Safari',
        browserVersion: '17.6',
        os: 'macOS',
        osVersion: '14.0',
        platform: 'MacIntel',
        mobile: false,
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'max-age=0',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Connection': 'keep-alive'
            // NOTE: Safari doesn't send Sec-CH-* or Sec-Fetch-User
        }
    },
    // ─────────────────────────────────────────────────────────────────────
    // Chrome Italian locale (v132) (for Italian businesses)
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'chrome_win_it',
        browser: 'Chrome',
        browserVersion: '132.0.0.0',
        os: 'Windows',
        osVersion: '10',
        platform: 'Win32',
        mobile: false,
        locale: 'it-IT',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cache-Control': 'max-age=0',
            'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    },
    // ─────────────────────────────────────────────────────────────────────
    // Chrome on Android (v132) (Mobile)
    // ─────────────────────────────────────────────────────────────────────
    {
        id: 'chrome_android_132',
        browser: 'Chrome',
        browserVersion: '132.0.0.0',
        os: 'Android',
        osVersion: '14',
        platform: 'Linux armv8l',
        mobile: true,
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'max-age=0',
            'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
            'Sec-CH-UA-Mobile': '?1',
            'Sec-CH-UA-Platform': '"Android"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Connection': 'keep-alive'
        }
    }
];

// ═══════════════════════════════════════════════════════════════════════════════
// R1 (TIER B): Programmatic profile pool expansion (10 hand-curated → 50+).
// ═══════════════════════════════════════════════════════════════════════════════
// Generates coherent profiles from BROWSER_VERSIONS × OS × locale × device.
// Each generated profile passes the same `validate()` checks as the curated
// ones. The hand-curated FINGERPRINT_PROFILES above are kept as anchor
// profiles (they encode subtle Sec-CH-UA brand-string variants that rotate
// in real Chrome and would otherwise be lost when versions roll forward).
// Generated profiles are de-duplicated against the anchor set by `id`.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Common Sec-CH-UA "Not_A Brand" variants observed in real Chrome telemetry.
 * Picking one at generation time rather than freezing one per version
 * matches what Chrome itself does (the value rotates ~quarterly).
 */
const SEC_CH_UA_NOT_BRAND_VARIANTS = [
    '"Not_A Brand";v="8"',
    '"Not-A.Brand";v="99"',
    '"Not A(Brand";v="99"',
    '"Not(A:Brand";v="24"'
];

const CHROME_OS_MATRIX = [
    { os: 'Windows', osVersion: '10', platform: 'Win32', uaPattern: 'Windows NT 10.0; Win64; x64' },
    { os: 'Windows', osVersion: '11', platform: 'Win32', uaPattern: 'Windows NT 10.0; Win64; x64' },
    { os: 'macOS',   osVersion: '14.0', platform: 'MacIntel', uaPattern: 'Macintosh; Intel Mac OS X 10_15_7' },
    { os: 'macOS',   osVersion: '15.0', platform: 'MacIntel', uaPattern: 'Macintosh; Intel Mac OS X 10_15_7' }
];

const FIREFOX_OS_MATRIX = [
    { os: 'Windows', osVersion: '10', platform: 'Win32', uaPattern: 'Windows NT 10.0; Win64; x64; rv:%V' },
    { os: 'Linux',   osVersion: 'x86_64', platform: 'Linux x86_64', uaPattern: 'X11; Linux x86_64; rv:%V' }
];

const EDGE_OS_MATRIX = [
    { os: 'Windows', osVersion: '10', platform: 'Win32' },
    { os: 'Windows', osVersion: '11', platform: 'Win32' }
];

const PROFILE_LOCALES = ['it-IT', 'en-US', 'en-GB'];

function _pickNotBrand() {
    return SEC_CH_UA_NOT_BRAND_VARIANTS[
        Math.floor(Math.random() * SEC_CH_UA_NOT_BRAND_VARIANTS.length)
    ];
}

function _localeAcceptLanguage(locale) {
    if (locale === 'it-IT') return 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
    if (locale === 'en-GB') return 'en-GB,en;q=0.9,en-US;q=0.8';
    return 'en-US,en;q=0.9';
}

/**
 * LIB-18 FIX (2026-05-10): Firefox-specific Accept-Language with monotonically
 * decreasing q-values. Pre-fix the Firefox profile (line 446) computed
 * `_localeAcceptLanguage(locale).replace(/0\.9/g, '0.5')` which substituted
 * only the FIRST q-value, leaving the cascade inconsistent — e.g. for it-IT
 * the result was "it-IT,it;q=0.5,en-US;q=0.8,en;q=0.7" where the primary
 * preference (0.5) was *lower* than the secondary (0.8). RFC 7231 §5.3.1
 * specifies q-values represent relative weight; a real Firefox install ships
 * a coherent decreasing cascade. The mismatched profile was a fingerprint
 * tell — anti-detection systems can flag the inversion.
 *
 * Now: hand-built per-locale strings with proper Firefox-style cascade
 * starting from a slightly lower top weight than Chrome (matches observed
 * Firefox behaviour: top language goes unweighted, secondaries cascade).
 */
function _firefoxLocaleAcceptLanguage(locale) {
    if (locale === 'it-IT') return 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3';
    if (locale === 'en-GB') return 'en-GB,en;q=0.5';
    return 'en-US,en;q=0.5';
}

function _buildChromeProfile(major, osCfg, locale) {
    const ua = `Mozilla/5.0 (${osCfg.uaPattern}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    const notBrand = _pickNotBrand();
    return {
        id: `gen_chrome_${osCfg.os.toLowerCase()}${osCfg.osVersion.replace(/\./g, '')}_${major}_${locale}`,
        browser: 'Chrome',
        browserVersion: `${major}.0.0.0`,
        os: osCfg.os,
        osVersion: osCfg.osVersion,
        platform: osCfg.platform,
        mobile: false,
        locale,
        userAgent: ua,
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': _localeAcceptLanguage(locale),
            'Cache-Control': 'max-age=0',
            'Sec-CH-UA': `${notBrand}, "Chromium";v="${major}", "Google Chrome";v="${major}"`,
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': `"${osCfg.os}"`,
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    };
}

function _buildFirefoxProfile(major, osCfg, locale) {
    const uaPattern = osCfg.uaPattern.replace('%V', `${major}.0`);
    return {
        id: `gen_firefox_${osCfg.os.toLowerCase()}_${major}_${locale}`,
        browser: 'Firefox',
        browserVersion: `${major}.0`,
        os: osCfg.os,
        osVersion: osCfg.osVersion,
        platform: osCfg.platform,
        mobile: false,
        locale,
        userAgent: `Mozilla/5.0 (${uaPattern}) Gecko/20100101 Firefox/${major}.0`,
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': _firefoxLocaleAcceptLanguage(locale),
            'Cache-Control': 'max-age=0',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    };
}

function _buildEdgeProfile(major, osCfg, locale) {
    const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`;
    const notBrand = _pickNotBrand();
    return {
        id: `gen_edge_${osCfg.os.toLowerCase()}${osCfg.osVersion.replace(/\./g, '')}_${major}_${locale}`,
        browser: 'Edge',
        browserVersion: `${major}.0.0.0`,
        os: osCfg.os,
        osVersion: osCfg.osVersion,
        platform: osCfg.platform,
        mobile: false,
        locale,
        userAgent: ua,
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': _localeAcceptLanguage(locale),
            'Cache-Control': 'max-age=0',
            'Sec-CH-UA': `${notBrand}, "Chromium";v="${major}", "Microsoft Edge";v="${major}"`,
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': `"${osCfg.os}"`,
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    };
}

/**
 * R1: Build the full pool from BROWSER_VERSIONS.
 * Anchor profiles (FINGERPRINT_PROFILES) come first; generated profiles
 * are appended skipping any whose `id` collides.
 */
function _buildExpandedPool() {
    const pool = [...FINGERPRINT_PROFILES];
    const seen = new Set(pool.map(p => p.id));

    // Chrome × OS × locale
    for (const major of BROWSER_VERSIONS.chrome.majors) {
        for (const osCfg of CHROME_OS_MATRIX) {
            for (const locale of PROFILE_LOCALES) {
                const p = _buildChromeProfile(major, osCfg, locale);
                if (!seen.has(p.id)) { pool.push(p); seen.add(p.id); }
            }
        }
    }

    // Firefox × (Win + Linux) × locale
    for (const major of BROWSER_VERSIONS.firefox.majors) {
        for (const osCfg of FIREFOX_OS_MATRIX) {
            for (const locale of PROFILE_LOCALES) {
                const p = _buildFirefoxProfile(major, osCfg, locale);
                if (!seen.has(p.id)) { pool.push(p); seen.add(p.id); }
            }
        }
    }

    // Edge × Win10/Win11 × it/en
    for (const major of BROWSER_VERSIONS.edge.majors) {
        for (const osCfg of EDGE_OS_MATRIX) {
            for (const locale of ['it-IT', 'en-US']) {
                const p = _buildEdgeProfile(major, osCfg, locale);
                if (!seen.has(p.id)) { pool.push(p); seen.add(p.id); }
            }
        }
    }

    return pool;
}

/** R1: full pool, computed once at module load. */
const EXPANDED_PROFILE_POOL = _buildExpandedPool();

/**
 * Screen resolutions by device type
 */
const SCREEN_RESOLUTIONS = {
    desktop: [
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 },
        { width: 1366, height: 768 },
        { width: 1536, height: 864 },
        { width: 1440, height: 900 }
    ],
    mobile: [
        { width: 412, height: 915 },
        { width: 390, height: 844 },
        { width: 360, height: 800 },
        { width: 414, height: 896 }
    ]
};

/**
 * Timezones by locale
 */
const TIMEZONES = {
    'en-US': ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
    'it-IT': ['Europe/Rome'],
    'de-DE': ['Europe/Berlin'],
    'fr-FR': ['Europe/Paris'],
    'es-ES': ['Europe/Madrid'],
    'en-GB': ['Europe/London']
};

/**
 * FingerprintGenerator Class
 * Generates coherent browser fingerprints for anti-detection
 */
export class FingerprintGenerator {
    /**
     * Create a new FingerprintGenerator
     * @param {Object} options - Configuration options
     * @param {string[]} [options.browsers=['Chrome', 'Firefox', 'Edge']] - Allowed browsers
     * @param {string[]} [options.operatingSystems=['Windows', 'macOS']] - Allowed operating systems
     * @param {string[]} [options.locales=['it-IT', 'en-US']] - Preferred locales
     * @param {string[]} [options.devices=['desktop']] - Device types (desktop/mobile)
     */
    constructor(options = {}) {
        this.options = {
            browsers: options.browsers ?? ['Chrome', 'Firefox', 'Edge'],
            operatingSystems: options.operatingSystems ?? ['Windows', 'macOS'],
            locales: options.locales ?? ['it-IT', 'en-US'],
            devices: options.devices ?? ['desktop'],
            ...options
        };

        // Pre-filter eligible profiles
        this.eligibleProfiles = this._filterProfiles();

        logger.debug(`[FingerprintGenerator] Initialized with ${this.eligibleProfiles.length} eligible profiles`);
    }

    /**
     * Filter profiles based on options.
     * R1: pool now sourced from EXPANDED_PROFILE_POOL (anchor + generated)
     * to give 50+ distinct fingerprints. Per-instance filter is unchanged.
     * @private
     * @returns {Array} Filtered profiles
     */
    _filterProfiles() {
        return EXPANDED_PROFILE_POOL.filter(p => {
            const browserMatch = this.options.browsers.includes(p.browser);
            const osMatch = this.options.operatingSystems.includes(p.os);
            const deviceMatch = this.options.devices.includes(p.mobile ? 'mobile' : 'desktop');
            return browserMatch && osMatch && deviceMatch;
        });
    }

    /**
     * Generate a complete, coherent fingerprint
     * @returns {Object} Fingerprint with all necessary properties
     */
    generate() {
        // Select random profile from eligible ones
        const profiles = this.eligibleProfiles.length > 0
            ? this.eligibleProfiles
            : FINGERPRINT_PROFILES;

        const profile = profiles[Math.floor(Math.random() * profiles.length)];

        // Select screen resolution
        const resolutions = SCREEN_RESOLUTIONS[profile.mobile ? 'mobile' : 'desktop'];
        const screen = resolutions[Math.floor(Math.random() * resolutions.length)];

        // Select timezone based on locale
        const locale = profile.locale || 'en-US';
        const timezones = TIMEZONES[locale] || TIMEZONES['en-US'];
        const timezone = timezones[Math.floor(Math.random() * timezones.length)];

        // Build complete fingerprint
        const fingerprint = {
            // Profile ID for tracking
            profileId: profile.id,

            // Browser info
            browser: profile.browser,
            browserVersion: profile.browserVersion,
            os: profile.os,
            osVersion: profile.osVersion,
            platform: profile.platform,
            mobile: profile.mobile,
            locale,

            // User agent
            userAgent: profile.userAgent,

            // Headers (complete set with User-Agent)
            headers: {
                'User-Agent': profile.userAgent,
                ...profile.headers
            },

            // Screen properties
            screen: {
                width: screen.width,
                height: screen.height,
                availWidth: screen.width,
                availHeight: screen.height - (profile.mobile ? 0 : 40), // Taskbar
                colorDepth: 24,
                pixelDepth: 24,
                devicePixelRatio: profile.mobile ? 3 : (screen.width > 1920 ? 2 : 1)
            },

            // Hardware Info (Randomized for realism)
            hardware: {
                concurrency: [2, 4, 8, 12, 16][Math.floor(Math.random() * 5)],
                deviceMemory: [2, 4, 8, 16, 32][Math.floor(Math.random() * 5)]
            },

            // Timezone
            timezone,
            timezoneOffset: this._getTimezoneOffset(timezone),

            // Generation metadata
            generatedAt: Date.now()
        };

        return fingerprint;
    }

    /**
     * Generate only the HTTP headers portion (for quick use in fetch)
     * @returns {Object} Headers object ready for fetch()
     */
    generateHeaders() {
        const fingerprint = this.generate();
        return fingerprint.headers;
    }

    /**
     * Get headers with origin/referer for specific domain
     * @param {string} url - Target URL
     * @param {string} [referrer] - Optional referrer URL
     * @returns {Object} Complete headers for request
     */
    generateHeadersForUrl(url, referrer = null) {
        const fingerprint = this.generate();
        const headers = { ...fingerprint.headers };

        try {
            const urlObj = new URL(url);
            headers['Host'] = urlObj.hostname;

            if (referrer) {
                headers['Referer'] = referrer;
                headers['Sec-Fetch-Site'] = 'same-origin';
            }
        } catch (e) {
            // Invalid URL, use defaults
        }

        return headers;
    }

    /**
     * Get timezone offset for a timezone name
     * @private
     * @param {string} timezone - Timezone name
     * @returns {number} Offset in minutes
     */
    _getTimezoneOffset(timezone) {
        try {
            const date = new Date();
            const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
            const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
            return (utcDate - tzDate) / 60000; // Minutes
        } catch {
            return -60; // Default to CET (Italy)
        }
    }

    /**
     * Validate that a fingerprint is internally consistent
     * @param {Object} fingerprint - Fingerprint to validate
     * @returns {Object} Validation result with valid boolean and issues array
     */
    validate(fingerprint) {
        const issues = [];

        // Check User-Agent matches Sec-CH-UA (Chrome-based browsers)
        if (fingerprint.headers['Sec-CH-UA']) {
            const uaMatch = fingerprint.userAgent.match(/Chrome\/(\d+)/);
            const chMatch = fingerprint.headers['Sec-CH-UA'].match(/Chrome";v="(\d+)/);

            if (uaMatch && chMatch && uaMatch[1] !== chMatch[1]) {
                issues.push(`User-Agent Chrome version (${uaMatch[1]}) does not match Sec-CH-UA (${chMatch[1]})`);
            }
        }

        // Check mobile flag consistency
        if (fingerprint.mobile && fingerprint.headers['Sec-CH-UA-Mobile'] !== '?1') {
            issues.push('Mobile flag inconsistent with Sec-CH-UA-Mobile header');
        }
        if (!fingerprint.mobile && fingerprint.headers['Sec-CH-UA-Mobile'] === '?1') {
            issues.push('Desktop fingerprint has mobile Sec-CH-UA-Mobile header');
        }

        // Check platform consistency
        if (fingerprint.os === 'Windows' &&
            fingerprint.headers['Sec-CH-UA-Platform'] &&
            !fingerprint.headers['Sec-CH-UA-Platform'].includes('Windows')) {
            issues.push('OS (Windows) does not match Sec-CH-UA-Platform header');
        }
        if (fingerprint.os === 'macOS' &&
            fingerprint.headers['Sec-CH-UA-Platform'] &&
            !fingerprint.headers['Sec-CH-UA-Platform'].includes('macOS')) {
            issues.push('OS (macOS) does not match Sec-CH-UA-Platform header');
        }

        // Firefox should NOT have Sec-CH-* headers
        if (fingerprint.browser === 'Firefox' && fingerprint.headers['Sec-CH-UA']) {
            issues.push('Firefox should not have Sec-CH-UA headers');
        }

        // Safari should NOT have Sec-CH-* headers  
        if (fingerprint.browser === 'Safari' && fingerprint.headers['Sec-CH-UA']) {
            issues.push('Safari should not have Sec-CH-UA headers');
        }

        return {
            valid: issues.length === 0,
            issues
        };
    }

    /**
     * Get list of supported browsers
     * @static
     * @returns {string[]} Array of supported browser names
     */
    static getSupportedBrowsers() {
        return [...new Set(FINGERPRINT_PROFILES.map(p => p.browser))];
    }

    /**
     * Get list of supported operating systems
     * @static
     * @returns {string[]} Array of supported OS names
     */
    static getSupportedOS() {
        return [...new Set(FINGERPRINT_PROFILES.map(p => p.os))];
    }

    /**
     * Get count of available profiles (anchor + generated).
     * @static
     * @returns {number} Total profile count
     */
    static getProfileCount() {
        return EXPANDED_PROFILE_POOL.length;
    }

    /**
     * R1: get count of anchor (hand-curated) profiles only — useful in tests
     * to verify the expansion didn't regress the anchor set.
     * @static
     */
    static getAnchorProfileCount() {
        return FINGERPRINT_PROFILES.length;
    }

    /**
     * R1: list profile IDs (used by tests + ops scripts).
     * @static
     */
    static listProfileIds() {
        return EXPANDED_PROFILE_POOL.map(p => p.id);
    }

    /**
     * R1: introspect the BROWSER_VERSIONS table the pool was built from.
     * Lets the auto-update script verify a deploy actually rolled.
     * @static
     */
    static getBrowserVersionsMeta() {
        return {
            lastUpdated: BROWSER_VERSIONS.lastUpdated,
            chromeMajors: [...BROWSER_VERSIONS.chrome.majors],
            firefoxMajors: [...BROWSER_VERSIONS.firefox.majors],
            edgeMajors: [...BROWSER_VERSIONS.edge.majors]
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

let _instance = null;

/**
 * Get the singleton FingerprintGenerator instance
 * Pre-configured for Italian business scraping
 * @param {Object} [options] - Override options
 * @returns {FingerprintGenerator} Singleton instance
 */
export function getFingerprintGenerator(options = {}) {
    if (!_instance) {
        _instance = new FingerprintGenerator({
            browsers: ['Chrome', 'Firefox', 'Edge'],
            operatingSystems: ['Windows', 'macOS'],
            locales: ['it-IT', 'en-US'],  // Prefer Italian for Italian businesses
            devices: ['desktop'],
            ...options
        });
    }
    return _instance;
}

export default FingerprintGenerator;
