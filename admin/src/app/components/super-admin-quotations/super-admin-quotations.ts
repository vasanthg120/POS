import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, takeUntil, forkJoin } from 'rxjs';

import {
  SuperAdminService, QuotationRow, QuotationsSummary, TenantLite, Pagination,
} from '../services/super-admin';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

@Component({
  selector: 'app-super-admin-quotations',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './super-admin-quotations.html',
  styleUrls: ['./super-admin-quotations.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SuperAdminQuotations implements OnInit, OnDestroy {

  rows: QuotationRow[] = [];
  summary: QuotationsSummary = { total: 0, totalAmount: 0, approved: 0, pending: 0, rejectedExpired: 0 };
  pagination: Pagination = { page: 1, limit: 25, total: 0, pages: 1 };
  tenants: TenantLite[] = [];
  isLoading = true;
  isExporting = false;
  skeletonRows = Array(6);
  filtersCollapsed = true;
  tenantErrors: { tenantId: string; tenantName: string; error: string }[] = [];

  readonly monthOptions = MONTH_NAMES.map((label, i) => ({ value: i + 1, label }));
  readonly yearOptions: number[] = (() => {
    const y = new Date().getFullYear();
    return [y - 2, y - 1, y, y + 1];
  })();

  selectedMonth = new Date().getMonth() + 1;
  selectedYear = new Date().getFullYear();
  searchQuery = '';
  activeTenant = '';
  activePaymentStatus = '';
  pageSize = 25;

  readonly paymentStatusOptions = [
    { value: '', label: 'All' },
    { value: 'paid', label: 'Paid' },
    { value: 'partially_paid', label: 'Partial' },
    { value: 'pending', label: 'Pending' },
    { value: 'failed', label: 'Failed' },
  ];

  sortField: 'quotationDate' | 'amount' | 'customerName' = 'quotationDate';
  sortDir: 'asc' | 'desc' = 'desc';

  private destroy$ = new Subject<void>();
  private filterTrigger$ = new Subject<void>();

  constructor(private svc: SuperAdminService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    this.filterTrigger$.pipe(debounceTime(250), takeUntil(this.destroy$)).subscribe(() => this.load());
    this.load();
    // Tenant list is independent of period/filters and rarely changes —
    // fetched once via the lightweight endpoint (no CRM calls), not
    // re-fetched on every filter change like the quotation rows are.
    this.svc.getTenantsLite().pipe(takeUntil(this.destroy$)).subscribe({
      next: (res) => { this.tenants = res.data.tenants; this.cdr.markForCheck(); },
      error: () => {},
    });
  }

  ngOnDestroy(): void { this.destroy$.next(); this.destroy$.complete(); }

  load(resetPage = true, refresh = false): void {
    if (resetPage) this.pagination = { ...this.pagination, page: 1 };
    this.isLoading = true;
    this.cdr.markForCheck();

    this.svc.getQuotations({
      month: this.selectedMonth, year: this.selectedYear,
      tenantId: this.activeTenant, paymentStatus: this.activePaymentStatus,
      search: this.searchQuery.trim(),
      page: this.pagination.page, limit: this.pageSize,
      refresh,
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: (res) => {
        this.rows = res.data.rows;
        this.summary = res.data.summary;
        this.pagination = res.data.pagination;
        this.tenantErrors = res.data.tenantErrors;
        this.isLoading = false;
        this.applySort();
        this.cdr.markForCheck();
      },
      error: () => { this.isLoading = false; this.cdr.markForCheck(); },
    });
  }

  refresh(): void { this.load(false, true); }

  onPeriodChange(): void { this.filterTrigger$.next(); }
  applyFiltersDebounced(): void { this.filterTrigger$.next(); }
  toggleFilters(): void { this.filtersCollapsed = !this.filtersCollapsed; }

  resetFilters(): void {
    const now = new Date();
    this.selectedMonth = now.getMonth() + 1;
    this.selectedYear = now.getFullYear();
    this.searchQuery = '';
    this.activeTenant = '';
    this.activePaymentStatus = '';
    this.filterTrigger$.next();
  }

  get activeFilterCount(): number {
    return [this.searchQuery, this.activeTenant, this.activePaymentStatus].filter(Boolean).length;
  }

  // ── Pagination ──────────────────────────────────────────────────────────
  goToPage(page: number): void {
    if (page < 1 || page > this.pagination.pages || page === this.pagination.page) return;
    this.pagination = { ...this.pagination, page };
    this.load(false);
  }

  onPageSizeChange(): void { this.load(true); }

  // ── Sort (applies within the current page — full-set sort would need a
  // server-side sort param, out of scope for now since rows already arrive
  // newest-first by default) ─────────────────────────────────────────────
  sortBy(field: typeof this.sortField): void {
    this.sortDir = this.sortField === field ? (this.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    this.sortField = field;
    this.applySort();
    this.cdr.markForCheck();
  }

  sortIcon(field: typeof this.sortField): string {
    if (this.sortField !== field) return '⇅';
    return this.sortDir === 'asc' ? '↑' : '↓';
  }

  private applySort(): void {
    const asc = this.sortDir === 'asc';
    this.rows = [...this.rows].sort((a, b) => {
      const av = this.sortField === 'amount' ? a.amount : (this.sortField === 'customerName' ? a.customerName : a.quotationDate);
      const bv = this.sortField === 'amount' ? b.amount : (this.sortField === 'customerName' ? b.customerName : b.quotationDate);
      if (typeof av === 'number' && typeof bv === 'number') return asc ? av - bv : bv - av;
      return asc ? String(av ?? '').localeCompare(String(bv ?? '')) : String(bv ?? '').localeCompare(String(av ?? ''));
    });
  }

  fmtINR(n: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n ?? 0);
  }

  fmtDate(s: string | null): string {
    if (!s) return '—';
    return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  payLabel(status: string): string {
    const map: Record<string, string> = { paid: 'Paid', partially_paid: 'Partial', pending: 'Pending', failed: 'Failed', refunded: 'Refunded' };
    return map[status] ?? status;
  }

  // Exports the *full filtered set*, not just the current page — re-fetches
  // with a high limit rather than exporting `this.rows` (which is one page).
  exportCSV(): void {
    if (this.isExporting) return;
    this.isExporting = true;
    this.cdr.markForCheck();

    this.svc.getQuotations({
      month: this.selectedMonth, year: this.selectedYear,
      tenantId: this.activeTenant, paymentStatus: this.activePaymentStatus,
      search: this.searchQuery.trim(),
      page: 1, limit: 5000,
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: (res) => {
        this.isExporting = false;
        this.downloadCSV(res.data.rows);
        this.cdr.markForCheck();
      },
      error: () => { this.isExporting = false; this.cdr.markForCheck(); },
    });
  }

  private downloadCSV(rows: QuotationRow[]): void {
    const headers = [
      'Tenant', 'Quotation Number', 'Customer', 'Email', 'Quotation Date', 'Amount',
      'Quotation Status', 'Payment Status', 'Paid Amount', 'Created By', 'Related Deal', 'Last Updated',
    ];
    const csvRows = rows.map(r => [
      r.tenantName, r.quotationNo, r.customerName, r.customerEmail, r.quotationDate, r.amount,
      r.quotationStatus, r.paymentStatus, r.paidAmount, r.createdBy, r.relatedDeal, r.lastUpdated,
    ]);
    const csv = [headers, ...csvRows]
      .map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url, download: `quotations-all-tenants-${this.selectedYear}-${String(this.selectedMonth).padStart(2, '0')}.csv`,
    }).click();
    URL.revokeObjectURL(url);
  }

  trackByIdx(i: number): number { return i; }
  trackByRow(_: number, r: QuotationRow): string { return `${r.tenantId}-${r.quoteId}`; }
}
