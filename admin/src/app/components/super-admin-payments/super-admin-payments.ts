import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subject, debounceTime, takeUntil } from 'rxjs';

import {
  SuperAdminService, PaymentRow, PaymentsResponse, TenantLite, Pagination,
} from '../services/super-admin';
import { PeriodPicker } from '../shared/period-picker/period-picker';
import { PERIOD_PRESETS, PeriodPreset, PeriodState, defaultPeriod, periodLabel, periodParams } from '../shared/period';
import { SaDrilldown, DrillRequest } from '../shared/sa-drilldown/sa-drilldown';

@Component({
  selector: 'app-super-admin-payments',
  standalone: true,
  imports: [CommonModule, FormsModule, PeriodPicker, SaDrilldown],
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
  loadError = '';
  skeletonRows = Array(4);
  filtersCollapsed = true;
  tenantErrors: { tenantId: string; tenantName: string; error: string }[] = [];

  // Defaults to "All time" (was the current month only).
  period: PeriodState = defaultPeriod();
  searchQuery = '';
  drill: DrillRequest | null = null;
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

  constructor(private svc: SuperAdminService, private cdr: ChangeDetectorRef, private route: ActivatedRoute) {}

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    const preset = q.get('preset') as PeriodPreset | null;
    if (preset && PERIOD_PRESETS.some(p => p.value === preset)) {
      this.period = { preset, month: Number(q.get('month')) || this.period.month, year: Number(q.get('year')) || this.period.year };
    }
    const source = q.get('source');
    if (source && this.sourceOptions.some(o => o.value === source)) this.activeSource = source;
    this.activeTenant = q.get('tenantId') ?? '';
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
      ...this.filters(),
      page: this.pagination.page, limit: this.pageSize,
      refresh,
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: (res) => {
        this.rows = res.data.rows;
        this.summary = res.data.summary;
        this.pagination = res.data.pagination;
        this.tenantErrors = res.data.tenantErrors;
        this.loadError = '';
        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadError = err?.error?.message || err?.message || 'Could not load payments.';
        this.isLoading = false; this.cdr.markForCheck();
      },
    });
  }

  private filters() {
    return {
      ...periodParams(this.period),
      tenantId: this.activeTenant, source: this.activeSource,
      search: this.searchQuery.trim(),
      sort: this.sortField, dir: this.sortDir,
    };
  }

  get periodText(): string { return periodLabel(this.period); }

  /** KPI cards filter by source; clicking the active one clears it. */
  setSource(source: '' | 'Manual' | 'Razorpay'): void {
    this.activeSource = this.activeSource === source ? '' : source;
    this.load();
  }

  openRow(r: PaymentRow): void {
    this.drill = { kind: 'quote', tenantId: r.tenantId, quoteId: r.quoteId, tenantName: r.tenantName };
    this.cdr.markForCheck();
  }
  closeDrill(): void { this.drill = null; this.cdr.markForCheck(); }

  refresh(): void { this.load(false, true); }

  onPeriodChange(p: PeriodState): void { this.period = p; this.filterTrigger$.next(); }
  applyFiltersDebounced(): void { this.filterTrigger$.next(); }
  toggleFilters(): void { this.filtersCollapsed = !this.filtersCollapsed; }

  resetFilters(): void {
    this.period = defaultPeriod();
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
    this.load();
  }

  sortIcon(field: typeof this.sortField): string {
    if (this.sortField !== field) return '⇅';
    return this.sortDir === 'asc' ? '↑' : '↓';
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

    this.svc.getPayments({ ...this.filters(), page: 1, limit: 5000 }).pipe(takeUntil(this.destroy$)).subscribe({
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
      href: url, download: `payments-all-tenants-${this.periodText.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`,
    }).click();
    URL.revokeObjectURL(url);
  }

  trackByIdx(i: number): number { return i; }
  trackByRow(_: number, r: PaymentRow): string { return `${r.tenantId}-${r.quoteId}-${r.transactionReference}-${r.paymentDate}`; }
}
