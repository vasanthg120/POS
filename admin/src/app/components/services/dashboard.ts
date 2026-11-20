// dashboard.service.ts  —  Fixed: all data sourced from /tenant/quotes
// (same source as the tracking component), so amounts and analytics are consistent.
import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient, HttpHeaders, HttpErrorResponse } from '@angular/common/http';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  KpiCard,
  ActivityItem,
  ChartBar,
  PieSlice,
  TopTenant,
} from '../dashboard/dashboard';
import { Environment } from '../environment/environment';

// ── Token helpers (unchanged) ────────────────────────────────────────────────
const TOKEN_KEYS = ['pos_token', 'accessToken', 'pos_access_token', 'token', 'auth_token', 'jwt'];

export function getToken(): string {
  for (const key of TOKEN_KEYS) {
    const v = sessionStorage.getItem(key) ?? localStorage.getItem(key) ?? '';
    if (v) return v;
  }
  return '';
}

export function authOpts(): { headers: HttpHeaders } {
  return {
    headers: new HttpHeaders({
      Authorization : `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
    }),
  };
}

// ── Colour palettes (from design token names, not hex) ───────────────────────
// These are used inline in chart slices. Kept as hex here because they are
// dynamic CSS values set via [style.background], not static class names.
const STATUS_COLORS: Record<string, string> = {
  // Payment statuses
  paid:            '#16a34a',
  pending:         '#d97706',
  failed:          '#dc2626',
  partially_paid:  '#4f46e5',
  refunded:        '#0ea5e9',
  // Quotation stages
  created:          '#0ea5e9',
  'in progress':    '#4f46e5',
  processing:       '#0284c7',
  'awaiting payment': '#d97706',
  'payment completed': '#16a34a',
  delivered:        '#0891b2',
  closed:           '#94a3b8',
  cancelled:        '#dc2626',
};

const METHOD_COLORS: Record<string, string> = {
  UPI:            '#4f46e5',
  Card:           '#0ea5e9',
  'Net Banking':  '#1e40af',
  Cash:           '#16a34a',
  'Bank Transfer':'#0284c7',
  NEFT:           '#0891b2',
  RTGS:           '#0f766e',
  IMPS:           '#7c3aed',
  Cheque:         '#d97706',
  Wallet:         '#f59e0b',
  EMI:            '#dc2626',
};

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private http         = inject(HttpClient);
  private readonly api = `${Environment.API_URL}`;

  // ── State signals ────────────────────────────────────────────────────────────
  loading      = signal(true);
  error        = signal<string | null>(null);
  sessionError = signal(false);
  lastUpdated  = signal<Date>(new Date());

  // ── KPI signals (all in rupees, not paise) ───────────────────────────────────
  totalQuotes       = signal(0);
  totalPayments     = signal(0);   // = number of quotes with a non-pending payment status
  successPayments   = signal(0);   // paid count
  pendingPayments   = signal(0);   // pending count
  totalRevPaise     = signal(0);   // kept for API compat; stores rupees * 100 equivalent
  monthRevPaise     = signal(0);
  todayRevPaise     = signal(0);
  totalRefundsPaise = signal(0);
  avgTicketPaise    = signal(0);
  momGrowth         = signal<number | null>(null);
  totalTenants      = signal(0);
  activeTenants     = signal(0);
  approvedQuotes    = signal(0);   // client-approved in the CRM

  // ── CRM sync health (from /tenant/quotes `sync`) ─────────────────────────────
  crmSync = signal<any>(null);
  crmSyncWarning = computed(() => {
    const s = this.crmSync();
    if (!s || s.lastStatus !== 'error') return null;
    const when = s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleString() : 'never';
    return `Latest CRM sync failed: ${s.lastError ?? 'unknown error'} — showing data last synced ${when}.`;
  });

  // ── Chart data ───────────────────────────────────────────────────────────────
  dailyTrendBars    = signal<ChartBar[]>([]);
  weeklyRevBars     = signal<ChartBar[]>([]);
  methodSlices      = signal<PieSlice[]>([]);
  quoteStatusSlices = signal<PieSlice[]>([]);
  tenantGrowthBars  = signal<ChartBar[]>([]);

  // ── Feed & table ─────────────────────────────────────────────────────────────
  recentActivity = signal<ActivityItem[]>([]);
  topTenants     = signal<TopTenant[]>([]);

  // ── Computed helpers ─────────────────────────────────────────────────────────
  failedPayments = computed(() =>
    Math.max(0, this.totalPayments() - this.successPayments() - this.pendingPayments())
  );

  conversionRate = computed(() => {
    const t = this.totalQuotes();
    const s = this.successPayments();
    return t > 0 ? Math.round((s / t) * 100) : 0;
  });

  // These computed signals return rupees (the raw signals now store rupees * 100
  // so the dashboard template's /100 division stays compatible).
  totalRevRs     = computed(() => this.totalRevPaise()     / 100);
  monthRevRs     = computed(() => this.monthRevPaise()     / 100);
  todayRevRs     = computed(() => this.todayRevPaise()     / 100);
  totalRefundsRs = computed(() => this.totalRefundsPaise() / 100);
  avgTicketRs    = computed(() => this.avgTicketPaise()    / 100);

  refundPct = computed(() => {
    const rev = this.totalRevPaise();
    const ref = this.totalRefundsPaise();
    return rev > 0 ? Math.min(100, Math.max(0, Math.round((ref / rev) * 100))) : 0;
  });

  capturedFunnelPct = computed(() => {
    const t = this.totalPayments();
    return t > 0
      ? Math.min(100, Math.max(0, Math.round((this.successPayments() / t) * 100)))
      : 0;
  });

  kpiCards = computed<KpiCard[]>(() => [
    {
      id:      'revenue',
      label:   'Total Revenue',
      value:   String(this.totalRevPaise()),
      sub:     `${this.pctLabel(this.momGrowth())} vs last month`,
      trend:   this.momGrowth(),
      icon:    'rupee',
      color:   'sky',
      loading: this.loading(),
    },
    {
      id:      'month-rev',
      label:   'This Month',
      value:   String(this.monthRevPaise()),
      sub:     `Today: ₹${this.fmtNum(this.todayRevRs())}`,
      trend:   null,
      icon:    'calendar',
      color:   'blue',
      loading: this.loading(),
    },
    {
      id:      'payments',
      label:   'Total Payments',
      value:   String(this.totalPayments()),
      sub:     `${this.successPayments()} paid · ${this.failedPayments()} failed`,
      trend:   null,
      icon:    'credit-card',
      color:   'success',
      loading: this.loading(),
    },
    {
      id:      'quotes',
      label:   'Quotations',
      value:   String(this.totalQuotes()),
      sub:     `${this.approvedQuotes()} approved · ${this.conversionRate()}% converted`,
      trend:   null,
      icon:    'doc',
      color:   'indigo',
      loading: this.loading(),
    },
    {
      id:      'tenants',
      label:   'Active Tenants',
      value:   String(this.activeTenants()),
      sub:     `${this.totalTenants()} total registered`,
      trend:   null,
      icon:    'users',
      color:   'warning',
      loading: this.loading(),
    },
    {
      id:      'avg',
      label:   'Avg. Ticket',
      value:   String(this.avgTicketPaise()),
      sub:     `Refunded: ₹${this.fmtNum(this.totalRefundsRs())}`,
      trend:   null,
      icon:    'chart',
      color:   'muted',
      loading: this.loading(),
    },
  ]);

  // ── Fetch orchestration ──────────────────────────────────────────────────────
  fetchAll(silent = false): void {
    if (!silent) this.loading.set(true);
    this.error.set(null);
    this.sessionError.set(false);

    const h = authOpts();

    // Primary source: quotes (same as tracking component)
    // This already includes merged QuoteTracking data (paymentStatus, paidAmount, method, etc.)
    const quotes$ = this.http
      .get<any>(`${this.api}/tenant/quotes`, h)
      .pipe(catchError((e) => this.onError(e)));

    // Stats endpoint (pre-aggregated, rupees, from the server controller)
    const stats$ = this.http
      .get<any>(`${this.api}/tenant/quotes/stats`, h)
      .pipe(catchError(() => of(null)));

    // Razorpay statements summary (for daily revenue trend chart only)
    const stmtSummary$ = this.http
      .get<any>(`${this.api}/tenant/statements/summary`, h)
      .pipe(catchError(() => of(null)));

    // Admin tenants (superadmin only, 403 expected for normal users)
    const adminTenants$ = this.http
      .get<any>(`${this.api}/api/admin/tenants?limit=100`, h)
      .pipe(catchError(() => of(null)));

    forkJoin({ quotes: quotes$, stats: stats$, stmtSummary: stmtSummary$, adminTenants: adminTenants$ })
      .subscribe({
        next: ({ quotes, stats, stmtSummary, adminTenants }) => {
          // ── 1. Parse quotes array (same shape as tracking component) ──────────
          const quotesArr: any[] =
            quotes?.data?.quotes ??
            quotes?.data?.data   ??
            quotes?.quotes       ??
            (Array.isArray(quotes?.data) ? quotes.data : []);

          this.crmSync.set(quotes?.data?.sync ?? stats?.data?.sync ?? null);

          // ── 2. Ingest pre-aggregated stats (amounts already in rupees) ────────
          this.ingestStats(stats?.data ?? null, quotesArr);

          // ── 3. Ingest quote-level data for charts ─────────────────────────────
          this.ingestQuotes(quotesArr);

          // ── 4. Daily trend from statements (paise → rupees) ───────────────────
          this.ingestDailyTrend(stmtSummary?.data ?? stmtSummary);

          // ── 5. Tenants ────────────────────────────────────────────────────────
          const tenantsArr: any[] =
            adminTenants?.data    ??
            adminTenants?.tenants ??
            (Array.isArray(adminTenants) ? adminTenants : []);
          this.ingestTenants(tenantsArr, quotesArr);

          // ── 6. Activity feed ──────────────────────────────────────────────────
          this.buildActivity(quotesArr, tenantsArr);

          this.loading.set(false);
          this.lastUpdated.set(new Date());
        },
        error: () => {
          this.error.set('Unexpected error. Please try again.');
          this.loading.set(false);
        },
      });
  }

  // ── Error handler ────────────────────────────────────────────────────────────
  // Every non-auth failure (CRM not configured, CRM rejected the key, CRM
  // down, missing permission) used to be swallowed here, so the dashboard
  // silently showed zeros. Show the server's message instead.
  private onError(err: HttpErrorResponse | any) {
    if (err?.status === 401) {
      this.sessionError.set(true);
    } else if (err?.status === 0) {
      this.error.set('Cannot reach the POS server. Check your connection and try again.');
    } else {
      this.error.set(err?.error?.message || `Could not load CRM data (HTTP ${err?.status ?? 'error'}).`);
    }
    return of(null);
  }

  // ── Ingest stats (server-computed, rupees) ───────────────────────────────────
  // Falls back to client-side computation from quotesArr if stats endpoint is unavailable.
  ingestStats(stats: any, quotes: any[]): void {
    if (stats && typeof stats.total === 'number') {
      // Server gave us pre-aggregated stats — amounts already in rupees
      this.totalQuotes.set(stats.total ?? 0);
      this.successPayments.set(stats.paidCount ?? 0);
      this.pendingPayments.set(stats.pendingCount ?? 0);
      // Store as rupees * 100 so the template's /100 division yields correct rupees
      this.totalRevPaise.set((stats.totalRevenue   ?? 0) * 100);
      // "This Month" used to show all-time revenue here. The server now
      // returns month/today revenue by payment date; fall back to the
      // client-side figures if talking to an older backend.
      const local = this.periodRevenueFromQuotes(quotes);
      this.monthRevPaise.set(Math.round((stats.monthRevenue ?? local.month) * 100));
      this.todayRevPaise.set(Math.round((stats.todayRevenue ?? local.today) * 100));
      this.approvedQuotes.set(stats.approvedCount ?? quotes.filter((q: any) => q.approvalStatus === 'approved').length);
      this.totalRefundsPaise.set(0);
      this.avgTicketPaise.set((stats.avgDealSize   ?? 0) * 100);
      this.totalPayments.set(
        (stats.paidCount ?? 0) + (stats.pendingCount ?? 0) +
        (stats.failedCount ?? 0) + (stats.partialCount ?? 0)
      );
      this.momGrowth.set(null);
      return;
    }

    // Fallback: compute from quotes array (amounts already in rupees per the tracking controller)
    let totalRev   = 0;
    let paidCount  = 0;
    let pendCount  = 0;
    let failCount  = 0;
    let partCount  = 0;
    let totalPay   = 0;

    const now       = new Date();
    const thisMonth = now.getMonth();
    const thisYear  = now.getFullYear();
    const today     = now.toISOString().slice(0, 10);
    let monthRev    = 0;
    let todayRev    = 0;

    for (const q of quotes) {
      const status = q.paymentStatus ?? 'pending';
      const paid   = q.paidAmount    ?? 0;
      const amount = q.amount        ?? 0;
      const paidAt = q.paidAt        ?? q.createdAt ?? '';

      if (status === 'paid') {
        paidCount++;
        totalRev += paid || amount;
        const d = new Date(paidAt);
        if (d.getFullYear() === thisYear && d.getMonth() === thisMonth) {
          monthRev += paid || amount;
        }
        if (paidAt?.slice(0, 10) === today) todayRev += paid || amount;
      } else if (status === 'partially_paid') {
        partCount++;
        totalRev += paid;
        const d = new Date(paidAt);
        if (d.getFullYear() === thisYear && d.getMonth() === thisMonth) {
          monthRev += paid;
        }
      } else if (status === 'failed') {
        failCount++;
      } else {
        pendCount++;
      }
      totalPay++;
    }

    const avgDeal = quotes.length > 0
      ? quotes.reduce((s: number, q: any) => s + (q.amount ?? 0), 0) / quotes.length
      : 0;

    this.totalQuotes.set(quotes.length);
    this.successPayments.set(paidCount);
    this.pendingPayments.set(pendCount);
    this.totalPayments.set(totalPay);
    // Multiply by 100 so template's /100 yields the correct rupee value
    this.totalRevPaise.set(Math.round(totalRev   * 100));
    this.monthRevPaise.set(Math.round(monthRev   * 100));
    this.todayRevPaise.set(Math.round(todayRev   * 100));
    this.avgTicketPaise.set(Math.round(avgDeal   * 100));
    this.totalRefundsPaise.set(0);
    this.momGrowth.set(null);
    this.approvedQuotes.set(quotes.filter((q: any) => q.approvalStatus === 'approved').length);
  }

  /** Month-to-date and today's collected revenue (rupees), by payment date. */
  private periodRevenueFromQuotes(quotes: any[]): { month: number; today: number } {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    let month = 0;
    let todayRev = 0;
    for (const q of quotes ?? []) {
      if (q.paymentStatus !== 'paid' && q.paymentStatus !== 'partially_paid') continue;
      const amt = q.paymentStatus === 'paid' ? (q.paidAmount || q.amount || 0) : (q.paidAmount || 0);
      const paidAt = q.paidAt ?? '';
      const d = new Date(paidAt);
      if (!paidAt || isNaN(d.getTime())) continue;
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) month += amt;
      if (String(paidAt).slice(0, 10) === today) todayRev += amt;
    }
    return { month, today: todayRev };
  }

  // ── Ingest quotes → charts ───────────────────────────────────────────────────
  ingestQuotes(quotes: any[]): void {
    if (!quotes?.length) return;

    // ── Payment status breakdown (for funnel & weekly bar) ───────────────────
    const payMap: Record<string, number> = {};
    for (const q of quotes) {
      const s = (q.paymentStatus ?? 'pending').toLowerCase();
      payMap[s] = (payMap[s] ?? 0) + 1;
    }

    // ── Quotation stage breakdown ─────────────────────────────────────────────
    const stageMap: Record<string, number> = {};
    for (const q of quotes) {
      const s = (q.quotationStatus ?? q.status ?? 'Created').toLowerCase();
      stageMap[s] = (stageMap[s] ?? 0) + 1;
    }
    const stageTotal = quotes.length;
    this.quoteStatusSlices.set(
      Object.entries(stageMap)
        .sort(([, a], [, b]) => b - a)
        .map(([k, v]) => ({
          label: k.charAt(0).toUpperCase() + k.slice(1),
          value: v,
          pct:   Math.round((v / stageTotal) * 100),
          color: STATUS_COLORS[k.toLowerCase()] ?? '#94a3b8',
        }))
    );

    // ── Payment method breakdown ──────────────────────────────────────────────
    const methodMap: Record<string, number> = {};
    for (const q of quotes) {
      if (q.paymentMethod) {
        const m = q.paymentMethod;
        methodMap[m] = (methodMap[m] ?? 0) + 1;
      }
    }
    const methodTotal = Object.values(methodMap).reduce((a, b) => a + b, 0) || 1;
    this.methodSlices.set(
      Object.entries(methodMap)
        .sort(([, a], [, b]) => b - a)
        .map(([k, v]) => ({
          label: k,
          value: v,
          pct:   Math.round((v / methodTotal) * 100),
          color: METHOD_COLORS[k] ?? '#94a3b8',
        }))
    );

    // ── Weekly revenue bars (from paidAmount on quotes, in rupees) ────────────
    const weeklyMap: Record<string, number> = {};
    for (const q of quotes) {
      if ((q.paymentStatus === 'paid' || q.paymentStatus === 'partially_paid') && q.paidAt) {
        const d   = new Date(q.paidAt);
        const wk  = `W${this.getWeek(d)}`;
        weeklyMap[wk] = (weeklyMap[wk] ?? 0) + (q.paidAmount ?? q.amount ?? 0);
      }
    }
    const wArr = Object.entries(weeklyMap).slice(-8);
    const wMax = Math.max(...wArr.map(([, v]) => v), 1);
    this.weeklyRevBars.set(
      wArr.map(([k, v]) => ({ label: k, value: v, pct: Math.round((v / wMax) * 100) }))
    );
  }

  // ── Ingest daily trend from Razorpay statements (paise → rupees) ─────────────
  ingestDailyTrend(d: any): void {
    if (!d) return;
    const trend: any[] = d.dailyTrend ?? [];
    const last14 = trend.slice(-14);
    const maxAmt = Math.max(...last14.map((t: any) => (t.amount ?? 0) / 100), 1);
    if (last14.length) {
      this.dailyTrendBars.set(
        last14.map((t: any) => ({
          label: String(t.date ?? '').slice(5),
          value: (t.amount ?? 0) / 100,   // paise → rupees
          pct:   Math.round(((t.amount ?? 0) / 100 / maxAmt) * 100),
        }))
      );
    }
    // MoM growth from statements if available
    if (d.momGrowth != null) this.momGrowth.set(Number(d.momGrowth));
  }

  // ── Ingest tenants ───────────────────────────────────────────────────────────
  ingestTenants(tenants: any[], quotes: any[]): void {
    if (!tenants?.length) return;
    this.totalTenants.set(tenants.length);
    this.activeTenants.set(tenants.filter((t: any) => t.isActive !== false).length);

    // Monthly onboarding trend
    const mm: Record<string, number> = {};
    for (const t of tenants) {
      const d   = new Date(t.createdAt ?? Date.now());
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      mm[key] = (mm[key] ?? 0) + 1;
    }
    const sorted = Object.entries(mm).sort(([a], [b]) => a.localeCompare(b)).slice(-8);
    const tMax   = Math.max(...sorted.map(([, v]) => v), 1);
    this.tenantGrowthBars.set(
      sorted.map(([k, v]) => ({
        label: k.slice(5),
        value: v,
        pct:   Math.round((v / tMax) * 100),
      }))
    );

    // Top tenants by revenue from quotes (paidAmount already in rupees)
    const tenantRevMap: Record<string, number> = {};
    const tenantPayMap: Record<string, number> = {};
    for (const q of quotes) {
      // quotes don't carry tenantId on the frontend; use ownerEmail as proxy
      const key = q.ownerEmail ?? q.email ?? '';
      if (!key) continue;
      if (q.paymentStatus === 'paid' || q.paymentStatus === 'partially_paid') {
        tenantRevMap[key] = (tenantRevMap[key] ?? 0) + (q.paidAmount ?? 0);
        tenantPayMap[key] = (tenantPayMap[key] ?? 0) + 1;
      }
    }

    this.topTenants.set(
      tenants.slice(0, 5).map((t: any) => ({
        name:      t.businessName || `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim() || t.email,
        email:     t.email,
        city:      t.city ?? '—',
        isActive:  t.isActive !== false,
        setupStep: t.setupStep ?? 'business',
        rank:      0,
        revenue:   tenantRevMap[t.email] ?? 0,
        payments:  tenantPayMap[t.email] ?? 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .map((t, i) => ({ ...t, rank: i + 1 }))
    );
  }

  // ── Activity feed (quote-based, not payment-based) ───────────────────────────
  buildActivity(quotes: any[], tenants: any[]): void {
    const items: ActivityItem[] = [];

    // Recent paid/partially-paid quotes
    const recentPaid = [...quotes]
      .filter(q => q.paymentStatus === 'paid' || q.paymentStatus === 'partially_paid')
      .sort((a, b) => new Date(b.paidAt ?? b.createdAt ?? 0).getTime()
                    - new Date(a.paidAt ?? a.createdAt ?? 0).getTime())
      .slice(0, 5);

    for (const q of recentPaid) {
      const ok = q.paymentStatus === 'paid';
      items.push({
        id:         q.id ?? q._id ?? q.quoteId ?? String(Math.random()),
        type:       'payment',
        title:      `Payment ${ok ? 'received' : 'partial'} — ${q.customerName ?? q.title ?? ''}`,
        sub:        `₹${this.fmtNum(q.paidAmount ?? q.amount ?? 0)} via ${q.paymentMethod || 'gateway'}`,
        time:       this.timeAgo(new Date(q.paidAt ?? q.createdAt ?? Date.now()).getTime()),
        badge:      ok ? 'Paid' : 'Partial',
        badgeClass: ok ? 'badge-success' : 'badge-warning',
      });
    }

    // Recent quotes (any status)
    const recentQuotes = [...quotes]
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
      .slice(0, 4);

    for (const q of recentQuotes) {
      const name = q.customerName ?? q.title ?? 'Customer';
      items.push({
        id:         `q-${q.id ?? q._id ?? q.quoteId ?? Math.random()}`,
        type:       'quote',
        title:      `Quote #${q.quoteNumber ?? q.ticketNumber ?? '—'} — ${name}`,
        sub:        `₹${this.fmtNum(q.amount ?? 0)} · ${q.quotationStatus ?? q.status ?? 'draft'}`,
        time:       this.timeAgo(new Date(q.createdAt ?? Date.now()).getTime()),
        badge:      q.quotationStatus ?? q.status ?? 'Draft',
        badgeClass: 'badge-indigo',
      });
    }

    // Recent tenants
    for (const t of (tenants ?? []).slice(0, 2)) {
      items.push({
        id:         t.id ?? t._id ?? String(Math.random()),
        type:       'tenant',
        title:      `${t.businessName || (`${t.firstName ?? ''} ${t.lastName ?? ''}`).trim() || t.email} joined`,
        sub:        t.email,
        time:       this.timeAgo(new Date(t.createdAt ?? Date.now()).getTime()),
        badge:      t.isActive !== false ? 'Active' : 'Inactive',
        badgeClass: t.isActive !== false ? 'badge-success' : 'badge-muted',
      });
    }

    this.recentActivity.set(items.slice(0, 12));
  }

  // ── Utilities ────────────────────────────────────────────────────────────────
  fmtNum(n: number): string {
    if (!n || isNaN(n)) return '0';
    if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(1)}Cr`;
    if (n >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
    if (n >= 1_000)      return `${(n / 1_000).toFixed(1)}K`;
    return Math.round(n).toString();
  }

  pctLabel(n: number | null): string {
    if (n == null) return '—';
    return `${n > 0 ? '+' : ''}${n}%`;
  }

  timeAgo(ms: number): string {
    const diff = Date.now() - ms;
    if (isNaN(diff) || diff < 0) return 'just now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs  < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  getWeek(d: Date): number {
    const jan1 = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d.getTime() - jan1.getTime()) / 86_400_000 + jan1.getDay() + 1) / 7);
  }
}
