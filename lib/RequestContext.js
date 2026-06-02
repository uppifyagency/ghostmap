/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 * 
 * INSPIRED BY: Crawlee Request Context
 * https://crawlee.dev/js/docs/guides/request-storage
 */

/**
 * Ghost Map Pro - Request Context
 * Unified context object passed to all request handlers
 * Provides consistent API for:
 * - Request metadata
 * - Session info
 * - Logging
 * - Error tracking
 * - Duration metrics
 * 
 * CRAWLEE FEATURE 2.3
 */

import { logger } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST CONTEXT CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class RequestContext {
    /**
     * Create a new RequestContext
     * @param {Object} options - Context options
     * @param {string} options.url - Request URL
     * @param {string} [options.id] - Unique request ID
     * @param {number} [options.retryCount] - Current retry count
     * @param {Object} [options.session] - Associated session
     * @param {Object} [options.userData] - Custom user data
     * @param {string} [options.label] - Request label/type
     */
    constructor(options = {}) {
        // ─────────────────────────────────────────────────────────────────────────
        // Request Metadata
        // ─────────────────────────────────────────────────────────────────────────
        this.request = {
            id: options.id || this._generateId(),
            url: options.url,
            loadedUrl: options.url, // Will be updated after redirects
            uniqueKey: options.uniqueKey || this._normalizeUrl(options.url),
            method: options.method || 'GET',
            headers: options.headers || {},
            retryCount: options.retryCount || 0,
            maxRetries: options.maxRetries || 3,
            noRetry: options.noRetry || false,
            errorMessages: [],
            userData: options.userData || {},
            label: options.label || 'default',
            handledAt: null
        };

        // ─────────────────────────────────────────────────────────────────────────
        // Domain Info
        // ─────────────────────────────────────────────────────────────────────────
        try {
            const urlObj = new URL(options.url);
            this.domain = urlObj.hostname;
            this.protocol = urlObj.protocol;
            this.pathname = urlObj.pathname;
        } catch {
            this.domain = 'unknown';
            this.protocol = 'https:';
            this.pathname = '/';
        }

        // ─────────────────────────────────────────────────────────────────────────
        // Session
        // ─────────────────────────────────────────────────────────────────────────
        // BUG-Bulk-Falsy-Defaults: `||` → `??` consistency (codemod 2026-05-09).
        this.session = options.session ?? null;
        this.sessionId = options.session?.id || null;

        // ─────────────────────────────────────────────────────────────────────────
        // Response (populated after fetch)
        // ─────────────────────────────────────────────────────────────────────────
        this.response = null;
        this.html = null;
        this.contentType = null;
        this.contentLength = 0;

        // ─────────────────────────────────────────────────────────────────────────
        // Timing
        // ─────────────────────────────────────────────────────────────────────────
        this.startTime = Date.now();
        this.endTime = null;
        this.fetchDuration = null;
        this.processingDuration = null;

        // ─────────────────────────────────────────────────────────────────────────
        // State
        // ─────────────────────────────────────────────────────────────────────────
        this.state = 'pending'; // pending, fetching, processing, completed, failed
        this.wasRetried = false;
        this.skipReason = null;

        // ─────────────────────────────────────────────────────────────────────────
        // Extracted Data
        // ─────────────────────────────────────────────────────────────────────────
        this.extractedData = {
            emails: [],
            phones: [],
            socialLinks: {},
            metadata: {}
        };

        // ─────────────────────────────────────────────────────────────────────────
        // Context-aware Logger
        // ─────────────────────────────────────────────────────────────────────────
        this.log = this._createLogger();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Mark request as fetching
     */
    startFetch() {
        this.state = 'fetching';
        this.fetchStartTime = Date.now();
    }

    /**
     * Mark fetch as complete, record response
     * @param {Response} response - Fetch response
     * @param {string} html - Response HTML
     */
    completeFetch(response, html) {
        this.fetchDuration = Date.now() - (this.fetchStartTime || this.startTime);
        
        this.response = {
            status: response?.status,
            statusText: response?.statusText,
            ok: response?.ok,
            headers: this._extractHeaders(response),
            redirected: response?.redirected,
            url: response?.url
        };
        
        this.html = html;
        this.contentLength = html?.length || 0;
        this.contentType = response?.headers?.get?.('content-type') || 'text/html';
        
        // Update loaded URL if redirected
        if (response?.url && response.url !== this.request.url) {
            this.request.loadedUrl = response.url;
        }
        
        this.state = 'processing';
    }

    /**
     * Mark request as completed successfully
     */
    complete() {
        this.endTime = Date.now();
        this.state = 'completed';
        this.request.handledAt = new Date().toISOString();
        this.processingDuration = this.endTime - this.startTime - (this.fetchDuration || 0);
    }

    /**
     * Mark request as failed
     * @param {Error|string} error - Error that caused failure
     */
    fail(error) {
        this.endTime = Date.now();
        this.state = 'failed';
        this.pushErrorMessage(error);
    }

    /**
     * Mark request as skipped
     * @param {string} reason - Reason for skipping
     */
    skip(reason) {
        this.state = 'skipped';
        this.skipReason = reason;
        this.endTime = Date.now();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ERROR TRACKING
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Add an error message to the request
     * @param {Error|string} error - Error to record
     */
    pushErrorMessage(error) {
        const errorEntry = {
            message: error?.message || String(error),
            stack: error?.stack || null,
            timestamp: Date.now(),
            retryCount: this.request.retryCount
        };
        this.request.errorMessages.push(errorEntry);
    }

    /**
     * Get the last error message
     * @returns {Object|null} Last error entry
     */
    getLastError() {
        const errors = this.request.errorMessages;
        return errors.length > 0 ? errors[errors.length - 1] : null;
    }

    /**
     * Check if this request has errors
     * @returns {boolean}
     */
    hasErrors() {
        return this.request.errorMessages.length > 0;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DATA EXTRACTION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Add extracted emails
     * @param {string|string[]} emails - Email(s) to add
     */
    addEmails(emails) {
        const toAdd = Array.isArray(emails) ? emails : [emails];
        toAdd.forEach(email => {
            if (email && !this.extractedData.emails.includes(email)) {
                this.extractedData.emails.push(email);
            }
        });
    }

    /**
     * Add extracted phone numbers
     * @param {string|string[]} phones - Phone(s) to add
     */
    addPhones(phones) {
        const toAdd = Array.isArray(phones) ? phones : [phones];
        toAdd.forEach(phone => {
            if (phone && !this.extractedData.phones.includes(phone)) {
                this.extractedData.phones.push(phone);
            }
        });
    }

    /**
     * Add social link
     * @param {string} platform - Social platform (facebook, instagram, etc.)
     * @param {string} url - Profile URL
     */
    addSocialLink(platform, url) {
        if (platform && url) {
            this.extractedData.socialLinks[platform] = url;
        }
    }

    /**
     * Add metadata
     * @param {string} key - Metadata key
     * @param {any} value - Metadata value
     */
    addMetadata(key, value) {
        this.extractedData.metadata[key] = value;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // METRICS & UTILITIES
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Get total duration in ms
     * @returns {number} Duration in milliseconds
     */
    getDuration() {
        return (this.endTime || Date.now()) - this.startTime;
    }

    /**
     * Check if request can be retried
     * @returns {boolean}
     */
    canRetry() {
        return !this.request.noRetry && 
               this.request.retryCount < this.request.maxRetries;
    }

    /**
     * Increment retry count
     */
    incrementRetry() {
        this.request.retryCount++;
        this.wasRetried = true;
    }

    /**
     * Get serializable summary of this request
     * @returns {Object}
     */
    toJSON() {
        return {
            id: this.request.id,
            url: this.request.url,
            loadedUrl: this.request.loadedUrl,
            domain: this.domain,
            state: this.state,
            retryCount: this.request.retryCount,
            duration: this.getDuration(),
            fetchDuration: this.fetchDuration,
            response: this.response ? {
                status: this.response.status,
                ok: this.response.ok,
                redirected: this.response.redirected
            } : null,
            contentLength: this.contentLength,
            extractedData: {
                emailCount: this.extractedData.emails.length,
                phoneCount: this.extractedData.phones.length,
                socialCount: Object.keys(this.extractedData.socialLinks).length
            },
            errors: this.request.errorMessages.length,
            sessionId: this.sessionId
        };
    }

    /**
     * Get short string representation
     * @returns {string}
     */
    toString() {
        const duration = this.getDuration();
        const status = this.response?.status || 'N/A';
        return `[${this.request.id}] ${this.domain}${this.pathname} (${status}, ${duration}ms)`;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE METHODS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Generate unique request ID
     * @private
     */
    _generateId() {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 9);
        return `req_${timestamp}_${random}`;
    }

    /**
     * Normalize URL for uniqueKey
     * @private
     */
    _normalizeUrl(url) {
        if (!url) return 'unknown';
        try {
            const u = new URL(url);
            // Remove trailing slash, lowercase hostname
            const path = u.pathname.replace(/\/$/, '') || '/';
            return `${u.hostname.toLowerCase()}${path}`;
        } catch {
            return url.toLowerCase();
        }
    }

    /**
     * Extract headers from response
     * @private
     */
    _extractHeaders(response) {
        if (!response?.headers) return {};
        
        const headers = {};
        const important = ['content-type', 'content-length', 'cf-ray', 'retry-after', 'x-robots-tag'];
        
        if (typeof response.headers.forEach === 'function') {
            response.headers.forEach((value, key) => {
                if (important.includes(key.toLowerCase())) {
                    headers[key.toLowerCase()] = value;
                }
            });
        }
        
        return headers;
    }

    /**
     * Create context-aware logger
     * @private
     */
    _createLogger() {
        const prefix = () => `[${this.request.id.slice(-8)}|${this.domain}]`;
        
        return {
            info: (msg, ...args) => logger.info(`${prefix()} ${msg}`, ...args),
            warn: (msg, ...args) => logger.warn(`${prefix()} ${msg}`, ...args),
            error: (msg, ...args) => logger.error(`${prefix()} ${msg}`, ...args),
            debug: (msg, ...args) => logger.debug(`${prefix()} ${msg}`, ...args)
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a RequestContext from a simple URL
 * @param {string} url - Request URL
 * @param {Object} [options] - Additional options
 * @returns {RequestContext}
 */
export function createContext(url, options = {}) {
    return new RequestContext({ url, ...options });
}

/**
 * Create a RequestContext for a business scraping job
 * @param {Object} business - Business object from database
 * @param {Object} [session] - Session to use
 * @returns {RequestContext}
 */
export function createBusinessContext(business, session = null) {
    return new RequestContext({
        url: business.website,
        label: 'business_scrape',
        session,
        userData: {
            businessId: business.id,
            businessName: business.title,
            businessCategory: business.category
        }
    });
}

/**
 * Create a RequestContext for a page within a business scrape
 * @param {string} url - Page URL
 * @param {RequestContext} parentContext - Parent business context
 * @param {string} pageType - Type of page (homepage, contact, about, etc.)
 * @returns {RequestContext}
 */
export function createPageContext(url, parentContext, pageType = 'other') {
    return new RequestContext({
        url,
        label: `page_${pageType}`,
        session: parentContext.session,
        userData: {
            ...parentContext.request.userData,
            pageType,
            parentRequestId: parentContext.request.id
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT POOL (for tracking active requests)
// ═══════════════════════════════════════════════════════════════════════════════

export class RequestContextPool {
    constructor(options = {}) {
        // BUG-Bulk-Falsy-Defaults (codemod, 2026-05-09): `||` → `??` for
        // numeric defaults. `||` would override caller intent of 0 (e.g.
        // maxSize: 0 to disable cap) with the default.
        this.maxSize = options.maxSize ?? 1000;
        this.contexts = new Map();
        this.completedContexts = [];
        this.maxCompleted = options.maxCompleted ?? 100;
    }

    /**
     * Add a context to the pool
     * @param {RequestContext} context
     */
    add(context) {
        this.contexts.set(context.request.id, context);
        
        // Cleanup old contexts if too many
        if (this.contexts.size > this.maxSize) {
            const oldest = this.contexts.keys().next().value;
            this.contexts.delete(oldest);
        }
    }

    /**
     * Get a context by ID
     * @param {string} id - Request ID
     * @returns {RequestContext|undefined}
     */
    get(id) {
        return this.contexts.get(id);
    }

    /**
     * Mark a context as completed and move to history
     * @param {string} id - Request ID
     */
    complete(id) {
        const context = this.contexts.get(id);
        if (context) {
            this.contexts.delete(id);
            this.completedContexts.push(context.toJSON());
            
            // Trim completed history
            if (this.completedContexts.length > this.maxCompleted) {
                this.completedContexts.shift();
            }
        }
    }

    /**
     * Get all active contexts
     * @returns {RequestContext[]}
     */
    getActive() {
        return Array.from(this.contexts.values());
    }

    /**
     * Get summary statistics
     * @returns {Object}
     */
    getStats() {
        const active = this.getActive();
        const byState = {};
        const byDomain = {};
        
        active.forEach(ctx => {
            byState[ctx.state] = (byState[ctx.state] || 0) + 1;
            byDomain[ctx.domain] = (byDomain[ctx.domain] || 0) + 1;
        });
        
        return {
            activeCount: active.length,
            completedCount: this.completedContexts.length,
            byState,
            byDomain,
            avgDuration: active.length > 0 
                ? Math.round(active.reduce((sum, c) => sum + c.getDuration(), 0) / active.length)
                : 0
        };
    }

    /**
     * Clear all contexts
     */
    clear() {
        this.contexts.clear();
        this.completedContexts = [];
    }
}

// Singleton pool instance
let _poolInstance = null;

/**
 * Get the singleton RequestContextPool
 * @returns {RequestContextPool}
 */
export function getContextPool() {
    if (!_poolInstance) {
        _poolInstance = new RequestContextPool();
    }
    return _poolInstance;
}
