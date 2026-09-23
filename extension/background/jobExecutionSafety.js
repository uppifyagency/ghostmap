export const JOB_TIMEOUT_ERROR_CODE = 'JOB_TIMEOUT';
export const DEFAULT_JOB_TIMEOUT_MS = 300000;
export const DEFAULT_ACTIVE_JOB_REAPER_INTERVAL_MS = 60000;
export const DEFAULT_ACTIVE_JOB_MAX_AGE_MS = 300000;

export function createJobTimeoutError({ jobId = 'unknown', timeoutMs = 0, lastStep = null } = {}) {
    const error = new Error(`Job ${jobId} timed out after ${timeoutMs}ms${lastStep ? ` (last step: ${lastStep})` : ''}`);
    error.name = 'JobTimeoutError';
    error.code = JOB_TIMEOUT_ERROR_CODE;
    error.jobId = jobId;
    error.timeoutMs = timeoutMs;
    error.lastStep = lastStep;
    return error;
}

export function startTimedOperation(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('startTimedOperation requires a function');

    const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError('timeoutMs must be a positive finite number');
    }

    let settled = false;
    let timedOut = false;
    let timer = null;
    let resolveOperation;
    let rejectOperation;

    const promise = new Promise((resolve, reject) => {
        resolveOperation = resolve;
        rejectOperation = reject;
    });

    const expire = () => {
        if (settled) return false;
        settled = true;
        timedOut = true;
        if (timer !== null) clearTimeout(timer);
        const lastStep = typeof options.lastStep === 'function'
            ? options.lastStep()
            : (options.lastStep ?? null);
        const error = createJobTimeoutError({
            jobId: options.jobId,
            timeoutMs,
            lastStep
        });
        try {
            options.onTimeout?.(error);
        } catch {
            // Timeout settlement must not depend on observer behavior.
        }
        rejectOperation(error);
        return true;
    };

    timer = setTimeout(expire, timeoutMs);

    Promise.resolve()
        .then(fn)
        .then(
            value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolveOperation(value);
            },
            error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                rejectOperation(error);
            }
        );

    return {
        promise,
        expire,
        isSettled: () => settled,
        didTimeout: () => timedOut
    };
}

export function findStaleActiveJobs(activeJobs, options = {}) {
    const now = options.now ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_ACTIVE_JOB_MAX_AGE_MS;
    if (!Number.isFinite(now)) throw new RangeError('now must be finite');
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
        throw new RangeError('maxAgeMs must be a positive finite number');
    }

    const entries = activeJobs instanceof Map
        ? activeJobs.values()
        : (activeJobs ?? []);

    return Array.from(entries).filter(job => {
        const startedAt = job?.startedAt;
        return Number.isFinite(startedAt) && now >= startedAt && now - startedAt >= maxAgeMs;
    });
}
