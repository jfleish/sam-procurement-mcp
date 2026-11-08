import assert from 'node:assert/strict';
import test from 'node:test';
import { awardQuery, createAwards, marketSummary } from '../src/awards.js';
import { compareBaseline, createIntelligence, fitFor, makeBaseline } from '../src/intelligence.js';
import { createRequester, UserError } from '../src/net.js';
import { createSam, deadlineStatus, htmlText } from '../src/sam.js';

const now = new Date('2026-08-01T12:00:00Z');
const id = 'f'.repeat(32);
const row = { noticeId: id, title: 'Cloud security', active: 'Yes', postedDate: '2026-07-30',
  responseDeadLine: '2026-08-02T20:00:00-04:00', naicsCode: '541512', classificationCode: 'DA01' };
const secret = 'synthetic_test_key';
const readCredential = async () => ({ key: secret, source: 'test' });
const json = (value) => new Response(JSON.stringify(value));

test('SAM maps search dates, uses a page index, and rebuilds the authenticated description URL', async () => {
  const calls = [];
  const request = createRequester(async (url, options) => {
    calls.push(new URL(url));
    assert.equal(options.redirect, 'error');
    if (url.pathname.endsWith('noticedesc')) {
      return json({ description: '<p>Provide &amp; verify.</p><script>ignore</script><p>Scope</p>' });
    }
    return json({ totalRecords: 4, opportunitiesData: [row] });
  });
  const sam = createSam(request, readCredential);
  const data = await sam.search({ title: 'Cloud & security', noticeType: 'combined', naics: '541512',
    postedFrom: '2026-07-01', postedTo: '2026-08-01' }, now, { page: 2, limit: 3 });
  assert.equal(data.total, 4);
  assert.equal(calls[0].pathname, '/opportunities/v2/search');
  assert.deepEqual(Object.fromEntries(calls[0].searchParams), { postedFrom: '07/01/2026', postedTo: '08/01/2026',
    limit: '3', offset: '1', title: 'Cloud & security', ncode: '541512', ptype: 'k', api_key: secret });
  const description = await sam.description({ ...row,
    description: 'https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=bad&api_key=bad&other=bad' });
  assert.match(description, /^Provide & verify\.\s+Scope$/);
  assert.deepEqual(Object.fromEntries(calls[1].searchParams), { noticeid: id, api_key: secret });
  await assert.rejects(() => sam.description({ ...row, description: 'https://evil.invalid/notice' }), /unrecognized/);
  assert.equal(calls.length, 2);
  assert.equal(htmlText('10 < 20 and 20 > 10'), '10 < 20 and 20 > 10');
});

test('requester coalesces requests, avoids repeat quota use and keeps request details out of errors', async () => {
  let calls = 0;
  const request = createRequester(async () => { calls++; return json({}); });
  const url = new URL('https://api.sam.gov/?api_key=' + secret);
  await Promise.all([request('SAM.gov', url), request('SAM.gov', url)]);
  await request('SAM.gov', url);
  assert.equal(calls, 1);
  await request('SAM.gov', url, { fresh: true });
  assert.equal(calls, 2);

  const rejected = createRequester(async () => new Response(secret, { status: 429 }));
  await assert.rejects(() => rejected('SAM.gov', url), (error) =>
    error.message.includes('rate limit') && !error.message.includes(secret));
  const offline = createRequester(async () => { throw new Error(url.href); });
  await assert.rejects(() => offline('SAM.gov', url), (error) => !error.message.includes(secret));
  const missing = createRequester(async () => new Response('', { status: 404 }));
  assert.equal((await missing('SAM.gov', url, { allowMissing: true })).data, null);
  await assert.rejects(() => missing('SAM.gov', url), /HTTP 404/);
});

test('USAspending retries one transient gateway failure within the original deadline', async () => {
  let calls = 0;
  const request = createRequester(async () => ++calls === 1 ? new Response('', { status: 503 }) : json({ results: [] }));
  const result = await request('USAspending', new URL('https://api.usaspending.gov/'), { body: {} });
  assert.equal(calls, 2);
  assert.deepEqual(result.data, { results: [] });
});

test('entity lookups project a public, exact UEI allowlist', async () => {
  const uei = 'DEMO00000001';
  const result = await createSam(createRequester(async (url) => {
    assert.equal(url.searchParams.get('ueiSAM'), uei);
    assert.equal(url.searchParams.get('sensitivity'), 'public');
    assert.equal(url.searchParams.get('samRegistered'), 'Yes');
    assert.equal(url.searchParams.get('includeSections'), 'entityRegistration');
    return json({ entityData: [
      { entityRegistration: { ueiSAM: uei, publicDisplayFlag: 'Y', samRegistered: 'Yes', legalBusinessName: 'Public LLC', tin: 'secret' } },
      { entityRegistration: { ueiSAM: uei, publicDisplayFlag: 'N', samRegistered: 'Yes', legalBusinessName: 'Private LLC' } },
      { entityRegistration: { ueiSAM: uei, publicDisplayFlag: 'Y', samRegistered: 'No', legalBusinessName: 'Unregistered LLC' } },
      { entityRegistration: { ueiSAM: 'OTHER0000000', publicDisplayFlag: 'Y', samRegistered: 'Yes', legalBusinessName: 'Wrong LLC' } }
    ] });
  }), readCredential).lookupEntity(uei);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].legalBusinessName, 'Public LLC');
  assert.doesNotMatch(JSON.stringify(result), /secret|Private LLC|Wrong LLC|Unregistered LLC/);
});

test('SAM connection status uses one explicit check, tracks errors, and resets after rotation', async () => {
  let credential = { key: secret, source: 'test' };
  let response = () => json({ totalRecords: 0, opportunitiesData: [], echo: secret });
  let requests = 0;
  const sam = createSam(createRequester(async (url) => {
    requests++;
    assert.equal(url.origin, 'https://api.sam.gov');
    assert.equal(url.searchParams.get('api_key'), credential.key);
    return response();
  }), async () => {
    if (!credential) throw new UserError('Run setup in a terminal.', 'missing_key');
    return credential;
  });
  assert.equal((await sam.status()).samConnectionStatus, 'unverified');
  assert.equal(requests, 0);
  assert.equal((await sam.status(true)).samConnectionStatus, 'connected');
  assert.equal(requests, 1);
  response = () => new Response(`An invalid api_key was supplied: ${secret}`, { status: 400 });
  const rejected = await sam.status(true);
  assert.equal(rejected.samConnectionStatus, 'authentication_failed');
  assert.equal((await sam.status()).samConnectionStatus, 'authentication_failed');
  assert(!JSON.stringify(rejected).includes(secret));
  response = () => new Response(secret, { status: 429 });
  assert.equal((await sam.status(true)).samConnectionStatus, 'rate_limited');
  response = () => { throw new Error(`Transport failed with ${secret}`); };
  const offline = await sam.status(true);
  assert.equal(offline.samConnectionStatus, 'unreachable');
  assert(!JSON.stringify(offline).includes(secret));
  credential = { key: 'synthetic_rotated_key', source: 'test' };
  assert.equal((await sam.status()).samConnectionStatus, 'unverified');
  response = () => new Response('', { status: 404 });
  assert.equal((await sam.status(true)).samConnectionStatus, 'upstream_error');
  credential = null;
  assert.equal((await sam.status()).samConnectionStatus, 'missing_key');
  assert.equal(requests, 5);
});

test('SAM response values and failed requests cannot echo the key', async () => {
  const request = createRequester(async () => json({ description: `Upstream echoed ${secret}` }));
  const sam = createSam(request, readCredential);
  const result = await sam.description({ ...row,
    description: `https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=${id}` });
  assert.equal(result, 'Upstream echoed [redacted]');
});

test('opportunity ranking explains missing data and never assumes a time zone', () => {
  const notice = { title: 'Cloud security', naics: '541512', active: true, responseDeadline: '2026-08-02T12:00:00' };
  const fit = fitFor(notice, { naicsCodes: ['541512'], pscCodes: ['DA01'], titlePhrases: ['cloud'] });
  assert.equal(fit.score, 64);
  assert.equal(fit.evidence.find((field) => field.dimension === 'PSC').outcome, 'unknown');
  assert.equal(deadlineStatus(notice, now), 'unknown');
  assert.equal(deadlineStatus({ ...notice, responseDeadline: '2026-08-02T12:00:00Z' }, now), 'open');
  assert.equal(deadlineStatus({ ...notice, responseDeadline: '2026-08-01T08:00:00-04:00' }, now), 'past_deadline');
});

test('snapshot comparison handles amendments and missing descriptions separately', async () => {
  let deadline = row.responseDeadLine;
  let description = 'Original description';
  let wrongId = false;
  const sam = {
    async search() {
      return { rows: [{ ...row, responseDeadLine: deadline, noticeId: wrongId ? '0'.repeat(32) : id }],
        retrievedAt: now.toISOString() };
    },
    async description() { return description; }
  };
  const intelligence = createIntelligence({ sam, clock: () => now });
  const baseline = makeBaseline(await intelligence.snapshot({ noticeId: id }));
  deadline = '2026-08-10T20:00:00-04:00';
  description = 'Amended description';
  const changed = compareBaseline(baseline, await intelligence.snapshot({ noticeId: id }));
  assert.deepEqual(changed.changes.map(({ field }) => field), ['responseDeadline']);
  assert.equal(changed.descriptionStatus, 'changed');
  description = null;
  deadline = row.responseDeadLine;
  const withoutText = await intelligence.snapshot({ noticeId: id });
  const gone = compareBaseline(baseline, withoutText);
  assert.equal(gone.descriptionStatus, 'no_longer_available');
  assert.equal(gone.status, 'changed');
  const unavailable = compareBaseline(baseline, { ...withoutText, descriptionError: 'Temporary error' });
  assert.equal(unavailable.descriptionStatus, 'fetch_failed');
  assert.equal(unavailable.status, 'incomplete');
  wrongId = true;
  await assert.rejects(() => intelligence.snapshot({ noticeId: id }), /different notice ID/);
});

test('related notice discovery checks exact solicitation number and buyer before showing other IDs', async () => {
  const baseline = { ...row, solicitationNumber: 'ABC-1', fullParentPathCode: '001.1', fullParentPathName: 'Buyer' };
  const later = { ...baseline, noticeId: 'a'.repeat(32), title: 'Amendment' };
  const sam = {
    async search(query, _now, options) {
      assert.deepEqual(query, { solicitationNumber: 'ABC-1', postedFrom: '2026-07-30' });
      assert.equal(options.fresh, true);
      return { rows: [baseline, later, { ...later, fullParentPathCode: '002.1' },
        { ...later, solicitationNumber: 'ABC-10' }], total: 4, retrievedAt: now.toISOString() };
    }
  };
  const intelligence = createIntelligence({ sam, clock: () => now });
  const related = await intelligence.relatedNotices({
    noticeId: id, solicitationNumber: 'ABC-1', postedDate: '2026-07-30',
    organization: 'Buyer', organizationCode: '001.1'
  });
  assert.deepEqual(related.notices.map((notice) => notice.noticeId), [later.noticeId]);
  assert.equal(related.examined, 4);
});

test('award requests use signed-date prime contract filters and summarize positive-dollar shares', async () => {
  assert.throws(() => awardQuery({}, now, 1, 20), /Add at least one award filter/);
  const request = createRequester(async (url, options) => {
    const query = JSON.parse(options.body);
    assert.deepEqual(query.filters.award_type_codes, ['A', 'B', 'C', 'D']);
    assert.equal(query.filters.time_period[0].date_type, 'new_awards_only');
    assert.deepEqual(query.filters.naics_codes.require, ['541512']);
    assert.deepEqual(query.filters.psc_codes, ['DA01']);
    assert.equal(query.filters.award_ids, undefined);
    if (url.pathname.endsWith('spending_by_award_count/')) return json({ results: { contracts: 20 } });
    const award = (awardId, amount, uei) => ({
      generated_internal_id: awardId, 'Award Amount': amount, 'Recipient UEI': uei,
      'Recipient Name': 'Example', 'Awarding Agency': 'Agency', NAICS: { code: '541512' }, PSC: { code: 'DA01' }
    });
    return json({ results: [award('A1', 100, 'DEMO00000001'), award('A2', 50, 'DEMO00000001'),
      award('A3', 50, 'DEMO00000002'), award('A4', -10, 'DEMO00000002'), award('A5', null, null)],
    page_metadata: { hasNext: true } });
  });
  const summary = marketSummary(await createAwards(request)({ naics: '541512', psc: 'DA01' }, now,
    { withCount: true }));
  assert.equal(summary.totals.netAwardAmount, 190);
  assert.equal(summary.totals.positiveAwardAmount, 200);
  assert.equal(summary.totals.awardsMissingAmount, 1);
  assert.equal(summary.leadingRecipients[0].shareOfPositiveAmountPct, 75);
  assert.equal(summary.coverage.additionalMatches, true);
  assert.equal(summary.coverage.matchingAwards, 20);
  assert.equal(summary.coverage.sampleShareOfMatchingAwardsPct, 25);
  assert.equal(summary.examples[0].naics, '541512');
});

test('PIID searches use unquoted candidates, verify exact IDs, and sort by signing date', async () => {
  const request = createRequester(async (url, options) => {
    assert.match(url.pathname, /spending_by_award\/$/);
    const query = JSON.parse(options.body);
    assert.deepEqual(query.filters.award_ids, ['ABC-1']);
    assert.equal(query.sort, 'Base Obligation Date');
    const rows = ['ABC-10', 'ABC-1'].map((id) => ({
      generated_internal_id: id, 'Award ID': id, 'Base Obligation Date': '2026-08-01', 'Start Date': '2026-09-01'
    }));
    return json({ results: rows, page_metadata: { hasNext: false } });
  });
  const result = await createAwards(request)({ awardId: 'ABC-1' }, now, { withCount: true, sort: 'recent' });
  assert.deepEqual(result.awards.map((row) => row.awardId), ['ABC-1']);
  assert.equal(result.awards[0].signedDate, '2026-08-01');
  assert.equal(result.matchingCount.total, 1);
});
