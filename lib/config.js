/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Configuration Management
 * Centralized configuration with environment-based settings
 */

// HIGH FIX #10: Dynamic environment detection instead of hardcoded 'production'
//
// 2026-05-15 FIX: the previous detection was dead code in practice.
//   - `manifest.version.includes('dev')` only fires if you bump version to
//     "9.12.x-dev" manually (nobody did).
//   - `DEV_EXTENSION_IDS.includes(chrome.runtime.id)` compared the runtime
//     extension id against the literal string "unpacked". Chrome generates
//     a RANDOM HASH for unpacked extensions (e.g. "kfcdefghij...") — never
//     literally "unpacked" — so this branch was never taken on any machine.
//
// Result: ENV was always 'production' for everyone, which meant:
//   - CONFIG.logging.enabled = false
//   - CONFIG.logging.levels.debug = false  → every logger.debug(...) silenced
//   - sidepanel activity feed never populated with under-the-hood traces
//
// The reliable signal is `manifest.update_url`: extensions installed from
// the Chrome Web Store carry an `update_url`; unpacked loads do not. That
// flag is set by Chrome itself, not editable by user code.
const ENV = (() => {
    try {
        const manifest = chrome.runtime.getManifest();
        const isUnpacked = !manifest.update_url;
        if (isUnpacked || manifest.version.includes('dev')) {
            return 'development';
        }
        return 'production';
    } catch {
        return 'production'; // Fallback
    }
})();

export const CONFIG = {
    // Environment
    isDevelopment: ENV === 'development',
    isProduction: ENV === 'production',

    // Database
    db: {
        // PLACEHOLDER ONLY — read by Database constructor at lib/db.js:267 as a
        // pre-init fallback for `this.dbName`. The real runtime DB name is
        // assigned in `init()` at lib/db.js:314 as `'AppDataStore_' + dbId`,
        // so this string is never used as the actual IndexedDB name.
        // Kept (not deleted) so `new Database()` doesn't expose `dbName=undefined`
        // to any caller that reads it before awaiting `init()`.
        // Audit 2026-05-07: confirmed via grep — no other reader.
        name: 'GhostMapPro_DB_v1',
        version: 3, // B8-3 FIX: hasWebsite computed index (was v2 = PHASE 3 FIX #22 indexes)
        stores: {
            businesses: 'businesses',
            jobs: 'jobs',
            settings: 'settings'
        }
    },

    // Rate Limiting
    // AUDIT FIX #8: Gaussian distribution for human-like behavior
    rateLimits: {
        emailScraping: {
            // PHASE 1 OPTIMIZATION: Increased parallelism for faster extraction
            // Gaussian delay parameters (more natural than fixed intervals)
            meanDelayMs: 1200,          // OPTIMIZED: 1.2s average delay (was 1500)
            jitterStdDev: 400,          // OPTIMIZED: tighter variance (was 500)
            maxConcurrent: 5,           // OPTIMIZED: 5 parallel scrapes (was 3, +67%)
            burstLimit: 15,             // OPTIMIZED: allow more burst (was 10)
            burstCooldownMs: 15000,     // OPTIMIZED: shorter cooldown (was 20000)
            retryAttempts: 3,
            retryDelayBase: 2000,       // Base delay for exponential backoff
            timeout: 30000              // 30 second timeout per request
        },
        apiCalls: {
            minDelay: 1000,             // Minimum 1s between any API calls
            maxDelay: 3000              // Maximum random additional delay
        }
    },

    // Selectors with fallback chain for Google Maps
    selectors: {
        // Primary selectors (try in order)
        businessLink: [
            'a[href*="/maps/place/"][aria-label]',
            'a[data-value*="maps/place/"]',
            'div[role="article"] a[href*="/maps/place/"]',
            'a.hfpxzc', // Common Maps class (may change)
            '[jsaction*="pane"] a[href*="/maps/place/"]'
        ],
        scrollContainer: [
            'div[role="feed"]',
            'div.m6QErb[aria-label]',
            'div[tabindex="-1"][aria-label]'
        ],
        businessCard: [
            'div[role="article"]',
            'div.Nv2PK',
            'div[jsaction*="mouseover"]'
        ]
    },

    // Data extraction patterns
    extraction: {
        email: {
            // Stricter regex to avoid CSS classes and malformed emails
            pattern: /\b[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}@[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}\.[a-zA-Z]{2,}\b/g,

            // Minimum quality score to keep email (lowered to 45 for Gmail)
            minConfidenceScore: 45,

            // Priority prefixes (business emails)
            priorityPrefixes: [
                'info', 'contact', 'hello', 'support', 'sales', 'admin',
                'mail', 'office', 'business', 'team', 'press', 'media',
                'service', 'help', 'enquiry', 'inquiry'
            ],

            // Free email providers (lower quality score)
            freeEmailProviders: [
                'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
                'aol.com', 'icloud.com', 'mail.com', 'protonmail.com',
                'live.com', 'msn.com', 'yandex.com', 'gmx.com',
                'zoho.com', 'tutanota.com'
            ],

            // Blacklisted domains (test, placeholder, tracking)
            // FIX: Expanded to include .co variants and Italian placeholders
            blacklist: [
                // Example/placeholder domains (English)
                'example.com', 'example.co', 'test.com', 'test.co',
                'domain.com', 'domain.co', 'email.com', 'email.co',
                'mysite.com', 'mysite.co', 'placeholder.com', 'placeholder.co',
                'yoursite.com', 'yoursite.co', 'sample.com', 'sample.co',
                'yourdomain.com', 'yourdomain.co',
                // Italian placeholder domains (commonly found in Italian sites)
                'esempio.it', 'esempio.co', 'esempio.com',
                'ilmiosito.it', 'ilmiosito.com', 'ilmiosito.co',
                'tuosito.it', 'tuosito.com', 'tuosito.co',
                'tuodominio.it', 'tuodominio.com', 'tuodominio.co',
                'miosito.it', 'miosito.com', 'miosito.co',
                // Tracking & analytics
                'wixpress.com', 'wixpress.co',
                'sentry-next.wixpress.com', 'sentry-next.wixpress.co',
                'sentry.wixpress.com', 'sentry.wixpress.co',
                'wix.com', 'wix.co', 'editorx.com',
                'sentry.io', 'google.com', 'cloudflare.com',
                'amazonaws.com', 'googleusercontent.com',
                // Form services
                'jotform.com', 'mailchimp.com', 'hubspot.com',
                'sendgrid.net', 'mailgun.org', 'sparkpostmail.com'
            ],

            // Obfuscation patterns to decode
            obfuscationPatterns: [
                { pattern: /\[at\]/gi, replace: '@' },
                { pattern: /\[dot\]/gi, replace: '.' },
                { pattern: /\{at\}/gi, replace: '@' },
                { pattern: /\{dot\}/gi, replace: '.' },
                { pattern: /<at>/gi, replace: '@' },
                { pattern: /<dot>/gi, replace: '.' },
                { pattern: /\(at\)/gi, replace: '@' },
                { pattern: /\(dot\)/gi, replace: '.' },
                { pattern: / at /gi, replace: '@' },
                { pattern: / dot /gi, replace: '.' },
                { pattern: / AT /g, replace: '@' },
                { pattern: / DOT /g, replace: '.' },
                { pattern: /@\s+/g, replace: '@' },
                { pattern: /\s+\./g, replace: '.' },
                { pattern: /&#64;/g, replace: '@' },
                { pattern: /&#46;/g, replace: '.' }
            ],

            // =========================================================================
            // BLOCK-L5: Valid TLDs for email cleaning
            // =========================================================================
            // IMPORTANT: Sorted by length DESC to match longest first (.com before .co)
            // This prevents .com → .co truncation when cleaning corrupted TLDs
            // UPDATE: Add new TLDs here when needed (check IANA: https://data.iana.org/TLD/tlds-alpha-by-domain.txt)
            // =========================================================================
            validTLDs: [
                // 4+ chars (match first)
                'info', 'name', 'mobi', 'asia', 'jobs', 'tech', 'shop', 'site', 'online', 'store',
                // 3 chars (generic TLDs)
                'com', 'org', 'net', 'edu', 'gov', 'mil', 'biz', 'pro', 'app', 'dev',
                // 2 chars (country codes) - LAST to prevent false matches
                'it', 'uk', 'de', 'fr', 'es', 'nl', 'ch', 'at', 'be', 'eu', 'us', 'ca',
                'io', 'co', 'me', 'tv', 'tel'
            ]
        },
        phone: {
            // GMB-specific phone patterns. 2026-05-05: rewritten to mirror the
            // Italian-friendly set already used by background/area-search.js.
            // The previous US-only patterns produced empty phone columns for
            // pizzerie/pub during MANUAL scrape (the content-script fallback
            // path) — area-search worked because it shipped its own copy.
            // Order: most specific first; observer's regex engine returns on
            // first match.
            gmbPatterns: [
                // Italian mobile, +39 3xx (3-3-4 + 3-2-2-3 splits)
                /(\+39\s*3\d{2}\s*\d{3}\s*\d{4})/,
                /(\+39\s*3\d{2}\s*\d{2}\s*\d{2}\s*\d{3})/,
                // Italian landline, +39 0xx — MOST SPECIFIC FIRST
                /(\+39\s*0\d{1,4}\s*\d{4}\s*\d{4})/,
                /(\+39\s*0\d{1,4}\s*\d{3}\s*\d{4})/,
                /(\+39\s*0\d{1,4}\s*\d{4,8})/,
                // Italian mobile without prefix
                /\b(3\d{2}\s*\d{3}\s*\d{4})\b/,
                /\b(3\d{2}\s*\d{2}\s*\d{2}\s*\d{3})\b/,
                // Italian landline without prefix
                /\b(0\d{1,4}\s*\d{4}\s*\d{4})\b/,
                /\b(0\d{1,3}\s*\d{3}\s*\d{4})\b/,
                /\b(0\d{1,4}\s*\d{4,8})\b/,
                /\b(0\d{2,4}\s*\d{5,8})\b/,
                // US fallback
                /\+?1\s*[-.]?\s*\(?([0-9]{3})\)?\s*[-.]?\s*([0-9]{3})\s*[-.]?\s*([0-9]{4})/,
                // Generic international
                /(\+\d{1,3}\s*\d{2,4}\s*\d{4,8})/
            ]
        },
        social: {
            platforms: {
                facebook: ['facebook.com', 'fb.com', 'fb.me'],
                instagram: ['instagram.com', 'instagr.am'],
                twitter: ['twitter.com', 'x.com'],
                linkedin: ['linkedin.com'],
                youtube: ['youtube.com', 'youtu.be'],
                tiktok: ['tiktok.com']
            }
        }
    },

    // Email Scraping Strategy (OPTIMIZED - smart prioritization + early exit)
    emailScraping: {
        pagesToTry: [
            '',                      // Homepage (most important - footer emails)
            '/contact',              // English (universal)
            '/contatti',             // Italian
            '/about',                // Team/About pages often have emails
            '/kontakt',              // German
            '/contacto'              // Spanish
        ],
        maxPagesPerSite: 5,       // REDUCED: Smart prioritization visits best pages first
        stopOnFirstSuccess: false, // Let high-confidence detection handle early exit
        skipOn503: true          // Don't retry rate-limited requests
    },

    // Logging
    logging: {
        enabled: ENV === 'development',
        levels: {
            error: true,   // Always log errors
            warn: true,    // Enable warnings for user visibility
            info: true,    // Enable info for activity log
            // BUG-019 FIX: Debug logging should respect environment
            debug: ENV === 'development'  // Only enable debug in development
        },
        prefix: '[Ghost Map]'
    },

    // Error handling
    errors: {
        maxRetries: 3,
        retryDelay: 1000,
        useExponentialBackoff: true,
        backoffMultiplier: 2,
        circuitBreakerThreshold: 10, // Open circuit after 10 consecutive failures
        circuitBreakerTimeout: 60000  // Try again after 1 minute
    },

    // UI Settings
    ui: {
        feedMaxItems: 100,
        statsRefreshInterval: 5000, // PHASE 3 FIX #32: Increased from 2s to 5s (60% CPU reduction)
        notificationDuration: 3000   // 3 seconds
    },

    // PHASE 4 FIX #38 + BUG #20 FIX: Centralized Limits (Magic Numbers)
    limits: {
        MAX_LOG_ENTRIES: 200,
        MAX_FEED_ITEMS: 100,
        MAX_LINE_LENGTH: 800,
        LRU_CACHE_SIZE: 10000,
        MAX_SITEMAP_PAGES: 50,
        MAX_RETRY_ATTEMPTS: 3,
        DOMAIN_RETRY_BUDGET: 10,
        DOMAIN_RETRY_WINDOW_MS: 3600000, // 1 hour

        // BUG #20 FIX: Email extraction limits
        MAX_EMAILS_PER_BUSINESS: 10,
        MAX_PAGES_PER_BUSINESS: 10,
        MAX_DISCOVERED_LINKS: 5,
        FAST_PATH_EMAIL_LIMIT: 5,

        // Observer limits
        INTERSECTION_MARGIN_MIN: 100,
        INTERSECTION_MARGIN_RANGE: 200,

        // Job Queue delay bounds
        GAUSSIAN_MIN_DELAY: 2000,
        GAUSSIAN_MAX_DELAY: 20000
    },

    // BLOCK-L2 FIX: Offscreen document settings
    offscreen: {
        pingMaxAttempts: 25,      // Max attempts to ping offscreen document
        pingIntervalMs: 200       // Interval between ping attempts
    },

    // BLOCK-L2 FIX: Tab fallback page priorities for email scraping
    tabFallback: {
        // Pages to try, ordered by priority (lower = higher priority)
        pagePriorities: [
            { path: '', label: '🏠 Homepage', priority: 0 },
            { path: '/contact', label: '📧 Contact', priority: 1 },
            { path: '/contatti', label: '📧 Contatti (IT)', priority: 1 },
            { path: '/kontakt', label: '📧 Kontakt (DE)', priority: 1 },
            { path: '/contacto', label: '📧 Contacto (ES)', priority: 1 },
            { path: '/about', label: 'ℹ️ About', priority: 2 },
            { path: '/chi-siamo', label: 'ℹ️ Chi Siamo (IT)', priority: 2 },
            { path: '/chi-sono', label: 'ℹ️ Chi Sono (IT)', priority: 2 },
            { path: '/about-us', label: 'ℹ️ About Us', priority: 2 }
        ]
    },

    // BUG #10 FIX: Centralized SessionPool Configuration (Anti-Detection)
    sessionPool: {
        maxPoolSize: 20,        // Maximum concurrent sessions
        maxUsageCount: 30,      // Requests before session rotation
        maxErrorScore: 3,       // Errors before session retirement
        maxAgeSecs: 1800,       // 30 minutes max session age
        rotateOnBlock: true,    // Auto-rotate when blocked detected
        persistSessions: true   // Save sessions to storage for recovery
    },

    // BUG #10 FIX: Centralized Statistics Configuration
    statistics: {
        logIntervalSecs: 120,    // Log stats every 2 minutes
        persistIntervalMs: 60000 // Persist to storage every minute
    },

    // Feature flags
    features: {
        autoScrapeEmails: false,
        cloudFlareDetection: true,
        sitemapDiscovery: true
    },

    // 2026-05-06 (v9.8): /maps/preview/place fetcher for cards beyond
    // the initial APP_INITIALIZATION_STATE batch (~17-19 cards).
    // When enabled, observer fires a network detail-fetch for every
    // discovered card whose phone is still null after DOM + state-map
    // lookups. The fetch returns phone/website/address/rating which
    // are merged back via the existing `business_enrichment` flow.
    //
    // 2026-05-06 (v9.9.0): default flipped to ON after 97.6% phone
    // coverage observed on real-Chrome smoke test (84 cards / 82 phones,
    // pizzerie/Modena scenario). Rollback path: set false here and
    // reload extension, or run
    // `localStorage.removeItem('gmp.detailFetchEnabled')` in DevTools
    // console of any Maps tab if user previously opted in via that path.
    // Concurrency is hard-capped at 3 in detail-fetcher.js with
    // exponential backoff and a kill-switch — runaway requests are
    // bounded.
    detailFetch: {
        enabled: true,
        // Skip fire when href is older than this many ms — avoids re-firing
        // for cards re-discovered by DOM-mutation churn (LRU dedup is the
        // primary guard, this is a secondary safety).
        maxHrefAgeMs: 30_000
    },

    // v9.11 (2026-05-07): Area Search detail-fetch mirror.
    //
    // When `useDetailFetch=true`, runTurboV3 wakes the manual-mode observer
    // in each Area Search popup tab (sends `start_scraping`), then waits
    // for in-flight `/maps/preview/place` fetches to drain BEFORE closing
    // the tab. This brings Area Search phone-coverage from ~22% (DOM-only,
    // extractEnhanced regex) up to ≥99% (matches v9.10 manual-mode).
    //
    // Independent of `detailFetch.enabled` because Area Search runs N tabs
    // in parallel (default 8), so 8×3 = 24 concurrent fetches per second
    // toward `/maps/preview/place`. Anti-detection blast radius is larger
    // — keep this flag separate so it can be turned off without disabling
    // manual mode.
    //
    // `drainTimeoutMs` is a hard cap. Even with concurrency-3 detail-fetcher,
    // ~30 cards × ~500ms = 15s covers a typical batch. Enrichments still
    // in flight at expiry are aborted on tab close (acceptable: extractEnhanced
    // already saved the records, the phone field stays empty for those).
    areaSearch: {
        useDetailFetch: true,
        drainTimeoutMs: 15_000
    },

    // R3+R12 (TIER A): Robots.txt compliance behavior
    // strictMode=false (default) preserves prior fail-open semantics:
    //   robots.txt 404/timeout/parse-error → request proceeds.
    // strictMode=true blocks the request when robots.txt cannot be reliably evaluated.
    // The fetch always uses the caller's session User-Agent when supplied via
    // robotsCompliance.isAllowed(url, { headers }), so the bot identity matches the
    // page-fetch identity (no "two faces to one site" pattern).
    robotsCompliance: {
        strictMode: false,
        cacheTTLms: 24 * 60 * 60 * 1000,
        fetchTimeoutMs: 5000,
        // Used only when no headers are passed via isAllowed(). The pipeline
        // always passes session headers, so this is a safety fallback.
        fallbackUserAgent: 'GhostMapProBot'
    },

    // Opportuni — opt-in cloud sync of de-identified place metadata.
    // Default OFF: user must enable explicitly via sidepanel toggle.
    // De-identification rules: drop email/phone/social BEFORE network call.
    opportuni: {
        enabled: false,
        endpoint: 'http://localhost:8787/api/sync',
        userToken: null,                           // populated after auth flow
        syncIntervalMs: 60_000,                    // batch debounce
        minBatchSize: 10,
        maxBatchSize: 500,
        deidentify: ['email', 'emails', 'phone', 'social']
    }
};

/**
 * Load configuration from storage and merge with defaults
 * Allows for user overrides of selectors and settings
 */
export async function loadConfig() {
    try {
        // Check if chrome.storage is available (might not be in some test environments)
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const stored = await chrome.storage.local.get('userConfig');
            if (stored.userConfig) {
                // Deep merge user config into CONFIG
                // Note: This is a simple merge, for deep nesting we might need a utility
                if (stored.userConfig.selectors) {
                    // Step 03-03: Use safeMerge to prevent prototype pollution (M2-SEC2)
                    const { safeMerge } = await import('./sanitize.js');
                    safeMerge(CONFIG.selectors, stored.userConfig.selectors);
                }
                // Add other overrides here as needed
            }
        }
    } catch (e) {
        console.warn('Failed to load user config:', e);
    }
    return CONFIG;
}

// Get selector by trying each in the fallback chain
export function getElement(selectorArray, parent = document) {
    for (const selector of selectorArray) {
        const element = parent.querySelector(selector);
        if (element) return element;
    }
    return null;
}

// Get all elements using fallback chain
export function getElements(selectorArray, parent = document) {
    for (const selector of selectorArray) {
        const elements = parent.querySelectorAll(selector);
        if (elements.length > 0) return elements;
    }
    return [];
}

export default CONFIG;
