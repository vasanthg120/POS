import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, takeUntil } from 'rxjs';

import {
  SuperAdminService, PaymentRow, PaymentsResponse, TenantLite, Pagination,
} from '../services/super-admin';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

@Component({
  selector: 'app-super-admin-payments',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './super-admin-payments.html',
  styleUrls: ['./super-admin-payments.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SuperAdminPayments implements OnInit, OnDestroy {

  rows: PaymentRow[] = [];
  summary: PaymentsResponse['summary'] = { totalCount: 0, totalCollected: 0, manualCount: 0, razorpayCount: 0 };
  pagination: Pagination = { page: 1, limit: 25, total: 0, pages: 1 };
  tenants: TenantLite[] = [];
  isLoading = true;
  isExporting = false;
  skeletonRows = Array(4);
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
  activeSource = '';
  pageSize = 25;

  readonly sourceOptions = [
    { value: '', label: 'All Sources' },
    { value: 'Manual', label: 'Manual' },
    { value: 'Razorpay', label: 'Razorpay' },
  ];

  sortField: 'paymentDate' | 'paymentAmount' | 'customerName' = 'paymentDate';
  sortDir: 'asc' | 'desc' = 'desc';

  private destroy$ = new Subject<void>();
  private filterTrigger$ = new Subject<void>();

  constructor(private svc: SuperAdminService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    this.filterTrigger$.pipe(debounceTime(250), takeUntil(this.destroy$)).subscribe(() => this.load());
    this.load();
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

    this.svc.getPayments({
      month: this.selectedMonth, year: this.selectedYear,
      tenantId: this.activeTenant, source: this.activeSource,
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
    this.activeSource = '';
    this.filterTrigger$.next();
  }

  get activeFilterCount(): number {
    return [this.searchQuery, this.activeTenant, this.activeSource].filter(Boolean).length;
  }

  goToPage(page: number): void {
    if (page < 1 || page > this.pagination.pages || page === this.pagination.page) return;
    this.pagination = { ...this.pagination, page };
    this.load(false);
  }

  onPageSizeChange(): void { this.load(true); }

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
      const av = this.sortField === 'paymentAmount' ? a.paymentAmount : (this.sortField === 'customerName' ? a.customerName : a.paymentDate);
      const bv = this.sortField === 'paymentAmount' ? b.paymentAmount : (this.sortField === 'customerName' ? b.customerName : b.paymentDate);
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

  exportCSV(): void {
    if (this.isExporting) return;
    this.isExporting = true;
    this.cdr.markForCheck();

    this.svc.getPayments({
      month: this.selectedMonth, year: this.selectedYear,
      tenantId: this.activeTenant, source: this.activeSource,
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

  private downloadCSV(rows: PaymentRow[]): void {
    const headers = [
      'Tenant', 'Quotation Number', 'Customer', 'Email', 'Payment Date', 'Method', 'Amount',
      'Payment Status', 'Source', 'Transaction Reference', 'Refund Status', 'Created By', 'Last Updated',
    ];
    const csvRows = rows.map(r => [
      r.tenantName, r.quotationNo, r.customerName, r.customerEmail, r.paymentDate, r.paymentMethod, r.paymentAmount,
      r.paymentStatus, r.paymentSource, r.transactionReference, r.refundStatus, r.createdBy, r.lastUpdated,
    ]);
    const csv = [headers, ...csvRows]
      .map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url, download: `payments-all-tenants-${this.selectedYear}-${String(this.selectedMonth).padStart(2, '0')}.csv`,
    }).click();
    URL.revokeObjectURL(url);
  }

  trackByIdx(i: number): number { return i; }
  trackByRow(_: number, r: PaymentRow): string { return `${r.tenantId}-${r.quoteId}-${r.transactionReference}-${r.paymentDate}`; }
}
