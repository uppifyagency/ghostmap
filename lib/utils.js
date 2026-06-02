/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Utility Functions
 * Safe utilities for logging, timing, randomization, and helpers
 */

import { CONFIG } from './config.js';

/**
 * @typedef {Object} RetryOptions
 * @property {number} [maxAttempts=3] - Maximum number of retry attempts
 * @property {number} [baseDelay=1000] - Base delay between retries in milliseconds
 * @property {boolean} [useBackoff=true] - Whether to use exponential backoff
 * @property {number} [backoffMultiplier=2] - Multiplier for exponential backoff
 * @property {function(number, Error, number): void} [onRetry] - Callback fired on each retry
 */

/**
 * @typedef {Object} SerializedError
 * @property {string} message - Error message
 * @property {string} name - Error name/type
 * @property {string} [stack] - Stack trace (only in development mode)
 * @property {string|number} [code] - Error code if available
 */
/**
 * Throttle map for log broadcasting (PHASE 3 FIX #23)
 * Prevents message queue flooding during active scraping
 */
const broadcastThrottle = new Map(); // level -> lastBroadcast timestamp
// BUG FIX #7: Per-level throttling to prevent dropping important messages
// B11-5 FIX (2026-05-29): info throttled 0 → 100ms (max ~10 broadcasts/sec).
// During scrape bursts the info-level broadcast stream flooded the dev-log
// bridge; errors/warns stay near-unthrottled so critical info is preserved.
const THROTTLE_MS = {
    error: 0,      // Never throttle errors - critical information
    warn: 1,       // Minimal throttling for warnings
    info: 100,     // B11-5 FIX: cap ~10 logs/sec (was 0 = unlimited spam)
    debug: 5       // Minimal throttling for debug
};

/**
 * Broadcast log to UI (if available)
 * PHASE 3 FIX #23: Throttled + production filtering
 * BUG FIX #7: Per-level throttling
 * Sends log messages to UI via chrome.runtime.sendMessage
 * Throttled based on log level to avoid dropping important messages
 * @private
 * @param {('error'|'warn'|'info'|'debug')} level - Log level
 * @param {string} message - Message to broadcast
 */
function broadcastLog(level, message) {
    // PHASE 3 FIX #23: Filter debug logs in production ONLY if explicitly disabled
    if (CONFIG.isProduction && level === 'debug' && !CONFIG.logging.levels.debug) {
        return; // Don't broadcast debug logs in production when disabled
    }

    // BUG FIX #7: Per-level throttling
    const now = Date.now();
    const throttleMs = typeof THROTTLE_MS === 'object' ? THROTTLE_MS[level] : THROTTLE_MS;
    const lastBroadcast = broadcastThrottle.get(level) || 0;

    if (now - lastBroadcast < throttleMs) {
        return; // Too soon, skip this broadcast
    }

    broadcastThrottle.set(level, now);

    try {
        // BUG-015 FIX: Check if chrome.runtime is still valid (can become undefined during SW termination)
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
            chrome.runtime.sendMessage({
                action: 'log_message',
                payload: {
                    level,
                    message,
                    timestamp: now,
                    prefix: CONFIG.logging.prefix  // Add prefix for UI consistency
                }
            }).catch(() => {
                // Ignore errors - UI might not be open
            });
        }
    } catch (e) {
        // BUG-015 FIX: Catch any errors including "Extension context invalidated"
        // This can happen during service worker termination
        // Ignore silently - logging should never crash the extension
    }
}

/**
 * Safe Logger - respects production mode and broadcasts to UI
 * Provides console logging with configurable levels and UI broadcasting
 * @type {{error: function(...any): void, warn: function(...any): void, info: function(...any): void, debug: function(...any): void}}
 * @example
 * logger.error('Something went wrong:', error);
 * logger.info('Process started');
 * logger.debug('Variable state:', {count: 10});
 */
export const logger = {
    error: (...args) => {
        if (CONFIG.logging.levels.error) {
            const message = args.join(' ');
            console.error(CONFIG.logging.prefix, ...args);
            broadcastLog('error', message);
        }
    },
    warn: (...args) => {
        if (CONFIG.logging.levels.warn) {
            const message = args.join(' ');
            console.warn(CONFIG.logging.prefix, ...args);
            broadcastLog('warn', message);
        }
    },
    info: (...args) => {
        if (CONFIG.logging.levels.info) {
            const message = args.join(' ');
            console.log(CONFIG.logging.prefix, ...args);
            broadcastLog('info', message);
        }
    },
    debug: (...args) => {
        if (CONFIG.logging.levels.debug) {
            const message = args.join(' ');
            console.log(CONFIG.logging.prefix, '[DEBUG]', ...args);
            broadcastLog('debug', message); // FIX: Broadcast with correct 'debug' level
        }
    }
};

/**
 * Random number with Gaussian (normal) distribution
 * Uses Box-Muller transform for more natural randomization
 * Useful for simulating human-like timing variations
 * @param {number} mean - Center value (average)
 * @param {number} stdDev - Standard deviation (spread)
 * @returns {number} Random number from Gaussian distribution
 * @example
 * // Generate delay around 1000ms with ±200ms variation
 * const delay = randomGaussian(1000, 200);
 */
export function randomGaussian(mean, stdDev) {
    // Box-Muller transform
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return z0 * stdDev + mean;
}

/**
 * Random integer between min and max (inclusive)
 * @param {number} min - Minimum value (inclusive)
 * @param {number} max - Maximum value (inclusive)
 * @returns {number} Random integer between min and max
 * @example
 * const delay = randomInt(500, 1500); // Random delay between 0.5-1.5s
 */
export function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Random delay with Gaussian distribution
 * Returns a promise that resolves after a random delay
 * @param {number} meanMs - Average delay in milliseconds
 * @param {number} [stdDevMs] - Standard deviation (default: 20% of mean)
 * @returns {Promise<void>} Promise that resolves after delay
 * @example
 * // Wait for ~1000ms with natural variation
 * await randomDelay(1000);
 * // Custom variation
 * await randomDelay(1000, 500); // ~1000ms ± 500ms
 */
export function randomDelay(meanMs, stdDevMs = meanMs * 0.2) {
    const delay = Math.max(0, randomGaussian(meanMs, stdDevMs));
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>} Promise that resolves after delay
 * @example
 * await sleep(1000); // Wait 1 second
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * Automatically retries failed async operations with configurable backoff strategy
 * @param {function(): Promise<any>} fn - Async function to retry
 * @param {RetryOptions} [options={}] - Retry configuration options
 * @returns {Promise<any>} Result of the function call
 * @throws {Error} Last error if all retries exhausted
 * @example
 * const data = await retry(
 *   async () => await fetchData(),
 *   { maxAttempts: 5, baseDelay: 1000, onRetry: (attempt, err) => {
 *     console.log(`Retry ${attempt} after error:`, err.message);
 *   }}
 * );
 */
export async function retry(fn, options = {}) {
    const {
        maxAttempts = CONFIG.errors.maxRetries,
        baseDelay = CONFIG.errors.retryDelay,
        useBackoff = CONFIG.errors.useExponentialBackoff,
        backoffMultiplier = CONFIG.errors.backoffMultiplier,
        onRetry = null
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt === maxAttempts) {
                throw error;
            }

            const delay = useBackoff
                ? baseDelay * Math.pow(backoffMultiplier, attempt - 1)
                : baseDelay;

            logger.warn(`Retry attempt ${attempt}/${maxAttempts} after ${delay}ms:`, error.message);

            if (onRetry) {
                onRetry(attempt, error, delay);
            }

            await sleep(delay);
        }
    }

    throw lastError;
}

/**
 * Debounce function - delays execution until calls stop for specified time
 * Useful for input handlers and expensive operations
 * @param {function(...any): any} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {function(...any): void} Debounced function
 * @example
 * const saveInput = debounce((value) => {
 *   saveToDatabase(value);
 * }, 500); // Saves 500ms after user stops typing
 */
export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Throttle function - limits execution to once per time period
 * Useful for rate-limiting frequent events (scroll, resize)
 * @param {function(...any): any} func - Function to throttle
 * @param {number} limit - Time limit in milliseconds
 * @returns {function(...any): void} Throttled function
 * @example
 * const handleScroll = throttle(() => {
 *   updateScrollPosition();
 * }, 100); // Executes at most once per 100ms
 */
export function throttle(func, limit) {
    let inThrottle;
    return function (...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * Safe JSON parse with fallback
 * @param {string} str - JSON string to parse
 * @param {any} [fallback=null] - Fallback value if parsing fails
 * @returns {any} Parsed object or fallback value
 * @example
 * const data = safeJsonParse(userInput, {}); // Returns {} if invalid JSON
 */
export function safeJsonParse(str, fallback = null) {
    try {
        return JSON.parse(str);
    } catch (e) {
        logger.warn('JSON parse failed:', e.message);
        return fallback;
    }
}

/**
 * Normalize URL (remove tracking params, fragments)
 * Strips common tracking parameters and hash fragments
 * @param {string} url - URL to normalize
 * @returns {string} Normalized URL
 * @example
 * normalizeUrl('https://example.com?utm_source=email#section')
 * // Returns: 'https://example.com'
 */
export function normalizeUrl(url) {
    try {
        const urlObj = new URL(url);
        // Remove common tracking parameters
        const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'gclid'];
        trackingParams.forEach(param => urlObj.searchParams.delete(param));
        // Remove fragment
        urlObj.hash = '';
        return urlObj.toString();
    } catch (e) {
        return url;
    }
}

/**
 * Extract domain from URL
 * @param {string} url - URL to parse
 * @returns {string|null} Hostname or null if invalid URL
 * @example
 * getDomain('https://www.example.com/path') // Returns: 'www.example.com'
 */
export function getDomain(url) {
    try {
        return new URL(url).hostname;
    } catch (e) {
        return null;
    }
}

/**
 * Serialize error for logging/messaging
 * PHASE 4 FIX #39: Standardized error serialization
 * Converts Error objects to plain objects for JSON serialization
 * @param {Error|any} error - Error object or any value
 * @returns {SerializedError} Serialized error with message, stack, name
 * @example
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   const serialized = serializeError(error);
 *   await logToServer(serialized); // Can be JSON.stringify'd
 * }
 */
export function serializeError(error) {
    if (error instanceof Error) {
        return {
            message: error.message,
            name: error.name,
            stack: CONFIG.isDevelopment ? error.stack : undefined,
            code: error.code
        };
    }

    if (typeof error === 'object' && error !== null) {
        return {
            message: error.message || String(error),
            name: error.name || 'UnknownError',
            ...error
        };
    }

    return {
        message: String(error),
        name: 'UnknownError'
    };
}

/**
 * Validate phone number
 * @param {string} phone - Phone number to validate
 * @returns {boolean} - True if valid
 */
export function isValidPhone(phone) {
    if (!phone || typeof phone !== 'string') return false;

    // Remove all non-digit characters except +
    const cleaned = phone.replace(/[^\d+]/g, '');

    // 2026-05-05: lowered min from 10 to 9 to accept short Italian landlines.
    // Rome (06) + 7-digit subscriber and other older 0XX numbers can be 9
    // digits total. Restaurant/pizzeria phones in IT Maps frequently use this
    // shorter format; the 10-digit floor was rejecting them silently.
    // 15-digit ceiling matches ITU-T E.164.
    const digitCount = cleaned.replace(/\+/g, '').length;
    if (digitCount < 9 || digitCount > 15) return false;

    // If starts with +, must be followed by digits.
    // 9 digits + "+" + 1-3 digit country code = at least 11 chars.
    if (cleaned.startsWith('+') && cleaned.length < 11) return false;

    return true;
}

/**
 * Normalize phone number to E.164 format
 * @param {string} phone - Phone number to normalize
 * @returns {string|null} - Normalized phone number or null
 */
export function normalizePhone(phone) {
    if (!phone) return null;

    // Remove all non-digit characters except +
    let cleaned = phone.replace(/[^\d+]/g, '');

    // If doesn't start with +, assume US/Canada and add +1
    if (!cleaned.startsWith('+')) {
        // Remove leading 1 if present (US/Canada)
        if (cleaned.startsWith('1') && cleaned.length === 11) {
            cleaned = cleaned.substring(1);
        }
        // Add +1 prefix for US/Canada
        if (cleaned.length === 10) {
            cleaned = '+1' + cleaned;
        }
    }

    return cleaned;
}


/**
 * Sanitize string for CSV with comprehensive formula injection prevention (HIGH FIX #7)
 * Prevents CSV formula injection attacks in Excel, Google Sheets, LibreOffice
 * Also handles DDE (Dynamic Data Exchange) attack vectors
 * @param {string|any} str - String to escape for CSV
 * @returns {string} Escaped string safe for CSV inclusion
 * @example
 * escapeCsv('=SUM(A1:A10)') // Returns: "'=SUM(A1:A10)" (prefixed with quote)
 * escapeCsv('Company, Inc.') // Returns: '"Company, Inc."' (wrapped in quotes)
 */
export function escapeCsv(str) {
    if (str === null || str === undefined) return '';

    let stringValue = String(str)
        .replace(/[\r\n]+/g, ' ')  // Replace newlines with spaces
        .replace(/\0/g, '')         // Remove null bytes (HIGH FIX #7)
        .trim();

    // Comprehensive list of dangerous formula prefixes (HIGH FIX #7)
    // These can trigger formula execution in Excel, Google Sheets, LibreOffice
    const DANGEROUS_PREFIXES = [
        '=',      // Standard formula
        '+',      // Can be interpreted as formula
        '-',      // Can be interpreted as formula
        '@',      // Excel function prefix
        '\t',     // Tab can trigger formula
        '\r',     // Carriage return
        '\n',     // Newline
        '|',      // Pipe - used in DDE attacks
        '%',      // Percent - edge case in some apps
        '!',      // Can trigger macros
        '^',      // Caret - formula operator
    ];

    // Also check for DDE (Dynamic Data Exchange) attack vectors (HIGH FIX #7)
    const DDE_PATTERNS = [
        /^cmd\|/i,
        /^powershell\|/i,
        /^MSEXCEL\|/i,
        /^\+\s*cmd/i,
        /^=\s*cmd/i,
    ];

    // Prefix with single quote if dangerous
    const hasDangerousPrefix = DANGEROUS_PREFIXES.some(prefix =>
        stringValue.startsWith(prefix)
    );

    const hasDDEPattern = DDE_PATTERNS.some(pattern =>
        pattern.test(stringValue)
    );

    if (hasDangerousPrefix || hasDDEPattern) {
        stringValue = "'" + stringValue;
    }

    // Always quote if contains comma, double quote, or newline
    if (stringValue.includes(',') || stringValue.includes('"') ||
        stringValue.includes('\n') || stringValue.includes('\r')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }

    return stringValue;
}

/**
 * Deep clone object using JSON serialization
 * WARNING: Does not preserve functions, undefined values, or circular references
 * @param {any} obj - Object to clone
 * @returns {any} Deep cloned object
 * @example
 * const copy = deepClone(originalObject);
 * copy.nested.value = 'changed'; // Does not affect original
 */
export function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Check if running in service worker context
 * @returns {boolean} True if code is running in a service worker
 * @example
 * if (isServiceWorker()) {
 *   // Use service worker APIs
 * }
 */
export function isServiceWorker() {
    return typeof ServiceWorkerGlobalScope !== 'undefined' &&
        self instanceof ServiceWorkerGlobalScope;
}

/**
 * Check if running in content script context
 * @returns {boolean} True if code is running in a content script
 * @example
 * if (isContentScript()) {
 *   // Access DOM and chrome APIs
 * }
 */
export function isContentScript() {
    return typeof chrome !== 'undefined' &&
        chrome.runtime &&
        chrome.runtime.id &&
        typeof document !== 'undefined';
}

/**
 * Format phone for display with international support
 * PHASE 3 FIX #26: International phone formatting for Italy, UK, Germany, US
 * Database continues storing E.164 format - this is display-only
 * 
 * @param {string} phone - Phone in E.164 format (+country_code + number)
 * @returns {string} - Formatted for display according to local conventions
 * 
 * Examples:
 * +39061234567  → "06 1234 5678" (Italy)
 * +442012345678 → "020 1234 5678" (UK)
 * +493012345678 → "030 12345678" (Germany)
 * +15551234567  → "(555) 123-4567" (US/Canada)
 * 5551234567    → "(555) 123-4567" (US, no country code)
 * +81312345678  → "+81 3-1234-5678" (Unknown format, display with prefix)
 */
export function formatPhoneForDisplay(phone) {
    if (!phone) return '';

    // Remove all non-digit characters except +
    const cleaned = phone.replace(/[^\d+]/g, '');

    // Handle Italian numbers (+39)
    if (cleaned.startsWith('+39')) {
        const number = cleaned.substring(3); // Remove +39

        if (number.length === 10) {
            // Format: 06 1234 5678 or 02 1234 5678
            return `${number.substring(0, 2)} ${number.substring(2, 6)} ${number.substring(6)}`;
        } else if (number.length === 9) {
            // Format: 06 123 4567 (short form)
            return `${number.substring(0, 2)} ${number.substring(2, 5)} ${number.substring(5)}`;
        }
        // Return without country code for other lengths
        return number;
    }

    // Handle UK numbers (+44)
    if (cleaned.startsWith('+44')) {
        const number = cleaned.substring(3); // Remove +44

        if (number.length === 10) {
            // Format: 020 1234 5678 (London) or 0161 123 4567 (Manchester)
            if (number.startsWith('20')) {
                return `0${number.substring(0, 2)} ${number.substring(2, 6)} ${number.substring(6)}`;
            } else {
                return `0${number.substring(0, 3)} ${number.substring(3, 6)} ${number.substring(6)}`;
            }
        }
        // Return with leading 0 for other lengths
        return '0' + number;
    }

    // Handle German numbers (+49)
    if (cleaned.startsWith('+49')) {
        const number = cleaned.substring(3); // Remove +49

        if (number.length === 10) {
            // Format: 030 12345678 (Berlin)
            return `0${number.substring(0, 2)} ${number.substring(2)}`;
        } else if (number.length === 11) {
            // Format: 0211 1234567 (Düsseldorf)
            return `0${number.substring(0, 3)} ${number.substring(3)}`;
        }
        // Return with leading 0 for other lengths
        return '0' + number;
    }

    // Handle US/Canada numbers (+1)
    if (cleaned.startsWith('+1') && cleaned.length === 12) {
        const number = cleaned.substring(2); // Remove +1
        // Format: (555) 123-4567
        return `(${number.substring(0, 3)}) ${number.substring(3, 6)}-${number.substring(6)}`;
    }

    // Handle US numbers without country code (10 digits)
    if (!cleaned.startsWith('+') && cleaned.length === 10) {
        // Format: (555) 123-4567
        return `(${cleaned.substring(0, 3)}) ${cleaned.substring(3, 6)}-${cleaned.substring(6)}`;
    }

    // For unknown international formats, display with country code
    if (cleaned.startsWith('+')) {
        // Try to format as: +CC AAA-BBB-CCCC
        const match = cleaned.match(/^(\+\d{1,3})(\d{3,4})(\d+)$/);
        if (match) {
            const [, countryCode, prefix, rest] = match;
            // Group rest in chunks of 4
            const formatted = rest.match(/.{1,4}/g)?.join('-') || rest;
            return `${countryCode} ${prefix}-${formatted}`;
        }
        // Fallback: display as-is with country code
        return cleaned;
    }

    // Return as-is if format not recognized
    return phone;
}

/**
 * Generate unique ID using timestamp and random values
 * @returns {string} Unique identifier string
 * @example
 * const id = generateId(); // e.g., "l8jxm0u0.8qz5t6n"
 */
export function generateId() {
    // BUG #22 FIX: Replace deprecated substr() with substring()
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

/**
 * Format timestamp for display in locale-specific format
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted date/time string
 * @example
 * formatTimestamp(Date.now()) // "11/24/2025, 2:30:15 PM"
 */
export function formatTimestamp(timestamp) {
    return new Date(timestamp).toLocaleString();
}

/**
 * Calculate percentage rounded to nearest integer
 * @param {number} value - Numerator value
 * @param {number} total - Denominator value
 * @returns {number} Percentage (0-100), or 0 if total is 0
 * @example
 * percentage(3, 10) // Returns: 30
 */
export function percentage(value, total) {
    if (total === 0) return 0;
    return Math.round((value / total) * 100);
}

/**
 * Truncate string with ellipsis if exceeds max length
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length including ellipsis
 * @returns {string} Truncated string with ... if needed
 * @example
 * truncate('Very long text here', 10) // "Very lo..."
 */
export function truncate(str, maxLength) {
    if (!str || str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
}

/**
 * Check if element is visible in viewport
 * @param {HTMLElement} element - DOM element to check
 * @returns {boolean} True if element is fully visible in viewport
 * @example
 * if (isInViewport(myElement)) {
 *   // Trigger animation or lazy load
 * }
 */
export function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
}

/**
 * Wait for element to appear in DOM using MutationObserver
 * @param {string} selector - CSS selector for the element
 * @param {number} [timeout=10000] - Maximum wait time in milliseconds
 * @returns {Promise<HTMLElement>} Promise resolving to the element
 * @throws {Error} If element not found within timeout
 * @example
 * const button = await waitForElement('.submit-btn', 5000);
 * button.click();
 */
export function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const element = document.querySelector(selector);
        if (element) {
            return resolve(element);
        }

        const observer = new MutationObserver((mutations) => {
            const element = document.querySelector(selector);
            if (element) {
                observer.disconnect();
                resolve(element);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Element ${selector} not found within ${timeout}ms`));
        }, timeout);
    });
}

export default {
    logger,
    randomGaussian,
    randomInt,
    randomDelay,
    sleep,
    retry,
    debounce,
    throttle,
    safeJsonParse,
    normalizeUrl,
    getDomain,
    serializeError,
    isValidPhone,
    normalizePhone,
    formatPhoneForDisplay,
    escapeCsv,
    deepClone,
    isServiceWorker,
    isContentScript,
    generateId,
    formatTimestamp,
    percentage,
    truncate,
    isInViewport,
    waitForElement
};
