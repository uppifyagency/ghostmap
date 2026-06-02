/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Database Layer
 * Singleton pattern with proper connection management
 */

import { CONFIG } from './config.js';
import { logger } from './utils.js';
import { getCanonicalDbKey } from './urlNormalizer.js';

/**
 * @typedef {Object} Business
 * @property {string} googleMapsUrl - Primary key: Google Maps URL for the business
 * @property {string} title - Business name/title
 * @property {string} [category] - Business category (e.g., "Restaurant", "Hotel")
 * @property {string} [phone] - Phone number in E.164 format
 * @property {string} [website] - Business website URL
 * @property {string} [email] - Comma-separated list of email addresses
 * @property {number|string} [rating] - Google Maps rating (0-5)
 * @property {number|string} [reviews] - Number of reviews
 * @property {string} [address] - Full business address
 * @property {Object} [social] - Social media links
 * @property {string} [social.facebook] - Facebook page URL
 * @property {string} [social.instagram] - Instagram profile URL
 * @property {string} [social.twitter] - Twitter profile URL
 * @property {string} [social.linkedin] - LinkedIn profile URL
 * @property {boolean} emailScraped - Whether email scraping has been attempted
 * @property {number} timestamp - Unix timestamp when business was first scraped
 * @property {number} [scrapedAt] - Unix timestamp when business data was scraped
 * @property {string} [scrapeError] - Error message if scraping failed
 * @property {string} [partitaIva] - Italian VAT number (P.IVA) - 11 digits
 * @property {string} [codiceFiscale] - Italian Tax Code (C.F.) - 16 alphanumeric
 * @property {string} [openingHours] - Business opening hours from GMB
 */

/**
 * @typedef {Object} DatabaseStats
 * @property {number} total - Total number of businesses
 * @property {number} withEmail - Businesses with at least one email
 * @property {number} withPhone - Businesses with phone numbers
 * @property {number} withWebsite - Businesses with websites
 * @property {number} scraped - Businesses that have been scraped for emails
 * @property {number} pending - Businesses pending email scraping
 * @property {number} emailDiscoveryRate - Percentage of businesses with emails
 * @property {string} avgEmailsPerBusiness - Average emails per business (for those with emails)
 * @property {number} cloudflareBlocks - Count of Cloudflare-blocked businesses
 * @property {number} totalEmailCount - Total unique emails found
 */

// =====================================================
// SECURITY: BATCH SAVE MUTEX
// =====================================================

/**
 * Mutex for batch save operations
 * SECURITY: Prevents concurrent batch writes from corrupting database state
 * Uses queue-based lock acquisition for fairness
 * @class BatchSaveMutex
 */
class BatchSaveMutex {
    constructor() {
        this.locked = false;
        this.queue = [];
        logger.debug('[MUTEX] BatchSaveMutex initialized');
    }

    /**
     * Acquire lock (async, blocks until available or timeout)
     * ═══════════════════════════════════════════════════════════════════════════
     * M3-001 FIX: Added timeout to prevent permanent deadlocks
     * ─────────────────────────────────────────────────────────────────────────────
     * Problem: If a lock holder crashes/hangs without releasing, all waiters
     * would block forever, freezing database operations permanently.
     * 
     * Solution: Add configurable timeout (default 30s). If lock isn't acquired
     * within timeout, reject with error so caller can handle gracefully.
     * ═══════════════════════════════════════════════════════════════════════════
     * @param {number} timeoutMs - Maximum time to wait for lock (default: 30000ms)
     * @returns {Promise<Function>} Release function - MUST be called to unlock
     * @throws {Error} If timeout expires before lock is acquired
     * @example
     * const release = await mutex.acquire(5000); // 5s timeout
     * try {
     *   // ... critical section ...
     * } finally {
     *   release();
     * }
     */
    // B8-5 fix: default raised 30s → 60s. Burst-concurrent batchSave on
    // slow hardware (HDD, high Chrome IO contention) could hit 30s false
    // timeouts even on healthy serialization (e.g., 50 batches × 1.5s avg
    // = 75s). 60s gives more headroom; callers can still pass a tighter
    // timeout via options.mutexTimeoutMs.
    async acquire(timeoutMs = 60000) {
        const startTime = Date.now();

        while (this.locked) {
            // M3-001 FIX: Check timeout before waiting
            const elapsed = Date.now() - startTime;
            if (elapsed >= timeoutMs) {
                const error = new Error(`MUTEX_TIMEOUT: Lock not acquired within ${timeoutMs}ms (waited ${elapsed}ms)`);
                logger.error('[MUTEX]', error.message);
                throw error;
            }

            // Wait in queue with timeout protection
            await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    // Remove self from queue if timeout fires
                    const idx = this.queue.indexOf(resolve);
                    if (idx > -1) this.queue.splice(idx, 1);
                    reject(new Error(`MUTEX_TIMEOUT: Lock not acquired within ${timeoutMs}ms`));
                }, timeoutMs - elapsed);

                // Store resolve with timeout cleanup
                const wrappedResolve = () => {
                    clearTimeout(timeoutId);
                    resolve();
                };
                this.queue.push(wrappedResolve);
            });
        }

        this.locked = true;
        logger.debug('[MUTEX] Lock acquired');

        // Return release function
        return () => this.release();
    }

    /**
     * Release lock and wake next waiter
     * @private
     */
    release() {
        this.locked = false;

        // Wake next waiter if any
        const nextWaiter = this.queue.shift();
        if (nextWaiter) {
            logger.debug(`[MUTEX] Lock released, ${this.queue.length} waiting`);
            nextWaiter();
        } else {
            logger.debug('[MUTEX] Lock released, queue empty');
        }
    }
}

/**
 * @typedef {Object} Migration
 * @property {string} name - Human-readable migration name
 * @property {function(IDBDatabase, IDBTransaction=): void} up - Migration function to apply schema changes
 */

/**
 * @typedef {Object} BatchSaveResult
 * @property {number} success - Number of successfully saved businesses
 * @property {Array<{index: number, error: Error}>} errors - Array of errors with their indices
 */

/**
 * Database Migration Registry
 * PHASE 4 FIX #42: Structured migration system
 * 
 * =========================================================================
 * BLOCK-L5 DOC: Migration Pattern
 * =========================================================================
 * Each migration has:
 * - up(db, transaction): Applies schema changes (required)
 * - down(): NOT IMPLEMENTED for IndexedDB (see reasons below)
 * 
 * WHY NO down() METHODS:
 * 1. IndexedDB onupgradeneeded only fires on version INCREASE
 * 2. Browsers don't support downgrade paths natively
 * 3. To rollback: increment version and write reverse logic in new up()
 * 
 * ROLLBACK PATTERN (if needed):
 * ```
 * 3: {
 *   name: 'Rollback emailScrapingIndex',
 *   up: (db, transaction) => {
 *     const store = transaction.objectStore('businesses');
 *     if (store.indexNames.contains('emailScrapingIndex')) {
 *       store.deleteIndex('emailScrapingIndex');
 *     }
 *   }
 * }
 * ```
 * =========================================================================
 * 
 * @type {Object<number, Migration>}
 */
const MIGRATIONS = {
    1: {
        name: 'Initial schema',
        up: (db) => {
            // Create businesses store
            if (!db.objectStoreNames.contains(CONFIG.db.stores.businesses)) {
                const businessStore = db.createObjectStore(CONFIG.db.stores.businesses, {
                    keyPath: 'googleMapsUrl'
                });

                // Original indexes
                businessStore.createIndex('email', 'email', { unique: false });
                businessStore.createIndex('emailScraped', 'emailScraped', { unique: false });
                businessStore.createIndex('timestamp', 'timestamp', { unique: false });
                businessStore.createIndex('title', 'title', { unique: false });

                logger.info('Created businesses store with 4 indexes');
            }

            // Create jobs store
            if (!db.objectStoreNames.contains(CONFIG.db.stores.jobs)) {
                db.createObjectStore(CONFIG.db.stores.jobs, {
                    keyPath: 'id',
                    autoIncrement: true
                });
                logger.info('Created jobs store');
            }

            // Create settings store
            if (!db.objectStoreNames.contains(CONFIG.db.stores.settings)) {
                db.createObjectStore(CONFIG.db.stores.settings, {
                    keyPath: 'key'
                });
                logger.info('Created settings store');
            }
        }
    },
    2: {
        name: 'Performance indexes',
        up: (db, transaction) => {
            const businessStore = transaction.objectStore(CONFIG.db.stores.businesses);

            // Add category index for business type filtering
            if (!businessStore.indexNames.contains('category')) {
                businessStore.createIndex('category', 'category', { unique: false });
                logger.info('✅ Added category index');
            }

            // Add scrapedAt index for date range queries
            if (!businessStore.indexNames.contains('scrapedAt')) {
                businessStore.createIndex('scrapedAt', 'scrapedAt', { unique: false });
                logger.info('✅ Added scrapedAt index');
            }

            // Add compound index for email scraping query optimization
            if (!businessStore.indexNames.contains('emailScrapingIndex')) {
                businessStore.createIndex(
                    'emailScrapingIndex',
                    ['emailScraped', 'website'],
                    { unique: false }
                );
                logger.info('✅ Added compound emailScrapingIndex [emailScraped, website]');
            }
        }
    },
    3: {
        // B8-3 FIX: getBusinessesWithoutWebsite() previously did O(N) cursor
        // full-scan ("compound index with optional `website` field is
        // unreliable" per the prior comment). On 10K+ DBs this added
        // 0.5–2 s lock per call. Adding a derived `hasWebsite` boolean
        // field + single-field index lets the query become an
        // index.getAll(IDBKeyRange.only(false)) — O(log N).
        name: 'Add hasWebsite computed index + backfill',
        up: (db, transaction) => {
            const businessStore = transaction.objectStore(CONFIG.db.stores.businesses);

            if (!businessStore.indexNames.contains('hasWebsite')) {
                businessStore.createIndex('hasWebsite', 'hasWebsite', { unique: false });
                logger.info('✅ Added hasWebsite index');
            }

            // Backfill: iterate existing records and stamp the derived
            // boolean. The cursor walk runs INSIDE the upgrade transaction
            // so it commits atomically with the index creation. For very
            // large DBs this takes O(N) at the cost of update latency,
            // but it's a one-shot cost paid only on schema upgrade.
            let backfilled = 0;
            const cursorReq = businessStore.openCursor();
            cursorReq.onsuccess = (e) => {
                const c = e.target.result;
                if (!c) {
                    if (backfilled > 0) {
                        logger.info(`✅ Backfilled hasWebsite on ${backfilled} existing records`);
                    }
                    return;
                }
                const b = c.value;
                const hasWebsite = !!(b.website && typeof b.website === 'string'
                    && b.website.trim().length > 0);
                if (b.hasWebsite !== hasWebsite) {
                    c.update({ ...b, hasWebsite });
                    backfilled++;
                }
                c.continue();
            };
            cursorReq.onerror = () => {
                logger.warn('[DB] hasWebsite backfill cursor error:', cursorReq.error);
            };
        }
    }
};

/**
 * Helper: derive the hasWebsite boolean from a business object.
 * Used by saveBusiness / batchSave so the new index always sees a
 * consistent field. Empty strings, whitespace, and missing values all
 * map to false.
 * @private
 */
function _deriveHasWebsite(business) {
    return !!(business
        && typeof business.website === 'string'
        && business.website.trim().length > 0);
}

/**
 * SAVE-DLQ (2026-05-28): transient-error taxonomy for the saveBusiness retry.
 * CONSERVATIVE — only confirmed-retriable IndexedDB error names retry; any
 * unknown name is treated as NON-transient (returns false ⇒ caller breaks the
 * retry loop ⇒ record routed straight to the dead-letter with ZERO wasted
 * attempts). QuotaExceededError NEVER retries (a full store won't clear on a
 * 200ms backoff — it is routed to the dead-letter / storage-full UI path by
 * handleBusinessBatch). Ref: MDN IDBRequest error / DOMException names.
 * @private
 */
const MAX_SAVE_ATTEMPTS = 3;
const TRANSIENT_DB_ERRORS = new Set([
    'TransactionInactiveError', 'AbortError', 'UnknownError', 'InvalidStateError'
]);
function _isTransientDbError(err) {
    if (!err) return false;
    if (err.name === 'QuotaExceededError') return false; // NEVER retry quota
    return TRANSIENT_DB_ERRORS.has(err.name) ||
           /connection.*clos|database.*clos/i.test(err.message || '');
}

/**
 * Database Manager
 * Singleton class handling IndexedDB operations with proper connection management
 */
class Database {
    constructor() {
        this.db = null;
        this.dbName = CONFIG.db.name;
        this.initPromise = null;

        // SECURITY: Mutex for concurrent batch save protection
        this.batchSaveMutex = new BatchSaveMutex();
        logger.debug('[DB] Database instance created with mutex protection');
    }

    /**
     * Initialize database connection
     * Thread-safe singleton pattern with proper promise caching
     * Generates and persists unique database ID for production environments
     * @returns {Promise<IDBDatabase>} IndexedDB database instance
     * @throws {Error} If database initialization fails
     * @example
     * const db = await dbInstance.init();
     * console.log('Database ready:', db.name);
     */
    async init() {
        // Fast path: already initialized
        if (this.db) {
            return this.db;
        }

        // Concurrent callers get the same promise (CRITICAL FIX: don't use isInitializing flag)
        if (this.initPromise) {
            return this.initPromise;
        }

        // Create initialization promise (only once)
        this.initPromise = (async () => {
            try {
                const stored = await chrome.storage.local.get('dbId');
                let dbId = stored.dbId;


                if (!dbId) {
                    dbId = this._generateRandomId();
                    await chrome.storage.local.set({ dbId });
                    logger.info('Generated new persistent DB ID:', dbId);
                }

                // ═════════════════════════════════════════════════════════════
                // SL-003 FIX: Consistent DB naming across environments
                // Always use AppDataStore_ prefix with persistent ID
                // Development mode tracked separately via isDevelopment flag
                // ═════════════════════════════════════════════════════════════
                this.dbName = 'AppDataStore_' + dbId;
                this.isDevelopment = !CONFIG.isProduction;

                if (this.isDevelopment) {
                    logger.warn(`[DB] 🛠️ Development mode enabled - DB: ${this.dbName}`);
                }


                const db = await this._openDatabase();

                if (!db) {
                    throw new Error('Database initialization returned null');
                }

                logger.info('Database initialized:', this.dbName);
                return db;
            } catch (error) {
                // Clear promise ONLY on error so retry is possible
                this.initPromise = null;
                this.db = null;
                logger.error('Database initialization failed:', error);

                // B8-2 fix: surface migration failures to UI. The migration
                // path inside _openDatabase() throws on failure, which the
                // transaction auto-aborts; the user otherwise sees only a
                // dead extension with no diagnostic. Persist the failure
                // signature in chrome.storage.session so the sidepanel can
                // pick it up at startup, AND broadcast a one-shot message
                // for any listener that's already alive.
                try {
                    const msg = error instanceof Error ? error.message : String(error);
                    const isMigrationFailure = msg.includes('Migration')
                        || msg.includes('migration')
                        || msg.includes('upgrade');
                    if (isMigrationFailure && typeof chrome !== 'undefined'
                        && chrome?.storage?.session?.set) {
                        await chrome.storage.session.set({
                            db_migration_failure: { message: msg, at: Date.now() }
                        });
                        if (chrome?.runtime?.sendMessage) {
                            chrome.runtime.sendMessage({
                                action: 'db_migration_failure',
                                payload: { message: msg }
                            }).catch(() => {});
                        }
                    }
                } catch (surfaceErr) {
                    // Best-effort surfacing; don't mask the original error
                    logger.warn('[DB] Failed to surface migration failure:', surfaceErr);
                }

                throw error;
            }
        })();

        this.db = await this.initPromise;
        return this.db;
    }

    _generateRandomId() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let id = '';
        for (let i = 0; i < 8; i++) {
            id += chars[Math.floor(Math.random() * chars.length)];
        }
        return id;
    }

    /**
     * Normalize a Google Maps URL into the IndexedDB primary key.
     *
     * v9.10 (2026-05-07): now delegates to `urlNormalizer.getCanonicalDbKey`
     * — the single source of truth. Previously this method handled only
     * step 2 of a 2-step pipeline (the urlNormalizer step ran upstream),
     * which caused the v9.8.1 silent enrichment loss (see commit eb60ab4).
     * Kept as a method so internal callers (`saveBusiness`, `batchSave`)
     * continue to work without churn.
     *
     * @private
     * @param {string} url - Raw Google Maps URL
     * @returns {string} Canonical DB key
     */
    _normalizeGoogleMapsUrl(url) {
        return getCanonicalDbKey(url);
    }

    /**
     * Open IndexedDB connection
     * Handles database upgrades and runs migrations sequentially
     * @private
     * @returns {Promise<IDBDatabase>} Opened database instance
     * @throws {Error} If database cannot be opened or migration fails
     */
    _openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, CONFIG.db.version);

            request.onerror = () => {
                reject(new Error('Failed to open database: ' + request.error));
            };

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const oldVersion = event.oldVersion;
                const newVersion = event.newVersion;
                const transaction = event.target.transaction;

                logger.info(`Upgrading database from v${oldVersion} to v${newVersion}...`);

                // PHASE 4 FIX #42: Run migrations sequentially
                for (let v = oldVersion + 1; v <= newVersion; v++) {
                    if (MIGRATIONS[v]) {
                        logger.info(`Running migration v${v}: ${MIGRATIONS[v].name}`);
                        try {
                            MIGRATIONS[v].up(db, transaction);
                            logger.info(`Migration v${v} complete`);
                        } catch (error) {
                            logger.error(`Migration v${v} failed:`, error);
                            // Transaction will auto-abort on error
                            throw error;
                        }
                    }
                }

                logger.info('Database migration complete');
            };
        });
    }

    /**
     * Execute transaction with proper error handling
     * Helper method to wrap IndexedDB transactions in Promises
     * 
     * ⚠️ BLOCK-L3 DOC: When to use _transaction vs manual transactions:
     * - USE _transaction(): For simple get/put/delete/clear operations
     * - USE MANUAL: For cursor-based iteration (getBusinessesForEmailScraping,
     *   getBusinessesWithoutWebsite, getFailedBusinesses, getAllBusinesses with pagination)
     *   These need cursor.continue() flow which doesn't fit the single-request pattern.
     * 
     * @private
     * @param {string} storeName - Name of object store to access
     * @param {('readonly'|'readwrite')} mode - Transaction mode
     * @param {function(IDBObjectStore): IDBRequest} operation - Function executing the store operation
     * @returns {Promise<any>} Result of the operation
     * @throws {Error} If transaction or operation fails
     */
    async _transaction(storeName, mode, operation) {
        const db = await this.init();

        // Add null check to prevent "Cannot read properties of null" error
        if (!db) {
            throw new Error('[DB ERROR] Database not initialized - db instance is null');
        }

        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction(storeName, mode);
                const store = transaction.objectStore(storeName);

                const request = operation(store);

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);

                transaction.onerror = () => reject(transaction.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Save a single business (upsert)
     * @param {Business} business - Business object to save
     * @returns {Promise<string>} Google Maps URL of saved business
     * @throws {Error} If save fails or database is not initialized
     * @example
     * await dbInstance.saveBusiness({
     *   googleMapsUrl: 'https://maps.google.com/...',
     *   title: 'Acme Corp',
     *   category: 'Technology',
     *   phone: '+1234567890',
     *   website: 'https://acme.com'
     * });
     */
    async saveBusiness(business, { retry = true } = {}) {
        // Validate primary key
        if (!business.googleMapsUrl) {
            const error = new Error('[DB SAVE FAILURE] Business must have googleMapsUrl');
            logger.error(error.message, business);
            throw error;
        }

        // STRANGE-BEHAVIOR-FIX-003: Normalize URL to prevent duplicates
        // Same business may be saved with http:// or https:// - normalize to https://
        business.googleMapsUrl = this._normalizeGoogleMapsUrl(business.googleMapsUrl);

        // Set defaults
        if (!business.timestamp) {
            business.timestamp = Date.now();
        }
        if (!business.emailScraped) {
            business.emailScraped = false;
        }
        // B8-3 FIX: derive hasWebsite for the index. Always overwrite —
        // a save with an empty website string must clear the boolean.
        business.hasWebsite = _deriveHasWebsite(business);

        logger.debug(`[DB SAVE] Saving business: ${business.title || business.googleMapsUrl}`);

        // SAVE-DLQ (2026-05-28): retry TRANSIENT put failures (SW evicted /
        // transaction aborted / connection closed) with short backoff. Validation
        // + normalization above run ONCE; only the put is retried. Quota and any
        // unknown error name fast-fail (see _isTransientDbError) so the caller can
        // route the record to the dead-letter / storage-full UI path. store.put is
        // an idempotent upsert, so a retry after a partially-applied write is safe.
        // retry:false (used by the dead-letter drain) does ONE attempt with no
        // backoff — bulk recovery must not spend the per-record backoff budget.
        const maxAttempts = retry ? MAX_SAVE_ATTEMPTS : 1;
        let lastErr;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await this._saveBusinessOnce(business);
            } catch (err) {
                lastErr = err;
                if (!_isTransientDbError(err) || attempt === maxAttempts) break;
                const backoffMs = 50 * (2 ** (attempt - 1)); // 50, 100, 200ms
                logger.warn(`[DB RETRY] attempt ${attempt}/${MAX_SAVE_ATTEMPTS} for ${business.googleMapsUrl}: ${err?.name}; retry in ${backoffMs}ms`);
                await new Promise(r => setTimeout(r, backoffMs));
            }
        }
        throw lastErr; // exhausted or non-transient → propagate for dead-letter capture
    }

    /**
     * Single save attempt (no retry). Extracted from saveBusiness so the retry
     * wrapper can re-invoke just the put without re-running validation. Assumes
     * `business` is already validated + normalized.
     * @private
     */
    async _saveBusinessOnce(business) {
        // SECURITY FIX: Await init() BEFORE Promise constructor to prevent race condition
        const db = await this.init();

        if (!db) {
            throw new Error('[DB ERROR] Database not initialized - db instance is null');
        }

        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction(CONFIG.db.stores.businesses, 'readwrite');
                const store = transaction.objectStore(CONFIG.db.stores.businesses);
                const request = store.put(business);

                request.onsuccess = () => {
                    logger.debug(`[DB SAVE SUCCESS] ${business.googleMapsUrl}`);
                };

                request.onerror = () => {
                    if (request.error && request.error.name === 'QuotaExceededError') {
                        // SAVE-DLQ (2026-05-28): the UI signal IS now wired — this
                        // rejection propagates to handleBusinessBatch, which counts
                        // quotaFailures and surfaces a "storage full" alert in the
                        // area-search completion dialog (re-verified via
                        // navigator.storage.estimate). No broadcast needed here.
                        logger.error('[DB QUOTA EXCEEDED] Storage full! Please clear data or export.');
                    }
                    logger.error(`[DB SAVE FAILURE] ${business.googleMapsUrl}:`, request.error);
                    reject(request.error);
                };

                // AUDIT FIX #3: Wait for transaction to complete before resolving
                transaction.oncomplete = () => {
                    logger.debug(`[DB TRANSACTION COMPLETE] ${business.googleMapsUrl} persisted`);
                    resolve(business.googleMapsUrl);
                };

                transaction.onerror = () => {
                    if (transaction.error && transaction.error.name === 'QuotaExceededError') {
                        logger.error('[DB QUOTA EXCEEDED] Storage full! Please clear data or export.');
                        logger.error('QUOTA_EXCEEDED');
                    }
                    logger.error(`[DB TRANSACTION FAILURE]`, transaction.error);
                    reject(transaction.error);
                };
            } catch (error) {
                logger.error('[DB SAVE FAILURE] Exception:', error);
                reject(error);
            }
        });
    }

    /**
     * Get a business by URL
     * @param {string} url - Google Maps URL (primary key)
     * @returns {Promise<Business|undefined>} Business object if found, undefined otherwise
     * @example
     * const business = await dbInstance.getBusiness('https://maps.google.com/...');
     * if (business) {
     *   console.log('Found:', business.title);
     * }
     */
    async getBusiness(url) {
        return this._transaction(CONFIG.db.stores.businesses, 'readonly', (store) => {
            return store.get(url);
        });
    }

    /**
     * Get all businesses with optional pagination
     * BLOCK-4 FIX (CRIT-007): Added pagination to prevent memory exhaustion
     * WARNING: Calling without limit on large datasets can freeze UI
     * @param {Object} [options] - Pagination options
     * @param {number} [options.limit] - Max businesses to return (default: all)
     * @param {number} [options.offset=0] - Number of records to skip
     * @returns {Promise<Business[]>} Array of business objects
     * @example
     * // Get first 100 businesses
     * const batch1 = await dbInstance.getAllBusinesses({ limit: 100, offset: 0 });
     * // Get next 100
     * const batch2 = await dbInstance.getAllBusinesses({ limit: 100, offset: 100 });
     */
    async getAllBusinesses(options = {}) {
        const { limit, offset = 0 } = options;

        // Fast path: no pagination (backward compatible)
        if (!limit && offset === 0) {
            return this._transaction(CONFIG.db.stores.businesses, 'readonly', (store) => {
                return store.getAll();
            });
        }

        // Paginated path: use cursor for memory efficiency
        const db = await this.init();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(CONFIG.db.stores.businesses, 'readonly');
            const store = transaction.objectStore(CONFIG.db.stores.businesses);
            const request = store.openCursor();

            const results = [];
            let skipped = 0;

            request.onsuccess = (event) => {
                const cursor = event.target.result;

                if (cursor) {
                    // Skip offset
                    if (skipped < offset) {
                        skipped++;
                        cursor.continue();
                        return;
                    }

                    // Collect until limit
                    results.push(cursor.value);

                    if (limit && results.length >= limit) {
                        resolve(results);
                        return;
                    }

                    cursor.continue();
                } else {
                    resolve(results);
                }
            };

            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    /**
     * BLOCK-4 FIX (CRIT-007): Async generator for streaming large datasets
     * Yields businesses in batches without loading all into memory
     * @param {number} [batchSize=1000] - Number of businesses per batch
     * @yields {Business[]} Batches of business objects
     * @example
     * for await (const batch of dbInstance.getAllBusinessesPaginated(500)) {
     *   console.log(`Processing ${batch.length} businesses...`);
     *   await processBusinesses(batch);
     * }
     */
    async *getAllBusinessesPaginated(batchSize = 1000) {
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const batch = await this.getAllBusinesses({ limit: batchSize, offset });
            if (batch.length > 0) {
                yield batch;
                offset += batch.length;
            }
            hasMore = batch.length === batchSize;
        }
    }

    /**
     * Get businesses for email scraping (have website, not yet scraped)
     * PHASE 3 FIX #22: Indexes added for future optimization
     * Note: Compound index with optional fields requires cursor scan for reliability
     */
    async getBusinessesForEmailScraping(limit = null) {
        const db = await this.init();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(CONFIG.db.stores.businesses, 'readonly');
            const store = transaction.objectStore(CONFIG.db.stores.businesses);

            // Use cursor scan (compound index with optional 'website' field is unreliable)
            // Future: Can optimize with single-field index when all records have website
            const request = store.openCursor();

            const results = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;

                if (cursor) {
                    const business = cursor.value;

                    // Filter: has website AND not yet scraped (or emailScraped is undefined/false)
                    if (business.website &&
                        business.website.trim() !== '' &&
                        !business.emailScraped) {
                        results.push(business);

                        // If limit reached, resolve early
                        if (limit && results.length >= limit) {
                            resolve(results);
                            return;
                        }
                    }

                    cursor.continue();
                } else {
                    // No more entries
                    resolve(results);
                }
            };

            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    /**
     * Get businesses that have GMB URL but NO website
     * Used by website extraction feature to find missing websites
     * @param {number} [limit] - Optional limit
     * @returns {Promise<Array>} Businesses without website
     */
    async getBusinessesWithoutWebsite(limit = null) {
        const db = await this.init();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(CONFIG.db.stores.businesses, 'readonly');
            const store = transaction.objectStore(CONFIG.db.stores.businesses);

            // B8-3 FIX: use the v3 hasWebsite index instead of full cursor
            // scan. On 10K+ DBs the cursor scan was 0.5–2 s; the index
            // lookup is O(log N) ≈ 5-50 ms.
            //
            // Fallback: if the index isn't available (DB still on v1/v2
            // before the user reloads the extension), gracefully fall back
            // to the cursor scan so the call doesn't throw.
            let useIndex = false;
            try {
                useIndex = store.indexNames.contains('hasWebsite');
            } catch (_) { /* defensive */ }

            if (useIndex) {
                const idx = store.index('hasWebsite');
                const range = IDBKeyRange.only(false);
                // limit is a separate concept than cursor.continue(); use
                // openCursor on the index so we can early-exit with limit.
                const idxReq = idx.openCursor(range);
                const results = [];
                idxReq.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        const business = cursor.value;
                        if (business.googleMapsUrl) {
                            results.push(business);
                            if (limit && results.length >= limit) {
                                resolve(results);
                                return;
                            }
                        }
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                };
                idxReq.onerror = () => reject(idxReq.error);
                transaction.onerror = () => reject(transaction.error);
                return;
            }

            // Fallback: original cursor full-scan (kept verbatim for v1/v2
            // databases that haven't yet completed migration v3).
            const request = store.openCursor();
            const results = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;

                if (cursor) {
                    const business = cursor.value;

                    // Filter: has GMB URL but NO website
                    if (business.googleMapsUrl &&
                        (!business.website || business.website.trim() === '')) {
                        results.push(business);

                        if (limit && results.length >= limit) {
                            resolve(results);
                            return;
                        }
                    }

                    cursor.continue();
                } else {
                    resolve(results);
                }
            };

            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    /**
     * Get businesses that failed email scraping (timeout, Cloudflare, errors)
     * FIX: These businesses have emailScraped=true but scrapeError set or no email found
     * @param {number} [limit] - Optional limit
     * @returns {Promise<Array>} Failed businesses that can be retried
     */
    async getFailedBusinesses(limit = null) {
        const db = await this.init();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(CONFIG.db.stores.businesses, 'readonly');
            const store = transaction.objectStore(CONFIG.db.stores.businesses);

            const request = store.openCursor();
            const results = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;

                if (cursor) {
                    const business = cursor.value;

                    // Filter: has website AND (has scrapeError OR emailScraped but no email)
                    const hasWebsite = business.website && business.website.trim() !== '';
                    const hasScrapeError = business.scrapeError;
                    const scrapedButNoEmail = business.emailScraped && !business.email;

                    if (hasWebsite && (hasScrapeError || scrapedButNoEmail)) {
                        results.push(business);

                        if (limit && results.length >= limit) {
                            resolve(results);
                            return;
                        }
                    }

                    cursor.continue();
                } else {
                    resolve(results);
                }
            };

            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    /**
     * B10-3 FIX (2026-05-10): server-side filter for "old businesses with
     * email" — returns ONLY the URL identifiers, not the full business
     * records. Pre-fix the storage modal called get_all_businesses then
     * filtered client-side; on a 10K+ business DB the IPC payload was
     * 8MB+ which Chrome MV3 can silently truncate at ~10MB.
     *
     * Cursor-based scan keeps memory bounded — only IDs accumulate, not
     * full records. Caller batches the IDs into delete_business_batch.
     *
     * @param {number} cutoffMs - Unix timestamp; entries with timestamp/
     *                            scrapedAt strictly LESS than this are old.
     * @returns {Promise<string[]>} Array of googleMapsUrl identifiers.
     */
    async getOldEmailedBusinessIds(cutoffMs) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(CONFIG.db.stores.businesses, 'readonly');
            const store = transaction.objectStore(CONFIG.db.stores.businesses);
            const request = store.openCursor();
            const ids = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const b = cursor.value;
                    const ts = b.scrapedAt || b.timestamp || 0;
                    if (ts < cutoffMs && b.email && b.googleMapsUrl) {
                        ids.push(b.googleMapsUrl);
                    }
                    cursor.continue();
                } else {
                    resolve(ids);
                }
            };
            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    /**
     * B10-3 FIX (2026-05-10): server-side filter for "old businesses (any)".
     * Same rationale as getOldEmailedBusinessIds: cursor-based scan,
     * IDs only, bounded memory + IPC payload.
     *
     * @param {number} cutoffMs - Unix timestamp; entries with timestamp/
     *                            createdAt strictly LESS than this are old.
     * @returns {Promise<string[]>}
     */
    async getOldBusinessIds(cutoffMs) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(CONFIG.db.stores.businesses, 'readonly');
            const store = transaction.objectStore(CONFIG.db.stores.businesses);
            const request = store.openCursor();
            const ids = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const b = cursor.value;
                    const ts = b.timestamp || b.createdAt || 0;
                    if (ts < cutoffMs && b.googleMapsUrl) {
                        ids.push(b.googleMapsUrl);
                    }
                    cursor.continue();
                } else {
                    resolve(ids);
                }
            };
            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    /**
     * Reset failed businesses for retry
     * FIX: Clears emailScraped flag and scrapeError so businesses can be rescraped
     * @returns {Promise<number>} Number of businesses reset
     */
    async resetFailedForRetry() {
        const failedBusinesses = await this.getFailedBusinesses();
        let resetCount = 0;

        for (const business of failedBusinesses) {
            try {
                await this.updateBusiness(business.googleMapsUrl, {
                    emailScraped: false,
                    scrapeError: null,
                    scrapedFrom: null,
                    scrapedAt: null
                });
                resetCount++;
            } catch (error) {
                logger.warn(`[DB] Failed to reset business: ${business.title}`, error);
            }
        }

        logger.info(`[DB] Reset ${resetCount} failed businesses for retry`);
        return resetCount;
    }

    /**
     * Update existing business data
     * @param {string} url - Google Maps URL
     * @param {object} updates - Fields to update
     * @returns {Promise<void>}
     */
    async updateBusiness(url, updates) {
        logger.debug(`[DB] updateBusiness called with URL: ${url}`);

        const business = await this.getBusiness(url);

        if (!business) {
            const error = new Error('[DB UPDATE FAILURE] Business not found: ' + url);
            logger.error(error.message);
            throw error;
        }

        logger.debug(`[DB] Found existing business, applying updates:`, Object.keys(updates));
        const updatedBusiness = { ...business, ...updates };

        return this.saveBusiness(updatedBusiness);
    }

    /**
     * Delete business
     */
    async deleteBusiness(googleMapsUrl) {
        return this._transaction(CONFIG.db.stores.businesses, 'readwrite', (store) => {
            return store.delete(googleMapsUrl);
        });
    }

    /**
     * Clear all data from a store
     * @param {string} storeName - Name of store to clear
     * @returns {Promise<void>}
     */
    async clear(storeName = CONFIG.db.stores.businesses) {
        return this._transaction(storeName, 'readwrite', (store) => {
            return store.clear();
        });
    }

    /**
     * Get database statistics
     * ENHANCED: Complete analytics including success rates, timing, failures, and storage
     * @returns {Promise<DatabaseStats>} Comprehensive statistics object
     * @example
     * const stats = await dbInstance.getStats();
     * console.log(`Success rate: ${stats.successRatePercent}%`);
     * console.log(`Avg time: ${stats.avgScrapingTimeSeconds}s`);
     * console.log(`Storage: ${stats.storageSizeMB} MB`);
     */
    async getStats() {
        const db = await this.init();

        // FIX: Add null check to prevent race condition with parallel scraping
        if (!db) {
            logger.warn('[DB] Database not ready yet, returning empty stats');
            return {
                total: 0,
                withEmail: 0,
                withPhone: 0,
                withWebsite: 0,
                scraped: 0,
                pending: 0,
                failed: 0,
                succeeded: 0,
                emailDiscoveryRate: 0,
                successRatePercent: 0,
                avgEmailsPerBusiness: '0.0',
                avgScrapingTimeSeconds: 0,
                cloudflareBlocks: 0,
                totalEmailCount: 0,
                storageSizeMB: 0,
                storageQuotaMB: 0,
                storageUsedPercent: 0
            };
        }

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(CONFIG.db.stores.businesses, 'readonly');
            const store = transaction.objectStore(CONFIG.db.stores.businesses);

            const stats = {
                total: 0,
                withEmail: 0,
                withPhone: 0,
                withWebsite: 0,
                scraped: 0,
                pending: 0,
                failed: 0,
                succeeded: 0,
                emailDiscoveryRate: 0,
                successRatePercent: 0,
                avgEmailsPerBusiness: '0.0',
                avgScrapingTimeSeconds: 0,
                cloudflareBlocks: 0,
                totalEmailCount: 0,
                storageSizeMB: 0,
                storageQuotaMB: 0,
                storageUsedPercent: 0
            };

            // Timing accumulator
            let totalScrapingTimeMs = 0;
            let scrapedWithTimeCount = 0;

            // 1. Get total count (Fast)
            const countRequest = store.count();

            countRequest.onsuccess = () => {
                stats.total = countRequest.result;

                // 2. Use cursor to scan properties without loading all objects into memory
                // This is still O(n) time but O(1) memory, unlike getAll() which is O(n) memory
                const cursorRequest = store.openCursor();

                let emailBusinessCount = 0;

                cursorRequest.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        const b = cursor.value;

                        // Email stats
                        if (b.email && b.email.trim() !== '') {
                            stats.withEmail++;
                            emailBusinessCount++;
                            stats.totalEmailCount += b.email.split(',').filter(e => e.trim()).length;
                        }

                        // Basic counts
                        if (b.phone && b.phone.trim() !== '') stats.withPhone++;
                        if (b.website && b.website.trim() !== '') stats.withWebsite++;
                        if (b.emailScraped) stats.scraped++;
                        if (!b.emailScraped && b.website) stats.pending++;

                        // Success/Failure tracking
                        if (b.emailScraped && b.email) {
                            stats.succeeded++; // Successfully scraped AND found email
                        } else if (b.emailScraped && !b.email) {
                            stats.failed++; // Scraped but no email found
                        } else if (b.scrapeError) {
                            stats.failed++; // Error during scraping
                        }

                        // Timing metrics (if available)
                        if (b.scrapingDurationMs && b.scrapingDurationMs > 0) {
                            totalScrapingTimeMs += b.scrapingDurationMs;
                            scrapedWithTimeCount++;
                        }

                        // Cloudflare blocks
                        if (b.scrapeError === 'cloudflare_protected' ||
                            (b.scrapeError && b.scrapeError.includes('Cloudflare'))) {
                            stats.cloudflareBlocks++;
                        }

                        cursor.continue();
                    } else {
                        // Finished scanning - calculate derived stats
                        stats.emailDiscoveryRate = stats.total > 0
                            ? Math.round((stats.withEmail / stats.total) * 100)
                            : 0;

                        stats.avgEmailsPerBusiness = emailBusinessCount > 0
                            ? (stats.totalEmailCount / emailBusinessCount).toFixed(1)
                            : '0.0';

                        // Success rate: succeeded / (succeeded + failed)
                        const totalAttempts = stats.succeeded + stats.failed;
                        stats.successRatePercent = totalAttempts > 0
                            ? Math.round((stats.succeeded / totalAttempts) * 100)
                            : 0;

                        // Average scraping time
                        stats.avgScrapingTimeSeconds = scrapedWithTimeCount > 0
                            ? Math.round((totalScrapingTimeMs / scrapedWithTimeCount) / 1000)
                            : 0;

                        // Get storage quota (async)
                        this._getStorageInfo().then(storageInfo => {
                            stats.storageSizeMB = storageInfo.usedMB;
                            stats.storageQuotaMB = storageInfo.quotaMB;
                            stats.storageUsedPercent = storageInfo.usedPercent;
                            resolve(stats);
                        }).catch(err => {
                            logger.warn('[DB] Could not get storage info:', err);
                            resolve(stats); // Return without storage info
                        });
                    }
                };

                cursorRequest.onerror = () => reject(cursorRequest.error);
            };

            countRequest.onerror = () => reject(countRequest.error);
        });
    }

    /**
     * Get storage usage information
     * @private
     * @returns {Promise<{usedMB: number, quotaMB: number, usedPercent: number}>}
     */
    async _getStorageInfo() {
        if (!navigator.storage || !navigator.storage.estimate) {
            return { usedMB: 0, quotaMB: 0, usedPercent: 0 };
        }

        try {
            const estimate = await navigator.storage.estimate();
            const usedMB = estimate.usage ? (estimate.usage / (1024 * 1024)).toFixed(2) : 0;
            const quotaMB = estimate.quota ? (estimate.quota / (1024 * 1024)).toFixed(2) : 0;
            const usedPercent = estimate.quota
                ? Math.round((estimate.usage / estimate.quota) * 100)
                : 0;

            return {
                usedMB: parseFloat(usedMB),
                quotaMB: parseFloat(quotaMB),
                usedPercent
            };
        } catch (error) {
            logger.error('[DB] Storage estimate error:', error);
            return { usedMB: 0, quotaMB: 0, usedPercent: 0 };
        }
    }

    /**
     * Batch save businesses with guaranteed durability and concurrency protection
     * SECURITY: Uses mutex to prevent concurrent batch writes from corrupting database
     * Uses single transaction to save multiple businesses efficiently
     * Waits for transaction completion before resolving (CRITICAL FIX)
     * @param {Business[]} businesses - Array of business objects to save
     * @returns {Promise<{success: number, errors: Array}>} Result object with success count and errors array
     * @example
     * const result = await dbInstance.batchSave([business1, business2, business3]);
     * console.log(`Saved ${result.success} businesses`);
     * if (result.errors.length > 0) {
     *   console.error('Errors:', result.errors);
     * }
     */
    async batchSave(businesses, options = {}) {
        if (!businesses || businesses.length === 0) {
            return { success: 0, errors: [] };
        }

        // SECURITY: Acquire mutex to prevent concurrent batch writes.
        // B8-5: callers can pass { mutexTimeoutMs: <ms> } to override the
        // 60 s default — useful for tests that exercise queue behavior or
        // callers that prefer fast-fail.
        const release = await this.batchSaveMutex.acquire(options.mutexTimeoutMs);
        logger.debug(`[MUTEX] Acquired lock for batch save of ${businesses.length} businesses`);

        try {
            return await this._batchSaveInternal(businesses);
        } finally {
            // CRITICAL: Always release mutex, even on error
            release();
        }
    }

    /**
     * Internal batch save implementation (protected by mutex)
     * @private
     * @param {Business[]} businesses - Array of business objects
     * @returns {Promise<{success: number, errors: Array}>}
     */
    async _batchSaveInternal(businesses) {
        const db = await this.init();

        if (!db) {
            throw new Error('[DB ERROR] Database not initialized');
        }

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(CONFIG.db.stores.businesses, 'readwrite');
            const store = transaction.objectStore(CONFIG.db.stores.businesses);

            const errors = [];

            businesses.forEach((business, index) => {
                // Validate before adding
                if (!business.googleMapsUrl) {
                    errors.push({ index, error: new Error('Missing googleMapsUrl') });
                    return;
                }

                // M6-INT3 FIX: Normalize URL to match saveBusiness() behavior
                business.googleMapsUrl = this._normalizeGoogleMapsUrl(business.googleMapsUrl);

                // Set defaults
                if (!business.timestamp) business.timestamp = Date.now();
                if (business.emailScraped === undefined) business.emailScraped = false;
                // B8-3 FIX: derive hasWebsite for the v3 index.
                business.hasWebsite = _deriveHasWebsite(business);

                const request = store.put(business);

                request.onerror = (event) => {
                    // B8-1 FIX (2026-05-10): preventDefault stops the error
                    // from propagating to the parent transaction. Without
                    // this call, IndexedDB aborts the WHOLE transaction on
                    // any single put() error — meaning a batch with one bad
                    // entry (e.g. ConstraintError on duplicate key) silently
                    // rolls back ALL successful puts. Caller's expected
                    // behavior {success: N-1, errors: [{index: K, ...}]}
                    // becomes {success: 0, errors: ALL_LOST} pre-fix.
                    //
                    // This pattern is documented in MDN's IndexedDB best
                    // practices: "If you do not want a single failed put()
                    // to roll back the entire transaction, call
                    // event.preventDefault() in the onerror handler."
                    event.preventDefault();
                    errors.push({ index, error: request.error });
                    logger.warn(`[DB] Batch save error for index ${index}:`, request.error);
                };

                // We don't resolve on individual success - wait for transaction
            });

            // ✅ CRITICAL: Only resolve when transaction is fully committed
            transaction.oncomplete = () => {
                const successCount = businesses.length - errors.length;
                logger.info(`[DB] Batch save complete: ${successCount}/${businesses.length} succeeded`);
                resolve({ success: successCount, errors });
            };

            transaction.onerror = () => {
                logger.error('[DB] Batch transaction error:', transaction.error);
                reject(transaction.error);
            };

            transaction.onabort = () => {
                logger.error('[DB] Batch transaction aborted:', transaction.error);
                reject(new Error('Transaction aborted: ' + (transaction.error?.message || 'Unknown')));
            };
        });
    }

    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.initPromise = null;
            logger.info('Database connection closed');
        }
    }
}

// Export singleton instance
const dbInstance = new Database();

// Legacy API compatibility
export async function initDB() {
    return dbInstance.init();
}

export async function saveBusiness(business) {
    return dbInstance.saveBusiness(business);
}

export async function getBusinesses() {
    return dbInstance.getAllBusinesses();
}

export async function getBusiness(googleMapsUrl) {
    return dbInstance.getBusiness(googleMapsUrl);
}

export async function getBusinessesForEmailScraping(limit) {
    return dbInstance.getBusinessesForEmailScraping(limit);
}

export async function getBusinessesWithoutWebsite(limit) {
    return dbInstance.getBusinessesWithoutWebsite(limit);
}

// B10-3 FIX (2026-05-10): server-side filter wrappers for storage-modal
// cleanup. Pre-fix UI fetched ALL businesses then filtered client-side
// (8MB+ IPC payload risk on 10K+ DB). Now SW does cursor-based filter
// and returns only URL identifiers.
export async function getOldEmailedBusinessIds(cutoffMs) {
    return dbInstance.getOldEmailedBusinessIds(cutoffMs);
}

export async function getOldBusinessIds(cutoffMs) {
    return dbInstance.getOldBusinessIds(cutoffMs);
}

export async function updateBusiness(business) {
    // AUDIT FIX #1: Validate parameter to catch silent failures
    if (!business) {
        const error = new Error('[DB UPDATE FAILURE] updateBusiness called with null/undefined');
        logger.error(error.message);
        throw error;
    }

    // Check if called with correct signature
    if (!business.googleMapsUrl) {
        const error = new Error(
            '[DB UPDATE FAILURE] updateBusiness called without googleMapsUrl. ' +
            'Object keys: ' + Object.keys(business).join(', ')
        );
        logger.error(error.message, business);
        throw error;
    }

    // Debug logging for successful update
    logger.debug(`[DB UPDATE] Updating business: ${business.title || business.googleMapsUrl}`);

    // Use saveBusiness which does upsert (put operation)
    try {
        const result = await dbInstance.saveBusiness(business);
        logger.debug(`[DB UPDATE SUCCESS] ${business.googleMapsUrl}`);
        return result;
    } catch (error) {
        logger.error(`[DB UPDATE FAILURE] Failed to update ${business.googleMapsUrl}:`, error.message);
        throw error;
    }
}

export async function deleteBusiness(googleMapsUrl) {
    return dbInstance.deleteBusiness(googleMapsUrl);
}

export async function clearAllBusinesses() {
    return dbInstance.clear(); // Fix: was calling clearAllBusinesses() but method is clear()
}

export async function getStats() {
    return dbInstance.getStats();
}

// P3-002 FIX: Export getFailedBusinesses for retry functionality
export async function getFailedBusinesses(limit = null) {
    return dbInstance.getFailedBusinesses(limit);
}

export async function batchSave(businesses) {
    return dbInstance.batchSave(businesses);
}

// Export instance for direct use
export default dbInstance;
