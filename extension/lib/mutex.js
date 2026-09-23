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
     *
     * MUTEX-01 (2026-06-10): optional `timeoutMs`. Without it, a waiter blocks
     * forever if the current holder crashes without releasing (probe-confirmed
     * deadlock) — that remains the DOCUMENTED primitive semantics (no silent
     * default-timeout: turning a visible deadlock into an invisible
     * correctness bug would be worse). Callers that need an upper bound pass
     * `timeoutMs` and get a MUTEX_TIMEOUT rejection, with the waiter cleanly
     * removed from the queue. Live consumers all use runExclusive (safe:
     * try/finally release).
     *
     * @param {number} [timeoutMs] - optional max wait; rejects on expiry
     * @returns {Promise<Function>} A function that releases the lock when called.
     * @example
     * const release = await mutex.acquire(5000); // throws MUTEX_TIMEOUT after 5s
     * try {
     *     // Critical section
     * } finally {
     *     release();
     * }
     */
    acquire(timeoutMs) {
        return new Promise((resolve, reject) => {
            const release = () => {
                if (this._queue.length > 0) {
                    const next = this._queue.shift();
                    next();
                } else {
                    this._locked = false;
                }
            };

            if (this._locked) {
                let timer = null;
                const waiter = () => {
                    if (timer !== null) clearTimeout(timer);
                    resolve(release);
                };
                if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                    timer = setTimeout(() => {
                        // Single-threaded JS: this removal can't race release()'s
                        // shift — either the waiter is still queued (remove it)
                        // or it was already served (clearTimeout prevented this).
                        const i = this._queue.indexOf(waiter);
                        if (i !== -1) this._queue.splice(i, 1);
                        reject(new Error(`MUTEX_TIMEOUT: acquire() not granted within ${timeoutMs}ms`));
                    }, timeoutMs);
                }
                this._queue.push(waiter);
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
