// Entry point: reads settings and secrets, runs the nightly job, reports the result.
import { appendFile, readFile } from 'node:fs/promises';
import { createApifyClient } from './apify.js';
import { createGhlClient } from './ghl.js';
import { runPipeline } from './pipeline.js';
import { createSheetsClient } from './sheets.js';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const toNumber = (v) => (v === undefined || v === '' ? null : Number(v));

try {
  process.loadEnvFile(); // local runs read .env; GitHub passes secrets as env vars
} catch {}

const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const limit = toNumber(option('--limit') ?? process.env.LIMIT);
const maxLocations = toNumber(option('--max-locations') ?? process.env.MAX_LOCATIONS);

function need(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')}. See README.md, setup step 3.`);
}

function findPlaceholders(value, path = 'config') {
  if (typeof value === 'string') return value.includes('REPLACE') ? [path] : [];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => findPlaceholders(v, `${path}.${k}`));
  return [];
}

async function loadServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    return JSON.parse(await readFile(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
  }
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
  return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
}

function report(summary) {
  const lines = [
    `Status: ${summary.status}`,
    `New contacts created in GHL: ${summary.newContacts ?? 0}`,
    `Already added earlier today: ${summary.alreadyToday ?? 0}`,
    `Coverage Log rows finished: ${summary.locationsFinished?.length ?? 0}`,
    `Coverage Log rows still waiting: ${summary.pendingLocations ?? '?'}`,
  ];
  const b = summary.backlog;
  if (b) {
    const left = Math.max(0, b.total - b.offset);
    lines.push(`Paid backlog: ${summary.backlogContacts ?? 0} new contacts tonight, ${left} of ${b.total} leads left${left ? '' : ' (finished: scraping new counties)'}`);
  }
  const u = summary.apifyUsage;
  if (u) lines.push(`Apify this month: $${u.usedUsd.toFixed(2)} of $${u.limitUsd.toFixed(2)} limit used, resets ${String(u.resetsAt ?? '?').slice(0, 10)}`);
  for (const [reason, n] of Object.entries(summary.skipped ?? {})) lines.push(`Skipped (${reason}): ${n}`);
  if (summary.partialRows?.length) lines.push(`Half done, finish next run: rows ${summary.partialRows.join(', ')}`);
  if (summary.apifyFailures?.length) lines.push(`Apify failures: ${summary.apifyFailures.join(', ')}`);
  if (summary.newCategories?.length) lines.push(`Categories not on your Categories tab (contacted anyway): ${summary.newCategories.join(', ')}`);
  if (summary.enrollFailed?.length) lines.push(`Created but NOT in the workflow (add by hand): ${summary.enrollFailed.join(', ')}`);
  for (const note of summary.notes ?? []) lines.push(`Note: ${note}`);
  if (summary.preview) lines.push(`Next rows and the Apify input they would use:\n${JSON.stringify(summary.preview, null, 2)}`);
  return lines.join('\n');
}

async function main() {
  const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  const unfilled = findPlaceholders(config);
  if (unfilled.length) throw new Error(`Fill in config.json first: ${unfilled.join(', ')}`);

  need(['SHEET_ID', process.env.GOOGLE_SERVICE_ACCOUNT_FILE ? 'GOOGLE_SERVICE_ACCOUNT_FILE' : 'GOOGLE_SERVICE_ACCOUNT_JSON']);
  if (!dryRun) need(['APIFY_TOKEN', 'GHL_TOKEN', 'GHL_LOCATION_ID']);

  const sheetId = process.env.SHEET_ID.match(/\/d\/([\w-]+)/)?.[1] ?? process.env.SHEET_ID.trim();
  const sheets = createSheetsClient({ serviceAccount: await loadServiceAccount(), spreadsheetId: sheetId });
  const apify = createApifyClient({
    token: process.env.APIFY_TOKEN,
    actor: config.apify.actor,
    maxWaitMinutes: config.apify.maxWaitMinutes,
    minUsdLeft: config.apify.stopBelowUsd ?? null,
  });
  const ghl = createGhlClient({
    token: process.env.GHL_TOKEN,
    locationId: process.env.GHL_LOCATION_ID,
    workflowId: process.env.GHL_WORKFLOW_ID,
  });

  let summary;
  let exitCode = 0;
  try {
    summary = await runPipeline({ config, sheets, apify, ghl, options: { dryRun, limit, maxLocations } });
  } catch (err) {
    summary = err.summary ?? { status: `error: ${err.message}` };
    console.error(`::error::${err.message}`);
    exitCode = 1;
  }

  const text = report(summary);
  console.log(`\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Nightly lead import\n\n\`\`\`\n${text}\n\`\`\`\n`);
  }
  if (summary.status === 'ran out of locations' && config.alertWhenOutOfLocations) {
    // A failed run makes GitHub email you, which is the reminder to add more locations.
    console.error('::error::Ran out of Coverage Log rows before reaching the daily limit. Add more rows marked "Not run".');
    exitCode = exitCode || 2;
  }
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exitCode = 1;
});
