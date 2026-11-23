import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject, debounceTime, takeUntil } from 'rxjs';

import { SuperAdminService, TenantSnapshot, QuotationRow, QuotationsFilters } from '../services/super-admin';
import { PeriodPicker } from '../shared/period-picker/period-picker';
import { PeriodState, defaultPeriod, periodLabel, periodParams } from '../shared/period';
import { SaDrilldown, DrillRequest } from '../shared/sa-drilldown/sa-drilldown';

/** Dashboard KPI -> the records behind it. */
export type DashKpi =
  | 'tenants' | 'quotations' | 'pendingQuotes' | 'approvedQuotes' | 'rejectedQuotes'
  | 'invoiced' | 'collected' | 'pendingPayments' | 'failedPayments' | 'royalty'
  | 'crm' | 'razorpay';

@Component({
  selector: 'app-super-admin-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, PeriodPicker, SaDrilldown],
  templateUrl: './super-admin-dashboard.html',
  styleUrls: ['./super-admin-dashboard.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SuperAdminDashboard implements OnInit, OnDestroy {

  // ── Data ──────────────────────────────────────────────────────────────────
  tenants: TenantSnapshot[] = [];
  filtered: TenantSnapshot[] = [];

  // ── UI state ──────────────────────────────────────────────────────────────
  isLoading = true;
  loadError: string | null = null;
  skeletonRows = Array(8);
  filtersCollapsed = true;

  // ── Filters ───────────────────────────────────────────────────────────────
  // Defaults to "All time": it used to default to the current month, so only
  // the quotations created this month (11 of 108) were ever counted.
  period: PeriodState = defaultPeriod();
  searchQuery = '';

  // ── Drill-down + recent quotations ────────────────────────────────────────
  drill: DrillRequest | null = null;
  recent: QuotationRow[] = [];
  recentLoading = true;
  recentError = '';
  activeStatus: '' | 'active' | 'inactive' = '';
  activeIntegration: '' | 'crm-missing' | 'razorpay-missing' | 'sync-error' = '';

  readonly statusOptions = [
    { value: '', label: 'All Tenants' },
    { value: 'active', label: 'Active' },
    { value: 'inactive', label: 'Inactive' },
  ];

  readonly integrationOptions = [
    { value: '', label: 'All Integrations' },
    { value: 'crm-missing', label: 'CRM Not Connected' },
    { value: 'razorpay-missing', label: 'Razorpay Not Connected' },
    { value: 'sync-error', label: 'Sync Errors' },
  ];

  // ── Sort ──────────────────────────────────────────────────────────────────
  sortField: 'businessName' | 'invoicedAmount' | 'collected' | 'royalty' = 'collected';
  sortDir: 'asc' | 'desc' = 'desc';

  private destroy$ = new Subject<void>();
  private filterTrigger$ = new Subject<void>();

  constructor(
    private svc: SuperAdminService,
    private cdr: ChangeDetectorRef,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.filterTrigger$
      .pipe(debounceTime(250), takeUntil(this.destroy$))
      .subscribe(() => this.load());
    this.load();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── Data loading ───────────────────────────────────────────────────────────
  load(showSpinner = true, refresh = false): void {
    if (showSpinner) { this.isLoading = true; this.cdr.markForCheck(); }
    this.loadRecent(refresh);
    this.svc.getTenantsOverview({ ...periodParams(this.period), refresh })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.tenants = res.data.tenants;
          this.loadError = null;
          this.isLoading = false;
          this.applyFilters();
        },
        // Was silently swallowed, leaving "No tenants onboarded yet" on screen.
        error: (err) => {
          this.loadError = err?.error?.message || err?.message || 'Could not load the dashboard.';
          this.isLoading = false;
          this.cdr.markForCheck();
        },
      });
  }

  private loadRecent(refresh = false): void {
    this.recentLoading = true; this.recentError = '';
    this.svc.getQuotations({ ...periodParams(this.period), sort: 'quotationDate', dir: 'desc', page: 1, limit: 8, refresh })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => { this.recent = res.data.rows; this.recentLoading = false; this.cdr.markForCheck(); },
        error: (err) => {
          this.recentError = err?.error?.message || 'Could not load recent quotations.';
          this.recentLoading = false; this.cdr.markForCheck();
        },
      });
  }

  refresh(): void { this.load(true, true); }

  // ── Filters ───────────────────────────────────────────────────────────────
  onPeriodChange(p: PeriodState): void { this.period = p; this.filterTrigger$.next(); }
  get periodText(): string { return periodLabel(this.period); }
  applyFiltersDebounced(): void { this.filterTrigger$.next(); }
  toggleFilters(): void { this.filtersCollapsed = !this.filtersCollapsed; }

  resetFilters(): void {
    this.period = defaultPeriod();
    this.searchQuery = '';
    this.activeStatus = '';
    this.activeIntegration = '';
    this.filterTrigger$.next();
  }

  get activeFilterCount(): number {
    return [this.searchQuery, this.activeStatus, this.activeIntegration].filter(Boolean).length;
  }

  applyFilters(): void {
    const q = this.searchQuery.trim().toLowerCase();
    let list = this.tenants.filter(t => {
      const matchSearch = !q
        || t.businessName.toLowerCase().includes(q)
        || t.ownerName.toLowerCase().includes(q)
        || t.email.toLowerCase().includes(q)
        || t.city.toLowerCase().includes(q)
        || t.tenantId.toLowerCase().includes(q);

      const matchStatus = !this.activeStatus
        || (this.activeStatus === 'active' ? t.isActive : !t.isActive);

      const matchIntegration = !this.activeIntegration
        || (this.activeIntegration === 'crm-missing' && !t.crm.isConfigured)
        || (this.activeIntegration === 'razorpay-missing' && !t.razorpay.isConfigured)
        || (this.activeIntegration === 'sync-error' && t.syncStatus === 'error');

      return matchSearch && matchStatus && matchIntegration;
    });

    const asc = this.sortDir === 'asc';
    list = [...list].sort((a, b) => {
      const av = this.sortValue(a);
      const bv = this.sortValue(b);
      if (typeof av === 'number' && typeof bv === 'number') return asc ? av - bv : bv - av;
      return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });

    this.filtered = list;
    this.cdr.markForCheck();
  }

  sortBy(field: typeof this.sortField): void {
    this.sortDir = this.sortField === field ? (this.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    this.sortField = field;
    this.applyFilters();
  }

  sortIcon(field: typeof this.sortField): string {
    if (this.sortField !== field) return '⇅';
    return this.sortDir === 'asc' ? '↑' : '↓';
  }

  private sortValue(t: TenantSnapshot): string | number {
    switch (this.sortField) {
      case 'businessName': return t.businessName || t.ownerName;
      case 'invoicedAmount': return t.invoicedAmount;
      case 'collected': return t.payments.totalCollected;
      case 'royalty': return t.royalty.totalPayable;
    }
  }

  // ── KPIs — computed from the currently filtered set, so every card and the
  // table respect the same filters (period + search + status + integration).
  get kpi() {
    const list = this.filtered;
    const sum = (fn: (t: TenantSnapshot) => number) => list.reduce((s, t) => s + fn(t), 0);
    return {
      totalTenants: list.length,
      activeTenants: list.filter(t => t.isActive).length,
      inactiveTenants: list.filter(t => !t.isActive).length,
      totalQuotations: sum(t => t.quotations.total),
      pendingQuotations: sum(t => t.quotations.pending),
      approvedQuotations: sum(t => t.quotations.approved),
      rejectedExpiredQuotations: sum(t => t.quotations.rejectedOrExpired),
      totalInvoiced: sum(t => t.invoicedAmount),
      totalCollected: sum(t => t.payments.totalCollected),
      pendingAmount: sum(t => t.payments.pendingAmount),
      failedPayments: sum(t => t.payments.failedCount),
      totalRoyalty: sum(t => t.royalty.totalPayable),
      crmConnected: list.filter(t => t.crm.isConfigured).length,
      razorpayConnected: list.filter(t => t.razorpay.isConfigured).length,
    };
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  openTenant(t: TenantSnapshot): void {
    this.router.navigate(['/admin/tenants', t.tenantId]);
  }

  /** Query params that carry the current period to a full list page. */
  private periodQuery(): Record<string, string | number> {
    const q: Record<string, string | number> = { preset: this.period.preset };
    if (this.period.preset === 'month') { q['month'] = this.period.month; q['year'] = this.period.year; }
    return q;
  }

  /**
   * Opens the drawer with the records behind a KPI card. Tenant-scoped
   * filters (search / status / integration) only narrow tenant lists; the
   * quotation and payment lists cover every monitored tenant for the period,
   * matching how the totals are summed.
   */
  openKpi(kpi: DashKpi): void {
    const p = periodParams(this.period);
    const sub = `${this.periodText} · all tenants`;
    const quotes = (title: string, extra: QuotationsFilters, query: Record<string, string> = {}): DrillRequest => ({
      kind: 'quotes', title, subtitle: sub, filters: { ...p, ...extra },
      fullView: { label: 'Open in Quotations', path: '/admin/quotations', queryParams: { ...this.periodQuery(), ...query } },
    });
    const payments = (title: string): DrillRequest => ({
      kind: 'payments', title, subtitle: sub, filters: { ...p },
      fullView: { label: 'Open in Payments', path: '/admin/payments', queryParams: this.periodQuery() },
    });
    const tenants = (title: string, list: TenantSnapshot[]): DrillRequest => ({
      kind: 'tenants', title, subtitle: `${list.length} tenant${list.length === 1 ? '' : 's'}`, tenants: list,
      fullView: { label: 'Manage tenants', path: '/admin/tenants' },
    });

    const map: Record<DashKpi, () => DrillRequest> = {
      tenants:         () => tenants('All tenants', this.filtered),
      crm:             () => tenants('CRM connection status', [...this.filtered].sort((a, b) => Number(a.crm.isConfigured) - Number(b.crm.isConfigured))),
      razorpay:        () => tenants('Razorpay connection status', [...this.filtered].sort((a, b) => Number(a.razorpay.isConfigured) - Number(b.razorpay.isConfigured))),
      quotations:      () => quotes('All quotations', {}),
      invoiced:        () => quotes('Invoiced amount: quotations', {}),
      pendingQuotes:   () => quotes('Pending quotations', { outcome: 'pending' }, { outcome: 'pending' }),
      approvedQuotes:  () => quotes('Approved quotations', { outcome: 'approved' }, { outcome: 'approved' }),
      rejectedQuotes:  () => quotes('Rejected / expired quotations', { outcome: 'rejectedOrExpired' }, { outcome: 'rejectedOrExpired' }),
      pendingPayments: () => quotes('Payment pending', { paymentStatus: 'pending' }, { paymentStatus: 'pending' }),
      failedPayments:  () => quotes('Failed / lost payments', { paymentStatus: 'failed' }, { paymentStatus: 'failed' }),
      collected:       () => payments('Payments received'),
      royalty:         () => payments('Payments that earn royalty'),
    };
    this.drill = map[kpi]();
    this.cdr.markForCheck();
  }

  openQuote(r: QuotationRow): void {
    this.drill = { kind: 'quote', tenantId: r.tenantId, quoteId: r.quoteId, tenantName: r.tenantName };
    this.cdr.markForCheck();
  }

  closeDrill(): void { this.drill = null; this.cdr.markForCheck(); }

  get outcomeSplit(): { key: string; label: string; count: number; pct: number }[] {
    const k = this.kpi;
    const total = Math.max(1, k.totalQuotations);
    return [
      { key: 'approved', label: 'Approved', count: k.approvedQuotations },
      { key: 'pending', label: 'Pending', count: k.pendingQuotations },
      { key: 'rejectedOrExpired', label: 'Rejected / expired', count: k.rejectedExpiredQuotations },
    ].map(x => ({ ...x, pct: Math.round((x.count / total) * 1000) / 10 }));
  }

  get collectionRate(): number {
    const k = this.kpi;
    return k.totalInvoiced > 0 ? Math.round((k.totalCollected / k.totalInvoiced) * 100) : 0;
  }

  fmtDate(s: string | null): string {
    if (!s) return '—';
    return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  payLabel(s: string): string {
    return ({ paid: 'Paid', partially_paid: 'Partial', pending: 'Pending', failed: 'Failed', refunded: 'Refunded' } as Record<string, string>)[s] ?? s;
  }

  trackByRow(_: number, r: QuotationRow): string { return `${r.tenantId}-${r.quoteId}`; }

  // ── Display helpers ───────────────────────────────────────────────────────
  fmtINR(n: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR',
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n ?? 0);
  }

  initials(name: string): string {
    return (name || '?').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
  }

  private readonly AVATAR_PALETTE = [
    '#1d4ed8', '#0891b2', '#059669', '#7c3aed',
    '#d97706', '#dc2626', '#0284c7', '#9333ea',
  ];
  avatarColor(name: string): string {
    return this.AVATAR_PALETTE[(name?.charCodeAt(0) ?? 0) % this.AVATAR_PALETTE.length];
  }

  syncLabel(t: TenantSnapshot): string {
    if (t.syncStatus === 'not_configured') return 'CRM not connected';
    if (t.syncStatus === 'error') return t.syncError || 'Sync failed';
    return 'Synced';
  }

  trackByIdx(i: number): number { return i; }
  trackByTenant(_: number, t: TenantSnapshot): string { return t.id; }
}
