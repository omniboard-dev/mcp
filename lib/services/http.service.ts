const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_IDEMPOTENT_RETRIES = 2;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  const method = init.method?.toUpperCase() ?? 'GET';
  const operation = `${method} ${url.origin}${url.pathname}`;
  const retryCount = ['GET', 'HEAD'].includes(method)
    ? readNonNegativeInteger(
        process.env.OMNIBOARD_PROVIDER_IDEMPOTENT_RETRIES,
        DEFAULT_IDEMPOTENT_RETRIES
      )
    : 0;
  const maxAttempts = retryCount + 1;
  const timeoutMs = readPositiveInteger(
    process.env.OMNIBOARD_PROVIDER_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (
        attempt < maxAttempts &&
        RETRYABLE_HTTP_STATUSES.has(response.status)
      ) {
        await response.body?.cancel();
        await waitBeforeRetry(attempt);
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      if (attempt < maxAttempts) {
        await waitBeforeRetry(attempt);
        continue;
      }
      const reason = controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : describeTransportError(error);
      throw new Error(`Provider ${operation} transport failed: ${reason}`);
    }
  }

  throw new Error(`Provider ${operation} exhausted its retry budget`);
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function waitBeforeRetry(attempt: number) {
  const baseDelayMs = Math.min(2_000, 250 * 2 ** (attempt - 1));
  const jitterMs = Math.floor(Math.random() * 100);
  return new Promise<void>((resolve) =>
    setTimeout(resolve, baseDelayMs + jitterMs)
  );
}

function describeTransportError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string } | undefined;
  return cause?.code ? `${error.message} (${cause.code})` : error.message;
}
