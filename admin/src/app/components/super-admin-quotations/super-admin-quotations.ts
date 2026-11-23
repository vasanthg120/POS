import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subject, debounceTime, takeUntil } from 'rxjs';

import {
  SuperAdminService, QuotationRow, QuotationsSummary, TenantLite, Pagination, QuoteOutcome,
} from '../services/super-admin';
import { PeriodPicker } from '../shared/period-picker/period-picker';
import { PERIOD_PRESETS, PeriodPreset, PeriodState, defaultPeriod, periodLabel, periodParams } from '../shared/period';
import { SaDrilldown, DrillRequest } from '../shared/sa-drilldown/sa-drilldown';

type SortField = 'quotationDate' | 'amount' | 'customerName' | 'paidAmount';

@Component({
  selector: 'app-super-admin-quotations',
  standalone: true,
  imports: [CommonModule, FormsModule, PeriodPicker, SaDrilldown],
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
  loadError = '';
  skeletonRows = Array(6);
  filtersCollapsed = true;
  tenantErrors: { tenantId: string; tenantName: string; error: string }[] = [];

  // Defaults to "All time" — the old default (current month) hid every older quotation.
  period: PeriodState = defaultPeriod();
  searchQuery = '';
  activeTenant = '';
  activePaymentStatus = '';
  activeOutcome: QuoteOutcome | '' = '';
  pageSize = 25;

  drill: DrillRequest | null = null;

  readonly paymentStatusOptions = [
    { value: '', label: 'All' },
    { value: 'paid', label: 'Paid' },
    { value: 'partially_paid', label: 'Partial' },
    { value: 'pending', label: 'Pending' },
    { value: 'failed', label: 'Failed' },
  ];

  readonly outcomeOptions: { value: QuoteOutcome | ''; label: string }[] = [
    { value: '', label: 'All' },
    { value: 'approved', label: 'Approved' },
    { value: 'pending', label: 'Pending' },
    { value: 'rejectedOrExpired', label: 'Rejected / Expired' },
  ];

  // Sorted on the server, so the order holds across pages (it used to sort
  // only the 25 rows on screen).
  sortField: SortField = 'quotationDate';
  sortDir: 'asc' | 'desc' = 'desc';

  private destroy$ = new Subject<void>();
  private filterTrigger$ = new Subject<void>();

  constructor(
    private svc: SuperAdminService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
  ) {}

  ngOnInit(): void {
    this.applyQueryParams();
    this.filterTrigger$.pipe(debounceTime(250), takeUntil(this.destroy$)).subscribe(() => this.load());
    this.load();
    // Tenant list is independent of period/filters — fetched once (no CRM calls).
    this.svc.getTenantsLite().pipe(takeUntil(this.destroy$)).subscribe({
      next: (res) => { this.tenants = res.data.tenants; this.cdr.markForCheck(); },
      error: () => {},
    });
  }

  ngOnDestroy(): void { this.destroy$.next(); this.destroy$.complete(); }

  /** Lets the dashboard's drill-down "Open in Quotations" land on the same slice. */
  private applyQueryParams(): void {
    const q = this.route.snapshot.queryParamMap;
    const preset = q.get('preset') as PeriodPreset | null;
    if (preset && PERIOD_PRESETS.some(p => p.value === preset)) {
      this.period = {
        preset,
        month: Number(q.get('month')) || this.period.month,
        year: Number(q.get('year')) || this.period.year,
      };
    }
    const outcome = q.get('outcome');
    if (outcome && this.outcomeOptions.some(o => o.value === outcome)) this.activeOutcome = outcome as QuoteOutcome;
    const pay = q.get('paymentStatus');
    if (pay && this.paymentStatusOptions.some(o => o.value === pay)) this.activePaymentStatus = pay;
    this.activeTenant = q.get('tenantId') ?? '';
    this.searchQuery = q.get('search') ?? '';
    if (this.activeOutcome || this.activePaymentStatus || this.activeTenant || this.searchQuery) this.filtersCollapsed = false;
  }

  private filters() {
    return {
      ...periodParams(this.period),
      tenantId: this.activeTenant,
      paymentStatus: this.activePaymentStatus,
      outcome: this.activeOutcome,
      search: this.searchQuery.trim(),
      sort: this.sortField,
      dir: this.sortDir,
    };
  }

  load(resetPage = true, refresh = false): void {
    if (resetPage) this.pagination = { ...this.pagination, page: 1 };
    this.isLoading = true;
    this.cdr.markForCheck();

    this.svc.getQuotations({ ...this.filters(), page: this.pagination.page, limit: this.pageSize, refresh })
      .pipe(takeUntil(this.destroy$)).subscribe({
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
          this.loadError = err?.error?.message || err?.message || 'Could not load quotations.';
          this.isLoading = false;
          this.cdr.markForCheck();
        },
      });
  }

  refresh(): void { this.load(false, true); }

  get periodText(): string { return periodLabel(this.period); }

  onPeriodChange(p: PeriodState): void { this.period = p; this.filterTrigger$.next(); }
  applyFiltersDebounced(): void { this.filterTrigger$.next(); }
  toggleFilters(): void { this.filtersCollapsed = !this.filtersCollapsed; }

  /** KPI cards act as segment filters; clicking the active one clears it. */
  setOutcome(o: QuoteOutcome | ''): void {
    this.activeOutcome = this.activeOutcome === o ? '' : o;
    this.load();
  }

  resetFilters(): void {
    this.period = defaultPeriod();
    this.searchQuery = '';
    this.activeTenant = '';
    this.activePaymentStatus = '';
    this.activeOutcome = '';
    this.filterTrigger$.next();
  }

  get activeFilterCount(): number {
    return [this.searchQuery, this.activeTenant, this.activePaymentStatus, this.activeOutcome].filter(Boolean).length;
  }

  // ── Detail drawer ─────────────────────────────────────────────────────────
  openRow(r: QuotationRow): void {
    this.drill = { kind: 'quote', tenantId: r.tenantId, quoteId: r.quoteId, tenantName: r.tenantName };
    this.cdr.markForCheck();
  }
  closeDrill(): void { this.drill = null; this.cdr.markForCheck(); }

  // ── Pagination ────────────────────────────────────────────────────────────
  goToPage(page: number): void {
    if (page < 1 || page > this.pagination.pages || page === this.pagination.page) return;
    this.pagination = { ...this.pagination, page };
    this.load(false);
  }

  onPageSizeChange(): void { this.load(true); }

  // ── Sort ──────────────────────────────────────────────────────────────────
  sortBy(field: SortField): void {
    this.sortDir = this.sortField === field ? (this.sortDir === 'asc' ? 'desc' : 'asc') : (field === 'customerName' ? 'asc' : 'desc');
    this.sortField = field;
    this.load();
  }

  sortIcon(field: SortField): string {
    if (this.sortField !== field) return '⇅';
    return this.sortDir === 'asc' ? '↑' : '↓';
  }

  // ── Display ───────────────────────────────────────────────────────────────
  fmtINR(n: number | undefined | null): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n ?? 0);
  }

  fmtDate(s: string | null | undefined): string {
    if (!s) return '—';
    return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  payLabel(status: string): string {
    const map: Record<string, string> = { paid: 'Paid', partially_paid: 'Partial', pending: 'Pending', failed: 'Failed', refunded: 'Refunded' };
    return map[status] ?? status;
  }

  outcomeLabel(o?: string): string {
    return ({ approved: 'Approved', pending: 'Pending', rejectedOrExpired: 'Rejected / Expired' } as Record<string, string>)[o ?? ''] ?? '—';
  }

  // Exports the full filtered set, not just the current page.
  exportCSV(): void {
    if (this.isExporting) return;
    this.isExporting = true;
    this.cdr.markForCheck();

    this.svc.getQuotations({ ...this.filters(), page: 1, limit: 5000 }).pipe(takeUntil(this.destroy$)).subscribe({
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
      'Tenant', 'Quotation Number', 'Deal', 'Customer', 'Company', 'Email', 'Phone', 'Quotation Date', 'Expiry Date',
      'Amount', 'Paid Amount', 'Balance Due', 'Outcome', 'Client Approval', 'Stage', 'Payment Status',
      'Created By', 'Last Updated',
    ];
    const csvRows = rows.map(r => [
      r.tenantName, r.quotationNo, r.relatedDeal, r.customerName, r.companyName, r.customerEmail, r.customerPhone,
      r.quotationDate, r.expiryDate, r.amount, r.paidAmount, r.balanceDue, this.outcomeLabel(r.outcome),
      r.approvalStatus, r.quotationStatus, r.paymentStatus, r.createdBy, r.lastUpdated,
    ]);
    const csv = [headers, ...csvRows]
      .map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const slug = this.periodText.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    Object.assign(document.createElement('a'), { href: url, download: `quotations-all-tenants-${slug}.csv` }).click();
    URL.revokeObjectURL(url);
  }

  trackByIdx(i: number): number { return i; }
  trackByRow(_: number, r: QuotationRow): string { return `${r.tenantId}-${r.quoteId}`; }
}
