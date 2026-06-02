/**
 * Ghost Map Pro - Sidepanel Controller
 * Phase-Based Navigation with Modern UI
 * Version 9.0.1 - Fixed message actions
 */

// ============================================
// STATE MANAGEMENT
// ============================================
// ═══════════════════════════════════════════════════════════════════════════
// UI-004 FIX: Store interval IDs for proper cleanup on unload
// ═══════════════════════════════════════════════════════════════════════════
let statsRefreshInterval = null;

// IO7: Pending URLs from file import
let pendingImportUrls = [];

const state = {
    currentPhase: 1,
    isMonitoring: false,
    isExtractingEmails: false,
    isExtractingWebsites: false,
    isWebsiteExtractionPaused: false,  // FIX: Track pause state for resume toggle
    activityExpanded: false,
    stats: {
        total: 0,
        withEmail: 0,
        withWebsite: 0,
        withPhone: 0,
        queue: 0,
        failed: 0,
        successRate: 0,
        avgTime: null
    },
    emailProgress: {
        current: 0,
        total: 0,
        percent: 0
    },
    websiteProgress: {
        current: 0,
        total: 0,
        percent: 0
    },
    activities: [],
    MAX_ACTIVITIES: 100,  // P3-006 FIX: Prevent unbounded activity list growth
    previousTotal: 0,
    currentTabId: null
};

// ============================================
// DOM ELEMENTS
// ============================================
const elements = {
    // Phase navigation
    phaseItems: document.querySelectorAll('.phase-item'),
    phaseLines: document.querySelectorAll('.phase-line'),
    phaseContents: document.querySelectorAll('.phase-content'),
    phaseCounts: {
        1: document.getElementById('phaseCount1'),
        2: document.getElementById('phaseCount2'),
        3: document.getElementById('phaseCount3')
    },

    // Header
    statusIndicator: document.getElementById('statusIndicator'),
    statusText: document.getElementById('statusText'),
    settingsBtn: document.getElementById('settingsBtn'),
    globalResetBtn: document.getElementById('globalResetBtn'),  // FIX: Added global reset button

    // Hero
    heroCard: document.getElementById('heroCard'),
    heroNumber: document.getElementById('heroNumber'),
    emailCount: document.getElementById('emailCount'),
    websiteCount: document.getElementById('websiteCount'),
    phoneCount: document.getElementById('phoneCount'),

    // Phase 1: Discover
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    extractWebsitesBtn: document.getElementById('extractWebsitesBtn'),
    pauseWebsiteBtn: document.getElementById('pauseWebsiteBtn'),
    missingWebsiteBadge: document.getElementById('missingWebsiteBadge'),
    websiteProgressSection: document.getElementById('websiteProgressSection'),
    websiteProgressBar: document.getElementById('websiteProgressBar'),
    websiteProgressPercent: document.getElementById('websiteProgressPercent'),
    websiteProgressStats: document.getElementById('websiteProgressStats'),
    websiteProgressMessage: document.getElementById('websiteProgressMessage'),
    areaSearchBtn: document.getElementById('areaSearchBtn'),
    extractTransition: document.getElementById('extractTransition'),
    queueCount: document.getElementById('queueCount'),
    goToExtractBtn: document.getElementById('goToExtractBtn'),

    // Phase 2: Extract
    emailBtn: document.getElementById('emailBtn'),
    stopEmailBtn: document.getElementById('stopEmailBtn'),
    emailProgressSection: document.getElementById('emailProgressSection'),
    emailProgressBar: document.getElementById('emailProgressBar'),
    emailProgressPercent: document.getElementById('emailProgressPercent'),
    emailProgressStats: document.getElementById('emailProgressStats'),
    emailProgressETA: document.getElementById('emailProgressETA'),
    emailProgressLabel: document.getElementById('emailProgressLabel'),
    emailCurrentItem: document.getElementById('emailCurrentItem'),
    emailCurrentText: document.getElementById('emailCurrentText'),
    emailShimmer: document.getElementById('emailShimmer'),
    successRate: document.getElementById('successRate'),
    avgTime: document.getElementById('avgTime'),
    failedCount: document.getElementById('failedCount'),
    failedStatCard: document.getElementById('failedStatCard'),
    retrySection: document.getElementById('retrySection'),  // P3-002 FIX
    retryFailedBtn: document.getElementById('retryFailedBtn'),  // P3-002 FIX
    retryCount: document.getElementById('retryCount'),  // P3-002 FIX
    exportTransition: document.getElementById('exportTransition'),
    goToExportBtn: document.getElementById('goToExportBtn'),

    // Live Stats Board
    liveStatsToggle: document.getElementById('liveStatsToggle'),
    liveStatsBoard: document.getElementById('liveStatsBoard'),
    liveRuntime: document.getElementById('liveRuntime'),
    liveReqFinished: document.getElementById('liveReqFinished'),
    liveReqTotal: document.getElementById('liveReqTotal'),
    liveRetried: document.getElementById('liveRetried'),
    liveEmails: document.getElementById('liveEmails'),
    liveEmailsRate: document.getElementById('liveEmailsRate'),
    liveSpeed: document.getElementById('liveSpeed'),
    liveDownloaded: document.getElementById('liveDownloaded'),
    liveCFBlocks: document.getElementById('liveCFBlocks'),
    liveRateLimits: document.getElementById('liveRateLimits'),
    liveTimeouts: document.getElementById('liveTimeouts'),
    liveSessionsRetired: document.getElementById('liveSessionsRetired'),
    liveSessionsCreated: document.getElementById('liveSessionsCreated'),
    liveMemory: document.getElementById('liveMemory'),
    // AutoScaler stats
    liveConcurrency: document.getElementById('liveConcurrency'),
    liveSuccessRate: document.getElementById('liveSuccessRate'),
    liveScaleUps: document.getElementById('liveScaleUps'),
    liveScaleDowns: document.getElementById('liveScaleDowns'),

    // Phase 3: Export
    qualityArc: document.getElementById('qualityArc'),
    qualityValue: document.getElementById('qualityValue'),
    qualityLabel: document.getElementById('qualityLabel'),
    previewTotal: document.getElementById('previewTotal'),
    previewEmails: document.getElementById('previewEmails'),
    previewWebsites: document.getElementById('previewWebsites'),
    previewPhones: document.getElementById('previewPhones'),
    exportCsvBtn: document.getElementById('exportCsvBtn'),
    exportMdBtn: document.getElementById('exportMdBtn'),
    viewFailedBtn: document.getElementById('viewFailedBtn'),
    failedBadge: document.getElementById('failedBadge'),
    resetBtn: document.getElementById('resetBtn'),

    // Activity
    activityList: document.getElementById('activityList'),
    activityEmpty: document.getElementById('activityEmpty'),
    toggleActivityBtn: document.getElementById('toggleActivityBtn'),

    // Storage
    storageText: document.getElementById('storageText'),
    storageFill: document.getElementById('storageFill'),
    storageDetailsBtn: document.getElementById('storageDetailsBtn'),

    // Toast
    toastContainer: document.getElementById('toastContainer'),

    // Loading
    loadingOverlay: document.getElementById('loadingOverlay'),
    loadingMessage: document.getElementById('loadingMessage'),

    // Settings Modal
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    cancelSettingsBtn: document.getElementById('cancelSettingsBtn'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    settingRateLimit: document.getElementById('settingRateLimit'),
    settingMaxConcurrent: document.getElementById('settingMaxConcurrent'),
    settingTimeout: document.getElementById('settingTimeout'),
    tabBtns: document.querySelectorAll('.tab-btn'),
    tabContents: document.querySelectorAll('.tab-content'),

    // FIX: Added selector inputs for custom GMaps selectors
    selTitle: document.getElementById('selTitle'),
    selPhone: document.getElementById('selPhone'),
    selWebsite: document.getElementById('selWebsite'),
    selAddress: document.getElementById('selAddress')
};

// ═══════════════════════════════════════════════════════════════════════════
// H4-003 FIX: Message Timeout Utility
// ─────────────────────────────────────────────────────────────────────────────
// Problem: chrome.runtime.sendMessage can hang forever if:
//   - Background script crashed/unresponsive
//   - Service worker was terminated and not restarted
//   - Message handler threw uncaught exception
// 
// This causes UI to freeze with no feedback to user.
// 
// Solution: Wrap message calls with timeout to fail gracefully.
// ═══════════════════════════════════════════════════════════════════════════
// UI-3 FIX (2026-05-11): sendMessageWithTimeout was hoisted into the
// shared ui/messaging.js loaded BEFORE this script. We reference it
// directly via the global it installs on `window`. Local re-binding
// keeps every callsite below unchanged. Previously this helper was
// inlined here only, so storage-modal.js (which loads earlier) had to
// use raw chrome.runtime.sendMessage — that path would hang the modal
// forever on SW eviction. Now both files share the same SW-safe
// helper. See ui/messaging.js for the body.
const sendMessageWithTimeout = window.sendMessageWithTimeout;

// ============================================
// INITIALIZATION
// ============================================
async function initialize() {
    console.log('[GhostMap] Initializing sidepanel v9.0.1...');

    // BLOCK-2 FIX (MED-015): Error boundary around initialization
    try {
        // Setup event listeners
        setupEventListeners();

        // Load initial stats
        await loadStats();

        // Load settings
        await loadSettings();

        // Setup message listener
        chrome.runtime.onMessage.addListener(handleBackgroundMessage);

        // Start periodic stats refresh
        // UI-004 FIX: Store interval ID for cleanup
        statsRefreshInterval = setInterval(loadStats, 3000);

        // BLOCK-3 FIX (CRIT-008): Cleanup intervals on page unload
        // UI-004 FIX: Also cleanup statsRefreshInterval
        window.addEventListener('beforeunload', () => {
            if (liveStatsInterval) {
                clearInterval(liveStatsInterval);
                liveStatsInterval = null;
            }
            if (statsRefreshInterval) {
                clearInterval(statsRefreshInterval);
                statsRefreshInterval = null;
            }
        });

        console.log('[GhostMap] Sidepanel initialized');
    } catch (error) {
        console.error('[GhostMap] CRITICAL: Initialization failed:', error);
        // UI-001 FIX: Show error state using textContent (XSS-safe)
        // Even system errors should use safe DOM methods as a defense-in-depth measure
        const errorContainer = document.createElement('div');
        errorContainer.style.cssText = 'padding: 20px; text-align: center; color: #f87171;';

        const heading = document.createElement('h2');
        heading.textContent = '⚠️ Initialization Error';

        const message = document.createElement('p');
        message.style.color = '#9ca3af';
        message.textContent = 'Ghost Map Pro failed to start.';

        const errorDetail = document.createElement('p');
        errorDetail.style.cssText = 'font-size: 12px; color: #6b7280; margin-top: 10px;';
        errorDetail.textContent = error.message || 'Unknown error';

        const reloadBtn = document.createElement('button');
        reloadBtn.textContent = '🔄 Reload';
        reloadBtn.style.cssText = 'margin-top: 20px; padding: 10px 20px; background: #6366f1; color: white; border: none; border-radius: 8px; cursor: pointer;';
        reloadBtn.onclick = () => location.reload();

        errorContainer.append(heading, message, errorDetail, reloadBtn);
        document.body.innerHTML = '';
        document.body.appendChild(errorContainer);
    }
}

// ============================================
// M7-RACE1 FIX: Debounce utility for click handlers
// Prevents race conditions from rapid button clicking.
// First click executes immediately; subsequent clicks within
// the debounce window (500ms) are ignored.
// ============================================
const DEBOUNCE_MS = 500;

function createDebouncedClickHandler(handler, btn) {
    let debounceActive = false;
    return function debouncedHandler() {
        if (debounceActive) {
            return;
        }
        debounceActive = true;
        btn.disabled = true;

        Promise.resolve(handler()).finally(() => {
            setTimeout(() => {
                debounceActive = false;
                btn.disabled = false;
            }, DEBOUNCE_MS);
        });
    };
}

// ============================================
// EVENT LISTENERS
// ============================================
function setupEventListeners() {
    // Phase navigation
    elements.phaseItems.forEach(item => {
        item.addEventListener('click', () => {
            const phase = parseInt(item.dataset.phase);
            if (phase <= getMaxAvailablePhase()) {
                switchPhase(phase);
            }
        });
    });

    // Phase 1: Discover (M7-RACE1: debounced to prevent rapid-click race conditions)
    elements.startBtn.addEventListener('click', createDebouncedClickHandler(startScraping, elements.startBtn));
    elements.stopBtn.addEventListener('click', createDebouncedClickHandler(stopScraping, elements.stopBtn));
    elements.extractWebsitesBtn.addEventListener('click', startWebsiteExtraction);
    elements.pauseWebsiteBtn.addEventListener('click', pauseWebsiteExtraction);
    elements.areaSearchBtn.addEventListener('click', openAreaSearch);
    if (elements.goToExtractBtn) {
        elements.goToExtractBtn.addEventListener('click', () => switchPhase(2));
    }

    // Phase 2: Extract
    elements.emailBtn.addEventListener('click', startEmailScraping);
    elements.stopEmailBtn.addEventListener('click', stopEmailScraping);
    if (elements.goToExportBtn) {
        elements.goToExportBtn.addEventListener('click', () => switchPhase(3));
    }
    // P3-002 FIX: Retry failed button
    if (elements.retryFailedBtn) {
        elements.retryFailedBtn.addEventListener('click', retryFailedBusinesses);
    }
    // Live Stats Board toggle
    if (elements.liveStatsToggle) {
        elements.liveStatsToggle.addEventListener('click', toggleLiveStatsBoard);
    }
    // Note: failedStatCard click is handled by failed-modal.js

    // Phase 3: Export
    elements.exportCsvBtn.addEventListener('click', exportCSV);
    elements.exportMdBtn.addEventListener('click', exportMD);
    // Note: viewFailedBtn click is handled by failed-modal.js
    elements.resetBtn.addEventListener('click', confirmReset);

    // FIX: Global reset button in header (accessible from all phases)
    if (elements.globalResetBtn) {
        elements.globalResetBtn.addEventListener('click', confirmReset);
    }

    // Activity
    elements.toggleActivityBtn.addEventListener('click', toggleActivity);

    // Storage - handled by storage-modal.js
    // elements.storageDetailsBtn handled by storage-modal.js

    // Settings
    elements.settingsBtn.addEventListener('click', openSettings);
    elements.closeSettingsBtn.addEventListener('click', closeSettings);
    elements.cancelSettingsBtn.addEventListener('click', closeSettings);
    elements.saveSettingsBtn.addEventListener('click', saveSettings);

    // IO7: URL Import handlers
    setupImportHandlers();

    // Tab switching in settings
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
}

// ============================================
// PHASE MANAGEMENT
// ============================================
function switchPhase(phase) {
    state.currentPhase = phase;

    // Update phase navigation
    elements.phaseItems.forEach((item, i) => {
        const itemPhase = parseInt(item.dataset.phase);
        item.classList.remove('active', 'completed');

        if (itemPhase === phase) {
            item.classList.add('active');
        } else if (itemPhase < phase) {
            item.classList.add('completed');
        }
    });

    // Update phase lines
    elements.phaseLines.forEach((line, i) => {
        line.classList.toggle('active', i < phase - 1);
    });

    // Update phase content
    elements.phaseContents.forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`phase${phase}Content`).classList.add('active');

    // Phase-specific actions
    if (phase === 3) {
        updateQualityGauge();
        updateExportPreview();
    }
}

function getMaxAvailablePhase() {
    if (state.stats.total === 0) return 1;
    return 3; // All phases available once we have data
}

// ============================================
// MONITORING (Phase 1) - Sends to CONTENT SCRIPT
// ============================================
async function startScraping() {
    try {
        // Get active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab) {
            showToast('No active tab found', 'error');
            return;
        }

        if (!tab.url?.includes('google.com/maps')) {
            showToast('Please open Google Maps first', 'error');
            return;
        }

        state.currentTabId = tab.id;
        console.log('[GhostMap] Starting scraping on tab:', tab.id);

        // Send message to CONTENT SCRIPT (not background!)
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'start_scraping' });

        if (response && response.status === 'started') {
            state.isMonitoring = true;
            updateMonitoringUI(true);
            showToast('👻 Monitoring started! Scroll to discover businesses', 'success');
            addActivity({ name: 'Monitoring started', status: 'success', detail: 'active' });
        } else if (response && response.status === 'already_running') {
            state.isMonitoring = true;
            updateMonitoringUI(true);
            showToast('Already monitoring', 'info');
        } else {
            showToast('Failed to start monitoring', 'error');
        }

    } catch (error) {
        console.error('[GhostMap] Start failed:', error);
        showToast('Error: Make sure you are on Google Maps', 'error');
    }
}

async function stopScraping() {
    try {
        // UI-7 FIX (2026-05-10): pre-fix this queried `chrome.tabs.query({
        // active: true })` which returned the *currently focused* tab, not
        // the tab where monitoring was started. If the user started on a
        // Maps tab and switched to Gmail before clicking Stop, the message
        // was either sent to the wrong tab (no listener) or skipped entirely
        // by the `tab.url?.includes('google.com/maps')` guard. The local UI
        // flipped to "Stopped" while the original Maps tab kept observing.
        //
        // startScraping() already records `state.currentTabId` (line 441).
        // We now use it as the authoritative target; fall back to active-tab
        // query only if the id was never set (defensive, e.g. SW eviction
        // mid-session and UI re-init without a fresh start).
        let targetTabId = state.currentTabId;
        if (typeof targetTabId !== 'number') {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.url?.includes('google.com/maps')) {
                targetTabId = tab.id;
            }
        }

        if (typeof targetTabId === 'number') {
            try {
                await chrome.tabs.sendMessage(targetTabId, { action: 'stop_scraping' });
            } catch (sendErr) {
                // Tab may have been closed before stop — log and proceed to UI flip.
                console.warn('[GhostMap] stop_scraping send failed (tab closed?):', sendErr?.message);
            }
        }

        state.isMonitoring = false;
        state.currentTabId = null;  // UI-7: clear so a fresh start re-records.
        updateMonitoringUI(false);
        showToast('Monitoring stopped', 'success');
        addActivity({ name: 'Monitoring stopped', status: 'info', detail: 'stopped' });

    } catch (error) {
        console.error('[GhostMap] Stop failed:', error);
        // Still update UI
        state.isMonitoring = false;
        state.currentTabId = null;
        updateMonitoringUI(false);
    }
}

function updateMonitoringUI(isActive) {
    elements.startBtn.disabled = isActive;
    elements.stopBtn.disabled = !isActive;
    elements.statusIndicator.classList.toggle('active', isActive);
    elements.statusText.textContent = isActive ? 'Monitoring' : 'Idle';

    if (isActive) {
        elements.startBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Monitoring...`;
    } else {
        elements.startBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Start Monitoring`;
    }
}

// ============================================
// WEBSITE EXTRACTION (Phase 1) - Sends to BACKGROUND
// ============================================
async function startWebsiteExtraction() {
    try {
        elements.extractWebsitesBtn.disabled = true;
        elements.extractWebsitesBtn.innerHTML = `
            <div class="loading-spinner"></div>
            Extracting...`;

        elements.websiteProgressSection.style.display = 'block';
        elements.websiteProgressBar.parentElement.classList.add('active');

        // ═══════════════════════════════════════════════════════════════════════════
        // C3-003 FIX: State After Await - Move state updates to AFTER response
        // ─────────────────────────────────────────────────────────────────────────────
        // Problem: Previously state was set BEFORE await, causing:
        // - UI shows "Extracting" but backend didn't start
        // - State is desynced if message fails
        // 
        // Solution: Only set extraction state after we confirm the backend started
        // UI elements (button, pause) are set optimistically for responsiveness,
        // but core state (isExtractingWebsites) is set after confirmation.
        // ═══════════════════════════════════════════════════════════════════════════

        // FIX: Enable pause button optimistically (UX), but defer state change
        elements.pauseWebsiteBtn.disabled = false;
        elements.pauseWebsiteBtn.textContent = 'Pause';

        const response = await sendMessageWithTimeout({ action: 'extract_missing_websites' });

        // C3-003 FIX: Now set state AFTER await confirms backend started
        if (response && response.processed !== undefined) {
            // Set state during active extraction (immediate sync on success)
            state.isExtractingWebsites = true;
            state.isWebsiteExtractionPaused = false;

            // Immediately mark as complete since response contains final results
            state.isExtractingWebsites = false;
            updateWebsiteProgress({
                current: response.processed,
                total: response.processed,
                percent: 100,
                message: `Done! Found ${response.found} websites`
            });

            showToast(`✓ Website extraction complete: ${response.found} found`, 'success');
            addActivity({ name: 'Website extraction', status: 'success', detail: `+${response.found}` });

            // Reset button
            setTimeout(() => {
                elements.extractWebsitesBtn.disabled = false;
                elements.extractWebsitesBtn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="2" y1="12" x2="22" y2="12"/>
                    </svg>
                    Extract Websites`;
                elements.websiteProgressSection.style.display = 'none';
                // FIX: Reset pause button state on completion
                elements.pauseWebsiteBtn.disabled = true;
                elements.pauseWebsiteBtn.textContent = 'Pause';
                state.isWebsiteExtractionPaused = false;
            }, 2000);

            await loadStats();
        } else {
            throw new Error('Invalid response');
        }

    } catch (error) {
        console.error('[GhostMap] Website extraction failed:', error);
        showToast('Website extraction failed', 'error');
        elements.extractWebsitesBtn.disabled = false;
        elements.extractWebsitesBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
            </svg>
            Extract Websites`;
    }
}

async function pauseWebsiteExtraction() {
    try {
        if (!state.isWebsiteExtractionPaused) {
            // PAUSE
            const response = await sendMessageWithTimeout({ action: 'pause_website_extraction' });
            if (response?.status === 'paused') {
                state.isWebsiteExtractionPaused = true;
                elements.pauseWebsiteBtn.textContent = 'Resume';
                showToast('⏸ Website extraction paused', 'info');
            } else {
                showToast('Could not pause extraction', 'warning');
            }
        } else {
            // RESUME
            const response = await sendMessageWithTimeout({ action: 'resume_website_extraction' });
            if (response?.status === 'resumed') {
                state.isWebsiteExtractionPaused = false;
                elements.pauseWebsiteBtn.textContent = 'Pause';
                showToast('▶ Website extraction resumed', 'success');
            } else {
                showToast('Could not resume extraction', 'warning');
            }
        }
    } catch (error) {
        console.error('[GhostMap] Pause/Resume website extraction failed:', error);
        showToast('Pause/Resume failed: ' + error.message, 'error');
    }
}

function updateWebsiteProgress(progress) {
    state.websiteProgress = progress;
    elements.websiteProgressBar.style.width = `${progress.percent}%`;
    elements.websiteProgressPercent.textContent = `${progress.percent}%`;
    elements.websiteProgressStats.textContent = `${progress.current} / ${progress.total}`;
    elements.websiteProgressMessage.textContent = progress.message || 'Processing...';
}

// ============================================
// EMAIL EXTRACTION (Phase 2) - Sends to BACKGROUND
// ============================================
async function startEmailScraping() {
    try {
        elements.emailBtn.disabled = true;
        elements.emailBtn.innerHTML = `
            <div class="loading-spinner"></div>
            Starting...`;

        elements.emailShimmer.parentElement.classList.add('active');

        const response = await sendMessageWithTimeout({ action: 'start_email_scraping' });

        // FIX: Handle no_targets response explicitly
        if (response?.status === 'no_targets') {
            showToast('📭 No websites found to scrape. Run "Extract Websites" first.', 'warning');
            addActivity({ name: 'Email extraction', status: 'warning', detail: 'no websites' });
            // Reset button state
            elements.emailBtn.disabled = false;
            elements.emailBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Start Extraction`;
            elements.emailShimmer.parentElement.classList.remove('active');
            return;
        }

        if (response && (response.status === 'started' || response.status === 'already_running')) {
            state.isExtractingEmails = true;
            updateEmailExtractionUI(true);
            showToast('📧 Email extraction started', 'success');
            addActivity({ name: 'Email extraction', status: 'success', detail: 'started' });

            // If already running, try to resume
            if (response.status === 'already_running') {
                await sendMessageWithTimeout({ action: 'resume_email_scraping' });
            }
        } else {
            throw new Error(response?.error || 'Failed to start');
        }

    } catch (error) {
        console.error('[GhostMap] Email extraction failed:', error);
        showToast('Failed to start email extraction', 'error');
        elements.emailBtn.disabled = false;
        elements.emailBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Start Extraction`;
        elements.emailShimmer.parentElement.classList.remove('active');
    }
}

async function stopEmailScraping() {
    try {
        await sendMessageWithTimeout({ action: 'stop_email_scraping' });
        state.isExtractingEmails = false;
        updateEmailExtractionUI(false);
        showToast('Email extraction paused', 'success');
    } catch (error) {
        console.error('[GhostMap] Stop email scraping failed:', error);
    }
}

// P3-002 FIX: Retry failed businesses
async function retryFailedBusinesses() {
    try {
        elements.retryFailedBtn.disabled = true;
        elements.retryFailedBtn.innerHTML = `
            <div class="loading-spinner"></div>
            Retrying...`;

        const response = await sendMessageWithTimeout({ action: 'retry_failed_businesses' });

        if (response?.success) {
            state.isExtractingEmails = true;
            updateEmailExtractionUI(true);
            elements.retrySection.style.display = 'none';
            showToast(`Retrying ${response.count || 'failed'} businesses`, 'info');
        } else if (response?.noFailed) {
            showToast('No failed businesses to retry', 'warning');
        } else {
            showToast(response?.error || 'Retry failed', 'error');
        }
    } catch (error) {
        console.error('[GhostMap] Retry failed:', error);
        showToast('Retry failed', 'error');
    } finally {
        if (elements.retryFailedBtn) {
            elements.retryFailedBtn.disabled = false;
            elements.retryFailedBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="1 4 1 10 7 10"></polyline>
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                </svg>
                Retry Failed (<span id="retryCount">${state.stats.failed || 0}</span>)`;
        }
    }
}

function updateEmailExtractionUI(isActive) {
    elements.emailBtn.disabled = isActive;
    elements.stopEmailBtn.disabled = !isActive;
    elements.emailProgressLabel.textContent = isActive ? 'Extracting emails...' : 'Ready to extract';
    elements.statusIndicator.classList.toggle('active', isActive || state.isMonitoring);
    elements.statusText.textContent = isActive ? 'Extracting' : (state.isMonitoring ? 'Monitoring' : 'Idle');

    if (isActive) {
        elements.emailShimmer.parentElement.classList.add('active');
        elements.emailBtn.innerHTML = `
            <div class="loading-spinner"></div>
            Extracting...`;
    } else {
        elements.emailShimmer.parentElement.classList.remove('active');
        elements.emailBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Start Extraction`;
    }
}

function updateEmailProgress(progress) {
    state.emailProgress = progress;
    elements.emailProgressBar.style.width = `${progress.percent}%`;
    elements.emailProgressPercent.textContent = `${Math.round(progress.percent)}%`;
    elements.emailProgressStats.textContent = `${progress.current} / ${progress.total}`;

    if (progress.eta) {
        elements.emailProgressETA.textContent = `~${progress.eta} remaining`;
    } else if (progress.percent >= 100) {
        elements.emailProgressETA.textContent = 'Complete!';
    }

    if (progress.currentItem) {
        elements.emailCurrentItem.style.display = 'flex';
        elements.emailCurrentText.textContent = progress.currentItem;
    }

    // FIX: Detect completion and reset UI when at 100%
    // If progress is 100% and current equals total, trigger completion
    if (progress.percent >= 100 && progress.current >= progress.total && state.isExtractingEmails) {
        // Use a small delay to allow final messages to process
        setTimeout(() => {
            if (state.isExtractingEmails && state.emailProgress?.percent >= 100) {
                state.isExtractingEmails = false;
                updateEmailExtractionUI(false);
                elements.emailProgressLabel.textContent = 'Extraction complete!';
                if (elements.exportTransition) {
                    elements.exportTransition.style.display = 'block';
                }
            }
        }, 1500); // 1.5 second delay for final processing
    }

    // Show export transition when complete
    if (progress.percent >= 100) {
        if (elements.exportTransition) {
            elements.exportTransition.style.display = 'block';
        }
    }
}

// ============================================
// AREA SEARCH
// ============================================
function openAreaSearch() {
    const modal = document.getElementById('areaSearchModal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

// ============================================
// STATS & DATA
// ============================================
async function loadStats() {
    try {
        // B9-2 FIX (2026-05-10): wrap with sendMessageWithTimeout so a
        // hung SW can't freeze the sidepanel UI for Chrome's internal
        // 5min default. Without this, "loading stats" spinner would
        // persist indefinitely if SW is in eviction recovery loop.
        const [stats, queueStatus] = await Promise.all([
            sendMessageWithTimeout({ action: 'get_stats' }),
            sendMessageWithTimeout({ action: 'get_queue_status' })
        ]);

        if (stats) {
            updateStats(stats, queueStatus);
        }
    } catch (error) {
        console.error('[GhostMap] Failed to load stats:', error);
    }
}

// BLOCK-7 FIX (MED-017): Debounced updateStats to prevent rapid UI updates
let updateStatsTimeout = null;
function updateStats(stats, queueStatus = null) {
    // Debounce: cancel previous pending update
    if (updateStatsTimeout) clearTimeout(updateStatsTimeout);

    // Schedule update with 100ms debounce
    updateStatsTimeout = setTimeout(() => updateStatsDebounced(stats, queueStatus), 100);
}

function updateStatsDebounced(stats, queueStatus = null) {
    // Update state
    state.stats = {
        total: stats.total || 0,
        withEmail: stats.withEmail || 0,
        withWebsite: stats.withWebsite || 0,
        withPhone: stats.withPhone || 0,
        queue: queueStatus?.pending || stats.emailQueue || stats.queue || 0,
        failed: stats.failed || queueStatus?.failed || 0,
        successRate: stats.successRatePercent || stats.successRate || 0,
        avgTime: stats.avgScrapingTimeSeconds || stats.avgTime || null
    };

    // Animate hero number if changed
    if (state.stats.total !== state.previousTotal) {
        animateCounter(elements.heroNumber, state.previousTotal, state.stats.total);

        // Pulse effect
        elements.heroCard.classList.add('updating');
        setTimeout(() => elements.heroCard.classList.remove('updating'), 600);

        // v9.5: Trigger sparkle effect on new discovery
        const sparkleContainer = document.getElementById('heroSparkles');
        if (sparkleContainer && window.GhostMapAnimations?.createSparkles) {
            window.GhostMapAnimations.createSparkles(sparkleContainer, 8);
        }

        // v9.5: Highlight substats on change
        const emailSubstat = document.getElementById('emailSubstat');
        const websiteSubstat = document.getElementById('websiteSubstat');
        const phoneSubstat = document.getElementById('phoneSubstat');
        if (emailSubstat && state.stats.withEmail > 0) {
            emailSubstat.classList.add('highlight');
            setTimeout(() => emailSubstat.classList.remove('highlight'), 1000);
        }
        if (websiteSubstat && state.stats.withWebsite > 0) {
            websiteSubstat.classList.add('highlight');
            setTimeout(() => websiteSubstat.classList.remove('highlight'), 1000);
        }
        if (phoneSubstat && state.stats.withPhone > 0) {
            phoneSubstat.classList.add('highlight');
            setTimeout(() => phoneSubstat.classList.remove('highlight'), 1000);
        }

        // Milestone celebration
        checkMilestone(state.stats.total);

        state.previousTotal = state.stats.total;
    }

    // v9.5: Update monitoring glow state
    if (state.isMonitoring) {
        elements.heroCard.classList.add('monitoring');
    } else {
        elements.heroCard.classList.remove('monitoring');
    }

    // Update other displays
    elements.emailCount.textContent = state.stats.withEmail;
    elements.websiteCount.textContent = state.stats.withWebsite;
    if (elements.phoneCount) elements.phoneCount.textContent = state.stats.withPhone;

    // Phase counts
    elements.phaseCounts[1].textContent = state.stats.total;
    elements.phaseCounts[2].textContent = state.stats.withEmail > 0
        ? `${state.stats.withEmail}/${state.stats.total}`
        : '—';
    elements.phaseCounts[3].textContent = state.stats.total > 0 ? 'Ready' : '—';

    // Queue count & transition CTA
    elements.queueCount.textContent = state.stats.queue;
    elements.extractTransition.style.display = state.stats.queue > 0 ? 'block' : 'none';

    // Phase 2 stats
    elements.successRate.textContent = `${state.stats.successRate}%`;
    elements.avgTime.textContent = state.stats.avgTime ? `${state.stats.avgTime.toFixed(1)}s` : '—';
    elements.failedCount.textContent = state.stats.failed;

    // Failed badge
    if (state.stats.failed > 0) {
        elements.failedBadge.style.display = 'inline';
        elements.failedBadge.textContent = state.stats.failed;
        // P3-002 FIX: Show retry button when there are failed items
        if (elements.retrySection) {
            elements.retrySection.style.display = 'block';
            if (elements.retryCount) {
                elements.retryCount.textContent = state.stats.failed;
            }
        }
    } else {
        elements.failedBadge.style.display = 'none';
        // P3-002 FIX: Hide retry button when no failed items
        if (elements.retrySection) {
            elements.retrySection.style.display = 'none';
        }
    }

    // Missing website badge
    // UI-10 FIX (2026-05-10): pre-fix used `||` which falls through on truthful zero —
    // when stats.withoutWebsite === 0 (no missing websites, all enriched) the code
    // computed `total - withWebsite`, which can be negative if state.stats is stale
    // mid-update. Now: `??` preserves a legitimate 0; `Math.max(0, ...)` zero-floors
    // any stale-stats negative result. Badge always shows a non-negative integer.
    const missingWebsites = Math.max(
        0,
        stats.withoutWebsite ?? (state.stats.total - state.stats.withWebsite),
    );
    if (missingWebsites > 0) {
        elements.missingWebsiteBadge.style.display = 'inline';
        elements.missingWebsiteBadge.textContent = missingWebsites;
    } else {
        elements.missingWebsiteBadge.style.display = 'none';
    }

    // Storage
    if (stats.storageSizeMB !== undefined) {
        const used = stats.storageSizeMB || 0;
        const quota = stats.storageQuotaMB || 100;
        const percent = Math.round((used / quota) * 100);
        elements.storageText.textContent = `${used.toFixed(1)} MB / ${quota.toFixed(0)} MB`;
        elements.storageFill.style.width = `${percent}%`;
    }

    // Update export preview if on phase 3
    if (state.currentPhase === 3) {
        updateExportPreview();
    }

    // v9.5: Show contextual smart tips
    showContextualTip();
}

/**
 * v9.5: Show contextual smart tips based on current state
 */
function showContextualTip() {
    if (!window.GhostMapAnimations?.smartTips) return;
    const tips = window.GhostMapAnimations.smartTips;

    // Tip 1: First 10 businesses discovered
    if (state.stats.total === 10 && state.previousTotal < 10) {
        tips.show('first_10', 'Tip: Let it run while you browse other tabs', { icon: '💡' });
        return;
    }

    // Tip 2: Ready for email extraction
    if (state.stats.withWebsite >= 5 && state.stats.withEmail === 0 && !state.isExtractingEmails) {
        tips.show('ready_extract', 'You have websites ready! Click "Start Extraction" to find emails.', { icon: '📧' });
        return;
    }

    // Tip 3: High failure rate
    if (state.stats.failed > 10 && state.stats.successRate < 50) {
        tips.show('high_failure', 'High failure rate detected. Try reducing concurrent requests in settings.', { icon: '⚠️' });
        return;
    }

    // Tip 4: Ready to export
    if (state.stats.withEmail >= 10 && state.currentPhase === 2) {
        tips.show('ready_export', 'Pro tip: Switch to Export phase to download your leads!', { icon: '📊' });
        return;
    }
}

function animateCounter(element, from, to) {
    const duration = 500;
    const start = performance.now();

    const update = (now) => {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
        element.textContent = Math.round(from + (to - from) * eased);

        if (progress < 1) {
            requestAnimationFrame(update);
        }
    };

    requestAnimationFrame(update);
}

/**
 * v9.5 Enhanced: Milestone celebration with confetti
 */
function checkMilestone(count) {
    const milestones = [10, 25, 50, 100, 250, 500, 1000];
    if (milestones.includes(count)) {
        showToast(`🎉 Milestone: ${count} businesses!`, 'success');

        // v9.5: Trigger confetti celebration
        if (window.GhostMapAnimations?.confetti) {
            window.GhostMapAnimations.confetti({
                particleCount: count >= 100 ? 80 : 50,
                spread: 70,
                colors: ['#6366f1', '#10b981', '#f59e0b', '#a855f7', '#ec4899']
            });
        }
    }
}

// ============================================
// QUALITY GAUGE (Phase 3)
// ============================================
function updateQualityGauge() {
    // Calculate quality score based on data completeness
    const total = state.stats.total || 1;
    const emailScore = (state.stats.withEmail / total) * 40;
    const websiteScore = (state.stats.withWebsite / total) * 30;
    const phoneScore = (state.stats.withPhone / total) * 30;
    const quality = Math.round(emailScore + websiteScore + phoneScore);

    // Animate the arc
    const circumference = 2 * Math.PI * 40; // r=40
    const dashArray = (quality / 100) * circumference;
    elements.qualityArc.style.strokeDasharray = `${dashArray} ${circumference}`;

    // Update value
    elements.qualityValue.textContent = `${quality}%`;

    // Update label
    let label = 'Data Quality';
    if (quality >= 80) label = 'Excellent Quality';
    else if (quality >= 60) label = 'Good Quality';
    else if (quality >= 40) label = 'Fair Quality';
    else label = 'Needs Improvement';
    elements.qualityLabel.textContent = label;
    elements.qualityLabel.style.color = quality >= 60 ? 'var(--success-400)' : 'var(--warning-400)';
}

function updateExportPreview() {
    elements.previewTotal.textContent = state.stats.total;
    elements.previewEmails.textContent = state.stats.withEmail;
    elements.previewWebsites.textContent = state.stats.withWebsite;
    elements.previewPhones.textContent = state.stats.withPhone;
}

// ============================================
// EXPORT
// ============================================
async function exportCSV() {
    showLoading('Exporting CSV...');
    try {
        const response = await sendMessageWithTimeout({ action: 'export_data' });
        if (response?.status === 'success') {
            // Trigger download
            if (response.csv) {
                downloadFile(response.csv, `ghost_map_export_${Date.now()}.csv`, 'text/csv');
            }
            showToast(`📤 Exported ${response.count || state.stats.total} records`, 'success');
        } else {
            throw new Error(response?.error || 'Export failed');
        }
    } catch (error) {
        console.error('[GhostMap] Export failed:', error);
        showToast('Export failed: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

async function exportMD() {
    showLoading('Exporting Markdown...');
    try {
        const response = await sendMessageWithTimeout({ action: 'export_emails_markdown' });
        if (response?.status === 'success') {
            if (response.markdown) {
                downloadFile(response.markdown, `ghost_map_emails_${Date.now()}.md`, 'text/markdown');
            }
            showToast(`📄 Exported ${response.count || 0} emails`, 'success');
        } else if (response?.status === 'no_emails') {
            showToast('No emails to export', 'info');
        } else {
            throw new Error(response?.error || 'Export failed');
        }
    } catch (error) {
        console.error('[GhostMap] MD Export failed:', error);
        showToast('Export failed: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType + ';charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// ============================================
// RESET
// ============================================
function confirmReset() {
    if (confirm('⚠️ This will delete ALL collected data. Are you sure?')) {
        resetAll();
    }
}

async function resetAll() {
    showLoading('Resetting all data...');
    try {
        await sendMessageWithTimeout({ action: 'factory_reset' });

        // Reset state
        state.stats = { total: 0, withEmail: 0, withWebsite: 0, withPhone: 0, queue: 0, failed: 0, successRate: 0, avgTime: null };
        state.previousTotal = 0;
        state.activities = [];
        state.isExtractingEmails = false;
        state.emailProgress = { current: 0, total: 0, percent: 0 };

        // FIX: Reset website extraction state (M7-MISS7)
        state.isExtractingWebsites = false;
        state.isWebsiteExtractionPaused = false;
        state.websiteProgress = { current: 0, total: 0, percent: 0 };

        // Update UI
        elements.heroNumber.textContent = '0';
        elements.emailCount.textContent = '0';
        elements.websiteCount.textContent = '0';
        if (elements.phoneCount) elements.phoneCount.textContent = '0';

        // FIX: Reset email progress bar UI to 0%
        elements.emailProgressBar.style.width = '0%';
        elements.emailProgressPercent.textContent = '0%';
        elements.emailProgressStats.textContent = '0 / 0';
        elements.emailProgressETA.textContent = 'Ready to extract';
        elements.emailProgressLabel.textContent = 'Ready to extract';
        elements.emailCurrentItem.style.display = 'none';
        updateEmailExtractionUI(false);

        // FIX: Reset website progress bar UI (M7-MISS7)
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

        // FIX: Clear website badge (M7-MISS7)
        if (elements.missingWebsiteBadge) {
            elements.missingWebsiteBadge.style.display = 'none';
            elements.missingWebsiteBadge.textContent = '0';
        }

        // Hide export transition
        if (elements.exportTransition) {
            elements.exportTransition.style.display = 'none';
        }

        // Switch to phase 1
        switchPhase(1);

        // Clear activities
        renderActivities();

        showToast('All data has been reset', 'success');
    } catch (error) {
        console.error('[GhostMap] Reset failed:', error);
        showToast('Reset failed', 'error');
    } finally {
        hideLoading();
    }
}

// ============================================
// ACTIVITY FEED
// ============================================
function addActivity(activity) {
    state.activities.unshift({
        id: Date.now(),
        ...activity,
        time: 'now'
    });

    // P3-006 FIX: Use configured MAX_ACTIVITIES constant to prevent memory growth
    if (state.activities.length > state.MAX_ACTIVITIES) {
        state.activities = state.activities.slice(0, state.MAX_ACTIVITIES);
    }

    renderActivities();
}

function renderActivities() {
    if (state.activities.length === 0) {
        elements.activityEmpty.style.display = 'flex';
        return;
    }

    elements.activityEmpty.style.display = 'none';

    const maxItems = state.activityExpanded ? 20 : 5;
    const items = state.activities.slice(0, maxItems);

    elements.activityList.innerHTML = items.map(a => `
        <div class="activity-item">
            <span class="activity-status ${a.status}">${getStatusIcon(a.status)}</span>
            <span class="activity-name">${escapeHtml(a.name)}</span>
            <span class="activity-detail ${a.status}">${escapeHtml(a.detail)}</span>
            <span class="activity-time">${a.time}</span>
        </div>
    `).join('');
}

function getStatusIcon(status) {
    switch (status) {
        case 'success': return '✓';
        case 'warning': return '⚠';
        case 'error': return '✕';
        default: return '○';
    }
}

function toggleActivity() {
    state.activityExpanded = !state.activityExpanded;
    elements.activityList.classList.toggle('expanded', state.activityExpanded);
    elements.toggleActivityBtn.textContent = state.activityExpanded ? 'Show Less' : 'See All';
    renderActivities();
}

// ============================================
// LIVE STATS BOARD
// ============================================
let liveStatsInterval = null;

function toggleLiveStatsBoard() {
    if (!elements.liveStatsBoard || !elements.liveStatsToggle) return;

    const isVisible = elements.liveStatsBoard.style.display !== 'none';

    if (isVisible) {
        // Hide the board
        elements.liveStatsBoard.style.display = 'none';
        elements.liveStatsToggle.classList.remove('active');
        // Stop fetching stats
        if (liveStatsInterval) {
            clearInterval(liveStatsInterval);
            liveStatsInterval = null;
        }
    } else {
        // Show the board
        elements.liveStatsBoard.style.display = 'block';
        elements.liveStatsToggle.classList.add('active');
        // Start fetching stats immediately and periodically
        updateLiveStats();
        liveStatsInterval = setInterval(updateLiveStats, 2000);
    }
}

async function updateLiveStats() {
    try {
        const stats = await sendMessageWithTimeout({ action: 'get_live_stats' });

        if (stats && !stats.error) {
            // Update all the live stats elements
            if (elements.liveRuntime) {
                elements.liveRuntime.textContent = stats.runtimeFormatted || '0s';
            }
            if (elements.liveReqFinished) {
                elements.liveReqFinished.textContent = stats.requestsFinished || 0;
            }
            if (elements.liveReqTotal) {
                elements.liveReqTotal.textContent = stats.requestsTotal || 0;
            }
            if (elements.liveRetried) {
                elements.liveRetried.textContent = stats.requestsRetried || 0;
            }
            if (elements.liveEmails) {
                elements.liveEmails.textContent = stats.emailsFound || 0;
            }
            if (elements.liveEmailsRate) {
                elements.liveEmailsRate.textContent = `${stats.emailsPerMinute || '0'}/min`;
            }
            if (elements.liveSpeed) {
                elements.liveSpeed.textContent = `${stats.requestsPerSecond || '0'} req/s`;
            }
            if (elements.liveDownloaded) {
                elements.liveDownloaded.textContent = stats.bytesDownloadedFormatted || '0 B';
            }
            if (elements.liveCFBlocks) {
                elements.liveCFBlocks.textContent = stats.cloudflareBlocks || 0;
            }
            if (elements.liveRateLimits) {
                elements.liveRateLimits.textContent = stats.rateLimitHits || 0;
            }
            if (elements.liveTimeouts) {
                elements.liveTimeouts.textContent = stats.timeouts || 0;
            }
            if (elements.liveSessionsRetired) {
                elements.liveSessionsRetired.textContent = stats.sessionsRetired || 0;
            }
            if (elements.liveSessionsCreated) {
                elements.liveSessionsCreated.textContent = stats.sessionsCreated || 0;
            }
            if (elements.liveMemory) {
                elements.liveMemory.textContent = `${stats.peakMemoryMB || '0'} MB`;
            }
        }

        // Fetch AutoScaler stats
        const asResponse = await sendMessageWithTimeout({ action: 'get_autoscaler_stats' });
        if (asResponse && asResponse.autoscaler) {
            const as = asResponse.autoscaler;
            if (elements.liveConcurrency) {
                elements.liveConcurrency.textContent = `${as.currentConcurrency || as.desiredConcurrency || 0}/${as.maxConcurrency || 8}`;
            }
            if (elements.liveSuccessRate) {
                const rate = as.successRate !== undefined ? (as.successRate * 100).toFixed(0) : '—';
                elements.liveSuccessRate.textContent = `${rate}%`;
            }
            if (elements.liveScaleUps) {
                elements.liveScaleUps.textContent = as.scaleUpCount || 0;
            }
            if (elements.liveScaleDowns) {
                elements.liveScaleDowns.textContent = as.scaleDownCount || 0;
            }
        }
    } catch (error) {
        console.warn('[GhostMap] Failed to fetch live stats:', error);
    }
}

// Stop the live stats polling interval
function stopLiveStatsPolling() {
    if (liveStatsInterval) {
        clearInterval(liveStatsInterval);
        liveStatsInterval = null;
    }
    // Also collapse the board
    if (elements.liveStatsBoard) {
        elements.liveStatsBoard.style.display = 'none';
    }
    if (elements.liveStatsToggle) {
        elements.liveStatsToggle.classList.remove('active');
    }
}

// ============================================
// SETTINGS MODAL
// ============================================
function openSettings() {
    elements.settingsModal.style.display = 'flex';
}

function closeSettings() {
    elements.settingsModal.style.display = 'none';
}

async function loadSettings() {
    try {
        const result = await chrome.storage.local.get(['ghostMapSettings', 'userConfig', 'ghostmap_feature_flags']);

        // SYNC FIX: Defaults now match lib/config.js exactly
        // CONFIG.rateLimits.emailScraping = { maxConcurrent: 5, timeout: 30000, meanDelayMs: 1200 }
        // rateLimit = 60000 / meanDelayMs ≈ 50 (but UI had 12 as safe default)
        const CONFIG_DEFAULTS = {
            rateLimit: 12,       // UI safe default (requests per minute)
            maxConcurrent: 5,    // Matches CONFIG.rateLimits.emailScraping.maxConcurrent
            timeout: 30          // Matches CONFIG.rateLimits.emailScraping.timeout / 1000
        };

        // Load General tab settings - use CONFIG_DEFAULTS as fallbacks
        if (result.ghostMapSettings) {
            elements.settingRateLimit.value = result.ghostMapSettings.rateLimit || CONFIG_DEFAULTS.rateLimit;
            elements.settingMaxConcurrent.value = result.ghostMapSettings.maxConcurrent || CONFIG_DEFAULTS.maxConcurrent;
            elements.settingTimeout.value = result.ghostMapSettings.timeout || CONFIG_DEFAULTS.timeout;
        } else {
            // No saved settings - apply CONFIG defaults to UI
            elements.settingRateLimit.value = CONFIG_DEFAULTS.rateLimit;
            elements.settingMaxConcurrent.value = CONFIG_DEFAULTS.maxConcurrent;
            elements.settingTimeout.value = CONFIG_DEFAULTS.timeout;
        }

        // FIX: Load Selectors tab settings
        if (result.userConfig && result.userConfig.selectors) {
            const sel = result.userConfig.selectors;
            if (elements.selTitle && sel.title) elements.selTitle.value = sel.title;
            if (elements.selPhone && sel.phone) elements.selPhone.value = sel.phone;
            if (elements.selWebsite && sel.website) elements.selWebsite.value = sel.website;
            if (elements.selAddress && sel.address) elements.selAddress.value = sel.address;
        }

    } catch (error) {
        console.error('[GhostMap] Failed to load settings:', error);
    }
}

async function saveSettings() {
    try {
        // General settings
        const settings = {
            rateLimit: parseInt(elements.settingRateLimit.value),
            maxConcurrent: parseInt(elements.settingMaxConcurrent.value),
            timeout: parseInt(elements.settingTimeout.value)
        };

        // FIX: Collect selector overrides (userConfig format for config.js loadConfig)
        const selectors = {};
        if (elements.selTitle && elements.selTitle.value.trim()) {
            selectors.title = elements.selTitle.value.trim();
        }
        if (elements.selPhone && elements.selPhone.value.trim()) {
            selectors.phone = elements.selPhone.value.trim();
        }
        if (elements.selWebsite && elements.selWebsite.value.trim()) {
            selectors.website = elements.selWebsite.value.trim();
        }
        if (elements.selAddress && elements.selAddress.value.trim()) {
            selectors.address = elements.selAddress.value.trim();
        }

        // Save general settings
        await chrome.storage.local.set({ ghostMapSettings: settings });

        // Save selector overrides (if any) to userConfig for config.js
        if (Object.keys(selectors).length > 0) {
            await chrome.storage.local.set({ userConfig: { selectors } });
            console.log('[GhostMap] Selector overrides saved:', selectors);
        }

        // Notify background to apply settings
        await sendMessageWithTimeout({ action: 'update_settings', settings });

        closeSettings();
        showToast('Settings saved', 'success');
    } catch (error) {
        console.error('[GhostMap] Failed to save settings:', error);
        showToast('Failed to save settings', 'error');
    }
}

function switchTab(tabId) {
    elements.tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    elements.tabContents.forEach(content => {
        content.style.display = content.id === `tab-${tabId}` ? 'block' : 'none';
    });
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 200);
    }, 3000);
}

// ============================================
// LOADING
// ============================================
function showLoading(message = 'Processing...') {
    elements.loadingMessage.textContent = message;
    elements.loadingOverlay.style.display = 'flex';
}

function hideLoading() {
    elements.loadingOverlay.style.display = 'none';
}

// ============================================
// BACKGROUND MESSAGES
// ============================================
function handleBackgroundMessage(message, sender, sendResponse) {
    // FIX: Ignore messages targeted at offscreen document
    // These should NOT be intercepted by the sidepanel
    if (message.target === 'offscreen') {
        return false; // Don't handle, let offscreen document respond
    }

    // 2026-05-15: filter out the high-frequency `log_message` echo. The
    // SW originals are already visible in the dev-log-server output, so
    // logging "Received message: log_message" hundreds of times per
    // scrape is pure noise that overwhelmed the streaming Monitor.
    // Keep the trace for everything else (business_found, queue_progress,
    // scraping_progress, errors etc.) — those signal real state changes.
    const _msgKey = message.type || message.action;
    if (_msgKey !== 'log_message') {
        console.log('[GhostMap] Received message:', _msgKey);
    }

    // Track if we actually handle this message
    let handled = false;

    switch (message.type || message.action) {

        // FIX: Add handler for live log messages from background
        case 'log_message':
            const logPayload = message.payload;
            if (logPayload && logPayload.message) {
                // Filter to only show important messages in Activity Feed
                const msg = logPayload.message;
                const level = logPayload.level;

                // Show all errors and warnings
                if (level === 'error' || level === 'warn') {
                    addActivity({
                        name: msg.substring(0, 100),
                        status: level === 'error' ? 'error' : 'warning',
                        detail: level
                    });
                }
                // Show key info messages (EMAIL FOUND, COMPLETE, SAVE, etc.)
                else if (level === 'info' && (
                    msg.includes('EMAIL FOUND') ||
                    msg.includes('[COMPLETE]') ||
                    msg.includes('[SAVE]') ||
                    msg.includes('[BUSINESS]') ||
                    msg.includes('TAB FALLBACK') ||
                    msg.includes('[SUCCESS]')
                )) {
                    // Extract business name or email for cleaner display
                    let activityName = msg;
                    let detail = 'info';

                    if (msg.includes('EMAIL FOUND')) {
                        const emailMatch = msg.match(/email\(s\):\s*([^\s]+)/i);
                        activityName = emailMatch ? `📧 ${emailMatch[1]}` : '📧 Email found';
                        detail = '+email';
                    } else if (msg.includes('[COMPLETE]')) {
                        const bizMatch = msg.match(/Finished processing "([^"]+)"/);
                        activityName = bizMatch ? bizMatch[1] : 'Processing complete';
                        const emailsMatch = msg.match(/Emails found:\s*(\d+)/);
                        detail = emailsMatch ? `${emailsMatch[1]} email(s)` : 'done';
                    } else if (msg.includes('[SAVE]')) {
                        const countMatch = msg.match(/Saved (\d+) email/);
                        activityName = countMatch ? `Saved ${countMatch[1]} email(s)` : 'Data saved';
                        detail = '+saved';
                    } else if (msg.includes('[BUSINESS]')) {
                        const bizMatch = msg.match(/Processing:\s*"([^"]+)"/);
                        activityName = bizMatch ? bizMatch[1] : 'Processing business';
                        detail = 'scraping';
                    }

                    addActivity({
                        name: activityName.substring(0, 80),
                        status: 'success',
                        detail: detail
                    });
                }
            }
            break;

        case 'newBusiness':
        case 'business_found':

            addActivity({
                name: message.business?.title || message.data?.title || 'New business',
                status: message.business?.website || message.data?.website ? 'success' : 'warning',
                detail: message.business?.website || message.data?.website ? '+website' : 'no website'
            });
            loadStats();
            break;

        case 'emailFound':
        case 'email_found':
            addActivity({
                name: message.email || message.business?.email || 'Email found',
                status: 'success',
                detail: '+email'
            });
            loadStats();
            break;

        case 'emailScrapeProgress':
        case 'email_scrape_progress':
        case 'scraping_progress':  // FIX: This is what background actually sends
            // Handle both flat and nested payload formats
            const progressData = message.payload || message;
            const current = progressData.current || 0;
            const total = progressData.total || 0;
            const percent = total > 0 ? Math.round((current / total) * 100) : 0;

            updateEmailProgress({
                current: current,
                total: total,
                percent: percent,
                eta: progressData.eta || message.eta,
                currentItem: progressData.currentItem || message.currentUrl || message.url
            });
            break;

        // UX-1 FIX (2026-05-15): Phase-2 heartbeat — emitted every 2s by the SW
        // while a batch is active. Keeps the progress bar moving even when no
        // email_found / job_complete events fire (slow CMSs, circuit-breaker
        // pause, tab-fallback cascade). Surfaces circuit-open state so the user
        // sees "⚠️ Pausa: troppi siti falliscono" instead of a silent freeze.
        case 'phase2_heartbeat': {
            const hb = message.payload || {};
            const hbTotal = hb.total || 0;
            const hbProcessed = hb.processed || 0;
            const hbPercent = hbTotal > 0 ? Math.round((hbProcessed / hbTotal) * 100) : 0;
            const hbCurrentItem = hb.activeNames && hb.activeNames.length > 0
                ? hb.activeNames
                : (hb.circuitOpen
                    ? '⚠️ Pausa: troppi siti falliscono (riprova fra ~60s)'
                    : (hb.isPaused ? '⏸ In pausa' : `${hb.active} attivi, ${hb.pending} in coda`));

            updateEmailProgress({
                current: hbProcessed,
                total: hbTotal,
                percent: hbPercent,
                currentItem: hbCurrentItem
            });

            // Edge-triggered circuit-open warning: toast/activity only on the
            // closed→open transition so the user isn't spammed every 2s.
            const prevCircuitOpen = state._lastCircuitOpen === true;
            const nowCircuitOpen = hb.circuitOpen === true;
            if (nowCircuitOpen && !prevCircuitOpen) {
                showToast('⚠️ Troppi fallimenti consecutivi — pausa di ~60s', 'info');
                addActivity({
                    name: 'Circuit breaker aperto',
                    status: 'info',
                    detail: 'pausa ~60s'
                });
            } else if (!nowCircuitOpen && prevCircuitOpen) {
                addActivity({
                    name: 'Circuit breaker chiuso',
                    status: 'success',
                    detail: 'ripresa scraping'
                });
            }
            state._lastCircuitOpen = nowCircuitOpen;
            break;
        }

        case 'websiteProgress':
        case 'website_progress':
            updateWebsiteProgress({
                current: message.current || 0,
                total: message.total || 0,
                percent: message.percent || 0,
                message: message.message
            });
            break;

        case 'websiteExtractionComplete':
        case 'website_extraction_complete':
            state.isExtractingWebsites = false;
            showToast(`✓ Website extraction complete`, 'success');
            loadStats();
            break;

        case 'scrapingFailed':
        case 'scraping_failed':
            addActivity({
                name: message.url || message.business?.title || 'Unknown',
                status: 'error',
                detail: message.error || 'failed'
            });
            break;

        case 'statsUpdate':
        case 'stats_update':
            updateStats(message.stats || message);
            break;

        // ============================================
        // CRITICAL FIX: 8 Missing Message Handlers
        // These were causing broken progress bars and stuck buttons
        // ============================================

        case 'email_scraping_finished':
            state.isExtractingEmails = false;
            updateEmailExtractionUI(false);
            stopLiveStatsPolling();  // FIX: Stop live stats polling when scraping ends
            const emailPayload = message.payload || message;
            updateEmailProgress({
                current: emailPayload.found || emailPayload.processed || 0,
                total: emailPayload.found || emailPayload.processed || 0,
                percent: 100
            });
            showToast(`✓ Email extraction complete: ${emailPayload.found || 0} emails found`, 'success');
            if (elements.exportTransition) elements.exportTransition.style.display = 'block';
            loadStats();
            break;

        case 'queue_progress':
        case 'queue_ready':
            // Queue status updates - refresh stats
            loadStats();
            break;

        case 'reset_complete':
            showToast('✓ Factory reset complete', 'success');
            loadStats();
            break;

        case 'website_extraction_progress':
            // FIX: Handle nested payload structure
            const wxProgress = message.payload || message;
            const wxTotal = wxProgress.total || 0;
            const wxCurrent = wxProgress.current || 0;
            updateWebsiteProgress({
                current: wxCurrent,
                total: wxTotal,
                percent: wxTotal > 0 ? Math.round((wxCurrent / wxTotal) * 100) : 0,
                message: wxProgress.currentItem || 'Processing...'
            });
            break;

        case 'website_extraction_finished':
            state.isExtractingWebsites = false;
            state.isWebsiteExtractionPaused = false;  // FIX: Reset paused state
            const wxFinished = message.payload || message;
            if (elements.extractWebsitesBtn) {
                elements.extractWebsitesBtn.disabled = false;
                elements.extractWebsitesBtn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="2" y1="12" x2="22" y2="12"/>
                    </svg>
                    Extract Websites`;
            }
            if (elements.websiteProgressSection) {
                elements.websiteProgressSection.style.display = 'none';
            }
            // FIX: Reset pause button state
            elements.pauseWebsiteBtn.disabled = true;
            elements.pauseWebsiteBtn.textContent = 'Pause';
            showToast(`✓ Website extraction complete: ${wxFinished.found || 0} found`, 'success');
            addActivity({ name: 'Website extraction', status: 'success', detail: `+${wxFinished.found || 0}` });
            loadStats();
            break;

        case 'website_extraction_paused':
            showToast('⏸ Website extraction paused', 'info');
            break;

        case 'website_extraction_resumed':
            showToast('▶ Website extraction resumed', 'success');
            break;

        // ─── B12-1 FIX: orphan area_search_warning message handler ──────
        // Pre-fix: SW emitted runtime message but no UI listener was wired.
        // Now mirrored in both area-search-modal (banner) and sidepanel
        // (Activity Feed + toast). Sidepanel version guarantees the signal
        // is captured even if the area-search modal was closed mid-batch.
        case 'area_search_warning': {
            const wp = message.payload || {};
            let warnText;
            if (wp.type === 'high_wake_fail_rate') {
                const pct = Math.round((wp.rate || 0) * 100);
                warnText = `Area search: high wake-fail rate (${pct}%)`;
            } else if (wp.message) {
                warnText = `Area search: ${wp.message}`;
            } else {
                warnText = 'Area search warning';
            }
            showToast(`⚠️ ${warnText}`, 'warning');
            addActivity({ name: warnText, status: 'warning', detail: 'area-search' });
            handled = true;
            break;
        }

        // ─── B12-2 FIX: orphan area_search_captcha_detected message ──────
        // Pre-fix: same as B12-1. CAPTCHA detection during area search left
        // the user with no signal — scrape would silently slow/halt.
        case 'area_search_captcha_detected': {
            const cp = message.payload || {};
            const cdSec = (typeof cp.cooldownMs === 'number') ? Math.round(cp.cooldownMs / 1000) : '?';
            const captchaMsg = `CAPTCHA detected — extension will retry after cooldown (${cdSec}s)`;
            showToast(`🛑 ${captchaMsg}`, 'error');
            addActivity({ name: captchaMsg, status: 'error', detail: 'captcha' });
            handled = true;
            break;
        }

        // ─── B2-4 FIX: detail-fetcher kill-switch UI signal ──────────────
        // Pre-fix: kill-switch was silent; sidepanel showed "scraping in
        // progress" while ALL subsequent enrichment failed. Now: visible
        // toast + Activity Feed entry. Reset event clears with success
        // toast so users know the cooldown ended.
        case 'detail_fetcher_kill_switch': {
            const tripped = !!message.payload?.tripped;
            const fails = message.payload?.consecutiveFails ?? 0;
            if (tripped) {
                const msg = `Detail-fetcher kill switch tripped (${fails} consecutive failures). Maps may be rate-limiting — pausing detail enrichment.`;
                showToast(`🛑 ${msg}`, 'error');
                addActivity({ name: msg, status: 'error', detail: 'detail-fetcher' });
            } else {
                const msg = 'Detail-fetcher kill switch reset — enrichment resumed.';
                showToast(`✓ ${msg}`, 'success');
                addActivity({ name: msg, status: 'success', detail: 'detail-fetcher' });
            }
            handled = true;
            break;
        }
    }

    // UI-6 FIX (2026-05-10): pre-fix this unconditionally called
    // sendResponse({received: true}) and returned true even for messages
    // that did NOT match any case in the switch. Two consequences:
    //
    //   1. Returning true tells Chrome "I will respond ASYNCHRONOUSLY,
    //      keep the message channel open." Other listeners (e.g.
    //      area-search-modal.js's own onMessage at ~line 397) that share
    //      the same broadcast (`area_search_progress`, `stats_update`,
    //      etc.) had their responses suppressed because the sidepanel
    //      had already "claimed" the response slot first.
    //   2. The SW broadcasting the message saw `{received: true}` come
    //      back even when sidepanel did nothing useful with the payload —
    //      a false ACK that broke the SW's "response received" semantics
    //      (which some SW handlers used to track delivery confirmation).
    //
    // Now: only acknowledge handled messages. For unhandled ones return
    // false explicitly so other listeners can take the slot. Tracker
    // `handled` was already in place — pre-fix just ignored it.
    if (handled) {
        sendResponse({ received: true });
        return true;
    }
    return false;
}

// ============================================
// IO7: URL IMPORT HANDLERS
// ============================================

/**
 * Setup URL import event handlers
 * Only runs if import elements exist in DOM
 */
function setupImportHandlers() {
    const btnImportFile = document.getElementById('btnImportFile');
    const importFileInput = document.getElementById('importFileInput');
    const btnConfirmImport = document.getElementById('btnConfirmImport');
    const btnClearImport = document.getElementById('btnClearImport');
    const importPreview = document.getElementById('importPreview');
    const importSection = document.getElementById('importSection');

    // Guard: Skip if elements don't exist
    if (!btnImportFile || !importFileInput) {
        console.log('[IO7] Import elements not found, skipping setup');
        return;
    }

    // Browse button triggers file input
    btnImportFile.addEventListener('click', () => {
        importFileInput.click();
    });

    // File selected - parse and preview
    importFileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const content = await file.text();
            const urls = parseUrlFile(content, file.name);

            if (urls.length === 0) {
                showToast('No valid URLs found in file', 'error');
                return;
            }

            // Store for confirmation
            pendingImportUrls = urls;

            // Show preview
            document.getElementById('importFileName').textContent = file.name;
            document.getElementById('importCountBadge').textContent = `${urls.length} URLs`;
            importPreview.classList.remove('hidden');
            importSection.classList.add('file-selected');

            showToast(`📄 ${urls.length} URLs ready to import`, 'info');

        } catch (error) {
            console.error('[IO7] File parse error:', error);
            showToast('Failed to read file: ' + error.message, 'error');
        }
    });

    // Confirm import - send to background
    btnConfirmImport?.addEventListener('click', async () => {
        if (pendingImportUrls.length === 0) return;

        btnConfirmImport.disabled = true;
        btnConfirmImport.innerHTML = '<div class="loading-spinner"></div>';

        try {
            const response = await sendMessageWithTimeout({
                action: 'import_url_batch',
                payload: { urls: pendingImportUrls }
            });

            if (response?.success) {
                const msg = `Added ${response.saved} businesses`;
                const detail = response.duplicates > 0 ? ` (${response.duplicates} duplicates)` : '';
                showToast(`✅ ${msg}${detail}`, 'success');
                addActivity({
                    name: 'URL Import',
                    status: 'success',
                    detail: `+${response.saved}`
                });

                // Reload stats to reflect new businesses
                await loadStats();
            } else {
                showToast('Import failed: ' + (response?.error || 'Unknown error'), 'error');
            }

        } catch (error) {
            console.error('[IO7] Import failed:', error);
            showToast('Import failed: ' + error.message, 'error');
        } finally {
            // Reset UI
            clearImportState();
        }
    });

    // Clear import
    btnClearImport?.addEventListener('click', () => {
        clearImportState();
    });

    console.log('[IO7] URL Import handlers initialized');
}

/**
 * Parse URL file (TXT, CSV, MD)
 * Extracts URLs from any text content - handles commas, semicolons, tabs
 * @param {string} content - File content
 * @param {string} filename - File name for format detection
 * @returns {string[]} Array of normalized URLs
 */
function parseUrlFile(content, filename) {
    const urls = [];
    const seen = new Set();

    // Blocked social/platform domains (not useful for email scraping)
    const blockedDomains = [
        'google.com', 'facebook.com', 'twitter.com', 'instagram.com',
        'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com',
        'amazon.com', 'ebay.com', 'whatsapp.com'
    ];

    // STRATEGY 1: Extract all URLs using regex (most reliable)
    // Matches http:// or https:// followed by valid URL characters
    const urlRegex = /https?:\/\/[^\s,;"\'\]\)\}\>\<\t]+/gi;
    const regexMatches = content.match(urlRegex) || [];

    for (const match of regexMatches) {
        processUrl(match);
    }

    // STRATEGY 2: If no URLs found with protocol, try domain patterns
    if (urls.length === 0) {
        // Split by common delimiters: newlines, tabs, commas, semicolons
        const parts = content.split(/[\r\n\t,;]+/)
            .map(p => p.trim())
            .filter(p => p && p.length > 3);

        for (const part of parts) {
            // Skip headers
            if (part.toLowerCase().includes('website') || part.toLowerCase().includes('url')) {
                continue;
            }

            // Handle MD links: [text](url)
            const mdMatch = part.match(/\(([^)]+)\)/);
            if (mdMatch && mdMatch[1].includes('.')) {
                processUrl(mdMatch[1]);
                continue;
            }

            // If looks like a domain (has a dot and no spaces)
            if (part.includes('.') && !part.includes(' ')) {
                processUrl(part);
            }
        }
    }

    function processUrl(rawUrl) {
        let url = rawUrl.trim()
            .replace(/[,;"\'\]\)\}\>\<]+$/, '') // Remove trailing punctuation
            .replace(/\/+$/, ''); // Remove trailing slashes

        if (!url || url.length < 4) return;

        // Add protocol if missing
        if (!url.match(/^https?:\/\//i)) {
            url = 'https://' + url;
        }

        try {
            const parsed = new URL(url);
            const normalized = `${parsed.protocol}//${parsed.hostname}`;
            const hostname = parsed.hostname.toLowerCase();

            // Skip duplicates
            if (seen.has(normalized)) return;

            // Skip blocked domains
            if (blockedDomains.some(b => hostname.includes(b))) return;

            // Skip IPs and localhost
            if (hostname.match(/^(\d{1,3}\.){3}\d{1,3}$/) || hostname === 'localhost') return;

            // Skip if hostname has no dot (invalid domain)
            if (!hostname.includes('.')) return;

            seen.add(normalized);
            urls.push(normalized);

        } catch {
            // Invalid URL, skip silently
        }
    }

    console.log(`[IO7] Parsed ${urls.length} valid URLs from file`);
    return urls.slice(0, 5000); // Max 5000 URLs per import
}


/**
 * Clear import state and reset UI
 */
function clearImportState() {
    pendingImportUrls = [];

    const importPreview = document.getElementById('importPreview');
    const importFileInput = document.getElementById('importFileInput');
    const importSection = document.getElementById('importSection');
    const btnConfirmImport = document.getElementById('btnConfirmImport');

    if (importPreview) importPreview.classList.add('hidden');
    if (importFileInput) importFileInput.value = '';
    if (importSection) importSection.classList.remove('file-selected');
    if (btnConfirmImport) {
        btnConfirmImport.disabled = false;
        btnConfirmImport.innerHTML = 'Add to Discovery';
    }
}

// ============================================
// UTILITIES
// ============================================
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// START
// ============================================
document.addEventListener('DOMContentLoaded', initialize);

// Export for other modules
window.GhostMapUI = {
    showToast,
    showLoading,
    hideLoading,
    addActivity,
    loadStats,
    switchPhase
};

// ─────────────────────────────────────────────────────────────────────────
// OPPORTUNI — opt-in cloud sync settings (additive, default OFF)
// ─────────────────────────────────────────────────────────────────────────
(function wireOpportuniTab() {
    const STORAGE_KEY = 'opportuni_settings';
    const AUTH_KEY = 'opportuni_auth';

    document.addEventListener('DOMContentLoaded', () => {
        const tabBtn = document.querySelector('.tab-btn[data-tab="opportuni"]');
        const tabPane = document.getElementById('tab-opportuni');
        if (!tabBtn || !tabPane) return;

        const enabledEl = document.getElementById('opportuniEnabled');
        const endpointEl = document.getElementById('opportuniEndpoint');
        const tokenEl = document.getElementById('opportuniToken');
        const syncBtn = document.getElementById('opportuniSyncNowBtn');
        const statusEl = document.getElementById('opportuniSyncStatus');

        tabBtn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
            tabBtn.classList.add('active');
            tabPane.style.display = 'block';
        });

        const restore = async () => {
            try {
                if (chrome?.storage?.local) {
                    const a = await chrome.storage.local.get([STORAGE_KEY, AUTH_KEY]);
                    const cfg = a[STORAGE_KEY] || {};
                    if (enabledEl) enabledEl.checked = !!cfg.enabled;
                    if (endpointEl) endpointEl.value = cfg.endpoint || 'http://localhost:8787/api/sync';
                    if (tokenEl) tokenEl.value = a[AUTH_KEY]?.token || '';
                }
            } catch (e) { console.warn('[Opportuni] restore failed', e); }
        };
        restore();

        const persist = async () => {
            if (!chrome?.storage?.local) return;
            await chrome.storage.local.set({
                [STORAGE_KEY]: {
                    enabled: !!enabledEl?.checked,
                    endpoint: endpointEl?.value || ''
                }
            });
            if (tokenEl?.value) {
                await chrome.storage.local.set({
                    [AUTH_KEY]: { token: tokenEl.value, savedAt: Date.now() }
                });
            } else {
                await chrome.storage.local.remove(AUTH_KEY);
            }
        };

        [enabledEl, endpointEl, tokenEl].forEach(el => el?.addEventListener('change', persist));

        syncBtn?.addEventListener('click', async () => {
            if (statusEl) statusEl.textContent = 'Sync in corso...';
            try {
                if (!chrome?.runtime?.sendMessage) throw new Error('chrome.runtime not available');
                await persist();
                const resp = await sendMessageWithTimeout({
                    action: 'sync_to_opportuni',
                    payload: {
                        snapshotId: `gmp-${Date.now()}`,
                        coverageComplete: false,
                        businesses: []
                    }
                });
                if (resp?.skipped) {
                    statusEl.textContent = `⏭ Skipped: ${resp.reason || 'unknown'}`;
                } else if (resp?.success) {
                    statusEl.textContent = '✅ Sync OK';
                } else {
                    statusEl.textContent = `❌ ${resp?.error || 'unknown error'}`;
                }
            } catch (e) {
                if (statusEl) statusEl.textContent = `❌ ${e.message}`;
            }
        });
    });
})();
