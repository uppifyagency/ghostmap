/**
 * Create a scrape helper window without covering the user's work.
 *
 * Chrome still needs a real popup (inactive tabs get throttled; minimized
 * windows stall JS). focused:false alone is not enough on Windows — the new
 * window often lands on top of the z-order.
 *
 * @param {chrome.windows.CreateData} createOptions
 * @param {{ restoreFocus?: boolean }} [opts] restoreFocus defaults true for
 *   short website/email popups. Area Search passes false so long-lived Maps
 *   windows are not background-throttled by re-focusing the user window.
 * @returns {Promise<chrome.windows.Window>}
 */
export async function createUnfocusedScrapeWindow(createOptions = {}, opts = {}) {
    const restoreFocus = opts.restoreFocus !== false;
    let restoreId = null;

    if (restoreFocus) {
        try {
            const last = await chrome.windows.getLastFocused({ populate: false });
            if (last?.id != null && last.type === 'normal') {
                restoreId = last.id;
            }
        } catch {
            /* no focused window yet */
        }
    }

    const win = await chrome.windows.create({
        ...createOptions,
        focused: false
    });

    if (win?.id != null) {
        try {
            await chrome.windows.update(win.id, { focused: false });
        } catch {
            /* ignore */
        }
    }

    if (restoreFocus && restoreId != null && restoreId !== win?.id) {
        try {
            await chrome.windows.update(restoreId, { focused: true });
        } catch {
            /* window may have closed */
        }
    }

    return win;
}
