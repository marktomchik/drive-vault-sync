import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

const REQUEST_RETRY_COUNT = 3;
const REQUEST_RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 60000;

export async function requestGoogleUrl(options: RequestUrlParam): Promise<RequestUrlResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REQUEST_RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => window.setTimeout(resolve, REQUEST_RETRY_DELAY_MS * attempt));
    }
    try {
      return await withTimeout(requestUrl(options), REQUEST_TIMEOUT_MS, options.url);
    } catch (error) {
      lastError = error;
      if ((isDnsResolutionError(error) || isTimeoutError(error)) && attempt < REQUEST_RETRY_COUNT - 1) continue;
      throw error;
    }
  }
  throw lastError;
}

/**
 * requestUrl() has no abort/timeout support, so a stalled connection (e.g. a network blip mid-transfer)
 * can leave its promise pending forever, silently freezing the whole sync with no error and no progress.
 * Racing it against a timer bounds the wait; the underlying request may still finish in the background,
 * which is harmless since we stop relying on its result once we've moved on to a retry.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(timeoutError(url, ms)), ms);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
    );
  });
}

function timeoutError(url: string, ms: number): Error & { status?: number } {
  const error = new Error(`Google Drive request timed out after ${ms}ms: ${url}`) as Error & { status?: number };
  error.status = 504;
  return error;
}

export function formatRequestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isDnsResolutionError(error: unknown): boolean {
  return /UnknownHostException|Unable to resolve host|ERR_NAME_NOT_RESOLVED/i.test(formatRequestError(error));
}

export function isTimeoutError(error: unknown): boolean {
  return /Google Drive request timed out/.test(formatRequestError(error));
}
