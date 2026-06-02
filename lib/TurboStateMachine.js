/**
 * Ghost Map Pro - Turbo State Machine
 * FIX C-002: Thread-safe state management with mutex pattern
 * 
 * PROBLEM: TURBO_STATE was a plain object accessed from multiple async contexts
 * SOLUTION: Encapsulated state with atomic operations and event emission
 */

import { logger } from './utils.js';
import { Mutex } from './mutex.js';

/**
 * @typedef {Object} TurboStats
 * @property {number} businessesFound
 * @property {number} withWebsite
 * @property {number} withPhone
 * @property {number} withEmail
 */

/**
 * @typedef {Object} TurboStateSnapshot
 * @property {boolean} isRunning
 * @property {boolean} isPaused
 * @property {number} currentBatch
 * @property {number} totalBatches
 * @property {number} completedSearches
 * @property {number} totalSearches
 * @property {number} consecutiveLowYield
 * @property {TurboStats} stats
 * @property {Object} config
 */

/**
 * TurboStateMachine - Thread-safe state management for area search
 * 
 * Usage:
 *   const state = TurboStateMachine.getInstance();
 *   await state.start(config);
 *   await state.incrementBatch();
 *   const snapshot = state.getSnapshot();
 */
class TurboStateMachine {
    static #instance = null;
    
    /** @type {Mutex} */
    #mutex;
    
    /** @type {boolean} */
    #isRunning = false;
    
    /** @type {boolean} */
    #isPaused = false;
    
    /** @type {number} */
    #currentBatch = 0;
    
    /** @type {number} */
    #totalBatches = 0;
    
    /** @type {number} */
    #completedSearches = 0;
    
    /** @type {number} */
    #totalSearches = 0;
    
    /** @type {number} */
    #consecutiveLowYield = 0;
    
    /** @type {number|null} */
    #startTime = null;
    
    /** @type {TurboStats} */
    #stats = {
        businessesFound: 0,
        withWebsite: 0,
        withPhone: 0,
        withEmail: 0
    };
    
    /** @type {Object} */
    #config = {};
    
    /** @type {Map<string, Function[]>} */
    #listeners = new Map();
    
    // FIX H-001: Limited search history instead of unbounded array
    /** @type {Array} */
    #recentSearches = [];
    
    /** @type {number} */
    #maxRecentSearches = 100; // Keep only last 100 for debugging
    
    constructor() {
        if (TurboStateMachine.#instance) {
            throw new Error('Use TurboStateMachine.getInstance() instead of new');
        }
        this.#mutex = new Mutex();
        logger.info('[TurboStateMachine] Initialized with mutex protection');
    }
    
    /**
     * Get singleton instance
     * @returns {TurboStateMachine}
     */
    static getInstance() {
        if (!TurboStateMachine.#instance) {
            TurboStateMachine.#instance = new TurboStateMachine();
        }
        return TurboStateMachine.#instance;
    }
    
    /**
     * Start a new turbo search session
     * @param {Object} config - Search configuration
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async start(config) {
        const release = await this.#mutex.acquire();
        
        try {
            if (this.#isRunning) {
                return { success: false, error: 'Already running' };
            }
            
            // Reset all state
            this.#isRunning = true;
            this.#isPaused = false;
            this.#currentBatch = 0;
            this.#totalBatches = 0;
            this.#completedSearches = 0;
            this.#totalSearches = 0;
            this.#consecutiveLowYield = 0;
            this.#startTime = Date.now();
            this.#stats = {
                businessesFound: 0,
                withWebsite: 0,
                withPhone: 0,
                withEmail: 0
            };
            this.#config = { ...config };
            
            // FIX H-001: Clear search history on new session
            this.#recentSearches = [];
            
            this.#emit('started', this.getSnapshot());
            logger.info('[TurboStateMachine] Session started');
            
            return { success: true };
        } finally {
            release();
        }
    }
    
    /**
     * Stop the current session
     * @returns {Promise<TurboStateSnapshot>}
     */
    async stop() {
        const release = await this.#mutex.acquire();
        
        try {
            const finalSnapshot = this.getSnapshot();
            
            this.#isRunning = false;
            this.#isPaused = false;
            
            // FIX H-001: Clear accumulated data
            this.#recentSearches = [];
            
            this.#emit('stopped', finalSnapshot);
            logger.info('[TurboStateMachine] Session stopped');
            
            return finalSnapshot;
        } finally {
            release();
        }
    }
    
    /**
     * Pause the current session
     * @returns {Promise<boolean>}
     */
    async pause() {
        const release = await this.#mutex.acquire();
        
        try {
            if (!this.#isRunning || this.#isPaused) {
                return false;
            }
            
            this.#isPaused = true;
            this.#emit('paused', this.getSnapshot());
            logger.info('[TurboStateMachine] Session paused');
            
            return true;
        } finally {
            release();
        }
    }
    
    /**
     * Resume a paused session
     * @returns {Promise<boolean>}
     */
    async resume() {
        const release = await this.#mutex.acquire();
        
        try {
            if (!this.#isRunning || !this.#isPaused) {
                return false;
            }
            
            this.#isPaused = false;
            this.#emit('resumed', this.getSnapshot());
            logger.info('[TurboStateMachine] Session resumed');
            
            return true;
        } finally {
            release();
        }
    }
    
    /**
     * Set total batches count
     * @param {number} total
     */
    async setTotalBatches(total) {
        const release = await this.#mutex.acquire();
        try {
            this.#totalBatches = total;
        } finally {
            release();
        }
    }
    
    /**
     * Set total searches count
     * @param {number} total
     */
    async setTotalSearches(total) {
        const release = await this.#mutex.acquire();
        try {
            this.#totalSearches = total;
        } finally {
            release();
        }
    }
    
    /**
     * Increment current batch (atomic)
     * @returns {Promise<number>} New batch number
     */
    async incrementBatch() {
        const release = await this.#mutex.acquire();
        try {
            this.#currentBatch++;
            this.#emit('batchProgress', {
                current: this.#currentBatch,
                total: this.#totalBatches
            });
            return this.#currentBatch;
        } finally {
            release();
        }
    }
    
    /**
     * Increment completed searches (atomic)
     * @returns {Promise<number>} New completed count
     */
    async incrementCompletedSearches() {
        const release = await this.#mutex.acquire();
        try {
            this.#completedSearches++;
            return this.#completedSearches;
        } finally {
            release();
        }
    }
    
    /**
     * Record a search result
     * @param {Object} searchResult
     * @param {number} searchResult.newBusinesses - New businesses found
     * @param {number} searchResult.duplicates - Duplicate count
     * @param {number} [searchResult.withWebsite] - Count of new businesses that have a website
     * @param {number} [searchResult.withPhone]   - Count that have a phone number
     * @param {number} [searchResult.withEmail]   - Count that have an email (LIB-15: previously dropped)
     */
    async recordSearchResult(searchResult) {
        const release = await this.#mutex.acquire();

        try {
            // LIB-15 FIX (2026-05-10): the `withEmail` field was declared in
            // the TurboStats typedef (#stats initializer line 77, also reset
            // on line 138) but NEVER incremented here — pre-fix destructured
            // only `newBusinesses, duplicates, withWebsite, withPhone`,
            // so even when callers passed `withEmail` it was dropped on the
            // floor. Anyone reading getStats().withEmail saw a permanent 0,
            // making the field dead telemetry that contradicted the public
            // typedef. The fix destructures it AND increments the stat.
            const { newBusinesses = 0, duplicates = 0, withWebsite = 0, withPhone = 0, withEmail = 0 } = searchResult;

            // Update stats
            this.#stats.businessesFound += newBusinesses;
            this.#stats.withWebsite += withWebsite;
            this.#stats.withPhone += withPhone;
            this.#stats.withEmail += withEmail;  // LIB-15
            
            // FIX H-001: Keep only recent searches for debugging
            if (this.#recentSearches.length >= this.#maxRecentSearches) {
                this.#recentSearches.shift(); // Remove oldest
            }
            this.#recentSearches.push({
                timestamp: Date.now(),
                newBusinesses,
                duplicates
            });
            
            // Track low yield for early termination
            const LOW_YIELD_THRESHOLD = 2;
            if (newBusinesses < LOW_YIELD_THRESHOLD) {
                this.#consecutiveLowYield++;
            } else {
                this.#consecutiveLowYield = 0;
            }
            
            this.#emit('searchRecorded', {
                newBusinesses,
                duplicates,
                consecutiveLowYield: this.#consecutiveLowYield
            });
            
        } finally {
            release();
        }
    }
    
    /**
     * Check if should stop due to low yield
     * @param {number} threshold - Max consecutive low yields
     * @returns {boolean}
     */
    shouldStopForLowYield(threshold = 3) {
        return this.#consecutiveLowYield >= threshold;
    }
    
    /**
     * Get current state snapshot (read-only)
     * @returns {TurboStateSnapshot}
     */
    getSnapshot() {
        return {
            isRunning: this.#isRunning,
            isPaused: this.#isPaused,
            currentBatch: this.#currentBatch,
            totalBatches: this.#totalBatches,
            completedSearches: this.#completedSearches,
            totalSearches: this.#totalSearches,
            consecutiveLowYield: this.#consecutiveLowYield,
            startTime: this.#startTime,
            runtime: this.#startTime ? Date.now() - this.#startTime : 0,
            stats: { ...this.#stats },
            config: { ...this.#config },
            recentSearchesCount: this.#recentSearches.length
        };
    }
    
    /**
     * Quick status check (no mutex needed for reads)
     */
    get isRunning() { return this.#isRunning; }
    get isPaused() { return this.#isPaused; }
    get canProceed() { return this.#isRunning && !this.#isPaused; }
    
    /**
     * Subscribe to state changes
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
        if (!this.#listeners.has(event)) {
            this.#listeners.set(event, []);
        }
        this.#listeners.get(event).push(callback);
        
        // Return unsubscribe function
        return () => {
            const listeners = this.#listeners.get(event);
            const index = listeners.indexOf(callback);
            if (index > -1) {
                listeners.splice(index, 1);
            }
        };
    }
    
    /**
     * Emit event to listeners
     * @param {string} event
     * @param {any} data
     */
    #emit(event, data) {
        const listeners = this.#listeners.get(event) || [];
        listeners.forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                logger.error(`[TurboStateMachine] Event handler error for ${event}:`, error);
            }
        });
    }
    
    /**
     * Get memory usage estimate
     * @returns {number} Bytes
     */
    getMemoryUsage() {
        const searchesSize = JSON.stringify(this.#recentSearches).length * 2; // UTF-16
        const configSize = JSON.stringify(this.#config).length * 2;
        return searchesSize + configSize + 1024; // 1KB overhead estimate
    }
}

export { TurboStateMachine };
export default TurboStateMachine;
