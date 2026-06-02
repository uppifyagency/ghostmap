/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 * 
 * INSPIRED BY: Crawlee Snapshotter & SystemStatus
 * https://crawlee.dev/js/docs/guides/avoid-blocking
 */

/**
 * Ghost Map Pro - System Monitor
 * Browser-compatible system resource monitoring for:
 * - Memory usage tracking
 * - Tab count monitoring
 * - Storage quota tracking
 * - Automatic throttling when overloaded
 * 
 * CRAWLEE FEATURE 3.1
 */

import { logger } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM MONITOR CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class SystemMonitor {
    /**
     * Create a new SystemMonitor
     * @param {Object} options - Configuration options
     * @param {number} [options.snapshotIntervalMs=5000] - How often to take snapshots
     * @param {number} [options.historySize=60] - Number of snapshots to keep (5 min at 5s interval)
     * @param {number} [options.memoryWarningRatio=0.8] - Memory threshold for warning (80%)
     * @param {number} [options.memoryCriticalRatio=0.9] - Memory threshold for critical (90%)
     * @param {number} [options.maxTabsWarning=15] - Tab count threshold for warning
     * @param {number} [options.maxTabsCritical=25] - Tab count threshold for critical
     */
    constructor(options = {}) {
        this.options = {
            snapshotIntervalMs: options.snapshotIntervalMs || 5000,
            historySize: options.historySize || 60,
            memoryWarningRatio: options.memoryWarningRatio || 0.8,
            memoryCriticalRatio: options.memoryCriticalRatio || 0.9,
            // M-1 FIX: Further increased thresholds - these count ALL browser tabs, not just extension tabs
            // Power users commonly have 50+ tabs open; previous 50/100 still caused false positives
            maxTabsWarning: options.maxTabsWarning || 75,
            maxTabsCritical: options.maxTabsCritical || 150,
            storageWarningRatio: options.storageWarningRatio || 0.7
        };

        // Snapshot history
        this.snapshots = [];
        this.interval = null;
        this.isRunning = false;

        // Event callbacks
        // BUG-Bulk-Falsy-Defaults (codemod, 2026-05-09): `||` → `??` consistency.
        // For null-defaulted callback hooks, the difference is cosmetic (null
        // input gives null result either way) but `??` is the intended idiom
        // for "use default only if explicitly absent".
        this.onWarning = options.onWarning ?? null;
        this.onCritical = options.onCritical ?? null;
        this.onRecovered = options.onRecovered ?? null;

        // State tracking
        this.lastState = 'normal'; // normal, warning, critical
        this.stateChangedAt = Date.now();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Start monitoring
     */
    async start() {
        if (this.isRunning) return;

        this.isRunning = true;
        this.interval = setInterval(() => this._takeSnapshot(), this.options.snapshotIntervalMs);

        // Take initial snapshot
        await this._takeSnapshot();

        logger.info(`[SystemMonitor] 🖥️ Started (interval: ${this.options.snapshotIntervalMs}ms, history: ${this.options.historySize})`);
    }

    /**
     * Stop monitoring
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.isRunning = false;
        logger.info('[SystemMonitor] Stopped');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Snapshot Collection
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Take a system snapshot
     * @private
     */
    async _takeSnapshot() {
        try {
            const snapshot = {
                timestamp: Date.now(),
                memory: await this._getMemoryInfo(),
                tabs: await this._getTabInfo(),
                storage: await this._getStorageInfo(),
                performance: this._getPerformanceInfo()
            };

            // Add to history
            this.snapshots.push(snapshot);

            // Trim history
            while (this.snapshots.length > this.options.historySize) {
                this.snapshots.shift();
            }

            // Evaluate state
            this._evaluateState(snapshot);

            return snapshot;
        } catch (error) {
            logger.warn(`[SystemMonitor] Snapshot failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Get memory information
     * @private
     */
    async _getMemoryInfo() {
        // Try chrome.system.memory first (requires "system.memory" permission)
        if (typeof chrome !== 'undefined' && chrome.system?.memory) {
            try {
                const info = await chrome.system.memory.getInfo();
                return {
                    total: info.capacity,
                    available: info.availableCapacity,
                    used: info.capacity - info.availableCapacity,
                    ratio: (info.capacity - info.availableCapacity) / info.capacity,
                    source: 'chrome.system.memory'
                };
            } catch (e) {
                // Fall through to other methods
            }
        }

        // Try performance.memory (Chrome only, limited)
        if (typeof performance !== 'undefined' && performance.memory) {
            return {
                total: performance.memory.jsHeapSizeLimit,
                used: performance.memory.usedJSHeapSize,
                available: performance.memory.jsHeapSizeLimit - performance.memory.usedJSHeapSize,
                ratio: performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit,
                source: 'performance.memory'
            };
        }

        // Fallback - estimate based on typical extension limits
        return {
            total: 512 * 1024 * 1024, // Assume 512MB limit
            used: 0,
            available: 512 * 1024 * 1024,
            ratio: 0,
            source: 'estimate'
        };
    }

    /**
     * Get tab information
     * @private
     */
    async _getTabInfo() {
        if (typeof chrome === 'undefined' || !chrome.tabs) {
            return { total: 0, extensionRelated: 0, mapsTab: 0 };
        }

        try {
            const tabs = await chrome.tabs.query({});

            // Count different tab types
            let mapsTab = 0;
            let extensionRelated = 0;

            for (const tab of tabs) {
                if (tab.url?.includes('google.com/maps')) {
                    mapsTab++;
                    extensionRelated++;
                } else if (tab.url?.startsWith('chrome-extension://')) {
                    extensionRelated++;
                }
            }

            return {
                total: tabs.length,
                extensionRelated,
                mapsTab
            };
        } catch (error) {
            return { total: 0, extensionRelated: 0, mapsTab: 0 };
        }
    }

    /**
     * Get storage information
     * @private
     */
    async _getStorageInfo() {
        // Try navigator.storage.estimate
        if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
            try {
                const estimate = await navigator.storage.estimate();
                return {
                    quota: estimate.quota || 0,
                    usage: estimate.usage || 0,
                    ratio: estimate.quota ? estimate.usage / estimate.quota : 0,
                    source: 'navigator.storage'
                };
            } catch (e) {
                // Fall through
            }
        }

        // Try chrome.storage.local.getBytesInUse
        if (typeof chrome !== 'undefined' && chrome.storage?.local?.getBytesInUse) {
            try {
                const bytesInUse = await new Promise((resolve) => {
                    chrome.storage.local.getBytesInUse(null, resolve);
                });
                // Chrome local storage limit is typically 10MB for extensions
                const quota = 10 * 1024 * 1024;
                return {
                    quota,
                    usage: bytesInUse,
                    ratio: bytesInUse / quota,
                    source: 'chrome.storage'
                };
            } catch (e) {
                // Fall through
            }
        }

        return { quota: 0, usage: 0, ratio: 0, source: 'unknown' };
    }

    /**
     * Get performance timing info
     * @private
     */
    _getPerformanceInfo() {
        if (typeof performance === 'undefined') {
            return { entries: 0, heapUsed: 0 };
        }

        return {
            entries: performance.getEntries?.()?.length || 0,
            heapUsed: performance.memory?.usedJSHeapSize || 0,
            timeOrigin: performance.timeOrigin || 0
        };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // State Evaluation
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Evaluate system state from snapshot
     * @private
     */
    _evaluateState(snapshot) {
        const { memory, tabs, storage } = snapshot;
        let newState = 'normal';
        const issues = [];

        // Check memory
        if (memory.ratio >= this.options.memoryCriticalRatio) {
            newState = 'critical';
            issues.push(`Memory critical: ${(memory.ratio * 100).toFixed(1)}%`);
        } else if (memory.ratio >= this.options.memoryWarningRatio) {
            if (newState !== 'critical') newState = 'warning';
            issues.push(`Memory high: ${(memory.ratio * 100).toFixed(1)}%`);
        }

        // Check tabs
        if (tabs.total >= this.options.maxTabsCritical) {
            newState = 'critical';
            issues.push(`Too many tabs: ${tabs.total}`);
        } else if (tabs.total >= this.options.maxTabsWarning) {
            if (newState !== 'critical') newState = 'warning';
            issues.push(`High tab count: ${tabs.total}`);
        }

        // Check storage
        if (storage.ratio >= this.options.storageWarningRatio) {
            if (newState !== 'critical') newState = 'warning';
            issues.push(`Storage high: ${(storage.ratio * 100).toFixed(1)}%`);
        }

        // State change handling
        if (newState !== this.lastState) {
            this.stateChangedAt = Date.now();

            if (newState === 'critical') {
                logger.error(`[SystemMonitor] 🚨 CRITICAL: ${issues.join(', ')}`);
                this.onCritical?.(snapshot, issues);
            } else if (newState === 'warning') {
                logger.warn(`[SystemMonitor] ⚠️ WARNING: ${issues.join(', ')}`);
                this.onWarning?.(snapshot, issues);
            } else if (this.lastState !== 'normal') {
                logger.info(`[SystemMonitor] ✅ Recovered to normal state`);
                this.onRecovered?.(snapshot);
            }

            this.lastState = newState;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get current system status
     * @returns {Object} Current status
     */
    getStatus() {
        const latest = this.snapshots[this.snapshots.length - 1];

        if (!latest) {
            return {
                state: 'unknown',
                isOverloaded: false,
                shouldThrottle: false,
                memory: { ratio: 0 },
                tabs: { total: 0 },
                storage: { ratio: 0 }
            };
        }

        return {
            state: this.lastState,
            isOverloaded: this.lastState === 'critical',
            shouldThrottle: this.lastState !== 'normal',
            memory: latest.memory,
            tabs: latest.tabs,
            storage: latest.storage,
            timestamp: latest.timestamp,
            stateAge: Date.now() - this.stateChangedAt
        };
    }

    /**
     * Check if system should throttle operations
     * @returns {boolean}
     */
    shouldThrottle() {
        return this.lastState !== 'normal';
    }

    /**
     * Check if system is critically overloaded
     * @returns {boolean}
     */
    isOverloaded() {
        return this.lastState === 'critical';
    }

    /**
     * Get recommended concurrency based on system state
     * @param {number} baseConcurrency - Base concurrency level
     * @returns {number} Recommended concurrency
     */
    getRecommendedConcurrency(baseConcurrency = 5) {
        switch (this.lastState) {
            case 'critical':
                return 1; // Minimum
            case 'warning':
                return Math.max(1, Math.floor(baseConcurrency / 2));
            default:
                return baseConcurrency;
        }
    }

    /**
     * Get trend information (is system getting better or worse?)
     * @returns {Object} Trend info
     */
    getTrend() {
        if (this.snapshots.length < 5) {
            return { direction: 'stable', confidence: 'low' };
        }

        // Compare recent vs older snapshots
        const recent = this.snapshots.slice(-5);
        const older = this.snapshots.slice(-10, -5);

        if (older.length === 0) {
            return { direction: 'stable', confidence: 'low' };
        }

        const recentAvgMemory = recent.reduce((sum, s) => sum + s.memory.ratio, 0) / recent.length;
        const olderAvgMemory = older.reduce((sum, s) => sum + s.memory.ratio, 0) / older.length;

        const memoryDelta = recentAvgMemory - olderAvgMemory;

        if (Math.abs(memoryDelta) < 0.05) {
            return { direction: 'stable', confidence: 'medium', delta: memoryDelta };
        } else if (memoryDelta > 0) {
            return { direction: 'worsening', confidence: 'high', delta: memoryDelta };
        } else {
            return { direction: 'improving', confidence: 'high', delta: memoryDelta };
        }
    }

    /**
     * Get statistics summary
     * @returns {Object}
     */
    getStats() {
        if (this.snapshots.length === 0) {
            return { snapshotCount: 0 };
        }

        const memoryRatios = this.snapshots.map(s => s.memory.ratio);
        const avgMemory = memoryRatios.reduce((a, b) => a + b, 0) / memoryRatios.length;
        const maxMemory = Math.max(...memoryRatios);
        const minMemory = Math.min(...memoryRatios);

        return {
            snapshotCount: this.snapshots.length,
            currentState: this.lastState,
            stateAge: Date.now() - this.stateChangedAt,
            memory: {
                current: memoryRatios[memoryRatios.length - 1],
                avg: avgMemory,
                max: maxMemory,
                min: minMemory
            },
            trend: this.getTrend()
        };
    }

    /**
     * Force a snapshot now
     * @returns {Promise<Object>}
     */
    async forceSnapshot() {
        return this._takeSnapshot();
    }

    /**
     * Clear snapshot history
     */
    clearHistory() {
        this.snapshots = [];
        this.lastState = 'normal';
        this.stateChangedAt = Date.now();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
//
// MV3 SW EVICTION POLICY (B11-6 cluster triage 2026-05-10): SAFE-BY-SEMANTICS.
// SystemMonitor holds a rolling 60-snapshot history of memory/tabs/storage
// readings + a state machine (normal → warning → critical) that is RE-EVALUATED
// on every snapshot, not history-dependent. Loss at eviction resets history;
// next _takeSnapshot() re-establishes current system state. Transitions
// remain correct because they're event-driven on snapshot value, not on
// historical trends. CAVEAT: the setInterval that drives snapshots dies
// with the SW; re-armed on next wake when initialize() runs again.

// SW-EVICTION-SAFE: ephemeral singleton; rolling history re-fills on wake.
let _instance = null;

/**
 * Get the singleton SystemMonitor instance
 * @param {Object} [options] - Options for first initialization
 * @returns {SystemMonitor}
 */
export function getSystemMonitor(options = {}) {
    if (!_instance) {
        _instance = new SystemMonitor(options);
    }
    return _instance;
}

/**
 * Initialize and start the SystemMonitor
 * @param {Object} [options] - Configuration options
 * @returns {Promise<SystemMonitor>}
 */
export async function initializeSystemMonitor(options = {}) {
    const monitor = getSystemMonitor(options);
    if (!monitor.isRunning) {
        await monitor.start();
    }
    return monitor;
}

/**
 * Stop the SystemMonitor
 */
export function stopSystemMonitor() {
    if (_instance) {
        _instance.stop();
    }
}

export default SystemMonitor;
