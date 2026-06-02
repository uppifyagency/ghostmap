/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 * 
 * INSPIRED BY: Crawlee AutoscaledPool
 * https://crawlee.dev/js/docs/guides/scaling-crawlers
 */

/**
 * Ghost Map Pro - AutoScaler
 * Adaptive concurrency control based on:
 * - System resource status
 * - Success rate of recent requests
 * - Error patterns
 * 
 * Automatically scales up when things are going well,
 * and scales down when detecting problems.
 * 
 * CRAWLEE FEATURE 3.2
 */

import { logger } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOSCALER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class AutoScaler {
    /**
     * Create a new AutoScaler
     * @param {Object} options - Configuration options
     * @param {number} [options.minConcurrency=1] - Minimum concurrency level
     * @param {number} [options.maxConcurrency=10] - Maximum concurrency level
     * @param {number} [options.desiredConcurrency=3] - Starting concurrency level
     * @param {number} [options.scaleUpStepSize=1] - How much to increase per scale up
     * @param {number} [options.scaleDownStepSize=1] - How much to decrease per scale down
     * @param {number} [options.scaleUpIntervalMs=10000] - Minimum time between scale ups
     * @param {number} [options.scaleDownIntervalMs=5000] - Minimum time between scale downs
     * @param {number} [options.successRateThresholdUp=0.9] - Success rate needed to scale up
     * @param {number} [options.successRateThresholdDown=0.7] - Success rate below which to scale down
     * @param {number} [options.windowSize=20] - Size of rolling success window
     */
    constructor(options = {}) {
        // BUG-AS-Falsy-Defaults (AutoScaler audit, 2026-05-09):
        // Pre-fix used `||` for option defaults. The `||` falsy fallback
        // fires for ANY falsy value including legitimate `0` — so an
        // explicit caller intent like `scaleUpIntervalMs: 0` (no cooldown)
        // or `successRateThresholdUp: 0` (always scale up) was silently
        // overridden by the default. Switching to `??` (nullish-coalesce)
        // preserves caller-provided zeros and only falls back when the
        // option is truly absent. Real-world impact today is theoretical
        // (no current caller passes 0 — see background/jobQueue.js:41,
        // background/index.js:218), but the fix removes a defensive trap.
        // Test: tests/run-autoscaler-pure-logic-node.mjs (Test 1).
        this.options = {
            minConcurrency: options.minConcurrency ?? 1,
            maxConcurrency: options.maxConcurrency ?? 10,
            desiredConcurrency: options.desiredConcurrency ?? 3,
            scaleUpStepSize: options.scaleUpStepSize ?? 1,
            scaleDownStepSize: options.scaleDownStepSize ?? 1,
            scaleUpIntervalMs: options.scaleUpIntervalMs ?? 10000,
            scaleDownIntervalMs: options.scaleDownIntervalMs ?? 5000,
            successRateThresholdUp: options.successRateThresholdUp ?? 0.9,
            successRateThresholdDown: options.successRateThresholdDown ?? 0.7,
            windowSize: options.windowSize ?? 20,
            // Cooldown after errors before allowing scale up
            errorCooldownMs: options.errorCooldownMs ?? 30000
        };

        // Current state
        this.currentConcurrency = this.options.desiredConcurrency;
        this.desiredConcurrency = this.options.desiredConcurrency;

        // Timing
        this.lastScaleUp = 0;
        this.lastScaleDown = 0;
        this.lastError = 0;

        // Rolling window for success tracking
        this.successWindow = [];

        // Statistics
        this.stats = {
            scaleUpCount: 0,
            scaleDownCount: 0,
            totalEvaluations: 0,
            peakConcurrency: this.options.desiredConcurrency,
            lowestConcurrency: this.options.desiredConcurrency
        };

        logger.info(`[AutoScaler] 🎚️ Initialized: min=${this.options.minConcurrency}, max=${this.options.maxConcurrency}, initial=${this.desiredConcurrency}`);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Result Recording
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Record the result of a request
     * @param {boolean} success - Whether the request succeeded
     * @param {Object} [metadata] - Optional metadata about the request
     */
    recordResult(success, metadata = {}) {
        // Add to rolling window
        this.successWindow.push({
            success: success ? 1 : 0,
            timestamp: Date.now(),
            ...metadata
        });

        // Trim to window size
        while (this.successWindow.length > this.options.windowSize) {
            this.successWindow.shift();
        }

        // Track last error time
        if (!success) {
            this.lastError = Date.now();
        }
    }

    /**
     * Get current success rate from rolling window
     * @returns {number} Success rate (0-1)
     */
    getSuccessRate() {
        if (this.successWindow.length === 0) {
            return 1; // No data, assume good
        }

        const successCount = this.successWindow.reduce((sum, r) => sum + r.success, 0);
        return successCount / this.successWindow.length;
    }

    /**
     * Get weighted success rate (recent results matter more)
     * @returns {number} Weighted success rate (0-1)
     */
    getWeightedSuccessRate() {
        if (this.successWindow.length === 0) {
            return 1;
        }

        let weightedSum = 0;
        let weightSum = 0;

        this.successWindow.forEach((result, index) => {
            // Linear weight: more recent = higher weight
            const weight = index + 1;
            weightedSum += result.success * weight;
            weightSum += weight;
        });

        return weightedSum / weightSum;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Evaluation
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Evaluate current state and adjust concurrency
     * @param {Object} systemStatus - Status from SystemMonitor
     * @returns {number} New desired concurrency
     */
    evaluate(systemStatus = {}) {
        // LIB-6 FIX (2026-05-10): honour the _paused flag set by pause()/resume().
        // Pre-fix `evaluate()` ignored _paused entirely — pause()/resume() were
        // documented contract-promises that did not affect scaling decisions.
        // Concretely: a caller pausing the scaler before triggering a cleanup
        // that involves error spikes would still observe scale-down because
        // the periodic evaluate() tick continued running. After resume() the
        // cleanup-induced low concurrency would persist with no scale-up
        // signal until the next normal failure → success transition.
        if (this._paused) {
            return this.desiredConcurrency;
        }
        this.stats.totalEvaluations++;
        const now = Date.now();
        const successRate = this.getSuccessRate();
        const weightedRate = this.getWeightedSuccessRate();

        // Use the lower of the two rates for safer decisions
        const effectiveRate = Math.min(successRate, weightedRate);

        // Check if system is overloaded
        const isOverloaded = systemStatus.isOverloaded || systemStatus.shouldThrottle;

        // Conditions for scale UP
        const canScaleUp = 
            !isOverloaded &&
            effectiveRate >= this.options.successRateThresholdUp &&
            now - this.lastScaleUp >= this.options.scaleUpIntervalMs &&
            now - this.lastError >= this.options.errorCooldownMs &&
            this.desiredConcurrency < this.options.maxConcurrency &&
            this.successWindow.length >= 5; // Need some data

        // Conditions for scale DOWN
        const shouldScaleDown =
            isOverloaded ||
            effectiveRate < this.options.successRateThresholdDown ||
            (systemStatus.state === 'critical');

        // Apply scaling decisions
        if (shouldScaleDown && this.desiredConcurrency > this.options.minConcurrency) {
            // Scale down
            const oldConcurrency = this.desiredConcurrency;
            
            // Scale down more aggressively if critical
            const stepSize = systemStatus.state === 'critical' 
                ? this.options.scaleDownStepSize * 2 
                : this.options.scaleDownStepSize;

            this.desiredConcurrency = Math.max(
                this.desiredConcurrency - stepSize,
                this.options.minConcurrency
            );

            if (this.desiredConcurrency !== oldConcurrency) {
                this.lastScaleDown = now;
                this.stats.scaleDownCount++;
                this.stats.lowestConcurrency = Math.min(this.stats.lowestConcurrency, this.desiredConcurrency);

                const reason = isOverloaded ? 'system overloaded' : `low success rate (${(effectiveRate * 100).toFixed(1)}%)`;
                logger.warn(`[AutoScaler] 📉 Scaling DOWN: ${oldConcurrency} → ${this.desiredConcurrency} (${reason})`);
            }
        } else if (canScaleUp) {
            // Scale up
            const oldConcurrency = this.desiredConcurrency;

            this.desiredConcurrency = Math.min(
                this.desiredConcurrency + this.options.scaleUpStepSize,
                this.options.maxConcurrency
            );

            if (this.desiredConcurrency !== oldConcurrency) {
                this.lastScaleUp = now;
                this.stats.scaleUpCount++;
                this.stats.peakConcurrency = Math.max(this.stats.peakConcurrency, this.desiredConcurrency);

                logger.info(`[AutoScaler] 📈 Scaling UP: ${oldConcurrency} → ${this.desiredConcurrency} (success rate: ${(effectiveRate * 100).toFixed(1)}%)`);
            }
        }

        // Update current concurrency (smooth transition)
        this.currentConcurrency = this.desiredConcurrency;

        return this.desiredConcurrency;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get current desired concurrency
     * @returns {number}
     */
    getConcurrency() {
        return this.desiredConcurrency;
    }

    /**
     * Get current concurrency (alias)
     * @returns {number}
     */
    getCurrentConcurrency() {
        return this.currentConcurrency;
    }

    /**
     * Force set concurrency (manual override)
     * @param {number} concurrency - New concurrency level
     */
    setConcurrency(concurrency) {
        const clamped = Math.min(
            Math.max(concurrency, this.options.minConcurrency),
            this.options.maxConcurrency
        );

        if (clamped !== this.desiredConcurrency) {
            logger.info(`[AutoScaler] ⚙️ Manual override: ${this.desiredConcurrency} → ${clamped}`);
            this.desiredConcurrency = clamped;
            this.currentConcurrency = clamped;
        }
    }

    /**
     * Temporarily pause auto-scaling (useful during cleanup)
     */
    pause() {
        this._paused = true;
        logger.debug('[AutoScaler] Paused');
    }

    /**
     * Resume auto-scaling
     */
    resume() {
        this._paused = false;
        logger.debug('[AutoScaler] Resumed');
    }

    /**
     * Check if we have capacity for more work
     * @param {number} currentActive - Currently active tasks
     * @returns {boolean}
     */
    hasCapacity(currentActive) {
        return currentActive < this.desiredConcurrency;
    }

    /**
     * Get available slots
     * @param {number} currentActive - Currently active tasks
     * @returns {number} Number of available slots
     */
    getAvailableSlots(currentActive) {
        return Math.max(0, this.desiredConcurrency - currentActive);
    }

    /**
     * Get statistics
     * @returns {Object}
     */
    getStats() {
        return {
            currentConcurrency: this.currentConcurrency,
            desiredConcurrency: this.desiredConcurrency,
            minConcurrency: this.options.minConcurrency,
            maxConcurrency: this.options.maxConcurrency,
            successRate: this.getSuccessRate(),
            weightedSuccessRate: this.getWeightedSuccessRate(),
            windowSize: this.successWindow.length,
            ...this.stats,
            timeSinceLastScaleUp: Date.now() - this.lastScaleUp,
            timeSinceLastScaleDown: Date.now() - this.lastScaleDown,
            timeSinceLastError: Date.now() - this.lastError
        };
    }

    /**
     * Reset to initial state
     */
    reset() {
        this.currentConcurrency = this.options.desiredConcurrency;
        this.desiredConcurrency = this.options.desiredConcurrency;
        this.successWindow = [];
        this.lastScaleUp = 0;
        this.lastScaleDown = 0;
        this.lastError = 0;
        this.stats = {
            scaleUpCount: 0,
            scaleDownCount: 0,
            totalEvaluations: 0,
            peakConcurrency: this.options.desiredConcurrency,
            lowestConcurrency: this.options.desiredConcurrency
        };
        logger.info('[AutoScaler] Reset to initial state');
    }

    /**
     * Get a summary string for logging
     * @returns {string}
     */
    toString() {
        const rate = this.getSuccessRate();
        return `Concurrency: ${this.desiredConcurrency}/${this.options.maxConcurrency} | Success: ${(rate * 100).toFixed(0)}% | ↑${this.stats.scaleUpCount} ↓${this.stats.scaleDownCount}`;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
//
// MV3 SW EVICTION POLICY (B11-6 cluster triage 2026-05-10): SAFE-BY-SEMANTICS.
// _instance / _authoritativeConfig hold an AutoScaler instance with rolling
// stats (successWindow last-20, scale-up/down timers, concurrency level).
// Loss at SW eviction resets the rolling window — adaptive scaling has a
// brief "cold start" at wake but rapidly re-converges. The next
// getAutoScaler() re-creates the singleton with the same config (same
// _authoritativeConfig path on the new module instance) so callers see
// consistent behavior. NO data corruption, just transient metric reset.

// SW-EVICTION-SAFE: ephemeral singleton; rolling stats reset on wake by design.
let _instance = null;

/**
 * Authoritative config snapshot, captured on first initialization
 * @type {Object|null}
 */
// SW-EVICTION-SAFE: config snapshot re-captured on next getAutoScaler() at wake.
let _authoritativeConfig = null;

/**
 * Get the singleton AutoScaler instance
 * M8-CONFLICT FIX: Detects conflicting config and warns without overwriting
 * @param {Object} [options] - Options for first initialization
 * @returns {AutoScaler}
 */
export function getAutoScaler(options = {}) {
    if (!_instance) {
        _instance = new AutoScaler(options);
        _instance._lastConflictWarning = null;
        _authoritativeConfig = { ...options };
    } else if (Object.keys(options).length > 0) {
        // M8-CONFLICT FIX: Detect actual value conflicts
        const conflicts = [];
        for (const key of Object.keys(options)) {
            if (key in _authoritativeConfig && options[key] !== _authoritativeConfig[key]) {
                conflicts.push(`${key}: ${_authoritativeConfig[key]} (authoritative) vs ${options[key]} (requested)`);
            }
        }

        if (conflicts.length > 0) {
            const warningMsg = `[AutoScaler] Conflicting singleton config ignored: ${conflicts.join(', ')}`;
            logger.warn(warningMsg);
            _instance._lastConflictWarning = warningMsg;
        } else {
            _instance._lastConflictWarning = null;
        }
    }
    return _instance;
}

/**
 * Reset the AutoScaler singleton
 */
export function resetAutoScaler() {
    if (_instance) {
        _instance.reset();
    }
}

/**
 * Reset singleton for test isolation (test-only)
 */
export function resetAutoScalerForTest() {
    _instance = null;
    _authoritativeConfig = null;
}

export default AutoScaler;
