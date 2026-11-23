import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, Output, inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';

import {
  SuperAdminService, QuotationRow, PaymentRow, TenantSnapshot,
  QuotationsFilters, PaymentsFilters, QuoteDetailResponse,
} from '../../services/super-admin';
import { DetailDrawer } from '../detail-drawer/detail-drawer';
import { QuoteDetail } from '../quote-detail/quote-detail';

export interface DrillLink {
  label: string;
  path: string;
  queryParams?: Record<string, string | number>;
}

/** What a clicked card / row asks the drawer to show. */
export type DrillRequest =
  | { kind: 'quotes'; title: string; subtitle?: string; filters: QuotationsFilters; fullView?: DrillLink }
  | { kind: 'payments'; title: string; subtitle?: string; filters: PaymentsFilters; fullView?: DrillLink }
  | { kind: 'tenants'; title: string; subtitle?: string; tenants: TenantSnapshot[]; fullView?: DrillLink }
  | { kind: 'quote'; tenantId: string; quoteId: string; tenantName?: string; title?: string };

interface QuoteRef { tenantId: string; quoteId: string; tenantName?: string; }

const LIST_LIMIT = 200;

/**
 * Super Admin drill-down: a KPI card opens the records behind its number
 * (quotations, payments or tenants); a record opens the full quotation.
 * Rows on the list pages open straight into the quotation (`kind: 'quote'`).
 */
@Component({
  selector: 'app-sa-drilldown',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, DetailDrawer, QuoteDetail],
  templateUrl: './sa-drilldown.html',
  styleUrls: ['./sa-drilldown.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SaDrilldown implements OnDestroy {
  private readonly svc = inject(SuperAdminService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly router = inject(Router);

  @Output() closed = new EventEmitter<void>();

  req: DrillRequest | null = null;

  // list
  listLoading = false;
  listError = '';
  quoteRows: QuotationRow[] = [];
  paymentRows: PaymentRow[] = [];
  totalRecords = 0;
  search = '';
  sort: 'date' | 'amount' = 'date';

  // detail
  ref: QuoteRef | null = null;
  detail: QuoteDetailResponse | null = null;
  detailLoading = false;
  detailError = '';

  private listSub?: Subscription;
  private detailSub?: Subscription;

  @Input() set request(r: DrillRequest | null) {
    this.req = r;
    this.reset();
    if (!r) return;
    if (r.kind === 'quote') this.openQuote({ tenantId: r.tenantId, quoteId: r.quoteId, tenantName: r.tenantName });
    else if (r.kind === 'quotes' || r.kind === 'payments') this.loadList();
  }

  ngOnDestroy(): void { this.listSub?.unsubscribe(); this.detailSub?.unsubscribe(); }

  private reset(): void {
    this.listSub?.unsubscribe(); this.detailSub?.unsubscribe();
    this.quoteRows = []; this.paymentRows = []; this.totalRecords = 0;
    this.listError = ''; this.listLoading = false; this.search = ''; this.sort = 'date';
    this.ref = null; this.detail = null; this.detailError = ''; this.detailLoading = false;
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  loadList(): void {
    const r = this.req;
    if (!r || (r.kind !== 'quotes' && r.kind !== 'payments')) return;
    this.listLoading = true; this.listError = '';
    this.cdr.markForCheck();
    this.listSub?.unsubscribe();

    if (r.kind === 'quotes') {
      this.listSub = this.svc.getQuotations({ ...r.filters, page: 1, limit: LIST_LIMIT }).subscribe({
        next: (res) => {
          this.quoteRows = res.data.rows; this.totalRecords = res.data.pagination.total;
          this.listLoading = false; this.cdr.markForCheck();
        },
        error: (err) => this.onListError(err),
      });
    } else {
      this.listSub = this.svc.getPayments({ ...r.filters, page: 1, limit: LIST_LIMIT }).subscribe({
        next: (res) => {
          this.paymentRows = res.data.rows; this.totalRecords = res.data.pagination.total;
          this.listLoading = false; this.cdr.markForCheck();
        },
        error: (err) => this.onListError(err),
      });
    }
  }

  private onListError(err: any): void {
    this.listError = err?.error?.message || err?.message || 'Could not load the records.';
    this.listLoading = false; this.cdr.markForCheck();
  }

  openQuote(ref: QuoteRef): void {
    this.ref = ref;
    this.detail = null; this.detailError = ''; this.detailLoading = true;
    this.cdr.markForCheck();
    this.detailSub?.unsubscribe();
    this.detailSub = this.svc.getQuoteDetail(ref.tenantId, ref.quoteId).subscribe({
      next: (res) => { this.detail = res.data; this.detailLoading = false; this.cdr.markForCheck(); },
      error: (err) => {
        this.detailError = err?.error?.message || err?.message || 'Could not load this quotation.';
        this.detailLoading = false; this.cdr.markForCheck();
      },
    });
  }

  retryDetail(): void { if (this.ref) this.openQuote(this.ref); }

  backToList(): void {
    this.detailSub?.unsubscribe();
    this.ref = null; this.detail = null; this.detailError = ''; this.detailLoading = false;
    this.cdr.markForCheck();
  }

  // ── List helpers ──────────────────────────────────────────────────────────

  get visibleQuotes(): QuotationRow[] {
    const q = this.search.trim().toLowerCase();
    let rows = !q ? this.quoteRows : this.quoteRows.filter(r =>
      `${r.quotationNo} ${r.customerName} ${r.customerEmail} ${r.companyName ?? ''} ${r.tenantName} ${r.relatedDeal ?? ''}`
        .toLowerCase().includes(q));
    if (this.sort === 'amount') rows = [...rows].sort((a, b) => b.amount - a.amount);
    return rows;
  }

  get visiblePayments(): PaymentRow[] {
    const q = this.search.trim().toLowerCase();
    let rows = !q ? this.paymentRows : this.paymentRows.filter(r =>
      `${r.quotationNo} ${r.customerName} ${r.customerEmail} ${r.tenantName} ${r.transactionReference ?? ''}`
        .toLowerCase().includes(q));
    if (this.sort === 'amount') rows = [...rows].sort((a, b) => b.paymentAmount - a.paymentAmount);
    return rows;
  }

  get visibleTenants(): TenantSnapshot[] {
    const r = this.req;
    if (r?.kind !== 'tenants') return [];
    const q = this.search.trim().toLowerCase();
    return !q ? r.tenants : r.tenants.filter(t =>
      `${t.businessName} ${t.ownerName} ${t.email} ${t.city} ${t.tenantId}`.toLowerCase().includes(q));
  }

  get listSum(): number {
    return this.req?.kind === 'payments'
      ? this.visiblePayments.reduce((s, r) => s + r.paymentAmount, 0)
      : this.visibleQuotes.reduce((s, r) => s + r.amount, 0);
  }

  get collectedSum(): number { return this.visibleQuotes.reduce((s, r) => s + (r.paidAmount || 0), 0); }

  /** Outcome split for the segmented bar on quote lists. */
  get outcomeSplit(): { key: string; label: string; count: number; pct: number }[] {
    const rows = this.visibleQuotes;
    const n = rows.length || 1;
    const count = (k: string) => rows.filter(r => r.outcome === k).length;
    return [
      { key: 'approved', label: 'Approved', count: count('approved'), pct: 0 },
      { key: 'pending', label: 'Pending', count: count('pending'), pct: 0 },
      { key: 'rejectedOrExpired', label: 'Rejected / expired', count: count('rejectedOrExpired'), pct: 0 },
    ].map(s => ({ ...s, pct: Math.round((s.count / n) * 1000) / 10 }));
  }

  // ── Prev / next within the list ───────────────────────────────────────────

  private get navList(): QuoteRef[] {
    if (this.req?.kind === 'quotes') return this.visibleQuotes.map(r => ({ tenantId: r.tenantId, quoteId: r.quoteId, tenantName: r.tenantName }));
    if (this.req?.kind === 'payments') return this.visiblePayments.map(r => ({ tenantId: r.tenantId, quoteId: r.quoteId, tenantName: r.tenantName }));
    return [];
  }
  get navIndex(): number {
    const ref = this.ref;
    if (!ref) return -1;
    return this.navList.findIndex(r => r.tenantId === ref.tenantId && r.quoteId === ref.quoteId);
  }
  get navCount(): number { return this.navList.length; }
  step(delta: number): void {
    const list = this.navList;
    const i = this.navIndex + delta;
    if (i >= 0 && i < list.length) this.openQuote(list[i]);
  }

  // ── Navigation / display ──────────────────────────────────────────────────

  openTenant(t: TenantSnapshot): void {
    this.closed.emit();
    this.router.navigate(['/admin/tenants', t.tenantId]);
  }

  goFullView(link: DrillLink): void {
    this.closed.emit();
    this.router.navigate([link.path], { queryParams: link.queryParams ?? {} });
  }

  get drawerTitle(): string {
    const r = this.req;
    if (!r) return '';
    if (this.ref) {
      const d = this.detail?.quote;
      return d ? (d.dealName || d.title || `Quotation #${d.quoteNumber}`) : (r.kind === 'quote' && r.title) || 'Quotation';
    }
    return r.kind === 'quote' ? (r.title || 'Quotation') : r.title;
  }

  get drawerSubtitle(): string {
    const r = this.req;
    if (!r) return '';
    if (this.ref) return this.detail ? `${this.detail.tenant.tenantName} · #${this.detail.quote.quoteNumber}` : (this.ref.tenantName ?? '');
    if (r.kind === 'quote') return r.tenantName ?? '';
    return r.subtitle ?? '';
  }

  get eyebrow(): string {
    if (this.ref) return 'Quotation details';
    switch (this.req?.kind) {
      case 'quotes': return 'Quotations';
      case 'payments': return 'Payments';
      case 'tenants': return 'Tenants';
      default: return '';
    }
  }

  get fullView(): DrillLink | null {
    const r = this.req;
    return r && r.kind !== 'quote' ? (r.fullView ?? null) : null;
  }

  get kind(): DrillRequest['kind'] | null { return this.req?.kind ?? null; }

  get showBack(): boolean { return !!this.ref && this.req?.kind !== 'quote'; }

  fmtINR(n: number): string {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n ?? 0);
  }
  fmtDate(s: string | null | undefined): string {
    if (!s) return '—';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  payLabel(s: string): string {
    return ({ paid: 'Paid', partially_paid: 'Partial', pending: 'Pending', failed: 'Failed', refunded: 'Refunded' } as Record<string, string>)[s] ?? s;
  }
  outcomeLabel(s?: string): string {
    return ({ approved: 'Approved', pending: 'Pending', rejectedOrExpired: 'Rejected / expired' } as Record<string, string>)[s ?? ''] ?? '';
  }
  initials(name: string): string {
    return (name || '?').split(/\s+/).filter(Boolean).map(p => p[0]).join('').slice(0, 2).toUpperCase() || '?';
  }

  trackQuote(_: number, r: QuotationRow): string { return `${r.tenantId}-${r.quoteId}`; }
  trackPayment(i: number, r: PaymentRow): string { return `${r.tenantId}-${r.quoteId}-${i}`; }
  trackTenant(_: number, t: TenantSnapshot): string { return t.id; }
}
