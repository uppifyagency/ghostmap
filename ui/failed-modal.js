/**
 * Failed Businesses Modal - FIXED VERSION
 * Shows detailed list of businesses that failed email scraping with error reasons
 * 
 * FIXES APPLIED:
 * - Fixed categorization logic to avoid double-counting
 * - Added proper error handling for missing message handler
 * - Added loading and error states
 * - Fixed "no website" categorization to only include actual failures
 * - Added retry mechanism for failed requests
 */

// Add Failed Businesses Modal HTML
const failedModalHTML = `
<div class="modal-overlay" id="failedModal" style="display: none;">
    <div class="modal-content" style="max-width: 700px;">
        <div class="modal-header">
            <h3>❌ Failed Businesses</h3>
            <button id="closeFailedModalBtn" class="icon-btn">✕</button>
        </div>
        
        <div class="modal-body">
            <div class="failed-summary">
                <p><strong id="failedTotalCount">0</strong> businesses failed email scraping</p>
            </div>

            <!-- Failure Categories -->
            <div class="failure-categories">
                <div class="failure-category">
                    <span class="category-icon">🚫</span>
                    <span class="category-label">No Email Found:</span>
                    <span class="category-count" id="noEmailCount">0</span>
                </div>
                <div class="failure-category">
                    <span class="category-icon">🔒</span>
                    <span class="category-label">Cloudflare Blocked:</span>
                    <span class="category-count" id="cloudflareCount">0</span>
                </div>
                <div class="failure-category">
                    <span class="category-icon">⏱️</span>
                    <span class="category-label">Timeout/Error:</span>
                    <span class="category-count" id="errorCount">0</span>
                </div>
                <div class="failure-category">
                    <span class="category-icon">🌐</span>
                    <span class="category-label">No Website:</span>
                    <span class="category-count" id="noWebsiteCount">0</span>
                </div>
            </div>

            <!-- Failed Businesses List -->
            <div class="failed-list-container">
                <h4>Failed Businesses Details:</h4>
                <div id="failedBusinessesList" class="failed-businesses-list">
                    <div class="loading-state">Loading...</div>
                </div>
            </div>
        </div>

        <div class="modal-footer">
            <button class="btn secondary" id="exportFailedBtn">📥 Export Failed</button>
            <button class="btn secondary" id="retryFailedFromModalBtn">🔄 Retry All Failed</button>
            <button class="btn primary" id="closeFailedModalFooterBtn">Close</button>
        </div>
    </div>
</div>
`;

// Inject modal into page
document.addEventListener('DOMContentLoaded', () => {
    document.body.insertAdjacentHTML('beforeend', failedModalHTML);

    // Attach event listeners - support both button and card click
    ['viewFailedBtn', 'failedStatCard'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', openFailedModal);
    });

    const closeBtn = document.getElementById('closeFailedModalBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeFailedModal);
    }

    const closeFooterBtn = document.getElementById('closeFailedModalFooterBtn');
    if (closeFooterBtn) {
        closeFooterBtn.addEventListener('click', closeFailedModal);
    }

    const exportBtn = document.getElementById('exportFailedBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportFailedBusinesses);
    }

    const retryBtn = document.getElementById('retryFailedFromModalBtn');
    if (retryBtn) {
        retryBtn.addEventListener('click', retryFailedFromModal);
    }

    // Close modal on overlay click
    const modal = document.getElementById('failedModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeFailedModal();
            }
        });
    }
});

/**
 * Open Failed Businesses Modal
 */
async function openFailedModal() {
    const modal = document.getElementById('failedModal');
    if (!modal) {
        console.error('[FailedModal] Modal element not found');
        return;
    }

    modal.style.display = 'flex';
    await loadFailedBusinesses();
}

/**
 * Close Failed Businesses Modal
 */
function closeFailedModal() {
    const modal = document.getElementById('failedModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Categorize a business into failure type
 * FIXED: Proper categorization logic without double-counting
 * 
 * @param {Object} business - Business object
 * @returns {string|null} - Category key or null if not a failure
 */
function categorizeFailure(business) {
    const hasWebsite = business.website && business.website.trim() !== '';
    const wasScraped = business.emailScraped === true;
    const hasEmail = business.email && business.email.trim() !== '';
    const hasError = business.scrapeError && business.scrapeError.trim() !== '';

    // If business has an email, it's not a failure
    if (hasEmail) {
        return null;
    }

    // Check for Cloudflare errors (highest priority for categorization)
    if (hasError) {
        const errorLower = business.scrapeError.toLowerCase();
        if (errorLower.includes('cloudflare') ||
            business.scrapeError === 'cloudflare_protected') {
            return 'cloudflare';
        }
    }

    // Business was scraped but no email found
    if (wasScraped) {
        if (hasError) {
            // Had an error during scraping (timeout, fetch error, etc.)
            return 'error';
        } else {
            // Scraped successfully but no email on site
            return 'noEmail';
        }
    }

    // Business has no website - couldn't be scraped
    if (!hasWebsite) {
        return 'noWebsite';
    }

    // Business not yet scraped, not a failure (pending)
    return null;
}

/**
 * Load and display failed businesses
 * FIXED: Better error handling, proper categorization
 */
async function loadFailedBusinesses() {
    const listContainer = document.getElementById('failedBusinessesList');
    if (!listContainer) return;

    // Show loading state
    listContainer.innerHTML = '<div class="loading-state">Loading failed businesses...</div>';

    try {
        // Request all businesses from background script
        // IMPORTANT: Background script must handle 'get_all_businesses' action
        const response = await sendMessageWithRetry({ action: 'get_all_businesses' }, 3);

        if (!response) {
            throw new Error('No response from background script. Is it running?');
        }

        if (response.error) {
            throw new Error(response.error);
        }

        const businesses = response.businesses || [];

        if (businesses.length === 0) {
            listContainer.innerHTML = '<div class="empty-state">No businesses in database yet. Start monitoring and scraping first!</div>';
            updateCounts({ noEmail: [], cloudflare: [], error: [], noWebsite: [] });
            return;
        }

        // Categorize failures using fixed logic
        const failed = {
            noEmail: [],        // Scraped but no email found
            cloudflare: [],     // Cloudflare protected
            error: [],          // Other errors (timeout, fetch error, etc.)
            noWebsite: []       // No website to scrape
        };

        businesses.forEach(business => {
            const category = categorizeFailure(business);
            if (category && failed[category]) {
                failed[category].push(business);
            }
        });

        // Update counts
        updateCounts(failed);

        // Render list
        renderFailedList(failed);

    } catch (error) {
        console.error('[FailedModal] Failed to load businesses:', error);
        // UI-4 FIX (2026-05-10): pre-fix the Retry button used inline
        // `onclick="loadFailedBusinesses()"`, blocked by MV3 default CSP
        // (`script-src 'self'`) on extension pages — see UI-1 fix for the
        // identical pattern in storage-modal.js. Result: when SW was
        // unavailable the user saw a Retry button that did nothing on
        // click; the only recovery was closing and re-opening the modal.
        // Now: render with id, then bind the click handler explicitly.
        listContainer.innerHTML = `
            <div class="error-state">
                <p>❌ Failed to load data</p>
                <p class="error-detail">${escapeHtml(error.message)}</p>
                <button id="failedModalRetryBtn" class="btn secondary" style="margin-top: 10px;">
                    🔄 Retry
                </button>
            </div>
        `;
        const retryBtn = listContainer.querySelector('#failedModalRetryBtn');
        if (retryBtn) {
            retryBtn.addEventListener('click', loadFailedBusinesses);
        }
        updateCounts({ noEmail: [], cloudflare: [], error: [], noWebsite: [] });
    }
}

/**
 * Send message with retry logic
 * @param {Object} message - Message to send
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<Object>} - Response from background script
 */
async function sendMessageWithRetry(message, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await chrome.runtime.sendMessage(message);
            return response;
        } catch (error) {
            lastError = error;
            console.warn(`[FailedModal] Attempt ${attempt}/${maxRetries} failed:`, error.message);

            if (attempt < maxRetries) {
                // Wait before retry (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }

    throw lastError || new Error('Failed to communicate with background script');
}

/**
 * Update failure category counts in UI
 * @param {Object} failed - Categorized failure arrays
 */
function updateCounts(failed) {
    const totalFailed = failed.noEmail.length + failed.cloudflare.length +
        failed.error.length + failed.noWebsite.length;

    const totalCount = document.getElementById('failedTotalCount');
    const noEmailCount = document.getElementById('noEmailCount');
    const cloudflareCount = document.getElementById('cloudflareCount');
    const errorCount = document.getElementById('errorCount');
    const noWebsiteCount = document.getElementById('noWebsiteCount');

    if (totalCount) totalCount.textContent = totalFailed;
    if (noEmailCount) noEmailCount.textContent = failed.noEmail.length;
    if (cloudflareCount) cloudflareCount.textContent = failed.cloudflare.length;
    if (errorCount) errorCount.textContent = failed.error.length;
    if (noWebsiteCount) noWebsiteCount.textContent = failed.noWebsite.length;
}

/**
 * Render failed businesses list
 * @param {Object} failed - Categorized failure arrays
 */
function renderFailedList(failed) {
    const container = document.getElementById('failedBusinessesList');
    if (!container) return;

    let html = '';

    // Helper to render a category
    const renderCategory = (title, icon, businesses, errorType, colorClass = '') => {
        if (businesses.length === 0) return '';

        return `
            <div class="failed-category-section ${colorClass}">
                <h5 class="category-header">
                    ${icon} ${title} 
                    <span class="category-count-badge">${businesses.length}</span>
                </h5>
                <div class="category-items">
                    ${businesses.map(b => renderBusinessItem(b, errorType)).join('')}
                </div>
            </div>
        `;
    };

    html += renderCategory('No Email Found', '🚫', failed.noEmail, 'NO EMAIL', 'category-warning');
    html += renderCategory('Cloudflare Protected', '🔒', failed.cloudflare, 'CLOUDFLARE', 'category-blocked');
    html += renderCategory('Errors & Timeouts', '⏱️', failed.error, 'ERROR', 'category-error');
    html += renderCategory('No Website', '🌐', failed.noWebsite, 'NO WEBSITE', 'category-info');

    if (html === '') {
        html = `
            <div class="success-state">
                <span class="success-icon">✅</span>
                <p>No failed businesses - all scraping successful!</p>
            </div>
        `;
    }

    container.innerHTML = html;
}

/**
 * Render a single business item
 * @param {Object} b - Business object
 * @param {string} errorType - Error type label
 * @returns {string} - HTML string
 */
function renderBusinessItem(b, errorType) {
    const websiteHtml = b.website
        ? `<div class="detail-row">🌐 <a href="${safeHref(b.website)}" target="_blank" rel="noopener">${escapeHtml(truncateUrl(b.website))}</a></div>`
        : '<div class="detail-row">🌐 No website listed</div>';

    const phoneHtml = b.phone
        ? `<div class="detail-row">📞 ${escapeHtml(b.phone)}</div>`
        : '';

    const errorHtml = b.scrapeError
        ? `<div class="detail-row error-message">⚠️ ${escapeHtml(b.scrapeError)}</div>`
        : '';

    const mapsLinkHtml = b.googleMapsUrl
        ? `<a href="${safeHref(b.googleMapsUrl)}" target="_blank" class="maps-link" title="Open in Google Maps">📍</a>`
        : '';

    return `
        <div class="failed-business-item">
            <div class="failed-business-header">
                <strong>${escapeHtml(b.title || 'Unknown Business')}</strong>
                <div class="header-actions">
                    ${mapsLinkHtml}
                    <span class="failed-badge badge-${escapeHtml(errorType.toLowerCase().replace(' ', '-'))}">${escapeHtml(errorType)}</span>
                </div>
            </div>
            <div class="failed-business-details">
                ${websiteHtml}
                ${phoneHtml}
                ${errorHtml}
            </div>
        </div>
    `;
}

/**
 * Truncate URL for display
 * @param {string} url - Full URL
 * @returns {string} - Truncated URL
 */
function truncateUrl(url) {
    if (!url) return '';
    try {
        const urlObj = new URL(url);
        const display = urlObj.hostname + urlObj.pathname;
        return display.length > 50 ? display.substring(0, 47) + '...' : display;
    } catch {
        return url.length > 50 ? url.substring(0, 47) + '...' : url;
    }
}

/**
 * Retry failed businesses from modal
 */
async function retryFailedFromModal() {
    const btn = document.getElementById('retryFailedFromModalBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '🔄 Retrying...';
    }

    try {
        // USE NEW DATABASE-BASED RETRY (works for businesses with no email found)
        const response = await chrome.runtime.sendMessage({ action: 'retry_failed_businesses' });

        if (response && response.status === 'retrying') {
            alert(`✅ Retrying ${response.count} failed businesses! Check the main panel for progress.`);
            closeFailedModal();

            // Refresh stats in main panel if function exists
            if (typeof refreshStats === 'function') {
                refreshStats();
            }
        } else if (response && response.status === 'no_targets') {
            alert('No failed businesses to retry.');
        } else {
            alert('Error: ' + (response?.error || 'Could not start retry'));
        }
    } catch (error) {
        console.error('[FailedModal] Retry error:', error);
        alert('Error starting retry: ' + error.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '🔄 Retry All Failed';
        }
    }
}

/**
 * Export failed businesses as CSV
 */
async function exportFailedBusinesses() {
    const btn = document.getElementById('exportFailedBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '📥 Exporting...';
    }

    try {
        const response = await sendMessageWithRetry({ action: 'get_all_businesses' });
        const businesses = response?.businesses || [];

        // Filter failed businesses using the same logic
        const failed = businesses.filter(b => categorizeFailure(b) !== null);

        if (failed.length === 0) {
            alert('No failed businesses to export');
            return;
        }

        // Create CSV with BOM for Excel compatibility
        const BOM = '\uFEFF';
        let csv = BOM + 'Business Name,Website,Phone,Category,Error Reason,Google Maps URL\n';

        failed.forEach(b => {
            const category = categorizeFailure(b);
            const categoryLabel = {
                'noEmail': 'No Email Found',
                'cloudflare': 'Cloudflare Blocked',
                'error': 'Error/Timeout',
                'noWebsite': 'No Website'
            }[category] || 'Unknown';

            const errorReason = b.scrapeError ||
                (!b.website ? 'No website listed' :
                    (b.emailScraped && !b.email ? 'Scraped but no email found' : 'Unknown'));

            csv += `"${escapeCsvField(b.title || '')}",`;
            csv += `"${escapeCsvField(b.website || '')}",`;
            csv += `"${escapeCsvField(b.phone || '')}",`;
            csv += `"${escapeCsvField(categoryLabel)}",`;
            csv += `"${escapeCsvField(errorReason)}",`;
            csv += `"${escapeCsvField(b.googleMapsUrl || '')}"\n`;
        });

        // Download
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ghost_map_failed_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`[FailedModal] Exported ${failed.length} failed businesses`);

    } catch (error) {
        console.error('[FailedModal] Export error:', error);
        alert('Failed to export: ' + error.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '📥 Export Failed';
        }
    }
}

/**
 * Escape CSV field (handle quotes and newlines)
 * @param {string} field - Field value
 * @returns {string} - Escaped field
 */
function escapeCsvField(field) {
    if (!field) return '';
    return field.toString().replace(/"/g, '""').replace(/\n/g, ' ');
}

/**
 * HTML escape helper (XSS prevention)
 * @param {string} text - Text to escape
 * @returns {string} - Escaped HTML
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * UI-002 FIX: Safe href helper (XSS prevention for URLs)
 * Prevents javascript: and other dangerous URL schemes in href attributes
 * @param {string} url - URL to sanitize
 * @returns {string} - Safe URL for href attribute
 */
function safeHref(url) {
    if (!url) return '#';
    const trimmed = url.trim().toLowerCase();
    // Block dangerous URL schemes
    if (trimmed.startsWith('javascript:') ||
        trimmed.startsWith('data:') ||
        trimmed.startsWith('vbscript:')) {
        console.warn('[UI-002] Blocked dangerous URL scheme:', url.substring(0, 50));
        return '#';
    }
    // Ensure http(s) protocol
    if (!url.match(/^https?:\/\//i)) {
        return 'https://' + url;
    }
    return url;
}

// Export functions for global access
window.openFailedModal = openFailedModal;
window.closeFailedModal = closeFailedModal;
window.exportFailedBusinesses = exportFailedBusinesses;
window.loadFailedBusinesses = loadFailedBusinesses;

// Add CSS for the modal (inject styles)
const modalStyles = `
<style>
    /* Premium Dark Theme Styles for Failed Modal */
    #failedModal .modal-content {
        /* Inherits glassmorphism from sidepanel.css */
        border: 1px solid var(--glass-border);
        box-shadow: var(--glass-shadow);
    }

    .failed-summary {
        text-align: center;
        margin-bottom: 20px;
        padding: 15px;
        background: var(--glass-bg);
        border-radius: 12px;
        border: 1px solid var(--glass-border);
    }

    .failed-summary p {
        margin: 0;
        font-size: 15px;
        color: var(--text-secondary);
    }

    .failed-summary strong {
        color: var(--color-error);
        font-size: 18px;
    }

    .failed-businesses-list {
        max-height: 300px;
        overflow-y: auto;
        border: 1px solid var(--glass-border);
        border-radius: 8px;
        padding: 10px;
        background: rgba(0, 0, 0, 0.2);
    }

    .failed-item {
        padding: 12px;
        border-bottom: 1px solid var(--glass-border);
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        transition: background 0.2s;
    }

    .failed-item:last-child {
        border-bottom: none;
    }

    .failed-item:hover {
        background: var(--glass-bg);
    }

    .business-info {
        flex: 1;
    }

    .business-name {
        font-weight: 600;
        margin-bottom: 4px;
        color: var(--text-primary);
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .maps-link {
        text-decoration: none;
        font-size: 16px;
        opacity: 0.8;
        transition: opacity 0.2s;
    }
    
    .maps-link:hover {
        opacity: 1;
    }

    .failed-badge {
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .badge-no-email { 
        background: rgba(245, 158, 11, 0.2); 
        color: #fbbf24; 
        border: 1px solid rgba(245, 158, 11, 0.3);
    }
    .badge-cloudflare { 
        background: rgba(239, 68, 68, 0.2); 
        color: #f87171; 
        border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .badge-error { 
        background: rgba(239, 68, 68, 0.15); 
        color: #fca5a5; 
        border: 1px solid rgba(239, 68, 68, 0.2);
    }
    .badge-no-website { 
        background: rgba(255, 255, 255, 0.1); 
        color: #d1d5db; 
        border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .failed-business-details {
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: 4px;
    }

    .detail-row {
        margin: 2px 0;
    }

    .detail-row a {
        color: var(--color-info);
        text-decoration: none;
    }

    .detail-row a:hover {
        text-decoration: underline;
        color: #60a5fa;
    }

    .error-message {
        color: #f87171;
        font-style: italic;
        font-size: 11px;
        margin-top: 4px;
    }

    .loading-state, .error-state, .empty-state, .success-state {
        text-align: center;
        padding: 40px 20px;
        color: var(--text-muted);
    }

    .error-state {
        color: var(--color-error);
    }

    .error-detail {
        font-size: 12px;
        margin-top: 8px;
        padding: 8px;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.2);
        border-radius: 4px;
        color: #fca5a5;
    }

    .success-state {
        color: var(--color-success);
    }

    .success-icon {
        font-size: 48px;
        display: block;
        margin-bottom: 12px;
    }

    .failure-categories {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        margin-bottom: 20px;
    }

    .failure-category {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: 8px;
        transition: transform 0.2s;
    }
    
    .failure-category:hover {
        background: rgba(255, 255, 255, 0.12);
        transform: translateY(-2px);
    }

    .category-label {
        flex: 1;
        font-size: 13px;
        color: var(--text-secondary);
    }

    .category-count {
        font-weight: 700;
        font-size: 16px;
        color: var(--text-primary);
    }
    /* BLOCK-10 FIX (LOW-020): Removed orphaned CSS properties (margin, font-size, color) */
}
</style>
`;

// Inject styles
document.head.insertAdjacentHTML('beforeend', modalStyles);
