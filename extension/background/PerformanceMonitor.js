/**
 * Performance Monitor
 * Tracks system health and scraping metrics
 */
export class PerformanceMonitor {
    constructor() {
        this.metrics = {
            startTime: Date.now(),
            jobsCompleted: 0,
            jobsFailed: 0,
            totalProcessingTime: 0,
            averageProcessingTime: 0,
            errors: {},
            memoryUsage: 'N/A'
        };
    }

    /**
     * Record job completion
     * @param {number} durationMs - Duration in milliseconds
     * @param {boolean} success - Whether job succeeded
     */
    recordJob(durationMs, success = true) {
        if (success) {
            this.metrics.jobsCompleted++;
            this.metrics.totalProcessingTime += durationMs;
            this.metrics.averageProcessingTime = Math.round(
                this.metrics.totalProcessingTime / this.metrics.jobsCompleted
            );
        } else {
            this.metrics.jobsFailed++;
        }
    }

    /**
     * Record an error
     * @param {string} type - Error type/category
     */
    recordError(type) {
        if (!this.metrics.errors[type]) {
            this.metrics.errors[type] = 0;
        }
        this.metrics.errors[type]++;
    }

    /**
     * Get current stats
     * @returns {Object} Current performance metrics
     */
    getStats() {
        // ISSUE PM-V2-001 FIX: Guard performance.memory (Chrome-specific, may not exist in all contexts)
        if (typeof performance !== 'undefined' && performance.memory) {
            this.metrics.memoryUsage = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + ' MB';
        }

        return {
            ...this.metrics,
            uptime: Math.round((Date.now() - this.metrics.startTime) / 1000) + 's'
        };
    }

    /**
     * Reset metrics
     */
    reset() {
        this.metrics = {
            startTime: Date.now(),
            jobsCompleted: 0,
            jobsFailed: 0,
            totalProcessingTime: 0,
            averageProcessingTime: 0,
            errors: {},
            memoryUsage: 'N/A'
        };
    }
}
