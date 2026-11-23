'use strict';

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  normalise, resolvePayStatus, resolveQuotStage, mergeTracking,
  fetchPageWithMeta, fetchAllQuotesWithMeta, normaliseApproval,
} = require('../services/quoteTracking.service');

const DAY = 86_400_000;
const past = new Date(Date.now() - 5 * DAY).toISOString();
const future = new Date(Date.now() + 5 * DAY).toISOString();

// Shape taken from a live ProspectConnect getQuotes response (values invented).
const crmQuote = (over = {}) => ({
  _id: 'abc123',
  ticket_number: 1042,
  quote_name: 'Uniforms',
  quote_status: 'published',
  client_approval_status: 'awaiting_response',
  quote_amount: 11800,
  currency: 'INR',
  created_at: '2026-11-19T05:11:03.405Z',
  date_created: '2026-11-19T05:13:38.897Z',
  date_modified: '2026-11-19T07:00:00.000Z',
  expiration_date: future,
  is_delete: false,
  is_active: true,
  tax: [{ tax_name: 'GST', currency: 'INR', tax_input: '18', tax_amount: 1800 }],
  client_details: { id: 'cli-1', name: 'Asha', email: 'asha@example.com', phone: '1' },
  contact_detail: { id: 'con-1', name_beautify: 'Asha K', email: 'asha@example.com' },
  quote_owner: { name: 'Owner', email: 'owner@example.com' },
  deal: { name: 'Deal A' },
  purchase_terms: '<p>terms</p>'.repeat(50),
  comments_to_buyer: 'thanks',
  ...over,
});

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

afterEach(() => { delete global.fetch; });

describe('normalise()', () => {
  test('maps ProspectConnect fields, including date_modified as updatedAt', () => {
    const q = normalise(crmQuote());
    expect(q.quoteId).toBe('abc123');
    expect(q.quoteNumber).toBe('1042');
    expect(q.amount).toBe(11800);
    expect(q.taxTotal).toBe(1800);
    expect(q.customerName).toBe('Asha');
    expect(q.customerId).toBe('cli-1');
    expect(q.createdAt).toBe('2026-11-19T05:11:03.405Z');
    expect(q.updatedAt).toBe('2026-11-19T07:00:00.000Z');   // was always null
    expect(q.isExpired).toBe(false);
  });

  test('drops the large HTML blobs from raw but keeps every field the UI reads', () => {
    const q = normalise(crmQuote());
    expect(q.raw.purchase_terms).toBeUndefined();
    expect(q.raw.comments_to_buyer).toBeUndefined();
    for (const f of ['quote_name', 'deal', 'quote_owner', 'client_approval_status', 'quote_status', 'expiration_date', 'ticket_number', 'quote_amount']) {
      expect(q.raw).toHaveProperty(f);
    }
  });

  test('approvalStatus: approved / pending / draft / rejected', () => {
    expect(normalise(crmQuote({ client_approval_status: 'approved' })).approvalStatus).toBe('approved');
    expect(normalise(crmQuote()).approvalStatus).toBe('pending');
    expect(normalise(crmQuote({ quote_status: 'draft' })).approvalStatus).toBe('draft');
    expect(normalise(crmQuote({ client_approval_status: 'Declined' })).approvalStatus).toBe('rejected');
    expect(normaliseApproval(undefined)).toBe('pending');
  });
});

describe('payment status / stage resolution', () => {
  test('an expired quote the client approved is still payment-due, not failed', () => {
    expect(resolvePayStatus(normalise(crmQuote({ expiration_date: past, client_approval_status: 'approved' })))).toBe('pending');
  });

  test('an expired quote the client never approved stays failed (existing rule)', () => {
    expect(resolvePayStatus(normalise(crmQuote({ expiration_date: past })))).toBe('failed');
  });

  test('an open quote is pending', () => {
    expect(resolvePayStatus(normalise(crmQuote()))).toBe('pending');
  });

  test('a client rejection maps to Cancelled (was unreachable before)', () => {
    expect(resolveQuotStage(normalise(crmQuote({ client_approval_status: 'rejected' })))).toBe('Cancelled');
  });

  test('existing stage mapping is unchanged otherwise', () => {
    expect(resolveQuotStage(normalise(crmQuote()))).toBe('Awaiting Payment');
    expect(resolveQuotStage(normalise(crmQuote({ client_approval_status: 'approved' })))).toBe('Awaiting Payment');
    expect(resolveQuotStage(normalise(crmQuote({ quote_status: 'draft' })))).toBe('Created');
  });

  test('a POS tracking record overrides the CRM-derived status', () => {
    const merged = mergeTracking(normalise(crmQuote({ expiration_date: past })), {
      paymentStatus: 'paid', paidAmount: 11800, quotationStatus: 'Payment Completed', paidAt: new Date(),
    }, null);
    expect(merged.paymentStatus).toBe('paid');
    expect(merged.paidAmount).toBe(11800);
    expect(merged.quotationStatus).toBe('Payment Completed');
  });
});

describe('Super Admin quote outcome buckets', () => {
  const { quoteOutcome } = require('../services/superAdminAggregation.service');
  const merged = (over, tracking) => mergeTracking(normalise(crmQuote(over)), tracking, null);

  test('client-approved counts as approved even when expired and unpaid (was "rejected/expired")', () => {
    expect(quoteOutcome(merged({ client_approval_status: 'approved', expiration_date: past }))).toBe('approved');
  });
  test('paid counts as approved', () => {
    expect(quoteOutcome(merged({}, { paymentStatus: 'paid', paidAmount: 1 }))).toBe('approved');
  });
  test('expired and never approved is rejected/expired', () => {
    expect(quoteOutcome(merged({ expiration_date: past }))).toBe('rejectedOrExpired');
  });
  test('client rejection is rejected/expired', () => {
    expect(quoteOutcome(merged({ client_approval_status: 'rejected' }))).toBe('rejectedOrExpired');
  });
  test('open and awaiting the client is pending', () => {
    expect(quoteOutcome(merged({}))).toBe('pending');
  });
});

describe('fetchPageWithMeta() — CRM response validation', () => {
  test('returns quotes and the CRM total', async () => {
    global.fetch = jest.fn(async () => response({ quotes: [crmQuote()], count: 107 }));
    const r = await fetchPageWithMeta('key', { limit: 1 });
    expect(r.quotes).toHaveLength(1);
    expect(r.count).toBe(107);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe('key');
    expect(JSON.parse(opts.body)).toEqual({ limit: 1, search: '', startAfter: 0 });
  });

  test('401 → CRM error that names the cause, never the key', async () => {
    global.fetch = jest.fn(async () => response('<html>401 Authorization Required</html>', 401));
    await expect(fetchPageWithMeta('secret-key-value')).rejects.toMatchObject({
      isCrmError: true, upstreamStatus: 401,
    });
    await expect(fetchPageWithMeta('secret-key-value')).rejects.toThrow(/rejected the API key/);
    await expect(fetchPageWithMeta('secret-key-value')).rejects.not.toThrow(/secret-key-value/);
  });

  test('HTML with 200 → error instead of an empty list', async () => {
    global.fetch = jest.fn(async () => response('<html>maintenance</html>'));
    await expect(fetchPageWithMeta('k')).rejects.toThrow(/non-JSON/);
  });

  test('JSON without a quote list → error carrying the CRM message (used to be [])', async () => {
    global.fetch = jest.fn(async () => response({ success: false, message: 'Token expired' }));
    await expect(fetchPageWithMeta('k')).rejects.toThrow(/Token expired/);
  });

  test('network failure → CRM error', async () => {
    global.fetch = jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
    await expect(fetchPageWithMeta('k')).rejects.toMatchObject({ isCrmError: true, status: 504 });
  });
});

describe('fetchAllQuotesWithMeta() — pagination', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => crmQuote({ _id: `q${i}`, ticket_number: i }));

  test('walks pages until exhausted and reports complete', async () => {
    const all = many(250);
    global.fetch = jest.fn(async (_url, opts) => {
      const { limit, startAfter } = JSON.parse(opts.body);
      return response({ quotes: all.slice(startAfter, startAfter + limit), count: all.length });
    });
    const r = await fetchAllQuotesWithMeta('k');
    expect(r.quotes).toHaveLength(250);
    expect(r.complete).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('reports incomplete when the CRM total is larger than what came back', async () => {
    global.fetch = jest.fn(async () => response({ quotes: many(10), count: 15 }));
    const r = await fetchAllQuotesWithMeta('k');
    expect(r.complete).toBe(false);
    expect(r.reportedCount).toBe(15);
  });
});

describe('detail-view fields', () => {
  // Numbers from a real quote: 43,050 of items − 2,000 discount + 999 fee + 5% GST.
  const priced = () => normalise(crmQuote({
    quote_amount: 44151.45,
    discount: [{ discount_name: 'Onboarding Offer', discount_amount: 2000, discount_input: 2000 }],
    fees: [{ fees_name: 'Setup', fees_amount: 999, fees_input: 999 }],
    tax: [{ tax_name: 'GST', currency: '%', tax_input: '5', tax_amount: 2102.45 }],
    client_details: { id: 'c1', name: 'Karthik', company_name: 'Galaxy Cast', city: 'Chennai', country: 'India', email: 'k@example.com' },
    quote_owner_company: { company_name: 'FP T.nagar', tax_ids: [{ label: 'India GSTIN', value: '33AAA' }] },
    approvals_feedback: [{ feedback: 'Size M-3', feedback_date: '2026-08-13T03:36:26.167Z', is_client_feedback: true }],
  }));

  test('price breakdown adds back up to the quote amount', () => {
    const b = priced().breakdown;
    expect(b.subtotal).toBe(43050);
    expect(b.discountTotal).toBe(2000);
    expect(b.feesTotal).toBe(999);
    expect(b.taxTotal).toBe(2102.45);
    expect(b.taxes[0]).toEqual({ name: 'GST', amount: 2102.45, rate: '5%' });
    expect(b.subtotal - b.discountTotal + b.feesTotal + b.taxTotal).toBeCloseTo(b.total, 2);
  });

  test('company, address, owner company, tax ids and client feedback', () => {
    const q = priced();
    expect(q.companyName).toBe('Galaxy Cast');
    expect(q.customerAddress).toBe('Chennai, India');
    expect(q.ownerCompany).toBe('FP T.nagar');
    expect(q.ownerTaxIds).toEqual([{ label: 'India GSTIN', value: '33AAA' }]);
    expect(q.clientFeedback).toEqual([{ text: 'Size M-3', date: '2026-08-13T03:36:26.167Z', fromClient: true }]);
  });

  test('a quote with no adjustments has subtotal = total', () => {
    const b = normalise(crmQuote({ tax: [], quote_amount: 500 })).breakdown;
    expect(b).toMatchObject({ subtotal: 500, total: 500, discountTotal: 0, feesTotal: 0, taxTotal: 0 });
  });
});

describe('matchesSearch()', () => {
  const { matchesSearch } = require('../services/quoteTracking.service');
  const q = normalise(crmQuote({ client_details: { name: 'Asha', company_name: 'Acme Corp', email: 'asha@example.com' } }));
  test.each([['1042'], ['acme'], ['ASHA@'], ['uniforms'], ['owner']])('finds "%s"', (t) => {
    expect(matchesSearch(q, t)).toBe(true);
  });
  test('no match / empty term', () => {
    expect(matchesSearch(q, 'zzz')).toBe(false);
    expect(matchesSearch(q, '  ')).toBe(true);
  });
});

describe('resolvePeriod() / inRange() — "All time"', () => {
  const { resolvePeriod } = require('../services/quoteTracking.service');
  const { inRange } = require('../services/superAdminAggregation.service');

  test('period=all has no bounds and includes every date (even none)', () => {
    const { periodStart, periodEnd } = resolvePeriod({ period: 'all', month: 11, year: 2026 });
    expect(periodStart).toBeNull();
    expect(periodEnd).toBeNull();
    expect(inRange('2020-01-01', periodStart, periodEnd)).toBe(true);
    expect(inRange(null, periodStart, periodEnd)).toBe(true);
  });

  test('without period it still defaults to one month (existing callers unchanged)', () => {
    const { periodStart, periodEnd } = resolvePeriod({ month: 4, year: 2026 });
    expect(periodStart.getMonth()).toBe(3);
    expect(periodEnd.getMonth()).toBe(3);
    expect(inRange('2026-05-02', periodStart, periodEnd)).toBe(false);
  });
});
