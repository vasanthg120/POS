'use strict';

/**
 * services/marginCalc.service.js — Margin calculator engine (server copy).
 *
 * The browser has the same engine (admin/.../margin-calculator/margin-engine.ts)
 * for live results; the server recomputes on every save so the stored summary
 * and the stats built from it can't drift from the rows, whatever a client
 * sends. Both are checked against the same cases in tests/marginCalc.test.js.
 *
 * ── Definition ─────────────────────────────────────────────────────────────
 *   Margin % = profit ÷ cost          (cost 100, sold at 200 → 100% margin)
 *   This is the business's definition (margin on cost). The older summary
 *   fields totalMarginPct / overallMarginPct keep their original meaning,
 *   profit ÷ revenue, for compatibility with jobs saved before.
 *
 * ── Per line item ──────────────────────────────────────────────────────────
 *   cost      = qty × unit cost + qty × print/deco per unit + setup + shipping
 *   cost/unit = cost ÷ qty                      (fully loaded = break-even price)
 *   revenue   = qty × sell price × (1 − job discount)
 *   profit    = revenue − cost
 *
 * ── Job ────────────────────────────────────────────────────────────────────
 *   taxable value (ex GST) = line revenue + setup fees billed + shipping billed
 *   GST                    = taxable value × GST rate
 *   invoice total          = taxable value + GST
 *   payment fee            = invoice total × payment fee %   (gateway charges on what is collected)
 *   all-in cost            = line costs + other job costs + payment fee
 *   net profit             = taxable value − all-in cost
 *   margin                 = net profit ÷ all-in cost
 *
 * ── Target pricing ─────────────────────────────────────────────────────────
 *   A target margin k (on cost) is profit ÷ revenue of t = k ÷ (1 + k):
 *     taxable value needed  T* = C0 ÷ (1 − t − f·(1 + g))
 *   with C0 = line costs + other job costs, f = payment fee, g = GST rate —
 *   exact, because the payment fee itself grows with the price. Suggested
 *   unit prices spread the needed line revenue over the rows in proportion
 *   to their cost (the same margin on every row), rounded UP to the chosen
 *   step so the target is met, not missed by rounding.
 *
 * Percentages are fractions (0.35 = 35%). A metric that is undefined (margin
 * with no revenue, cost/unit with no quantity) is null — never a misleading 0.
 */

// Margin on cost: poor < 25% ≤ fair < 50% ≤ good < 100% ≤ excellent
const HEALTH_MARGIN_BANDS = [0.25, 0.50, 1.00];
const MAX_ROWS = 300;
const ROUNDING_STEPS = [0.01, 1, 5, 10];

/** Finite, non-negative number (anything else → 0). */
const num = (v) => {
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** A percentage input (e.g. 18 for 18%) → fraction, clamped to 0…max%. */
const pct = (v, max = 100) => Math.min(num(v), max) / 100;

const round2 = (n) => (n === null ? null : Math.round((n + Number.EPSILON) * 100) / 100);
const round4 = (n) => (n === null ? null : Math.round((n + Number.EPSILON) * 10000) / 10000);
const ratio = (a, b) => (b > 0 ? a / b : null);

/** Rounds a price UP to a step (₹0.01, ₹1, ₹5, ₹10). */
const roundUp = (value, step) => {
  if (!(value > 0)) return 0;
  const s = ROUNDING_STEPS.includes(step) ? step : 1;
  // Integer arithmetic in paise avoids 0.1 + 0.2 style errors.
  const paise = Math.round(value * 100 * 1e6) / 1e6;
  const stepPaise = Math.round(s * 100);
  return (Math.ceil(paise / stepPaise - 1e-9) * stepPaise) / 100;
};

/** Margin on cost k → share of revenue that is profit (k ÷ (1 + k)), and back. */
const costMarginToSalesShare = (k) => (k === null ? null : k / (1 + k));
const salesShareToCostMargin = (t) => (t === null || t >= 1 ? null : t / (1 - t));

/** Normalised job-level settings. */
const jobSettings = (job = {}) => {
  // Target margin on cost (e.g. 50 = sell at cost + 50%), capped at 1000%.
  const targetMargin = Math.min(num(job.targetPct ?? 50), 1000) / 100;
  return {
    setupCount: num(job.setupCount),
    setupUnit: num(job.setupUnit),
    shipping: num(job.shipping),
    gst: pct(job.gstRate),
    discount: pct(job.discountPct),
    otherCost: num(job.otherCost),
    paymentFee: pct(job.paymentFeePct, 20),
    targetMargin,
    targetSalesShare: costMarginToSalesShare(targetMargin),
    rounding: ROUNDING_STEPS.includes(Number(job.priceRounding)) ? Number(job.priceRounding) : 1,
  };
};

/** One line item (before job-level pricing suggestions). */
const calcRow = (row = {}, discount = 0) => {
  const qty = num(row.qty);
  const unitCost = num(row.unitCost);
  const decoUnit = num(row.decoUnit);
  const setup = num(row.setup);
  const ship = num(row.ship);
  const quoteUnit = num(row.quoteUnit);

  const cog = qty * unitCost;
  const decoCost = qty * decoUnit;
  const totalCost = cog + decoCost + setup + ship;
  const grossRevenue = qty * quoteUnit;
  const revenue = grossRevenue * (1 - discount);
  const profit = revenue - totalCost;

  let state = 'ok';
  if (qty === 0 && totalCost === 0 && grossRevenue === 0) state = 'empty';
  else if (qty === 0) state = 'no-qty';
  else if (quoteUnit === 0) state = 'no-price';
  else if (profit < 0) state = 'loss';

  return {
    qty, unitCost, decoUnit, setup, ship, quoteUnit,
    cog, decoCost, totalCost,
    costPerUnit: qty > 0 ? totalCost / qty : null,
    grossRevenue, revenue, profit,
    profitPerUnit: qty > 0 ? profit / qty : null,
    // Margin on cost; undefined (null) until there is both a price and a cost.
    marginPct: revenue > 0 ? ratio(profit, totalCost) : null,
    salesSharePct: ratio(profit, revenue),        // profit ÷ revenue (internal)
    state,
  };
};

/**
 * Full calculation. Returns { rows, summary, target } with money rounded to
 * paise and percentages to 4 decimals. `summary` also carries the field names
 * older saved jobs use (grandTotal, profitSubtotal, overallMarginPct, …) with
 * the same meaning, so existing jobs and stats stay consistent.
 */
const calculate = (job = {}) => {
  const s = jobSettings(job);
  const inputRows = Array.isArray(job.rows) ? job.rows.slice(0, MAX_ROWS) : [];
  const rows = inputRows.map(r => calcRow(r, s.discount));

  const sum = (fn) => rows.reduce((acc, r) => acc + fn(r), 0);
  const totalQty = sum(r => r.qty);
  const lineCost = sum(r => r.totalCost);
  const lineRevenueGross = sum(r => r.grossRevenue);
  const discountAmount = lineRevenueGross * s.discount;
  const lineRevenue = lineRevenueGross - discountAmount;
  const lineProfit = lineRevenue - lineCost;

  const setupFees = s.setupCount * s.setupUnit;
  const shippingFee = s.shipping;
  const taxableValue = lineRevenue + setupFees + shippingFee;
  const gstAmount = taxableValue * s.gst;
  const invoiceTotal = taxableValue + gstAmount;
  const paymentFee = invoiceTotal * s.paymentFee;
  const allInCost = lineCost + s.otherCost + paymentFee;
  const netProfit = taxableValue - allInCost;
  const marginPct = taxableValue > 0 ? ratio(netProfit, allInCost) : null;   // margin on cost
  const salesSharePct = ratio(netProfit, taxableValue);  // legacy overallMarginPct

  // ── Break-even and target pricing (exact, fee scales with price) ─────────
  const fixedCost = lineCost + s.otherCost;                 // C0
  const feeLoad = s.paymentFee * (1 + s.gst);               // f·(1+g)
  const breakEvenTaxable = feeLoad < 1 ? fixedCost / (1 - feeLoad) : null;
  const denom = 1 - s.targetSalesShare - feeLoad;
  const requiredTaxable = denom > 0 ? fixedCost / denom : null;
  const billed = setupFees + shippingFee;
  const requiredLineRevenueGross = requiredTaxable === null || s.discount >= 1
    ? null
    : Math.max(0, (requiredTaxable - billed) / (1 - s.discount));

  // Suggested unit prices: same margin on every priced row's all-in cost.
  const pricedCost = rows.reduce((acc, r) => acc + (r.qty > 0 ? r.totalCost : 0), 0);
  const factor = requiredLineRevenueGross !== null && pricedCost > 0
    ? requiredLineRevenueGross / pricedCost
    : null;
  const suggested = rows.map(r => (factor !== null && r.qty > 0 && r.costPerUnit !== null
    ? roundUp(r.costPerUnit * factor, s.rounding)
    : null));

  const outRows = rows.map((r, i) => ({
    qty: r.qty,
    cog: round2(r.cog),
    decoCost: round2(r.decoCost),
    totalCost: round2(r.totalCost),
    costPerUnit: round2(r.costPerUnit),
    grossRevenue: round2(r.grossRevenue),
    revenue: round2(r.revenue),
    profit: round2(r.profit),
    profitPerUnit: round2(r.profitPerUnit),
    marginPct: round4(r.marginPct),
    suggestedUnitPrice: suggested[i],
    state: r.state,
  }));

  const summary = {
    // Totals
    totalQty,
    totalCog: round2(sum(r => r.cog)),
    totalDecoCost: round2(sum(r => r.decoCost)),
    totalSetup: round2(sum(r => r.setup)),
    totalShip: round2(sum(r => r.ship)),
    lineCost: round2(lineCost),
    lineRevenueGross: round2(lineRevenueGross),
    discountAmount: round2(discountAmount),
    lineRevenue: round2(lineRevenue),
    lineProfit: round2(lineProfit),
    lineMarginPct: round4(lineRevenue > 0 ? ratio(lineProfit, lineCost) : null),
    setupFees: round2(setupFees),
    shippingFee: round2(shippingFee),
    taxableValue: round2(taxableValue),
    gstAmount: round2(gstAmount),
    invoiceTotal: round2(invoiceTotal),
    otherCost: round2(s.otherCost),
    paymentFee: round2(paymentFee),
    allInCost: round2(allInCost),
    netProfit: round2(netProfit),
    marginPct: round4(marginPct),
    breakEvenTaxable: round2(breakEvenTaxable),
    lossRows: rows.filter(r => r.state === 'loss').length,
    unpricedRows: rows.filter(r => r.state === 'no-price').length,

    // Names older saved jobs and the stats use — same meaning as before
    // (totalMarginPct / overallMarginPct are profit ÷ revenue, not margin on cost).
    totalCost: round2(lineCost),
    totalQuote: round2(lineRevenueGross),
    totalMargin: round2(lineProfit),
    totalMarginPct: round4(ratio(lineProfit, lineRevenue)) ?? 0,
    subtotal: round2(lineRevenueGross),
    inclDelivery: round2(lineRevenue + shippingFee),
    setupTotal: round2(setupFees),
    grandTotal: round2(taxableValue),
    profitSubtotal: round2(netProfit),
    incGst: round2(invoiceTotal),
    overallMarginPct: round4(salesSharePct) ?? 0,
  };

  const target = {
    marginPct: round4(s.targetMargin),
    reachable: requiredTaxable !== null,
    requiredTaxable: round2(requiredTaxable),
    requiredInvoiceTotal: round2(requiredTaxable === null ? null : requiredTaxable * (1 + s.gst)),
    shortfall: round2(requiredTaxable === null ? null : Math.max(0, requiredTaxable - taxableValue)),
    met: marginPct !== null && requiredTaxable !== null && lineCost > 0 && taxableValue >= requiredTaxable - 0.005,
    rounding: s.rounding,
  };

  return { rows: outRows, summary, target };
};

/** 'loss' | 'poor' | 'fair' | 'good' | 'excellent' | 'none' for a margin on cost. */
const health = (marginPct) => {
  if (marginPct === null || marginPct === undefined || !Number.isFinite(marginPct)) return 'none';
  if (marginPct < 0) return 'loss';
  if (marginPct < HEALTH_MARGIN_BANDS[0]) return 'poor';
  if (marginPct < HEALTH_MARGIN_BANDS[1]) return 'fair';
  if (marginPct < HEALTH_MARGIN_BANDS[2]) return 'good';
  return 'excellent';
};

module.exports = {
  calculate,
  calcRow,
  jobSettings,
  health,
  roundUp,
  costMarginToSalesShare,
  salesShareToCostMargin,
  num,
  MAX_ROWS,
  ROUNDING_STEPS,
  HEALTH_MARGIN_BANDS,
};
