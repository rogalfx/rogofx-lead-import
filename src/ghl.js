// GoHighLevel (LeadConnector) API v2 client.
// Never updates existing contacts: the pipeline checks for a duplicate first and only creates new ones.
import { HttpError, request, sleep } from './http.js';

const API = 'https://services.leadconnectorhq.com';
// GHL allows 100 requests per 10 seconds per location. Stay under it.
const MIN_GAP_MS = 120;

export function createGhlClient({ token, locationId, workflowId }) {
  const headers = { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json' };
  let lastCall = 0;

  async function call(path, opts) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return request(`${API}${path}`, { headers, ...opts });
  }

  return {
    // Optional. Make never added contacts to a workflow (a GHL trigger does it),
    // so leave GHL_WORKFLOW_ID empty unless that changes.
    workflowId: workflowId || null,

    /** Returns the existing contact's id, or null. */
    async findDuplicate({ phone, email }) {
      const params = new URLSearchParams({ locationId });
      if (phone) params.set('number', phone);
      if (email) params.set('email', email);
      const data = await call(`/contacts/search/duplicate?${params}`, { label: 'GHL duplicate check' });
      return data?.contact?.id ?? null;
    },

    /** Returns { id, duplicate }. duplicate=true means GHL refused because it already exists. */
    async createContact(fields) {
      try {
        const data = await call('/contacts/', {
          method: 'POST',
          body: { ...fields, locationId },
          label: 'GHL create contact',
        });
        return { id: data.contact.id, duplicate: false };
      } catch (err) {
        const message = JSON.stringify(err.data ?? '').toLowerCase();
        if (err instanceof HttpError && err.status === 400 && message.includes('duplicate')) {
          return { id: err.data?.meta?.contactId ?? null, duplicate: true };
        }
        throw err;
      }
    },

    /** Puts a contact in a pipeline stage (an open opportunity). GHL workflows can start on this. */
    async createOpportunity({ pipelineId, stageId, contactId, name }) {
      const data = await call('/opportunities/', {
        method: 'POST',
        body: { locationId, pipelineId, pipelineStageId: stageId, contactId, name, status: 'open' },
        label: 'GHL add to pipeline',
      });
      return data?.opportunity?.id ?? null;
    },

    /** Read-only, for the funnel report. */
    async pipelines() {
      const data = await call(`/opportunities/pipelines?locationId=${locationId}`, { label: 'GHL pipelines' });
      return data?.pipelines ?? [];
    },

    async allContacts() {
      const out = [];
      let searchAfter;
      for (;;) {
        const body = { locationId, pageLimit: 500, ...(searchAfter ? { searchAfter } : {}) };
        const data = await call('/contacts/search', { method: 'POST', body, label: 'GHL list contacts' });
        const page = data?.contacts ?? [];
        out.push(...page);
        searchAfter = page.at(-1)?.searchAfter;
        if (page.length < 500 || !searchAfter) return out;
      }
    },

    async allOpportunities() {
      const out = [];
      let path = `/opportunities/search?location_id=${locationId}&limit=100`;
      while (path) {
        const data = await call(path, { label: 'GHL list opportunities' });
        const page = data?.opportunities ?? [];
        out.push(...page);
        const next = data?.meta?.nextPageUrl;
        path = next && page.length ? next.replace(API, '') : null;
      }
      return out;
    },

    async addToWorkflow(contactId) {
      await call(`/contacts/${contactId}/workflow/${workflowId}`, {
        method: 'POST',
        body: {},
        label: 'GHL add to workflow',
      });
    },
  };
}
