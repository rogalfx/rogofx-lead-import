// Small fetch wrapper: JSON in/out, retries on 429 and 5xx with backoff.

export class HttpError extends Error {
  constructor(label, status, data) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    super(`${label} failed with HTTP ${status}: ${detail?.slice(0, 500)}`);
    this.status = status;
    this.data = data;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const backoff = (attempt) => Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);

export async function request(url, { method = 'GET', headers = {}, body, retries = 5, label = url } = {}) {
  const hasBody = body !== undefined;
  const init = {
    method,
    headers: hasBody ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  };

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= retries) throw new Error(`${label} network error: ${err.message}`);
      await sleep(backoff(attempt));
      continue;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      continue;
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) throw new HttpError(label, res.status, data);
    return data;
  }
}
