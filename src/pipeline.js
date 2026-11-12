// The nightly job for the RogoFX_Lead_Tracker sheet:
// Coverage Log row (top to bottom) -> Apify -> skip anyone already contacted -> GHL contact
// -> Master Leads row -> Coverage Log row marked Run. Stops at the daily limit of new contacts.
// The Dashboard tab updates by itself from Coverage Log (Run) and Master Leads.
import { ApifyLimitError } from './apify.js';
import { HttpError } from './http.js';
import { asText, cleanName, dateSerial, phoneKey, placeToContact } from './mapping.js';

const FATAL_STATUSES = new Set([401, 402, 403]);
const DATASET_NOTE = /Apify dataset ([A-Za-z0-9]+)/;
const AUTO_NOTE = /(?:\s*\|\s*)?Auto \d{4}-\d{2}-\d{2}:.*$/s;
const MASTER_FLUSH_EVERY = 25;
const BACKLOG_PAGE = 500;
const PROGRESS_KEY = 'progress';

const isFatal = (err) => !(err instanceof HttpError) || FATAL_STATUSES.has(err.status);

export const localDate = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/** Keeps the user's own notes and replaces only the part this job wrote last time. */
export function mergeNotes(existing, auto) {
  const own = String(existing ?? '').replace(AUTO_NOTE, '').trim();
  return own ? `${own} | ${auto}` : auto;
}

// Master Leads columns, matched by header name (case-insensitive).
const MASTER_FIELDS = {
  'title (original)': ({ place }) => asText(place.title),
  street: ({ place }) => asText(place.street),
  city: ({ place }) => asText(place.city),
  // The Coverage Log row's state ("Florida"), which its "Leads in Master" formula matches on.
  state: ({ place, loc }) => asText(loc.state || place.state),
  phone: ({ place }) => asText(place.phone || place.phoneUnformatted),
  website: ({ place }) => asText(place.website),
  categoryname: ({ place }) => asText(place.categoryName),
  county: ({ loc }) => asText(loc.county),
  keyword: ({ loc }) => asText(loc.keyword),
  'clean name': ({ name }) => asText(name),
  'phone key': ({ key }) => asText(key),
  'date added': ({ today }) => today,
  status: ({ cfg }) => cfg.masterLeads.status,
  notes: ({ cfg, loc }) => asText(loc.note ?? cfg.masterLeads.note),
};

function findColumns(header, wanted, tab, required) {
  const lower = header.map((h) => String(h).trim().toLowerCase());
  const cols = {};
  const missing = [];
  for (const [key, name] of Object.entries(wanted)) {
    cols[key] = lower.indexOf(String(name).toLowerCase());
    if (cols[key] === -1 && required.includes(key)) missing.push(name);
  }
  if (missing.length) {
    throw new Error(`The "${tab}" tab is missing column(s): ${missing.join(', ')}. Columns found: ${header.join(', ')}`);
  }
  return cols;
}

export async function runPipeline({ config: cfg, sheets, apify, ghl, options = {}, now = () => new Date(), log = console.log }) {
  const dryRun = Boolean(options.dryRun);
  const today = localDate(now(), cfg.timezone);
  const cov = cfg.coverageLog;
  const summary = {
    status: 'running',
    newContacts: 0,
    skipped: {},
    locationsFinished: [],
    partialRows: [],
    apifyFailures: [],
    enrollFailed: [],
    newCategories: [],
    notes: [],
  };

  // 1. Master Leads: who has already been contacted, and how many were added today.
  const masterTab = cfg.masterLeads.tab;
  const masterHeader = await sheets.readHeader(masterTab);
  const mCols = findColumns(masterHeader, { key: 'Phone key', date: 'Date added' }, masterTab, ['key', 'date']);
  const mFrom = Math.min(mCols.key, mCols.date);
  const masterRows = await sheets.readTab(masterTab, { fromCol: mFrom, toCol: Math.max(mCols.key, mCols.date), unformatted: true });
  const masterKeys = new Set();
  const todaySerial = dateSerial(today);
  summary.alreadyToday = 0;
  for (const r of masterRows.slice(1)) {
    const key = phoneKey(r[mCols.key - mFrom]);
    if (key) masterKeys.add(key);
    const added = r[mCols.date - mFrom];
    if (added === todaySerial || String(added ?? '').trim() === today) summary.alreadyToday++;
  }

  let remaining = cfg.dailyLimit - summary.alreadyToday;
  if (options.limit != null) remaining = Math.min(remaining, options.limit);
  summary.budget = Math.max(0, remaining);
  log(`Today (${today}): ${summary.alreadyToday} already added to Master Leads, budget for this run: ${summary.budget}`);
  if (remaining <= 0) {
    summary.status = 'daily limit already reached';
    return summary;
  }

  // 2. Do Not Contact and Categories.
  const dnc = new Set(
    (await sheets.readTab(cfg.doNotContactTab, { fromCol: 0, toCol: 0 })).slice(1).map((r) => phoneKey(r[0])).filter(Boolean),
  );
  const categories = new Map(
    (await sheets.readTab(cfg.categories.tab, { fromCol: 0, toCol: 1 }))
      .slice(1)
      .filter((r) => String(r[0] ?? '').trim())
      .map((r) => [String(r[0]).trim().toLowerCase(), String(r[1] ?? '').trim().toLowerCase()]),
  );

  // 3. Coverage Log: locations still to do.
  const covRows = await sheets.readTab(cov.tab);
  if (covRows.length === 0) throw new Error(`The "${cov.tab}" tab is empty.`);
  const col = findColumns(covRows[0].map((h) => String(h).trim()), cov.columns, cov.tab, [
    'keyword',
    'location',
    'status',
    'dateRun',
    'results',
    'notes',
  ]);
  const todo = new Set(cov.todoStatuses.map((s) => s.toLowerCase()));

  // Rows are worked top to bottom, county by county, exactly as listed.
  const pending = [];
  covRows.slice(1).forEach((row, i) => {
    const v = (key) => (col[key] >= 0 ? String(row[col[key]] ?? '').trim() : '');
    const loc = {
      rowNumber: i + 2,
      state: v('state'),
      county: v('county'),
      keyword: v('keyword'),
      location: v('location'),
      status: v('status'),
      notes: v('notes'),
    };
    loc.savedDatasetId = DATASET_NOTE.exec(loc.notes)?.[1] ?? null;
    // "Partial" rows are only picked up if this job saved their Apify results (dataset id in Notes),
    // so an area is never paid for twice. Older hand-marked Partial rows are left alone, as Make did.
    const resumable = loc.status.toLowerCase() === cov.partialStatus.toLowerCase() && loc.savedDatasetId;
    if (!todo.has(loc.status.toLowerCase()) && !resumable) return;
    if (!loc.keyword || !loc.location) {
      if (loc.keyword || loc.location || loc.state) summary.notes.push(`row ${loc.rowNumber} skipped: no Keyword or Location`);
      return;
    }
    pending.push(loc);
  });
  const queue = options.maxLocations ? pending.slice(0, options.maxLocations) : pending;
  summary.pendingLocations = pending.length;
  log(`${pending.length} location(s) waiting in "${cov.tab}".`);

  // Same search Make ran, but with the row's own keyword (each county has a landscaping row and a
  // hardscaping row, so searching both on every row paid for every county twice). No place limit.
  // No Apify filters: each one (skipClosedPlaces included) is billed per place on top of the
  // place price, and closed places are already skipped below from the place's own fields.
  const apifyInputFor = (loc) => ({
    searchStringsArray: [loc.keyword],
    locationQuery: loc.location,
    language: cfg.apify.language,
  });

  // Apify's monthly spending limit: say so plainly up front instead of failing on the first scrape.
  // It only blocks new scrapes; leads already paid for (the backlog) are still worked through.
  const usage = apify.usage ? await apify.usage() : null;
  let apifyLow = false;
  if (usage) {
    summary.apifyUsage = usage;
    log(`Apify this month: $${usage.usedUsd.toFixed(2)} of $${usage.limitUsd.toFixed(2)} used, resets ${String(usage.resetsAt ?? '?').slice(0, 10)}`);
    apifyLow = usage.leftUsd < (cfg.apify.stopBelowUsd ?? 0);
  }

  // Leads already paid for in earlier scrapes: worked through first, 1 lead per new contact,
  // before any new county is scraped. Progress is kept in an Apify key-value store.
  const bl = cfg.backlog?.datasetId ? cfg.backlog : null;
  let backlog = null;
  if (bl) {
    const progress = (await apify.getRecord(bl.stateStoreId, PROGRESS_KEY)) ?? {};
    backlog = { total: await apify.datasetSize(bl.datasetId), offset: Number(progress.offset) || 0 };
    summary.backlog = backlog;
    log(`Paid backlog: ${backlog.offset} of ${backlog.total} checked, ${Math.max(0, backlog.total - backlog.offset)} left`);
  }
  const backlogLeft = () => (backlog ? Math.max(0, backlog.total - backlog.offset) : 0);

  if (dryRun) {
    summary.status = 'dry run';
    if (backlogLeft() > 0) summary.notes.push(`${backlogLeft()} paid backlog leads are worked through before any new scraping`);
    if (apifyLow) summary.notes.push(new ApifyLimitError(usage).message);
    summary.preview = queue.slice(0, 5).map((loc) => ({
      row: loc.rowNumber,
      what: `${loc.keyword} – ${loc.location || loc.county}`,
      apifyInput: loc.savedDatasetId ? `reuse saved Apify results (${loc.savedDatasetId})` : apifyInputFor(loc),
    }));
    return summary;
  }

  // 4. Process. Apify scrapes run a few at a time ahead of the GHL work.
  const writeCoverage = async (loc, status, results, text) => {
    const notes = mergeNotes(loc.notes, `Auto ${today}: ${text}`);
    await sheets.writeCells(cov.tab, [
      { row: loc.rowNumber, col: col.status, value: status },
      { row: loc.rowNumber, col: col.dateRun, value: today },
      { row: loc.rowNumber, col: col.results, value: results },
      { row: loc.rowNumber, col: col.notes, value: asText(notes) },
    ]);
    loc.notes = notes;
  };

  const scrape = async (loc) => {
    try {
      if (loc.savedDatasetId) {
        try {
          return { ok: true, datasetId: loc.savedDatasetId, items: await apify.getItems(loc.savedDatasetId) };
        } catch (err) {
          if (!(err instanceof HttpError && err.status === 404)) throw err;
          summary.notes.push(`row ${loc.rowNumber}: saved Apify results had expired, scraped again`);
        }
      }
      const run = await apify.run(apifyInputFor(loc));
      if (run.status !== 'SUCCEEDED') return { ok: false, reason: run.status };
      const items = await apify.getItems(run.datasetId);
      // Save the dataset id straight away so a crash never means paying Apify twice.
      await writeCoverage(loc, cov.partialStatus, items.length, `scraped ${items.length} places, not processed yet; Apify dataset ${run.datasetId}`);
      return { ok: true, datasetId: run.datasetId, items };
    } catch (err) {
      return { ok: false, reason: err.message, error: err };
    }
  };

  const masterBuffer = [];
  const flushMaster = async () => {
    if (!masterBuffer.length) return;
    const rows = [...masterBuffer];
    await sheets.appendRows(masterTab, rows);
    masterBuffer.splice(0, rows.length);
  };

  const inflight = new Map();
  let nextToStart = 0;
  let stop = false;
  const startMore = () => {
    const parallel = Math.max(1, cfg.apify.parallelRuns ?? 1);
    while (!stop && remaining > 0 && nextToStart < queue.length && inflight.size < parallel) {
      const i = nextToStart++;
      inflight.set(i, scrape(queue[i]));
    }
  };

  const checked = new Set();
  const newCategories = new Set();
  let apifyFailuresInARow = 0;
  let createFailuresInARow = 0;
  let reachedEnd = false;
  let fatal = null;

  const skip = (reason) => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
  };

  /** One place -> GHL contact + Master Leads row, unless it should be skipped. Returns true if added. */
  const tryContact = async (place, loc) => {
    const key = phoneKey(place.phoneUnformatted || place.phone);
    if (!key) return skip('no phone'), false;
    if (checked.has(key)) return false; // same business listed twice tonight: judge it once
    checked.add(key);
    if (cfg.skipClosedPlaces && (place.permanentlyClosed || place.temporarilyClosed)) return skip('closed'), false;
    if (dnc.has(key)) return skip('on Do Not Contact'), false;
    if (masterKeys.has(key)) return skip('already in Master Leads'), false;

    const category = String(place.categoryName ?? '').trim();
    const keep = categories.get(category.toLowerCase());
    if (keep === 'no') return skip('category marked No'), false;
    // Categories not on the tab are kept; they're listed in the run report so you can add them.
    if (category && keep === undefined) newCategories.add(category);

    const name = cleanName(place.title);
    const contact = placeToContact({ ...place, cleanName: name }, cfg.ghl.fields, cfg.ghl.tags ?? []);
    if (await ghl.findDuplicate({ phone: contact.phone })) return skip('already in GHL'), false;
    let created;
    try {
      created = await ghl.createContact(contact);
      createFailuresInARow = 0;
    } catch (err) {
      if (isFatal(err) || ++createFailuresInARow >= 5) throw err;
      return skip('rejected by GHL'), false;
    }
    if (created.duplicate) return skip('already in GHL'), false;

    masterKeys.add(key);
    masterBuffer.push(masterHeader.map((h) => MASTER_FIELDS[h.toLowerCase()]?.({ place, loc, name, key, today, cfg }) ?? ''));
    remaining--;
    summary.newContacts++;

    if (ghl.workflowId) {
      try {
        await ghl.addToWorkflow(created.id);
      } catch (err) {
        summary.enrollFailed.push(created.id);
        throw err;
      }
    }
    if (masterBuffer.length >= MASTER_FLUSH_EVERY) await flushMaster();
    return true;
  };

  const saveBacklogProgress = () =>
    apify.setRecord(bl.stateStoreId, PROGRESS_KEY, { offset: backlog.offset, total: backlog.total, updated: now().toISOString() });

  try {
    // 4a. The paid backlog first.
    if (backlogLeft() > 0) {
      const before = summary.newContacts;
      try {
        while (remaining > 0 && backlogLeft() > 0) {
          const page = await apify.getItemsPage(bl.datasetId, backlog.offset, BACKLOG_PAGE);
          if (!page.length) {
            backlog.total = backlog.offset; // dataset is shorter than it said: treat it as finished
            break;
          }
          for (const item of page) {
            if (remaining <= 0) break;
            const loc = { state: item.sourceState, county: item.sourceCounty, keyword: item.sourceKeyword, note: bl.note };
            await tryContact(item, loc);
            backlog.offset++;
          }
          await flushMaster();
          await saveBacklogProgress();
        }
      } finally {
        await flushMaster().catch(() => {});
        await saveBacklogProgress().catch((err) => summary.notes.push(`could not save backlog progress (${err.message})`));
      }
      summary.backlogContacts = summary.newContacts - before;
      log(`Paid backlog: ${summary.backlogContacts} new contacts, ${backlogLeft()} leads left`);
      if (backlogLeft() === 0) summary.notes.push('Paid backlog finished: new counties are scraped from here on');
    }

    // 4b. Then new scrapes from the Coverage Log, with whatever is left of today's budget.
    if (remaining > 0 && queue.length && apifyLow) throw new ApifyLimitError(usage);
    if (remaining > 0) startMore();
    for (let i = 0; i < queue.length; i++) {
      if (remaining <= 0 || stop) break;
      const loc = queue[i];
      if (!inflight.has(i)) inflight.set(i, scrape(loc));
      const res = await inflight.get(i);
      inflight.delete(i);

      if (!res.ok) {
        if (res.error && isFatal(res.error)) throw res.error;
        summary.apifyFailures.push(`row ${loc.rowNumber} (${res.reason})`);
        if (++apifyFailuresInARow >= 2) {
          stop = true;
          summary.stoppedOnFailures = true;
          break;
        }
        startMore();
        continue;
      }
      apifyFailuresInARow = 0;
      startMore();
      log(`Row ${loc.rowNumber} (${loc.keyword}, ${loc.county || loc.location}): ${res.items.length} places`);

      const skippedBefore = Object.values(summary.skipped).reduce((a, b) => a + b, 0);
      let added = 0;
      let stoppedEarly = false;
      for (const place of res.items) {
        if (remaining <= 0) {
          stoppedEarly = true;
          break;
        }
        if (await tryContact(place, loc)) added++;
      }
      const skipped = Object.values(summary.skipped).reduce((a, b) => a + b, 0) - skippedBefore;

      await flushMaster();
      if (stoppedEarly) {
        await writeCoverage(loc, cov.partialStatus, res.items.length, `${added} new so far, finishes next run; Apify dataset ${res.datasetId}`);
        summary.partialRows.push(loc.rowNumber);
      } else {
        await writeCoverage(loc, cov.doneStatus, res.items.length, `${res.items.length} found, ${added} new, ${skipped} skipped; Apify dataset ${res.datasetId}`);
        summary.locationsFinished.push(loc.rowNumber);
      }
    }
    // The loop only breaks early for the limit or for failures, so this means every location was tried.
    if (remaining > 0 && !stop) reachedEnd = true;
  } catch (err) {
    fatal = err;
    summary.status = err instanceof ApifyLimitError ? 'stopped: Apify monthly limit reached' : `error: ${err.message}`.slice(0, 300);
  } finally {
    stop = true;
    await flushMaster().catch((err) => {
      summary.notes.push(`COULD NOT SAVE to Master Leads (${err.message}): ${masterBuffer.map((r) => r.join(' / ')).join('; ')}`);
    });
    // Scrapes already running finish and save their dataset id (row marked Partial) for the next run.
    await Promise.allSettled(inflight.values());
    summary.newCategories = [...newCategories];
  }

  if (fatal) {
    fatal.summary = summary;
    throw fatal;
  }
  if (remaining <= 0) summary.status = 'daily limit reached';
  else if (summary.stoppedOnFailures) summary.status = 'stopped: Apify failed twice in a row';
  else if (reachedEnd && queue.length === pending.length) summary.status = 'ran out of locations';
  else summary.status = 'done';
  return summary;
}
