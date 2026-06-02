/**
 * M2-SEC1: Message Origin Validation
 * Defense-in-depth: validates sender identity and context for chrome.runtime.onMessage.
 *
 * - Rejects messages from foreign extension IDs
 * - Rejects messages with missing sender ID
 * - Requires destructive actions (factory_reset, clear_data) to originate
 *   from extension pages (sender.tab must be undefined)
 */

const DESTRUCTIVE_ACTIONS = new Set(['factory_reset', 'clear_data']);

/**
 * Validates the sender of a chrome.runtime.onMessage event.
 *
 * @param {chrome.runtime.MessageSender} sender - The message sender object
 * @param {string} action - The message action being performed
 * @param {string} ownExtensionId - The extension's own chrome.runtime.id
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function validateMessageSender(sender, action, ownExtensionId) {
    if (!sender || !sender.id) {
        return {
            allowed: false,
            reason: 'Rejected: missing sender ID'
        };
    }

    if (sender.id !== ownExtensionId) {
        return {
            allowed: false,
            reason: `Rejected: unexpected sender ID "${sender.id}"`
        };
    }

    if (DESTRUCTIVE_ACTIONS.has(action) && sender.tab !== undefined) {
        return {
            allowed: false,
            reason: `Rejected: destructive action "${action}" must originate from extension page, not tab context`
        };
    }

    return { allowed: true };
}
