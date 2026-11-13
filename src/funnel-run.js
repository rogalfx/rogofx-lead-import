// npm run funnel: reads GHL, prints the funnel and writes it to the "Funnel" tab (created if missing).
import { appendFile, readFile } from 'node:fs/promises';
import { computeFunnel, FUNNEL_HEADER, funnelRows } from './funnel.js';
import { createGhlClient } from './ghl.js';
import { createSheetsClient } from './sheets.js';

try {
  process.loadEnvFile();
} catch {}

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const ghl = createGhlClient({ token: process.env.GHL_TOKEN, locationId: process.env.GHL_LOCATION_ID });
const [pipelines, contacts, opportunities] = [await ghl.pipelines(), await ghl.allContacts(), await ghl.allOpportunities()];
const rows = funnelRows(computeFunnel({ contacts, opportunities, pipelines, config }));
const updated = new Date().toISOString().slice(0, 16).replace('T', ' ');
const table = [FUNNEL_HEADER, ...rows];
const text = table.map((r) => r.join(' | ')).join('\n');
console.log(`Funnel (${contacts.length} contacts, ${opportunities.length} opportunities, ${updated} UTC)\n${text}`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Funnel\n\n\`\`\`\n${text}\n\`\`\`\n`);

if (process.env.SHEET_ID && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE)) {
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_FILE
    ? JSON.parse(await readFile(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'))
    : JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim().startsWith('{') ? process.env.GOOGLE_SERVICE_ACCOUNT_JSON : Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8'));
  const sheetId = process.env.SHEET_ID.match(/\/d\/([\w-]+)/)?.[1] ?? process.env.SHEET_ID.trim();
  const sheets = createSheetsClient({ serviceAccount: sa, spreadsheetId: sheetId });
  const tab = config.funnel.tab;
  await sheets.ensureTab(tab);
  await sheets.replaceTab(tab, [[`Updated ${updated} UTC by the nightly job. Don't edit: it's rewritten every night.`], [], ...table]);
  console.log(`Written to the "${tab}" tab.`);
}
