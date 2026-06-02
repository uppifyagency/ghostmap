/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

// BLOCK-8 FIX (LOW-008): console.log used intentionally here because:
// 1. This runs BEFORE the logger module can be imported
// 2. We need to diagnose bootstrap failures that would prevent logger loading
// 3. These logs are critical for debugging content script injection issues
console.log('[CONTENT SCRIPT LOADER] Executing on:', window.location.href);
console.log('[CONTENT SCRIPT LOADER] Loading main content script...');

(async () => {
    try {
        const src = chrome.runtime.getURL('content/gmb/index.js');
        console.log('[CONTENT SCRIPT LOADER] Importing:', src);
        await import(src);
        console.log('[CONTENT SCRIPT LOADER] ✓ Main content script loaded successfully');
    } catch (error) {
        console.error('[CONTENT SCRIPT LOADER] ✗ Failed to load main content script:', error);
        console.error('[CONTENT SCRIPT LOADER] Error details:', {
            message: error.message,
            stack: error.stack
        });
    }
})();
