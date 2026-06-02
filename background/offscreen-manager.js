/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 * 
 * FIX-001: Enhanced race condition prevention with atomic lock pattern
 * The previous implementation had a subtle race between context check and lock acquisition.
 * Now the context check is performed INSIDE the locked section for true atomicity.
 */

/**
 * Ghost Map Pro - Offscreen Document Manager
 * Handles creation and management of offscreen documents for HTML parsing
 */

import { logger, sleep } from '../lib/utils.js';
import { CONFIG } from '../lib/config.js';

// Track offscreen document creation state with atomic lock
let offscreenCreating = null;

// 2026-05-15: deadlock guard. Pre-fix, if setupOffscreenDocument hung
// inside ensureOffscreenReady (because chrome.runtime.sendMessage has
// no native timeout and the offscreen doc went silent), every other
// caller awaiting `offscreenCreating` was stuck forever, freezing the
// entire job queue. Two guards now:
//   1. SETUP_TOTAL_TIMEOUT_MS bounds the whole setupOffscreenDocument
//      call — caller B never waits longer than this for caller A.
//   2. PING_SINGLE_TIMEOUT_MS bounds each ping inside
//      ensureOffscreenReady so a single non-responding sendMessage
//      cannot stall the entire ping budget.
// Observed freeze: scrape stuck for >50s on mariannamero.it after
// `[FIX-001] Already creating offscreen document, waiting...`.
const SETUP_TOTAL_TIMEOUT_MS = 15000;
const PING_SINGLE_TIMEOUT_MS = 1500;

function _withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`TIMEOUT(${label}, ${ms}ms)`)),
                ms
            );
        })
    ]).finally(() => clearTimeout(timer));
}

/**
 * Setup offscreen document with robust error handling and race condition prevention
 * FIX-001: Context check is now INSIDE the lock for true atomicity
 * @returns {Promise<void>} Resolves when offscreen document is created and ready
 * @throws {Error} If creation fails (excluding "already exists" error which is handled gracefully)
 * @example
 * await setupOffscreenDocument();
 * // Offscreen document is now ready to receive parse_html messages
 */
export async function setupOffscreenDocument() {
    // FIX-001: Wait for any in-progress creation first (atomic lock pattern).
    // 2026-05-15 deadlock guard: bound the wait. If caller A is hung
    // (offscreen doc went silent mid-setup, sendMessage with no timeout),
    // every subsequent caller used to wait forever. Now caller B waits at
    // most SETUP_TOTAL_TIMEOUT_MS — on timeout the lock is force-cleared
    // and we retry from scratch (which will hit the existing-context branch
    // and re-ping, or recreate if Chrome reports no context).
    if (offscreenCreating) {
        logger.debug('[FIX-001] Already creating offscreen document, waiting (bounded)...');
        try {
            await _withTimeout(offscreenCreating, SETUP_TOTAL_TIMEOUT_MS, 'caller-B-wait');
            return;
        } catch (waitErr) {
            logger.warn('[OFFSCREEN] caller-B timeout waiting for in-flight setup, force-clearing lock and retrying:', waitErr?.message);
            offscreenCreating = null;
            // fall through to start a fresh setup ourselves
        }
    }

    // FIX-001: Create promise and assign to lock variable SYNCHRONOUSLY
    // This prevents any other call from entering this block until we're done.
    // 2026-05-15: also bounded with SETUP_TOTAL_TIMEOUT_MS at the await
    // below, so caller A itself cannot hang forever.
    offscreenCreating = (async () => {
        try {
            // DIAGNOSTIC: Log creation attempt
            logger.info('[OFFSCREEN-DIAG] 🔵 Starting offscreen document setup...');

            // FIX-001: Check for existing context INSIDE the lock
            // This prevents the race condition where two calls both pass the
            // pre-lock check before either creates the document
            const existingContext = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT'],
                documentUrls: [chrome.runtime.getURL('offscreen/index.html')]
            });

            // DIAGNOSTIC: Log context check result
            logger.info('[OFFSCREEN-DIAG] 🔵 Existing contexts found:', existingContext.length);
            if (existingContext.length > 0) {
                logger.info('[OFFSCREEN-DIAG] 🔵 Context details:', JSON.stringify(existingContext.map(c => ({
                    contextType: c.contextType,
                    documentUrl: c.documentUrl,
                    documentLifecycle: c.documentLifecycle,
                    frameId: c.frameId
                }))));
            }

            if (existingContext.length > 0) {
                // BG-10 FIX (2026-05-10): pre-fix this early-returned without
                // waiting for the existing offscreen document to be responsive
                // to messages. Two callers arriving ~50 ms apart: the first
                // creates the doc and starts the ensureOffscreenReady ping
                // loop (up to CONFIG.offscreen.pingMaxAttempts × pingIntervalMs
                // ≈ 30 × 100 ms = 3 s); the second finds the context already
                // there, returns immediately, sends parse_html, and falls
                // through the 15 s message timeout because the doc isn't ready
                // yet. Caller then takes the parseHTMLDirect fallback — same
                // result but degraded quality.
                // Now: still skip the create, but also await ensureOffscreenReady
                // so the caller doesn't return until the doc is responsive.
                logger.debug('[FIX-001] Offscreen document already exists (reusing) — awaiting readiness');
                await ensureOffscreenReady();
                return;
            }

            logger.info('[OFFSCREEN] Creating offscreen document...');
            logger.info('[OFFSCREEN-DIAG] 🔵 Calling chrome.offscreen.createDocument...');

            await chrome.offscreen.createDocument({
                url: 'offscreen/index.html',
                reasons: ['DOM_SCRAPING'],
                justification: 'Parse HTML and extract contact information (emails, social links)'
            });

            logger.info('[OFFSCREEN-DIAG] ✅ createDocument() completed successfully');

            // DIAGNOSTIC: Check context immediately after creation
            const postCreateContext = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT']
            });
            logger.info('[OFFSCREEN-DIAG] 🔵 Post-create contexts:', postCreateContext.length, JSON.stringify(postCreateContext.map(c => ({
                documentLifecycle: c.documentLifecycle,
                documentUrl: c.documentUrl
            }))));

            // Wait for offscreen to be ready
            logger.info('[OFFSCREEN-DIAG] 🔵 Starting ping loop (ensureOffscreenReady)...');
            await ensureOffscreenReady();
            logger.info('Offscreen document created and ready');

        } catch (error) {
            const errorMsg = error?.message || String(error);

            if (errorMsg.includes('Only a single offscreen')) {
                logger.debug('Offscreen document already exists (reusing)');
            } else {
                logger.warn('Failed to create offscreen document:', error);
                throw error; // Propagate error to caller
            }
        } finally {
            offscreenCreating = null;
        }
    })();

    // 2026-05-15: bound caller A. If any internal step (getContexts,
    // createDocument, ensureOffscreenReady) hangs past the budget,
    // surface the error rather than wait forever.
    await _withTimeout(offscreenCreating, SETUP_TOTAL_TIMEOUT_MS, 'caller-A-setup');
}

/**
 * Ensure offscreen document is ready to receive messages by pinging it
 * BLOCK-L2 FIX: Uses CONFIG.offscreen settings instead of hardcoded values
 * @returns {Promise<void>} Resolves when offscreen responds with 'alive' status
 * @throws {Error} If offscreen document doesn't respond after max attempts
 * @example
 * await ensureOffscreenReady();
 * // Now safe to send parse_html messages
 */
export async function ensureOffscreenReady() {
    let attempts = 0;
    // BLOCK-L2 FIX: Use CONFIG for ping settings
    const maxAttempts = CONFIG.offscreen.pingMaxAttempts;
    const delay = CONFIG.offscreen.pingIntervalMs;

    // DIAGNOSTIC: Log ping loop start
    logger.info(`[OFFSCREEN-DIAG] 🔵 Ping loop: max=${maxAttempts}, delay=${delay}ms, total=${maxAttempts * delay}ms`);

    while (attempts < maxAttempts) {
        try {
            // DIAGNOSTIC: Log each ping attempt (only first 3 and every 5th)
            if (attempts < 3 || attempts % 5 === 0) {
                logger.debug(`[OFFSCREEN-DIAG] 🏓 Ping attempt ${attempts + 1}/${maxAttempts}...`);
            }

            // 2026-05-15: chrome.runtime.sendMessage has NO native
            // timeout — if the offscreen doc went silent (crashed,
            // mid-eviction, JS exception during init) the promise
            // never resolves. Wrap with PING_SINGLE_TIMEOUT_MS so a
            // dead ping doesn't burn the entire ping budget by waiting
            // forever on attempt #1. The catch below treats timeout
            // identically to any other failure → retry next iteration.
            const response = await _withTimeout(
                chrome.runtime.sendMessage({ action: 'ping', target: 'offscreen' }),
                PING_SINGLE_TIMEOUT_MS,
                'ping'
            );

            // DIAGNOSTIC: Log ping response
            if (attempts < 3 || response) {
                logger.debug(`[OFFSCREEN-DIAG] 📨 Ping response:`, JSON.stringify(response));
            }

            // BUG-001 FIX: Verify response source to prevent race condition
            // where another context (e.g., content script) responds first
            if (response && response.status === 'alive' && response.source === 'offscreen') {
                logger.info(`[OFFSCREEN-DIAG] ✅ Offscreen responded on attempt ${attempts + 1}`);
                return; // Offscreen responded with verified source
            } else if (response) {
                // DIAGNOSTIC: Log unexpected response
                logger.warn(`[OFFSCREEN-DIAG] ⚠️ Got response but wrong format:`, JSON.stringify(response));
            }
        } catch (e) {
            // DIAGNOSTIC: Log ping errors (only first 2)
            if (attempts < 2) {
                logger.debug(`[OFFSCREEN-DIAG] ❌ Ping ${attempts + 1} error:`, e.message);
            }
        }

        await sleep(delay);
        attempts++;
    }

    // DIAGNOSTIC: Final failure log
    logger.error(`[OFFSCREEN-DIAG] ❌❌❌ All ${maxAttempts} pings failed! Offscreen never responded.`);
    throw new Error('Offscreen document not responsive after creation');
}

export default {
    setupOffscreenDocument,
    ensureOffscreenReady
};
