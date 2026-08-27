import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject, debounceTime, takeUntil } from 'rxjs';

import { SuperAdminService, TenantSnapshot } from '../services/super-admin';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

@Component({
  selector: 'app-super-admin-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
  skeletonRows = Array(8);
  filtersCollapsed = true;

  // ── Filters ───────────────────────────────────────────────────────────────
  readonly monthOptions = MONTH_NAMES.map((label, i) => ({ value: i + 1, label }));
  readonly yearOptions: number[] = (() => {
    const y = new Date().getFullYear();
    return [y - 2, y - 1, y, y + 1];
  })();

  selectedMonth = new Date().getMonth() + 1;
  selectedYear = new Date().getFullYear();
  searchQuery = '';
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
  load(showSpinner = true): void {
    if (showSpinner) { this.isLoading = true; this.cdr.markForCheck(); }
    this.svc.getTenantsOverview({ month: this.selectedMonth, year: this.selectedYear })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.tenants = res.data.tenants;
          this.isLoading = false;
          this.applyFilters();
        },
        error: () => { this.isLoading = false; this.cdr.markForCheck(); },
      });
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  onPeriodChange(): void { this.filterTrigger$.next(); }
  applyFiltersDebounced(): void { this.filterTrigger$.next(); }
  toggleFilters(): void { this.filtersCollapsed = !this.filtersCollapsed; }

  resetFilters(): void {
    const now = new Date();
    this.selectedMonth = now.getMonth() + 1;
    this.selectedYear = now.getFullYear();
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
