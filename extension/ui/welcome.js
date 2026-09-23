/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Welcome page script
 */

document.addEventListener('DOMContentLoaded', () => {
    const startButton = document.getElementById('getStartedBtn');

    if (startButton) {
        startButton.addEventListener('click', getStarted);
    }
});

function getStarted() {
    chrome.tabs.create({
        url: 'https://www.google.com/maps'
    }).then(() => {
        window.close();
    }).catch(err => {
        console.error('Failed to open Google Maps:', err);
    });
}
