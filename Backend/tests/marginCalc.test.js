'use strict';

/**
 * Margin calculator engine. The browser engine
 * (admin/src/app/components/margin-calculator/margin-engine.ts) must give the
 * same answers: `VECTORS` below is the shared reference.
 */

const {
  calculate, roundUp, costMarginToSalesShare, salesShareToCostMargin, health,
} = require('../services/marginCalc.service');

/** Reference cases: input job → expected summary values (subset). */
const VECTORS = [
  {
    name: "user's example: cost 100, sold at 200 → 100% margin (on cost)",
    job: { gstRate: 18, rows: [{ qty: 1, unitCost: 100, quoteUnit: 200 }] },
    summary: { lineCost: 100, taxableValue: 200, netProfit: 100, marginPct: 1, gstAmount: 36, invoiceTotal: 236, overallMarginPct: 0.5 },
    row: { costPerUnit: 100, profitPerUnit: 100, marginPct: 1, state: 'ok' },
  },
  {
    name: 'fully loaded unit cost: print, setup and shipping spread over the quantity',
    job: { gstRate: 0, rows: [{ qty: 50, unitCost: 120, decoUnit: 30, setup: 500, ship: 250, quoteUnit: 250 }] },
    // cost = 50×120 + 50×30 + 500 + 250 = 8250 → 165/unit; revenue 12500
    summary: { lineCost: 8250, taxableValue: 12500, netProfit: 4250, marginPct: 0.5152 },
    row: { costPerUnit: 165, profitPerUnit: 85, marginPct: 0.5152 },
  },
  {
    name: 'setup fees and shipping billed to the client are revenue (their costs are on the rows)',
    job: { gstRate: 18, setupCount: 2, setupUnit: 400, shipping: 300, rows: [{ qty: 10, unitCost: 100, setup: 500, ship: 200, quoteUnit: 180 }] },
    // line: cost 1700, revenue 1800; billed 800 + 300 → taxable 2900
    summary: { lineCost: 1700, lineRevenue: 1800, setupFees: 800, shippingFee: 300, taxableValue: 2900, netProfit: 1200, gstAmount: 522, invoiceTotal: 3422, marginPct: 0.7059 },
  },
  {
    name: 'job discount reduces line revenue (and the row margins)',
    job: { gstRate: 18, discountPct: 10, rows: [{ qty: 10, unitCost: 100, quoteUnit: 200 }] },
    summary: { lineRevenueGross: 2000, discountAmount: 200, lineRevenue: 1800, netProfit: 800, marginPct: 0.8 },
    row: { revenue: 1800, profit: 800, marginPct: 0.8 },
  },
  {
    name: 'other job costs and a payment fee on the collected (GST-inclusive) amount',
    job: { gstRate: 18, otherCost: 150, paymentFeePct: 2, rows: [{ qty: 10, unitCost: 100, quoteUnit: 200 }] },
    // taxable 2000, invoice 2360, fee 47.20 → all-in 1000 + 150 + 47.2
    summary: { invoiceTotal: 2360, paymentFee: 47.2, allInCost: 1197.2, netProfit: 802.8, marginPct: 0.6706 },
  },
  {
    name: 'a loss is reported as a loss',
    job: { gstRate: 18, rows: [{ qty: 5, unitCost: 300, quoteUnit: 250 }] },
    summary: { netProfit: -250, marginPct: -0.1667, lossRows: 1 },
    row: { state: 'loss', marginPct: -0.1667 },
  },
  {
    name: 'no selling price: margin is undefined (null), not 0% or -100%',
    job: { gstRate: 18, rows: [{ qty: 5, unitCost: 300 }] },
    summary: { marginPct: null, lineMarginPct: null, overallMarginPct: 0, unpricedRows: 1 },
    row: { state: 'no-price', marginPct: null },
  },
  {
    name: 'negative and junk inputs are treated as 0',
    job: { gstRate: -5, discountPct: 'abc', rows: [{ qty: -3, unitCost: -10, quoteUnit: 100 }, { qty: '4', unitCost: '25', quoteUnit: '50' }] },
    summary: { totalQty: 4, lineCost: 100, lineRevenue: 200, gstAmount: 0, netProfit: 100 },
  },
];

const near = (actual, expected, key) => {
  if (expected === null) return expect([key, actual]).toEqual([key, null]);
  if (typeof expected === 'string') return expect([key, actual]).toEqual([key, expected]);
  return expect([key, Math.round(actual * 10000) / 10000]).toEqual([key, Math.round(expected * 10000) / 10000]);
};

describe('margin engine — reference cases', () => {
  test.each(VECTORS.map(v => [v.name, v]))('%s', (_name, v) => {
    const { summary, rows } = calculate(v.job);
    for (const [k, e] of Object.entries(v.summary)) near(summary[k], e, `summary.${k}`);
    for (const [k, e] of Object.entries(v.row ?? {})) near(rows[0][k], e, `row.${k}`);
  });
});

describe('margin engine — consistency', () => {
  test('revenue − all-in cost = net profit, and margin = profit ÷ all-in cost', () => {
    const { summary } = calculate({
      gstRate: 12, discountPct: 5, setupCount: 1, setupUnit: 600, shipping: 250, otherCost: 300, paymentFeePct: 2.36,
      rows: [{ qty: 25, unitCost: 210, decoUnit: 40, setup: 400, ship: 150, quoteUnit: 420 }, { qty: 100, unitCost: 35, quoteUnit: 79 }],
    });
    expect(summary.taxableValue - summary.allInCost).toBeCloseTo(summary.netProfit, 2);
    expect(summary.marginPct).toBeCloseTo(summary.netProfit / summary.allInCost, 4);
    expect(summary.overallMarginPct).toBeCloseTo(summary.netProfit / summary.taxableValue, 4);
    expect(summary.invoiceTotal).toBeCloseTo(summary.taxableValue + summary.gstAmount, 2);
  });

  test('an old saved job (no new fields) gives the same totals as the old formula', () => {
    const old = { setupCount: 3, setupUnit: 250, shipping: 400, gstRate: 18,
      rows: [{ qty: 40, unitCost: 150, decoUnit: 25, setup: 600, ship: 300, quoteUnit: 290 }, { qty: 10, unitCost: 500, quoteUnit: 650 }] };
    // Old engine: grandTotal = Σquote + shipping + setupCount×setupUnit; profit = grandTotal − Σcost.
    const lineCost = 40 * 150 + 40 * 25 + 600 + 300 + 10 * 500;
    const quote = 40 * 290 + 10 * 650;
    const grand = quote + 400 + 750;
    const { summary } = calculate(old);
    expect(summary.grandTotal).toBe(grand);
    expect(summary.profitSubtotal).toBe(grand - lineCost);
    expect(summary.overallMarginPct).toBeCloseTo((grand - lineCost) / grand, 4);
    expect(summary.incGst).toBeCloseTo(grand * 1.18, 2);
    expect(summary.totalQuote).toBe(quote);
  });
});

describe('margin engine — target pricing', () => {
  const base = {
    gstRate: 18, discountPct: 5, setupCount: 1, setupUnit: 500, shipping: 200, otherCost: 350, paymentFeePct: 2,
    rows: [
      { item: 'Polo', qty: 60, unitCost: 260, decoUnit: 45, setup: 800, ship: 400, quoteUnit: 340 },
      { item: 'Cap', qty: 60, unitCost: 90, decoUnit: 20, quoteUnit: 140 },
      { item: 'Sample', qty: 0, unitCost: 0, setup: 150 },   // a cost with no quantity to price
    ],
  };

  test.each([[25], [50], [100], [150]])('applying the suggested prices reaches a %s%% margin', (value) => {
    const job = { ...base, targetPct: value, priceRounding: 1 };
    const { rows, target } = calculate(job);
    expect(target.reachable).toBe(true);

    const priced = { ...job, rows: job.rows.map((r, i) => ({ ...r, quoteUnit: rows[i].suggestedUnitPrice ?? r.quoteUnit })) };
    const after = calculate(priced);
    const wanted = value / 100;
    expect(after.summary.marginPct).toBeGreaterThanOrEqual(wanted - 1e-4);
    // Rounding up to ₹1 per unit overshoots only slightly.
    expect(after.summary.marginPct).toBeLessThan(wanted + 0.03);
    expect(after.target.met).toBe(true);
    expect(rows[2].suggestedUnitPrice).toBeNull();   // nothing to price on a qty-0 row
  });

  test('suggested prices are rounded up to the chosen step', () => {
    for (const step of [1, 5, 10]) {
      const { rows } = calculate({ ...base, targetPct: 37, priceRounding: step });
      for (const r of rows.filter(x => x.suggestedUnitPrice !== null)) {
        expect(Math.round(r.suggestedUnitPrice * 100) % Math.round(step * 100)).toBe(0);
      }
    }
  });

  test('an impossible target is reported as unreachable', () => {
    const { target } = calculate({ ...base, targetPct: 1000, paymentFeePct: 20 });
    expect(target.reachable).toBe(false);
    expect(target.requiredTaxable).toBeNull();
  });

  test('break-even accounts for the payment fee growing with the price', () => {
    const { summary } = calculate({ gstRate: 18, paymentFeePct: 2, otherCost: 0, rows: [{ qty: 1, unitCost: 1000, quoteUnit: 1 }] });
    const T = summary.breakEvenTaxable;
    const fee = T * 1.18 * 0.02;
    expect(T - 1000 - fee).toBeCloseTo(0, 2);
  });
});

describe('helpers', () => {
  test('margin on cost ↔ profit share of revenue', () => {
    expect(costMarginToSalesShare(1)).toBe(0.5);
    expect(salesShareToCostMargin(0.5)).toBe(1);
    expect(costMarginToSalesShare(0.25)).toBeCloseTo(0.2, 6);
    expect(salesShareToCostMargin(1)).toBeNull();
  });

  test('roundUp never rounds a price down and survives float noise', () => {
    expect(roundUp(151.01, 1)).toBe(152);
    expect(roundUp(151, 1)).toBe(151);
    expect(roundUp(0.1 + 0.2, 0.01)).toBe(0.3);
    expect(roundUp(101, 5)).toBe(105);
    expect(roundUp(100, 10)).toBe(100);
  });

  test('health bands', () => {
    // Margin on cost: poor < 25% <= fair < 50% <= good < 100% <= excellent
    expect([-0.1, 0.1, 0.3, 0.6, 1, 1.5, null].map(health)).toEqual(['loss', 'poor', 'fair', 'good', 'excellent', 'excellent', 'none']);
  });
});

module.exports = { VECTORS };
