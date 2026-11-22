import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  DestroyRef,
} from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { interval } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DashboardService, getToken } from '../services/dashboard';

export interface KpiCard {
  id: string;
  label: string;
  value: string;
  sub: string;
  trend: number | null;
  icon: string;
  color: string;
  loading: boolean;
}

export interface ActivityItem {
  id: string;
  type: 'quote' | 'payment' | 'tenant' | 'status';
  title: string;
  sub: string;
  time: string;
  badge: string;
  badgeClass: string;
}

export interface ChartBar {
  label: string;
  value: number;
  pct: number;
}

export interface PieSlice {
  label: string;
  value: number;
  pct: number;
  color: string;
}

export interface TopTenant {
  name: string;
  email: string;
  city: string;
  isActive: boolean;
  setupStep: string;
  rank: number;
  revenue: number;
  payments: number;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, DatePipe, DecimalPipe],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class Dashboard implements OnInit, OnDestroy {

  readonly Math = Math;

  private router     = inject(Router);
  private destroyRef = inject(DestroyRef);
  private svc        = inject(DashboardService);

  readonly loading           = this.svc.loading;
  readonly error             = this.svc.error;
  readonly sessionError      = this.svc.sessionError;
  readonly lastUpdated       = this.svc.lastUpdated;
  readonly kpiCards          = this.svc.kpiCards;
  readonly dailyTrendBars    = this.svc.dailyTrendBars;
  readonly weeklyRevBars     = this.svc.weeklyRevBars;
  readonly methodSlices      = this.svc.methodSlices;
  readonly quoteStatusSlices = this.svc.quoteStatusSlices;
  readonly tenantGrowthBars  = this.svc.tenantGrowthBars;
  readonly recentActivity    = this.svc.recentActivity;
  readonly topTenants        = this.svc.topTenants;
  readonly totalQuotes       = this.svc.totalQuotes;
  readonly totalPayments     = this.svc.totalPayments;
  readonly successPayments   = this.svc.successPayments;
  readonly pendingPayments   = this.svc.pendingPayments;
  readonly failedPayments    = this.svc.failedPayments;
  readonly totalTenants      = this.svc.totalTenants;
  readonly activeTenants     = this.svc.activeTenants;
  readonly conversionRate    = this.svc.conversionRate;
  readonly totalRevPaise     = this.svc.totalRevPaise;
  readonly totalRevRs        = this.svc.totalRevRs;
  readonly totalRefundsRs    = this.svc.totalRefundsRs;
  readonly crmSync           = this.svc.crmSync;
  readonly crmSyncWarning    = this.svc.crmSyncWarning;

  readonly avgTicket         = this.svc.avgTicketPaise;

  readonly totalRevenueRs    = this.svc.totalRevPaise;

  readonly activeTab = signal<'overview' | 'payments' | 'quotes' | 'tenants'>('overview');
  readonly tooltip   = signal<{ x: number; y: number; label: string; value: string } | null>(null);

  ngOnInit(): void {
    if (!getToken()) {
      this.svc.sessionError.set(true);
      this.svc.loading.set(false);
      return;
    }
    this.fetchAll();
    interval(120_000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.fetchAll(true));
  }

  ngOnDestroy(): void {}

  // ── Delegates ─────────────────────────────────────────────────────────────
  fetchAll(silent = false): void {
    this.svc.fetchAll(silent);
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
  setTab(tab: 'overview' | 'payments' | 'quotes' | 'tenants'): void {
    this.activeTab.set(tab);
  }

  onBarHover(ev: MouseEvent, bar: ChartBar, prefix = ''): void {
    this.tooltip.set({
      x: ev.clientX,
      y: ev.clientY - 48,
      label: bar.label,
      value: `${prefix}${this.fmtNum(bar.value)}`,
    });
  }

  clearTooltip(): void {
    this.tooltip.set(null);
  }

  goToLogin(): void {
    this.router.navigate(['/auth/login']);
  }

  refreshNow(): void {
    this.fetchAll();
  }

  // ── Utilities (delegate to service) ──────────────────────────────────────
  fmtNum(n: number): string {
    return this.svc.fmtNum(n);
  }

  pctLabel(n: number | null): string {
    return this.svc.pctLabel(n);
  }

  clamp100(n: number): number {
    return Math.min(100, Math.max(0, n || 0));
  }

  trackById(_: number, item: { id: string }): string {
    return item.id;
  }

  iconPath(id: string): string {
    const p: Record<string, string> = {
      rupee:         'M6 3h12M6 8h12m-7 5 4.5 8M6 13h3.5a4.5 4.5 0 0 0 0-9H6',
      calendar:      'M8 2v3m8-3v3M3 8h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
      'credit-card': 'M2 9h20M2 13h20M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
      doc:           'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 0v6h6M10 13h4M10 17h4M8 9h.01',
      users:         'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
      chart:         'M3 3v18h18M7 16l4-4 4 4 4-4',
      refresh:       'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
      clock:         'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
      zap:           'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
      lock:          'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
      home:          'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
      check:         'M20 6L9 17l-5-5',
      warning:       'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
    };
    return p[id] ?? '';
  }
}
