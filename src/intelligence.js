import { createHash } from 'node:crypto';
import { marketSummary } from './awards.js';
import { dateOffset } from './inputs.js';
import { UserError } from './net.js';
import { deadlineStatus, normalizeOpportunity, resources } from './sam.js';

const TEXT_PAGE = 6000;

export function fitFor(notice, profile) {
  const dimensions = [
    ['NAICS', profile.naicsCodes, notice.naics, 35],
    ['PSC', profile.pscCodes, notice.psc, 25],
    ['place of performance', profile.states, notice.placeOfPerformance?.state, 15],
    ['set-aside code', profile.setAsideCodes, notice.setAsideCode, 15]
  ];
  const evidence = [];
  for (const [dimension, codes, value, weight] of dimensions) {
    if (!codes?.length) continue;
    evidence.push({ dimension, value: value ?? null,
      outcome: !value ? 'unknown' : codes.includes(value.toUpperCase()) ? 'match' : 'mismatch', weight });
  }
  if (profile.titlePhrases?.length) {
    const matches = profile.titlePhrases.filter((phrase) => notice.title?.toLowerCase().includes(phrase.toLowerCase()));
    evidence.push({ dimension: 'title phrases', value: matches,
      outcome: !notice.title ? 'unknown' : matches.length ? 'match' : 'mismatch', weight: 10 });
  }
  const available = evidence.reduce((sum, row) => sum + row.weight, 0);
  const matched = evidence.reduce((sum, row) => sum + (row.outcome === 'match' ? row.weight : 0), 0);
  return { score: available ? Math.round(100 * matched / available) : null, evidence };
}

function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sliceDescription(text, offset) {
  if (text === null) return null;
  if (offset > text.length || (offset === text.length && offset !== 0)) {
    throw new UserError('Description offset is past the available text. Start at offset 0.');
  }
  let end = Math.min(text.length, offset + TEXT_PAGE);
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length };
}

export function createIntelligence({ sam, awards, demo, clock = () => new Date() }) {
  const source = demo ? 'Synthetic demo' : 'SAM.gov';

  function decorate(row, now) {
    const notice = normalizeOpportunity(row);
    if (demo) notice.url = `https://example.invalid/notices/${notice.noticeId}`;
    return { ...notice, deadlineStatus: deadlineStatus(notice, now) };
  }

  async function search(filters) {
    const { page = 1, limit = 15, profile, ...query } = filters;
    const now = clock();
    const result = await sam.search(query, now, { page, limit });
    let notices = result.rows.map((row) => decorate(row, now));
    if (query.openOnly) notices = notices.filter((item) => item.deadlineStatus === 'open');
    if (profile) {
      notices = notices.map((item) => ({ ...item, fit: fitFor(item, profile) }))
        .sort((a, b) => (b.fit.score ?? -1) - (a.fit.score ?? -1));
    }
    const moreAvailable = result.total > page * limit;
    return {
      source, retrievedAt: result.retrievedAt, dateRange: { from: result.from, to: result.to },
      totalSourceMatches: result.total, sourceRowsOnPage: result.rows.length, page,
      nextPage: moreAvailable && page < 100 ? page + 1 : null, moreAvailable, notices,
      ...(query.openOnly && { openOnlyScope: 'Applied to the current page. Active notices without a zone-qualified deadline are excluded.' }),
      ...(profile && { fitScope: 'Current page ranked by supplied profile. Unknown fields receive no match credit. Review actual eligibility in the notice.' })
    };
  }

  async function snapshot({ noticeId, postedDate, fresh = false }) {
    const now = clock();
    const options = { limit: 1, defaultDays: 365, fresh };
    const today = now.toISOString().slice(0, 10);
    const older = postedDate && postedDate < dateOffset(today, -365);
    if (postedDate > today) throw new UserError('Use the notice’s original posting date, which cannot be in the future.');
    let result = await sam.search({ noticeId, postedFrom: postedDate, postedTo: older ? postedDate : today }, now, options);
    // An amended older notice may have a new posting date.
    if (older && result.rows.length === 0) result = await sam.search({ noticeId }, now, options);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (typeof row?.noticeId !== 'string' || row.noticeId.toLowerCase() !== noticeId) {
      throw new UserError('SAM.gov returned a different notice ID. Refine the posted date.');
    }
    const notice = { ...decorate(row, now), ...resources(row) };
    try {
      const description = await sam.description(row, { fresh });
      return { source, retrievedAt: result.retrievedAt, notice, description, descriptionError: null };
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      return { source, retrievedAt: result.retrievedAt, notice, description: null, descriptionError: error.message };
    }
  }

  async function relatedNotices(baseline) {
    const { noticeId, solicitationNumber, organization, organizationCode, postedDate } = baseline;
    if (!solicitationNumber || (!organization && !organizationCode)) return null;
    const now = clock();
    const oldest = dateOffset(now.toISOString().slice(0, 10), -365);
    const postedFrom = postedDate && postedDate > oldest ? postedDate : oldest;
    try {
      const result = await sam.search({ solicitationNumber, postedFrom }, now, { limit: 15, fresh: true });
      const notices = result.rows.map((row) => decorate(row, now)).filter((notice) => {
        const sameBuyer = organizationCode && notice.organizationCode
          ? organizationCode === notice.organizationCode
          : organization && organization.toUpperCase() === notice.organization?.toUpperCase();
        return notice.noticeId !== noticeId && sameBuyer &&
          notice.solicitationNumber?.toUpperCase() === solicitationNumber.toUpperCase();
      });
      return {
        notices, upstreamMatches: result.total, examined: result.rows.length, retrievedAt: result.retrievedAt,
        scope: 'Other IDs sharing the same solicitation number and buyer within the examined page. Open SAM.gov to verify the relationship and latest action.'
      };
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      return { error: error.message };
    }
  }

  async function get(input) {
    const current = await snapshot(input);
    if (!current) throw new UserError('Notice not found in the searched posting dates. Supply its original postedDate for older notices or check the official SAM.gov page.');
    return { ...current, description: sliceDescription(current.description, input.descriptionOffset ?? 0) };
  }

  async function research(input) {
    const { notice, ...details } = await get(input);
    const fit = input.profile ? fitFor(notice, input.profile) : null;
    const naics = /^\d{6}$/.test(notice.naics ?? '') ? notice.naics : undefined;
    const psc = /^[A-Z0-9]{4}$/.test(notice.psc ?? '') ? notice.psc : undefined;
    const filter = { naics, psc, agency: input.awardingAgency };
    let relatedAwards = null;
    let relatedAwardsNote = 'No usable NAICS or PSC on the notice. Search USAspending with a user-selected keyword or buyer.';
    if (naics || psc) {
      try {
        const result = await awards(filter, clock(), { limit: 25, withCount: true });
        relatedAwards = marketSummary(result);
        relatedAwardsNote = 'Classification-based comparables. These records establish no link to this solicitation or its incumbent.';
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        relatedAwardsNote = error.message;
      }
    }
    return { ...details, notice, fit, relatedAwardFilters: filter, relatedAwards, relatedAwardsNote,
      verify: ['Latest amendments and authoritative deadline', 'Attachments and submission instructions',
        'Eligibility and required certifications', 'Evaluation factors and required deliverables'] };
  }

  return { search, get, research, snapshot, relatedNotices };
}

export function makeBaseline(snapshot) {
  const { notice, description, retrievedAt, source } = snapshot;
  return {
    notice, source, capturedAt: retrievedAt,
    descriptionHash: description === null ? null : digest(description)
  };
}

export function compareBaseline(baseline, snapshot) {
  const fields = ['title', 'organization', 'organizationCode', 'solicitationNumber', 'noticeType', 'postedDate',
    'responseDeadline', 'archiveDate', 'active', 'naics', 'psc', 'setAsideCode', 'setAsideDescription',
    'placeOfPerformance', 'award', 'attachmentUrls',
    'attachmentUrlsTruncated', 'additionalInfoUrl'];
  const changes = fields.filter((key) => JSON.stringify(baseline.notice[key]) !== JSON.stringify(snapshot.notice[key]))
    .map((field) => ({ field, before: baseline.notice[field] ?? null, after: snapshot.notice[field] ?? null }));
  const current = makeBaseline(snapshot);
  const before = baseline.descriptionHash;
  const after = current.descriptionHash;
  const descriptionStatus = snapshot.descriptionError ? 'fetch_failed' :
    before && after ? (before === after ? 'unchanged' : 'changed') :
    before ? 'no_longer_available' : after ? 'now_available' : 'unavailable_in_both';
  const changed = changes.length > 0 || ['changed', 'no_longer_available', 'now_available'].includes(descriptionStatus);
  const incomplete = snapshot.descriptionError || baseline.notice.attachmentUrlsTruncated || snapshot.notice.attachmentUrlsTruncated;
  return {
    status: changed ? 'changed' : incomplete ? 'incomplete' : 'no_detected_change',
    changes, descriptionStatus,
    descriptionError: snapshot.descriptionError,
    baselineAt: baseline.capturedAt, retrievedAt: snapshot.retrievedAt, notice: snapshot.notice,
    scope: 'Compares the latest API-visible fields, listed attachment URLs and available notice text. Open SAM.gov for the full version and attachment history.'
  };
}
