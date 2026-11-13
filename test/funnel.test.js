import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { computeFunnel, funnelRows } from '../src/funnel.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const pipelines = [
  { id: 'sms', name: 'SMS Pipeline', stages: [{ id: 's1', name: 'New Prospect 👥' }, { id: 's2', name: 'Prospect Replied 💬' }] },
  {
    id: 'sales',
    name: 'Sales Pipeline',
    stages: [{ id: 'b', name: 'Appointment Booked' }, { id: 'sh', name: 'Appointment Showed' }, { id: 'ns', name: 'No-Show' }, { id: 'w', name: 'New Client' }],
  },
];
const contact = (id, name, tags, month = '2026-10') => ({ id, companyName: name, tags, dateAdded: `${month}-05T00:00:00Z` });
const opp = (contactId, pipelineId, pipelineStageId, extra = {}) => ({ contactId, pipelineId, pipelineStageId, status: 'open', ...extra });

test('counts each texted lead once at the furthest step it reached, by month and by fit', () => {
  const contacts = [
    contact('a', 'Gulf Pavers', ['sms']), // texted only
    contact('b', 'Stone Patios', ['sms']), // replied (SMS card moved)
    contact('c', 'Coastal Hardscape', ['sms', 'demo call booked']), // booked by tag, no card
    contact('d', 'Elite Outdoor Living', ['sms']), // showed
    contact('e', "Rojo's Lawn Service", ['sms']), // no-show
    contact('f', 'Design Scapes', ['sms'], '2026-11'), // signed
    contact('g', 'Mark', ['demo call booked']), // test contact, never texted: left out
  ];
  const opportunities = [
    opp('a', 'sms', 's1'),
    opp('b', 'sms', 's2'),
    opp('d', 'sales', 'sh'),
    opp('e', 'sales', 'ns'),
    opp('f', 'sales', 'w', { monetaryValue: 1000 }),
    opp('g', 'sales', 'b'),
  ];

  const g = computeFunnel({ contacts, opportunities, pipelines, config });

  assert.deepEqual(g.total, { texted: 6, replied: 5, booked: 4, showed: 2, noShow: 1, won: 1, wonValue: 1000 });
  assert.equal(g.month['2026-11'].won, 1);
  assert.equal(g.fit['mowing / lawn care (by name)'].texted, 1);
  const rows = funnelRows(g);
  assert.deepEqual(rows[0], ['All texted', 6, 5, 4, 2, 1, 1, 1000, '66.7%', '50.0%', '50.0%']);
});
