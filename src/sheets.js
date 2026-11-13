// Google Sheets client using a service account (no npm packages needed).
import crypto from 'node:crypto';
import { request } from './http.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** 0 -> A, 25 -> Z, 26 -> AA */
export function colLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export const quoteTab = (tab) => `'${tab.replace(/'/g, "''")}'`;

export function createSheetsClient({ serviceAccount, spreadsheetId }) {
  let token = null;
  let tokenExpires = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpires - 60_000) return token;
    const now = Math.floor(Date.now() / 1000);
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
      iss: serviceAccount.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), serviceAccount.private_key).toString('base64url');
    const data = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
      label: 'Google sign-in',
    });
    token = data.access_token;
    tokenExpires = Date.now() + data.expires_in * 1000;
    return token;
  }

  async function call(path, { method = 'GET', body, label } = {}) {
    return request(`${API}/${spreadsheetId}${path}`, {
      method,
      body,
      headers: { Authorization: `Bearer ${await getToken()}` },
      label: label ?? `Google Sheets ${method} ${path.split('?')[0]}`,
    });
  }

  const valuesPath = (range) => `/values/${encodeURIComponent(range)}`;

  return {
    async readHeader(tab) {
      const data = await call(valuesPath(`${quoteTab(tab)}!1:1`));
      return (data?.values?.[0] ?? []).map((h) => String(h).trim());
    },

    /**
     * All rows of a tab, header included. fromCol/toCol (0-based) limit the columns.
     * unformatted=true returns raw numbers (dates come back as serial numbers).
     */
    async readTab(tab, { fromCol, toCol, unformatted = false } = {}) {
      const range = fromCol == null ? quoteTab(tab) : `${quoteTab(tab)}!${colLetter(fromCol)}:${colLetter(toCol ?? fromCol)}`;
      const query = unformatted ? '?valueRenderOption=UNFORMATTED_VALUE' : '';
      const data = await call(valuesPath(range) + query);
      return data?.values ?? [];
    },

    /** cells: [{ row (1-based), col (0-based), value }]. Typed as if entered by hand. */
    async writeCells(tab, cells) {
      if (!cells.length) return;
      await call('/values:batchUpdate', {
        method: 'POST',
        body: {
          valueInputOption: 'USER_ENTERED',
          data: cells.map((c) => ({ range: `${quoteTab(tab)}!${colLetter(c.col)}${c.row}`, values: [[c.value]] })),
        },
      });
    },

    /** Adds the tab if the spreadsheet doesn't have it yet. */
    async ensureTab(tab) {
      const meta = await call('?fields=sheets.properties.title');
      if ((meta?.sheets ?? []).some((s) => s.properties.title === tab)) return;
      await call(':batchUpdate', { method: 'POST', body: { requests: [{ addSheet: { properties: { title: tab } } }] } });
    },

    /** Clears the tab and writes these rows from A1. */
    async replaceTab(tab, rows) {
      await call(`${valuesPath(quoteTab(tab))}:clear`, { method: 'POST', body: {} });
      await call(`${valuesPath(`${quoteTab(tab)}!A1`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: rows } });
    },

    /** Adds rows after the last row of the tab. Typed as if entered by hand. */
    async appendRows(tab, rows) {
      if (!rows.length) return;
      await call(`${valuesPath(`${quoteTab(tab)}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: { values: rows },
      });
    },
  };
}
