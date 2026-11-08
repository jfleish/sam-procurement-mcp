import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

export class UserError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function readText(stream, maxBytes) {
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for await (const chunk of stream ?? []) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new UserError('Response exceeded the size limit. Narrow the request.');
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export function createRequester(fetcher = fetch) {
  const cache = new Map();
  const inFlight = new Map();

  return async function request(source, url, { body, allowMissing = false, fresh = false } = {}) {
    const secret = source === 'SAM.gov' ? url.searchParams.get('api_key') : null;
    const key = createHash('sha256').update(JSON.stringify([url.href, body, allowMissing])).digest('hex');
    const cached = cache.get(key);
    if (!fresh && cached?.expires > Date.now()) return cached.result;
    if (inFlight.has(key)) return inFlight.get(key);
    if (inFlight.size >= 8) throw new UserError('Too many requests are running. Try again shortly.');
    const pending = (async () => {
      let response;
      let data;
      let authError = '';
      try {
        const options = {
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
          ...(body && {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          })
        };
        response = await fetcher(url, options);
        if (source === 'USAspending' && [502, 503, 504].includes(response.status) && !response.headers.has('retry-after')) {
          await response.body?.cancel();
          await delay(750, undefined, { signal: options.signal });
          response = await fetcher(url, options);
        }
        if (response.ok) {
          const raw = await readText(response.body, 4 * 1024 * 1024);
          data = JSON.parse(raw, secret ? (_name, value) =>
            typeof value === 'string' ? value.replaceAll(secret, '[redacted]') : value : undefined);
        } else if (source === 'SAM.gov' && [400, 403].includes(response.status)) {
          // Inspect known gateway indicators without returning any upstream error text.
          authError = await readText(response.body, 16_384).catch(() => '');
        } else {
          await response.body?.cancel();
        }
      } catch (error) {
        if (error instanceof UserError) throw error;
        if (error instanceof SyntaxError) throw new UserError(`${source} returned invalid JSON.`, 'upstream_error');
        throw new UserError(`Could not reach ${source} or read its response. Check your connection and try again.`, 'unreachable');
      }
      if (response.status === 429 || /OVER_RATE_LIMIT|API_KEY_RATE_LIMIT|rate limit exceeded/i.test(authError)) {
        throw new UserError(`${source} rate limit reached. Wait for your quota to reset before retrying.`, 'rate_limited');
      }
      if (response.status === 401 || response.status === 403 ||
        /API_KEY_INVALID|invalid api[_ -]?key|API_KEY_MISSING/i.test(authError)) {
        const advice = source === 'SAM.gov'
          ? ' Check API permissions in SAM.gov Account Details. Run sam-procurement-mcp setup to replace the key.' : '';
        throw new UserError(`${source} rejected the request (HTTP ${response.status}).${advice}`, 'authentication_failed');
      }
      if (!response.ok && !(allowMissing && response.status === 404)) {
        throw new UserError(`${source} request failed (HTTP ${response.status}). Check your filters or try again later.`, 'upstream_error');
      }
      if (response.ok && data === null) throw new UserError(`${source} returned an empty JSON result.`);
      const result = { data: data ?? null, retrievedAt: new Date().toISOString() };
      cache.delete(key);
      cache.set(key, { result, expires: Date.now() + 5 * 60_000 });
      if (cache.size > 24) cache.delete(cache.keys().next().value);
      return result;
    })();
    inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(key);
    }
  };
}
