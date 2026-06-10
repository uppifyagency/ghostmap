/**
 * Storage Details Modal - Enhanced Chrome Storage Monitoring
 * Shows detailed breakdown of storage usage and cleanup tools
 * 
 * BLOCK-10 FIX (LOW-017): Native alert/confirm/prompt are INTENTIONALLY used here
 * for destructive operations (delete businesses, clear data). This is a safety pattern:
 * - Users must explicitly acknowledge before irreversible actions
 * - Modal dialogs block execution until user responds
 * - Toast notifications would not provide sufficient friction for data deletion
 */

// Add Storage Details Modal to HTML
const storageModalHTML = `
<div class="modal-overlay" id="storageModal" style="display: none;">
    <div class="modal-content" style="max-width: 600px;">
        <div class="modal-header">
            <h3>💾 Chrome Storage Details</h3>
            <button id="closeStorageModalBtn" class="icon-btn">✕</button>
        </div>
        
        <div class="modal-body">
            <!-- Storage Overview -->
            <div class="storage-overview">
                <h4>📊 Storage Overview</h4>
                <div class="storage-stat-row">
                    <span>Total Used:</span>
                    <strong id="detailTotalUsed">0 MB</strong>
                </div>
                <div class="storage-stat-row">
                    <span>Available Quota:</span>
                    <strong id="detailQuota">0 MB</strong>
                </div>
                <div class="storage-stat-row">
                    <span>Percentage:</span>
                    <strong id="detailPercent">0%</strong>
                </div>
            </div>

            <!-- Breakdown -->
            <div class="storage-breakdown">
                <h4>📦 Storage Breakdown</h4>
                
                <div class="storage-item">
                    <div class="storage-item-header">
                        <span class="storage-item-icon">🗄️</span>
                        <span class="storage-item-name">IndexedDB (Businesses)</span>
                        <span class="storage-item-size" id="indexedDBSize">0 MB</span>
                    </div>
                    <div class="storage-item-details">
                        <small>Database: <code>GhostMapPro_DB_v1</code></small><br>
                        <small>Stores: businesses</small><br>
                        <small id="businessCount">0 records</small>
                    </div>
                </div>

                <div class="storage-item">
                    <div class="storage-item-header">
                        <span class="storage-item-icon">⚙️</span>
                        <span class="storage-item-name">chrome.storage.local</span>
                        <span class="storage-item-size" id="chromeStorageSize">< 1 MB</span>
                    </div>
                    <div class="storage-item-details">
                        <small>Settings, user preferences</small>
                    </div>
                </div>
            </div>

            <!-- Data Location -->
            <div class="storage-location">
                <h4>📁 Data Location (Your Mac)</h4>
                <div class="alert-box warning">
                    <strong>🖥️ IndexedDB Files:</strong><br>
                    <code style="font-size: 11px; word-break: break-all;">
                        ~/Library/Application Support/Google/Chrome/<br>
                        Default/IndexedDB/chrome-extension_[EXTENSION_ID]_0.indexeddb.leveldb/
                    </code>
                    <br><br>
                    <strong>⚙️ chrome.storage Files:</strong><br>
                    <code style="font-size: 11px; word-break: break-all;">
                        ~/Library/Application Support/Google/Chrome/<br>
                        Default/Local Extension Settings/[EXTENSION_ID]/
                    </code>
                </div>
                <p style="font-size: 13px; color: #6b7280; margin-top: 12px;">
                    ✅ <strong>Good news:</strong> Export (CSV/MD) does NOT create additional files on your Mac. 
                    The export generates the file in-memory and triggers a download, but doesn't leave parsing artifacts behind.
                </p>
            </div>

            <!-- Cleanup Section -->
            <div class="storage-cleanup">
                <h4>🧹 Data Cleanup</h4>
                <p style="font-size: 13px; color: #6b7280; margin-bottom: 12px;">
                    Clear data to free up storage space:
                </p>
                <div class="cleanup-options">
                    <!-- B10-1 FIX (truthful labeling): the underlying logic
                         filters by age + has-email, NOT by export status.
                         The legacy "Clear Exported" label was misleading and
                         could destroy un-exported user data. Renamed to match
                         the actual filter. Future PR may add proper exportedAt
                         tracking via DB migration v3. -->
                    <!-- UI-1 FIX (2026-05-10): inline onclick handlers were
                         blocked by MV3 default CSP (script-src 'self').
                         Bound via addEventListener in DOMContentLoaded below. -->
                    <button class="btn secondary" id="clearOldEmailedBtn">
                        🗑️ Clear Old Emailed Data (> 7 days)
                    </button>
                    <button class="btn secondary" id="clearOldBusinessesBtn">
                        ⏱️ Clear Old Data (> 30 days)
                    </button>
                    <button class="btn" style="background: #ef4444; color: white;" id="confirmClearAllBtn">
                        ⚠️ Clear ALL Data
                    </button>
                </div>
            </div>

            <!-- Chrome Quota Info -->
            <div class="storage-info-box">
                <h4>ℹ️ Chrome Storage Limits</h4>
                <ul style="font-size: 13px; color: #6b7280; line-height: 1.6;">
                    <li><strong>IndexedDB:</strong> Up to 60% of available disk space (can be 10GB+ on modern Macs)</li>
                    <li><strong>chrome.storage.local:</strong> 10 MB total (for settings)</li>
                    <li><strong>Persistence:</strong> Data remains after closing browser until manually cleared</li>
                    <li><strong>Automatic Cleanup:</strong> Chrome may clear data if disk space is critically low</li>
                </ul>
            </div>
        </div>

        <div class="modal-footer">
            <!-- UI-1 FIX: same MV3 CSP issue, bound via addEventListener.
                 Note id "closeStorageModalFooterBtn" to avoid collision with
                 the header X button id="closeStorageModalBtn" (line 18). -->
            <button class="btn primary" id="refreshStorageDetailsBtn">🔄 Refresh</button>
            <button class="btn secondary" id="closeStorageModalFooterBtn">Close</button>
        </div>
    </div>
</div>
`;

// Inject modal into page
document.addEventListener('DOMContentLoaded', () => {
    document.body.insertAdjacentHTML('beforeend', storageModalHTML);

    // Attach event listener to Details button (opens modal)
    const detailsBtn = document.getElementById('storageDetailsBtn');
    if (detailsBtn) {
        detailsBtn.addEventListener('click', openStorageModal);
    }

    // UI-1 FIX (2026-05-10): bind 6 modal buttons via addEventListener.
    // Pre-fix the cleanup buttons + footer Refresh/Close used inline onclick=
    // handlers blocked by MV3 default CSP (script-src 'self'), so the modal
    // had a non-responsive destructive-action panel. Additionally the header
    // X (id="closeStorageModalBtn") had an id but NO listener bound — also
    // dead. Both issues addressed here.
    //
    // The window.X exports below (line ~378) remain for backward-compat with
    // any external caller that may invoke them directly; they are no longer
    // required by the modal itself.
    const buttonBindings = [
        ['closeStorageModalBtn',       closeStorageModal],   // header X
        ['closeStorageModalFooterBtn', closeStorageModal],   // footer Close
        ['refreshStorageDetailsBtn',   refreshStorageDetails],
        ['clearOldEmailedBtn',         clearOldEmailedBusinesses],
        ['clearOldBusinessesBtn',      clearOldBusinesses],
        ['confirmClearAllBtn',         confirmClearAll],
    ];
    for (const [id, handler] of buttonBindings) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('click', handler);
        } else {
            // Defensive: log if HTML drifts from JS bindings.
            console.warn(`[storage-modal] missing button id: ${id}`);
        }
    }
});

/**
 * Open Storage Details Modal
 */
async function openStorageModal() {
    const modal = document.getElementById('storageModal');
    if (!modal) return;

    modal.style.display = 'flex';
    await refreshStorageDetails();
}

/**
 * Close Storage Details Modal
 */
function closeStorageModal() {
    const modal = document.getElementById('storageModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Refresh storage details
 */
async function refreshStorageDetails() {
    try {
        // Get storage estimate
        const estimate = await navigator.storage.estimate();

        // UI-8 FIX (2026-05-10): pre-fix `estimate.usage / estimate.quota` produced
        // NaN (when both undefined) or Infinity (when usage > 0 and quota === 0)
        // and rendered literally as "NaN%" / "Infinity%" in the modal. Edge cases:
        // private browsing on some platforms, ChromeOS profiles with quota
        // disabled, mocked navigator.storage in tests. Now we guard quota > 0
        // and surface "—" (em dash) when the percent cannot be computed —
        // honest "info unavailable" rather than a misleading "0%".
        const usage = typeof estimate.usage === 'number' ? estimate.usage : 0;
        const quota = typeof estimate.quota === 'number' ? estimate.quota : 0;
        const usedMB = (usage / (1024 * 1024)).toFixed(2);
        const quotaMB = quota > 0 ? (quota / (1024 * 1024)).toFixed(2) : null;
        const percent = quota > 0 ? Math.round((usage / quota) * 100) : null;

        // Update overview
        document.getElementById('detailTotalUsed').textContent = `${usedMB} MB`;
        document.getElementById('detailQuota').textContent = quotaMB !== null ? `${quotaMB} MB` : '—';
        document.getElementById('detailPercent').textContent = percent !== null ? `${percent}%` : '—';

        // Get database stats
        // UI-3 FIX (2026-05-11): use shared sendMessageWithTimeout from
        // ui/messaging.js so this call rejects after 15s instead of
        // hanging the modal forever if the SW is evicted mid-call.
        const statsResponse = await window.sendMessageWithTimeout({ action: 'get_stats' });
        // UI-02 FIX (2026-06-09): get_stats returns the FLAT getStatsWithQueue()
        // object (the sidepanel consumes stats.total directly). There is no
        // `.stats` wrapper, so `statsResponse?.stats` was always {} and the modal
        // showed "0 records / ~0.00 MB" regardless of actual DB contents.
        const stats = statsResponse || {};

        // ═══════════════════════════════════════════════════════════════════════════════
        // UI-009 FIX: Estimate IndexedDB size with documented calculation
        // Average business record includes: name(50), address(100), phone(15), 
        // email(50), website(80), category(40), placeId(50), timestamps(50), 
        // social links(150), metadata(200) ≈ 785 bytes → rounded to 800
        // This is a conservative estimate; actual size varies by data completeness
        // ═══════════════════════════════════════════════════════════════════════════════
        const avgRecordSize = 800; // bytes - see calculation above
        const indexedDBSizeMB = ((stats.total || 0) * avgRecordSize / (1024 * 1024)).toFixed(2);

        document.getElementById('indexedDBSize').textContent = `~${indexedDBSizeMB} MB`;
        document.getElementById('businessCount').textContent = `${stats.total || 0} records`;

        // chrome.storage.local is negligible (< 1MB)
        document.getElementById('chromeStorageSize').textContent = '< 1 MB';

    } catch (error) {
        console.error('Failed to refresh storage details:', error);
    }
}

/**
 * B10-1 P0 FIX (truthful labeling): clear businesses that are >7 days old
 * AND have an email. This is what the legacy `clearExportedBusinesses`
 * actually did — but its label and dialog said "exported", which was
 * misleading and could destroy un-exported user data.
 *
 * This function is renamed `clearOldEmailedBusinesses` to match its real
 * behavior. The UI button label and confirm dialog are updated to match.
 *
 * The legacy `clearExportedBusinesses` is preserved as a thin alias for
 * backward compatibility (in case anything was bound to `window.X`),
 * but routes to the same logic with the new dialog.
 *
 * Future PR: introduce DB migration v3 with `exportedAt` index for proper
 * export tracking. See HANDOFF_ULTRAREVIEW_BLOCKS.md Block 10 §B10-1.
 */
async function clearOldEmailedBusinesses() {
    const confirmed = confirm(
        'Delete businesses scraped MORE THAN 7 DAYS AGO that have an email?\n\n' +
        '⚠️ NOTE: This filter is age + email. It does NOT track export status.\n' +
        'Recently scraped businesses with emails will NOT be deleted.\n' +
        'Old businesses without emails will NOT be deleted.\n\n' +
        'This action cannot be undone.'
    );
    if (!confirmed) return;

    try {
        // B10-3 FIX (2026-05-10): server-side filter via cursor scan in SW.
        // Pre-fix this fetched ALL businesses (potentially 8MB+ IPC payload
        // on 10K+ DBs, risk of silent truncation at ~10MB Chrome limit) and
        // filtered client-side. Now SW returns only the URL identifiers —
        // bounded payload + bounded memory in the UI process.
        // UI-3 FIX (2026-05-11): SW-eviction-safe via shared helper.
        const response = await window.sendMessageWithTimeout({
            action: 'get_old_emailed_business_ids',
            payload: { daysAgo: 7 }
        });

        if (response?.status !== 'success') {
            alert('Failed to fetch candidates: ' + (response?.error || 'unknown error'));
            return;
        }

        const urls = response.urls || [];
        if (urls.length === 0) {
            alert('No old exported businesses found to clear.');
            return;
        }

        // UI-003 FIX: Use batch delete for O(1) network calls instead of O(n)
        // UI-3 FIX (2026-05-11): batch deletes can take time on large
        // datasets — bump timeout to 30s. The user has already confirmed
        // the destructive action so a longer wait is preferable to a
        // false "didn't work" signal.
        const result = await window.sendMessageWithTimeout({
            action: 'delete_business_batch',
            urls: urls
        }, 30000);

        // UI-2 FIX (2026-05-10): pre-fix accessed `result.deleted` without
        // checking that `result` is defined. When the SW is mid-eviction or
        // no listener responds, chrome.runtime.sendMessage resolves to
        // undefined; reading `.deleted` on it threw TypeError, swallowed by
        // the outer catch as "Failed to clear: Cannot read properties of
        // undefined" — a confusing message while the SW may have already
        // completed (or partially completed) the deletion. Explicit guard
        // surfaces a clean SW-unreachable message instead.
        if (!result) {
            alert('Failed to clear: service worker unreachable. Please retry in a moment.');
            return;
        }

        alert(`Deleted ${result.deleted ?? 0} old businesses with emails.`);
        await refreshStorageDetails();

    } catch (error) {
        alert('Failed to clear old emailed businesses: ' + error.message);
    }
}

// Backward-compat alias: legacy callers (e.g. older HTML or external code
// bound to window.clearExportedBusinesses) get the renamed function.
// Forwards to clearOldEmailedBusinesses with the corrected dialog.
async function clearExportedBusinesses() {
    return clearOldEmailedBusinesses();
}

/**
 * Clear businesses older than 30 days
 */
async function clearOldBusinesses() {
    // BROKEN CODE FIX: Fixed string escape sequences
    const confirmed = confirm('Delete all businesses older than 30 days?\n\nThis cannot be undone.');
    if (!confirmed) return;

    try {
        // B10-3 FIX (2026-05-10): server-side filter via cursor scan in SW.
        // Same rationale as clearExportedBusinesses — bounded IPC payload.
        // UI-3 FIX (2026-05-11): SW-eviction-safe via shared helper.
        const response = await window.sendMessageWithTimeout({
            action: 'get_old_business_ids',
            payload: { daysAgo: 30 }
        });

        if (response?.status !== 'success') {
            alert('Failed to fetch candidates: ' + (response?.error || 'unknown error'));
            return;
        }

        const urls = response.urls || [];
        if (urls.length === 0) {
            alert('No businesses older than 30 days found.');
            return;
        }

        // UI-003 FIX: Use batch delete for O(1) network calls instead of O(n)
        // UI-3 FIX (2026-05-11): 30s timeout for destructive batch op.
        const result = await window.sendMessageWithTimeout({
            action: 'delete_business_batch',
            urls: urls
        }, 30000);

        // UI-2 FIX (2026-05-10): same SW-unreachable guard as
        // clearOldEmailedBusinesses above.
        if (!result) {
            alert('Failed to clear: service worker unreachable. Please retry in a moment.');
            return;
        }

        alert(`Deleted ${result.deleted ?? 0} old businesses`);
        await refreshStorageDetails();

    } catch (error) {
        alert('Failed to clear old businesses: ' + error.message);
    }
}

/**
 * Confirm and clear all data
 */
async function confirmClearAll() {
    // BROKEN CODE FIX: Fixed string escape sequences
    const confirmed = confirm(
        '⚠️ WARNING: This will delete ALL data!\n\n' +
        '• All businesses\n' +
        '• All emails\n' +
        '• All scraping history\n\n' +
        'This action CANNOT be undone.\n\nAre you absolutely sure?'
    );

    if (!confirmed) return;

    const doubleConfirm = prompt('Type "DELETE ALL" to confirm:');
    if (doubleConfirm !== 'DELETE ALL') return;

    // B10-2 FIX (2026-05-10): pre-fix this was fire-and-forget — modal
    // closed immediately whether or not the SW actually cleared the DB.
    // If SW was in eviction race or returned an error, user saw "modal
    // closed → assume success" while the database remained intact —
    // silent failure on the most destructive operation in the UI.
    //
    // Now: await the SW response, surface success/failure to user, only
    // close modal on confirmed success. Try/catch absorbs runtime
    // exceptions (SW unreachable, port disconnected mid-flight).
    try {
        // UI-3 FIX (2026-05-11): clear_data wipes the entire IDB — on
        // 50K+ record datasets this can take 20-30s on cold SW. Use 60s
        // timeout; user has already passed two confirm gates so they're
        // committed. Without a timeout this used to hang indefinitely
        // on SW eviction, leaving the user with a frozen modal.
        const response = await window.sendMessageWithTimeout({ action: 'clear_data' }, 60000);
        // SW handler returns {status: 'success'} on completion. We tolerate
        // both shape variants for forward-compat: {status:'success'} or
        // {ok:true} or simply non-error truthy response.
        const ok = response && (
            response.status === 'success' ||
            response.ok === true ||
            (response.error === undefined && response.status !== 'error')
        );
        if (ok) {
            const count = (typeof response.count === 'number') ? response.count : null;
            alert(count !== null
                ? `✓ Deleted ${count} record${count === 1 ? '' : 's'}`
                : '✓ All data deleted'
            );
            closeStorageModal();
        } else {
            const errMsg = response?.error || response?.message || 'unknown error';
            alert(`✗ Failed to clear data: ${errMsg}`);
            // Modal stays open so user can retry or close manually.
        }
    } catch (err) {
        // Runtime/IPC error (SW dead, port disconnected, message timeout).
        alert(`✗ Failed to clear data: ${err?.message || err}`);
        // Modal stays open.
    }
}

// Export functions for use in main UI
window.openStorageModal = openStorageModal;
window.closeStorageModal = closeStorageModal;
window.refreshStorageDetails = refreshStorageDetails;
window.clearExportedBusinesses = clearExportedBusinesses;  // legacy alias (B10-1)
window.clearOldEmailedBusinesses = clearOldEmailedBusinesses;  // B10-1: truthful name
window.clearOldBusinesses = clearOldBusinesses;
window.confirmClearAll = confirmClearAll;
