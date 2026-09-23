/**
 * Shared messaging helper for UI scripts.
 *
 * UI-3 FIX (2026-05-11): the timeout-protected sendMessage helper was
 * previously defined locally in sidepanel.js (B9-2 fix) but not
 * exposed to other UI scripts. storage-modal.js still made 6 raw
 * chrome.runtime.sendMessage calls — if the service worker was
 * evicted between user click and message delivery, those promises
 * would hang forever (Chrome never auto-rejects on SW silence) and
 * the modal would lock up. Now hoisted to a shared script loaded
 * BEFORE both consumers, exporting the helper on `window` since
 * sidepanel.html uses classic (non-module) script tags.
 *
 * Default timeout: 15s. For destructive long-running ops like
 * clear_data, callers should pass an explicit longer timeout (e.g.
 * 30000) — the service worker can take a while to wipe IDB at scale,
 * and the user has already passed a confirm() gate so they're
 * already committed and a longer wait is preferable to a false
 * "didn't work" signal.
 */
(function () {
    'use strict';

    const DEFAULT_TIMEOUT_MS = 15000;

    /**
     * @param {object} message - sendMessage payload
     * @param {number} [timeoutMs=15000] - reject after this many ms
     * @returns {Promise<any>} response or throws Error('MESSAGE_TIMEOUT: ...')
     */
    async function sendMessageWithTimeout(message, timeoutMs = DEFAULT_TIMEOUT_MS) {
        let timer = null;
        try {
            return await Promise.race([
                chrome.runtime.sendMessage(message),
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('MESSAGE_TIMEOUT: Background not responding')),
                        timeoutMs
                    );
                })
            ]);
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }

    // Expose on window for classic-script consumers.
    window.sendMessageWithTimeout = sendMessageWithTimeout;
})();
