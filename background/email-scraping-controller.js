/**
 * Email Scraping Controller
 * Extracted from background/index.js for testability.
 * Controls email scraping lifecycle including keep-alive alarm management.
 */

import { logger } from '../lib/utils.js';

/**
 * Creates an email scraping controller with injected dependencies.
 * @param {Object} deps - Dependencies
 * @param {Object} deps.jobQueue - The job queue instance
 * @param {Object} deps.chromeAlarms - The chrome.alarms API
 * @returns {Object} Controller with stopEmailScraping method
 */
export function createEmailScrapingController({ jobQueue, chromeAlarms }) {

    function stopKeepAlive() {
        chromeAlarms.clear('keepalive');
        logger.debug('[KEEPALIVE] Stopped');
    }

    function stopEmailScraping() {
        jobQueue.pause();
        stopKeepAlive();
        logger.info('Email scraping paused');
        return { status: 'paused' };
    }

    return {
        stopEmailScraping,
        stopKeepAlive
    };
}
