/**
 * Sidepanel Reset Module
 * Step 01-05: M7-MISS7 - resetAll omits website extraction state
 *
 * Provides the website extraction state reset logic
 * that was missing from resetAll().
 *
 * Called by resetAll() in sidepanel.js to ensure website extraction
 * state is fully cleared during a factory reset.
 */

/**
 * Resets all website extraction state and UI elements.
 *
 * @param {object} state - The sidepanel state object
 * @param {object} elements - The DOM elements cache
 */
export function resetWebsiteExtractionState(state, elements) {
    // Reset website extraction state
    state.isExtractingWebsites = false;
    state.isWebsiteExtractionPaused = false;
    state.websiteProgress = { current: 0, total: 0, percent: 0 };

    // Hide website progress bar
    if (elements.websiteProgressSection) {
        elements.websiteProgressSection.style.display = 'none';
    }
    if (elements.websiteProgressBar) {
        elements.websiteProgressBar.style.width = '0%';
    }
    if (elements.websiteProgressPercent) {
        elements.websiteProgressPercent.textContent = '0%';
    }
    if (elements.websiteProgressStats) {
        elements.websiteProgressStats.textContent = '0 / 0';
    }
    if (elements.websiteProgressMessage) {
        elements.websiteProgressMessage.textContent = '';
    }

    // Clear website badge count
    if (elements.missingWebsiteBadge) {
        elements.missingWebsiteBadge.style.display = 'none';
        elements.missingWebsiteBadge.textContent = '0';
    }
}
