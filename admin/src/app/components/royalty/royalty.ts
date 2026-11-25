import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, takeUntil } from 'rxjs';

import {
  RoyaltyService, RoyaltyRow, RoyaltySummary, RoyaltyReportFilters, RoyaltyStatusBreakdownEntry,
  RoyaltySourceSplit, RoyaltyRateLine, RoyaltyHistoryEntry,
} from '../services/royalty';
import { Auth } from '../services/auth';
import { describeHttpError } from '../services/api-error';
import { DetailDrawer } from '../shared/detail-drawer/detail-drawer';
import {
  MONTH_NAMES, PERIOD_PRESETS, PeriodPreset, periodLabel, periodParams, yearOptions,
} from '../shared/period';

const AVATAR_PALETTE = [
  '#1d4ed8', '#0891b2', '#059669', '#7c3aed',
  '#d97706', '#dc2626', '#0284c7', '#9333ea',
  '#0f766e', '#b45309', '#3b82f6', '#ef4444',
];

type RoyaltyPreset = PeriodPreset | 'custom';
type SortField =
  | 'quotationNo' | 'customerName' | 'quotationDate' | 'paymentDate'
  | 'paymentAmount' | 'royaltyPercent' | 'royaltyAmount';

/** Every payment of one quotation within the period — the row-click drawer. */
interface QuoteGroup {
  quoteId: string;
  quotationNo: string;
  quotationTitle: string;
  customerName: string;
  customerEmail: string;
  quotationDate: string | null;
  quoteAmount: number;
  paidToDate: number;
  balanceDue: number;
  paymentStatus: string;
  quotationStatus: string;
  payments: RoyaltyRow[];
  periodPaid: number;
  periodRoyalty: number;
}

@Component({
  selector: 'app-royalty',
  standalone: true,
  imports: [CommonModule, FormsModule, DetailDrawer],
  templateUrl: './royalty.html',
  styleUrls: ['./royalty.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Royalty implements OnInit, OnDestroy {

  // ── Data ──────────────────────────────────────────────────────────────────
  rows: RoyaltyRow[] = [];
  summary: RoyaltySummary = this.emptySummary();
  statusBreakdown: RoyaltyStatusBreakdownEntry[] = [];
  sourceSplit: RoyaltySourceSplit[] = [];
  rateBreakdown: RoyaltyRateLine[] = [];
  /** yyyy-mm-dd bounds of the data on screen ('' = open-ended). */
  viewRange: { from: string; to: string } = { from: '', to: '' };
  /** Label of the period the data on screen was loaded for — the picker may
   *  already show the next one while that request is still running. */
  viewLabel = '';
  rateHistory: RoyaltyHistoryEntry[] = [];

  // ── UI state ──────────────────────────────────────────────────────────────
  isLoading = true;
  hasLoaded = false;
  loadError = '';
  skeletonCards = Array(4);

  // ── Period — defaults to the current month (royalty is settled monthly) ────
  readonly presets: { value: RoyaltyPreset; label: string }[] = [
    ...PERIOD_PRESETS.filter(p => p.value !== 'all'),
    { value: 'all', label: 'All time' },
    { value: 'custom', label: 'Custom range…' },
  ];
  readonly months = MONTH_NAMES;
  readonly years = yearOptions();

  preset: RoyaltyPreset = 'this_month';
  pickMonth = new Date().getMonth() + 1;
  pickYear = new Date().getFullYear();
  dateFrom = '';
  dateTo = '';

  // ── Filters ───────────────────────────────────────────────────────────────
  searchQuery = '';
  activeSource: '' | 'Manual' | 'Razorpay' = '';
  activeStatus: '' | 'paid' | 'partially_paid' = '';

  readonly statusOptions: { value: '' | 'paid' | 'partially_paid'; label: string }[] = [
    { value: '', label: 'All' },
    { value: 'paid', label: 'Fully paid' },
    { value: 'partially_paid', label: 'Partially paid' },
  ];

  // ── Sort (client-side, over the already-fetched rows) ──────────────────────
  sortField: SortField = 'paymentDate';
  sortDir: 'asc' | 'desc' = 'desc';

  // ── Drawers ───────────────────────────────────────────────────────────────
  selectedQuote: QuoteGroup | null = null;
  showRateHistory = false;

  // ── Toast ─────────────────────────────────────────────────────────────────
  showToast = false;
  toastMsg = '';
  toastType: 'success' | 'error' = 'success';
  private toastTimer?: ReturnType<typeof setTimeout>;

  private destroy$ = new Subject<void>();
  private filterTrigger$ = new Subject<void>();
  private requestSeq = 0;

  constructor(
    private svc: RoyaltyService,
    private cdr: ChangeDetectorRef,
    public  auth: Auth,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.filterTrigger$
      .pipe(debounceTime(300), takeUntil(this.destroy$))
      .subscribe(() => this.loadReport());

    this.loadConfig();
    this.loadReport();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  private buildFilters(): RoyaltyReportFilters {
    const filters: RoyaltyReportFilters = {
      search: this.searchQuery.trim(),
      source: this.activeSource,
      status: this.activeStatus,
    };
    if (this.preset === 'custom') {
      if (this.dateFrom) filters.dateFrom = this.dateFrom;
      if (this.dateTo) filters.dateTo = this.dateTo;
      // An empty custom range would silently fall back to "this month" on the
      // server — say "all time" instead, which is what an open range means.
      if (!this.dateFrom && !this.dateTo) filters.period = 'all';
    } else {
      Object.assign(filters, periodParams({ preset: this.preset, month: this.pickMonth, year: this.pickYear }));
    }
    return filters;
  }

  /**
   * The calendar days a request covers, worked out here rather than read back
   * from the server's timestamps — those are in the server's timezone and
   * would show "1 Nov – 1 Dec" in an IST browser if the server runs on UTC.
   */
  private rangeOf(f: RoyaltyReportFilters): { from: string; to: string } {
    if (f.period === 'all') return { from: '', to: '' };
    if (f.month && f.year) {
      const mm = String(f.month).padStart(2, '0');
      const last = new Date(f.year, f.month, 0).getDate();
      return { from: `${f.year}-${mm}-01`, to: `${f.year}-${mm}-${String(last).padStart(2, '0')}` };
    }
    return { from: f.dateFrom ?? '', to: f.dateTo ?? '' };
  }

  loadReport(): void {
    this.isLoading = true;
    this.cdr.markForCheck();
    const seq = ++this.requestSeq;
    const filters = this.buildFilters();
    const range = this.rangeOf(filters);
    const label = this.periodText;
    if (!this.viewLabel) this.viewLabel = label;

    this.svc.getReport(filters)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          if (seq !== this.requestSeq) return; // a newer filter change is in flight
          const d = res.data;
          this.rows = d.rows ?? [];
          this.summary = { ...this.emptySummary(), ...d.summary };
          this.statusBreakdown = d.statusBreakdown ?? [];
          this.sourceSplit = d.sourceSplit ?? [];
          this.rateBreakdown = d.rateBreakdown ?? [];
          this.viewRange = range;
          this.viewLabel = label;
          this.isLoading = false;
          this.hasLoaded = true;
          this.loadError = '';
          this.applySort();
          // Keep an open drawer in step with the refreshed data.
          if (this.selectedQuote) {
            const id = this.selectedQuote.quoteId;
            this.selectedQuote = this.rows.some(r => r.quoteId === id) ? this.groupFor(id) : null;
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          if (seq !== this.requestSeq) return;
          this.isLoading = false;
          // The reason, not a fixed text: "Cannot reach the POS server", the
          // CRM's own error, a session that ended, HTTP status, …
          this.loadError = describeHttpError(err, 'Failed to load the royalty report.');
          this.showToastMsg(this.loadError, 'error');
          this.cdr.markForCheck();
        },
      });
  }

  private loadConfig(): void {
    this.svc.getConfig()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => { this.rateHistory = res.data.history ?? []; this.cdr.markForCheck(); },
        error: () => {},
      });
  }

  refresh(): void {
    this.loadConfig();
    this.loadReport();
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  onPresetChange(): void {
    if (this.preset === 'custom' && !this.dateFrom && !this.dateTo) {
      // Start the custom range from the period being viewed, so switching to
      // it doesn't jump to a different set of numbers before any date is picked.
      this.dateFrom = this.viewRange.from;
      this.dateTo = this.viewRange.to;
    }
    this.queueReload();
  }

  applyFilters(): void { this.queueReload(); }

  /** Dim the current numbers right away, then load once input settles. */
  private queueReload(): void {
    this.isLoading = true;
    this.cdr.markForCheck();
    this.filterTrigger$.next();
  }

  setSource(source: '' | 'Manual' | 'Razorpay'): void {
    this.activeSource = this.activeSource === source ? '' : source;
    this.queueReload();
  }

  setStatus(status: '' | 'paid' | 'partially_paid'): void {
    this.activeStatus = status;
    this.queueReload();
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.queueReload();
  }

  resetFilters(): void {
    const now = new Date();
    this.preset = 'this_month';
    this.pickMonth = now.getMonth() + 1;
    this.pickYear = now.getFullYear();
    this.dateFrom = '';
    this.dateTo = '';
    this.searchQuery = '';
    this.activeSource = '';
    this.activeStatus = '';
    this.queueReload();
  }

  /** Filters other than the period — the period is always shown on its own. */
  get activeFilterCount(): number {
    return [this.searchQuery.trim(), this.activeSource, this.activeStatus].filter(Boolean).length;
  }

  get isDefaultView(): boolean {
    return this.preset === 'this_month' && this.activeFilterCount === 0;
  }

  // ── Period text ───────────────────────────────────────────────────────────

  get periodText(): string {
    if (this.preset === 'custom') {
      if (!this.dateFrom && !this.dateTo) return 'All time';
      if (!this.dateTo) return `From ${this.fmtDate(this.dateFrom)}`;
      if (!this.dateFrom) return `Up to ${this.fmtDate(this.dateTo)}`;
      return `${this.fmtDate(this.dateFrom)} – ${this.fmtDate(this.dateTo)}`;
    }
    return periodLabel({ preset: this.preset, month: this.pickMonth, year: this.pickYear });
  }

  /** The exact days on screen, e.g. "1 Nov 2026 – 30 Nov 2026". */
  get periodRangeText(): string {
    const { from, to } = this.viewRange;
    if (!from && !to) return 'Every recorded payment';
    if (from && to) return `${this.fmtDate(from)} – ${this.fmtDate(to)}`;
    return from ? `From ${this.fmtDate(from)}` : `Up to ${this.fmtDate(to)}`;
  }

  // ── Derived numbers ───────────────────────────────────────────────────────

  /** Royalty ÷ revenue — equals the rate unless the period spans a rate change. */
  get effectiveRate(): number {
    const { totalEligibleAmount: amt, totalRoyaltyPayable: roy } = this.summary;
    return amt > 0 ? Math.round((roy / amt) * 10000) / 100 : this.summary.royaltyPercentage;
  }

  get hasMixedRates(): boolean { return this.rateBreakdown.length > 1; }

  /** Table footer: the single rate applied, or "≈ avg%" if the rate changed mid-period. */
  get footerRate(): string {
    if (this.hasMixedRates) return `≈ ${this.effectiveRate}%`;
    return `${this.rateBreakdown.length ? this.rateBreakdown[0].percentage : 0}%`;
  }

  sourceShare(s: RoyaltySourceSplit): number {
    const total = this.sourceSplit.reduce((t, x) => t + x.amount, 0);
    return total > 0 ? Math.round((s.amount / total) * 100) : 0;
  }

  get hasSourceData(): boolean { return this.sourceSplit.some(s => s.count > 0); }

  /** Payments of a single quotation would otherwise read "1 payments". */
  plural(n: number, word: string): string { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  // ── Drawers ───────────────────────────────────────────────────────────────

  private groupFor(quoteId: string): QuoteGroup | null {
    const payments = this.rows
      .filter(r => r.quoteId === quoteId)
      .sort((a, b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());
    if (!payments.length) return null;
    const f = payments[0];
    const sum = (k: 'paymentAmount' | 'royaltyAmount') =>
      Math.round(payments.reduce((s, p) => s + (p[k] || 0), 0) * 100) / 100;
    return {
      quoteId,
      quotationNo: f.quotationNo,
      quotationTitle: f.quotationTitle,
      customerName: f.customerName,
      customerEmail: f.customerEmail,
      quotationDate: f.quotationDate,
      quoteAmount: f.quoteAmount,
      paidToDate: f.paidToDate,
      balanceDue: f.balanceDue,
      paymentStatus: f.paymentStatus,
      quotationStatus: f.quotationStatus,
      payments,
      periodPaid: sum('paymentAmount'),
      periodRoyalty: sum('royaltyAmount'),
    };
  }

  openQuote(r: RoyaltyRow): void {
    this.selectedQuote = this.groupFor(r.quoteId);
    this.cdr.markForCheck();
  }

  closeQuote(): void { this.selectedQuote = null; this.cdr.markForCheck(); }

  openRateHistory(): void { this.showRateHistory = true; this.cdr.markForCheck(); }
  closeRateHistory(): void { this.showRateHistory = false; this.cdr.markForCheck(); }

  paidPct(g: QuoteGroup): number {
    return g.quoteAmount > 0 ? Math.min(100, Math.round((g.paidToDate / g.quoteAmount) * 100)) : 0;
  }

  /** Plain-language reason a payment got its rate (tooltip + drawer). */
  rateNote(r: RoyaltyRow): string {
    const since = r.rateEffectiveFrom ? this.fmtDate(r.rateEffectiveFrom) : '';
    switch (r.rateBasis) {
      case 'history':    return `${r.royaltyPercent}% was the rate in force on ${this.fmtDate(r.paymentDate)} (set ${since}).`;
      case 'first-rate': return `Paid before your first royalty rate was set on ${since}, so that first rate (${r.royaltyPercent}%) applies.`;
      case 'override':   return `A special ${r.royaltyPercent}% rate applies to this quotation (since ${since}).`;
      default:           return 'No royalty rate has been set for your account yet, so no royalty is charged.';
    }
  }

  // ── Sort ──────────────────────────────────────────────────────────────────

  sortBy(field: SortField): void {
    this.sortDir = this.sortField === field ? (this.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    this.sortField = field;
    this.applySort();
    this.cdr.markForCheck();
  }

  ariaSort(field: SortField): 'ascending' | 'descending' | 'none' {
    if (this.sortField !== field) return 'none';
    return this.sortDir === 'asc' ? 'ascending' : 'descending';
  }

  private applySort(): void {
    const dir = this.sortDir === 'asc' ? 1 : -1;
    const f = this.sortField;
    const isDate = f === 'paymentDate' || f === 'quotationDate';
    this.rows = [...this.rows].sort((a, b) => {
      const av = a[f];
      const bv = b[f];
      if (isDate) {
        return dir * ((av ? new Date(av as string).getTime() : 0) - (bv ? new Date(bv as string).getTime() : 0));
      }
      if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv);
      // numeric: true → quotation "17" sorts before "114", not after it.
      return dir * String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  // ── CSV export ────────────────────────────────────────────────────────────

  exportCSV(): void {
    if (!this.rows.length) return;
    const headers = [
      'Quotation Number', 'Quotation Title', 'Customer Name', 'Customer Email',
      'Quotation Date', 'Payment Date', 'Payment Source', 'Payment Method', 'Payment Reference',
      'Payment Amount (INR)', 'Royalty %', 'Rate Effective From', 'Royalty Amount (INR)',
      'Payment Status', 'Royalty Status',
    ];
    const csvRows: (string | number)[][] = this.rows.map(r => [
      r.quotationNo, r.quotationTitle, r.customerName, r.customerEmail,
      this.isoDay(r.quotationDate), this.isoDay(r.paymentDate), r.paymentSource, r.paymentMethod, r.paymentReference,
      r.paymentAmount.toFixed(2), r.royaltyPercent, this.isoDay(r.rateEffectiveFrom), r.royaltyAmount.toFixed(2),
      this.payLabel(r.paymentStatus), r.royaltyStatus,
    ]);
    csvRows.push([
      'TOTAL', '', '', '', '', '', '', '', '',
      this.summary.totalEligibleAmount.toFixed(2), '', '', this.summary.totalRoyaltyPayable.toFixed(2), '', '',
    ]);
    const csv = [headers, ...csvRows]
      .map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const slug = this.viewLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    Object.assign(document.createElement('a'), { href: url, download: `royalty-${slug || 'report'}.csv` }).click();
    URL.revokeObjectURL(url);
    this.showToastMsg(`Exported ${this.plural(this.rows.length, 'payment')}.`, 'success');
  }

  // ── Display helpers ───────────────────────────────────────────────────────

  fmtINR(n: number, decimals = 0): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR',
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }).format(n ?? 0);
  }

  /** Royalty is a percentage of a payment — show it to the paisa. */
  fmtRoyalty(n: number): string { return this.fmtINR(n, 2); }

  fmtDate(s: string | null | undefined): string {
    if (!s) return '—';
    // A bare yyyy-mm-dd is a local calendar day — parse it as one, or IST
    // users would see the day before.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  fmtDateTime(s: string | null | undefined): string {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /** yyyy-mm-dd in local time, for CSV cells and date inputs. */
  private isoDay(s: string | null | undefined): string {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  avatarColor(name: string): string {
    return AVATAR_PALETTE[(name?.charCodeAt(0) ?? 0) % AVATAR_PALETTE.length];
  }

  initials(name: string): string {
    return (name || '?').split(/\s+/).filter(Boolean).map(p => p[0]).join('').slice(0, 2).toUpperCase() || '?';
  }

  payLabel(status: string): string {
    const map: Record<string, string> = { paid: 'Paid', partially_paid: 'Partial' };
    return map[status] ?? status;
  }

  breakdownLabel(status: string): string {
    const map: Record<string, string> = {
      pending: 'Awaiting payment', paid: 'Paid', partially_paid: 'Partially paid',
      failed: 'Failed', refunded: 'Refunded',
    };
    return map[status] ?? status;
  }

  private showToastMsg(msg: string, type: 'success' | 'error'): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastMsg = msg;
    this.toastType = type;
    this.showToast = true;
    this.cdr.markForCheck();
    this.toastTimer = setTimeout(() => { this.showToast = false; this.cdr.markForCheck(); }, 3200);
  }

  private emptySummary(): RoyaltySummary {
    return {
      quotationsInPeriod: 0, paidQuotationsInPeriod: 0, totalPayments: 0, totalEligibleAmount: 0,
      royaltyPercentage: 0, rateConfigured: true, rateSince: null, totalRoyaltyPayable: 0,
      quotationCount: 0, manualCount: 0, razorpayCount: 0, scannedQuotations: 0,
    };
  }

  // ── trackBy ───────────────────────────────────────────────────────────────
  trackByRow(i: number, r: RoyaltyRow): string { return `${r.quoteId}-${r.paymentReference}-${r.paymentDate}-${i}`; }
  trackByIdx(i: number): number { return i; }
}
