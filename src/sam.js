import { createHash } from 'node:crypto';
import { parseFragment } from 'parse5';
import { dates, isoDate, noticeId as noticeIdSchema } from './inputs.js';
import { UserError } from './net.js';

const SAM = 'https://api.sam.gov';
const SEARCH = SAM + '/opportunities/v2/search';
const TYPES = { solicitation: 'o', combined: 'k', sources_sought: 'r', presolicitation: 'p',
  award: 'a', special: 's', justification: 'u', surplus: 'g', intent_to_bundle: 'i' };
const FILTERS = {
  title: 'title', solicitationNumber: 'solnum', organization: 'organizationName',
  naics: 'ncode', psc: 'ccode', state: 'state', setAside: 'typeOfSetAside', noticeId: 'noticeid'
};
const BLOCK = new Set(['p', 'div', 'br', 'li', 'tr', 'td', 'th', 'hr', 'section', 'h1', 'h2', 'h3', 'h4']);
const SKIP = new Set(['script', 'style', 'template', 'iframe', 'noscript']);

export function cleanText(value, maxLength = 320) {
  if (typeof value !== 'string' || /^null$/i.test(value.trim())) return null;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maxLength) || null;
}

export function htmlText(value) {
  if (!/<\/?[a-z][\s\S]*?>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(value)) return value.trim();
  const parts = [];
  const nodes = [...parseFragment(value).childNodes].reverse();
  while (nodes.length) {
    const node = nodes.pop();
    if (node === '\n') {
      parts.push(node);
      continue;
    }
    if (SKIP.has(node.tagName)) continue;
    if (node.nodeName === '#text') parts.push(node.value);
    if (BLOCK.has(node.tagName)) {
      parts.push('\n');
      nodes.push('\n');
    }
    for (let i = (node.childNodes?.length ?? 0) - 1; i >= 0; i--) nodes.push(node.childNodes[i]);
  }
  return parts.join('').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function money(value) {
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) value = Number(value);
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER / 100 ? value : null;
}

function publicResource(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || !['https://sam.gov', SAM].includes(url.origin) || url.username || url.password) return null;
  url.search = '';
  url.hash = '';
  return url.href;
}

export function normalizeOpportunity(row) {
  const id = noticeIdSchema.safeParse(row?.noticeId);
  if (!id.success) throw new UserError('SAM.gov returned a notice without a valid identifier.');
  const organization = cleanText(row.fullParentPathName) ??
    [row.department, row.subTier, row.office].map((v) => cleanText(v)).filter(Boolean).join(' / ');
  const place = row.placeOfPerformance;
  const active = cleanText(row.active)?.toLowerCase();
  const rawPostedDate = cleanText(row.postedDate, 50)?.slice(0, 10);
  return {
    noticeId: id.data,
    title: cleanText(row.title),
    solicitationNumber: cleanText(row.solicitationNumber),
    organization: organization || null,
    organizationCode: cleanText(row.fullParentPathCode, 80),
    noticeType: cleanText(row.type, 80),
    baseNoticeType: cleanText(row.baseType, 80),
    postedDate: isoDate.safeParse(rawPostedDate).success ? rawPostedDate : null,
    responseDeadline: cleanText(row.responseDeadLine ?? row.reponseDeadLine, 80),
    archiveDate: cleanText(row.archiveDate, 80),
    active: active === 'yes' ? true : active === 'no' ? false : null,
    naics: cleanText(row.naicsCode, 12),
    psc: cleanText(row.classificationCode, 12),
    setAsideCode: cleanText(row.typeOfSetAside ?? row.setAsideCode, 40),
    setAsideDescription: cleanText(row.typeOfSetAsideDescription ?? row.setAside, 100),
    placeOfPerformance: place ? {
      city: cleanText(place.city?.name, 80),
      state: cleanText(place.state?.code ?? place.state, 12),
      country: cleanText(place.country?.code ?? place.country, 12)
    } : null,
    award: row.award ? {
      awardNumber: cleanText(row.award.number, 100),
      amount: money(row.award.amount),
      date: cleanText(row.award.date, 80),
      recipient: cleanText(row.award.awardee?.name, 120),
      recipientUei: cleanText(row.award.awardee?.ueiSAM, 12)
    } : null,
    url: `https://sam.gov/opp/${id.data}/view`
  };
}

export function deadlineStatus(notice, now) {
  if (notice.active === false) return 'inactive';
  const value = notice.responseDeadline;
  // Only compare absolute instants. A zone-less date cannot safely be classified.
  const timestamp = /T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value ?? '') ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return 'unknown';
  if (timestamp <= now.getTime()) return 'past_deadline';
  return notice.active === true ? 'open' : 'unknown';
}

export function createSam(request, readCredential) {
  let lastCheck;
  const fingerprint = (key) => createHash('sha256').update(key).digest('hex');
  async function authenticated(url, options, credential) {
    const { key } = credential ?? await readCredential();
    const id = fingerprint(key);
    url.searchParams.set('api_key', key);
    try {
      const result = await request('SAM.gov', url, options);
      lastCheck = { id, state: 'connected', checkedAt: result.retrievedAt };
      return result;
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      lastCheck = { id, state: error.code ?? 'upstream_error', checkedAt: new Date().toISOString(), error: error.message };
      throw error;
    }
  }

  const api = {
    async search(filters, now, { page = 1, limit = 20, fresh = false, defaultDays = 30, verify = false, credential } = {}) {
      const { from, to } = dates(filters.postedFrom, filters.postedTo, defaultDays, 365, now);
      const params = new URLSearchParams({
        postedFrom: from.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3/$1'),
        postedTo: to.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3/$1'),
        limit, offset: page - 1
      });
      for (const [field, name] of Object.entries(FILTERS)) {
        if (filters[field]) params.set(name, filters[field]);
      }
      if (filters.noticeType) params.set('ptype', TYPES[filters.noticeType]);
      const url = new URL(`${SEARCH}?${params}`);
      const { data, retrievedAt } = await authenticated(url, { allowMissing: !verify, fresh }, credential);
      const total = data === null ? 0 : data.totalRecords;
      const rows = data?.opportunitiesData ?? (total === 0 ? [] : null);
      if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(rows) || rows.length > limit) {
        throw new UserError('SAM.gov returned an unexpected opportunities response.');
      }
      return { rows, total, from, to, retrievedAt };
    },

    verify(credential) {
      return api.search({}, new Date(), { limit: 1, fresh: true, verify: true, credential });
    },

    async status(checkConnection = false) {
      let credential;
      try {
        credential = await readCredential();
        if (checkConnection) await api.verify(credential);
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        const state = error.code ?? 'upstream_error';
        if (credential) {
          lastCheck = { id: fingerprint(credential.key), state, checkedAt: new Date().toISOString(), error: error.message };
        }
        return {
          samKeyConfigured: Boolean(credential),
          samOpportunityAccess: credential ? 'configured' : 'setup_required',
          samConnectionStatus: state,
          samSetupError: error.message,
          ...(credential && { samCredentialSource: credential.source, samLastCheckedAt: lastCheck.checkedAt })
        };
      }
      const check = lastCheck?.id === fingerprint(credential.key) ? lastCheck : null;
      return {
        samKeyConfigured: true, samOpportunityAccess: 'configured',
        samConnectionStatus: check?.state ?? 'unverified', samCredentialSource: credential.source,
        ...(check && { samLastCheckedAt: check.checkedAt }),
        ...(check?.error && { samSetupError: check.error })
      };
    },

    async description(row, { fresh = false } = {}) {
      const value = cleanText(row.description, 1_000_000);
      if (!value) return null;
      if (!/^https?:\/\//i.test(value)) return htmlText(value);
      const url = URL.canParse(value) ? new URL(value) : null;
      if (!url || url.origin !== SAM || url.username || url.password ||
        !/^\/(?:prod\/)?opportunities\/v[12]\/noticedesc\/?$/.test(url.pathname)) {
        throw new UserError('SAM.gov returned an unrecognized description link. Open the official notice.');
      }
      // Rebuild the query so no supplied URL controls credentials or lookup identity.
      url.search = new URLSearchParams({ noticeid: noticeIdSchema.parse(row.noticeId) });
      const { data } = await authenticated(url, { allowMissing: true, fresh });
      if (data === null) return null;
      const description = cleanText(data.description, 4 * 1024 * 1024);
      if (typeof data.description !== 'string' && data.description !== null) {
        throw new UserError('SAM.gov returned an unexpected description response.');
      }
      return description ? htmlText(description) : null;
    },

    async lookupEntity(uei) {
      const url = new URL(`${SAM}/entity-information/v3/entities`);
      url.searchParams.set('ueiSAM', uei);
      url.searchParams.set('sensitivity', 'public');
      url.searchParams.set('samRegistered', 'Yes');
      url.searchParams.set('includeSections', 'entityRegistration');
      const { data, retrievedAt } = await authenticated(url, { allowMissing: true });
      const rows = data?.entityData ?? (data === null || data.totalRecords === 0 ? [] : null);
      if (!Array.isArray(rows)) throw new UserError('SAM.gov returned an unexpected entity response.');
      const records = rows.map((row) => row?.entityRegistration)
        .filter((row) => row?.ueiSAM === uei && row.publicDisplayFlag === 'Y' && row.samRegistered === 'Yes')
        .map((row) => ({
          legalBusinessName: cleanText(row.legalBusinessName, 160),
          dbaName: cleanText(row.dbaName, 160),
          cageCode: cleanText(row.cageCode, 10),
          registrationStatus: cleanText(row.registrationStatus, 40),
          registrationExpirationDate: cleanText(row.registrationExpirationDate, 30),
          purposeOfRegistration: cleanText(row.purposeOfRegistrationDesc, 80)
        }));
      return {
        source: 'SAM.gov', retrievedAt, uei, records,
        url: 'https://sam.gov/entity-information',
        scope: 'Registered entities marked for public display. Verify the UEI and current registration in SAM.gov before relying on this result.'
      };
    }
  };
  return api;
}

export function resources(row) {
  const links = Array.isArray(row.resourceLinks) ? row.resourceLinks : [];
  const urls = [...new Set(links.map(publicResource).filter(Boolean))].sort();
  return {
    attachmentUrls: urls.slice(0, 40),
    attachmentUrlsTruncated: urls.length > 40,
    additionalInfoUrl: publicResource(row.additionalInfoLink)
  };
}
