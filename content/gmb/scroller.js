/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Scroller (Simplified for Manual Mode)
 * 
 * BLOCK-8 FIX (LOW-007): This file is INTENTIONALLY kept as a utility stub.
 * It provides useful helper functions (scrollToTop, scrollToBottom, isAtEnd)
 * that may be used for future features. Not removing to preserve API.
 */

import { logger } from '../../lib/utils.js';

export class HumanScroller {
    // M5-DETECT6: Scroll speed limits to match human behavior
    static MIN_SCROLL_EVENTS_PER_SECOND = 1;
    static MAX_SCROLL_EVENTS_PER_SECOND = 3;

    constructor(containerSelector) {
        this.containerSelector = containerSelector;
        this.isScrolling = false;
        this._scrollEventTimestamps = [];
        this.minScrollEventsPerSecond = HumanScroller.MIN_SCROLL_EVENTS_PER_SECOND;
        this.maxScrollEventsPerSecond = HumanScroller.MAX_SCROLL_EVENTS_PER_SECOND;
        logger.info('Scroller initialized (manual mode - not used)');
    }

    /**
     * M5-DETECT6: Record a scroll event and check if it should be throttled
     * Enforces max 3 scroll events per second to match human behavior
     * @returns {boolean} true if allowed, false if throttled
     */
    recordScrollEvent() {
        const now = Date.now();
        // Remove timestamps older than 1 second
        this._scrollEventTimestamps = this._scrollEventTimestamps.filter(
            t => now - t < 1000
        );
        // Throttle if exceeding max events per second
        if (this._scrollEventTimestamps.length >= this.maxScrollEventsPerSecond) {
            return false;
        }
        this._scrollEventTimestamps.push(now);
        return true;
    }

    /**
     * Get the configured scroll speed bounds
     * @returns {{ minEventsPerSecond: number, maxEventsPerSecond: number }}
     */
    getScrollSpeedBounds() {
        return {
            minEventsPerSecond: this.minScrollEventsPerSecond,
            maxEventsPerSecond: this.maxScrollEventsPerSecond
        };
    }

    /**
     * Start scrolling (not used in manual mode)
     */
    async start() {
        logger.info('Auto-scroll not available in manual mode. Please scroll manually.');
        return;
    }

    /**
     * Stop scrolling
     */
    stop() {
        this.isScrolling = false;
        logger.info('Scroller stopped');
    }

    /**
     * Check if at end of list
     */
    isAtEnd() {
        const container = document.querySelector(this.containerSelector);
        if (!container) return false;

        const threshold = 50;
        return container.scrollTop + container.clientHeight >= container.scrollHeight - threshold;
    }

    /**
     * Scroll to top (utility function)
     */
    scrollToTop() {
        const container = document.querySelector(this.containerSelector);
        if (container) {
            container.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    /**
     * Scroll to bottom (utility function)
     */
    scrollToBottom() {
        const container = document.querySelector(this.containerSelector);
        if (container) {
            container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        }
    }
}

export default HumanScroller;
