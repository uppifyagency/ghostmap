/**
 * =====================================================
 * AREA SEARCH MODAL - TURBO EDITION
 * =====================================================
 * 
 * Updated UI with Turbo Mode toggle
 * Shows parallel tabs setting and faster estimates
 */

const areaSearchModalHTML = `
<div class="modal-overlay" id="areaSearchModal" style="display: none;">
    <div class="modal-content" style="max-width: 520px;">
        <div class="modal-header">
            <h3>🗺️ Area Search</h3>
            <button id="closeAreaSearchBtn" class="icon-btn">✕</button>
        </div>
        
        <div class="modal-body">
            <!-- TURBO MODE TOGGLE -->
            <div class="turbo-toggle" style="background: linear-gradient(135deg, rgba(16,185,129,0.15), rgba(59,130,246,0.15)); border: 1px solid rgba(16,185,129,0.3); border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between;">
                <div>
                    <div style="font-weight: 600; display: flex; align-items: center; gap: 8px;">
                        🚀 Turbo Mode
                        <span style="font-size: 10px; background: #10b981; padding: 2px 8px; border-radius: 10px;">10x FASTER</span>
                    </div>
                    <div style="font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 2px;">
                        Opens <span id="parallelTabsDisplay">8</span> tabs simultaneously
                    </div>
                </div>
                <label class="switch">
                    <input type="checkbox" id="turboModeToggle" checked>
                    <span class="slider"></span>
                </label>
            </div>

            <!-- Configuration Form -->
            <div id="areaSearchConfig">
                <div class="form-group">
                    <label>📍 City / Location</label>
                    <input type="text" id="areaSearchCity" placeholder="e.g., Modena" list="italianCities">
                    <datalist id="italianCities">
                        <option value="Milano"><option value="Roma"><option value="Napoli">
                        <option value="Torino"><option value="Bologna"><option value="Firenze">
                        <option value="Venezia"><option value="Verona"><option value="Modena">
                        <option value="Parma"><option value="Padova"><option value="Brescia">
                        <option value="Bergamo"><option value="Genova"><option value="Bari">
                    </datalist>
                </div>
                
                <div class="form-group">
                    <label>📏 Radius</label>
                    <div class="range-container">
                        <input type="range" id="areaSearchRadiusRange" min="10" max="200" value="100" step="10">
                        <div class="range-value">
                            <input type="number" id="areaSearchRadius" value="100" min="10" max="200" style="width: 60px;">
                            <span>km</span>
                        </div>
                    </div>
                    <span class="hint" id="radiusHint">~31,416 km² coverage</span>
                </div>
                
                <div class="form-group">
                    <label>🔍 Keywords (one per line)</label>
                    <textarea id="areaSearchKeywords" rows="4" placeholder="wedding planner&#10;fotografo matrimonio&#10;interior designer&#10;architetto"></textarea>
                </div>
                
                <!-- Turbo Settings (shown when turbo enabled) -->
                <div id="turboSettings" class="form-group" style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px;">
                    <label style="font-size: 12px;">⚡ Turbo Settings</label>
                    <div style="display: flex; gap: 12px; margin-top: 8px;">
                        <div style="flex: 1;">
                            <label style="font-size: 11px; color: rgba(255,255,255,0.5);">Parallel Tabs</label>
                            <select id="parallelTabsSelect" style="width: 100%;">
                                <option value="4">4 tabs (Safe)</option>
                                <option value="6">6 tabs</option>
                                <option value="8" selected>8 tabs (Recommended)</option>
                                <option value="10">10 tabs (Fast)</option>
                                <option value="12">12 tabs (Aggressive)</option>
                            </select>
                        </div>
                        <div style="flex: 1;">
                            <label style="font-size: 11px; color: rgba(255,255,255,0.5);">Grid Spacing</label>
                            <select id="areaSearchSpacing" style="width: 100%;">
                                <option value="5">5 km (Dense)</option>
                                <option value="8" selected>8 km (Standard)</option>
                                <option value="12">12 km (Fast)</option>
                                <option value="15">15 km (Very Fast)</option>
                            </select>
                        </div>
                    </div>
                </div>
                
                <!-- Estimate Box -->
                <div id="areaSearchEstimate" class="estimate-box" style="display: none;">
                    <div class="estimate-header">📊 Search Estimate</div>
                    <div class="estimate-grid">
                        <div class="estimate-item">
                            <span class="estimate-value" id="estGridPoints">0</span>
                            <span class="estimate-label">Grid Points</span>
                        </div>
                        <div class="estimate-item">
                            <span class="estimate-value" id="estTotalSearches">0</span>
                            <span class="estimate-label">Searches</span>
                        </div>
                        <div class="estimate-item">
                            <span class="estimate-value" id="estBatches">0</span>
                            <span class="estimate-label">Batches</span>
                        </div>
                        <div class="estimate-item">
                            <span class="estimate-value" id="estTime">0m</span>
                            <span class="estimate-label">Est. Time</span>
                        </div>
                    </div>
                    <div id="speedComparison" style="text-align: center; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 11px; color: rgba(255,255,255,0.5);">
                        <span style="text-decoration: line-through; color: #ef4444;" id="oldTime">4h 20m</span>
                        → <span style="color: #10b981; font-weight: 600;" id="newTime">26 min</span>
                        <span style="color: #10b981;">🚀 10x faster!</span>
                    </div>
                </div>
            </div>
            
            <!-- Progress View -->
            <div id="areaSearchProgress" style="display: none;">
                <!-- B12-1/B12-2 FIX: warning banner (CAPTCHA cooldown, high-fail-rate, etc.) -->
                <div id="areaSearchWarningBanner" class="warning-banner" style="display: none;" role="alert" aria-live="polite">
                    <span id="areaSearchWarningIcon" class="warning-banner-icon">⚠️</span>
                    <span id="areaSearchWarningText" class="warning-banner-text">—</span>
                </div>

                <div style="text-align: center; margin-bottom: 16px;">
                    <div style="font-size: 48px; font-weight: 700;" id="progressPercent">0%</div>
                    <div id="turboIndicator" style="display: inline-flex; align-items: center; gap: 6px; background: rgba(16,185,129,0.2); padding: 4px 12px; border-radius: 20px; font-size: 12px; color: #10b981;">
                        🚀 TURBO <span id="parallelInfo">8 tabs</span>
                    </div>
                    <div style="color: rgba(255,255,255,0.6); margin-top: 8px;" id="progressStatus">Searching...</div>
                </div>
                
                <div style="margin-bottom: 16px;">
                    <div style="height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden;">
                        <div id="progressBar" style="height: 100%; width: 0%; background: linear-gradient(90deg, #10b981, #34d399); transition: width 0.3s;"></div>
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;">
                    <div class="stat-card">
                        <div class="stat-value" id="progressCurrent">0</div>
                        <div class="stat-label">/ <span id="progressTotal">0</span> Searches</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="progressBatch">0</div>
                        <div class="stat-label">/ <span id="progressTotalBatches">0</span> Batches</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="progressElapsed">0:00</div>
                        <div class="stat-label">Elapsed</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="progressRemaining">--:--</div>
                        <div class="stat-label">Remaining</div>
                    </div>
                </div>
                
                <div id="currentSearchInfo" style="margin-top: 16px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px; font-size: 12px;">
                    <div style="color: rgba(255,255,255,0.5);">Processing batch:</div>
                    <div id="batchInfo" style="font-weight: 600;">Initializing...</div>
                </div>
            </div>
        </div>
        
        <div class="modal-footer">
            <button class="btn secondary" id="cancelAreaSearchBtn">Cancel</button>
            <button class="btn secondary" id="pauseAreaSearchBtn" style="display: none;">⏸ Pause</button>
            <button class="btn primary" id="startAreaSearchBtn">🚀 Start Turbo Search</button>
        </div>
    </div>
</div>

<style>
/* Toggle Switch */
.switch {
    position: relative;
    width: 50px;
    height: 26px;
}
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
    position: absolute;
    cursor: pointer;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(255,255,255,0.2);
    border-radius: 26px;
    transition: 0.3s;
}
.slider:before {
    position: absolute;
    content: "";
    height: 20px;
    width: 20px;
    left: 3px;
    bottom: 3px;
    background: white;
    border-radius: 50%;
    transition: 0.3s;
}
input:checked + .slider { background: #10b981; }
input:checked + .slider:before { transform: translateX(24px); }

/* Stat cards */
.stat-card {
    background: rgba(255,255,255,0.05);
    padding: 12px;
    border-radius: 8px;
    text-align: center;
}
.stat-value {
    font-size: 20px;
    font-weight: 600;
    color: #10b981;
}
.stat-label {
    font-size: 11px;
    color: rgba(255,255,255,0.5);
}

/* Range container */
.range-container {
    display: flex;
    align-items: center;
    gap: 12px;
}
.range-container input[type="range"] {
    flex: 1;
    height: 6px;
    -webkit-appearance: none;
    background: rgba(255,255,255,0.2);
    border-radius: 3px;
}
.range-container input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 18px;
    height: 18px;
    background: #10b981;
    border-radius: 50%;
    cursor: pointer;
}
.range-value {
    display: flex;
    align-items: center;
    gap: 4px;
}

/* Estimate box */
.estimate-box {
    background: linear-gradient(135deg, rgba(16,185,129,0.1), rgba(59,130,246,0.1));
    border: 1px solid rgba(16,185,129,0.3);
    border-radius: 12px;
    padding: 16px;
    margin-top: 16px;
}
.estimate-header {
    font-weight: 600;
    margin-bottom: 12px;
    text-align: center;
}
.estimate-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
}
.estimate-item { text-align: center; }
.estimate-value {
    display: block;
    font-size: 18px;
    font-weight: 700;
    color: #10b981;
}
.estimate-label {
    display: block;
    font-size: 9px;
    color: rgba(255,255,255,0.5);
    text-transform: uppercase;
}

/* Form styling */
#areaSearchModal .form-group { margin-bottom: 14px; }
#areaSearchModal label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 6px;
}
#areaSearchModal input[type="text"],
#areaSearchModal input[type="number"],
#areaSearchModal textarea,
#areaSearchModal select {
    width: 100%;
    padding: 10px 12px;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    color: white;
    font-size: 14px;
}
#areaSearchModal .hint {
    font-size: 11px;
    color: rgba(255,255,255,0.4);
    margin-top: 4px;
}

/* B12-1/B12-2 warning banner */
.warning-banner {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    margin-bottom: 14px;
    background: rgba(245, 158, 11, 0.18);
    border: 1px solid rgba(245, 158, 11, 0.55);
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.4;
    color: #fde68a;
}
.warning-banner.captcha {
    background: rgba(239, 68, 68, 0.18);
    border-color: rgba(239, 68, 68, 0.55);
    color: #fecaca;
}
.warning-banner-icon { flex-shrink: 0; font-size: 16px; }
.warning-banner-text { flex: 1; }
</style>
`;

// =====================================================
// MODAL LOGIC
// =====================================================

function initAreaSearchModal() {
    document.body.insertAdjacentHTML('beforeend', areaSearchModalHTML);

    const modal = document.getElementById('areaSearchModal');
    const turboToggle = document.getElementById('turboModeToggle');
    const parallelSelect = document.getElementById('parallelTabsSelect');
    const radiusInput = document.getElementById('areaSearchRadius');
    const radiusRange = document.getElementById('areaSearchRadiusRange');
    const keywordsInput = document.getElementById('areaSearchKeywords');
    const spacingSelect = document.getElementById('areaSearchSpacing');

    // Close handlers
    document.getElementById('closeAreaSearchBtn')?.addEventListener('click', closeAreaSearchModal);
    document.getElementById('cancelAreaSearchBtn')?.addEventListener('click', handleCancel);
    document.getElementById('startAreaSearchBtn')?.addEventListener('click', handleStart);
    document.getElementById('pauseAreaSearchBtn')?.addEventListener('click', handlePause);

    modal?.addEventListener('click', (e) => {
        if (e.target === modal) closeAreaSearchModal();
    });

    // Turbo toggle
    turboToggle?.addEventListener('change', () => {
        const turboSettings = document.getElementById('turboSettings');
        const startBtn = document.getElementById('startAreaSearchBtn');
        if (turboToggle.checked) {
            turboSettings.style.display = 'block';
            startBtn.textContent = '🚀 Start Turbo Search';
        } else {
            turboSettings.style.display = 'none';
            startBtn.textContent = '▶️ Start Search';
        }
        updateEstimate();
    });

    // Parallel tabs display
    parallelSelect?.addEventListener('change', () => {
        document.getElementById('parallelTabsDisplay').textContent = parallelSelect.value;
        updateEstimate();
    });

    // Sync radius inputs
    radiusRange?.addEventListener('input', () => {
        radiusInput.value = radiusRange.value;
        updateRadiusHint();
        updateEstimate();
    });
    radiusInput?.addEventListener('input', () => {
        radiusRange.value = radiusInput.value;
        updateRadiusHint();
        updateEstimate();
    });

    // Update estimate on change
    keywordsInput?.addEventListener('input', updateEstimate);
    spacingSelect?.addEventListener('change', updateEstimate);

    // Listen for progress + warnings
    // B12-1/B12-2 FIX: case-style dispatch with warning banner handling.
    chrome.runtime.onMessage.addListener((message) => {
        switch (message.action) {
            case 'area_search_progress':
                updateProgressUI(message.payload);
                break;
            case 'area_search_complete':
                handleComplete(message.payload);
                break;
            case 'area_search_warning':
                showAreaSearchWarning(message.payload, 'warning');
                break;
            case 'area_search_captcha_detected':
                showAreaSearchWarning(message.payload, 'captcha');
                break;
        }
    });
}

// ─── B12-1/B12-2 FIX: warning banner ──────────────────────────────────────
// Pre-fix: SW emitted `area_search_warning` and `area_search_captcha_detected`
// runtime messages but no UI listener was wired. Audit comment at
// background/area-search.js:601-604 explicitly flagged "no UI listener wired
// for area_search_warning (verified)". Fix: dispatch to in-modal banner
// AND mirror to sidepanel (sidepanel.js handles persistent activity feed,
// guaranteeing the signal survives modal close).
//
// Display rules:
//   • min 8s display time even if cooldown is shorter (multiple SW retries
//     within one cooldown shouldn't blink the banner)
//   • clear previous timer if a new warning arrives — avoids race where
//     stale timer hides a fresh warning
//   • payload shapes:
//     warning:  {message, cooldownMs}  OR  {type:'high_wake_fail_rate', rate, failed, total}
//     captcha:  {cooldownMs, resumeAt}

let _areaSearchWarningTimer = null;
const AREA_SEARCH_WARNING_MIN_MS = 8000;

function showAreaSearchWarning(payload, kind) {
    const banner = document.getElementById('areaSearchWarningBanner');
    const textEl = document.getElementById('areaSearchWarningText');
    const iconEl = document.getElementById('areaSearchWarningIcon');
    if (!banner || !textEl || !iconEl) return; // modal not yet rendered

    const isCaptcha = kind === 'captcha';
    banner.classList.toggle('captcha', isCaptcha);
    iconEl.textContent = isCaptcha ? '🛑' : '⚠️';

    // Compose human-readable message based on payload shape
    let msg;
    if (isCaptcha) {
        const cd = (payload && typeof payload.cooldownMs === 'number') ? payload.cooldownMs : 0;
        msg = `CAPTCHA detected — extension will retry after cooldown (${Math.round(cd / 1000)}s)`;
    } else if (payload && payload.type === 'high_wake_fail_rate') {
        const pct = Math.round((payload.rate || 0) * 100);
        msg = `High tab wake-fail rate (${pct}% — ${payload.failed}/${payload.total}). Some records will fall back to legacy DOM extraction.`;
    } else if (payload && typeof payload.message === 'string') {
        const cd = (typeof payload.cooldownMs === 'number') ? Math.round(payload.cooldownMs / 1000) : null;
        msg = cd !== null ? `${payload.message} (cooldown: ${cd}s)` : payload.message;
    } else {
        msg = 'Area search warning (no details).';
    }
    textEl.textContent = msg;
    banner.style.display = 'flex';

    // Auto-hide after max(cooldownMs, MIN_MS) + 2s grace
    const cdMs = (payload && typeof payload.cooldownMs === 'number') ? payload.cooldownMs : 0;
    const displayMs = Math.max(cdMs, AREA_SEARCH_WARNING_MIN_MS) + 2000;
    if (_areaSearchWarningTimer !== null) clearTimeout(_areaSearchWarningTimer);
    _areaSearchWarningTimer = setTimeout(() => {
        banner.style.display = 'none';
        _areaSearchWarningTimer = null;
    }, displayMs);
}

// Exported for testability (window scope is the project's existing pattern)
if (typeof window !== 'undefined') {
    /** @type {any} */ (window).showAreaSearchWarning = showAreaSearchWarning;
}

async function openAreaSearchModal() {
    document.getElementById('areaSearchModal').style.display = 'flex';

    // UI-5 FIX (2026-05-10): pre-fix used the legacy callback form of
    // chrome.runtime.sendMessage and never checked chrome.runtime.lastError.
    // When the SW was evicted or no listener answered, the callback fired
    // with `response === undefined` and `chrome.runtime.lastError` set.
    // The check `response?.isRunning` evaluated to false, causing the
    // modal to fall through to `showConfigView()` — even though an area
    // search WAS still running in the background. The user, faced with a
    // fresh config form, would press Start again and kick off a SECOND
    // concurrent area search (compounding state corruption fixed in
    // SEC-5 / area-search.js).
    //
    // Now: Promise-form sendMessage with try/catch. On any error or
    // undefined response we keep the modal open but show progress view
    // optimistically if the caller knows monitoring is active in UI
    // state, otherwise default to config view. We log the failure so
    // the user can see it in DevTools rather than silently misbehaving.
    let response;
    try {
        response = await chrome.runtime.sendMessage({ action: 'get_area_search_status' });
    } catch (err) {
        console.warn('[AreaSearchModal] get_area_search_status failed:', err?.message);
    }

    if (response?.isRunning) {
        showProgressView();
    } else if (response === undefined) {
        // SW unreachable — DON'T show config (would let user start a duplicate
        // run if a search is actually still active). Show progress view as a
        // safer default with a notice; the user can still cancel.
        console.warn('[AreaSearchModal] SW unreachable; defaulting to progress view to prevent duplicate start');
        showProgressView();
    } else {
        showConfigView();
        updateEstimate();
    }
}

function closeAreaSearchModal() {
    document.getElementById('areaSearchModal').style.display = 'none';
    // UI-2 FIX (2026-05-27): clear pending warning-banner auto-hide timer
    // so it does not fire after the modal closes. The pre-fix timer was
    // a leaked resource — its callback was idempotent (banner element
    // still in DOM) but it kept a slot in the browser timer queue and
    // resurfaced as a stale banner on rapid close/reopen cycles.
    if (_areaSearchWarningTimer !== null) {
        clearTimeout(_areaSearchWarningTimer);
        _areaSearchWarningTimer = null;
    }
}

function showConfigView() {
    document.getElementById('areaSearchConfig').style.display = 'block';
    document.getElementById('areaSearchProgress').style.display = 'none';
    document.getElementById('startAreaSearchBtn').style.display = 'inline-flex';
    document.getElementById('pauseAreaSearchBtn').style.display = 'none';
    document.getElementById('cancelAreaSearchBtn').textContent = 'Cancel';
}

function showProgressView() {
    document.getElementById('areaSearchConfig').style.display = 'none';
    document.getElementById('areaSearchProgress').style.display = 'block';
    document.getElementById('startAreaSearchBtn').style.display = 'none';
    document.getElementById('pauseAreaSearchBtn').style.display = 'inline-flex';
    document.getElementById('cancelAreaSearchBtn').textContent = 'Stop';
}

function updateRadiusHint() {
    const radius = parseInt(document.getElementById('areaSearchRadius').value) || 100;
    const area = Math.round(Math.PI * radius * radius);
    document.getElementById('radiusHint').textContent = `~${area.toLocaleString()} km² coverage`;
}

function updateEstimate() {
    const city = document.getElementById('areaSearchCity').value.trim();
    const radius = parseInt(document.getElementById('areaSearchRadius').value) || 100;
    const keywords = document.getElementById('areaSearchKeywords').value
        .split('\n').map(k => k.trim()).filter(k => k);
    const spacing = parseInt(document.getElementById('areaSearchSpacing').value) || 8;
    const turboEnabled = document.getElementById('turboModeToggle').checked;
    const parallelTabs = parseInt(document.getElementById('parallelTabsSelect').value) || 8;

    const estimateBox = document.getElementById('areaSearchEstimate');

    if (!city || keywords.length === 0) {
        estimateBox.style.display = 'none';
        return;
    }

    // Calculate
    const gridPoints = Math.ceil(Math.PI * Math.pow(radius / spacing, 2));
    const totalSearches = gridPoints * keywords.length;

    let timeMinutes, batches;
    if (turboEnabled) {
        batches = Math.ceil(totalSearches / parallelTabs);
        timeMinutes = Math.ceil(batches * 12 / 60); // ~12s per batch
    } else {
        batches = totalSearches;
        timeMinutes = Math.ceil(totalSearches * 30 / 60); // ~30s per search
    }

    // Old time (sequential)
    const oldTimeMinutes = Math.ceil(totalSearches * 30 / 60);

    // Update UI
    document.getElementById('estGridPoints').textContent = gridPoints;
    document.getElementById('estTotalSearches').textContent = totalSearches;
    document.getElementById('estBatches').textContent = batches;
    document.getElementById('estTime').textContent = formatTime(timeMinutes);

    // Speed comparison
    const speedComparison = document.getElementById('speedComparison');
    if (turboEnabled && oldTimeMinutes > timeMinutes * 2) {
        speedComparison.style.display = 'block';
        document.getElementById('oldTime').textContent = formatTime(oldTimeMinutes);
        document.getElementById('newTime').textContent = formatTime(timeMinutes);
    } else {
        speedComparison.style.display = 'none';
    }

    estimateBox.style.display = 'block';
}

function formatTime(minutes) {
    if (minutes >= 60) {
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }
    return `${minutes}m`;
}

async function handleStart() {
    const city = document.getElementById('areaSearchCity').value.trim();
    const radius = parseInt(document.getElementById('areaSearchRadius').value) || 100;
    const keywords = document.getElementById('areaSearchKeywords').value
        .split('\n').map(k => k.trim()).filter(k => k);
    const spacing = parseInt(document.getElementById('areaSearchSpacing').value) || 8;
    const turboEnabled = document.getElementById('turboModeToggle').checked;
    const parallelTabs = parseInt(document.getElementById('parallelTabsSelect').value) || 8;

    if (!city) return alert('Please enter a city');
    if (keywords.length === 0) return alert('Please enter keywords');

    const startBtn = document.getElementById('startAreaSearchBtn');
    startBtn.disabled = true;
    startBtn.innerHTML = '⏳ Starting...';

    // M-2 FIX: Track if we successfully started to avoid resetting button when in progress view
    let startedSuccessfully = false;

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'start_area_search',
            payload: {
                city,
                radiusKm: radius,
                keywords,
                spacingKm: spacing,
                parallelTabs: turboEnabled ? parallelTabs : 1,
                turboMode: turboEnabled
            }
        });

        if (response?.status === 'started') {
            startedSuccessfully = true;
            showProgressView();
            document.getElementById('parallelInfo').textContent =
                turboEnabled ? `${parallelTabs} tabs` : '1 tab';
        } else {
            alert('Error: ' + (response?.message || 'Unknown'));
        }
    } catch (error) {
        alert('Error: ' + error.message);
    } finally {
        // M-2 FIX: Always reset button state unless we successfully transitioned to progress view
        if (!startedSuccessfully) {
            startBtn.disabled = false;
            startBtn.innerHTML = '🚀 Start Turbo Search';
        }
    }
}

async function handlePause() {
    const pauseBtn = document.getElementById('pauseAreaSearchBtn');
    const response = await chrome.runtime.sendMessage({ action: 'get_area_search_status' });

    if (response?.isPaused) {
        await chrome.runtime.sendMessage({ action: 'resume_area_search' });
        pauseBtn.innerHTML = '⏸ Pause';
    } else {
        await chrome.runtime.sendMessage({ action: 'pause_area_search' });
        pauseBtn.innerHTML = '▶ Resume';
    }
}

async function handleCancel() {
    if (document.getElementById('cancelAreaSearchBtn').textContent === 'Stop') {
        if (!confirm('Stop the search?')) return;
        await chrome.runtime.sendMessage({ action: 'stop_area_search' });
        showConfigView();
        document.getElementById('startAreaSearchBtn').disabled = false;
        document.getElementById('startAreaSearchBtn').innerHTML = '🚀 Start Turbo Search';
    } else {
        closeAreaSearchModal();
    }
}

function updateProgressUI(progress) {
    if (!progress) return;

    document.getElementById('progressPercent').textContent = progress.percent + '%';
    document.getElementById('progressBar').style.width = progress.percent + '%';
    document.getElementById('progressCurrent').textContent = progress.current;
    document.getElementById('progressTotal').textContent = progress.total;
    document.getElementById('progressElapsed').textContent = progress.elapsed || '0:00';
    document.getElementById('progressRemaining').textContent = progress.remaining || '--:--';

    if (progress.currentBatch !== undefined) {
        document.getElementById('progressBatch').textContent = progress.currentBatch;
        document.getElementById('progressTotalBatches').textContent = progress.totalBatches;
        document.getElementById('batchInfo').textContent =
            `Batch ${progress.currentBatch}/${progress.totalBatches}`;
    }

    const pauseBtn = document.getElementById('pauseAreaSearchBtn');
    pauseBtn.innerHTML = progress.isPaused ? '▶ Resume' : '⏸ Pause';

    document.getElementById('progressStatus').textContent =
        progress.isPaused ? 'Paused' : 'Searching...';
}

function handleComplete(result) {
    console.log('[AREA SEARCH] Complete!', result);

    // Close modal first to show main UI
    closeAreaSearchModal();

    // CRITICAL FIX: Trigger sidepanel stats refresh to load new businesses
    // This will update the business count and make them visible
    chrome.runtime.sendMessage({ action: 'get_stats' }).then(() => {
        // The sidepanel auto-refreshes stats every 5 seconds anyway,
        // but we trigger immediate refresh for better UX
        console.log('[AREA SEARCH] Stats refresh triggered');
    }).catch(err => {
        console.warn('[AREA SEARCH] Stats refresh failed:', err);
    });

    // OBS-4 (2026-05-17): stats are now DB-truth (post-reconciliation in
    // finishTurbo). Display total + this-run breakdown so the user sees
    // (a) where the DB stands now, and (b) what THIS search contributed.
    // Pre-fix the dialog showed "Businesses found: 0" because the counter
    // was newly-saved-only; with the reconciliation it now matches what
    // the main sidepanel shows.
    const s = result.stats || {};
    const newThisRun = s.newBusinessesThisRun ?? 0;
    const duplicatesThisRun = s.duplicatesFound ?? 0;

    // SAVE-DLQ (2026-05-28): the save outcome is no longer silent. Distinct,
    // non-conflated signals (RCA Revision v3):
    //   • recoveredFromQueue — records re-saved from a previous run's failures
    //   • failedSaveEvents   — save-attempt failures THIS run (diagnostic)
    //   • pendingInQueue     — records still queued for retry (global, post-drain)
    //   • quotaFailures      — per-run quota hits → "storage full" (fresh, no stale flag)
    const recoveredFromQueue = s.recoveredFromQueue || 0;
    const failedSaveEvents = s.failedSaveEvents || 0;
    const pendingInQueue = s.pendingInQueue || 0;
    const quotaFailures = s.quotaFailures || 0;
    let saveHealthText = '';
    if (recoveredFromQueue > 0) saveHealthText += `\n♻️ ${recoveredFromQueue} recuperati da ricerche precedenti`;
    if (failedSaveEvents > 0) saveHealthText += `\n⚠️ ${failedSaveEvents} salvataggi falliti in questa ricerca`;
    if (pendingInQueue > 0) saveHealthText += `\n📥 ${pendingInQueue} in coda di recupero (riprovati al prossimo avvio)`;
    if (quotaFailures > 0) saveHealthText += `\n🛑 Spazio di archiviazione pieno — esporta o pulisci i dati`;

    const statsText = result.stats ?
        `\n\nBusinesses found: ${s.businessesFound || 0} ` +
        `(${newThisRun} new, ${duplicatesThisRun} already in DB)\n` +
        `With website: ${s.withWebsite || 0}\n` +
        `With phone: ${s.withPhone || 0}` + saveHealthText :
        '';

    alert(`✅ Area Search Complete!${statsText}\n\nDuration: ${result.duration}\n\n💡 Tip: Check the main view for scraped businesses.\nClick "Scrape Emails" to extract emails from websites.`);

    // Reset start button
    const startBtn = document.getElementById('startAreaSearchBtn');
    if (startBtn) {
        startBtn.disabled = false;
        startBtn.innerHTML = '🚀 Start Turbo Search';
    }
}

// Initialize
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAreaSearchModal);
} else {
    initAreaSearchModal();
}

window.openAreaSearchModal = openAreaSearchModal;
