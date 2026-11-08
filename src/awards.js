import { dates } from './inputs.js';
import { UserError } from './net.js';
import { cleanText, money } from './sam.js';

const ENDPOINT = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const COUNT_ENDPOINT = 'https://api.usaspending.gov/api/v2/search/spending_by_award_count/';
const FIELDS = ['Award ID', 'Recipient Name', 'Recipient UEI', 'Awarding Agency', 'Awarding Sub Agency',
  'Award Amount', 'Base Obligation Date', 'Start Date', 'End Date', 'Description', 'NAICS', 'PSC',
  'Place of Performance State Code', 'generated_internal_id'];

export function awardQuery(filters, now, page, limit, sort) {
  const { from, to } = dates(filters.from, filters.to, 730, 3653, now);
  if (from < '2007-10-01') throw new UserError('USAspending award search begins on 2007-10-01.');
  const { keyword, naics, psc, agency, recipient, awardId, state } = filters;
  if (!keyword && !naics && !psc && !agency && !recipient && !awardId && !state) {
    throw new UserError('Add at least one award filter such as NAICS, PSC, keyword, agency, recipient, PIID, or state.');
  }
  return {
    filters: {
      award_type_codes: ['A', 'B', 'C', 'D'],
      time_period: [{ start_date: from, end_date: to, date_type: 'new_awards_only' }],
      ...(keyword && { keywords: [keyword] }),
      ...(naics && { naics_codes: { require: [naics] } }),
      ...(psc && { psc_codes: [psc] }),
      ...(agency && { agencies: [{ type: 'awarding', tier: 'toptier', name: agency }] }),
      ...(recipient && { recipient_search_text: [recipient] }),
      ...(awardId && { award_ids: [awardId] }),
      ...(state && { place_of_performance_locations: [{ country: 'USA', state }] })
    },
    fields: FIELDS,
    page, limit, order: 'desc',
    sort: sort === 'recent' ? 'Base Obligation Date' : 'Award Amount'
  };
}

function normalize(row) {
  const generatedId = cleanText(row?.generated_internal_id, 240);
  if (!generatedId) throw new UserError('USAspending returned a contract without a unique award identifier.');
  return {
    generatedId,
    awardId: cleanText(row['Award ID'], 100),
    recipient: cleanText(row['Recipient Name'], 160),
    recipientUei: cleanText(row['Recipient UEI'], 12),
    awardingAgency: cleanText(row['Awarding Agency'], 160),
    awardingSubAgency: cleanText(row['Awarding Sub Agency'], 160),
    amount: money(row['Award Amount']),
    signedDate: cleanText(row['Base Obligation Date'], 30),
    startDate: cleanText(row['Start Date'], 30),
    endDate: cleanText(row['End Date'], 30),
    description: cleanText(row.Description, 600),
    naics: cleanText(row.NAICS?.code ?? row.NAICS, 12),
    psc: cleanText(row.PSC?.code ?? row.PSC, 12),
    state: cleanText(row['Place of Performance State Code'], 12),
    url: `https://www.usaspending.gov/award/${encodeURIComponent(generatedId)}`
  };
}

export function createAwards(request) {
  async function count(filters) {
    try {
      const { data, retrievedAt } = await request('USAspending', new URL(COUNT_ENDPOINT), { body: { filters } });
      const total = data?.results?.contracts;
      if (!Number.isSafeInteger(total) || total < 0) {
        throw new UserError('USAspending returned an unexpected award count.');
      }
      return { total, retrievedAt };
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      return { error: error.message };
    }
  }

  return async function search(filters, now, { page = 1, limit = 20, sort = 'amount', withCount = false } = {}) {
    const body = awardQuery(filters, now, page, limit, sort);
    const [{ data, retrievedAt }, upstreamCount] = await Promise.all([
      request('USAspending', new URL(ENDPOINT), { body }),
      withCount && !filters.awardId ? count(body.filters) : null
    ]);
    if (!Array.isArray(data?.results) || data.results.length > limit ||
        typeof data.page_metadata?.hasNext !== 'boolean') {
      throw new UserError('USAspending returned an unexpected awards response.');
    }
    // The quoted exact-match query can return HTTP 503. Check the PIID on each unquoted candidate.
    const rows = data.results.map(normalize).filter((row) =>
      !filters.awardId || row.awardId?.toUpperCase() === filters.awardId.toUpperCase());
    const awards = [...new Map(rows.map((row) => [row.generatedId, row])).values()];
    const moreAvailable = data.page_metadata.hasNext;
    const matchingCount = withCount && filters.awardId && page === 1 && !moreAvailable
      ? { total: awards.length, retrievedAt }
      : upstreamCount;
    return {
      awards,
      nextPage: moreAvailable && page < 100 ? page + 1 : null,
      moreAvailable,
      matchingCount,
      ...(filters.awardId && { filterScope: 'Exact PIID checked on the retrieved candidates. More pages, if available, may contain more candidates.' }),
      dateRange: { from: body.filters.time_period[0].start_date, to: body.filters.time_period[0].end_date },
      retrievedAt,
      source: 'USAspending',
      url: 'https://www.usaspending.gov/search'
    };
  };
}

const dollars = (cents) => cents / 100;
const share = (cents, total) => total ? Math.round(cents / total * 1000) / 10 : null;

export function marketSummary(result) {
  const recipients = new Map();
  const buyers = new Map();
  let positive = 0;
  let net = 0;
  let missing = 0;
  for (const row of result.awards) {
    const cents = Math.round((row.amount ?? 0) * 100);
    const positiveCents = Math.max(0, cents);
    if (row.amount === null) missing++;
    positive += positiveCents;
    net += cents;
    // Unidentified recipients get separate buckets. Names alone cannot resolve aliases.
    const key = row.recipientUei || (row.recipient ? `name:${row.recipient.toUpperCase()}` : row.generatedId);
    const recipient = recipients.get(key) ?? {
      recipient: row.recipient, uei: row.recipientUei, count: 0, positiveCents: 0, exampleUrl: row.url
    };
    recipient.count++;
    recipient.positiveCents += positiveCents;
    recipients.set(key, recipient);
    const buyer = buyers.get(row.awardingAgency) ?? {
      agency: row.awardingAgency, count: 0, positiveCents: 0, exampleUrl: row.url
    };
    buyer.count++;
    buyer.positiveCents += positiveCents;
    buyers.set(row.awardingAgency, buyer);
  }
  const top = (groups) => [...groups.values()]
    .sort((a, b) => b.positiveCents - a.positiveCents || b.count - a.count)
    .slice(0, 8)
    .map(({ positiveCents, ...group }) => ({
      ...group, positiveAwardAmount: dollars(positiveCents), shareOfPositiveAmountPct: share(positiveCents, positive)
    }));
  const count = result.matchingCount?.total;
  const sampleSize = result.awards.length;
  return {
    source: result.source,
    url: result.url,
    retrievedAt: result.retrievedAt,
    dateRange: result.dateRange,
    coverage: {
      awardsAnalyzed: sampleSize,
      matchingAwards: count ?? null,
      countRetrievedAt: result.matchingCount?.retrievedAt ?? null,
      countError: result.matchingCount?.error ?? null,
      sampleShareOfMatchingAwardsPct: count > 0 && count >= sampleSize ? share(sampleSize, count) : null,
      additionalMatches: result.moreAvailable || count > sampleSize,
      ...(result.filterScope && { filterScope: result.filterScope }),
      selection: 'First page, sorted by reported award amount descending.'
    },
    totals: {
      netAwardAmount: dollars(net), positiveAwardAmount: dollars(positive), awardsMissingAmount: missing
    },
    leadingRecipients: top(recipients),
    leadingAwardingAgencies: top(buyers),
    examples: result.awards.slice(0, 8),
    interpretation: [
      'Shares use positive award amounts within the retrieved records. They are sample shares, not market share.',
      'The date filter selects newly signed awards. Reported award amounts can reflect subsequent modifications and are not fiscal-period spending.',
      'Recipients are grouped by UEI when available and exact name otherwise. Confirm identities on USAspending.'
    ]
  };
}
