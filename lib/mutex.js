/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Mutex (Mutual Exclusion)
 * Provides a synchronization primitive for enforcing potential exclusive access
 * to shared resources or critical sections of code.
 */
export class Mutex {
    constructor() {
        this._queue = [];
        this._locked = false;
    }

    /**
     * Acquire the lock.
     * If the lock is already held, the promise resolves when the lock is available.
     * @returns {Promise<Function>} A function that releases the lock when called.
     * @example
     * const release = await mutex.acquire();
     * try {
     *     // Critical section
     * } finally {
     *     release();
     * }
     */
    acquire() {
        return new Promise((resolve) => {
            const release = () => {
                if (this._queue.length > 0) {
                    const next = this._queue.shift();
                    next();
                } else {
                    this._locked = false;
                }
            };

            if (this._locked) {
                this._queue.push(() => resolve(release));
            } else {
                this._locked = true;
                resolve(release);
            }
        });
    }

    /**
     * Run a function exclusively.
     * Automatically acquires and releases the lock.
     * @param {Function} fn - The async function to execute
     * @returns {Promise<any>} The result of the function
     * @example
     * const result = await mutex.runExclusive(async () => {
     *     return await db.save(data);
     * });
     */
    async runExclusive(fn) {
        const release = await this.acquire();
        try {
            return await fn();
        } finally {
            release();
        }
    }

    /**
     * Check if the mutex is currently locked.
     * @returns {boolean} True if locked
     */
    isLocked() {
        return this._locked;
    }

    /**
     * Get the number of waiters in the queue
     * @returns {number} Queue length
     */
    getQueueLength() {
        return this._queue.length;
    }
}
