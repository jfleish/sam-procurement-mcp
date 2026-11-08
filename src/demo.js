import { awardQuery } from './awards.js';
import { dateOffset, dates } from './inputs.js';
import { htmlText } from './sam.js';

const notice = (n) => String(n).padStart(32, '0');
const demoUrl = 'https://example.invalid';

export function createDemo() {
  const sam = {
    async search(filters, now, { page = 1, limit = 20, defaultDays = 30 } = {}) {
      const today = now.toISOString().slice(0, 10);
      const { from, to } = dates(filters.postedFrom, filters.postedTo, defaultDays, 365, now);
      const defaults = {
        department: 'Fictional Federal Operations Bureau',
        subTier: 'Example Acquisition Office',
        postedDate: dateOffset(today, -4),
        responseDeadLine: dateOffset(today, 18) + 'T21:00:00Z',
        active: 'Yes',
        placeOfPerformance: { city: { name: 'Arlington' }, state: { code: 'VA' }, country: { code: 'USA' } }
      };
      const rows = [
        {
          ...defaults, noticeId: notice(1), solicitationNumber: 'DEMO-IT-001',
          title: 'Cloud migration and cybersecurity engineering', type: 'Combined Synopsis/Solicitation',
          typeOfSetAside: 'SBA', typeOfSetAsideDescription: 'Total Small Business Set-Aside',
          naicsCode: '541512', classificationCode: 'DA01',
          description: '<h2>Scope</h2><p>Inventory legacy applications, migrate two pilot workloads, and deliver a security authorization package.</p>' +
            '<h2>Submission</h2><p>Provide a technical approach, key personnel resumes, two references, and a separate price volume.</p>' +
            '<p>Check the official amendment and attachments before submitting.</p>'
        },
        {
          ...defaults, noticeId: notice(2), solicitationNumber: 'DEMO-IT-002',
          title: 'Zero trust cloud access modernization', type: 'Sources Sought',
          naicsCode: '541512', classificationCode: 'DA01',
          description: '<p>The buyer requests capability statements on identity federation and continuous access evaluation.</p>' +
            '<p>Responses should summarize relevant projects and provide company size and UEI.</p>'
        },
        {
          ...defaults, noticeId: notice(3), solicitationNumber: 'DEMO-FAC-001',
          title: 'Preventive maintenance for a field office', type: 'Solicitation',
          naicsCode: '561210', classificationCode: 'S216',
          responseDeadLine: dateOffset(today, -1) + 'T21:00:00Z',
          description: '<p>Inspect and maintain mechanical systems. A site visit was listed in the original notice.</p>'
        }
      ].filter((row) => row.postedDate >= from && row.postedDate <= to &&
        (!filters.noticeId || row.noticeId === filters.noticeId) &&
        (!filters.title || row.title.toLowerCase().includes(filters.title.toLowerCase())) &&
        (!filters.organization || row.department.toLowerCase().includes(filters.organization.toLowerCase())) &&
        (!filters.solicitationNumber || row.solicitationNumber === filters.solicitationNumber) &&
        (!filters.naics || row.naicsCode === filters.naics) &&
        (!filters.psc || row.classificationCode === filters.psc) &&
        (!filters.state || row.placeOfPerformance.state.code === filters.state) &&
        (!filters.setAside || row.typeOfSetAside === filters.setAside) &&
        (!filters.noticeType || row.type === { combined: 'Combined Synopsis/Solicitation',
          sources_sought: 'Sources Sought', solicitation: 'Solicitation' }[filters.noticeType]));
      return { rows: rows.slice((page - 1) * limit, page * limit), total: rows.length,
        from, to, retrievedAt: now.toISOString() };
    },
    async description(row) {
      return htmlText(row.description);
    },
    async lookupEntity(uei) {
      return {
        source: 'Synthetic demo', retrievedAt: new Date().toISOString(), uei, url: `${demoUrl}/entities`,
        records: uei === 'DEMO00000001' ? [{
          legalBusinessName: 'Demo Systems LLC', dbaName: null, cageCode: null,
          registrationStatus: 'Active', registrationExpirationDate: null, purposeOfRegistration: 'All Awards'
        }] : []
      };
    }
  };

  async function awards(filters, now, { page = 1, limit = 20, sort = 'amount', withCount = false } = {}) {
    const query = awardQuery(filters, now, page, limit, sort);
    const { start_date: from, end_date: to } = query.filters.time_period[0];
    const today = now.toISOString().slice(0, 10);
    const rows = [
      ['Demo Systems LLC', 'DEMO00000001', 4_600_000, 390],
      ['Example Security Inc.', 'DEMO00000002', 2_900_000, 250],
      ['Demo Systems LLC', 'DEMO00000001', 1_900_000, 125],
      ['Sample Digital Group', 'DEMO00000003', 680_000, 67]
    ].map(([recipient, recipientUei, amount, days], index) => ({
      generatedId: `DEMO-AWD-${index + 1}`, awardId: `DEMO-IT-AWD-${index + 1}`,
      recipient, recipientUei, amount, signedDate: dateOffset(today, -days),
      startDate: dateOffset(today, 1 - days), endDate: dateOffset(today, 730 - days),
      awardingAgency: 'Fictional Federal Operations Bureau', awardingSubAgency: 'Example Acquisition Office',
      description: 'Fictional cloud engineering and security support contract.',
      naics: '541512', psc: 'DA01', state: 'VA', url: `${demoUrl}/awards/${index + 1}`
    })).filter((row) => row.signedDate >= from && row.signedDate <= to &&
      (!filters.naics || row.naics === filters.naics) &&
      (!filters.psc || row.psc === filters.psc) &&
      (!filters.state || row.state === filters.state) &&
      (!filters.agency || row.awardingAgency.toLowerCase() === filters.agency.toLowerCase()) &&
      (!filters.recipient || row.recipient.toLowerCase().includes(filters.recipient.toLowerCase()) ||
        row.recipientUei.toLowerCase() === filters.recipient.toLowerCase()) &&
      (!filters.keyword || row.description.toLowerCase().includes(filters.keyword.toLowerCase())) &&
      (!filters.awardId || row.awardId.toLowerCase() === filters.awardId.toLowerCase()));
    if (sort === 'recent') rows.sort((a, b) => b.signedDate.localeCompare(a.signedDate));
    const moreAvailable = rows.length > page * limit;
    return { awards: rows.slice((page - 1) * limit, page * limit), nextPage: moreAvailable ? page + 1 : null,
      moreAvailable, dateRange: { from, to }, retrievedAt: now.toISOString(), source: 'Synthetic demo',
      matchingCount: withCount ? { total: rows.length, retrievedAt: now.toISOString() } : null,
      url: `${demoUrl}/awards` };
  }

  return { sam, awards };
}
