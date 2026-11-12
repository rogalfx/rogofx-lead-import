import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, test } from 'node:test';
import { createApifyClient } from '../src/apify.js';
import { createGhlClient } from '../src/ghl.js';
import { cleanName, dateSerial, fillTemplate, phoneKey, placeToContact } from '../src/mapping.js';
import { colLetter, createSheetsClient, quoteTab } from '../src/sheets.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with a list of canned responses and records the calls. */
function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request: ${url}`);
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    });
  };
  return calls;
}

test('GHL: duplicate check sends the right headers and returns the existing id', async () => {
  const calls = stubFetch([{ body: { contact: { id: 'abc123' } } }, { body: { contact: null } }]);
  const ghl = createGhlClient({ token: 'tok', locationId: 'loc1', workflowId: 'wf1' });

  assert.equal(await ghl.findDuplicate({ phone: '+12145550000' }), 'abc123');
  assert.equal(await ghl.findDuplicate({ phone: '+12145550001' }), null);

  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://services.leadconnectorhq.com/contacts/search/duplicate');
  assert.equal(url.searchParams.get('locationId'), 'loc1');
  assert.equal(url.searchParams.get('number'), '+12145550000');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].headers.Version, '2021-07-28');
});

test('GHL: create returns the new id, and a "duplicate" refusal is reported as existing', async () => {
  const calls = stubFetch([
    { body: { contact: { id: 'new1' } } },
    { status: 400, body: { message: 'This location does not allow duplicated contacts.', meta: { contactId: 'old9' } } },
  ]);
  const ghl = createGhlClient({ token: 'tok', locationId: 'loc1', workflowId: 'wf1' });

  assert.deepEqual(await ghl.createContact({ name: 'A', phone: '+1' }), { id: 'new1', duplicate: false });
  assert.deepEqual(await ghl.createContact({ name: 'B', phone: '+2' }), { id: 'old9', duplicate: true });
  assert.deepEqual(JSON.parse(calls[0].body), { name: 'A', phone: '+1', locationId: 'loc1' });
  assert.equal(calls[0].method, 'POST');
});

test('GHL: add to workflow posts to the workflow endpoint and retries a 429', async () => {
  const calls = stubFetch([{ status: 429, headers: { 'retry-after': '1' }, body: {} }, { body: { succeded: true } }]);
  const ghl = createGhlClient({ token: 'tok', locationId: 'loc1', workflowId: 'wf1' });

  await ghl.addToWorkflow('c1');

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://services.leadconnectorhq.com/contacts/c1/workflow/wf1');
  assert.equal(calls[1].method, 'POST');
});

test('GHL: a 401 is thrown, not retried', async () => {
  const calls = stubFetch([{ status: 401, body: { message: 'Invalid JWT' } }]);
  const ghl = createGhlClient({ token: 'bad', locationId: 'loc1', workflowId: 'wf1' });

  await assert.rejects(ghl.createContact({ name: 'A', phone: '+1' }), (err) => err.status === 401);
  assert.equal(calls.length, 1);
});

test('Apify: starts the actor, waits until it finishes, returns the dataset', async () => {
  const calls = stubFetch([
    { status: 201, body: { data: { id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' } } },
    { body: { data: { id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' } } },
    { body: { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } } },
  ]);
  const apify = createApifyClient({ token: 'tok', actor: 'compass/crawler-google-places' });

  const result = await apify.run({ searchStringsArray: ['roofer'], locationQuery: 'Dallas, TX' });

  assert.deepEqual(result, { status: 'SUCCEEDED', runId: 'run1', datasetId: 'ds1' });
  assert.equal(calls[0].url, 'https://api.apify.com/v2/acts/compass~crawler-google-places/runs');
  assert.deepEqual(JSON.parse(calls[0].body), { searchStringsArray: ['roofer'], locationQuery: 'Dallas, TX' });
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[1].url, 'https://api.apify.com/v2/actor-runs/run1?waitForFinish=60');
});

test('Apify: reads every page of results', async () => {
  const page1 = Array.from({ length: 1000 }, (_, i) => ({ title: `p${i}` }));
  const calls = stubFetch([{ body: page1 }, { body: [{ title: 'last' }] }]);
  const apify = createApifyClient({ token: 'tok', actor: 'compass/crawler-google-places' });

  const items = await apify.getItems('ds1');

  assert.equal(items.length, 1001);
  assert.match(calls[1].url, /datasets\/ds1\/items\?clean=true&format=json&limit=1000&offset=1000$/);
});

test('Apify: a run that is still going past the time limit is aborted', async () => {
  const calls = stubFetch([
    { status: 201, body: { data: { id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' } } },
    { body: { data: { id: 'run1', status: 'ABORTED' } } },
  ]);
  const apify = createApifyClient({ token: 'tok', actor: 'compass/crawler-google-places', maxWaitMinutes: -1 });

  const result = await apify.run({});

  assert.equal(result.status, 'TOO-SLOW');
  assert.equal(calls[1].url, 'https://api.apify.com/v2/actor-runs/run1/abort');
});

test('templates: fallbacks, nested paths, sheet columns and dropped blanks', () => {
  const place = { title: 'Acme Roofing', phone: '(214) 555-0000', emails: ['a@acme.com'], website: '' };
  assert.equal(fillTemplate('{{phoneUnformatted|phone}}', place), '(214) 555-0000');
  assert.equal(fillTemplate('{{emails.0}}', place), 'a@acme.com');
  assert.deepEqual(fillTemplate({ q: ['{{City}}, {{State}}'], n: 5 }, { City: 'Dallas', State: 'TX' }), { q: ['Dallas, TX'], n: 5 });
  assert.equal(fillTemplate('Scraped {{date}}', { date: '2026-11-11' }), 'Scraped 2026-11-11');
  assert.deepEqual(placeToContact(place, { name: '{{title}}', website: '{{website}}', email: '{{emails.0}}' }), {
    name: 'Acme Roofing',
    email: 'a@acme.com',
  });
});

test('Sheets: signs in with the service account, then reads, appends and writes cells', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const calls = stubFetch([
    { body: { access_token: 'gtok', expires_in: 3600 } },
    { body: { values: [['City', 'Status'], ['Dallas', '']] } },
    { body: { updates: { updatedRange: "'Run log'!A5:G5" } } },
    { body: {} },
  ]);
  const sheets = createSheetsClient({ serviceAccount: { client_email: 'bot@x.iam.gserviceaccount.com', private_key: pem }, spreadsheetId: 'SHEET1' });

  assert.deepEqual(await sheets.readTab('Coverage Log'), [['City', 'Status'], ['Dallas', '']]);
  await sheets.appendRows('Master Leads', [["'Acme", '2026-11-11']]);
  await sheets.writeCells('Coverage Log', [{ row: 2, col: 6, value: 'Run' }, { row: 2, col: 12, value: "'Auto note" }]);

  // Google sign-in: a JWT signed with the service account key
  const assertion = new URLSearchParams(calls[0].body).get('assertion');
  const [head, claims, sig] = assertion.split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(sig, 'base64url')));
  const claim = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(claim.iss, 'bot@x.iam.gserviceaccount.com');
  assert.equal(claim.scope, 'https://www.googleapis.com/auth/spreadsheets');

  const base = 'https://sheets.googleapis.com/v4/spreadsheets/SHEET1/values';
  assert.equal(calls[1].url, `${base}/${encodeURIComponent("'Coverage Log'")}`);
  assert.equal(calls[1].headers.Authorization, 'Bearer gtok');
  assert.equal(calls[2].url, `${base}/${encodeURIComponent("'Master Leads'!A1")}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`);
  assert.deepEqual(JSON.parse(calls[2].body), { values: [["'Acme", '2026-11-11']] });
  assert.equal(calls[3].url, `${base}:batchUpdate`);
  assert.deepEqual(JSON.parse(calls[3].body), {
    valueInputOption: 'USER_ENTERED',
    data: [
      { range: "'Coverage Log'!G2", values: [['Run']] },
      { range: "'Coverage Log'!M2", values: [["'Auto note"]] },
    ],
  });
  assert.equal(calls.length, 4, 'signs in once and reuses the token');
});

test('Sheets: reads only the columns asked for, as raw values', async () => {
  const calls = stubFetch([{ body: { access_token: 'gtok', expires_in: 3600 } }, { body: { values: [['Phone key', 'Date added']] } }]);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sheets = createSheetsClient({
    serviceAccount: { client_email: 'bot@x', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    spreadsheetId: 'SHEET1',
  });

  await sheets.readTab('Master Leads', { fromCol: 10, toCol: 11, unformatted: true });

  assert.equal(
    calls[1].url,
    `https://sheets.googleapis.com/v4/spreadsheets/SHEET1/values/${encodeURIComponent("'Master Leads'!K:L")}?valueRenderOption=UNFORMATTED_VALUE`,
  );
});

test('sheet rules: clean name, phone key, date serial (checked against real rows)', () => {
  assert.equal(cleanName('Oak Leaf Lawn & Landscape, Inc.'), 'Oak Leaf Lawn & Landscape');
  assert.equal(cleanName('Smith Landscaping LLC'), 'Smith Landscaping');
  assert.equal(cleanName('Green Co, L.L.C.'), 'Green Co');
  assert.equal(cleanName('Acme Lawn Corp. | Best lawn care in Mobile'), 'Acme Lawn');
  assert.equal(cleanName('Zinc Gardens'), 'Zinc Gardens', 'only whole words are removed');
  assert.equal(phoneKey('(205) 281-4242'), '2052814242');
  assert.equal(phoneKey('+12052814242'), '2052814242');
  assert.equal(phoneKey(2052814242), '2052814242');
  assert.equal(phoneKey(''), '');
  assert.equal(dateSerial('2026-10-02'), 46297, 'Master Leads row 2 shows 10/2/26 = 46297');
  assert.equal(dateSerial('2026-10-06'), 46301, 'Coverage Log row 2 shows 10/6/26 = 46301');
});

test('sheet helpers: column letters, tab quoting, row numbers', () => {
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(25), 'Z');
  assert.equal(colLetter(26), 'AA');
  assert.equal(colLetter(701), 'ZZ');
  assert.equal(quoteTab("Bob's leads"), "'Bob''s leads'");
});

test('Apify: waits and retries when the plan memory is full, but not for other 402s', async () => {
  const memoryFull = { status: 402, body: { error: { type: 'actor-memory-limit-exceeded', message: 'By launching this job you will exceed the memory limit' } } };
  const calls = stubFetch([memoryFull, { status: 201, body: { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } } }]);
  const apify = createApifyClient({ token: 'tok', actor: 'compass/crawler-google-places', memoryRetryMs: 1 });

  assert.equal((await apify.run({})).status, 'SUCCEEDED');
  assert.equal(calls.length, 2);

  stubFetch([{ status: 402, body: { error: { type: 'not-enough-usage-to-run-paid-actor', message: 'Out of credit' } } }]);
  await assert.rejects(apify.run({}), (err) => err.status === 402);
});

test('Apify: passes the run timeout like Make did', async () => {
  const calls = stubFetch([{ status: 201, body: { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } } }]);
  const apify = createApifyClient({ token: 'tok', actor: 'compass/crawler-google-places', runTimeoutSecs: 1800 });

  await apify.run({});

  assert.equal(calls[0].url, 'https://api.apify.com/v2/acts/compass~crawler-google-places/runs?timeout=1800');
});
