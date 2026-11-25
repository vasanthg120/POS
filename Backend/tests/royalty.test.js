'use strict';

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// The report reads quotes through quoteTracking.service — stub only the I/O,
// keep the real eligiblePayments / resolvePeriod / round2.
jest.mock('../services/quoteTracking.service', () => ({
  ...jest.requireActual('../services/quoteTracking.service'),
  loadTenant: jest.fn(),
  fetchMergedQuotes: jest.fn(),
}));

const RoyaltyConfig = require('../models/royaltyConfig');
const quoteTracking = require('../services/quoteTracking.service');
const ctrl = require('../controllers/royaltyController');

const config = (history = [], quotationOverrides = []) =>
  new RoyaltyConfig({ tenantId: 'T1', history, quotationOverrides });

describe('RoyaltyConfig.resolveRate', () => {
  test('a payment dated the same day the rate was set gets that rate', () => {
    // Tracking stores a picked date as UTC midnight; the rate was set that afternoon.
    const c = config([{ percentage: 9, effectiveFrom: new Date('2026-11-24T09:45:00Z') }]);
    expect(c.resolveRate(new Date('2026-11-24T00:00:00Z'))).toMatchObject({ percentage: 9, basis: 'history' });
  });

  test('payments before the first rate ever set use that first rate, not 0%', () => {
    const c = config([{ percentage: 9, effectiveFrom: new Date('2026-11-25T10:00:00Z') }]);
    const r = c.resolveRate(new Date('2026-09-01T00:00:00Z'));
    expect(r).toMatchObject({ percentage: 9, basis: 'first-rate' });
    expect(r.effectiveFrom).toEqual(new Date('2026-11-25T10:00:00Z'));
  });

  test('a later rate change only applies from the day it was made', () => {
    const c = config([
      { percentage: 9, effectiveFrom: new Date('2026-10-01T08:00:00Z') },
      { percentage: 12, effectiveFrom: new Date('2026-11-20T08:00:00Z') },
    ]);
    expect(c.getEffectivePercentage(new Date('2026-11-19T00:00:00Z'))).toBe(9);
    expect(c.getEffectivePercentage(new Date('2026-11-20T00:00:00Z'))).toBe(12);
    expect(c.getEffectivePercentage(new Date('2026-12-05T00:00:00Z'))).toBe(12);
    expect(c.currentPercentage()).toBe(12);
  });

  test('no rate configured → 0% with basis "unset"', () => {
    const c = config();
    expect(c.resolveRate(new Date())).toEqual({ percentage: 0, effectiveFrom: null, basis: 'unset' });
    expect(c.currentPercentage()).toBeNull();
  });

  test('a quotation override wins over the tenant rate', () => {
    const c = config(
      [{ percentage: 9, effectiveFrom: new Date('2026-01-01T00:00:00Z') }],
      [{ quoteId: 'q-1', percentage: 5, effectiveFrom: new Date('2026-11-01T12:00:00Z') }],
    );
    expect(c.resolveRate(new Date('2026-11-01T00:00:00Z'), 'q-1')).toMatchObject({ percentage: 5, basis: 'override' });
    expect(c.getEffectivePercentage(new Date('2026-11-01T00:00:00Z'), 'q-2')).toBe(9);
  });

  test('royaltyFor rounds to paise', () => {
    const c = config([{ percentage: 9, effectiveFrom: new Date('2026-01-01T00:00:00Z') }]);
    expect(c.royaltyFor(80845, new Date('2026-11-24T00:00:00Z')).amount).toBe(7276.05);
  });
});

describe('GET /tenant/royalty (getReport)', () => {
  const quote = (over = {}) => ({
    quoteId: 'q-17', quoteNumber: '17', title: 'Uniforms', customerName: 'Sneha Pink', email: 's@example.com',
    amount: 80845, paidAmount: 80845, createdAt: '2026-04-13T05:00:00Z',
    paymentStatus: 'paid', quotationStatus: 'Payment Completed', paymentMethod: 'Bank Transfer',
    manualPayments: [{ amount: 80845, paymentDate: new Date('2026-11-24T00:00:00Z'), referenceNumber: 'UTR1', method: 'NEFT' }],
    ...over,
  });

  const run = async (query, quotes, history) => {
    quoteTracking.loadTenant.mockResolvedValue({ tenant: {}, apiKey: 'k' });
    quoteTracking.fetchMergedQuotes.mockResolvedValue(quotes);
    jest.spyOn(RoyaltyConfig, 'findOne').mockResolvedValue(config(history));
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await ctrl.getReport({ user: { id: 'u1', tenantId: 'T1' }, query }, res, jest.fn());
    return res.json.mock.calls[0][0];
  };

  afterEach(() => jest.restoreAllMocks());

  test('applies the configured rate to payments recorded before it was set', async () => {
    const body = await run(
      { month: '11', year: '2026' },
      [
        quote(),
        quote({
          quoteId: 'q-114', quoteNumber: '114', customerName: 'Ajay', amount: 10000, paidAmount: 8425,
          paymentStatus: 'partially_paid', createdAt: '2026-09-23T05:00:00Z',
          manualPayments: [{ amount: 8425, paymentDate: new Date('2026-11-24T00:00:00Z'), referenceNumber: '', method: 'Cash' }],
        }),
      ],
      [{ percentage: 9, effectiveFrom: new Date('2026-11-25T06:00:00Z') }],
    );

    expect(body.success).toBe(true);
    const { rows, summary, rateBreakdown, sourceSplit } = body.data;
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.royaltyPercent === 9 && r.rateBasis === 'first-rate')).toBe(true);
    expect(rows.find(r => r.quotationNo === '17')).toMatchObject({
      royaltyAmount: 7276.05, paymentMethod: 'NEFT', quoteAmount: 80845, balanceDue: 0,
    });
    expect(rows.find(r => r.quotationNo === '114')).toMatchObject({ royaltyAmount: 758.25, balanceDue: 1575 });

    expect(summary).toMatchObject({
      totalPayments: 2, totalEligibleAmount: 89270, totalRoyaltyPayable: 8034.3,
      royaltyPercentage: 9, rateConfigured: true, quotationCount: 2,
      quotationsInPeriod: 0, paidQuotationsInPeriod: 0, manualCount: 2, razorpayCount: 0,
    });
    expect(rateBreakdown).toEqual([{ percentage: 9, count: 2, amount: 89270, royalty: 8034.3 }]);
    expect(sourceSplit.find(s => s.source === 'Manual')).toMatchObject({ count: 2, amount: 89270 });
  });

  test('source split ignores the source filter; totals respect it', async () => {
    const body = await run(
      { period: 'all', source: 'Razorpay' },
      [quote()],
      [{ percentage: 9, effectiveFrom: new Date('2026-01-01T00:00:00Z') }],
    );
    expect(body.data.rows).toHaveLength(0);
    expect(body.data.summary.totalRoyaltyPayable).toBe(0);
    expect(body.data.sourceSplit.find(s => s.source === 'Manual').count).toBe(1);
  });

  test('no rate configured → 0 royalty, flagged as not set', async () => {
    const body = await run({ period: 'all' }, [quote()], []);
    expect(body.data.summary).toMatchObject({ rateConfigured: false, totalRoyaltyPayable: 0 });
    expect(body.data.rows[0]).toMatchObject({ royaltyPercent: 0, rateBasis: 'unset', royaltyStatus: 'Rate not set' });
  });
});
