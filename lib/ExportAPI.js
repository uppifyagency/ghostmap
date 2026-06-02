/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * 
 * IO6: Export API Infrastructure
 * Unified API layer for programmatic data access
 * 
 * STEP 1/3: Core Infrastructure
 * - Data retrieval methods
 * - Query filtering
 * - Pagination support
 * - Authentication layer (API key validation)
 */

'use strict';

import { getBusinesses, getStats, getBusiness as getBusinessFromDB } from './db.js';
import { logger, escapeCsv } from './utils.js';
import { CONFIG } from './config.js';
import { Mutex } from './mutex.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * API Version for compatibility tracking
 * @type {string}
 */
export const API_VERSION = '1.0.0';

/**
 * Default pagination limits
 * @type {Object}
 */
const PAGINATION_DEFAULTS = {
    limit: 100,
    maxLimit: 1000,
    offset: 0
};

/**
 * API Message Types for internal communication
 * @type {Object}
 */
export const API_MESSAGE_TYPES = {
    // Query Operations
    API_GET_BUSINESSES: 'api_get_businesses',
    API_GET_STATS: 'api_get_stats',
    API_GET_BUSINESS: 'api_get_business',

    // Export Operations
    API_EXPORT_JSON: 'api_export_json',
    API_EXPORT_CSV: 'api_export_csv',
    API_EXPORT_MARKDOWN: 'api_export_markdown',

    // Webhook Operations (Step 3)
    API_REGISTER_WEBHOOK: 'api_register_webhook',
    API_UNREGISTER_WEBHOOK: 'api_unregister_webhook',
    API_LIST_WEBHOOKS: 'api_list_webhooks',

    // Meta Operations
    API_GET_VERSION: 'api_get_version',
    API_HEALTH_CHECK: 'api_health_check'
};

/**
 * Error codes for API responses
 * @type {Object}
 */
export const API_ERRORS = {
    INVALID_REQUEST: { code: 'E001', message: 'Invalid request format' },
    UNAUTHORIZED: { code: 'E002', message: 'Invalid or missing API key' },
    NOT_FOUND: { code: 'E003', message: 'Resource not found' },
    DATABASE_ERROR: { code: 'E004', message: 'Database operation failed' },
    RATE_LIMITED: { code: 'E005', message: 'Rate limit exceeded' },
    INVALID_PARAMS: { code: 'E006', message: 'Invalid query parameters' },
    INTERNAL_ERROR: { code: 'E099', message: 'Internal server error' }
};

// =============================================================================
// API KEY MANAGEMENT
// =============================================================================

/**
 * API Key storage key
 * @private
 */
const API_KEY_STORAGE = 'ghost_map_api_key';

/**
 * Generate a secure API key
 * Uses crypto.getRandomValues for cryptographic randomness
 * @returns {string} 32-character hexadecimal API key
 */
export function generateApiKey() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get or create API key for this extension instance
 * @returns {Promise<string>} API key
 */
export async function getOrCreateApiKey() {
    try {
        const result = await chrome.storage.local.get(API_KEY_STORAGE);

        if (result[API_KEY_STORAGE]) {
            return result[API_KEY_STORAGE];
        }

        // Generate new key
        const newKey = generateApiKey();
        await chrome.storage.local.set({ [API_KEY_STORAGE]: newKey });
        logger.info('[ExportAPI] Generated new API key');
        return newKey;

    } catch (error) {
        logger.error('[ExportAPI] Failed to get/create API key:', error);
        throw error;
    }
}

/**
 * Validate provided API key
 * @param {string} providedKey - Key to validate
 * @returns {Promise<boolean>} True if valid
 */
export async function validateApiKey(providedKey) {
    if (!providedKey || typeof providedKey !== 'string') {
        return false;
    }

    try {
        const result = await chrome.storage.local.get(API_KEY_STORAGE);
        const storedKey = result[API_KEY_STORAGE];
        if (!storedKey || typeof storedKey !== 'string') {
            return false;
        }
        // LIB-3 FIX (2026-05-11): pre-fix used `===` which short-circuits
        // on the first differing char. The leaked timing signal is dwarfed
        // by chrome.runtime.sendMessage round-trip variance (~ms vs the
        // ns/char compare leak), so exploitability is theoretical — but
        // constant-time compare is industry-standard for any API-key /
        // secret comparison and costs ~32 cycles. Always preferable.
        // Length is invariant for legitimate keys (generateApiKey() always
        // returns 32-char hex) so the length check up-front leaks nothing
        // useful.
        return constantTimeEqual(storedKey, providedKey);
    } catch (error) {
        logger.error('[ExportAPI] API key validation error:', error);
        return false;
    }
}

/**
 * Constant-time string equality. Returns false fast on length mismatch
 * (length is non-secret for fixed-format keys), then XOR-scans the full
 * remainder so the running time depends only on `a.length`, not on
 * where the first diverging char sits.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

/**
 * Regenerate API key (invalidates old key)
 * @returns {Promise<string>} New API key
 */
export async function regenerateApiKey() {
    const newKey = generateApiKey();
    await chrome.storage.local.set({ [API_KEY_STORAGE]: newKey });
    logger.info('[ExportAPI] API key regenerated');
    return newKey;
}

// =============================================================================
// QUERY BUILDING & VALIDATION
// =============================================================================

/**
 * Validate and normalize query parameters
 * @param {Object} params - Raw query parameters
 * @returns {Object} Normalized parameters with defaults
 */
export function normalizeQueryParams(params = {}) {
    const normalized = {
        limit: PAGINATION_DEFAULTS.limit,
        offset: PAGINATION_DEFAULTS.offset,
        filters: {},
        sort: { field: 'timestamp', order: 'desc' }
    };

    // Pagination
    if (params.limit !== undefined) {
        const limit = parseInt(params.limit, 10);
        if (!isNaN(limit) && limit > 0) {
            normalized.limit = Math.min(limit, PAGINATION_DEFAULTS.maxLimit);
        }
    }

    if (params.offset !== undefined) {
        const offset = parseInt(params.offset, 10);
        if (!isNaN(offset) && offset >= 0) {
            normalized.offset = offset;
        }
    }

    // Filters
    if (params.hasEmail !== undefined) {
        normalized.filters.hasEmail = params.hasEmail === true || params.hasEmail === 'true';
    }

    if (params.hasPhone !== undefined) {
        normalized.filters.hasPhone = params.hasPhone === true || params.hasPhone === 'true';
    }

    if (params.hasWebsite !== undefined) {
        normalized.filters.hasWebsite = params.hasWebsite === true || params.hasWebsite === 'true';
    }

    if (params.category && typeof params.category === 'string') {
        normalized.filters.category = params.category.trim();
    }

    if (params.emailScraped !== undefined) {
        normalized.filters.emailScraped = params.emailScraped === true || params.emailScraped === 'true';
    }

    if (params.since && !isNaN(Date.parse(params.since))) {
        normalized.filters.since = new Date(params.since).getTime();
    }

    if (params.until && !isNaN(Date.parse(params.until))) {
        normalized.filters.until = new Date(params.until).getTime();
    }

    // Sorting
    const validSortFields = ['timestamp', 'title', 'category', 'scrapedAt'];
    if (params.sortBy && validSortFields.includes(params.sortBy)) {
        normalized.sort.field = params.sortBy;
    }

    if (params.sortOrder && ['asc', 'desc'].includes(params.sortOrder.toLowerCase())) {
        normalized.sort.order = params.sortOrder.toLowerCase();
    }

    return normalized;
}

/**
 * Apply filters to business array
 * @param {Array} businesses - Array of business objects
 * @param {Object} filters - Filter criteria
 * @returns {Array} Filtered businesses
 */
export function applyFilters(businesses, filters = {}) {
    if (!Array.isArray(businesses)) {
        return [];
    }

    return businesses.filter(business => {
        // Email filter
        if (filters.hasEmail === true && (!business.email || business.email.trim() === '')) {
            return false;
        }
        if (filters.hasEmail === false && business.email && business.email.trim() !== '') {
            return false;
        }

        // Phone filter
        if (filters.hasPhone === true && (!business.phone || business.phone.trim() === '')) {
            return false;
        }
        if (filters.hasPhone === false && business.phone && business.phone.trim() !== '') {
            return false;
        }

        // Website filter
        if (filters.hasWebsite === true && (!business.website || business.website.trim() === '')) {
            return false;
        }
        if (filters.hasWebsite === false && business.website && business.website.trim() !== '') {
            return false;
        }

        // Category filter (case-insensitive contains)
        if (filters.category) {
            const businessCategory = (business.category || '').toLowerCase();
            const filterCategory = filters.category.toLowerCase();
            if (!businessCategory.includes(filterCategory)) {
                return false;
            }
        }

        // Email scraped filter
        if (filters.emailScraped !== undefined && business.emailScraped !== filters.emailScraped) {
            return false;
        }

        // Date range filters
        const timestamp = business.timestamp || business.scrapedAt || 0;
        if (filters.since && timestamp < filters.since) {
            return false;
        }
        if (filters.until && timestamp > filters.until) {
            return false;
        }

        return true;
    });
}

/**
 * Apply sorting to business array
 * @param {Array} businesses - Array of business objects
 * @param {Object} sort - Sort configuration { field, order }
 * @returns {Array} Sorted businesses
 */
export function applySorting(businesses, sort = {}) {
    if (!Array.isArray(businesses) || businesses.length === 0) {
        return businesses;
    }

    const { field = 'timestamp', order = 'desc' } = sort;
    const multiplier = order === 'asc' ? 1 : -1;

    return [...businesses].sort((a, b) => {
        const aVal = a[field] || '';
        const bVal = b[field] || '';

        if (typeof aVal === 'number' && typeof bVal === 'number') {
            return (aVal - bVal) * multiplier;
        }

        return String(aVal).localeCompare(String(bVal)) * multiplier;
    });
}

/**
 * Apply pagination to business array
 * @param {Array} businesses - Array of business objects
 * @param {number} limit - Max items to return
 * @param {number} offset - Items to skip
 * @returns {Object} Paginated result with metadata
 */
export function applyPagination(businesses, limit, offset) {
    if (!Array.isArray(businesses)) {
        return {
            data: [],
            pagination: { total: 0, limit, offset, hasMore: false }
        };
    }

    const total = businesses.length;
    const paginatedData = businesses.slice(offset, offset + limit);
    const hasMore = offset + paginatedData.length < total;

    return {
        data: paginatedData,
        pagination: {
            total,
            limit,
            offset,
            count: paginatedData.length,
            hasMore,
            nextOffset: hasMore ? offset + limit : null
        }
    };
}

// =============================================================================
// CORE API METHODS
// =============================================================================

/**
 * Get businesses with filtering, sorting, and pagination
 * Primary API endpoint for data retrieval
 * 
 * @param {Object} params - Query parameters
 * @param {number} [params.limit=100] - Max records to return (max 1000)
 * @param {number} [params.offset=0] - Records to skip
 * @param {boolean} [params.hasEmail] - Filter by email presence
 * @param {boolean} [params.hasPhone] - Filter by phone presence
 * @param {boolean} [params.hasWebsite] - Filter by website presence
 * @param {string} [params.category] - Filter by category (contains)
 * @param {boolean} [params.emailScraped] - Filter by scrape status
 * @param {string} [params.since] - ISO date string for start range
 * @param {string} [params.until] - ISO date string for end range
 * @param {string} [params.sortBy] - Sort field (timestamp, title, category)
 * @param {string} [params.sortOrder] - Sort order (asc, desc)
 * @returns {Promise<Object>} API response with data and pagination
 */
export async function queryBusinesses(params = {}) {
    const startTime = performance.now();

    try {
        // Normalize parameters
        const normalized = normalizeQueryParams(params);

        // Get all businesses from database
        const allBusinesses = await getBusinesses();

        // Apply filters
        let filtered = applyFilters(allBusinesses, normalized.filters);

        // Apply sorting
        filtered = applySorting(filtered, normalized.sort);

        // Apply pagination
        const result = applyPagination(filtered, normalized.limit, normalized.offset);

        const duration = Math.round(performance.now() - startTime);

        logger.debug(`[ExportAPI] Query completed: ${result.pagination.count}/${result.pagination.total} in ${duration}ms`);

        return {
            success: true,
            apiVersion: API_VERSION,
            data: result.data,
            pagination: result.pagination,
            meta: {
                query: normalized,
                executionTimeMs: duration
            }
        };

    } catch (error) {
        logger.error('[ExportAPI] queryBusinesses error:', error);
        return {
            success: false,
            error: API_ERRORS.DATABASE_ERROR,
            message: error.message
        };
    }
}

/**
 * Get a single business by Google Maps URL
 * @param {string} googleMapsUrl - Business URL (primary key)
 * @returns {Promise<Object>} API response with business data
 */
export async function getBusiness(googleMapsUrl) {
    try {
        if (!googleMapsUrl || typeof googleMapsUrl !== 'string') {
            return {
                success: false,
                error: API_ERRORS.INVALID_PARAMS,
                message: 'googleMapsUrl is required'
            };
        }

        const business = await getBusinessFromDB(googleMapsUrl);

        if (!business) {
            return {
                success: false,
                error: API_ERRORS.NOT_FOUND,
                message: 'Business not found'
            };
        }

        return {
            success: true,
            apiVersion: API_VERSION,
            data: business
        };

    } catch (error) {
        logger.error('[ExportAPI] getBusiness error:', error);
        return {
            success: false,
            error: API_ERRORS.DATABASE_ERROR,
            message: error.message
        };
    }
}

/**
 * Get database statistics
 * @returns {Promise<Object>} API response with stats
 */
export async function getStatistics() {
    const startTime = performance.now();

    try {
        const stats = await getStats();
        const duration = Math.round(performance.now() - startTime);

        return {
            success: true,
            apiVersion: API_VERSION,
            data: {
                ...stats,
                exportApiEnabled: true,
                webhooksEnabled: false // Step 3
            },
            meta: {
                executionTimeMs: duration
            }
        };

    } catch (error) {
        logger.error('[ExportAPI] getStatistics error:', error);
        return {
            success: false,
            error: API_ERRORS.DATABASE_ERROR,
            message: error.message
        };
    }
}

// =============================================================================
// STEP 2: EXPORT FORMAT METHODS
// =============================================================================

/**
 * Escape CSV value to prevent injection and handle special characters
 * @param {*} value - Value to escape
 * @returns {string} Escaped CSV value
 */
/**
 * Escape CSV value using centralized escapeCsv from utils.js
 * M6-SEC1 FIX: Previous implementation lacked formula injection prevention.
 * Now delegates to escapeCsv which handles =, +, -, @, DDE patterns, and special chars.
 */
function escapeCsvValue(value) {
    return escapeCsv(value);
}

/**
 * Clean email string for export (removes tracking/spam patterns)
 * @param {string} rawEmails - Raw email string (comma-separated)
 * @returns {string} Cleaned email string
 */
function cleanEmails(rawEmails) {
    if (!rawEmails || typeof rawEmails !== 'string') return '';

    const blockedPatterns = [
        'sentry.io', 'wixpress.com', 'sentry.wixpress',
        'mailchimp.com', 'sendgrid.net', 'example.com',
        'test.com', 'temp.com', 'placeholder.com',
        'noreply', 'no-reply', 'donotreply'
    ];

    const emails = rawEmails.split(/[,;]/).map(e => e.trim()).filter(e => e);
    const cleanedEmails = [];

    for (const email of emails) {
        const cleanEmail = email.toLowerCase().trim();
        if (!cleanEmail || !cleanEmail.includes('@')) continue;

        const [localPart, domain] = cleanEmail.split('@');
        if (!localPart || !domain) continue;

        // Skip blocked domains
        if (blockedPatterns.some(p => domain.includes(p) || localPart.includes(p))) continue;

        // Skip UUID-like local parts
        if (localPart.length >= 20 && /^[a-f0-9]+$/.test(localPart)) continue;

        // Skip too-short local parts
        if (localPart.length < 2) continue;

        cleanedEmails.push(email.trim());
    }

    return cleanedEmails.join(', ');
}

/**
 * Export businesses as CSV format
 * Supports filtering via query params
 * 
 * @param {Object} params - Query parameters (same as queryBusinesses)
 * @returns {Promise<Object>} API response with CSV string
 */
export async function exportAsCSV(params = {}) {
    const startTime = performance.now();

    try {
        // Get filtered data using existing query logic
        const queryResult = await queryBusinesses({ ...params, limit: 10000 }); // Higher limit for exports

        if (!queryResult.success) {
            return queryResult; // Pass through error
        }

        const businesses = queryResult.data;

        if (businesses.length === 0) {
            return {
                success: true,
                apiVersion: API_VERSION,
                format: 'csv',
                data: '',
                count: 0,
                message: 'No businesses match the query'
            };
        }

        // Generate CSV headers
        const headers = [
            'Title', 'Category', 'Phone', 'Website', 'Email', 'Status',
            'Partita IVA', 'Codice Fiscale', 'Rating', 'Reviews',
            'Address', 'Google Maps URL', 'Scraped At'
        ];

        // Generate CSV rows
        const rows = businesses.map(b => [
            escapeCsvValue(b.title),
            escapeCsvValue(b.category),
            escapeCsvValue(b.phone),
            escapeCsvValue(b.website),
            escapeCsvValue(cleanEmails(b.email)),
            b.emailScraped ? (b.email ? 'success' : 'no_email') : 'pending',
            escapeCsvValue(b.partitaIva || ''),
            escapeCsvValue(b.codiceFiscale || ''),
            b.rating || '',
            b.reviews || '',
            escapeCsvValue(b.address),
            escapeCsvValue(b.googleMapsUrl),
            b.scrapedAt ? new Date(b.scrapedAt).toISOString() : ''
        ]);

        const csv = [
            headers.join(','),
            ...rows.map(r => r.join(','))
        ].join('\n');

        const duration = Math.round(performance.now() - startTime);

        return {
            success: true,
            apiVersion: API_VERSION,
            format: 'csv',
            data: csv,
            count: businesses.length,
            filename: `ghost_map_export_${Date.now()}.csv`,
            meta: {
                query: params,
                executionTimeMs: duration
            }
        };

    } catch (error) {
        logger.error('[ExportAPI] exportAsCSV error:', error);
        return {
            success: false,
            error: API_ERRORS.DATABASE_ERROR,
            message: error.message
        };
    }
}

/**
 * Export businesses as Markdown format
 * Returns clean email list or full business table based on options
 * 
 * @param {Object} params - Query parameters
 * @param {boolean} [params.emailsOnly=false] - If true, return only email list
 * @returns {Promise<Object>} API response with Markdown string
 */
export async function exportAsMarkdown(params = {}) {
    const startTime = performance.now();
    const emailsOnly = params.emailsOnly === true || params.emailsOnly === 'true';

    try {
        const queryResult = await queryBusinesses({ ...params, limit: 10000 });

        if (!queryResult.success) {
            return queryResult;
        }

        const businesses = queryResult.data;

        if (businesses.length === 0) {
            return {
                success: true,
                apiVersion: API_VERSION,
                format: 'markdown',
                data: '# No Data\n\nNo businesses match the query.',
                count: 0
            };
        }

        let markdown;
        let itemCount;

        if (emailsOnly) {
            // Extract unique emails only
            const uniqueEmails = new Set();

            businesses.forEach(b => {
                if (b.email) {
                    const cleaned = cleanEmails(b.email);
                    cleaned.split(',').map(e => e.trim()).filter(e => e)
                        .forEach(email => uniqueEmails.add(email.toLowerCase()));
                }
            });

            if (uniqueEmails.size === 0) {
                return {
                    success: true,
                    apiVersion: API_VERSION,
                    format: 'markdown',
                    data: '# No Emails Found\n\nNo valid emails in the selected businesses.',
                    count: 0
                };
            }

            const sortedEmails = Array.from(uniqueEmails).sort();
            markdown = `# Email Export\n\n**Total:** ${sortedEmails.length} unique emails\n\n${sortedEmails.join('\n')}`;
            itemCount = sortedEmails.length;

        } else {
            // Full business table
            const lines = [
                '# Business Export',
                '',
                `**Total:** ${businesses.length} businesses`,
                '',
                '| Title | Category | Email | Website | Phone |',
                '|-------|----------|-------|---------|-------|'
            ];

            businesses.forEach(b => {
                const email = cleanEmails(b.email) || '-';
                const title = (b.title || 'Unknown').replace(/\|/g, '/');
                const category = (b.category || '-').replace(/\|/g, '/');
                const website = b.website || '-';
                const phone = b.phone || '-';

                lines.push(`| ${title} | ${category} | ${email} | ${website} | ${phone} |`);
            });

            markdown = lines.join('\n');
            itemCount = businesses.length;
        }

        const duration = Math.round(performance.now() - startTime);

        return {
            success: true,
            apiVersion: API_VERSION,
            format: 'markdown',
            data: markdown,
            count: itemCount,
            filename: emailsOnly
                ? `ghost_map_emails_${Date.now()}.md`
                : `ghost_map_export_${Date.now()}.md`,
            meta: {
                emailsOnly,
                query: params,
                executionTimeMs: duration
            }
        };

    } catch (error) {
        logger.error('[ExportAPI] exportAsMarkdown error:', error);
        return {
            success: false,
            error: API_ERRORS.DATABASE_ERROR,
            message: error.message
        };
    }
}

/**
 * Export businesses as JSON format
 * Enhanced version of queryBusinesses with file download metadata
 * 
 * @param {Object} params - Query parameters (same as queryBusinesses)
 * @returns {Promise<Object>} API response with JSON string
 */
export async function exportAsJSON(params = {}) {
    const startTime = performance.now();

    try {
        const queryResult = await queryBusinesses({ ...params, limit: 10000 });

        if (!queryResult.success) {
            return queryResult;
        }

        // Clean emails in the data
        const cleanedData = queryResult.data.map(b => ({
            ...b,
            email: cleanEmails(b.email)
        }));

        const duration = Math.round(performance.now() - startTime);

        return {
            success: true,
            apiVersion: API_VERSION,
            format: 'json',
            data: JSON.stringify({
                exportedAt: new Date().toISOString(),
                count: cleanedData.length,
                businesses: cleanedData
            }, null, 2),
            count: cleanedData.length,
            filename: `ghost_map_export_${Date.now()}.json`,
            meta: {
                query: params,
                executionTimeMs: duration
            }
        };

    } catch (error) {
        logger.error('[ExportAPI] exportAsJSON error:', error);
        return {
            success: false,
            error: API_ERRORS.DATABASE_ERROR,
            message: error.message
        };
    }
}

// =============================================================================
// STEP 3: WEBHOOK INFRASTRUCTURE
// =============================================================================

/**
 * Webhook storage key
 * @private
 */
const WEBHOOK_STORAGE_KEY = 'ghost_map_webhooks';

// LIB-4 FIX (2026-05-10): serialize register/unregister read-modify-write on
// chrome.storage.local. Pre-fix two API_REGISTER_WEBHOOK requests arriving in
// the same event-loop tick would each call getWebhooks() → push → save with
// no locking; the second writer's save overwrote the first writer's added
// webhook (last-writer-wins). Webhook D was silently lost while the API
// response to caller D incorrectly indicated success. unregisterWebhook
// shares the same get→splice→save shape and is wrapped under the same lock.
//
// LIB-4 FIX (2026-05-27): triggerWebhooks now also uses _webhookMutex,
// but only for the post-batch counter merge — HTTP fetches stay in
// parallel. The per-webhook callback aggregates deltas into a local
// Map and a single mutex.runExclusive at the end re-reads the latest
// webhooks array, applies the deltas, and saves. Pre-fix two concurrent
// triggerWebhooks() calls overwrote each other's stat increments.
const _webhookMutex = new Mutex();

/**
 * Webhook event types
 * @type {Object}
 */
export const WEBHOOK_EVENTS = {
    BUSINESS_ADDED: 'business.added',
    BUSINESS_UPDATED: 'business.updated',
    EMAIL_SCRAPED: 'email.scraped',
    EXPORT_COMPLETED: 'export.completed',
    SCRAPING_STARTED: 'scraping.started',
    SCRAPING_COMPLETED: 'scraping.completed'
};

/**
 * Maximum webhooks per user
 * @private
 */
const MAX_WEBHOOKS = 10;

/**
 * Webhook timeout in ms
 * @private
 */
const WEBHOOK_TIMEOUT = 10000;

/**
 * Get all registered webhooks
 * @returns {Promise<Array>} Array of webhook objects
 */
export async function getWebhooks() {
    try {
        const result = await chrome.storage.local.get(WEBHOOK_STORAGE_KEY);
        return result[WEBHOOK_STORAGE_KEY] || [];
    } catch (error) {
        logger.error('[ExportAPI] Failed to get webhooks:', error);
        return [];
    }
}

/**
 * Save webhooks to storage
 * @param {Array} webhooks - Array of webhook objects
 * @returns {Promise<void>}
 */
async function saveWebhooks(webhooks) {
    await chrome.storage.local.set({ [WEBHOOK_STORAGE_KEY]: webhooks });
}

/**
 * Generate unique webhook ID
 * @returns {string} 8-char hex ID
 */
function generateWebhookId() {
    const array = new Uint8Array(4);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * LIB-2 FIX (2026-05-10): determine whether a hostname (string from URL.hostname)
 * is an IP literal in a private / link-local / loopback / cloud-metadata range.
 *
 * Pre-fix `isValidWebhookUrl` checked only `protocol === 'https:'`. If an
 * attacker obtained the API key (32 hex chars in chrome.storage.local), they
 * could call API_REGISTER_WEBHOOK with `https://169.254.169.254/...` (AWS
 * metadata), `https://10.0.0.1/admin`, or `https://localhost:3000/...` and the
 * extension's privileged context would happily POST de-identified business
 * payloads to that destination — confused-deputy SSRF reaching the user's LAN
 * or cloud metadata endpoints.
 *
 * Known limitation: DNS rebinding (a hostname that resolves to a private IP
 * after passing this check) is NOT defended here. A complete fix would
 * pre-resolve DNS and pin the resolved IP, which is out of scope for an
 * extension. The check below stops literal-IP and obvious local-name attacks.
 *
 * @param {string} hostname
 * @returns {boolean} true if the hostname is a banned IP literal / local name
 */
// ─── BUG-1 FIX (2026-05-27): IPv6 SSRF bypass close — Option B parser+bitmask ───
// Reference: docs/feature/fix-ipv6-ssrf-bypass/deliver/rca.md
//
// Replaces the string-prefix IPv6 blocklist (4 categories) with a proper
// parser → uint16[8] → bitmask check. Coverage now includes ALL of:
//   ::/128, ::1, fe80::/10, fc00::/7, ff00::/8, ::ffff:0:0/96 (v4-mapped,
//   recurses to isBannedIPv4), ::/96 v4-compatible (deprecated, reject
//   defensively), 64:ff9b::/96 NAT64 (recurses), 64:ff9b:1::/48 NAT64
//   local-use, 100::/64 discard-only, 2001:db8::/32 documentation.
// Fail-closed: parser returns null on any malformed input → caller treats
// as private (rejected).

/**
 * Reject a parsed IPv4 (4 octets, each 0-255) if it falls in any banned
 * range. Extracted from the inline v4 branch so v4-mapped IPv6 can reuse
 * the exact same set of rules.
 * @returns {boolean} true if address is banned
 */
function isBannedIPv4(a, b, c, d) {
    if ([a, b, c, d].some(v => !Number.isInteger(v) || v < 0 || v > 255)) return true;
    if (a === 127) return true;                              // 127.0.0.0/8 loopback
    if (a === 10) return true;                               // 10.0.0.0/8 RFC1918
    if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16.0.0/12
    if (a === 169 && b === 254) return true;                 // 169.254.0.0/16 link-local + AWS metadata
    if (a === 0) return true;                                // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;       // 100.64.0.0/10 CGNAT
    // DEBT-NEW-6 (2026-05-27): RFC 5737 documentation ranges. IANA-reserved,
    // should never be a legitimate webhook destination. Public DNS does not
    // resolve these ranges so the attack surface is bounded, but a webhook
    // URL using a literal IP in one of these blocks should be rejected on
    // principle (RFC enumeration completeness for the BUG-1 SSRF guard,
    // see docs/security-audit.md Appendix A §1).
    if (a === 192 && b === 0 && c === 2) return true;        // 192.0.2.0/24 RFC 5737 TEST-NET-1
    if (a === 198 && b === 51 && c === 100) return true;     // 198.51.100.0/24 RFC 5737 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true;      // 203.0.113.0/24 RFC 5737 TEST-NET-3
    // DEBT-NEW-6 (2026-05-27): RFC 2544 benchmarking range. Reserved for
    // inter-network device benchmarking; same rationale as RFC 5737.
    if (a === 198 && (b === 18 || b === 19)) return true;    // 198.18.0.0/15 RFC 2544
    if (a >= 224) return true;                               // 224+ multicast / reserved
    return false;
}

/**
 * Parse an IPv6 literal into a normalized array of 8 uint16 groups, or
 * null if invalid. Handles:
 *   - compressed form with "::" (exactly one occurrence)
 *   - fully expanded form (8 groups separated by ":")
 *   - mixed/dotted-quad embedded form (last 32 bits as a.b.c.d, e.g.
 *     ::ffff:127.0.0.1, 64:ff9b::a.b.c.d)
 * Any malformed input → null. Caller MUST treat null as "fail-closed
 * reject" so we never silently allow a literal we can't parse.
 * @param {string} h - lowercased hostname with brackets already stripped
 * @returns {number[]|null} 8 uint16 groups, or null
 */
function parseIPv6ToGroups(h) {
    if (typeof h !== 'string' || h.length === 0) return null;
    if (h.indexOf(':') < 0) return null;

    // Reject more than one "::" — only one elision allowed (RFC 5952).
    const doubleColonCount = (h.match(/::/g) || []).length;
    if (doubleColonCount > 1) return null;

    // Split a possibly-mixed v4-in-v6 tail: ::ffff:127.0.0.1 form.
    // If the rightmost segment contains dots, it must be a dotted-quad and
    // becomes two 16-bit hex groups appended to the head.
    let workingStr = h;
    let v4Tail = null;
    const lastColonIdx = h.lastIndexOf(':');
    const tail = h.slice(lastColonIdx + 1);
    if (tail.indexOf('.') >= 0) {
        const v4m = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (!v4m) return null;
        const oct = v4m.slice(1).map(Number);
        if (oct.some(v => v < 0 || v > 255)) return null;
        v4Tail = [(oct[0] << 8) | oct[1], (oct[2] << 8) | oct[3]];
        workingStr = h.slice(0, lastColonIdx) + ':0:0';  // placeholder we'll replace
    }

    // Split into head/tail around "::" (if present).
    let groupsStrs;
    if (doubleColonCount === 1) {
        const [left, right] = workingStr.split('::');
        const leftGroups = left === '' ? [] : left.split(':');
        const rightGroups = right === '' ? [] : right.split(':');
        const totalExplicit = leftGroups.length + rightGroups.length;
        if (totalExplicit > 7) return null;  // "::" must elide ≥1 group → max 7 explicit
        const zerosNeeded = 8 - totalExplicit;
        groupsStrs = [...leftGroups, ...Array(zerosNeeded).fill('0'), ...rightGroups];
    } else {
        groupsStrs = workingStr.split(':');
        if (groupsStrs.length !== 8) return null;
    }

    // Parse each group as 1-4 hex chars → uint16.
    const groups = new Array(8);
    for (let i = 0; i < 8; i++) {
        const s = groupsStrs[i];
        if (!/^[0-9a-f]{1,4}$/.test(s)) return null;
        groups[i] = parseInt(s, 16);
    }

    // If we extracted a v4 tail, overwrite the last two groups with the
    // computed values (replaces the "0:0" placeholder we inserted above).
    if (v4Tail !== null) {
        groups[6] = v4Tail[0];
        groups[7] = v4Tail[1];
    }

    return groups;
}

/**
 * Check a parsed IPv6 (8 uint16 groups) against banned ranges. Delegates
 * to isBannedIPv4 for IPv4-mapped (::ffff:0:0/96) and NAT64 well-known
 * (64:ff9b::/96) since the embedded IPv4 must satisfy the same rules.
 * @returns {boolean} true if address is banned
 */
function isBannedIPv6(g) {
    if (g === null || g.length !== 8) return true;  // fail-closed

    // ::/128 unspecified + ::1 loopback (groups 0..6 all zero).
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
        g[4] === 0 && g[5] === 0 && g[6] === 0) {
        return true;  // covers :: and ::1
    }

    // fe80::/10 link-local (high 10 bits = 1111 1110 10xx xxxx).
    if ((g[0] & 0xffc0) === 0xfe80) return true;

    // fc00::/7 unique-local (high 7 bits = 1111 110x).
    if ((g[0] & 0xfe00) === 0xfc00) return true;

    // ff00::/8 multicast.
    if ((g[0] & 0xff00) === 0xff00) return true;

    // ::ffff:0:0/96 IPv4-mapped — first 80 bits zero, group[5] === 0xffff.
    // Recurse into IPv4 rules with the embedded octets.
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
        g[4] === 0 && g[5] === 0xffff) {
        return isBannedIPv4(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
    }

    // ::/96 IPv4-compatible IPv6 (deprecated, RFC 4291 §2.5.5.1) — first
    // 96 bits zero. Reject defensively: the form is deprecated and embeds
    // an IPv4 payload that should also be checked.
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
        g[4] === 0 && g[5] === 0) {
        return true;
    }

    // 64:ff9b::/96 NAT64 well-known (RFC 6052) — recurse into IPv4.
    if (g[0] === 0x0064 && g[1] === 0xff9b &&
        g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
        return isBannedIPv4(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
    }

    // 64:ff9b:1::/48 NAT64 local-use (RFC 8215). Whole /48 rejected
    // regardless of embedded payload — local-use namespace by definition.
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return true;

    // 100::/64 discard-only (RFC 6666) — high 64 bits = 0100::.
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;

    // 2001:db8::/32 documentation prefix (RFC 3849).
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;

    // ─── NEW-1 (BUG-1 post-audit, 2026-05-27): RFC enumeration completeness ───
    // Red Hat senior audit flagged 4 IPv6 prefixes missing from the bitmask.
    // None were regressions (pre-fix code also let them through), but if the
    // strategy is enumeration, enumerate completely.

    // 2002::/16 6to4 (RFC 3056). Encapsulates IPv4 in groups[1]+groups[2].
    // A 6to4 packet to 2002:7f00:1:: is decapsulated by a 6to4 relay and
    // forwarded to the embedded IPv4 (127.0.0.1 here). Recurse into IPv4
    // rules — public IPv4 inside 6to4 stays allowed (e.g. 2002:0808:0808::
    // for 8.8.8.8). RFC 7526 deprecates 6to4 but routing persists in legacy
    // networks. The embedded octets are: group[1] high+low byte = a.b,
    // group[2] high+low byte = c.d.
    if (g[0] === 0x2002) {
        return isBannedIPv4(g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff);
    }

    // 2001::/32 Teredo (RFC 4380). IPv6-over-UDP-over-IPv4 tunnel; the
    // embedded server+client IPv4 is XOR-obfuscated and complex to validate.
    // Reject the entire /32 — Teredo is essentially obsolete for modern
    // hosts and a webhook to a Teredo address is a strong signal of attack
    // intent. Discriminate by groups[0]==0x2001 AND groups[1]==0x0000 (the
    // Teredo prefix is 2001:0::/32; canonical form has group[1] zero).
    if (g[0] === 0x2001 && g[1] === 0x0000) return true;

    // fec0::/10 deprecated site-local (RFC 3879). Some legacy stacks still
    // route this; block conservatively. High 10 bits = 1111 1110 11xx xxxx.
    if ((g[0] & 0xffc0) === 0xfec0) return true;

    // 2001:2::/48 RFC 5180 benchmarking namespace. Not production-routable
    // — a webhook destination here is either a misconfiguration or attack.
    if (g[0] === 0x2001 && g[1] === 0x0002 && g[2] === 0x0000) return true;

    return false;
}

function isPrivateOrSpecialAddr(hostname) {
    if (!hostname) return true;
    // Strip brackets that URL.hostname adds around IPv6 literals
    const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();

    // Reject literal "localhost"
    if (h === 'localhost') return true;

    // IPv4 dotted-quad
    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const o = v4.slice(1).map(Number);
        return isBannedIPv4(o[0], o[1], o[2], o[3]);
    }

    // IPv6 literal (any colon-bearing form once brackets stripped).
    // Parser+bitmask supersedes the old 4-prefix string blocklist.
    if (h.includes(':')) {
        const g = parseIPv6ToGroups(h);
        if (g === null) return true;  // fail-closed on any malformed literal
        return isBannedIPv6(g);
    }

    return false;
}

// BUG-1 testability hook: expose internal SSRF guard for the pure-Node
// regression runner at tests/run-export-api-ssrf-ipv6-node.mjs. Keeps the
// production call site unchanged; isPrivateOrSpecialAddr is still consumed
// only by isValidWebhookUrl in this module.
export { isPrivateOrSpecialAddr as _isPrivateOrSpecialAddr_for_tests };

// ─── NEW-2 (BUG-1 post-audit, 2026-05-27): two-layer webhook revalidation ──
// Audit identified that isValidWebhookUrl ran only at registerWebhook time
// (line ~1190). Webhooks persisted in chrome.storage.local under a weaker
// guard (pre-c34c93c) remained armed after deploy. Mitigation:
//
//   Layer 1 — cleanupInvalidWebhooks(): one-shot, called at SW init by the
//   background script. Filters stored webhooks against current
//   isValidWebhookUrl, writes back the cleaned set, structured-logs each
//   removal at WARN for retroactive anomaly detection.
//
//   Layer 2 — triggerWebhooks fire-time guard: defensive re-check before
//   each fetch(). Hot-path cost: ~1µs per webhook (URL parse + 4 string
//   compares). Bounded by MAX_WEBHOOKS=10 so worst case is ~10µs per event.
//
// The pure partition function `_filterValidWebhooks` is reused by both
// layers; the test runner imports it via _filterValidWebhooks_for_tests
// to assert the partition logic in isolation.

/**
 * Pure: partition a webhook array into {valid, removed} using the current
 * isValidWebhookUrl. No I/O, no logging — safe to call in hot path.
 * Defensive against non-array inputs (returns safe empty result).
 * @param {Array<{id?: string, url?: string}>} webhooks
 * @returns {{valid: Array, removed: Array<{id?: string, url?: string}>}}
 */
function _filterValidWebhooks(webhooks) {
    if (!Array.isArray(webhooks)) return { valid: [], removed: [] };
    const valid = [];
    const removed = [];
    for (const w of webhooks) {
        if (w && typeof w === 'object' && isValidWebhookUrl(w.url)) {
            valid.push(w);
        } else {
            removed.push(w || { id: '<missing>', url: '<missing>' });
        }
    }
    return { valid, removed };
}

export { _filterValidWebhooks as _filterValidWebhooks_for_tests };

/**
 * One-shot cleanup of stored webhooks. Called at SW init by background/
 * index.js after ExportAPI loads, OR triggered manually. Idempotent.
 * Structured-logs each removal so a retroactive scan of dev logs can
 * surface webhooks that were registered under a weaker guard.
 *
 * Wrapped in `_webhookMutex` to coordinate with register/unregister.
 *
 * @returns {Promise<{removed: Array<{id, url}>, kept: number}>} `removed`
 *   is the array of dropped records (for caller logging/telemetry); `kept`
 *   is the count of survivors. On error returns `{removed: [], kept: -1}`.
 */
export async function cleanupInvalidWebhooks() {
    return await _webhookMutex.runExclusive(async () => {
        try {
            const webhooks = await getWebhooks();
            const { valid, removed } = _filterValidWebhooks(webhooks);
            if (removed.length > 0) {
                for (const w of removed) {
                    let host = 'unknown';
                    try { host = new URL(w.url).hostname; } catch { /* malformed — host stays 'unknown' */ }
                    logger.warn(`[ExportAPI] cleanupInvalidWebhooks: removed id=${w.id} host=${host} (failed isValidWebhookUrl post-guard-update)`);
                }
                await saveWebhooks(valid);
            }
            return { removed, kept: valid.length };
        } catch (error) {
            logger.error('[ExportAPI] cleanupInvalidWebhooks error:', error);
            return { removed: [], kept: -1 };
        }
    });
}

/**
 * Validate webhook URL
 * @param {string} url - URL to validate
 * @returns {boolean} True if valid HTTPS URL pointing at a public host
 */
function isValidWebhookUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        const hostname = parsed.hostname;
        // Reject IP literals to private / loopback / link-local / metadata
        // ranges, plus literal "localhost" (LIB-2).
        if (isPrivateOrSpecialAddr(hostname)) return false;
        // Reject hostnames with no dot (intranet shorthand, single-label
        // resolution, etc.).
        if (!hostname.includes('.')) return false;
        // Reject IDN punycode names (homograph attack defense).
        if (hostname.includes('xn--')) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Register a new webhook
 * @param {Object} params - Webhook parameters
 * @param {string} params.url - HTTPS endpoint URL
 * @param {Array<string>} params.events - Event types to subscribe to
 * @param {string} [params.secret] - Optional secret for HMAC signing
 * @param {string} [params.name] - Optional friendly name
 * @returns {Promise<Object>} API response with webhook details
 */
export async function registerWebhook(params = {}) {
    // LIB-4 FIX: serialize entire validate-read-modify-write under _webhookMutex.
    return _webhookMutex.runExclusive(async () => {
        const { url, events, secret, name } = params;
        try {

        // Validate URL
        if (!url || !isValidWebhookUrl(url)) {
            return {
                success: false,
                error: API_ERRORS.INVALID_PARAMS,
                message: 'Valid HTTPS URL is required'
            };
        }

        // Validate events
        const validEvents = Object.values(WEBHOOK_EVENTS);
        const requestedEvents = Array.isArray(events) ? events : [];
        const invalidEvents = requestedEvents.filter(e => !validEvents.includes(e));

        if (requestedEvents.length === 0) {
            return {
                success: false,
                error: API_ERRORS.INVALID_PARAMS,
                message: `At least one event required. Valid events: ${validEvents.join(', ')}`
            };
        }

        if (invalidEvents.length > 0) {
            return {
                success: false,
                error: API_ERRORS.INVALID_PARAMS,
                message: `Invalid events: ${invalidEvents.join(', ')}`
            };
        }

        // Check limits
        const existingWebhooks = await getWebhooks();
        if (existingWebhooks.length >= MAX_WEBHOOKS) {
            return {
                success: false,
                error: API_ERRORS.RATE_LIMITED,
                message: `Maximum ${MAX_WEBHOOKS} webhooks allowed`
            };
        }

        // Check for duplicate URL
        if (existingWebhooks.some(w => w.url === url)) {
            return {
                success: false,
                error: API_ERRORS.INVALID_PARAMS,
                message: 'Webhook URL already registered'
            };
        }

        // Create webhook
        const webhook = {
            id: generateWebhookId(),
            url,
            events: requestedEvents,
            secret: secret || null,
            name: name || `Webhook ${existingWebhooks.length + 1}`,
            createdAt: Date.now(),
            lastTriggered: null,
            successCount: 0,
            failureCount: 0,
            enabled: true
        };

        // Save
        existingWebhooks.push(webhook);
        await saveWebhooks(existingWebhooks);

        logger.info('[ExportAPI] Webhook registered:', webhook.id, webhook.url);

        return {
            success: true,
            apiVersion: API_VERSION,
            webhook: {
                id: webhook.id,
                url: webhook.url,
                events: webhook.events,
                name: webhook.name,
                createdAt: new Date(webhook.createdAt).toISOString()
            }
        };

        } catch (error) {
            logger.error('[ExportAPI] registerWebhook error:', error);
            return {
                success: false,
                error: API_ERRORS.INTERNAL_ERROR,
                message: error.message
            };
        }
    });
}

/**
 * Unregister a webhook
 * @param {string} webhookId - Webhook ID to remove
 * @returns {Promise<Object>} API response
 */
export async function unregisterWebhook(webhookId) {
    // LIB-4 FIX: serialize get-modify-set under same mutex as registerWebhook.
    return _webhookMutex.runExclusive(async () => {
        try {
            if (!webhookId) {
                return {
                    success: false,
                    error: API_ERRORS.INVALID_PARAMS,
                    message: 'Webhook ID is required'
                };
            }

            const webhooks = await getWebhooks();
            const index = webhooks.findIndex(w => w.id === webhookId);

            if (index === -1) {
                return {
                    success: false,
                    error: API_ERRORS.NOT_FOUND,
                    message: 'Webhook not found'
                };
            }

            const removed = webhooks.splice(index, 1)[0];
            await saveWebhooks(webhooks);

            logger.info('[ExportAPI] Webhook unregistered:', webhookId);

            return {
                success: true,
                apiVersion: API_VERSION,
                message: `Webhook ${removed.name} removed`
            };

        } catch (error) {
            logger.error('[ExportAPI] unregisterWebhook error:', error);
            return {
                success: false,
                error: API_ERRORS.INTERNAL_ERROR,
                message: error.message
            };
        }
    });
}

/**
 * List all registered webhooks
 * @returns {Promise<Object>} API response with webhooks
 */
export async function listWebhooks() {
    try {
        const webhooks = await getWebhooks();

        return {
            success: true,
            apiVersion: API_VERSION,
            count: webhooks.length,
            maxWebhooks: MAX_WEBHOOKS,
            webhooks: webhooks.map(w => ({
                id: w.id,
                url: w.url,
                name: w.name,
                events: w.events,
                enabled: w.enabled,
                successCount: w.successCount,
                failureCount: w.failureCount,
                lastTriggered: w.lastTriggered ? new Date(w.lastTriggered).toISOString() : null,
                createdAt: new Date(w.createdAt).toISOString()
            }))
        };

    } catch (error) {
        logger.error('[ExportAPI] listWebhooks error:', error);
        return {
            success: false,
            error: API_ERRORS.INTERNAL_ERROR,
            message: error.message
        };
    }
}

/**
 * Create HMAC signature for webhook payload
 * @param {string} payload - JSON payload string
 * @param {string} secret - Secret key
 * @returns {Promise<string>} Hex signature
 */
async function createWebhookSignature(payload, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Trigger webhooks for an event
 * @param {string} event - Event type from WEBHOOK_EVENTS
 * @param {Object} data - Event data payload
 * @returns {Promise<Object>} Trigger results
 */
export async function triggerWebhooks(event, data = {}) {
    try {
        const webhooks = await getWebhooks();
        const relevantWebhooks = webhooks.filter(w => w.enabled && w.events.includes(event));

        if (relevantWebhooks.length === 0) {
            return { triggered: 0, success: 0, failed: 0 };
        }

        // NEW-2 (BUG-1 post-audit, 2026-05-27): fire-time defensive
        // re-validation. cleanupInvalidWebhooks() runs at SW init but a
        // webhook registered under a weaker guard could still be present
        // if cleanup is pending or didn't run yet on this session. Cost
        // ~1µs/webhook, bounded by MAX_WEBHOOKS=10. Skipped webhooks are
        // logged for retroactive scan; counters reflect only what we
        // actually attempted to deliver.
        const { valid: safeWebhooks, removed: skipped } = _filterValidWebhooks(relevantWebhooks);
        if (skipped.length > 0) {
            for (const w of skipped) {
                let host = 'unknown';
                try { host = new URL(w.url).hostname; } catch { /* malformed */ }
                logger.warn(`[ExportAPI] triggerWebhooks: SKIPPED webhook id=${w.id} host=${host} event=${event} (failed isValidWebhookUrl fire-time re-check)`);
            }
        }
        if (safeWebhooks.length === 0) {
            return { triggered: 0, success: 0, failed: 0, skipped_invalid: skipped.length };
        }

        const results = {
            triggered: safeWebhooks.length,
            success: 0,
            failed: 0,
            skipped_invalid: skipped.length,
            details: []
        };

        const payload = {
            event,
            timestamp: new Date().toISOString(),
            apiVersion: API_VERSION,
            data
        };

        const payloadString = JSON.stringify(payload);

        // LIB-4 FIX (2026-05-27): aggregate per-webhook stat deltas in a
        // local Map during the parallel HTTP batch. The map is the ONLY
        // mutable state shared across the .map() callbacks (besides the
        // local `results` accumulator) — the `safeWebhooks` snapshot is
        // treated as read-only. The post-batch merge applies the deltas
        // to a freshly-read array under _webhookMutex (atomic vs other
        // triggerWebhooks/register/unregister calls). HTTP fetches stay
        // unserialised; only the storage RMW is critical-region.
        const statDeltas = new Map(); // webhookId → { succ, fail, lastTriggered }

        // Trigger all webhooks in parallel — NEW-2: iterate safeWebhooks
        // (filtered subset) instead of relevantWebhooks so URLs that fail
        // the fire-time guard never reach fetch().
        const triggerPromises = safeWebhooks.map(async (webhook) => {
            const controller = new AbortController();
            // OBS-1 (2026-05-17): explicit reason. line 1284 branches on
            // `err.name === 'AbortError'` to render 'Timeout' in the UI —
            // keep name as 'AbortError' to preserve that path; message is
            // for debug-log triage. Webhook URL omitted from reason
            // (user-controlled, may contain secrets in path/query).
            const webhookHost = (() => { try { return new URL(webhook.url).hostname; } catch { return 'unknown'; } })();
            const timeoutId = setTimeout(
                () => controller.abort(new DOMException(`webhook fetch timeout ${WEBHOOK_TIMEOUT}ms host=${webhookHost}`, 'AbortError')),
                WEBHOOK_TIMEOUT
            );
            // DEBT-5 (2026-05-27): per-delivery latency for structured log.
            const deliveryStart = Date.now();

            // Helper: record a delta for this webhook (replaces the
            // pre-fix direct counter mutation on the shared snapshot).
            const recordDelta = (kind) => {
                const cur = statDeltas.get(webhook.id) ?? { succ: 0, fail: 0, lastTriggered: 0 };
                if (kind === 'succ') cur.succ++; else cur.fail++;
                cur.lastTriggered = Date.now();
                statDeltas.set(webhook.id, cur);
            };

            try {
                const headers = {
                    'Content-Type': 'application/json',
                    'X-GhostMap-Event': event,
                    'X-GhostMap-Delivery': generateWebhookId()
                };

                // Add signature if secret exists
                if (webhook.secret) {
                    headers['X-GhostMap-Signature'] = await createWebhookSignature(payloadString, webhook.secret);
                }

                const response = await fetch(webhook.url, {
                    method: 'POST',
                    headers,
                    body: payloadString,
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                const deliveryMs = Date.now() - deliveryStart;

                if (response.ok) {
                    recordDelta('succ');
                    results.success++;
                    results.details.push({ id: webhook.id, status: 'success', httpStatus: response.status });
                    // DEBT-5 (2026-05-27): structured success log for retroactive
                    // anomaly scan. `host=` lets a SOC dev scan for malicious
                    // destinations that were fired before cleanupInvalidWebhooks
                    // landed (BUG-1 NEW-2 mitigation flow). Token-stable format.
                    logger.info(`[ExportAPI] webhook delivered host=${webhookHost} event=${event} id=${webhook.id} status=${response.status} ms=${deliveryMs}`);
                } else {
                    recordDelta('fail');
                    results.failed++;
                    results.details.push({ id: webhook.id, status: 'failed', httpStatus: response.status });
                    // DEBT-5 structured fail log — same shape, WARN level.
                    logger.warn(`[ExportAPI] webhook delivery FAILED host=${webhookHost} event=${event} id=${webhook.id} status=${response.status} ms=${deliveryMs}`);
                }

            } catch (err) {
                clearTimeout(timeoutId);
                recordDelta('fail');
                results.failed++;
                const reason = err.name === 'AbortError' ? 'Timeout' : (err.message || 'unknown');
                results.details.push({
                    id: webhook.id,
                    status: 'error',
                    error: reason
                });
                // DEBT-5 structured error log — distinct reason= field for
                // network / abort / TLS failures vs HTTP-status failures above.
                const deliveryMs = Date.now() - deliveryStart;
                logger.warn(`[ExportAPI] webhook delivery ERROR host=${webhookHost} event=${event} id=${webhook.id} reason=${reason} ms=${deliveryMs}`);
            }
        });

        await Promise.allSettled(triggerPromises);

        // LIB-4 FIX (2026-05-27): apply accumulated deltas under the same
        // mutex used by register/unregister, re-reading the persisted
        // array so we never overwrite concurrent counter updates from a
        // sibling triggerWebhooks() call. The re-read is essential — the
        // initial `webhooks` snapshot is stale by definition the moment
        // we await any HTTP call.
        if (statDeltas.size > 0) {
            await _webhookMutex.runExclusive(async () => {
                const fresh = await getWebhooks();
                let dirty = false;
                for (const [id, d] of statDeltas) {
                    const w = fresh.find(x => x.id === id);
                    if (!w) continue; // webhook removed during batch — drop deltas
                    w.successCount = (w.successCount || 0) + d.succ;
                    w.failureCount = (w.failureCount || 0) + d.fail;
                    if (d.lastTriggered) w.lastTriggered = d.lastTriggered;
                    dirty = true;
                }
                if (dirty) await saveWebhooks(fresh);
            });
        }

        logger.debug(`[ExportAPI] Webhooks triggered for ${event}: ${results.success}/${results.triggered} success`);

        return results;

    } catch (error) {
        logger.error('[ExportAPI] triggerWebhooks error:', error);
        return { triggered: 0, success: 0, failed: 0, error: error.message };
    }
}

/**
 * Health check endpoint
 * @returns {Object} Health status
 */
export function healthCheck() {
    return {
        success: true,
        apiVersion: API_VERSION,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        features: {
            queryBusinesses: true,
            exportJson: true,
            exportCsv: true,
            exportMarkdown: true,
            webhooks: true
        }
    };
}

/**
 * Get API version info
 * @returns {Object} Version information
 */
export function getVersionInfo() {
    return {
        success: true,
        apiVersion: API_VERSION,
        extensionVersion: CONFIG.version || '1.0.0',
        schemaVersion: CONFIG.db.version || 2
    };
}

// =============================================================================
// MESSAGE HANDLER
// =============================================================================

/**
 * Handle API messages from external sources
 * Central router for all API operations
 * 
 * @param {Object} message - Message object
 * @param {string} message.action - API action type
 * @param {string} [message.apiKey] - API key for authentication
 * @param {Object} [message.params] - Action parameters
 * @param {Object} sender - Chrome message sender
 * @returns {Promise<Object>} API response
 */
export async function handleApiMessage(message, sender) {
    const { action, apiKey, params = {} } = message;

    // Validate API key for protected endpoints
    const protectedActions = [
        API_MESSAGE_TYPES.API_GET_BUSINESSES,
        API_MESSAGE_TYPES.API_GET_BUSINESS,
        API_MESSAGE_TYPES.API_GET_STATS,
        API_MESSAGE_TYPES.API_EXPORT_JSON,
        API_MESSAGE_TYPES.API_EXPORT_CSV,
        API_MESSAGE_TYPES.API_EXPORT_MARKDOWN
    ];

    if (protectedActions.includes(action)) {
        const isValid = await validateApiKey(apiKey);
        if (!isValid) {
            logger.warn('[ExportAPI] Unauthorized access attempt');
            return {
                success: false,
                error: API_ERRORS.UNAUTHORIZED
            };
        }
    }

    // Route to appropriate handler
    switch (action) {
        case API_MESSAGE_TYPES.API_GET_BUSINESSES:
            return queryBusinesses(params);

        case API_MESSAGE_TYPES.API_GET_BUSINESS:
            return getBusiness(params.googleMapsUrl);

        case API_MESSAGE_TYPES.API_GET_STATS:
            return getStatistics();

        case API_MESSAGE_TYPES.API_EXPORT_JSON:
            return exportAsJSON(params);

        case API_MESSAGE_TYPES.API_EXPORT_CSV:
            return exportAsCSV(params);

        case API_MESSAGE_TYPES.API_EXPORT_MARKDOWN:
            return exportAsMarkdown(params);

        case API_MESSAGE_TYPES.API_REGISTER_WEBHOOK:
            return registerWebhook(params);

        case API_MESSAGE_TYPES.API_UNREGISTER_WEBHOOK:
            return unregisterWebhook(params.webhookId);

        case API_MESSAGE_TYPES.API_LIST_WEBHOOKS:
            return listWebhooks();

        case API_MESSAGE_TYPES.API_GET_VERSION:
            return getVersionInfo();

        case API_MESSAGE_TYPES.API_HEALTH_CHECK:
            return healthCheck();

        default:
            return {
                success: false,
                error: API_ERRORS.INVALID_REQUEST,
                message: `Unknown action: ${action}`
            };
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

export const ExportAPI = {
    // Version
    VERSION: API_VERSION,

    // Message Types
    MESSAGES: API_MESSAGE_TYPES,

    // Errors
    ERRORS: API_ERRORS,

    // Webhook Events (Step 3)
    WEBHOOK_EVENTS,

    // API Key Management
    getOrCreateApiKey,
    validateApiKey,
    regenerateApiKey,

    // Core Methods
    queryBusinesses,
    getBusiness,
    getStatistics,
    healthCheck,
    getVersionInfo,

    // Export Formats (Step 2)
    exportAsCSV,
    exportAsMarkdown,
    exportAsJSON,

    // Webhooks (Step 3)
    registerWebhook,
    unregisterWebhook,
    listWebhooks,
    getWebhooks,
    triggerWebhooks,

    // Utilities
    normalizeQueryParams,
    applyFilters,
    applySorting,
    applyPagination,

    // Message Handler
    handleApiMessage
};

export default ExportAPI;

logger.info('[ExportAPI] Module loaded - Step 3/3 Complete (Webhooks Enabled)');
