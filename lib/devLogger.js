/**
 * Dev Log Bridge — forwards every log/console/error to a local sink server
 * so they appear in a single file/stream the user (and a connected coding
 * agent) can tail in real time.
 *
 * Design contract:
 *   - Zero impact in production: every export is a no-op until
 *     installDevLogger() is called, and that is gated on ENV=development
 *     by the caller (config.js).
 *   - Never throws into the host: all I/O is fire-and-forget, errors are
 *     swallowed locally.
 *   - Backs off automatically when the server is down (5 consecutive
 *     failures → kill switch flips until next page/SW boot).
 *   - Batches with a 100 ms trailing-edge debounce — under a burst of
 *     1000 log/s the network sees ~10 requests/s of 100 events each.
 *
 * Source tag convention (single letter pair, fits in monospace cleanly):
 *   SW  — background service worker
 *   UI  — sidepanel / popup HTML pages
 *   CS  — content script (ISOLATED world, e.g. loader.js, observer.js)
 *   MW  — content script (MAIN world, e.g. maps-state-watcher.js,
 *         detail-fetcher.js)
 */

const ENDPOINT = 'http://127.0.0.1:9876/log';
const BATCH_DEBOUNCE_MS = 100;
const KILL_AFTER_FAILS = 5;
const FETCH_TIMEOUT_MS = 2000;
const BUFFER_HARD_CAP = 5000; // safety bound; oldest dropped past this

let _source = null;
let _buffer = [];
let _timer = null;
let _fails = 0;
let _alive = true;
let _installed = false;

function _safeStringify(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ''}`;
    try { return JSON.stringify(v); } catch { return String(v); }
}

function _push(level, args) {
    if (!_alive || !_source) return;
    if (_buffer.length >= BUFFER_HARD_CAP) _buffer.shift();
    _buffer.push({
        ts: Date.now(),
        source: _source,
        level,
        msg: args.map(_safeStringify).join(' ')
    });
    if (!_timer) _timer = setTimeout(_flush, BATCH_DEBOUNCE_MS);
}

async function _flush() {
    _timer = null;
    if (_buffer.length === 0) return;
    const batch = _buffer;
    _buffer = [];
    try {
        // AbortController gives us a timeout fetch() lacks natively in
        // older runtimes. AbortSignal.timeout exists in Chrome 103+ but
        // we construct manually for clarity.
        const ctrl = new AbortController();
        // OBS-1 (2026-05-17): explicit reason. devLogger swallows the catch
        // (line ~79) so the reason rots in /dev/null today; included anyway
        // for forward-compat if we ever add classification on `_fails++`.
        // Name preserved as 'AbortError' for cross-codebase consistency.
        const to = setTimeout(
            () => ctrl.abort(new DOMException(`devLogger flush timeout ${FETCH_TIMEOUT_MS}ms`, 'AbortError')),
            FETCH_TIMEOUT_MS
        );
        try {
            await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batch),
                signal: ctrl.signal,
                // Don't let chrome-extension origin issues surface — we
                // POST to localhost only; server replies with Access-
                // Control-Allow-Origin:*. Keep mode default (cors).
            });
            _fails = 0;
        } finally { clearTimeout(to); }
    } catch (_) {
        _fails++;
        if (_fails >= KILL_AFTER_FAILS) {
            _alive = false;
            // last-ditch native console so the operator at least sees we
            // gave up; uses non-patched original via globalThis to avoid
            // a recursive call back into the patched console.
            const c = (typeof globalThis !== 'undefined' && globalThis.console) || null;
            if (c && c.warn) {
                c.warn('[devLogger] sink unreachable — disabling bridge until reload');
            }
        }
    }
}

/**
 * Forward an explicit event (used by logger.* in utils.js to mirror its
 * own broadcasts without going through console.*).
 * @param {string} level
 * @param  {...any} args
 */
export function devLog(level, ...args) {
    _push(level, args);
}

/**
 * Install the bridge for the current realm.
 *
 *   - Monkey-patches console.log/info/warn/error/debug so any existing
 *     console.* call is forwarded too (no caller changes needed).
 *   - Captures unhandled errors and promise rejections at window/self
 *     scope. The SW and UI both expose these handlers.
 *   - Idempotent: a second call is a no-op (we guard with _installed).
 *
 * @param {'SW'|'UI'|'CS'|'MW'} source - which realm we're running in
 */
export function installDevLogger(source) {
    if (_installed) return;
    _installed = true;
    _source = source;

    // Monkey-patch console.* — keep originals callable so DevTools still
    // shows them locally.
    const cons = (typeof globalThis !== 'undefined' && globalThis.console) || null;
    if (cons) {
        for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
            const orig = cons[level];
            if (typeof orig !== 'function') continue;
            cons[level] = function patched(...args) {
                try { _push(level, args); } catch { /* never throw */ }
                return orig.apply(cons, args);
            };
        }
    }

    // Unhandled errors / rejections. self covers SW; window covers UI.
    // In SW context self === globalThis; in UI window === globalThis.
    const target = (typeof self !== 'undefined') ? self
        : (typeof window !== 'undefined') ? window : null;
    if (target && typeof target.addEventListener === 'function') {
        target.addEventListener('error', (ev) => {
            try {
                _push('error', [
                    '[unhandled]',
                    ev?.message || ev?.error?.message || '(no message)',
                    ev?.error?.stack || `${ev?.filename}:${ev?.lineno}:${ev?.colno}`
                ]);
            } catch { /* never throw */ }
        });
        target.addEventListener('unhandledrejection', (ev) => {
            try {
                const r = ev?.reason;
                _push('error', [
                    '[unhandledrejection]',
                    r?.message || _safeStringify(r),
                    r?.stack || ''
                ]);
            } catch { /* never throw */ }
        });
    }

    // Boot beacon so the file shows when each realm came online.
    _push('info', [`[devLogger] online (source=${source})`]);
}
