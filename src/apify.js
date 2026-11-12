// Apify client: start the Google Maps scraper, wait for it, read the results.
import { HttpError, request, sleep } from './http.js';

const API = 'https://api.apify.com/v2';
const DONE = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

export function createApifyClient({ token, actor, maxWaitMinutes = 45, runTimeoutSecs = 0, pollPauseMs = 0, memoryRetryMs = 30_000 }) {
  const headers = { Authorization: `Bearer ${token}` };
  const actorPath = encodeURIComponent(actor.replace('/', '~'));
  const runQuery = runTimeoutSecs ? `?timeout=${runTimeoutSecs}` : '';

  return {
    /** Runs the actor and waits. Returns { status, runId, datasetId }. */
    async run(input) {
      const deadline = Date.now() + maxWaitMinutes * 60_000;
      let started;
      for (;;) {
        try {
          started = await request(`${API}/acts/${actorPath}/runs${runQuery}`, {
            method: 'POST',
            headers,
            body: input,
            label: 'Apify start run',
          });
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

    /** All items in a dataset. Throws HttpError 404 if the dataset has expired. */
    async getItems(datasetId) {
      const items = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const page = await request(
          `${API}/datasets/${datasetId}/items?clean=true&format=json&limit=${pageSize}&offset=${offset}`,
          { headers, label: 'Apify read results' },
        );
        items.push(...page);
        if (page.length < pageSize) return items;
      }
    },
  };
}
