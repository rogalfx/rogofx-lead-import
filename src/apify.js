// Apify client: start the Google Maps scraper, wait for it, read the results.
import { HttpError, request, sleep } from './http.js';

const API = 'https://api.apify.com/v2';
const DONE = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
const money = (n) => `$${Number(n).toFixed(2)}`;

/** Apify won't run anything until the monthly spending limit is raised or the cycle resets. */
export class ApifyLimitError extends Error {
  constructor(usage) {
    const used = usage ? ` (${money(usage.usedUsd)} of ${money(usage.limitUsd)} used this month)` : '';
    const reset = usage?.resetsAt ? ` until the cycle resets on ${String(usage.resetsAt).slice(0, 10)}` : ' until the monthly cycle resets';
    super(
      `Apify monthly spending limit reached${used}. Apify blocks every scrape${reset}. ` +
        'Raise the limit at https://console.apify.com/billing/limits or wait for the reset. ' +
        'Counties that were not scraped are left as they were in the Coverage Log.',
    );
    this.usage = usage;
  }
}

const isLimitRefusal = (err) =>
  err instanceof HttpError &&
  (err.status === 402 || err.status === 403) &&
  /platform-feature-disabled|monthly usage limit/i.test(JSON.stringify(err.data ?? ''));

export function createApifyClient({
  token,
  actor,
  maxWaitMinutes = 45,
  runTimeoutSecs = 0,
  pollPauseMs = 0,
  memoryRetryMs = 30_000,
  minUsdLeft = null,
}) {
  const headers = { Authorization: `Bearer ${token}` };
  const actorPath = encodeURIComponent(actor.replace('/', '~'));
  const runQuery = runTimeoutSecs ? `?timeout=${runTimeoutSecs}` : '';

  /** This month's spend against the limit, or null if Apify won't say. */
  async function usage() {
    try {
      const res = await request(`${API}/users/me/limits`, { headers, retries: 2, label: 'Apify usage' });
      const data = res?.data;
      const limitUsd = Number(data?.limits?.maxMonthlyUsageUsd);
      const usedUsd = Number(data?.current?.monthlyUsageUsd);
      if (!Number.isFinite(limitUsd) || !Number.isFinite(usedUsd)) return null;
      return { usedUsd, limitUsd, leftUsd: limitUsd - usedUsd, resetsAt: data?.monthlyUsageCycle?.endAt ?? null };
    } catch {
      return null;
    }
  }

  /** Turns Apify's "limit reached" refusal into a plain ApifyLimitError. */
  async function limitAware(fn) {
    try {
      return await fn();
    } catch (err) {
      if (isLimitRefusal(err)) throw new ApifyLimitError(await usage());
      throw err;
    }
  }

  return {
    usage,

    /** Runs the actor and waits. Returns { status, runId, datasetId }. */
    async run(input) {
      // Don't start a scrape that the monthly limit would cut off halfway (and still bill).
      if (minUsdLeft != null) {
        const u = await usage();
        if (u && u.leftUsd < minUsdLeft) throw new ApifyLimitError(u);
      }
      const deadline = Date.now() + maxWaitMinutes * 60_000;
      let started;
      for (;;) {
        try {
          started = await limitAware(() =>
            request(`${API}/acts/${actorPath}/runs${runQuery}`, {
              method: 'POST',
              headers,
              body: input,
              label: 'Apify start run',
            }),
          );
          break;
        } catch (err) {
          // Plan's memory is full because other scrapes are running: wait for one to finish.
          const memoryFull = err instanceof HttpError && err.status === 402 && /memory/i.test(JSON.stringify(err.data));
          if (!memoryFull || Date.now() > deadline) throw err;
          await sleep(memoryRetryMs);
        }
      }
      let run = started.data;

      while (!DONE.has(run.status)) {
        if (Date.now() > deadline) {
          await request(`${API}/actor-runs/${run.id}/abort`, { method: 'POST', headers, label: 'Apify abort run' }).catch(() => {});
          return { status: 'TOO-SLOW', runId: run.id, datasetId: run.defaultDatasetId };
        }
        if (pollPauseMs) await sleep(pollPauseMs);
        const polled = await request(`${API}/actor-runs/${run.id}?waitForFinish=60`, { headers, label: 'Apify check run' });
        run = polled.data;
      }
      return { status: run.status, runId: run.id, datasetId: run.defaultDatasetId };
    },

    /** Number of items in a dataset. */
    async datasetSize(datasetId) {
      const res = await limitAware(() => request(`${API}/datasets/${datasetId}`, { headers, label: 'Apify dataset info' }));
      return Number(res?.data?.itemCount) || 0;
    },

    /** One page of a dataset, in order. */
    async getItemsPage(datasetId, offset, limit) {
      return limitAware(() =>
        request(`${API}/datasets/${datasetId}/items?clean=true&format=json&limit=${limit}&offset=${offset}`, {
          headers,
          label: 'Apify read results',
        }),
      );
    },

    /** A JSON record from a key-value store, or null if it isn't there yet. */
    async getRecord(storeId, key) {
      try {
        return await request(`${API}/key-value-stores/${storeId}/records/${encodeURIComponent(key)}`, { headers, label: 'Apify read record' });
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },

    async setRecord(storeId, key, value) {
      await request(`${API}/key-value-stores/${storeId}/records/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers,
        body: value,
        label: 'Apify save record',
      });
    },

    /** All items in a dataset. Throws HttpError 404 if the dataset has expired. */
    async getItems(datasetId) {
      const items = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const page = await limitAware(() =>
          request(`${API}/datasets/${datasetId}/items?clean=true&format=json&limit=${pageSize}&offset=${offset}`, {
            headers,
            label: 'Apify read results',
          }),
        );
        items.push(...page);
        if (page.length < pageSize) return items;
      }
    },
  };
}
