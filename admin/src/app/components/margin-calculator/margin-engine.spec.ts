import { calculate, health, costMarginToSalesShare, salesShareToCostMargin, roundUp } from './margin-engine';

/**
 * Browser engine. Backend/tests/marginCalc.test.js holds the full reference
 * cases for the server copy; both engines must agree.
 * Margin = profit ÷ cost (margin on cost).
 */
describe('margin-engine', () => {
  it('cost 100, sold at 200 → 100% margin', () => {
    const { summary, rows } = calculate({ gstRate: 18, rows: [{ qty: 1, unitCost: 100, quoteUnit: 200 }] });
    expect(summary.marginPct).toBe(1);
    expect(rows[0].marginPct).toBe(1);
    expect(summary.netProfit).toBe(100);
    expect(summary.gstAmount).toBe(36);
    expect(summary.invoiceTotal).toBe(236);
    expect(rows[0].costPerUnit).toBe(100);
    expect(health(summary.marginPct)).toBe('excellent');
  });

  it('cost 100, sold at 150 → 50% margin', () => {
    const { summary } = calculate({ rows: [{ qty: 4, unitCost: 100, quoteUnit: 150 }] });
    expect(summary.marginPct).toBe(0.5);
    expect(health(summary.marginPct)).toBe('good');
  });

  it('spreads print, setup and shipping into an all-in unit cost', () => {
    const { rows } = calculate({ rows: [{ qty: 50, unitCost: 120, decoUnit: 30, setup: 500, ship: 250, quoteUnit: 250 }] });
    expect(rows[0].totalCost).toBe(8250);
    expect(rows[0].costPerUnit).toBe(165);
    expect(rows[0].marginPct as number).toBeCloseTo(4250 / 8250, 4);
  });

  it('treats billed setup fees and shipping as revenue, not cost', () => {
    const { summary } = calculate({ gstRate: 0, setupCount: 2, setupUnit: 400, shipping: 300, rows: [{ qty: 10, unitCost: 100, quoteUnit: 180 }] });
    expect(summary.taxableValue).toBe(2900);
    expect(summary.netProfit).toBe(1900);
    expect(summary.marginPct).toBe(1.9);
  });

  it('reports no price as null (shown as —), not 0% or -100%', () => {
    const { summary, rows } = calculate({ rows: [{ qty: 5, unitCost: 300 }] });
    expect(summary.marginPct).toBeNull();
    expect(rows[0].marginPct).toBeNull();
    expect(rows[0].state).toBe('no-price');
    expect(health(summary.marginPct)).toBe('none');
  });

  it('suggested prices reach the target margin', () => {
    const job = { gstRate: 18, discountPct: 5, otherCost: 300, paymentFeePct: 2, targetPct: 60,
      rows: [{ qty: 60, unitCost: 260, decoUnit: 45, setup: 800, quoteUnit: 340 }, { qty: 60, unitCost: 90, quoteUnit: 140 }] };
    const first = calculate(job);
    const priced = { ...job, rows: job.rows.map((r, i) => ({ ...r, quoteUnit: first.rows[i].suggestedUnitPrice ?? r.quoteUnit })) };
    expect(calculate(priced).summary.marginPct as number).toBeGreaterThanOrEqual(0.6 - 1e-4);
  });

  it('converts margin on cost ↔ profit share of revenue and rounds prices up', () => {
    expect(costMarginToSalesShare(1)).toBe(0.5);
    expect(salesShareToCostMargin(0.5)).toBe(1);
    expect(roundUp(151.01, 1)).toBe(152);
    expect(roundUp(101, 5)).toBe(105);
  });
});
