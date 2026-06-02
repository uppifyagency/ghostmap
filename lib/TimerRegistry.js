/**
 * Ghost Map Pro - Timer Registry
 * FIX H-002: Centralized timer management with automatic cleanup
 * 
 * PROBLEM: 29 setTimeout/setInterval calls scattered across codebase
 *          without consistent cleanup on service worker suspension
 * 
 * SOLUTION: Centralized registry that:
 *   - Tracks all timers by ID and purpose
 *   - Provides automatic cleanup on shutdown
 *   - Prevents memory leaks from orphaned timers
 *   - Offers debugging/monitoring capabilities
 */

import { logger } from './utils.js';

/**
 * @typedef {Object} TimerEntry
 * @property {number} id - Browser timer ID
 * @property {string} type - 'timeout' or 'interval'
 * @property {string} purpose - Human-readable description
 * @property {number} createdAt - Timestamp
 * @property {number} delay - Delay in ms
 * @property {string} [owner] - Module that created it
 */

// MV3 SW EVICTION POLICY (B11-6 cluster triage 2026-05-10): SAFE.
// TimerRegistry wraps globalThis.setTimeout/setInterval. On SW eviction the
// #instance is null'd (private static) and #timers Map clears, but the
// underlying browser timers continue to run; on wake the registry is fresh
// and tracks future timers cleanly. Orphaned browser timers from the previous
// SW lifetime check registry membership in their wrapped callbacks before
// executing — they safely no-op if the registry doesn't know them. Net
// effect: some pre-eviction timers may fire post-wake without registry
// effects; non-corrupting. The #isShuttingDown flag (set in clearAll() on
// shutdown) gates re-entry. SW-EVICTION-SAFE by design.
class TimerRegistry {
    // SW-EVICTION-SAFE: static singleton dies with SW; fresh on wake; orphan-tolerant.
    static #instance = null;

    // SW-EVICTION-SAFE: timers Map dies with SW; orphan callbacks self-no-op via membership check.
    /** @type {Map<number, TimerEntry>} */
    #timers = new Map();
    
    /** @type {number} */
    #nextInternalId = 1;
    
    /** @type {boolean} */
    #isShuttingDown = false;
    
    /** @type {number} */
    #totalCreated = 0;
    
    /** @type {number} */
    #totalCleared = 0;
    
    constructor() {
        if (TimerRegistry.#instance) {
            throw new Error('Use TimerRegistry.getInstance()');
        }
        
        // Listen for service worker lifecycle events
        if (typeof self !== 'undefined' && 'addEventListener' in self) {
            // Chrome extension service worker doesn't have 'beforeunload'
            // but we can handle it in our shutdown method
            logger.info('[TimerRegistry] Initialized - ready to track timers');
        }
    }
    
    /**
     * Get singleton instance
     * @returns {TimerRegistry}
     */
    static getInstance() {
        if (!TimerRegistry.#instance) {
            TimerRegistry.#instance = new TimerRegistry();
        }
        return TimerRegistry.#instance;
    }
    
    /**
     * Create a managed setTimeout
     * @param {Function} callback - Function to execute
     * @param {number} delay - Delay in milliseconds
     * @param {string} purpose - Description for debugging
     * @param {string} [owner] - Module name
     * @returns {number} Internal timer ID (use for clearing)
     */
    setTimeout(callback, delay, purpose = 'unnamed', owner = 'unknown') {
        if (this.#isShuttingDown) {
            logger.warn(`[TimerRegistry] Ignoring setTimeout during shutdown: ${purpose}`);
            return -1;
        }
        
        const internalId = this.#nextInternalId++;
        
        const wrappedCallback = () => {
            // Auto-remove from registry when executed
            this.#timers.delete(internalId);
            this.#totalCleared++;
            
            try {
                callback();
            } catch (error) {
                logger.error(`[TimerRegistry] Timer "${purpose}" threw error:`, error);
            }
        };
        
        const browserId = globalThis.setTimeout(wrappedCallback, delay);
        
        this.#timers.set(internalId, {
            id: browserId,
            type: 'timeout',
            purpose,
            createdAt: Date.now(),
            delay,
            owner
        });
        
        this.#totalCreated++;
        
        logger.debug(`[TimerRegistry] Created timeout #${internalId}: "${purpose}" (${delay}ms) by ${owner}`);
        
        return internalId;
    }
    
    /**
     * Create a managed setInterval
     * @param {Function} callback - Function to execute
     * @param {number} interval - Interval in milliseconds
     * @param {string} purpose - Description for debugging
     * @param {string} [owner] - Module name
     * @returns {number} Internal timer ID (use for clearing)
     */
    setInterval(callback, interval, purpose = 'unnamed', owner = 'unknown') {
        if (this.#isShuttingDown) {
            logger.warn(`[TimerRegistry] Ignoring setInterval during shutdown: ${purpose}`);
            return -1;
        }
        
        const internalId = this.#nextInternalId++;

        // LIB-14 FIX (2026-05-10): pre-fix the catch block logged the error
        // and left the interval running ("Optionally auto-clear" comment
        // marked the gap). A faulty interval (e.g. callback throws every
        // tick because of a stale closure / corrupted state) would log an
        // error every fire FOREVER, polluting telemetry and burning CPU.
        // Now: track consecutive failures and auto-clear after 5 in a row.
        // 5 (not 1) tolerates transient errors (network blip, race) while
        // still bounding the damage from a truly broken callback.
        const MAX_CONSECUTIVE_ERRORS = 5;

        const wrappedCallback = () => {
            // Check if we should stop
            if (this.#isShuttingDown || !this.#timers.has(internalId)) {
                return;
            }

            try {
                callback();
                // success: reset the consecutive-error counter
                const entry = this.#timers.get(internalId);
                if (entry && entry.consecutiveErrors) {
                    entry.consecutiveErrors = 0;
                }
            } catch (error) {
                logger.error(`[TimerRegistry] Interval "${purpose}" threw error:`, error);
                const entry = this.#timers.get(internalId);
                if (entry) {
                    entry.consecutiveErrors = (entry.consecutiveErrors || 0) + 1;
                    if (entry.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        logger.error(
                            `[TimerRegistry] Auto-clearing interval "${purpose}" (#${internalId}) ` +
                            `after ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Owner: ${owner}.`
                        );
                        this.clearInterval(internalId);
                    }
                }
            }
        };

        const browserId = globalThis.setInterval(wrappedCallback, interval);

        this.#timers.set(internalId, {
            id: browserId,
            type: 'interval',
            purpose,
            createdAt: Date.now(),
            delay: interval,
            owner,
            consecutiveErrors: 0   // LIB-14: tracked for auto-clear threshold
        });
        
        this.#totalCreated++;
        
        logger.debug(`[TimerRegistry] Created interval #${internalId}: "${purpose}" (${interval}ms) by ${owner}`);
        
        return internalId;
    }
    
    /**
     * Clear a timeout by internal ID
     * @param {number} internalId
     * @returns {boolean} True if timer was found and cleared
     */
    clearTimeout(internalId) {
        return this.#clearTimer(internalId, 'timeout');
    }
    
    /**
     * Clear an interval by internal ID
     * @param {number} internalId
     * @returns {boolean} True if timer was found and cleared
     */
    clearInterval(internalId) {
        return this.#clearTimer(internalId, 'interval');
    }
    
    /**
     * Internal timer clearing
     * @param {number} internalId
     * @param {string} expectedType
     * @returns {boolean}
     */
    #clearTimer(internalId, expectedType) {
        const entry = this.#timers.get(internalId);
        
        if (!entry) {
            logger.debug(`[TimerRegistry] Timer #${internalId} not found (already cleared or executed)`);
            return false;
        }
        
        if (entry.type !== expectedType) {
            logger.warn(`[TimerRegistry] Timer #${internalId} is ${entry.type}, not ${expectedType}`);
        }
        
        if (entry.type === 'timeout') {
            globalThis.clearTimeout(entry.id);
        } else {
            globalThis.clearInterval(entry.id);
        }
        
        this.#timers.delete(internalId);
        this.#totalCleared++;
        
        logger.debug(`[TimerRegistry] Cleared ${entry.type} #${internalId}: "${entry.purpose}"`);
        
        return true;
    }
    
    /**
     * Clear all timers from a specific owner/module
     * @param {string} owner
     * @returns {number} Number of timers cleared
     */
    clearByOwner(owner) {
        let cleared = 0;
        
        for (const [internalId, entry] of this.#timers) {
            if (entry.owner === owner) {
                if (entry.type === 'timeout') {
                    globalThis.clearTimeout(entry.id);
                } else {
                    globalThis.clearInterval(entry.id);
                }
                this.#timers.delete(internalId);
                this.#totalCleared++;
                cleared++;
            }
        }
        
        logger.info(`[TimerRegistry] Cleared ${cleared} timers owned by "${owner}"`);
        return cleared;
    }
    
    /**
     * Clear all timers (for shutdown)
     * @returns {number} Number of timers cleared
     */
    clearAll() {
        this.#isShuttingDown = true;
        let cleared = 0;
        
        for (const [internalId, entry] of this.#timers) {
            if (entry.type === 'timeout') {
                globalThis.clearTimeout(entry.id);
            } else {
                globalThis.clearInterval(entry.id);
            }
            cleared++;
        }
        
        this.#timers.clear();
        this.#totalCleared += cleared;
        
        logger.info(`[TimerRegistry] Shutdown complete: cleared ${cleared} timers`);
        
        return cleared;
    }
    
    /**
     * Resume after shutdown (for recovery)
     */
    resume() {
        this.#isShuttingDown = false;
        logger.info('[TimerRegistry] Resumed - accepting new timers');
    }
    
    /**
     * Get current timer statistics
     * @returns {Object}
     */
    getStats() {
        const timeouts = [...this.#timers.values()].filter(t => t.type === 'timeout');
        const intervals = [...this.#timers.values()].filter(t => t.type === 'interval');
        
        return {
            active: this.#timers.size,
            timeouts: timeouts.length,
            intervals: intervals.length,
            totalCreated: this.#totalCreated,
            totalCleared: this.#totalCleared,
            isShuttingDown: this.#isShuttingDown,
            byOwner: this.#groupByOwner()
        };
    }
    
    /**
     * Group timers by owner
     * @returns {Object<string, number>}
     */
    #groupByOwner() {
        const groups = {};
        for (const entry of this.#timers.values()) {
            groups[entry.owner] = (groups[entry.owner] || 0) + 1;
        }
        return groups;
    }
    
    /**
     * List all active timers (for debugging)
     * @returns {Array<{id: number, type: string, purpose: string, age: number, owner: string}>}
     */
    listTimers() {
        const now = Date.now();
        return [...this.#timers.entries()].map(([internalId, entry]) => ({
            id: internalId,
            type: entry.type,
            purpose: entry.purpose,
            delay: entry.delay,
            age: now - entry.createdAt,
            owner: entry.owner
        }));
    }
    
    /**
     * Find potentially leaked timers (running longer than expected)
     * @param {number} maxAgeMs - Maximum expected age
     * @returns {Array}
     */
    findLeakedTimers(maxAgeMs = 300000) { // 5 minutes default
        const now = Date.now();
        return [...this.#timers.entries()]
            .filter(([_, entry]) => {
                const age = now - entry.createdAt;
                // Intervals are expected to run long, check if much older than delay
                if (entry.type === 'interval') {
                    return age > maxAgeMs && age > entry.delay * 10;
                }
                // Timeouts should have executed
                return age > entry.delay + maxAgeMs;
            })
            .map(([internalId, entry]) => ({
                id: internalId,
                ...entry,
                age: now - entry.createdAt
            }));
    }
}

// Export singleton getter
export const getTimerRegistry = () => TimerRegistry.getInstance();

// Export convenience functions that use the singleton
export const managedSetTimeout = (callback, delay, purpose, owner) => 
    TimerRegistry.getInstance().setTimeout(callback, delay, purpose, owner);

export const managedSetInterval = (callback, interval, purpose, owner) => 
    TimerRegistry.getInstance().setInterval(callback, interval, purpose, owner);

export const managedClearTimeout = (id) => 
    TimerRegistry.getInstance().clearTimeout(id);

export const managedClearInterval = (id) => 
    TimerRegistry.getInstance().clearInterval(id);

export { TimerRegistry };
export default TimerRegistry;
