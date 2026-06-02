/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 * 
 * INSPIRED BY: Crawlee Pre/Post Navigation Hooks
 * https://crawlee.dev/js/docs/guides/request-storage#pre-navigation-hooks
 */

/**
 * Ghost Map Pro - Navigation Hooks System
 * Modular architecture for handling special cases like:
 * - Cloudflare challenges
 * - CAPTCHA detection
 * - Cookie consent popups
 * - Rate limiting responses
 * - Custom header injection
 * 
 * CRAWLEE FEATURE 2.1
 */

import { logger } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION HOOKS CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class NavigationHooks {
    constructor() {
        this.preHooks = [];
        this.postHooks = [];
        this.errorHooks = [];
        this.hookStats = {
            preExecuted: 0,
            postExecuted: 0,
            errorExecuted: 0,
            hookErrors: 0
        };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Hook Registration
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Add a pre-navigation hook (runs BEFORE fetch)
     * @param {Function} fn - Hook function receiving context
     * @param {Object} options - Hook options
     * @param {string} options.name - Hook name for logging
     * @param {number} options.priority - Lower = runs first (default 100)
     */
    addPreHook(fn, options = {}) {
        const hook = {
            fn,
            name: options.name || `preHook_${this.preHooks.length}`,
            priority: options.priority ?? 100,
            enabled: true
        };
        this.preHooks.push(hook);
        this.preHooks.sort((a, b) => a.priority - b.priority);
        logger.debug(`[NavigationHooks] Added pre-hook: ${hook.name} (priority: ${hook.priority})`);
    }

    /**
     * Add a post-navigation hook (runs AFTER fetch, before processing)
     * @param {Function} fn - Hook function receiving context
     * @param {Object} options - Hook options
     */
    addPostHook(fn, options = {}) {
        const hook = {
            fn,
            name: options.name || `postHook_${this.postHooks.length}`,
            priority: options.priority ?? 100,
            enabled: true
        };
        this.postHooks.push(hook);
        this.postHooks.sort((a, b) => a.priority - b.priority);
        logger.debug(`[NavigationHooks] Added post-hook: ${hook.name} (priority: ${hook.priority})`);
    }

    /**
     * Add an error hook (runs when fetch fails)
     * @param {Function} fn - Hook function receiving context and error
     * @param {Object} options - Hook options
     */
    addErrorHook(fn, options = {}) {
        const hook = {
            fn,
            name: options.name || `errorHook_${this.errorHooks.length}`,
            priority: options.priority ?? 100,
            enabled: true
        };
        this.errorHooks.push(hook);
        this.errorHooks.sort((a, b) => a.priority - b.priority);
        logger.debug(`[NavigationHooks] Added error-hook: ${hook.name} (priority: ${hook.priority})`);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Hook Execution
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Execute all pre-navigation hooks
     * @param {Object} context - Request context
     * @returns {Promise<Object>} Modified context or directives
     */
    async executePreHooks(context) {
        const result = { 
            skip: false, 
            retry: false, 
            modifiedHeaders: null,
            modifiedUrl: null 
        };

        for (const hook of this.preHooks) {
            if (!hook.enabled) continue;
            
            try {
                const hookResult = await hook.fn(context);
                this.hookStats.preExecuted++;
                
                if (hookResult) {
                    // Merge hook results
                    if (hookResult.skip) result.skip = true;
                    if (hookResult.retry) result.retry = true;
                    if (hookResult.modifiedHeaders) {
                        result.modifiedHeaders = { 
                            ...result.modifiedHeaders, 
                            ...hookResult.modifiedHeaders 
                        };
                    }
                    if (hookResult.modifiedUrl) {
                        result.modifiedUrl = hookResult.modifiedUrl;
                    }
                    
                    // If skip requested, stop executing more hooks
                    if (result.skip) {
                        logger.debug(`[NavigationHooks] Pre-hook ${hook.name} requested skip`);
                        break;
                    }
                }
            } catch (error) {
                this.hookStats.hookErrors++;
                logger.warn(`[NavigationHooks] Pre-hook ${hook.name} failed: ${error.message}`);
                // Continue with other hooks
            }
        }

        return result;
    }

    /**
     * Execute all post-navigation hooks
     * @param {Object} context - Request context with response
     * @returns {Promise<Object>} Directives (retry, block, etc.)
     */
    async executePostHooks(context) {
        const result = { 
            retry: false, 
            retryDelay: 0,
            block: false,
            blockReason: null,
            extractedData: {}
        };

        for (const hook of this.postHooks) {
            if (!hook.enabled) continue;
            
            try {
                const hookResult = await hook.fn(context);
                this.hookStats.postExecuted++;
                
                if (hookResult) {
                    if (hookResult.retry) {
                        result.retry = true;
                        result.retryDelay = Math.max(result.retryDelay, hookResult.retryDelay || 0);
                    }
                    if (hookResult.block) {
                        result.block = true;
                        result.blockReason = hookResult.blockReason || 'Unknown';
                    }
                    if (hookResult.extractedData) {
                        result.extractedData = { 
                            ...result.extractedData, 
                            ...hookResult.extractedData 
                        };
                    }
                    
                    // If block requested, stop executing more hooks
                    if (result.block) {
                        logger.warn(`[NavigationHooks] Post-hook ${hook.name} blocked: ${result.blockReason}`);
                        break;
                    }
                }
            } catch (error) {
                this.hookStats.hookErrors++;
                logger.warn(`[NavigationHooks] Post-hook ${hook.name} failed: ${error.message}`);
            }
        }

        return result;
    }

    /**
     * Execute all error hooks
     * @param {Object} context - Request context
     * @param {Error} error - The error that occurred
     * @returns {Promise<Object>} Directives (retry, etc.)
     */
    async executeErrorHooks(context, error) {
        const result = { 
            retry: false, 
            retryDelay: 0,
            handled: false 
        };

        for (const hook of this.errorHooks) {
            if (!hook.enabled) continue;
            
            try {
                const hookResult = await hook.fn(context, error);
                this.hookStats.errorExecuted++;
                
                if (hookResult) {
                    if (hookResult.retry) {
                        result.retry = true;
                        result.retryDelay = Math.max(result.retryDelay, hookResult.retryDelay || 0);
                    }
                    if (hookResult.handled) {
                        result.handled = true;
                        break;
                    }
                }
            } catch (hookError) {
                this.hookStats.hookErrors++;
                logger.warn(`[NavigationHooks] Error-hook ${hook.name} failed: ${hookError.message}`);
            }
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Hook Management
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Enable/disable a hook by name
     */
    setHookEnabled(name, enabled) {
        const allHooks = [...this.preHooks, ...this.postHooks, ...this.errorHooks];
        const hook = allHooks.find(h => h.name === name);
        if (hook) {
            hook.enabled = enabled;
            logger.info(`[NavigationHooks] Hook ${name} ${enabled ? 'enabled' : 'disabled'}`);
            return true;
        }
        return false;
    }

    /**
     * Remove a hook by name
     */
    removeHook(name) {
        const removeFrom = (arr) => {
            const idx = arr.findIndex(h => h.name === name);
            if (idx !== -1) {
                arr.splice(idx, 1);
                return true;
            }
            return false;
        };

        return removeFrom(this.preHooks) || 
               removeFrom(this.postHooks) || 
               removeFrom(this.errorHooks);
    }

    /**
     * Get hook statistics
     */
    getStats() {
        return {
            ...this.hookStats,
            preHooksCount: this.preHooks.length,
            postHooksCount: this.postHooks.length,
            errorHooksCount: this.errorHooks.length
        };
    }

    /**
     * Clear all hooks
     */
    clear() {
        this.preHooks = [];
        this.postHooks = [];
        this.errorHooks = [];
        logger.info('[NavigationHooks] All hooks cleared');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILT-IN HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cloudflare Challenge Detection Hook
 * Detects Cloudflare protection pages and waits
 */
export const cloudflareDetectionHook = async (context) => {
    const { response, html } = context;
    
    // Check for Cloudflare indicators
    const isCloudflarePage = 
        response?.status === 503 ||
        response?.headers?.['cf-ray'] ||
        response?.headers?.['cf-cache-status'] ||
        (html && (
            html.includes('Checking your browser') ||
            html.includes('cf-browser-verification') ||
            html.includes('__cf_chl_opt') ||
            html.includes('challenge-platform')
        ));
    
    if (isCloudflarePage) {
        logger.warn('[Hook:Cloudflare] 🛡️ Cloudflare challenge detected');
        return {
            retry: true,
            retryDelay: 5000, // Wait 5 seconds
            block: true,
            blockReason: 'Cloudflare protection'
        };
    }
    
    return null;
};

/**
 * CAPTCHA Detection Hook
 * Detects common CAPTCHA implementations
 */
export const captchaDetectionHook = async (context) => {
    const { html } = context;
    
    if (!html) return null;
    
    const hasCaptcha = 
        html.includes('g-recaptcha') ||
        html.includes('h-captcha') ||
        html.includes('data-sitekey') ||
        html.includes('recaptcha/api') ||
        html.includes('hcaptcha.com') ||
        html.includes('unusual traffic') ||
        html.includes('verify you are human') ||
        html.includes('please complete the security check');
    
    if (hasCaptcha) {
        logger.warn('[Hook:CAPTCHA] 🤖 CAPTCHA detected on page');
        return {
            block: true,
            blockReason: 'CAPTCHA protection',
            extractedData: { hasCaptcha: true }
        };
    }
    
    return null;
};

/**
 * Rate Limit Detection Hook
 * Detects rate limiting responses
 */
export const rateLimitDetectionHook = async (context) => {
    const { response, html } = context;
    
    const isRateLimited = 
        response?.status === 429 ||
        response?.status === 503 ||
        (response?.headers?.['retry-after']) ||
        (html && (
            html.includes('rate limit') ||
            html.includes('too many requests') ||
            html.includes('slow down') ||
            html.includes('request limit exceeded')
        ));
    
    if (isRateLimited) {
        // Parse Retry-After header if present
        const retryAfter = response?.headers?.['retry-after'];
        let delay = 30000; // Default 30 seconds
        
        if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (!isNaN(seconds)) {
                delay = seconds * 1000;
            }
        }
        
        logger.warn(`[Hook:RateLimit] ⏱️ Rate limited, retry in ${delay}ms`);
        return {
            retry: true,
            retryDelay: delay,
            extractedData: { rateLimited: true }
        };
    }
    
    return null;
};

/**
 * Soft Block Detection Hook
 * Detects "soft" blocks that don't return errors but serve empty/generic content
 */
export const softBlockDetectionHook = async (context) => {
    const { html, url } = context;
    
    if (!html) return null;
    
    // Very short page (possible block page)
    if (html.length < 500) {
        // Check if it's an actual block/error
        const isBlockPage = 
            html.includes('Access Denied') ||
            html.includes('Forbidden') ||
            html.includes('blocked') ||
            html.includes('not available') ||
            html.includes('error');
        
        if (isBlockPage) {
            logger.warn(`[Hook:SoftBlock] 🚧 Soft block detected for ${url}`);
            return {
                block: true,
                blockReason: 'Soft block (short error page)',
                extractedData: { softBlocked: true }
            };
        }
    }
    
    return null;
};

/**
 * Cookie Consent Detection Hook
 * Detects cookie consent banners (informational only)
 */
export const cookieConsentHook = async (context) => {
    const { html } = context;
    
    if (!html) return null;
    
    const hasCookieConsent = 
        html.includes('cookie-consent') ||
        html.includes('cookie-notice') ||
        html.includes('gdpr-consent') ||
        html.includes('accept cookies') ||
        html.includes('cookie policy');
    
    if (hasCookieConsent) {
        // Just informational, don't block
        return {
            extractedData: { hasCookieConsent: true }
        };
    }
    
    return null;
};

/**
 * Redirect Detection Hook
 * Detects and logs meta/JS redirects
 */
export const redirectDetectionHook = async (context) => {
    const { html, url } = context;
    
    if (!html) return null;
    
    // Check for meta refresh
    const metaRefreshMatch = html.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?\d+;?\s*url=([^"'>]+)/i);
    if (metaRefreshMatch) {
        const redirectUrl = metaRefreshMatch[1];
        logger.debug(`[Hook:Redirect] Meta refresh detected: ${redirectUrl}`);
        return {
            extractedData: { 
                hasMetaRedirect: true,
                redirectUrl 
            }
        };
    }
    
    // Check for JS redirect patterns
    const hasJsRedirect = 
        html.includes('window.location') ||
        html.includes('location.href') ||
        html.includes('location.replace');
    
    if (hasJsRedirect) {
        return {
            extractedData: { hasJsRedirect: true }
        };
    }
    
    return null;
};

/**
 * Error Page Detection Hook (Pre-hook)
 * Checks response status before processing
 */
export const errorPagePreHook = async (context) => {
    const { response } = context;
    
    if (!response) return null;
    
    // Skip processing for clear error pages
    if (response.status >= 400 && response.status < 500) {
        if (response.status === 404) {
            return {
                skip: true,
                extractedData: { is404: true }
            };
        }
        if (response.status === 403 || response.status === 401) {
            return {
                skip: true,
                extractedData: { isBlocked: true, status: response.status }
            };
        }
    }
    
    return null;
};

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a NavigationHooks instance with default hooks
 * @param {Object} options - Configuration options
 * @returns {NavigationHooks} Configured hooks instance
 */
export function createDefaultHooks(options = {}) {
    const hooks = new NavigationHooks();
    
    // Add post-hooks in order of importance
    hooks.addPostHook(cloudflareDetectionHook, { 
        name: 'cloudflare', 
        priority: 10 
    });
    
    hooks.addPostHook(captchaDetectionHook, { 
        name: 'captcha', 
        priority: 20 
    });
    
    hooks.addPostHook(rateLimitDetectionHook, { 
        name: 'rateLimit', 
        priority: 30 
    });
    
    hooks.addPostHook(softBlockDetectionHook, { 
        name: 'softBlock', 
        priority: 40 
    });
    
    if (options.detectRedirects !== false) {
        hooks.addPostHook(redirectDetectionHook, { 
            name: 'redirect', 
            priority: 50 
        });
    }
    
    if (options.detectCookieConsent !== false) {
        hooks.addPostHook(cookieConsentHook, { 
            name: 'cookieConsent', 
            priority: 100 
        });
    }
    
    logger.info(`[NavigationHooks] ✅ Created with ${hooks.postHooks.length} default hooks`);
    
    return hooks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
//
// MV3 SW EVICTION POLICY (B11-6 cluster triage 2026-05-10): SAFE-BY-SEMANTICS.
// NavigationHooks holds preHooks[]/postHooks[]/errorHooks[] arrays + per-hook
// statistics. Hooks are typically registered at extension boot (background/
// index.js initialization phase) — re-running on every SW wake re-registers
// them fresh. Hook LOGIC lives in the closures themselves (Cloudflare/CAPTCHA
// detection), not in NavigationHooks state, so re-registering preserves
// behavior. Statistics reset is observable but harmless.

// SW-EVICTION-SAFE: ephemeral singleton; hooks re-registered at every SW wake init.
let _instance = null;

/**
 * Get the singleton NavigationHooks instance
 * @param {Object} [options] - Options for first initialization
 * @returns {NavigationHooks} Singleton instance
 */
export function getNavigationHooks(options = {}) {
    if (!_instance) {
        _instance = createDefaultHooks(options);
    }
    return _instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetNavigationHooks() {
    if (_instance) {
        _instance.clear();
    }
    _instance = null;
}
