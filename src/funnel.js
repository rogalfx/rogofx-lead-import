// The sales funnel from GHL: texted -> replied -> booked -> showed -> signed, by month the lead was added
// and by fit (installer vs mowing crew, judged on the business name with config.installersOnly).
// Only contacts with the outbound SMS tag count, so test contacts and inbound leads stay out.
import { installerFilter } from './mapping.js';

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '');

export function computeFunnel({ contacts, opportunities, pipelines, config }) {
  const f = config.funnel;
  const byId = new Map(pipelines.map((p) => [p.id, p]));
  const sms = pipelines.find((p) => p.name === f.smsPipeline);
  const sales = pipelines.find((p) => p.name === f.salesPipeline);
  const stageName = (o) => byId.get(o.pipelineId)?.stages.find((s) => s.id === o.pipelineStageId)?.name ?? '';
  const lower = (list) => new Set((list ?? []).map((s) => s.toLowerCase()));
  const replyTags = lower(f.replyTags);
  const bookedTags = lower(f.bookedTags);
  const showed = lower(f.showedStages);
  const noShow = lower(f.noShowStages);
  const won = lower(f.wonStages);
  const notFit = installerFilter(config.installersOnly);

  const oppsByContact = new Map();
  for (const o of opportunities) {
    if (!oppsByContact.has(o.contactId)) oppsByContact.set(o.contactId, []);
    oppsByContact.get(o.contactId).push(o);
  }

  const blank = () => ({ texted: 0, replied: 0, booked: 0, showed: 0, noShow: 0, won: 0, wonValue: 0 });
  const groups = { total: blank(), month: {}, fit: {} };
  for (const c of contacts) {
    const tags = lower(c.tags);
    if (!tags.has(f.textedTag.toLowerCase())) continue;
    const opps = oppsByContact.get(c.id) ?? [];
    const smsOpp = opps.find((o) => o.pipelineId === sms?.id);
    const salesOpp = opps.find((o) => o.pipelineId === sales?.id);
    const smsStage = smsOpp ? stageName(smsOpp).toLowerCase() : '';
    const salesStage = salesOpp ? stageName(salesOpp).toLowerCase() : '';
    const isWon = Boolean(salesOpp && (salesOpp.status === 'won' || won.has(salesStage)));
    const isShowed = isWon || showed.has(salesStage);
    const isBooked = isShowed || Boolean(salesOpp) || [...bookedTags].some((t) => tags.has(t));
    const isReplied =
      isBooked || [...replyTags].some((t) => tags.has(t)) || Boolean(smsStage && smsStage !== f.firstStage.toLowerCase());

    const name = c.companyName || c.firstName || '';
    const keys = [
      groups.total,
      (groups.month[String(c.dateAdded ?? '').slice(0, 7) || '?'] ??= blank()),
      (groups.fit[notFit({ title: name }) ? 'mowing / lawn care (by name)' : 'installer or unclear'] ??= blank()),
    ];
    for (const g of keys) {
      g.texted++;
      if (isReplied) g.replied++;
      if (isBooked) g.booked++;
      if (isShowed) g.showed++;
      if (noShow.has(salesStage)) g.noShow++;
      if (isWon) {
        g.won++;
        g.wonValue += Number(salesOpp.monetaryValue) || 0;
      }
    }
  }
  return groups;
}

export const FUNNEL_HEADER = ['Group', 'Texted', 'Replied', 'Booked', 'Showed', 'No-show', 'Signed', 'Signed value ($/mo)', 'Booked per text', 'Show rate', 'Close rate (of showed)'];

export function funnelRows(groups) {
  const line = (label, g) => [label, g.texted, g.replied, g.booked, g.showed, g.noShow, g.won, g.wonValue, pct(g.booked, g.texted), pct(g.showed, g.booked), pct(g.won, g.showed)];
  return [
    line('All texted', groups.total),
    ...Object.entries(groups.fit).sort().map(([k, g]) => line(k, g)),
    ...Object.entries(groups.month).sort().map(([k, g]) => line(`Added ${k}`, g)),
  ];
}
