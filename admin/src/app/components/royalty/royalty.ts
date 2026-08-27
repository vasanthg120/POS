import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, takeUntil } from 'rxjs';

import {
  RoyaltyService, RoyaltyRow, RoyaltySummary, RoyaltyReportFilters, RoyaltyStatusBreakdownEntry,
} from '../services/royalty';
import { Auth } from '../services/auth';

const AVATAR_PALETTE = [
  '#1d4ed8', '#0891b2', '#059669', '#7c3aed',
  '#d97706', '#dc2626', '#0284c7', '#9333ea',
  '#0f766e', '#b45309', '#3b82f6', '#ef4444',
];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

@Component({
  selector: 'app-royalty',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './royalty.html',
  styleUrls: ['./royalty.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Royalty implements OnInit, OnDestroy {

  // ── Data ──────────────────────────────────────────────────────────────────
  rows: RoyaltyRow[] = [];
  summary: RoyaltySummary = this.emptySummary();
  statusBreakdown: RoyaltyStatusBreakdownEntry[] = [];

  // ── UI state ──────────────────────────────────────────────────────────────
  isLoading = true;
  skeletonRows = Array(7);
  filtersCollapsed = true;

  // ── Filters — month/year default to the current period ────────────────────
  readonly monthOptions = MONTH_NAMES.map((label, i) => ({ value: i + 1, label }));
  readonly yearOptions: number[] = (() => {
    const y = new Date().getFullYear();
    return [y - 2, y - 1, y, y + 1];
  })();

  selectedMonth = new Date().getMonth() + 1;
  selectedYear = new Date().getFullYear();
  usingCustomRange = false;
  dateFrom = '';
  dateTo = '';
  searchQuery = '';
  activeSource = '';
  activeStatus = '';

  readonly sourceOptions = [
    { value: '', label: 'All Sources' },
    { value: 'Manual', label: 'Manual' },
    { value: 'Razorpay', label: 'Razorpay' },
  ];

  readonly statusOptions = [
    { value: '', label: 'All' },
    { value: 'paid', label: 'Paid' },
    { value: 'partially_paid', label: 'Partially Paid' },
  ];

  // ── Sort (client-side, over the already-fetched rows) ──────────────────────
  sortField: keyof RoyaltyRow = 'paymentDate';
  sortDir: 'asc' | 'desc' = 'desc';

  // ── Royalty % (set by platform admin — read-only here) ─────────────────────
  currentPercentage: number | null = null;

  // ── Toast ─────────────────────────────────────────────────────────────────
  showToast = false;
  toastMsg = '';
  toastType: 'success' | 'error' = 'success';
  private toastTimer?: ReturnType<typeof setTimeout>;

  private destroy$ = new Subject<void>();
  private filterTrigger$ = new Subject<void>();

  constructor(
    private svc: RoyaltyService,
    private cdr: ChangeDetectorRef,
    public  auth: Auth,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.filterTrigger$
      .pipe(debounceTime(250), takeUntil(this.destroy$))
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
    if (this.usingCustomRange && (this.dateFrom || this.dateTo)) {
      filters.dateFrom = this.dateFrom;
      filters.dateTo = this.dateTo;
    } else {
      filters.month = this.selectedMonth;
      filters.year = this.selectedYear;
    }
    return filters;
  }

  loadReport(showSpinner = true): void {
    if (showSpinner) { this.isLoading = true; this.cdr.markForCheck(); }

    this.svc.getReport(this.buildFilters())
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.rows = res.data.rows;
          this.summary = res.data.summary;
          this.statusBreakdown = res.data.statusBreakdown ?? [];
          this.currentPercentage = res.data.summary.royaltyPercentage;
          this.isLoading = false;
          this.applySort();
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.isLoading = false;
          this.showToastMsg(err?.error?.message || 'Failed to load royalty report', 'error');
          this.cdr.markForCheck();
        },
      });
  }

  private loadConfig(): void {
    this.svc.getConfig()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => { this.currentPercentage = res.data.percentage; this.cdr.markForCheck(); },
        error: () => {},
      });
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  onPeriodChange(): void {
    this.usingCustomRange = false;
    this.filterTrigger$.next();
  }

  onDateRangeChange(): void {
    this.usingCustomRange = !!(this.dateFrom || this.dateTo);
    this.filterTrigger$.next();
  }

  applyFilters(): void { this.filterTrigger$.next(); }

  toggleFilters(): void { this.filtersCollapsed = !this.filtersCollapsed; }

  resetFilters(): void {
    const now = new Date();
    this.selectedMonth = now.getMonth() + 1;
    this.selectedYear = now.getFullYear();
    this.usingCustomRange = false;
    this.dateFrom = '';
    this.dateTo = '';
    this.searchQuery = '';
    this.activeSource = '';
    this.activeStatus = '';
    this.filterTrigger$.next();
  }

  get activeFilterCount(): number {
    return [
      this.usingCustomRange ? '1' : '',
      this.searchQuery, this.activeSource, this.activeStatus,
    ].filter(Boolean).length;
  }

  /** Drill down from a summary total into a single quotation's payments. */
  drillIntoQuote(quotationNo: string): void {
    this.searchQuery = quotationNo;
    this.filterTrigger$.next();
  }

  // ── Sort ──────────────────────────────────────────────────────────────────

  sortBy(field: keyof RoyaltyRow): void {
    this.sortDir = this.sortField === field ? (this.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    this.sortField = field;
    this.applySort();
    this.cdr.markForCheck();
  }

  sortIcon(field: keyof RoyaltyRow): string {
    if (this.sortField !== field) return '⇅';
    return this.sortDir === 'asc' ? '↑' : '↓';
  }

  private applySort(): void {
    const asc = this.sortDir === 'asc';
    const sf = this.sortField;
    this.rows = [...this.rows].sort((a, b) => {
      const av = a[sf] ?? '';
      const bv = b[sf] ?? '';
      if (typeof av === 'number' && typeof bv === 'number') return asc ? av - bv : bv - av;
      return asc
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
  }

  // ── CSV export ────────────────────────────────────────────────────────────

  exportCSV(): void {
    const headers = [
      'Quotation Number', 'Customer Name', 'Quotation Date', 'Payment Date',
      'Payment Reference', 'Payment Source', 'Payment Amount (INR)',
      'Royalty %', 'Royalty Amount (INR)', 'Payment Status', 'Royalty Status',
    ];
    const csvRows = this.rows.map(r => [
      r.quotationNo, r.customerName, r.quotationDate, r.paymentDate,
      r.paymentReference, r.paymentSource, r.paymentAmount,
      r.royaltyPercent, r.royaltyAmount, this.payLabel(r.paymentStatus), r.royaltyStatus,
    ]);
    const csv = [headers, ...csvRows]
      .map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url, download: `royalty-${this.selectedYear}-${String(this.selectedMonth).padStart(2, '0')}.csv`,
    }).click();
    URL.revokeObjectURL(url);
  }

  // ── Display helpers ───────────────────────────────────────────────────────

  fmtINR(n: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR',
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n ?? 0);
  }

  fmtDateShort(s: string | null): string {
    if (!s) return '—';
    return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  avatarColor(name: string): string {
    return AVATAR_PALETTE[(name?.charCodeAt(0) ?? 0) % AVATAR_PALETTE.length];
  }

  initials(name: string): string {
    return (name || '?').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
  }

  payLabel(status: string): string {
    const map: Record<string, string> = { paid: 'Paid', partially_paid: 'Partial' };
    return map[status] ?? status;
  }

  private showToastMsg(msg: string, type: 'success' | 'error'): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastMsg = msg;
    this.toastType = type;
    this.showToast = true;
    this.cdr.markForCheck();
    this.toastTimer = setTimeout(() => { this.showToast = false; this.cdr.markForCheck(); }, 2400);
  }

  breakdownLabel(status: string): string {
    const map: Record<string, string> = {
      pending: 'Awaiting payment', paid: 'Paid', partially_paid: 'Partially paid',
      failed: 'Failed', refunded: 'Refunded',
    };
    return map[status] ?? status;
  }

  private emptySummary(): RoyaltySummary {
    return {
      quotationsInPeriod: 0, totalPayments: 0, totalEligibleAmount: 0, royaltyPercentage: 0,
      totalRoyaltyPayable: 0, quotationCount: 0, manualCount: 0, razorpayCount: 0,
      scannedQuotations: 0,
    };
  }

  // ── trackBy ───────────────────────────────────────────────────────────────
  trackByRow(_: number, r: RoyaltyRow): string { return `${r.quoteId}-${r.paymentReference}-${r.paymentDate}`; }
  trackByIdx(i: number): number { return i; }
}
