import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ApifyLimitError } from '../src/apify.js';
import { HttpError } from '../src/http.js';
import { dateSerial } from '../src/mapping.js';
import { mergeNotes, runPipeline } from '../src/pipeline.js';

// The real config.json, so the tests check the settings that will actually run.
const realConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
// The backlog is off unless a test turns it on (the real one points at Mark's Apify dataset).
const config = (overrides = {}) => ({ ...structuredClone(realConfig), dailyLimit: 1000, backlog: null, ...overrides });
const BACKLOG = { datasetId: 'backlog1', stateStoreId: 'state1', note: 'Auto import (paid backlog)' };

/** Adds a paid backlog (a saved dataset plus a progress record) to a fake Apify. */
function withBacklog(apify, items, progress = null) {
  const records = progress ? { progress } : {};
  return {
    ...apify,
    records,
    pagesRead: 0,
    async datasetSize(id) {
      assert.equal(id, 'backlog1');
      return items.length;
    },
    async getItemsPage(id, offset, limit) {
      this.pagesRead++;
      return items.slice(offset, offset + limit);
    },
    async getRecord(store, key) {
      assert.equal(store, 'state1');
      return records[key] ?? null;
    },
    async setRecord(store, key, value) {
      records[key] = value;
    },
  };
}
const backlogItem = (area, i, extra = {}) => ({
  ...place(area, i),
  state: null,
  sourceState: 'Florida',
  sourceCounty: 'Collier',
  sourceKeyword: 'landscaping',
  ...extra,
});

// ---------- fakes that behave like the RogoFX_Lead_Tracker sheet, Apify and GHL ----------

/** Mimics USER_ENTERED: leading ' forces text, ISO dates become date serials. */
const stored = (v) => {
  if (typeof v !== 'string') return v;
  if (v.startsWith("'")) return v.slice(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return dateSerial(v);
  return v;
};

function fakeSheets(tabs) {
  return {
    tabs,
    async readHeader(tab) {
      return (tabs[tab]?.[0] ?? []).map(String);
    },
    async readTab(tab, { fromCol, toCol } = {}) {
      if (!tabs[tab]) throw new HttpError('Google Sheets read', 400, 'Unable to parse range');
      return tabs[tab].map((r) => (fromCol == null ? [...r] : r.slice(fromCol, (toCol ?? fromCol) + 1)));
    },
    async writeCells(tab, cells) {
      for (const c of cells) {
        const row = (tabs[tab][c.row - 1] ??= []);
        while (row.length < c.col) row.push('');
        row[c.col] = stored(c.value);
      }
    },
    async appendRows(tab, rows) {
      tabs[tab].push(...rows.map((r) => r.map(stored)));
    },
  };
}

const searchKey = (input) => input.locationQuery ?? input.searchStringsArray.join(' + ');

function fakeApify(results, { failing = [] } = {}) {
  const store = {};
  const runs = [];
  let n = 0;
  return {
    runs,
    async run(input) {
      runs.push(input);
      if (failing.includes(searchKey(input))) return { status: 'FAILED' };
      const id = `ds${++n}`;
      store[id] = results[searchKey(input)] ?? [];
      return { status: 'SUCCEEDED', datasetId: id };
    },
    async getItems(id) {
      if (!store[id]) throw new HttpError('Apify read results', 404, 'Dataset not found');
      return store[id];
    },
  };
}

function fakeGhl({ existingPhones = [], workflowId = null, failAfter = null, oppFails = false } = {}) {
  const existing = new Set(existingPhones);
  const opportunities = [];
  const created = [];
  const enrolled = [];
  return {
    workflowId,
    opportunities,
    created,
    enrolled,
    async findDuplicate({ phone }) {
      return existing.has(phone) ? 'old-contact' : null;
    },
    async createContact(contact) {
      if (failAfter != null && created.length >= failAfter) throw new HttpError('GHL create contact', 401, { message: 'Invalid JWT' });
      existing.add(contact.phone);
      created.push(contact);
      return { id: `c${created.length}`, duplicate: false };
    },
    async addToWorkflow(id) {
      enrolled.push(id);
    },
    async createOpportunity(opp) {
      if (oppFails) throw new HttpError('GHL add to pipeline', 422, { message: 'Pipeline stage not found' });
      opportunities.push(opp);
      return `o${opportunities.length}`;
    },
  };
}

const COVERAGE_HEADER = ['State', 'County', 'Size', 'Keyword', 'Location (paste into Apify)', 'Cities to Scrape', 'Status', 'Date run', 'Results returned', 'Cap used', 'Hit cap?', 'Leads in Master', 'Notes'];
const MASTER_HEADER = ['title (original)', 'street', 'city', 'state', 'phone', 'website', 'categoryName', 'County', 'Keyword', 'Clean name', 'Phone key', 'Date added', 'Status', 'Last contact', 'Booked?', 'Reviews', 'Notes'];

const row = (state, county, keyword, { status = 'Not run', size = '', cities = '', notes = '' } = {}) => [
  state, county, size, keyword, `${county} County, ${state}, USA`, cities, status, '', '', '', '=formula', '=formula', notes,
];

const tracker = ({ coverage, master = [], dnc = [], categories = [] }) =>
  fakeSheets({
    'Coverage Log': [COVERAGE_HEADER, ...coverage],
    'Master Leads': [MASTER_HEADER, ...master],
    'Do Not Contact': [['Phone key (10 digits, e.g. 2052814242)', 'Business', 'Date added', 'Reason'], ...dnc.map((k) => [k, '', '', 'STOP'])],
    Categories: [['categoryName (exact, from Apify)', 'Keep?'], ['Landscaper', 'Yes'], ['Lawn care service', 'Yes'], ['Plant nursery', 'No'], ...categories],
  });

const place = (area, i, extra = {}) => ({
  title: `Green ${area}-${i} Landscaping LLC`,
  street: `${i} Main St`,
  city: 'Prattville',
  state: 'Alabama',
  phone: `(${area}) 000-${String(i).padStart(4, '0')}`,
  phoneUnformatted: `+1${area}000${String(i).padStart(4, '0')}`,
  categoryName: 'Landscaper',
  ...extra,
});
const places = (area, count) => Array.from({ length: count }, (_, i) => place(area, i));
const key = (area, i) => `${area}000${String(i).padStart(4, '0')}`;

const nov11 = () => new Date('2026-11-11T08:00:00Z'); // 2am in Chicago
const nov12 = () => new Date('2026-11-12T08:00:00Z');
const quiet = () => {};
const run = (args) => runPipeline({ now: nov11, log: quiet, ...args });

// ---------- tests ----------

test('creates the GHL contact like Make did, adds a Master Leads row, and marks the Coverage Log row Run', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const apify = fakeApify({ 'Autauga County, Alabama, USA': [place(334, 1, { website: 'https://green.com' })] });
  const ghl = fakeGhl();

  const s = await run({ config: config(), sheets, apify, ghl });

  assert.equal(s.status, 'ran out of locations');
  assert.equal(s.newContacts, 1);
  assert.deepEqual(apify.runs[0], {
    searchStringsArray: ['landscaping'],
    locationQuery: 'Autauga County, Alabama, USA',
    language: 'en',
  }, "the row's keyword and location, no limit on places, and no paid Apify filters");
  assert.deepEqual(ghl.created[0], {
    firstName: 'Green 334-1 Landscaping',
    companyName: 'Green 334-1 Landscaping',
    phone: '+13340000001',
    address1: '1 Main St',
    city: 'Prattville',
    state: 'Alabama',
    website: 'https://green.com',
    dnd: false,
  });
  assert.deepEqual(sheets.tabs['Master Leads'][1], [
    'Green 334-1 Landscaping LLC', '1 Main St', 'Prattville', 'Alabama', '(334) 000-0001', 'https://green.com', 'Landscaper',
    'Autauga', 'landscaping', 'Green 334-1 Landscaping', '3340000001', dateSerial('2026-11-11'), 'Texted', '', '', '', 'Auto import',
  ]);
  const cov = sheets.tabs['Coverage Log'][1];
  assert.equal(cov[6], 'Run');
  assert.equal(cov[7], dateSerial('2026-11-11'));
  assert.equal(cov[8], 1, 'Results returned');
  assert.equal(cov[9], '', 'Cap used left blank: there is no cap');
  assert.equal(cov[10], '=formula', 'Hit cap? formula left alone');
  assert.equal(cov[11], '=formula', 'Leads in Master formula left alone');
  assert.equal(cov[12], 'Auto 2026-11-11: 1 found, 1 new, 0 skipped; Apify dataset ds1');
});

test('never contacts Do Not Contact, Master Leads, "No" categories, closed places, phoneless places or GHL duplicates', async () => {
  const list = [
    place(205, 1), // new
    place(205, 2), // on Do Not Contact
    place(205, 3), // already in Master Leads
    place(205, 4, { categoryName: 'Plant nursery' }), // category No
    place(205, 5, { permanentlyClosed: true }),
    place(205, 6, { phone: '', phoneUnformatted: '' }),
    place(205, 7), // already in GHL (e.g. created by Make)
    { ...place(205, 1), title: 'Same business listed twice' },
    place(205, 8), // new
  ];
  const sheets = tracker({
    coverage: [row('Alabama', 'Jefferson', 'landscaping')],
    dnc: [key(205, 2)],
    master: [['Old lead', '', '', 'Alabama', '(205) 000-0003', '', 'Landscaper', '', 'landscaping', 'Old lead', key(205, 3), 46297, 'Texted']],
  });
  const apify = fakeApify({ 'Jefferson County, Alabama, USA': list });
  const ghl = fakeGhl({ existingPhones: ['+12050000007'] });

  const s = await run({ config: config(), sheets, apify, ghl });

  assert.deepEqual(ghl.created.map((c) => c.phone), ['+12050000001', '+12050000008']);
  assert.deepEqual(s.skipped, {
    'on Do Not Contact': 1,
    'already in Master Leads': 1,
    'category marked No': 1,
    closed: 1,
    'no phone': 1,
    'already in GHL': 1,
  });
  assert.equal(sheets.tabs['Master Leads'].length, 4, 'header + old lead + 2 new');
});

test('stops at the daily limit, keeps every scrape it paid for, and finishes them next night without paying Apify again', async () => {
  const sheets = tracker({
    coverage: [row('Alabama', 'Autauga', 'landscaping'), row('Alabama', 'Baldwin', 'landscaping'), row('Alabama', 'Barbour', 'landscaping')],
  });
  const apify = fakeApify({
    'Autauga County, Alabama, USA': places(334, 4),
    'Baldwin County, Alabama, USA': places(251, 4),
    'Barbour County, Alabama, USA': places(256, 4),
  });
  const ghl = fakeGhl();

  const night1 = await run({ config: config({ dailyLimit: 5 }), sheets, apify, ghl });

  assert.equal(night1.status, 'daily limit reached');
  assert.equal(night1.newContacts, 5);
  const cov = sheets.tabs['Coverage Log'];
  assert.equal(cov[1][6], 'Run');
  assert.equal(cov[2][6], 'Partial');
  assert.match(cov[2][12], /1 new so far, finishes next run; Apify dataset ds2/);
  assert.equal(cov[3][6], 'Partial', 'the scrape started ahead of time is saved, not wasted');
  assert.match(cov[3][12], /scraped 4 places, not processed yet; Apify dataset ds3/);
  assert.equal(apify.runs.length, 3);

  const night2 = await run({ config: config(), sheets, apify, ghl, now: nov12 });

  assert.equal(apify.runs.length, 3, 'night 2 reuses saved results: no new Apify runs');
  assert.equal(night2.newContacts, 7);
  assert.equal(night2.skipped['already in Master Leads'], 1, "the one added last night isn't contacted again");
  assert.equal(cov[2][6], 'Run');
  assert.equal(cov[3][6], 'Run');
  assert.equal(new Set(ghl.created.map((c) => c.phone)).size, 12, 'all 12 businesses, each exactly once');
});

test('a second run on the same day only gets what is left of the 1,000', async () => {
  const today = dateSerial('2026-11-11');
  const sheets = tracker({
    coverage: [row('Alabama', 'Autauga', 'landscaping')],
    master: [
      ['a', '', '', '', '', '', '', '', '', '', '1110000001', dateSerial('2026-11-10')],
      ['b', '', '', '', '', '', '', '', '', '', '1110000002', today],
      ['c', '', '', '', '', '', '', '', '', '', '1110000003', today],
    ],
  });
  const apify = fakeApify({ 'Autauga County, Alabama, USA': places(334, 10) });
  const ghl = fakeGhl();

  const s = await run({ config: config({ dailyLimit: 5 }), sheets, apify, ghl });

  assert.equal(s.alreadyToday, 2, "yesterday's row doesn't count");
  assert.equal(s.newContacts, 3);
});

test('does nothing when today is already at the limit', async () => {
  const today = dateSerial('2026-11-11');
  const sheets = tracker({
    coverage: [row('Alabama', 'Autauga', 'landscaping')],
    master: [['a', '', '', '', '', '', '', '', '', '', '1110000001', today]],
  });
  const apify = fakeApify({});
  const ghl = fakeGhl();

  const s = await run({ config: config({ dailyLimit: 1 }), sheets, apify, ghl });

  assert.equal(s.status, 'daily limit already reached');
  assert.equal(apify.runs.length, 0);
});

test('works the Coverage Log top to bottom, county by county as listed', async () => {
  const sheets = tracker({
    coverage: [
      row('Alabama', 'Autauga', 'landscaping', { status: 'Run' }),
      row('Alabama', 'Autauga', 'hardscaping'),
      row('Alabama', 'Baldwin', 'landscaping'),
      row('Alabama', 'Baldwin', 'hardscaping'),
      row('Alabama', 'Barbour', 'landscaping', { status: 'Skipped' }),
      row('Georgia', 'Appling', 'landscaping'),
      row('Alabama', 'Bibb', 'landscaping', { status: 'Partial', notes: 'Auto 2026-11-10: 3 new so far; Apify dataset abc123' }),
      row('Alabama', 'Blount', 'landscaping', { status: 'Partial', notes: 'split by city later' }),
      row('Alabama', 'Bullock', 'landscaping', { status: 'Processing' }),
    ],
  });

  const s = await run({ config: config(), sheets, apify: fakeApify({}), ghl: fakeGhl(), options: { dryRun: true } });

  assert.deepEqual(s.preview.map((p) => p.row), [3, 4, 5, 7, 8]);
  assert.equal(s.preview[4].apifyInput, 'reuse saved Apify results (abc123)');
  assert.equal(s.pendingLocations, 6, 'Run, Skipped and hand-marked Partial rows are left alone; Processing (left by Make) is redone');
});

test('dry run reads everything but writes nothing and calls neither Apify nor GHL', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const before = JSON.stringify(sheets.tabs);
  const apify = fakeApify({ 'Autauga County, Alabama, USA': places(334, 3) });
  const ghl = fakeGhl();

  const s = await run({ config: config(), sheets, apify, ghl, options: { dryRun: true } });

  assert.equal(s.status, 'dry run');
  assert.equal(JSON.stringify(sheets.tabs), before);
  assert.equal(apify.runs.length, 0);
  assert.equal(ghl.created.length, 0);
});

test('two Apify failures in a row stop the run; those rows stay Not run', async () => {
  const sheets = tracker({
    coverage: [row('Alabama', 'Autauga', 'landscaping'), row('Alabama', 'Baldwin', 'landscaping'), row('Alabama', 'Barbour', 'landscaping')],
  });
  const apify = fakeApify({ 'Barbour County, Alabama, USA': places(256, 2) }, { failing: ['Autauga County, Alabama, USA', 'Baldwin County, Alabama, USA'] });

  const s = await run({ config: config(), sheets, apify, ghl: fakeGhl() });

  assert.equal(s.status, 'stopped: Apify failed twice in a row');
  const cov = sheets.tabs['Coverage Log'];
  assert.equal(cov[1][6], 'Not run');
  assert.equal(cov[2][6], 'Not run');
  assert.equal(cov[3][6], 'Partial', 'the scrape that did succeed is kept for next time');
});

test('a GHL login error stops the run but still records the contacts already created', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const apify = fakeApify({ 'Autauga County, Alabama, USA': places(334, 5) });
  const ghl = fakeGhl({ failAfter: 2 });

  await assert.rejects(run({ config: config(), sheets, apify, ghl }), /HTTP 401/);

  assert.equal(sheets.tabs['Master Leads'].length, 3, 'header + the 2 contacts created before the error');
  const cov = sheets.tabs['Coverage Log'][1];
  assert.equal(cov[6], 'Partial');
  assert.match(cov[12], /Apify dataset ds1/);
});

test('categories not on the Categories tab are still contacted, and the tab is not changed', async () => {
  const list = [place(334, 1, { categoryName: 'Snow removal service' }), place(334, 2, { categoryName: 'Snow removal service' })];
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const before = JSON.stringify(sheets.tabs.Categories);

  const s = await run({ config: config(), sheets, apify: fakeApify({ 'Autauga County, Alabama, USA': list }), ghl: fakeGhl() });

  assert.equal(s.newContacts, 2);
  assert.deepEqual(s.newCategories, ['Snow removal service'], 'listed once in the run report');
  assert.equal(JSON.stringify(sheets.tabs.Categories), before);
});

test('adds contacts to a workflow only when a workflow ID is set', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const ghl = fakeGhl({ workflowId: 'wf1' });

  await run({ config: config(), sheets, apify: fakeApify({ 'Autauga County, Alabama, USA': places(334, 2) }), ghl });

  assert.deepEqual(ghl.enrolled, ['c1', 'c2']);
});

test('clear error when a needed column is missing', async () => {
  const sheets = tracker({ coverage: [] });
  sheets.tabs['Coverage Log'][0] = ['State', 'County', 'Keyword', 'Status'];

  await assert.rejects(run({ config: config(), sheets, apify: fakeApify({}), ghl: fakeGhl() }), /"Coverage Log" tab is missing column\(s\): Location \(paste into Apify\), Date run, Results returned, Notes/);
});

test('keeps your own notes and only replaces what the job wrote last time', () => {
  const once = mergeNotes('call county office first', 'Auto 2026-11-11: 3 new so far; Apify dataset a1');
  assert.equal(once, 'call county office first | Auto 2026-11-11: 3 new so far; Apify dataset a1');
  assert.equal(mergeNotes(once, 'Auto 2026-11-12: 9 found'), 'call county office first | Auto 2026-11-12: 9 found');
  assert.equal(mergeNotes('', 'Auto 2026-11-12: 9 found'), 'Auto 2026-11-12: 9 found');
});

const overLimit = { usedUsd: 80, limitUsd: 80, leftUsd: 0, resetsAt: '2026-12-11T00:00:00.000Z' };

test('Apify monthly limit already spent: stops before scraping, says so plainly, sheet and GHL untouched', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const apify = { ...fakeApify({ 'Autauga County, Alabama, USA': places(334, 3) }), usage: async () => overLimit };
  const ghl = fakeGhl();
  const before = JSON.stringify(sheets.tabs);

  await assert.rejects(
    run({ config: config(), sheets, apify, ghl }),
    (err) =>
      err instanceof ApifyLimitError &&
      /\$80\.00 of \$80\.00/.test(err.message) &&
      /2026-12-11/.test(err.message) &&
      err.summary.status === 'stopped: Apify monthly limit reached',
  );
  assert.equal(JSON.stringify(sheets.tabs), before);
  assert.equal(apify.runs.length, 0);
  assert.equal(ghl.created.length, 0);
});

test('dry run shows the Apify spend and warns when the limit is reached', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const apify = { ...fakeApify({}), usage: async () => overLimit };

  const s = await run({ config: config(), sheets, apify, ghl: fakeGhl(), options: { dryRun: true } });

  assert.equal(s.status, 'dry run');
  assert.deepEqual(s.apifyUsage, overLimit);
  assert.match(s.notes.join(' '), /Apify monthly spending limit reached/);
});

test('Apify limit hit partway: finished counties are kept, the rest stay Not run', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping'), row('Alabama', 'Baldwin', 'landscaping')] });
  const base = fakeApify({ 'Autauga County, Alabama, USA': places(334, 2) });
  const apify = {
    ...base,
    usage: async () => ({ usedUsd: 10, limitUsd: 80, leftUsd: 70, resetsAt: null }),
    async run(input) {
      if (input.locationQuery.startsWith('Baldwin')) throw new ApifyLimitError(overLimit);
      return base.run(input);
    },
  };
  const ghl = fakeGhl();

  await assert.rejects(run({ config: config(), sheets, apify, ghl }), ApifyLimitError);

  assert.equal(ghl.created.length, 2);
  const cov = sheets.tabs['Coverage Log'];
  assert.equal(cov[1][6], 'Run');
  assert.equal(cov[2][6], 'Not run');
});

test('Master Leads gets the Coverage Log state, so its "Leads in Master" count works when Google gives no state', async () => {
  const sheets = tracker({ coverage: [row('Florida', 'Miami-Dade', 'hardscaping')] });
  const apify = fakeApify({ 'Miami-Dade County, Florida, USA': [place(305, 1, { state: null }), place(305, 2, { state: 'FL' })] });

  await run({ config: config(), sheets, apify, ghl: fakeGhl() });

  const master = sheets.tabs['Master Leads'];
  assert.deepEqual(master.slice(1).map((r) => [r[3], r[7], r[8]]), [
    ['Florida', 'Miami-Dade', 'hardscaping'],
    ['Florida', 'Miami-Dade', 'hardscaping'],
  ]);
});

test('paid backlog first: new contacts from it, progress saved, no Apify scrape while it lasts', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const items = [backlogItem(239, 1), backlogItem(239, 2), backlogItem(239, 3), backlogItem(239, 4)];
  const apify = withBacklog(fakeApify({ 'Autauga County, Alabama, USA': places(334, 5) }), items);
  const ghl = fakeGhl({ existingPhones: ['+12390000002'] });

  const s = await run({ config: config({ dailyLimit: 2, backlog: BACKLOG }), sheets, apify, ghl });

  assert.equal(s.status, 'daily limit reached');
  assert.equal(s.backlogContacts, 2);
  assert.deepEqual(ghl.created.map((c) => c.phone), ['+12390000001', '+12390000003']);
  assert.equal(apify.runs.length, 0, 'nothing scraped while paid leads are left');
  assert.equal(apify.records.progress.offset, 3, 'lead 4 is next');
  const master = sheets.tabs['Master Leads'].slice(1);
  assert.deepEqual(master.map((r) => [r[3], r[7], r[8], r[16]]), [
    ['Florida', 'Collier', 'landscaping', 'Auto import (paid backlog)'],
    ['Florida', 'Collier', 'landscaping', 'Auto import (paid backlog)'],
  ]);
  assert.equal(sheets.tabs['Coverage Log'][1][6], 'Not run', 'Coverage Log untouched');
});

test('paid backlog runs out: the rest of the night scrapes new counties and marks them Run', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const apify = withBacklog(fakeApify({ 'Autauga County, Alabama, USA': places(334, 3) }), [backlogItem(239, 1), backlogItem(239, 2)], { offset: 1 });
  const ghl = fakeGhl();

  const s = await run({ config: config({ backlog: BACKLOG }), sheets, apify, ghl });

  assert.equal(s.backlogContacts, 1, 'only the lead after the saved offset');
  assert.equal(s.newContacts, 4);
  assert.equal(apify.runs.length, 1);
  assert.equal(apify.records.progress.offset, 2);
  assert.match(s.notes.join(' '), /Paid backlog finished/);
  const cov = sheets.tabs['Coverage Log'][1];
  assert.equal(cov[6], 'Run');
  assert.equal(cov[7], dateSerial('2026-11-11'));
});

test('a finished backlog is not read again', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const apify = withBacklog(fakeApify({ 'Autauga County, Alabama, USA': places(334, 1) }), [backlogItem(239, 1)], { offset: 1 });

  const s = await run({ config: config({ backlog: BACKLOG }), sheets, apify, ghl: fakeGhl() });

  assert.equal(apify.pagesRead, 0);
  assert.equal(s.newContacts, 1);
});

test('Apify limit used up: the paid backlog still runs, only scraping stops', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const apify = { ...withBacklog(fakeApify({}), [backlogItem(239, 1)]), usage: async () => overLimit };
  const ghl = fakeGhl();

  await assert.rejects(run({ config: config({ backlog: BACKLOG }), sheets, apify, ghl }), ApifyLimitError);

  assert.equal(ghl.created.length, 1, 'the paid lead still went to GHL');
  assert.equal(apify.runs.length, 0);
  assert.equal(apify.records.progress.offset, 1);
});

test('a GHL error partway saves backlog progress so nothing is skipped or repeated', async () => {
  const sheets = tracker({ coverage: [] });
  const apify = withBacklog(fakeApify({}), [backlogItem(239, 1), backlogItem(239, 2), backlogItem(239, 3)]);
  const ghl = fakeGhl({ failAfter: 1 });

  await assert.rejects(run({ config: config({ backlog: BACKLOG }), sheets, apify, ghl }), /HTTP 401/);

  assert.equal(apify.records.progress.offset, 1, 'lead 2 is tried again next run');
  assert.equal(sheets.tabs['Master Leads'].length, 2);
});

const SMS_PIPELINE = { pipelineId: 'pipe1', stageId: 'stage1', name: '{{cleanName}}' };
const withPipeline = (overrides = {}) => {
  const c = config(overrides);
  c.ghl.opportunity = SMS_PIPELINE;
  return c;
};

test('every new contact is put in the SMS pipeline (what starts the SMS workflow); duplicates are not', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const apify = fakeApify({ 'Autauga County, Alabama, USA': places(334, 3) });
  const ghl = fakeGhl({ existingPhones: ['+13340000001'] });

  await run({ config: withPipeline(), sheets, apify, ghl });

  assert.deepEqual(ghl.opportunities, [
    { pipelineId: 'pipe1', stageId: 'stage1', contactId: 'c1', name: 'Green 334-0 Landscaping' },
    { pipelineId: 'pipe1', stageId: 'stage1', contactId: 'c2', name: 'Green 334-2 Landscaping' },
  ]);
});

test('backlog contacts go in the SMS pipeline too', async () => {
  const sheets = tracker({ coverage: [] });
  const apify = withBacklog(fakeApify({}), [backlogItem(239, 1)]);
  const ghl = fakeGhl();

  await run({ config: withPipeline({ backlog: BACKLOG }), sheets, apify, ghl });

  assert.equal(ghl.opportunities.length, 1);
  assert.equal(ghl.opportunities[0].contactId, 'c1');
});

test('if adding to the pipeline keeps failing, the run stops and names the contacts to add by hand', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const apify = fakeApify({ 'Autauga County, Alabama, USA': places(334, 8) });
  const ghl = fakeGhl({ oppFails: true });

  await assert.rejects(run({ config: withPipeline(), sheets, apify, ghl }), (err) => {
    assert.equal(err.summary.pipelineFailed.length, 5);
    assert.match(err.summary.pipelineFailed[0], /Green 334-0 Landscaping \(c1\)/);
    return true;
  });
  assert.equal(ghl.created.length, 5, 'stops after 5 failures instead of creating 1,000 contacts nobody texts');
  assert.equal(sheets.tabs['Master Leads'].length, 6, 'the 5 created are still recorded');
});

test('no pipeline set: contacts are only created, as before', async () => {
  const sheets = tracker({ coverage: [row('Alabama', 'Autauga', 'landscaping')] });
  const ghl = fakeGhl();
  const noPipeline = config();
  delete noPipeline.ghl.opportunity;
  await run({ config: noPipeline, sheets, apify: fakeApify({ 'Autauga County, Alabama, USA': places(334, 1) }), ghl });
  assert.equal(ghl.created.length, 1);
  assert.equal(ghl.opportunities.length, 0);
});

test('the real config puts new contacts in SMS Pipeline > New Prospect (starts the Initial SMS Sequence)', () => {
  assert.deepEqual(realConfig.ghl.opportunity, {
    pipeline: 'SMS Pipeline',
    stage: 'New Prospect',
    pipelineId: 'RQtxl63SbypkXrkpAeoN',
    stageId: 'f84bd262-3073-4617-9038-6ba8e5ea7e34',
    name: '{{cleanName}}',
  });
});

test('installers only: mowing and lawn-care crews are skipped by category or name, hardscapers and designers are kept', async () => {
  const list = [
    place(239, 1), // "Green ... Landscaping", category Landscaper: kept
    place(239, 2, { categoryName: 'Lawn care service' }), // skipped, even though the tab says Yes
    place(239, 3, { title: "Rojo's Lawn Service" }),
    place(239, 4, { title: 'Mow It Up LLC' }),
    place(239, 5, { title: 'Precision Cutzz Landscaping' }),
    place(239, 6, { title: 'Coastal Lawn & Hardscape Design', categoryName: 'Lawn care service' }), // name says installer: kept
    place(239, 7, { title: 'Gulf Pavers', categoryName: 'Paving contractor' }),
    place(239, 8, { title: 'Cutting Edge Landscapes' }), // "cutting" alone is not a mowing word
  ];
  const sheets = tracker({ coverage: [row('Florida', 'Lee', 'landscaping')] });
  const apify = fakeApify({ 'Lee County, Florida, USA': list });
  const ghl = fakeGhl();

  const s = await run({ config: config(), sheets, apify, ghl });

  assert.deepEqual(ghl.created.map((c) => c.phone), ['+12390000001', '+12390000006', '+12390000007', '+12390000008']);
  assert.deepEqual(s.skipped, { 'not an installer (category)': 1, 'not an installer (name)': 3 });
});

test('installers only can be turned off by deleting the block from config.json', async () => {
  const sheets = tracker({ coverage: [row('Florida', 'Lee', 'landscaping')] });
  const apify = fakeApify({ 'Lee County, Florida, USA': [place(239, 1, { title: 'Mow It Up' })] });
  const ghl = fakeGhl();
  const cfg = config();
  delete cfg.installersOnly;

  await run({ config: cfg, sheets, apify, ghl });

  assert.equal(ghl.created.length, 1);
});
