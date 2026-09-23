/**
 * M8-MISS3 FIX: Coordinated infrastructure shutdown
 *
 * Stops all infrastructure timers in dependency order:
 * 1. Job queue (stop active processing first)
 * 2. System monitor (depends on job queue metrics)
 * 3. AutoScaler (depends on system monitor)
 * 4. CircuitBreaker cleanup timer
 * 5. Session pool (independent, but shut down last for safety)
 *
 * This ensures components that depend on others are stopped before
 * their dependencies, preventing dangling references and timer leaks.
 *
 * BUG-3 (P2, prevention): each phase now emits a defensive `logger.warn`
 * when the expected method is missing on the supplied component. The
 * previous permissive `if (typeof x.method === 'function')` guard silently
 * absorbed mis-wired components — including the canonical trap where
 * `circuitBreaker` could be passed as the exported `Map` (same name as
 * the namespace) instead of a wrapper/namespace exposing
 * `stopCleanupTimer`. Hardening makes any future mis-wiring loud, not
 * silent. See JSDoc for the contract.
 */

import { logger } from './utils.js';

// ─── NEW-4 (2026-05-27): mis-wire telemetry counter ─────────────────────
// BUG-3 Step 1 added a defensive `logger.warn` on each phase when the
// expected method is missing. The warn is only visible in DevTools — a
// production user without DevTools open has zero signal that a future
// regression has re-introduced the mis-wire trap. NEW-4 adds:
//
//   - Module-level counter `_miswireTelemetry` that increments on every
//     detected mis-wire. Survives the SW lifetime, resets on eviction
//     (acceptable: production mis-wire should be empirically zero post-
//     DEBT-3; if N>0 over a session, that's the signal).
//   - `getInfraMiswireTelemetry()` exported + attached to `globalThis`
//     for DevTools inspection (mirrors `getTabCloseTelemetry` pattern
//     in background/TabScraperFallback.js:404).
//   - `lastMiswireTs` / `lastMiswirePhase` for forensic triage.
//
// Severity stays at WARN (a contract violation but not a runtime crash;
// shutdown continues). BUG-3 regression test asserts the warn level.
const _miswireTelemetry = {
    jobQueue: 0,
    systemMonitor: 0,
    autoScaler: 0,
    circuitBreaker: 0,
    sessionPool: 0,
    totalShutdowns: 0,
    totalMiswires: 0,
    lastMiswirePhase: null,
    lastMiswireTs: null,
    sinceTs: Date.now()
};

function _recordMiswire(phaseName) {
    _miswireTelemetry[phaseName]++;
    _miswireTelemetry.totalMiswires++;
    _miswireTelemetry.lastMiswirePhase = phaseName;
    _miswireTelemetry.lastMiswireTs = Date.now();
}

/**
 * Snapshot of the infrastructure mis-wire telemetry counters. Returns a
 * shallow copy so callers can't mutate the live object.
 *
 * Production usage: in DevTools (or `chrome.scripting.executeScript` on
 * the SW), run `getInfraMiswireTelemetry()` after a suspected mis-wire
 * incident to see which phase(s) fired and how often.
 *
 * @returns {{
 *   jobQueue: number, systemMonitor: number, autoScaler: number,
 *   circuitBreaker: number, sessionPool: number,
 *   totalShutdowns: number, totalMiswires: number,
 *   lastMiswirePhase: string|null, lastMiswireTs: number|null,
 *   sinceTs: number, sinceMs: number
 * }}
 */
export function getInfraMiswireTelemetry() {
    return {
        ...{ ..._miswireTelemetry },  // shallow clone — caller can't mutate
        sinceMs: Date.now() - _miswireTelemetry.sinceTs
    };
}

// Attach to globalThis so DevTools can call it without import (matches
// the `getTabCloseTelemetry` precedent at TabScraperFallback.js:395).
// Guarded — some test envs stub globalThis with a frozen object.
try {
    if (typeof globalThis !== 'undefined' && !globalThis.getInfraMiswireTelemetry) {
        globalThis.getInfraMiswireTelemetry = getInfraMiswireTelemetry;
    }
} catch { /* sandbox / frozen globalThis — proceed silently */ }

/**
 * Shutdown all infrastructure components in dependency order.
 *
 * @param {Object} components - Infrastructure components to shut down
 * @param {Object} [components.jobQueue]      - Object exposing async stop().
 * @param {Object} [components.systemMonitor] - Object exposing stop().
 * @param {Object} [components.autoScaler]    - Object exposing stop().
 * @param {Object} [components.circuitBreaker] - Object exposing a
 *   `stopCleanupTimer()` method. IMPORTANT: pass the module namespace
 *   `import * as cb from '../lib/CircuitBreaker.js'` OR a wrapper
 *   `{ stopCleanupTimer: cb.stopCleanupTimer }` — NOT the exported
 *   `circuitBreaker` Map symbol from CircuitBreaker.js (which is the
 *   state container, not the API namespace).
 * @param {Object} [components.sessionPool]   - Object exposing async shutdown().
 * @returns {Promise<void>}
 */
export async function shutdownInfrastructure(components) {
    const {
        jobQueue,
        systemMonitor,
        autoScaler,
        circuitBreaker,
        sessionPool
    } = components;

    _miswireTelemetry.totalShutdowns++;
    logger.info('[INFRASTRUCTURE] Starting coordinated shutdown...');

    // Phase 1: Stop job processing (must be first - other components serve the queue)
    if (jobQueue) {
        try {
            if (typeof jobQueue.stop === 'function') {
                await jobQueue.stop();
                logger.info('[INFRASTRUCTURE] Job queue stopped');
            } else {
                _recordMiswire('jobQueue');
                logger.warn('[INFRASTRUCTURE] jobQueue component missing stop() method — skipped (likely mis-wired: expected an object with .stop())');
            }
        } catch (error) {
            logger.warn(`[INFRASTRUCTURE] Job queue stop failed: ${error.message}`);
        }
    }

    // Phase 2: Stop monitoring (depends on queue metrics)
    if (systemMonitor) {
        try {
            if (typeof systemMonitor.stop === 'function') {
                systemMonitor.stop();
                logger.info('[INFRASTRUCTURE] System monitor stopped');
            } else {
                _recordMiswire('systemMonitor');
                logger.warn('[INFRASTRUCTURE] systemMonitor component missing stop() method during shutdown — skipped (likely mis-wired: expected an object with .stop())');
            }
        } catch (error) {
            logger.warn(`[INFRASTRUCTURE] System monitor stop failed during shutdown: ${error.message}`);
        }
    }

    // Phase 3: Stop autoscaler (depends on system monitor)
    if (autoScaler) {
        try {
            if (typeof autoScaler.stop === 'function') {
                autoScaler.stop();
                logger.info('[INFRASTRUCTURE] AutoScaler stopped');
            } else {
                _recordMiswire('autoScaler');
                logger.warn('[INFRASTRUCTURE] autoScaler component missing stop() method during shutdown — skipped (likely mis-wired: expected an object with .stop())');
            }
        } catch (error) {
            logger.warn(`[INFRASTRUCTURE] AutoScaler stop failed during shutdown: ${error.message}`);
        }
    }

    // Phase 4: Stop circuit breaker cleanup timer
    if (circuitBreaker) {
        try {
            if (typeof circuitBreaker.stopCleanupTimer === 'function') {
                circuitBreaker.stopCleanupTimer();
                logger.info('[INFRASTRUCTURE] Circuit breaker timer stopped');
            } else {
                _recordMiswire('circuitBreaker');
                logger.warn('[INFRASTRUCTURE] circuitBreaker component missing stopCleanupTimer() method — skipped (likely mis-wired: expected the CircuitBreaker module namespace or a wrapper exposing stopCleanupTimer, NOT the exported `circuitBreaker` Map symbol)');
            }
        } catch (error) {
            logger.warn(`[INFRASTRUCTURE] Circuit breaker stopCleanupTimer failed: ${error.message}`);
        }
    }

    // Phase 5: Shutdown session pool (persists state, last because independent)
    if (sessionPool) {
        try {
            if (typeof sessionPool.shutdown === 'function') {
                await sessionPool.shutdown();
                logger.info('[INFRASTRUCTURE] Session pool shut down');
            } else {
                _recordMiswire('sessionPool');
                logger.warn('[INFRASTRUCTURE] sessionPool component missing shutdown() method — skipped (likely mis-wired: expected an object with async .shutdown())');
            }
        } catch (error) {
            logger.warn(`[INFRASTRUCTURE] Session pool shutdown failed: ${error.message}`);
        }
    }

    logger.info('[INFRASTRUCTURE] Coordinated shutdown complete');
}
