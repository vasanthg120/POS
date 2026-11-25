/**
 * margin-engine.ts — Margin calculator engine (browser copy, for live results).
 *
 * Mirrors Backend/services/marginCalc.service.js, which recomputes every saved
 * job; both are checked against the same reference cases
 * (Backend/tests/marginCalc.test.js). Change them together.
 *
 *   Margin % = profit ÷ cost   (cost 100, sold at 200 → 100% margin)
 *
 * That is the business's definition (margin on cost). The older summary fields
 * totalMarginPct / overallMarginPct keep their original meaning (profit ÷
 * revenue) for jobs saved before. Percent outputs are fractions (1 = 100%).
 * Undefined metrics (no price, no cost) are null.
 */

export type RowState = 'ok' | 'empty' | 'no-qty' | 'no-price' | 'loss';
export type Health = 'loss' | 'poor' | 'fair' | 'good' | 'excellent' | 'none';

export interface RowInput {
  item?: string;
  qty?: number | string | null;
  unitCost?: number | string | null;
  decoUnit?: number | string | null;
  setup?: number | string | null;
  ship?: number | string | null;
  quoteUnit?: number | string | null;
}

export interface JobInput {
  rows: RowInput[];
  setupCount?: number | null;
  setupUnit?: number | null;
  shipping?: number | null;
  gstRate?: number | null;
  discountPct?: number | null;
  otherCost?: number | null;
  paymentFeePct?: number | null;
  /** Target margin on cost, in % (50 = cost + 50%). */
  targetPct?: number | null;
  priceRounding?: number | null;
}

export interface RowResult {
  qty: number;
  cog: number;
  decoCost: number;
  totalCost: number;
  costPerUnit: number | null;
  grossRevenue: number;
  revenue: number;
  profit: number;
  profitPerUnit: number | null;
  /** Margin on cost. */
  marginPct: number | null;
  suggestedUnitPrice: number | null;
  state: RowState;
}

export interface SummaryResult {
  totalQty: number;
  totalCog: number;
  totalDecoCost: number;
  totalSetup: number;
  totalShip: number;
  lineCost: number;
  lineRevenueGross: number;
  discountAmount: number;
  lineRevenue: number;
  lineProfit: number;
  lineMarginPct: number | null;
  setupFees: number;
  shippingFee: number;
  taxableValue: number;
  gstAmount: number;
  invoiceTotal: number;
  otherCost: number;
  paymentFee: number;
  allInCost: number;
  netProfit: number;
  /** Margin on cost: net profit ÷ all-in cost. */
  marginPct: number | null;
  breakEvenTaxable: number | null;
  lossRows: number;
  unpricedRows: number;
  // Field names older saved jobs and the stats use (overallMarginPct and
  // totalMarginPct are profit ÷ revenue — not margin on cost).
  totalCost: number;
  totalQuote: number;
  totalMargin: number;
  totalMarginPct: number;
  subtotal: number;
  inclDelivery: number;
  setupTotal: number;
  grandTotal: number;
  profitSubtotal: number;
  incGst: number;
  overallMarginPct: number;
}

export interface TargetResult {
  /** Target margin on cost. */
  marginPct: number | null;
  reachable: boolean;
  requiredTaxable: number | null;
  requiredInvoiceTotal: number | null;
  shortfall: number | null;
  met: boolean;
  rounding: number;
}

export interface CalcResult {
  rows: RowResult[];
  summary: SummaryResult;
  target: TargetResult;
}

/** Margin on cost: poor < 25% ≤ fair < 50% ≤ good < 100% ≤ excellent. */
export const HEALTH_MARGIN_BANDS = [0.25, 0.50, 1.00] as const;
export const ROUNDING_STEPS = [0.01, 1, 5, 10] as const;
export const MAX_ROWS = 300;

/** Finite, non-negative number (anything else → 0). */
export const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const pct = (v: unknown, max = 100): number => Math.min(num(v), max) / 100;
const round2 = (n: number | null): number | null => (n === null ? null : Math.round((n + Number.EPSILON) * 100) / 100);
const round4 = (n: number | null): number | null => (n === null ? null : Math.round((n + Number.EPSILON) * 10000) / 10000);
const money = (n: number): number => round2(n) as number;
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Rounds a price UP to a step (₹0.01, ₹1, ₹5, ₹10). */
export const roundUp = (value: number, step: number): number => {
  if (!(value > 0)) return 0;
  const s = (ROUNDING_STEPS as readonly number[]).includes(step) ? step : 1;
  const paise = Math.round(value * 100 * 1e6) / 1e6;
  const stepPaise = Math.round(s * 100);
  return (Math.ceil(paise / stepPaise - 1e-9) * stepPaise) / 100;
};

/** Margin on cost k → share of revenue that is profit (k ÷ (1 + k)), and back. */
export const costMarginToSalesShare = (k: number | null): number | null => (k === null ? null : k / (1 + k));
export const salesShareToCostMargin = (t: number | null): number | null => (t === null || t >= 1 ? null : t / (1 - t));

interface Settings {
  setupCount: number; setupUnit: number; shipping: number; gst: number; discount: number;
  otherCost: number; paymentFee: number; targetMargin: number; targetSalesShare: number; rounding: number;
}

const jobSettings = (job: JobInput): Settings => {
  const targetMargin = Math.min(num(job.targetPct ?? 50), 1000) / 100;
  const r = Number(job.priceRounding);
  return {
    setupCount: num(job.setupCount),
    setupUnit: num(job.setupUnit),
    shipping: num(job.shipping),
    gst: pct(job.gstRate),
    discount: pct(job.discountPct),
    otherCost: num(job.otherCost),
    paymentFee: pct(job.paymentFeePct, 20),
    targetMargin,
    targetSalesShare: costMarginToSalesShare(targetMargin) as number,
    rounding: (ROUNDING_STEPS as readonly number[]).includes(r) ? r : 1,
  };
};

interface RowRaw {
  qty: number; quoteUnit: number; setup: number; ship: number;
  cog: number; decoCost: number; totalCost: number; costPerUnit: number | null;
  grossRevenue: number; revenue: number; profit: number; profitPerUnit: number | null;
  marginPct: number | null; state: RowState;
}

const calcRow = (row: RowInput, discount: number): RowRaw => {
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

  let state: RowState = 'ok';
  if (qty === 0 && totalCost === 0 && grossRevenue === 0) state = 'empty';
  else if (qty === 0) state = 'no-qty';
  else if (quoteUnit === 0) state = 'no-price';
  else if (profit < 0) state = 'loss';

  return {
    qty, quoteUnit, setup, ship, cog, decoCost, totalCost,
    costPerUnit: qty > 0 ? totalCost / qty : null,
    grossRevenue, revenue, profit,
    profitPerUnit: qty > 0 ? profit / qty : null,
    // Margin on cost; undefined (null) until there is both a price and a cost.
    marginPct: revenue > 0 ? ratio(profit, totalCost) : null,
    state,
  };
};

export const calculate = (job: JobInput): CalcResult => {
  const s = jobSettings(job);
  const rows = (Array.isArray(job.rows) ? job.rows.slice(0, MAX_ROWS) : []).map(r => calcRow(r, s.discount));

  const sum = (fn: (r: RowRaw) => number) => rows.reduce((acc, r) => acc + fn(r), 0);
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
  const salesSharePct = ratio(netProfit, taxableValue);                       // legacy overallMarginPct

  const fixedCost = lineCost + s.otherCost;
  const feeLoad = s.paymentFee * (1 + s.gst);
  const breakEvenTaxable = feeLoad < 1 ? fixedCost / (1 - feeLoad) : null;
  const denom = 1 - s.targetSalesShare - feeLoad;
  const requiredTaxable = denom > 0 ? fixedCost / denom : null;
  const billed = setupFees + shippingFee;
  const requiredLineRevenueGross = requiredTaxable === null || s.discount >= 1
    ? null
    : Math.max(0, (requiredTaxable - billed) / (1 - s.discount));

  const pricedCost = rows.reduce((acc, r) => acc + (r.qty > 0 ? r.totalCost : 0), 0);
  const factor = requiredLineRevenueGross !== null && pricedCost > 0 ? requiredLineRevenueGross / pricedCost : null;

  const outRows: RowResult[] = rows.map(r => ({
    qty: r.qty,
    cog: money(r.cog),
    decoCost: money(r.decoCost),
    totalCost: money(r.totalCost),
    costPerUnit: round2(r.costPerUnit),
    grossRevenue: money(r.grossRevenue),
    revenue: money(r.revenue),
    profit: money(r.profit),
    profitPerUnit: round2(r.profitPerUnit),
    marginPct: round4(r.marginPct),
    suggestedUnitPrice: factor !== null && r.qty > 0 && r.costPerUnit !== null
      ? roundUp(r.costPerUnit * factor, s.rounding)
      : null,
    state: r.state,
  }));

  const summary: SummaryResult = {
    totalQty,
    totalCog: money(sum(r => r.cog)),
    totalDecoCost: money(sum(r => r.decoCost)),
    totalSetup: money(sum(r => r.setup)),
    totalShip: money(sum(r => r.ship)),
    lineCost: money(lineCost),
    lineRevenueGross: money(lineRevenueGross),
    discountAmount: money(discountAmount),
    lineRevenue: money(lineRevenue),
    lineProfit: money(lineProfit),
    lineMarginPct: round4(lineRevenue > 0 ? ratio(lineProfit, lineCost) : null),
    setupFees: money(setupFees),
    shippingFee: money(shippingFee),
    taxableValue: money(taxableValue),
    gstAmount: money(gstAmount),
    invoiceTotal: money(invoiceTotal),
    otherCost: money(s.otherCost),
    paymentFee: money(paymentFee),
    allInCost: money(allInCost),
    netProfit: money(netProfit),
    marginPct: round4(marginPct),
    breakEvenTaxable: round2(breakEvenTaxable),
    lossRows: rows.filter(r => r.state === 'loss').length,
    unpricedRows: rows.filter(r => r.state === 'no-price').length,
    totalCost: money(lineCost),
    totalQuote: money(lineRevenueGross),
    totalMargin: money(lineProfit),
    totalMarginPct: round4(ratio(lineProfit, lineRevenue)) ?? 0,
    subtotal: money(lineRevenueGross),
    inclDelivery: money(lineRevenue + shippingFee),
    setupTotal: money(setupFees),
    grandTotal: money(taxableValue),
    profitSubtotal: money(netProfit),
    incGst: money(invoiceTotal),
    overallMarginPct: round4(salesSharePct) ?? 0,
  };

  const target: TargetResult = {
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

export const health = (marginPct: number | null | undefined): Health => {
  if (marginPct === null || marginPct === undefined || !Number.isFinite(marginPct)) return 'none';
  if (marginPct < 0) return 'loss';
  if (marginPct < HEALTH_MARGIN_BANDS[0]) return 'poor';
  if (marginPct < HEALTH_MARGIN_BANDS[1]) return 'fair';
  if (marginPct < HEALTH_MARGIN_BANDS[2]) return 'good';
  return 'excellent';
};
