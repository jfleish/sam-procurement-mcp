import { z } from 'zod';
import { UserError } from './net.js';

export const shortText = z.string().trim().min(1).max(160);
const code = (pattern) => z.string().trim().toUpperCase().regex(pattern);
export const noticeId = z.string().trim().toLowerCase().regex(/^[a-f0-9]{32}$/);
export const naics = code(/^\d{6}$/);
export const psc = code(/^[A-Z0-9]{4}$/);
export const uei = code(/^[A-Z0-9]{12}$/);
export const state = code(/^[A-Z]{2}$/);
export const setAside = code(/^[A-Z0-9]{2,12}$/);
export const isoDate = z.iso.date().refine((date) => date >= '1900-01-01' && date < '9990-01-01',
  'Use a date between 1900 and 9989.');
export const page = z.number().int().min(1).max(100);

export const capabilityProfile = z.object({
  naicsCodes: z.array(naics).max(15).optional(),
  pscCodes: z.array(psc).max(15).optional(),
  titlePhrases: z.array(shortText).max(10).optional(),
  states: z.array(state).max(15).optional(),
  setAsideCodes: z.array(setAside).max(15).optional()
}).describe('Only include user-stated capabilities, preferences, and set-aside codes.');

export const opportunityFilters = {
  title: shortText.optional().describe('Title text sent to SAM.gov. Search synonyms separately.'),
  solicitationNumber: shortText.optional(),
  organization: shortText.optional().describe('SAM.gov department or sub-tier name.'),
  naics: naics.optional(),
  psc: psc.optional(),
  state: state.optional().describe('Place of performance, not the contracting office.'),
  setAside: setAside.optional().describe('SAM.gov set-aside code, e.g. SBA, 8A, WOSB.'),
  noticeType: z.enum(['solicitation', 'combined', 'sources_sought', 'presolicitation',
    'award', 'special', 'justification', 'surplus', 'intent_to_bundle']).optional(),
  postedFrom: isoDate.optional().describe('ISO date YYYY-MM-DD. Defaults to 30 days before postedTo.'),
  postedTo: isoDate.optional().describe('ISO date YYYY-MM-DD. Defaults to today.'),
  openOnly: z.boolean().optional().describe('Keep active notices with a future deadline that has an explicit time zone. This filters the returned page.')
};

export const awardFilters = {
  keyword: shortText.optional(),
  naics: naics.optional(),
  psc: psc.optional(),
  agency: shortText.optional().describe('Exact USAspending top-tier awarding agency name.'),
  recipient: shortText.optional().describe('Recipient search text, e.g. legal business name or UEI.'),
  awardId: shortText.refine((value) => !value.includes('"'), 'Pass the PIID without quotes.').optional()
    .describe('Exact PIID, when known.'),
  state: state.optional(),
  from: isoDate.optional().describe('Base award date lower bound. Default is 730 days before to.'),
  to: isoDate.optional().describe('Base award date upper bound. Default is today.')
};

export function dateOffset(date, days) {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

export function dates(from, to, defaultDays, maxDays, now) {
  to ??= now.toISOString().slice(0, 10);
  from ??= dateOffset(to, -defaultDays);
  if (from > to || dateOffset(from, maxDays) < to) {
    throw new UserError(`Use an ordered date range at most ${maxDays} days wide.`);
  }
  return { from, to };
}
