/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Email Scraper Module
 * Extracted from background/index.js for better code organization
 * 
 * CRAWLEE PHASE 2 INTEGRATION:
 * - 2.1 Navigation Hooks (pre/post fetch hooks)
 * - 2.2 Session Persistence (auto-save/restore)
 * - 2.3 Request Context (unified context API)
 * 
 * CRAWLEE PHASE 3 INTEGRATION:
 * - 3.1 System Monitor (resource monitoring)
 * - 3.2 AutoScaler (adaptive concurrency)
 */

import { CONFIG } from '../lib/config.js';
import { logger } from '../lib/utils.js';
import { sitemapDiscovery } from '../lib/SitemapDiscovery.js';
import { updateBusiness } from '../lib/db.js';
import { setupOffscreenDocument } from './offscreen-manager.js'; // HIGH FIX #5
// B4-1: SessionPool no longer eager-imported — resolved lazily via _getPool()
// from ServiceContainer to preserve restoreFromStorage semantics. The unused
// getSessionPool/initializeSessionPool/setSessionPoolForStats imports are
// removed to enforce the discipline.
import { getStatistics } from '../lib/Statistics.js';
import { getNavigationHooks } from '../lib/NavigationHooks.js';
// M3-MISS1: Removed unused createBusinessContext, createPageContext, getContextPool imports
import { getAutoScaler } from '../lib/AutoScaler.js';
import { getSystemMonitor } from '../lib/SystemMonitor.js';
import { scrapeWithTab, shouldRetryWithTab } from './TabScraperFallback.js';
import { container } from '../lib/ServiceContainer.js';
import { robotsCompliance } from '../lib/RobotsCompliance.js';

// ═══════════════════════════════════════════════════════════════════════════
// B4-1 P0 FIX: Lazy SessionPool access via DI container
// ─────────────────────────────────────────────────────────────────────────
// Pre-fix: this module called `getSessionPool({...config...})` at module
// load time, BEFORE `index.js initialize()` could call
// `initializeSessionPool({restoreFromStorage: true, ...})`. This created a
// pool WITHOUT restoreFromStorage — defeating session persistence entirely.
// Every SW wake → fresh pool → 0 sessions restored from disk.
//
// Fix: NEVER touch SessionPool at module load. Resolve lazily from the
// ServiceContainer (registered by index.js initialize() after the
// authoritative initializeSessionPool call). All call sites use _getPool().
//
// Same lazy pattern for Statistics (depends on SessionPool wiring).
//
// Other singletons (NavigationHooks, AutoScaler, SystemMonitor) remain
// eager-init since they don't have storage-restore semantics.
// ═══════════════════════════════════════════════════════════════════════════

// Eager init for singletons WITHOUT storage-restore semantics:
const navigationHooks = getNavigationHooks();
const autoScaler = getAutoScaler();
const systemMonitor = getSystemMonitor();

logger.info(`[EmailScraper] Navigation Hooks enabled with ${navigationHooks.postHooks.length} post-hooks`);
logger.info(`[EmailScraper] AutoScaler ready: ${autoScaler.toString()}`);

// M8-MISS1: Register email scraper dependencies in ServiceContainer
// These are available via container.get() for cross-module resolution.
// NOTE: sessionPool & statistics are registered by index.js initialize()
// — NOT here, to preserve restoreFromStorage semantics (B4-1 fix).
if (!container.has('navigationHooks')) {
    container.register('navigationHooks', navigationHooks);
}
if (!container.has('robotsCompliance')) {
    container.register('robotsCompliance', robotsCompliance);
}
logger.info('[EmailScraper] Dependencies registered in ServiceContainer');

/**
 * B4-1 lazy getter for SessionPool.
 * Throws if called before index.js initialize() has registered the pool —
 * prevents accidental creation of a pool without restoreFromStorage.
 * @private
 * @returns {ReturnType<typeof getSessionPool>}
 */
function _getPool() {
    if (!container.has('sessionPool')) {
        throw new Error(
            '[EmailScraper] SessionPool not yet initialized. ' +
            'index.js initialize() must complete before email scraping. ' +
            'See B4-1 fix: HANDOFF_ULTRAREVIEW_BLOCKS.md'
        );
    }
    return container.get('sessionPool');
}

/**
 * B4-1 lazy getter for Statistics.
 * Statistics is wired with SessionPool — depends on B4-1 lazy init.
 * @private
 */
function _getStats() {
    if (container.has('statistics')) {
        return container.get('statistics');
    }
    // Fallback: index.js may not have registered statistics yet.
    // This only happens early in init; downstream consumers tolerate it.
    return getStatistics({ logIntervalSecs: 120 });
}

// =============================================================================
// MEMORY SAFETY LIMITS - BLOCK-M3 FIX: Use CONFIG instead of hardcoded values
// =============================================================================
const MAX_EMAILS_PER_BUSINESS = CONFIG.limits.MAX_EMAILS_PER_BUSINESS;
const MAX_PAGES_PER_BUSINESS = CONFIG.limits.MAX_PAGES_PER_BUSINESS;
const MAX_DISCOVERED_LINKS = CONFIG.limits.MAX_DISCOVERED_LINKS;

// =============================================================================
// FIX-003 + P2 OPTIMIZATION: ADAPTIVE CIRCUIT BREAKER
// Different cooldown times based on error type for smarter recovery
//
// B4-2 P0 FIX (2026-05-10): the per-domain circuit-breaker state was held in
// a module-scope `Map`, which is lost on MV3 service-worker eviction. After
// every wake, every domain was a clean slate — re-scrape attacked already-
// banned URLs, sprecando session pool + triggering CAPTCHA on fresh sessions.
// Fix: persist via lib/swState.js (chrome.storage.session, eviction-safe).
//
// Side-effect: the periodic setInterval cleanup is removed — it operated on
// the in-memory Map and didn't survive eviction anyway. Stale entries are
// now evicted opportunistically inside `recordCircuitFailure` (evict-on-write),
// which scales with usage and avoids orphan timers (B4-3 also addressed).
// =============================================================================

import { createSessionState } from '../lib/swState.js';
import { Mutex } from '../lib/mutex.js';

const CIRCUIT_OPEN_THRESHOLD = 5;      // 5 consecutive failures opens circuit
const CIRCUIT_HALF_OPEN_ATTEMPTS = 2;  // Allow 2 test attempts in half-open state
const CIRCUIT_BREAKER_MAX_AGE_MS = 3600000; // 1 hour max age for entries

// SW-EVICTION-SAFE: backed by chrome.storage.session. Schema v1.
// Shape: { [domain: string]: { failures, openedAt, halfOpen, halfOpenAttempts, lastError, updatedAt } }
const _circuitBreakerState = createSessionState('email_circuit_breaker.v1', {});

// BG-2 FIX (2026-05-10): serialize get-modify-set on _circuitBreakerState.
// Pre-fix recordCircuitFailure / recordCircuitSuccess each performed an
// `await get()` → mutate → `await set()` without locking. With AutoScaler
// maxConcurrency 5+, multiple workers hitting the same protected domain
// simultaneously each read state.failures=0, increment to 1 locally, then
// write back — last-writer-wins collapsed N concurrent failures into 1.
// Result: CIRCUIT_OPEN_THRESHOLD (5) was never reached even when ALL 5
// workers blew up on Cloudflare/CAPTCHA, and the breaker never opened.
//
// This single module-scope mutex serializes all circuit-breaker mutations.
// Trade-off: 5 workers on different domains are also serialized — but
// recordCircuit{Success,Failure} runs only on completion / error paths,
// not the hot scrape loop, so throughput impact is negligible.
const _circuitMutex = new Mutex();

// P2 OPTIMIZATION: Adaptive cooldowns by error type
const ADAPTIVE_COOLDOWNS = {
    'CLOUDFLARE_PROTECTED': 300000,     // 5 min - hard block, needs human intervention
    'CAPTCHA': 300000,     // 5 min - same as Cloudflare
    'HTTP_429': 60000,      // 1 min - rate limit, wait briefly
    'HTTP_403': 120000,     // 2 min - soft block
    'HTTP_503': 30000,      // 30s - temporary unavailable
    'TIMEOUT': 15000,      // 15s - network issue, try again soon
    'EMPTY_HTML': 30000,      // 30s - likely JS site, tab fallback handles this
    'CONNECTION_ERROR': 20000,      // 20s - network issue
    'DEFAULT': 180000      // 3 min - unknown error type
};

/**
 * Evict stale circuit breaker entries (>1h) inside the provided map.
 * Pure helper — caller is responsible for persisting the result.
 *
 * @param {Record<string, any>} map
 * @returns {{cleaned: Record<string, any>, evicted: number}}
 * @private
 */
function _evictStaleCircuitEntries(map) {
    const now = Date.now();
    /** @type {Record<string, any>} */
    const cleaned = {};
    let evicted = 0;
    for (const [domain, state] of Object.entries(map)) {
        const s = /** @type {any} */ (state);
        // Use openedAt or updatedAt; stale if older than MAX_AGE.
        const ts = (s && (s.openedAt || s.updatedAt)) || 0;
        if (ts && (now - ts) > CIRCUIT_BREAKER_MAX_AGE_MS) {
            evicted++;
            continue;
        }
        cleaned[domain] = state;
    }
    return { cleaned, evicted };
}

/**
 * P2: Get cooldown duration based on last error type
 * @param {string} errorType - Error type string
 * @returns {number} Cooldown in milliseconds
 */
function getCooldownForError(errorType) {
    if (!errorType) return ADAPTIVE_COOLDOWNS.DEFAULT;

    // LIB-11 FIX (2026-05-11): mirror of lib/CircuitBreaker.js. Pre-fix
    // crashed with TypeError if a caller passed a numeric error code
    // (e.g. 429). String() coercion is safe for any toStringable input.
    const upperError = String(errorType).toUpperCase();

    // Match against known patterns
    if (upperError.includes('CLOUDFLARE')) return ADAPTIVE_COOLDOWNS.CLOUDFLARE_PROTECTED;
    if (upperError.includes('CAPTCHA')) return ADAPTIVE_COOLDOWNS.CAPTCHA;
    if (upperError.includes('429')) return ADAPTIVE_COOLDOWNS.HTTP_429;
    if (upperError.includes('403')) return ADAPTIVE_COOLDOWNS.HTTP_403;
    if (upperError.includes('503')) return ADAPTIVE_COOLDOWNS.HTTP_503;
    if (upperError.includes('TIMEOUT')) return ADAPTIVE_COOLDOWNS.TIMEOUT;
    if (upperError.includes('EMPTY')) return ADAPTIVE_COOLDOWNS.EMPTY_HTML;
    if (upperError.includes('CONNECTION') || upperError.includes('NETWORK')) {
        return ADAPTIVE_COOLDOWNS.CONNECTION_ERROR;
    }

    return ADAPTIVE_COOLDOWNS.DEFAULT;
}

/**
 * FIX-003 + P2 + B4-2: Check if circuit is open for a domain.
 * Uses adaptive cooldown based on stored error type. State persisted via
 * chrome.storage.session to survive SW eviction.
 *
 * NOTE: read-modify-write race window. Two concurrent calls may both read
 * the half-open state and both increment halfOpenAttempts independently —
 * the first to write wins, the other's attempt is lost (state-wise) but
 * still proceeds. Acceptable: worst case is 1 extra attempt past the
 * half-open budget.
 *
 * @param {string} domain - Domain to check
 * @returns {Promise<boolean>} True if circuit is open (should skip)
 */
export async function isCircuitOpen(domain) {
    // BG-14 FIX (2026-05-10): serialize the entire read-modify-write under
    // _circuitMutex (the same mutex BG-2 introduced for recordCircuit*).
    // This function is async — between `await get()` and `await set()`,
    // concurrent callers can interleave. Without the mutex, N callers in
    // half-open state all read halfOpenAttempts=0 and all increment to 1
    // independently, then write back; the CIRCUIT_HALF_OPEN_ATTEMPTS=2
    // budget is silently bypassed and the domain receives N concurrent
    // probe requests instead of 2 — usually triggering immediate re-block.
    return _circuitMutex.runExclusive(async () => {
        const all = await _circuitBreakerState.get();
        const state = all[domain];
        if (!state) return false;

        const now = Date.now();
        const elapsed = now - (state.openedAt || 0);
        const cooldownMs = getCooldownForError(state.lastError);

        // Cooldown expired - transition to half-open state
        if (elapsed >= cooldownMs) {
            let mutated = false;
            if (!state.halfOpen) {
                state.halfOpen = true;
                state.halfOpenAttempts = 0;
                state.updatedAt = now;
                mutated = true;
                logger.info(`[CIRCUIT] 🔄 Domain ${domain} entering half-open state after ${(cooldownMs / 1000).toFixed(0)}s`);
            }

            // In half-open, allow limited attempts
            if (state.halfOpenAttempts < CIRCUIT_HALF_OPEN_ATTEMPTS) {
                state.halfOpenAttempts++;
                state.updatedAt = now;
                mutated = true;
                if (mutated) {
                    all[domain] = state;
                    await _circuitBreakerState.set(all);
                }
                return false; // Allow attempt
            }
            if (mutated) {
                all[domain] = state;
                await _circuitBreakerState.set(all);
            }
            return true; // Exceeded half-open attempts, still blocked
        }

        return (state.failures || 0) >= CIRCUIT_OPEN_THRESHOLD;
    });
}

/**
 * FIX-003 + B4-2: Record success for circuit breaker.
 * State persisted via chrome.storage.session.
 * @param {string} domain - Domain that succeeded
 */
async function recordCircuitSuccess(domain) {
    // BG-2 FIX: serialize entire read-modify-write under _circuitMutex.
    return _circuitMutex.runExclusive(async () => {
        const all = await _circuitBreakerState.get();
        const state = all[domain];
        if (!state) return;  // No state to update

        // Success in half-open state closes the circuit
        if (state.halfOpen) {
            logger.info(`[CIRCUIT] ✅ Domain ${domain} recovered - circuit closed`);
            delete all[domain];
        } else {
            // Reduce failure count on success
            state.failures = Math.max(0, (state.failures || 0) - 1);
            state.updatedAt = Date.now();
            if (state.failures === 0) {
                delete all[domain];
            } else {
                all[domain] = state;
            }
        }
        await _circuitBreakerState.set(all);
    });
}

/**
 * FIX-003 + P2 + B4-2: Record failure for circuit breaker with error type.
 * State persisted via chrome.storage.session.
 *
 * Inline cleanup: opportunistically evicts stale entries (>1h) to bound
 * storage footprint without an orphan setInterval (B4-3 also addressed).
 *
 * @param {string} domain - Domain that failed
 * @param {string} [errorType] - Type of error for adaptive cooldown
 */
async function recordCircuitFailure(domain, errorType = 'DEFAULT') {
    // BG-2 FIX: serialize entire read-modify-write under _circuitMutex.
    return _circuitMutex.runExclusive(async () => {
        let all = await _circuitBreakerState.get();

        // Evict-on-write: opportunistically clean stale entries (B4-2 + B4-3)
        const { cleaned, evicted } = _evictStaleCircuitEntries(all);
        if (evicted > 0) {
            all = cleaned;
            logger.debug(`[CIRCUIT] 🧹 Evicted ${evicted} stale entries during write`);
        }

        let state = all[domain];
        if (!state) {
            state = { failures: 0, openedAt: 0, halfOpen: false, halfOpenAttempts: 0, lastError: null, updatedAt: Date.now() };
        }

        // Store error type for adaptive cooldown
        state.lastError = errorType;
        state.updatedAt = Date.now();

        // If in half-open and failed, re-open the circuit
        if (state.halfOpen) {
            state.halfOpen = false;
            state.failures = CIRCUIT_OPEN_THRESHOLD;
            state.openedAt = Date.now();
            logger.warn(`[CIRCUIT] 🔴 Domain ${domain} failed half-open test - circuit re-opened`);
            all[domain] = state;
            await _circuitBreakerState.set(all);
            return;
        }

        state.failures = (state.failures || 0) + 1;

        if (state.failures === CIRCUIT_OPEN_THRESHOLD) {
            state.openedAt = Date.now();
            const cooldownMs = getCooldownForError(errorType);
            logger.warn(`[CIRCUIT] ⛔ Domain ${domain} circuit OPENED (${CIRCUIT_OPEN_THRESHOLD} ${errorType} failures)`);
            logger.warn(`[CIRCUIT] ⏳ Domain ${domain} blocked for ${(cooldownMs / 60000).toFixed(1)} minutes (adaptive: ${errorType})`);
        }

        all[domain] = state;
        await _circuitBreakerState.set(all);
    });
}

// =============================================================================
// PAGE PRIORITY CONFIGURATION - Smart Page Prioritization
// =============================================================================
const PAGE_PRIORITY = {
    // Homepage - always first (often has email in footer)
    homepage: { priority: 0, patterns: [] },

    // Contact pages - highest priority after homepage
    contact: {
        priority: 1,
        patterns: [
            '/contact', '/contacts', '/contact-us', '/contactus', '/contact_us',
            '/contatti', '/contatto', '/kontakt', '/contacto', '/kontakte',
            '/get-in-touch', '/reach-us', '/reach-out', '/write-us',
            '/nous-contacter', '/contactez-nous', '/contactar',
            '/info', '/information', '/informazioni',
        ]
    },

    // About pages - second priority (often has email)
    about: {
        priority: 2,
        patterns: [
            '/about', '/about-us', '/aboutus', '/about_us',
            '/chi-siamo', '/chi-sono', '/uber-uns', '/ueber-uns',
            '/qui-sommes-nous', '/a-propos', '/quienes-somos', '/sobre-nosotros',
            '/team', '/our-team', '/il-team', '/staff',
            '/company', '/azienda', '/impressum', '/imprint',
        ]
    },

    // Other pages - lowest priority
    other: { priority: 3, patterns: [] }
};

/**
 * Determine page priority based on URL
 * @param {string} url - URL to classify
 * @returns {number} - Priority (0=homepage, 1=contact, 2=about, 3=other)
 */
function getPagePriority(url) {
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname.toLowerCase();

        // Homepage
        if (path === '/' || path === '') {
            return PAGE_PRIORITY.homepage.priority;
        }

        // Check contact patterns
        for (const pattern of PAGE_PRIORITY.contact.patterns) {
            if (path.includes(pattern)) {
                return PAGE_PRIORITY.contact.priority;
            }
        }

        // Check about patterns
        for (const pattern of PAGE_PRIORITY.about.patterns) {
            if (path.includes(pattern)) {
                return PAGE_PRIORITY.about.priority;
            }
        }

        return PAGE_PRIORITY.other.priority;
    } catch {
        return PAGE_PRIORITY.other.priority;
    }
}

/**
 * Get page type label for logging
 * @param {number} priority - Page priority
 * @returns {string} - Human-readable type
 */
function getPageTypeLabel(priority) {
    switch (priority) {
        case 0: return '🏠 Homepage';
        case 1: return '📧 Contact';
        case 2: return 'ℹ️ About';
        default: return '📄 Other';
    }
}

/**
 * Smart page prioritization - orders pages by likelihood of containing email
 * Order: Homepage → Contact pages → About pages → Other pages
 * @param {string} homepageUrl - Homepage URL
 * @param {string[]} sitemapPages - Pages from sitemap
 * @param {string[]} guessedPages - Guessed contact/about pages
 * @param {number} maxPages - Maximum pages to return
 * @returns {string[]} - Prioritized and deduplicated page list
 */
export function prioritizePages(homepageUrl, sitemapPages, guessedPages, maxPages = 5) {
    const seen = new Set();

    // FILTER HERE instead of at call site
    const validSitemapPages = sitemapPages.filter(isValidScrapableUrl);

    // OPTIMIZATION: If sitemap found contact/about pages, DON'T use guessed pages
    // This eliminates 404s for pages that don't exist
    const useGuessedPages = validSitemapPages.length === 0;

    // ═════════════════════════════════════════════════════════════════════════
    // BGW-M1 FIX: Log VALID page count, not raw sitemap count
    // This prevents log confusion by showing both raw and filtered counts
    // e.g., "sitemap=15 pages (valid=3)" shows 12 were filtered out
    // ═════════════════════════════════════════════════════════════════════════
    logger.info(`[DEBUG_UI] prioritizePages: sitemap=${sitemapPages.length}, valid=${validSitemapPages.length}, useGuessed=${useGuessedPages}`);

    if (!useGuessedPages) {
        // LOGGING FIX: Show original count vs valid count
        logger.info(`[PRIORITY] Sitemap found ${sitemapPages.length} pages (${validSitemapPages.length} valid) - skipping guessed URLs`);
    }

    // Combine all pages with their priorities
    const allPages = [
        { url: homepageUrl, source: 'homepage' },
        ...validSitemapPages.map(url => ({ url, source: 'sitemap' })),
        ...(useGuessedPages ? guessedPages.map(url => ({ url, source: 'guessed' })) : [])
    ];

    // Add priority and deduplicate
    const pagesWithPriority = [];
    for (const { url, source } of allPages) {
        // Normalize URL for deduplication
        const normalized = url.toLowerCase().replace(/\/$/, '');
        if (seen.has(normalized)) continue;
        seen.add(normalized);

        pagesWithPriority.push({
            url,
            source,
            priority: getPagePriority(url)
        });
    }

    // Sort by priority (lower = higher priority)
    pagesWithPriority.sort((a, b) => {
        // First by priority
        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }
        // Then prefer sitemap over guessed
        if (a.source !== b.source) {
            if (a.source === 'sitemap') return -1;
            if (b.source === 'sitemap') return 1;
        }
        return 0;
    });

    // Take top N pages
    const result = pagesWithPriority.slice(0, maxPages);

    // Log the prioritization
    logger.info(`[PRIORITY] Page order (${result.length} pages):`);
    result.forEach((page, i) => {
        const typeLabel = getPageTypeLabel(page.priority);
        logger.info(`  ${i + 1}. ${typeLabel} ${page.url} (${page.source})`);
    });

    return result.map(p => p.url);
}

/**
 * Check if email is high-confidence (worth stopping early for)
 * @param {string} email - Email to check
 * @param {string} businessDomain - Business website domain
 * @returns {boolean} - True if high confidence
 */
function isHighConfidenceEmail(email, businessDomain) {
    const emailLower = email.toLowerCase();
    const [localPart, emailDomain] = emailLower.split('@');

    // High confidence patterns
    const highConfidencePrefixes = [
        'info', 'contact', 'hello', 'ciao', 'hola',
        'mail', 'email', 'enquiries', 'enquiry',
        'booking', 'prenotazioni', 'reservations',
        'support', 'help', 'service',
    ];

    // Check if email domain matches business domain
    let domainMatch = false;
    if (businessDomain) {
        try {
            const bizDomain = new URL(businessDomain).hostname.replace('www.', '').toLowerCase();
            domainMatch = emailDomain.includes(bizDomain.split('.')[0]);
        } catch { }
    }

    // High confidence if:
    // 1. Starts with common business prefixes
    // 2. OR domain matches business website
    const hasGoodPrefix = highConfidencePrefixes.some(p => localPart.startsWith(p));

    return hasGoodPrefix || domainMatch;
}

// User agent rotation for anti-detection
const USER_AGENTS = [
    // Desktop Chrome (Windows)
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Desktop Chrome (Mac)
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Desktop Firefox
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    // Desktop Safari (Mac)
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    // Desktop Chrome (Linux)
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Mobile Chrome (Android)
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    // Mobile Safari (iPhone)
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    // Mobile Chrome (iOS)
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1'
];

let currentUserAgentIndex = 0;

/**
 * Filter out social media and invalid URLs
 * @param {string} url - URL to validate
 * @returns {boolean} - True if URL is scrapable
 */
export function isValidScrapableUrl(url) {
    if (!url || typeof url !== 'string') return false;

    try {
        // P1-1 FIX: Force HTTPS for all scraped URLs
        // This prevents mixed content and potential MITM attacks
        url = url.replace(/^http:\/\//i, 'https://');
        if (!url.startsWith('https://')) {
            url = 'https://' + url;
        }

        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();

        // PATCH #7: Skip social media, booking sites, and marketplaces
        const socialMediaDomains = [
            'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'fb.com',
            'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com',
            'snapchat.com', 'whatsapp.com', 'telegram.org', 'google.com',
            'maps.google.com', 'goo.gl', 'youtu.be', 'wa.me', 't.me',
            // Marketplaces and directories
            'amazon.com', 'ebay.com', 'yelp.com', 'tripadvisor.com',
            // Booking/Link shorteners that won't have emails
            'booking.com', 'calendly.com', 'linktr.ee', 'linkin.bio',
            'bit.ly', 'tinyurl.com'
        ];

        if (socialMediaDomains.some(domain => hostname.includes(domain))) {
            return false;
        }

        // Must have a dot (reject "localhost" or "not-a-url")
        if (!hostname.includes('.')) {
            return false;
        }

        // Must be http/https
        if (!urlObj.protocol.startsWith('http')) {
            return false;
        }

        // Reject fragments without paths (/#something)
        if (urlObj.pathname === '/' && urlObj.hash) {
            return false;
        }

        return true;
    } catch (e) {
        return false; // Invalid URL
    }
}
// =============================================================================
// C5 FIX: EUROPEAN LANGUAGE DETECTION SYSTEM
// =============================================================================
// NSA-grade language detection for precise contact page guessing across Europe.
// Prevents wasted requests (e.g., Italian sites trying /kontakt).
// =============================================================================

/**
 * European TLD to primary language mapping
 * Keys: Country code TLDs
 * Values: Primary language code(s) - first is default
 */
const TLD_LANGUAGE_MAP = {
    // Western Europe
    'it': 'it',           // Italy
    'de': 'de',           // Germany
    'at': 'de',           // Austria (German)
    'fr': 'fr',           // France
    'es': 'es',           // Spain
    'pt': 'pt',           // Portugal
    'be': 'nl',           // Belgium (Dutch default, also French)
    'nl': 'nl',           // Netherlands
    'lu': 'fr',           // Luxembourg (French default)

    // Northern Europe
    'uk': 'en',           // United Kingdom
    'ie': 'en',           // Ireland
    'dk': 'da',           // Denmark
    'se': 'sv',           // Sweden
    'no': 'no',           // Norway
    'fi': 'fi',           // Finland
    'is': 'is',           // Iceland

    // Central/Eastern Europe
    'pl': 'pl',           // Poland
    'cz': 'cs',           // Czech Republic
    'sk': 'sk',           // Slovakia
    'hu': 'hu',           // Hungary
    'ro': 'ro',           // Romania
    'bg': 'bg',           // Bulgaria
    'hr': 'hr',           // Croatia
    'si': 'sl',           // Slovenia
    'rs': 'sr',           // Serbia
    'ua': 'uk',           // Ukraine
    'by': 'be',           // Belarus
    'lt': 'lt',           // Lithuania
    'lv': 'lv',           // Latvia
    'ee': 'et',           // Estonia

    // Southern Europe
    'gr': 'el',           // Greece
    'cy': 'el',           // Cyprus (Greek)
    'mt': 'en',           // Malta (English)
    'al': 'sq',           // Albania
    'mk': 'mk',           // North Macedonia
    'me': 'me',           // Montenegro (also .me for personal domains)

    // Switzerland - SPECIAL: Multi-language
    'ch': 'multi-ch',     // Swiss domains need subdomain/path analysis

    // Generic TLDs default to English
    'com': 'en',
    'net': 'en',
    'org': 'en',
    'io': 'en',
    'co': 'en',
    'eu': 'en',           // .eu defaults to English (analyze further)
};

/**
 * Language-specific contact page paths
 * Ordered by likelihood of containing email addresses
 */
const LANGUAGE_CONTACT_PATHS = {
    // Italian
    'it': ['/contatti', '/contatto', '/chi-siamo', '/chi-sono', '/dove-siamo', '/info'],

    // German
    'de': ['/kontakt', '/impressum', '/ueber-uns', '/uber-uns', '/team', '/info'],

    // French
    'fr': ['/contact', '/nous-contacter', '/contactez-nous', '/a-propos', '/qui-sommes-nous', '/equipe'],

    // Spanish
    'es': ['/contacto', '/contactar', '/contactenos', '/quienes-somos', '/sobre-nosotros', '/equipo'],

    // Portuguese
    'pt': ['/contacto', '/contactos', '/contato', '/quem-somos', '/sobre-nos', '/equipa'],

    // Dutch
    'nl': ['/contact', '/over-ons', '/wie-zijn-wij', '/team', '/info'],

    // Polish
    'pl': ['/kontakt', '/o-nas', '/o-firmie', '/zespol', '/informacje'],

    // Greek
    'el': ['/epikoinonia', '/contact', '/gia-emas', '/about'],

    // Danish
    'da': ['/kontakt', '/om-os', '/om', '/info'],

    // Swedish
    'sv': ['/kontakt', '/om-oss', '/om', '/info'],

    // Norwegian
    'no': ['/kontakt', '/om-oss', '/om', '/info'],

    // Finnish
    'fi': ['/yhteystiedot', '/meista', '/tietoa', '/info'],

    // Czech
    'cs': ['/kontakt', '/o-nas', '/kontakty', '/info'],

    // Hungarian
    'hu': ['/kapcsolat', '/rolunk', '/cegunkrol', '/info'],

    // Romanian
    'ro': ['/contact', '/despre-noi', '/echipa', '/info'],

    // Croatian/Serbian/Slovenian (similar)
    'hr': ['/kontakt', '/o-nama', '/tim', '/info'],
    'sl': ['/kontakt', '/o-nas', '/ekipa', '/info'],
    'sr': ['/kontakt', '/o-nama', '/tim', '/info'],

    // English (default)
    'en': ['/contact', '/contact-us', '/about', '/about-us', '/team', '/info'],
};

/**
 * Hostname keywords that indicate language
 * Used for .com/.eu domains where TLD doesn't indicate language
 */
const HOSTNAME_LANGUAGE_HINTS = {
    'it': ['italy', 'italia', 'italiano', 'tuscany', 'toscana', 'rome', 'roma', 'milan', 'milano', 'venice', 'venezia', 'florence', 'firenze', 'naples', 'napoli', 'sicily', 'sicilia', 'sardegna', 'sardinia'],
    'de': ['germany', 'deutschland', 'deutsch', 'berlin', 'munich', 'muenchen', 'hamburg', 'frankfurt', 'koeln', 'cologne', 'bavaria', 'bayern'],
    'fr': ['france', 'francais', 'paris', 'lyon', 'marseille', 'bordeaux', 'toulouse', 'nice'],
    'es': ['spain', 'espana', 'español', 'madrid', 'barcelona', 'valencia', 'sevilla', 'malaga', 'ibiza', 'mallorca'],
    'pt': ['portugal', 'portugues', 'lisbon', 'lisboa', 'porto', 'algarve', 'madeira'],
    'nl': ['netherlands', 'nederland', 'dutch', 'amsterdam', 'rotterdam', 'holland'],
    'pl': ['poland', 'polska', 'polish', 'warsaw', 'warszawa', 'krakow', 'gdansk'],
    'el': ['greece', 'greek', 'hellas', 'athens', 'athina', 'thessaloniki', 'crete', 'santorini', 'mykonos'],
};

/**
 * C5 FIX: Detect language from URL with European precision
 * @param {string} hostname - Website hostname
 * @returns {string} - Language code (e.g., 'it', 'de', 'en')
 */
function detectLanguageFromHostname(hostname) {
    const lowerHostname = hostname.toLowerCase();

    // 1. Check for subdomain language hints (e.g., it.example.com, de.company.eu)
    const subdomainMatch = lowerHostname.match(/^(it|de|fr|es|pt|nl|pl|el|en|da|sv|no|fi)\./);
    if (subdomainMatch) {
        logger.debug(`[LANG] Subdomain detection: ${subdomainMatch[1]} from ${hostname}`);
        return subdomainMatch[1];
    }

    // 2. Extract TLD
    const parts = lowerHostname.split('.');
    const tld = parts[parts.length - 1];

    // 3. Handle Swiss domains specially
    if (tld === 'ch') {
        // Check for language hints in subdomain or hostname
        if (lowerHostname.includes('.it.') || lowerHostname.startsWith('it.')) return 'it';
        if (lowerHostname.includes('.de.') || lowerHostname.startsWith('de.')) return 'de';
        if (lowerHostname.includes('.fr.') || lowerHostname.startsWith('fr.')) return 'fr';
        // Default Swiss to German (most common)
        return 'de';
    }

    // 4. Define generic TLDs that need keyword analysis
    const genericTLDs = ['com', 'net', 'org', 'io', 'co', 'eu', 'biz', 'info'];
    const isGenericTLD = genericTLDs.includes(tld);

    // 5. For GENERIC TLDs, check keywords FIRST (before defaulting to English)
    if (isGenericTLD) {
        for (const [lang, keywords] of Object.entries(HOSTNAME_LANGUAGE_HINTS)) {
            for (const keyword of keywords) {
                if (lowerHostname.includes(keyword)) {
                    logger.debug(`[LANG] Keyword detection: ${lang} from "${keyword}" in ${hostname}`);
                    return lang;
                }
            }
        }
        // No keyword match → default to English for generic TLDs
        logger.debug(`[LANG] Default to English for generic TLD: ${hostname}`);
        return 'en';
    }

    // 6. Check country-specific TLD mapping (non-generic TLDs)
    if (TLD_LANGUAGE_MAP[tld]) {
        logger.debug(`[LANG] TLD detection: ${TLD_LANGUAGE_MAP[tld]} from .${tld}`);
        return TLD_LANGUAGE_MAP[tld];
    }

    // 7. Final fallback to English for unknown TLDs
    logger.debug(`[LANG] Default to English for unknown TLD: ${hostname}`);
    return 'en';
}

/**
 * Generate page URLs to try for email scraping
 * C5 FIX: Comprehensive European language detection
 * @param {string} baseUrl - Base website URL
 * @returns {string[]} - Array of URLs to try (prioritized by detected language)
 */
export function generatePageUrls(baseUrl) {
    try {
        const urlObj = new URL(baseUrl);
        const hostname = urlObj.hostname.toLowerCase();

        // C5 FIX: Use precise language detection
        const detectedLanguage = detectLanguageFromHostname(hostname);

        // Get language-specific paths, fallback to English
        let prioritizedPages = LANGUAGE_CONTACT_PATHS[detectedLanguage]
            || LANGUAGE_CONTACT_PATHS['en'];

        // For detected non-English, ONLY use that language's paths
        // This prevents Italian sites from trying /kontakt (German)
        // For English, we keep just English paths (no international mix)

        logger.debug(`[LANG] ${hostname} → Language: ${detectedLanguage}, Paths: ${prioritizedPages.slice(0, 3).join(', ')}...`);

        // Limit to fewer guesses (sitemap should have found real pages)
        const maxGuesses = 5;
        const pages = prioritizedPages.slice(0, maxGuesses);

        return pages.map(page => {
            const newUrl = new URL(urlObj);
            newUrl.pathname = page;
            return newUrl.toString();
        }).filter(url => isValidScrapableUrl(url));
    } catch (error) {
        logger.warn(`Invalid URL: ${baseUrl}`);
        return [];
    }
}

/**
 * Normalize email for deduplication (PHASE 3 FIX #27)
 * @param {string} email - Email to normalize
 * @returns {string} - Normalized email
 */
export function normalizeEmail(email) {
    if (!email || typeof email !== 'string') return '';
    return email.toLowerCase().trim();
}

/**
 * Get rotating user agent headers for HTTP requests
 * LEGACY SYNC VERSION - for backward compatibility
 * Uses simple rotation without session tracking
 * @returns {{[key: string]: string}} HTTP headers object with rotated user agent
 * @deprecated Use getSessionHeaders() for session-aware requests
 */
export function getRotatingHeaders() {
    currentUserAgentIndex = (currentUserAgentIndex + 1) % USER_AGENTS.length;

    return {
        'User-Agent': USER_AGENTS[currentUserAgentIndex],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0'
    };
}

/**
 * Get session-aware headers with coherent browser fingerprint
 * CRAWLEE-INSPIRED: Uses SessionPool for tracking and rotation
 * @returns {Promise<{headers: Object, sessionId: string}>} Headers and session ID for tracking
 */
export async function getSessionHeaders() {
    const session = await _getPool().getSession();

    return {
        headers: session.headers,
        sessionId: session.id
    };
}

/**
 * Detect Cloudflare challenge page (IMPROVED - reduce false positives)
 * Only detect actual challenge pages, not sites that simply use Cloudflare CDN
 * BUG-010 FIX: Added more Cloudflare variants for comprehensive detection
 * @param {string} html - HTML content
 * @returns {boolean} - True if Cloudflare CHALLENGE detected (not just CDN)
 */
export function isCloudflareChallenge(html) {
    if (!html || html.length < 100) return false;

    const lowerHtml = html.toLowerCase();

    // MUST have challenge-specific indicators (not just "cloudflare" in footer)
    // BUG-010 FIX: Enhanced with additional Cloudflare challenge variants
    const challengeIndicators = [
        'checking your browser',           // Challenge page title
        'cf-browser-verification',         // Challenge div ID
        '__cf_chl_jschl_tk__',            // Challenge token
        'challenge-running',               // Challenge state
        'cf-challenge-running',            // Challenge state (alt)
        'ray id:',                         // Only on challenge pages with this context
        'jschl-answer',                    // JavaScript challenge answer field
        'cf_chl_opt',                      // Challenge options
        'turnstile',                       // Cloudflare Turnstile CAPTCHA
        // BUG-010 FIX: New Cloudflare variants
        'cf-wrapper',                      // Challenge wrapper div
        'cf-im-under-attack',              // Under attack mode
        'cf-captcha-container',            // CAPTCHA container
        'hcaptcha',                        // hCaptcha (Cloudflare partner)
        'cf-error-details',                // Error page with details
        'managed_checking',                // Managed challenge
        'cf_chl_managed_tk',               // Managed challenge token
        'cf-mitigated',                    // Mitigated request
        'verifying you are human',         // Turnstile message
        'please wait while we verify',     // Challenge loading message
        'this process is automatic',       // Challenge info message
        'security check',                  // Generic security check
        'ddos-guard',                      // DDoS Guard (similar service)
        'cf-spinner-please-wait',          // Spinner during check
        '__cf_bm',                         // Bot management cookie reference
        'challenge-form',                  // Challenge form element
        'cf-turnstile'                     // Turnstile widget
    ];

    // Check for challenge indicators - REQUIRE 2+ to prevent false positives
    // Single mentions (e.g., "Ray ID:" in footer) shouldn't trigger
    const matchCount = challengeIndicators.filter(indicator =>
        lowerHtml.includes(indicator)
    ).length;

    // P1-002 FIX: Require at least 2 indicators to reduce false positives
    if (matchCount < 2) return false;

    // Additional check: Real challenge pages are typically small (<50KB) 
    // and have specific structure
    const isChallengeSize = html.length < 50000;

    // Check for actual content - if page has substantial content, 
    // it's probably not a challenge page
    const hasSubstantialContent = html.length > 10000 &&
        (lowerHtml.includes('<article') ||
            lowerHtml.includes('<main') ||
            lowerHtml.includes('class="content"') ||
            lowerHtml.includes('class="page"'));

    if (hasSubstantialContent) {
        logger.debug(`[CLOUDFLARE] Has challenge indicators but also substantial content - allowing`);
        return false;
    }

    return isChallengeSize;
}

/**
 * Fetch website HTML with timeout, session tracking, and statistics
 * CRAWLEE-INSPIRED: Uses SessionPool for fingerprinting and tracks metrics
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} - HTML content
 * @throws {Error} - If fetch fails or Cloudflare challenge detected
 */
export async function fetchWebsiteHTML(url, pageContext = null) {
    logger.info(`[STEP 1] Transforming URL to HTML: ${url}`);
    const startTime = Date.now();
    const controller = new AbortController();
    const FETCH_TIMEOUT = CONFIG.rateLimits.emailScraping.timeout || 8000;
    // OBS-1 (2026-05-17): explicit reason. line ~1240 branches on
    // `error.name === 'AbortError'` for circuit-breaker classification —
    // name preserved. URL is already logged at STEP 1 so we keep the
    // message compact (just the timeout value for triage).
    const timeoutId = setTimeout(
        () => controller.abort(new DOMException(`page fetch timeout ${FETCH_TIMEOUT}ms`, 'AbortError')),
        FETCH_TIMEOUT
    );

    // R12 (TIER A): obtain session headers FIRST so the robots.txt fetch and the
    // page fetch share one identity. Previously robots.txt was probed as
    // 'GhostMapProBot' while the page was fetched as Chrome — two faces to one
    // origin, a trivial anti-correlation signal for any defensive site.
    const { headers, sessionId } = await getSessionHeaders();
    const domain = new URL(url).hostname;

    // M8-MISS2 + R12: robots.txt check uses the SAME User-Agent as the page fetch.
    // R3: strictMode behavior is governed by CONFIG.robotsCompliance.strictMode.
    const robotsChecker = container.has('robotsCompliance')
        ? container.get('robotsCompliance')
        : robotsCompliance;
    const isAllowed = await robotsChecker.isAllowed(url, { headers });
    if (!isAllowed) {
        clearTimeout(timeoutId);
        logger.info(`[ROBOTS] Blocked by robots.txt: ${url}`);
        throw new Error('ROBOTS_TXT_DISALLOWED');
    }

    // Build hook context
    const hookContext = {
        url,
        domain,
        sessionId,
        headers,
        pageContext
    };

    // CRAWLEE PHASE 2.1: Execute pre-navigation hooks
    const preResult = await navigationHooks.executePreHooks(hookContext);

    if (preResult.skip) {
        logger.debug(`[NavigationHooks] Pre-hook requested skip for ${url}`);
        clearTimeout(timeoutId);
        throw new Error('HOOK_SKIP_REQUESTED');
    }

    // Apply modified headers from hooks
    const finalHeaders = preResult.modifiedHeaders
        ? { ...headers, ...preResult.modifiedHeaders }
        : headers;

    // Apply modified URL if provided
    const finalUrl = preResult.modifiedUrl || url;

    try {
        const response = await fetch(finalUrl, {
            method: 'GET',
            signal: controller.signal,
            headers: finalHeaders
        });

        clearTimeout(timeoutId);

        // CRAWLEE FEATURE 1.2: Handle blocked status codes
        const statusResult = _getPool().handleStatusCode(sessionId, response.status, domain);
        if (statusResult.retired) {
            // Session was retired, need to fail this request
            throw new Error(`Session retired due to ${response.status} ${statusResult.reason}`);
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        const duration = Date.now() - startTime;

        // CRAWLEE PHASE 2.1: Execute post-navigation hooks
        const postHookContext = {
            ...hookContext,
            response: {
                status: response.status,
                ok: response.ok,
                headers: Object.fromEntries(response.headers.entries()),
                redirected: response.redirected,
                url: response.url
            },
            html
        };

        const postResult = await navigationHooks.executePostHooks(postHookContext);

        // Handle hook-detected blocks
        if (postResult.block) {
            logger.warn(`[NavigationHooks] 🚫 Block detected: ${postResult.blockReason} for ${url}`);
            _getPool().markBad(sessionId, domain);

            // P1-002 FIX: Record circuit breaker failure for hook-detected blocks
            // BUG-5 Step 1: propagate blockReason from NavigationHooks so the
            // adaptive cooldown table picks the correct band (e.g.
            // CLOUDFLARE_PROTECTED → 5min vs DEFAULT 3min).
            await recordCircuitFailure(domain, postResult.blockReason);

            _getStats().recordRequest({
                duration,
                success: false,
                domain,
                error: postResult.blockReason
            });
            throw new Error(postResult.blockReason);
        }

        // Handle hook-requested retry
        if (postResult.retry) {
            logger.warn(`[NavigationHooks] 🔄 Retry requested with delay ${postResult.retryDelay}ms`);
            throw new Error(`HOOK_RETRY_${postResult.retryDelay}`);
        }

        // AUDIT FIX #9: Detect Cloudflare challenge page (backup check)
        if (isCloudflareChallenge(html)) {
            logger.warn(`[CLOUDFLARE] Challenge detected: ${url}`);
            // Record as blocked session
            _getPool().markBad(sessionId, domain);

            // P1-002 FIX: Record circuit breaker failure for Cloudflare blocks
            // BUG-5 Step 1: hard-code CLOUDFLARE_PROTECTED — same constant
            // already used 2 lines below for stats (line 1157) and throw
            // (line 1159). Cooldown 5min (anti-ban) vs DEFAULT 3min.
            await recordCircuitFailure(domain, 'CLOUDFLARE_PROTECTED');

            _getStats().recordRequest({
                duration,
                success: false,
                domain,
                error: 'CLOUDFLARE_PROTECTED'
            });
            throw new Error('CLOUDFLARE_PROTECTED');
        }

        // LOG-002 FIX: Validate HTML response is not empty or minimal
        // Empty/minimal HTML indicates JavaScript-rendered site that needs tab fallback
        const MIN_VALID_HTML_LENGTH = 100;
        if (!html || html.length < MIN_VALID_HTML_LENGTH) {
            logger.warn(`[EMPTY_HTML] Response too short (${html?.length || 0} chars) for ${url}`);
            _getPool().markBad(sessionId, domain);
            _getStats().recordRequest({
                duration,
                success: false,
                domain,
                error: 'empty_html_response'
            });
            throw new Error(`EMPTY_HTML: Response only ${html?.length || 0} chars (min: ${MIN_VALID_HTML_LENGTH})`);
        }

        // Record success
        _getPool().markGood(sessionId, domain);
        _getStats().recordRequest({
            duration,
            success: true,
            domain,
            bytes: html.length
        });

        // CRAWLEE PHASE 3.2: Record success for AutoScaler
        autoScaler.recordResult(true, { domain, duration });

        return html;
    } catch (error) {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;

        // CRAWLEE PHASE 2.1: Execute error hooks
        const errorHookContext = { ...hookContext, error };
        const errorResult = await navigationHooks.executeErrorHooks(errorHookContext, error);

        if (errorResult.handled) {
            logger.debug(`[NavigationHooks] Error handled by hook`);
        }

        // P1-001 FIX: Classify error type to determine session impact
        const errorMsg = String((error && typeof error === 'object' && 'message' in error) ? error.message : error);
        // P1-002 FIX: Normalize to lowercase for case-insensitive matching
        const errorMsgLower = errorMsg.toLowerCase();
        const isNotFoundError = errorMsgLower.includes('http 404') || errorMsgLower.includes('404');
        const isBlockingError = errorMsgLower.includes('captcha') ||
            errorMsgLower.includes('cloudflare') ||
            errorMsgLower.includes('cf-') ||
            errorMsgLower.includes('http 403') ||
            errorMsgLower.includes('http 429');

        // P1-001 FIX: Only mark session as bad for blocking errors, NOT for 404
        // 404 means the page doesn't exist, not that we're blocked
        if (!isNotFoundError) {
            _getPool().markBad(sessionId, domain);
        } else {
            logger.debug(`[SessionPool] Skipping markBad for 404 (page not found, not a block)`);
        }

        // P1-002 FIX: Record circuit breaker failures for blocking errors
        if (isBlockingError) {
            await recordCircuitFailure(domain);
        }

        _getStats().recordRequest({
            duration,
            success: false,
            domain,
            error: error.message
        });

        // CRAWLEE PHASE 3.2: Record failure for AutoScaler
        // FIX: Only record REAL failures that indicate system overload
        // CAPTCHA/Cloudflare/404 are site-specific issues, NOT system problems
        // Recording them causes AutoScaler to reduce concurrency unnecessarily
        const isSystemFailure = !isBlockingError && !isNotFoundError &&
            !errorMsgLower.includes('session retired');

        if (isSystemFailure) {
            autoScaler.recordResult(false, { domain, duration, error: error.message });
        } else {
            // Record as neutral (don't affect scaling decisions)
            logger.debug(`[AutoScaler] Skipping recordResult for ${isBlockingError ? 'blocking' : '404'} error (not a system issue)`);
        }

        if (error.name === 'AbortError') {
            throw new Error(`Timeout after ${FETCH_TIMEOUT}ms`);
        }

        throw error;
    }
}

/**
 * Parse HTML in offscreen document with guaranteed initialization (HIGH FIX #5)
 * @param {string} html - Raw HTML content to parse
 * @param {string} url - Source URL of the HTML (for context)
 * @param {(html: string, url: string) => {emails: string[], socialLinks: Object, contactLinks?: string[], title?: string}} parseHTMLDirect - Fallback parser function if offscreen fails
 * @returns {Promise<{emails: string[], socialLinks: Object, contactLinks?: string[], title?: string}>} Parsed result containing emails and social links
 * @throws {Error} If both offscreen and direct parsing fail
 */
export async function parseHTMLInOffscreen(html, url, parseHTMLDirect) {
    // HIGH FIX #5: Ensure offscreen document exists before sending message
    try {
        await setupOffscreenDocument();
    } catch (setupError) {
        logger.warn('[OFFSCREEN] Setup failed, using direct parsing:', setupError.message);
        return parseHTMLDirect(html, url);
    }

    // B4-5 fix: clear the race-timer on the success path so we don't leak
    // a 10 s closure for every successful parse. On 200+ concurrent parses
    // this previously added ~2 MB peak memory + a wasted CPU tick when the
    // already-resolved race timer fired uselessly.
    let parseTimeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        parseTimeoutId = setTimeout(
            () => reject(new Error('Offscreen timeout after 10s')),
            10000
        );
    });

    try {
        // HIGH FIX #5: Add timeout to prevent hanging
        const response = await Promise.race([
            chrome.runtime.sendMessage({
                action: 'parse_html',
                target: 'offscreen',
                payload: { html, url }
            }),
            timeoutPromise
        ]);

        if (response && response.success && response.source === 'offscreen') {
            return response.data;
        } else {
            logger.warn('[OFFSCREEN] Invalid response, using direct parsing fallback');
            return parseHTMLDirect(html, url);
        }
    } catch (error) {
        logger.warn('[OFFSCREEN] Error, using direct parsing fallback:', error.message);
        return parseHTMLDirect(html, url);
    } finally {
        // Always clear — success and error paths both pass through.
        if (parseTimeoutId) clearTimeout(parseTimeoutId);
    }
}

/**
 * Scrape emails from a business website using SEQUENTIAL page visiting strategy
 * SEQUENTIAL STRATEGY:
 * 1. Discover sitemap to find contact pages
 * 2. Build page list: Homepage → Sitemap pages → Guessed pages
 * 3. Visit pages ONE BY ONE sequentially
 * 4. STOP immediately when first email is found
 * 5. Exhaustive logging at every step for log view visibility
 * 
 * @param {{googleMapsUrl: string, title: string, website: string, phone?: string, email?: string, priority?: number}} business - Business object from database
 * @param {string} [currentBusinessName] - Reference to update current business name for progress tracking
 * @param {(html: string, url: string) => Promise<{emails: string[], socialLinks: Object, contactLinks?: string[]}>} parseHTMLInOffscreenWrapper - Parser function wrapper
 * @returns {Promise<{emails: string[], socialLinks: Object, successfulPage: string|null, duration: number, italianTaxCodes?: {partitaIva: string|null, codiceFiscale: string|null}, skipped?: boolean, skipReason?: string}>} Scraping results with emails, social links, and metadata
 * @throws {Error} If critical error occurs (Cloudflare errors are caught and handled)
 */
export async function scrapeEmailForBusiness(business, currentBusinessName, parseHTMLInOffscreenWrapper) {
    const startTime = Date.now();

    // HIGH-001 FIX: Removed useless currentBusinessName assignment
    // (JS passes strings by value, reassignment has no effect on caller)

    logger.info(`\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`[BUSINESS] Processing: "${business.title}"`);
    logger.info(`[URL] Extracted website: ${business.website}`);
    logger.info(`┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    logger.info(`[DEBUG_UI] scrapeEmailForBusiness called for ${business.title}`);

    // FIX-003: Extract domain for circuit breaker
    let domain = 'unknown';
    try {
        domain = new URL(business.website.startsWith('http') ? business.website : 'https://' + business.website).hostname;
    } catch (e) {
        logger.warn(`[CIRCUIT] Cannot parse domain from: ${business.website}`);
    }

    // FIX-003: Check circuit breaker BEFORE any network operations
    if (await isCircuitOpen(domain)) {
        const duration = Date.now() - startTime;
        logger.warn(`[CIRCUIT] ⏭️ Skipping ${business.title} - domain ${domain} is circuit-open`);
        _getStats().recordRequest({
            duration,
            success: false,
            domain,
            error: 'circuit_open'
        });
        return {
            emails: [],
            socialLinks: {},
            italianTaxCodes: { partitaIva: null, codiceFiscale: null },
            successfulPage: null,
            duration,
            skipped: true,
            skipReason: 'circuit_open'
        };
    }

    // Note: Business processed stats recorded at end with email status

    const allEmails = new Set();
    let socialLinks = {};
    let italianTaxCodes = { partitaIva: null, codiceFiscale: null };  // ITALIAN B2B FEATURE
    let successfulPage = null;
    let lastError = null;
    let blockingErrorOccurred = false; // Track if we hit any CAPTCHA/Cloudflare even if 404s follow

    try {
        const homepageUrl = business.website;

        // ═══════════════════════════════════════════════════════════════════════════
        // P0 OPTIMIZATION: SPECULATIVE PREFETCH
        // Start fetching homepage AND sitemap discovery in parallel
        // This saves 3-8 seconds of blocking sitemap wait time
        // ═══════════════════════════════════════════════════════════════════════════
        const speculativeStart = Date.now();
        logger.info(`┌─────────────────────────────────────────────────────────────────┐`);
        logger.info(`│ [P0 OPTIMIZATION] 🚀 SPECULATIVE PREFETCH STARTED               │`);
        logger.info(`│ Starting parallel: homepage fetch + sitemap discovery           │`);
        logger.info(`└─────────────────────────────────────────────────────────────────┘`);

        // Start both operations simultaneously
        const homepageFetchPromise = fetchWebsiteHTML(homepageUrl).catch(err => {
            logger.warn(`[P0 OPTIMIZATION] Homepage fetch failed: ${err.message}`);
            return null; // Don't fail the whole operation
        });

        const sitemapDiscoveryPromise = sitemapDiscovery.discover(homepageUrl).catch(err => {
            logger.warn(`[SITEMAP] Discovery failed: ${err.message || err}`);
            return []; // Continue with empty array
        });

        // Wait for homepage first (usually faster than sitemap)
        const homepageHtml = await homepageFetchPromise;
        const homepageFetchTime = Date.now() - speculativeStart;

        // Parse homepage IMMEDIATELY while sitemap may still be resolving
        let homepageEmailsFound = false;
        if (homepageHtml) {
            logger.info(`[P0 OPTIMIZATION] ⚡ Homepage fetched in ${homepageFetchTime}ms, parsing while sitemap resolves...`);

            // Check for Cloudflare on homepage
            if (isCloudflareChallenge(homepageHtml)) {
                logger.warn(`⚠ [CLOUDFLARE] Challenge detected on homepage`);
                throw new Error('CLOUDFLARE_PROTECTED');
            }

            const homepageResult = await parseHTMLInOffscreenWrapper(homepageHtml, homepageUrl);

            // Capture Italian tax codes from homepage
            if (homepageResult.italianTaxCodes) {
                if (homepageResult.italianTaxCodes.partitaIva) {
                    italianTaxCodes.partitaIva = homepageResult.italianTaxCodes.partitaIva;
                    logger.info(`[ITALIAN B2B] ✓ Found P.IVA on homepage: ${italianTaxCodes.partitaIva}`);
                }
                if (homepageResult.italianTaxCodes.codiceFiscale) {
                    italianTaxCodes.codiceFiscale = homepageResult.italianTaxCodes.codiceFiscale;
                    logger.info(`[ITALIAN B2B] ✓ Found C.F. on homepage: ${italianTaxCodes.codiceFiscale}`);
                }
            }

            // Capture social links
            if (homepageResult.socialLinks) {
                socialLinks = homepageResult.socialLinks;
            }

            // Check for emails on homepage - EARLY EXIT opportunity!
            if (homepageResult.emails?.length > 0) {
                logger.info(`✓✓✓ [P0 OPTIMIZATION] 🏆 SPECULATIVE WIN! Found ${homepageResult.emails.length} email(s) on HOMEPAGE in ${homepageFetchTime}ms!`);

                homepageResult.emails.forEach(email => {
                    if (allEmails.size < MAX_EMAILS_PER_BUSINESS) {
                        allEmails.add(normalizeEmail(email));
                        _getStats().recordEmail(true);
                    }
                });
                successfulPage = homepageUrl;
                homepageEmailsFound = true;

                // Check if high-confidence email - can skip everything
                const hasHighConfidence = homepageResult.emails.some(email =>
                    isHighConfidenceEmail(email, business.website)
                );

                if (hasHighConfidence) {
                    const totalSpeculativeTime = Date.now() - speculativeStart;
                    logger.info(`┌─────────────────────────────────────────────────────────────────┐`);
                    logger.info(`│ [P0 OPTIMIZATION] 🎯 SPECULATIVE EARLY-EXIT SUCCESS!            │`);
                    logger.info(`│ High-confidence email found on homepage - SKIPPING other pages  │`);
                    logger.info(`│ Time saved: ~${((totalSpeculativeTime * 3) / 1000).toFixed(1)}s (estimated for 3+ page sites)         │`);
                    logger.info(`└─────────────────────────────────────────────────────────────────┘`);

                    // CRITICAL BUG FIX: Must save to database before returning!
                    // Previously emails were found but never persisted
                    const emailList = Array.from(allEmails);
                    const updates = {
                        email: emailList.join(', ') || '',
                        social: socialLinks,
                        emailScraped: true,
                        scrapedAt: Date.now(),
                        scrapedFrom: successfulPage || homepageUrl,
                        partitaIva: italianTaxCodes.partitaIva || null,
                        codiceFiscale: italianTaxCodes.codiceFiscale || null
                    };
                    const updatedBusiness = { ...business, ...updates };
                    await updateBusiness(updatedBusiness);
                    logger.info(`✓✓✓ [SAVE] Saved ${allEmails.size} email(s) to database (speculative early-exit)`);
                    logger.info(`[NEXT] Ready for next business...\n`);

                    // Record success and return immediately
                    await recordCircuitSuccess(domain);
                    _getStats().recordBusinessProcessed(true);
                    return {
                        emails: emailList,
                        socialLinks,
                        italianTaxCodes,
                        successfulPage,
                        duration: Date.now() - startTime,
                        speculativeWin: true
                    };
                }
            }
        }

        // Now await sitemap results (may already be complete)
        const sitemapPages = await sitemapDiscoveryPromise;

        if (sitemapPages.length > 0) {
            logger.info(`✓ [SITEMAP] Found ${sitemapPages.length} contact-related pages`);
            sitemapPages.forEach((page, i) => {
                logger.debug(`  ${i + 1}. ${page}`);
            });
        } else {
            logger.info(`ℹ [SITEMAP] No contact-related pages found in sitemap`);
        }

        // If homepage already found emails AND stopOnFirstSuccess, we're done
        if (homepageEmailsFound && CONFIG.emailScraping.stopOnFirstSuccess) {
            logger.info(`[SPECULATIVE] Homepage emails found, stopOnFirstSuccess=true, skipping other pages`);
            await recordCircuitSuccess(domain);
            _getStats().recordBusinessProcessed(true);
            return {
                emails: Array.from(allEmails),
                socialLinks,
                italianTaxCodes,
                successfulPage,
                duration: Date.now() - startTime,
                speculativeWin: true
            };
        }

        // ═══════════════════════════════════════════════════
        // STEP 2: Build PRIORITIZED page list (Contact → About → Other)
        // Note: Homepage already processed above, exclude from list
        // ═══════════════════════════════════════════════════
        const guessedPages = generatePageUrls(business.website);

        // Use smart prioritization to order pages optimally
        const maxPages = CONFIG.emailScraping.maxPagesPerSite || 5;
        const allPagesToVisit = prioritizePages(
            homepageUrl,
            sitemapPages,
            guessedPages,
            maxPages
        );

        // Filter out homepage since we already processed it in speculative prefetch
        // This prevents duplicate processing and saves time
        const normalizedHomepage = homepageUrl.toLowerCase().replace(/\/$/, '');
        const pagesToVisit = allPagesToVisit.filter(page => {
            const normalizedPage = page.toLowerCase().replace(/\/$/, '');
            return normalizedPage !== normalizedHomepage;
        });

        logger.info(`[OPTIMIZATION] Skipping homepage (already processed), ${pagesToVisit.length} remaining pages to check`);

        // ═══════════════════════════════════════════════════
        // STEP 3: Visit remaining pages SEQUENTIALLY
        // ═══════════════════════════════════════════════════

        // HIGH-002 FIX: Hash main content only, skip dynamic headers/footers
        function quickHash(str) {
            let hash = 0;
            // Extract main content area if present (skip header/footer noise with timestamps/counters)
            let content = str;
            const mainMatch = str.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                str.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                str.match(/<div[^>]*(?:id|class)=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
            if (mainMatch && mainMatch[1] && mainMatch[1].length > 500) {
                content = mainMatch[1];
            }

            // Sample from extracted content
            const sampleSize = 1000;
            const sample = content.length > sampleSize * 2
                ? content.slice(0, sampleSize) + content.slice(-sampleSize)
                : content;

            for (let i = 0; i < sample.length; i++) {
                hash = ((hash << 5) - hash) + sample.charCodeAt(i);
                hash = hash & hash;
            }
            return hash;
        }

        let lastPageHash = null;    // P2-001 FIX: Track page hash to detect duplicates
        let duplicateCount = 0;     // Count consecutive duplicate pages
        const MAX_DUPLICATES = 2;   // Stop after 2 duplicates (likely SPA/redirect site)

        for (let i = 0; i < pagesToVisit.length; i++) {
            const currentPage = pagesToVisit[i];
            const pageNum = i + 1;
            const totalPages = pagesToVisit.length;

            try {
                logger.info(`[PAGE ${pageNum}/${totalPages}] Fetching: ${currentPage}`);

                // Fetch HTML
                logger.info(`[FETCH] Downloading HTML...`);
                const html = await fetchWebsiteHTML(currentPage);
                const pageSize = html.length;
                logger.info(`[HTML] Downloaded ${(pageSize / 1024).toFixed(1)} KB`);

                // P2-001 FIX: Use content hash for duplicate detection on SPAs
                const pageHash = quickHash(html);
                if (lastPageHash !== null && pageHash === lastPageHash) {
                    duplicateCount++;
                    logger.warn(`[DUPLICATE] Same content hash as previous page (${duplicateCount}/${MAX_DUPLICATES})`);

                    if (duplicateCount >= MAX_DUPLICATES) {
                        logger.warn(`[SPA DETECTED] Site appears to be SPA/redirect - stopping page traversal`);
                        break;
                    }
                    continue; // Skip this duplicate page
                } else {
                    duplicateCount = 0; // Reset counter for new unique page
                }
                lastPageHash = pageHash;

                // Check for Cloudflare
                if (isCloudflareChallenge(html)) {
                    logger.warn(`⚠ [CLOUDFLARE] Challenge detected on ${currentPage}`);
                    throw new Error('CLOUDFLARE_PROTECTED');
                }

                // Parse HTML and extract emails
                logger.info(`[PARSE] Transforming HTML to DOM...`);
                const result = await parseHTMLInOffscreenWrapper(html, currentPage);
                logger.info(`✓ [EXTRACT] Extraction complete`);

                // ═══════════════════════════════════════════════════════════════════════════
                // CRITICAL: Capture P.IVA/C.F. FIRST, BEFORE any break statements!
                // This ensures tax codes are captured even when we exit early due to email success
                // ═══════════════════════════════════════════════════════════════════════════
                if (result.italianTaxCodes) {
                    if (result.italianTaxCodes.partitaIva && !italianTaxCodes.partitaIva) {
                        italianTaxCodes.partitaIva = result.italianTaxCodes.partitaIva;
                        logger.info(`[ITALIAN B2B] ✓ Found P.IVA: ${italianTaxCodes.partitaIva}`);
                    }
                    if (result.italianTaxCodes.codiceFiscale && !italianTaxCodes.codiceFiscale) {
                        italianTaxCodes.codiceFiscale = result.italianTaxCodes.codiceFiscale;
                        logger.info(`[ITALIAN B2B] ✓ Found C.F.: ${italianTaxCodes.codiceFiscale}`);
                    }
                }

                // Store social links early too
                if (result.socialLinks && Object.keys(socialLinks).length === 0) {
                    socialLinks = result.socialLinks;
                }

                // Check results
                if (result.emails?.length > 0) {
                    logger.info(`✓✓✓ [EMAIL FOUND] Found ${result.emails.length} email(s): ${result.emails.join(', ')}`);

                    // Add emails to set with memory limit (CRITICAL FIX #3)
                    result.emails.forEach(email => {
                        if (allEmails.size < MAX_EMAILS_PER_BUSINESS) {
                            allEmails.add(normalizeEmail(email));
                            // Record email found
                            _getStats().recordEmail(true);
                        }
                    });
                    successfulPage = currentPage;

                    // MEMORY LIMIT: Early exit if we have enough emails
                    if (allEmails.size >= MAX_EMAILS_PER_BUSINESS) {
                        logger.info(`[MEMORY LIMIT] Collected ${MAX_EMAILS_PER_BUSINESS} emails, stopping`);
                        break;
                    }

                    // Store social links
                    if (result.socialLinks) {
                        socialLinks = result.socialLinks;
                    }

                    // NOTE: Italian tax codes are now extracted OUTSIDE this block
                    // to capture them even when no emails are found on a page

                    // SMART EARLY EXIT: Stop if high-confidence email found
                    const hasHighConfidence = result.emails.some(email =>
                        isHighConfidenceEmail(email, business.website)
                    );

                    if (hasHighConfidence) {
                        const remaining = totalPages - pageNum;
                        logger.info(`🎯 [HIGH CONFIDENCE] Found reliable email, skipping remaining ${remaining} page(s)`);
                        logger.info(`[SUCCESS] Total emails collected: ${allEmails.size}`);
                        break; // Exit the loop immediately
                    } else if (CONFIG.emailScraping.stopOnFirstSuccess) {
                        const remaining = totalPages - pageNum;
                        logger.info(`[STOP] Email found! Skipping remaining ${remaining} page(s)`);
                        logger.info(`[SUCCESS] Total emails collected: ${allEmails.size}`);
                        break; // Exit the loop immediately
                    } else {
                        logger.info(`[CONTINUE] Found email but checking more pages for better results...`);
                    }
                } else {
                    logger.info(`[NO EMAIL] No emails found on this page`);

                    // DYNAMIC DISCOVERY: If this is the homepage (first page) and we found contact links,
                    // add them to our pages to visit (prioritize them by type)
                    if (pageNum === 1 && result.contactLinks && result.contactLinks.length > 0) {
                        const newLinks = result.contactLinks
                            .filter(link => isValidScrapableUrl(link))
                            .filter(link => !pagesToVisit.includes(link))
                            .map(link => ({ url: link, priority: getPagePriority(link) }))
                            .sort((a, b) => a.priority - b.priority) // Contact pages first
                            .slice(0, MAX_DISCOVERED_LINKS) // CRITICAL FIX #3: Limit discovered links
                            .map(p => p.url);

                        if (newLinks.length > 0) {
                            logger.info(`[DISCOVERY] Found ${newLinks.length} contact links on homepage:`);
                            newLinks.forEach((link, i) => {
                                const typeLabel = getPageTypeLabel(getPagePriority(link));
                                logger.info(`  → ${typeLabel} ${link}`);
                            });
                            // Insert with safety limit (CRITICAL FIX #3)
                            if (pagesToVisit.length + newLinks.length <= MAX_PAGES_PER_BUSINESS) {
                                pagesToVisit.splice(pageNum, 0, ...newLinks);
                            } else {
                                logger.warn(`[MEMORY LIMIT] Skipping discovered links, page limit reached`);
                            }
                        }
                    }

                    logger.info(`[CONTINUE] Moving to next page...\n`);
                }

                // NOTE: P.IVA/C.F. and social links are now captured BEFORE the email check
                // at the start of this try block (see lines ~885-902) to ensure they're
                // captured even when we exit early due to finding emails.

            } catch (pageError) {
                // Handle errors for individual pages
                if (pageError.message === 'CLOUDFLARE_PROTECTED') {
                    logger.warn(`⚠ [CLOUDFLARE] Site is Cloudflare-protected, stopping scraping for this business`);
                    lastError = pageError;
                    break; // Stop trying other pages for Cloudflare-protected sites
                }

                // LOG-005 FIX: Always log error with clear message before moving to next page
                const errorMsg = pageError?.message || pageError?.toString() || 'Unknown fetch error';
                logger.warn(`✗ [ERROR] Failed to fetch ${currentPage}: ${errorMsg}`);

                // Track if this was a blocking error that should trigger fallback
                // EXTENDED BLOCKING CHECK (CAPTCHA/403)
                const isBlockingScale = shouldRetryWithTab(pageError) ||
                    errorMsg.toLowerCase().includes('captcha') ||
                    errorMsg.toLowerCase().includes('blocking') ||
                    errorMsg.toLowerCase().includes('403 forbidden');

                if (shouldRetryWithTab(pageError)) {
                    blockingErrorOccurred = true;
                }

                lastError = pageError || new Error(errorMsg);

                // ═══════════════════════════════════════════════════════════════════════════
                // NSA ARCHITECTURE: SENTRY GATE CHECK
                // ═══════════════════════════════════════════════════════════════════════════
                // If the Homepage (Page 1) is blocked by a security measure (CAPTCHA, Cloudflare, etc.),
                // abort the HTTP/S scraping strategy IMMEDIATELY.

                if (i === 0 && isBlockingScale) {
                    logger.warn(`🛑 [OPTIMIZATION] Homepage blocked by security gateway. Aborting traversal.`);
                    logger.info(`[SENTRY] Switching strategy for protected domain: ${domain}`);
                    blockingErrorOccurred = true;
                    // Intentionally break the loop to fall through effectively to the Tab Fallback
                    break;
                }

                // LOG-005 FIX: Changed from [RETRY] to [NEXT PAGE] for clarity
                // This is not a retry of the same page, but moving to the next page in the queue
                logger.info(`[NEXT PAGE] Attempting next URL in queue...\n`);
            }
        }

    } catch (error) {
        lastError = error;

        // AUDIT FIX #9: Handle Cloudflare protection gracefully
        if (error.message === 'CLOUDFLARE_PROTECTED') {
            logger.warn(`[CLOUDFLARE] Site protected: ${business.website}`);

            const cloudflareUpdates = {
                email: '',
                social: {},
                emailScraped: true,
                scrapedAt: Date.now(),
                scrapedFrom: 'cloudflare_protected',
                scrapeError: 'cloudflare_protected'
            };

            const updatedBusiness = { ...business, ...cloudflareUpdates };
            await updateBusiness(updatedBusiness);

            return {
                emails: [],
                socialLinks: {},
                successfulPage: null,
                duration: Date.now() - startTime
            };
        }

        logger.error(`[FATAL] Email scraping failed for ${business.title}:`, error.message);
    }

    // ═══════════════════════════════════════════════════
    // STEP 4: TAB FALLBACK - Try JavaScript Rendering if No Emails Found
    // ═══════════════════════════════════════════════════
    // CRAWLEE-INSPIRED: JavaScript Rendering Fallback
    // https://crawlee.dev/js/docs/guides/javascript-rendering
    // ═══════════════════════════════════════════════════════════════════════════
    // JS-PROTECTED EMAIL FIX: Always try Tab Fallback when no emails found
    // ─────────────────────────────────────────────────────────────────────────────
    // Problem: Previously required blocking error (CAPTCHA/Cloudflare) to trigger
    // But many sites use JavaScript email obfuscation WITHOUT blocking:
    //   - eval() deobfuscation (e.g., valeventi.it)
    //   - data-cfemail encryption
    //   - React/Vue/SPA rendered content
    // 
    // These sites return valid HTML without errors, but email is hidden in JS.
    // Static fetch succeeds but finds 0 emails.
    // 
    // Solution: Trigger Tab Fallback for ANY case with 0 emails found.
    // Tab opens real browser → JavaScript executes → email becomes visible.
    // ═══════════════════════════════════════════════════════════════════════════
    if (allEmails.size === 0) {
        const reason = blockingErrorOccurred
            ? 'Blocking error (CAPTCHA/Cloudflare) detected'
            : 'No emails in static HTML (possible JS obfuscation)';

        logger.info('');
        logger.info('╔═══════════════════════════════════════════════════════════════════');
        logger.info('║ [TAB FALLBACK] 🔄 No emails found via fetch, trying JavaScript rendering...');
        logger.info(`║ [REASON] ${reason}`);
        logger.info('╚═══════════════════════════════════════════════════════════════════');
        logger.info('');

        try {
            const tabResult = await scrapeWithTab(business);

            if (tabResult.emails && tabResult.emails.length > 0) {
                logger.info(`[TAB FALLBACK] ✓✓✓ Success! Found ${tabResult.emails.length} email(s) via Tab`);

                // Add emails to our set
                tabResult.emails.forEach(email => {
                    if (allEmails.size < MAX_EMAILS_PER_BUSINESS) {
                        allEmails.add(normalizeEmail(email));
                        _getStats().recordEmail(true);
                    }
                });

                // Update success tracking
                successfulPage = tabResult.successfulPage;

                // Merge social links if found
                if (tabResult.socialLinks && Object.keys(tabResult.socialLinks).length > 0) {
                    socialLinks = { ...socialLinks, ...tabResult.socialLinks };
                }

                // ITALIAN B2B FEATURE: Merge tax codes if found
                if (tabResult.italianTaxCodes) {
                    if (tabResult.italianTaxCodes.partitaIva && !italianTaxCodes.partitaIva) {
                        italianTaxCodes.partitaIva = tabResult.italianTaxCodes.partitaIva;
                        logger.info(`[TAB FALLBACK] ✓ Found P.IVA: ${italianTaxCodes.partitaIva}`);
                    }
                    if (tabResult.italianTaxCodes.codiceFiscale && !italianTaxCodes.codiceFiscale) {
                        italianTaxCodes.codiceFiscale = tabResult.italianTaxCodes.codiceFiscale;
                        logger.info(`[TAB FALLBACK] ✓ Found C.F.: ${italianTaxCodes.codiceFiscale}`);
                    }
                }

                // Clear the error since we recovered
                lastError = null;
            } else {
                logger.info(`[TAB FALLBACK] ✗ No emails found via Tab either`);
            }
        } catch (tabError) {
            logger.warn(`[TAB FALLBACK] Error during tab scraping: ${tabError.message}`);
            // Continue with original error, don't overwrite lastError
        }
    }

    // ═══════════════════════════════════════════════════
    // STEP 5: Save results to database
    // ═══════════════════════════════════════════════════
    const emailList = Array.from(allEmails);
    const duration = Date.now() - startTime;

    logger.info(`\n┌────────────────────────────────────────`);
    logger.info(`│ [COMPLETE] Finished processing "${business.title}"`);
    logger.info(`├────────────────────────────────────────`);
    logger.info(`│ Emails found: ${emailList.length}`);
    if (emailList.length > 0) {
        logger.info(`│ Email(s): ${emailList.join(', ')}`);
        logger.info(`│ Found on: ${successfulPage}`);
    }
    logger.info(`│ Duration: ${(duration / 1000).toFixed(1)}s`);
    logger.info(`└────────────────────────────────────────\n`);

    // Log current statistics
    const stats = _getStats().getStats();
    logger.info(`[STATS] Session: ${stats.requestsFinished} requests, ${stats.emailsFound} emails, ${stats.successRate} success rate`);
    _getStats().logProgress();

    const updates = {
        email: emailList.join(', ') || '',
        social: socialLinks,
        emailScraped: true,
        scrapedAt: Date.now(),
        scrapedFrom: successfulPage || 'failed',
        // ITALIAN B2B FEATURE: Store tax codes
        partitaIva: italianTaxCodes.partitaIva || null,
        codiceFiscale: italianTaxCodes.codiceFiscale || null
    };

    // If we found no emails, record the last error
    if (allEmails.size === 0 && lastError) {
        updates.scrapeError = lastError.message;
    }

    const updatedBusiness = { ...business, ...updates };
    await updateBusiness(updatedBusiness);

    // Record business processing with email status (moved from start to end)
    const foundEmail = allEmails.size > 0;
    _getStats().recordBusinessProcessed(foundEmail);

    // FIX-003: Record circuit breaker result
    if (foundEmail) {
        await recordCircuitSuccess(domain);
        logger.info(`✓✓✓ [SAVE] Saved ${allEmails.size} email(s) to database`);
        logger.info(`[NEXT] Ready for next business...\n`);
    } else {
        // CRIT-002 FIX: Record circuit result even for empty sites
        if (lastError) {
            await recordCircuitFailure(domain);
        } else {
            // Clean scrape with no emails = site is healthy, reset failure count
            await recordCircuitSuccess(domain);
            logger.debug(`[CIRCUIT] ✓ Domain ${domain} healthy (no errors, no emails)`);
        }
        logger.warn(`⚠ [SAVE] No emails found for: ${business.title}`);
        logger.info(`[NEXT] Moving to next business...\n`);
    }

    return {
        emails: Array.from(allEmails),
        socialLinks,
        italianTaxCodes,  // CRIT-001 FIX: Return P.IVA/C.F. data
        successfulPage,
        duration
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRAWLEE-INSPIRED EXPORTS - Statistics and State Management
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get full crawler statistics
 * @returns {Object} Complete statistics object
 */
export function getCrawlerStats() {
    return _getStats().getStats();
}

/**
 * Get compact stats for UI display
 * @returns {string} Compact stats string
 */
export function getCompactStats() {
    return _getStats().getCompactStats();
}

/**
 * Get session pool statistics
 * @returns {Object} Session pool stats
 */
export function getSessionStats() {
    return _getPool().getStats();
}

/**
 * Start statistics auto-logging
 */
export function startStatistics() {
    _getStats().start();
}

/**
 * Stop statistics auto-logging
 */
export function stopStatistics() {
    _getStats().stop();
}

/**
 * Reset all statistics
 */
export function resetStatistics() {
    _getStats().reset();
}

/**
 * Persist crawler state (sessions + statistics)
 * @returns {Promise<void>}
 */
export async function persistState() {
    await _getPool().persist();
    logger.info('[STATE] Crawler state persisted');
}

/**
 * Restore crawler state from storage
 * @returns {Promise<void>}
 */
export async function restoreState() {
    await _getPool().restore();
    logger.info('[STATE] Crawler state restored');
}

export default {
    isValidScrapableUrl,
    generatePageUrls,
    normalizeEmail,
    getRotatingHeaders,
    getSessionHeaders,
    isCloudflareChallenge,
    fetchWebsiteHTML,
    parseHTMLInOffscreen,
    scrapeEmailForBusiness,
    // Crawlee-inspired exports
    getCrawlerStats,
    getCompactStats,
    getSessionStats,
    startStatistics,
    stopStatistics,
    resetStatistics,
    persistState,
    restoreState,
    // HIGH-003 FIX: Export circuit breaker functions for TabScraperFallback
    isCircuitOpen,
    recordCircuitSuccess,
    recordCircuitFailure
};
