import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { finalize } from 'rxjs/operators';

import {
  SuperAdminService, TenantSnapshot, QuotationRow, PaymentRow, Pagination, QuotationsFilters, QuoteOutcome,
} from '../services/super-admin';
import { Environment } from '../environment/environment';
import { PeriodPicker } from '../shared/period-picker/period-picker';
import { PeriodState, defaultPeriod, periodLabel, periodParams } from '../shared/period';
import { SaDrilldown, DrillRequest } from '../shared/sa-drilldown/sa-drilldown';

type DetailTab = 'quotations' | 'payments';

@Component({
  selector: 'app-tenant-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, PeriodPicker, SaDrilldown],
  templateUrl: './tenant-detail.html',
  styleUrls: ['./tenant-detail.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantDetail implements OnInit, OnDestroy {

  tenantId = '';
  tenant: TenantSnapshot | null = null;
  isLoading = true;
  errorMsg = '';

  // Defaults to "All time" (was the current month only).
  period: PeriodState = defaultPeriod();

  // ── Records tabs ───────────────────────────────────────────────────────────
  tab: DetailTab = 'quotations';
  outcome: QuoteOutcome | '' = '';
  listSearch = '';
  quoteRows: QuotationRow[] = [];
  paymentRows: PaymentRow[] = [];
  listPage: Pagination = { page: 1, limit: 10, total: 0, pages: 1 };
  listLoading = false;
  listError = '';
  readonly listLimit = 10;

  drill: DrillRequest | null = null;

  // ── Royalty % editor (platform admin sets this — tenants view only) ────────
  royaltyEditing = false;
  royaltyDraft: number | null = null;
  royaltySaving = false;
  royaltyErr = '';

  private destroy$ = new Subject<void>();

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private svc: SuperAdminService,
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe(p => {
      this.tenantId = p.get('tenantId') ?? '';
      if (this.tenantId) this.load();
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  load(): void {
    this.isLoading = true;
    this.errorMsg = '';
    this.cdr.markForCheck();

    this.loadList(1);
    this.svc.getTenantOverview(this.tenantId, periodParams(this.period))
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.tenant = res.data.tenant;
          this.isLoading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.errorMsg = err?.error?.message || 'Failed to load tenant.';
          this.isLoading = false;
          this.cdr.markForCheck();
        },
      });
  }

  onPeriodChange(p: PeriodState): void { this.period = p; this.load(); }

  get periodText(): string { return periodLabel(this.period); }

  // ── Records tabs ───────────────────────────────────────────────────────────
  setTab(t: DetailTab): void {
    if (this.tab === t) return;
    this.tab = t;
    this.outcome = '';
    this.loadList(1);
  }

  setOutcome(o: QuoteOutcome | ''): void {
    this.tab = 'quotations';
    this.outcome = this.outcome === o ? '' : o;
    this.loadList(1);
  }

  onListSearch(): void { this.loadList(1); }

  loadList(page = this.listPage.page): void {
    if (!this.tenantId) return;
    this.listLoading = true; this.listError = '';
    this.cdr.markForCheck();
    const base = { ...periodParams(this.period), tenantId: this.tenantId, search: this.listSearch.trim(), page, limit: this.listLimit };

    const onError = (err: any) => {
      this.listError = err?.error?.message || 'Could not load records.';
      this.listLoading = false; this.cdr.markForCheck();
    };

    if (this.tab === 'quotations') {
      this.svc.getQuotations({ ...base, outcome: this.outcome, sort: 'quotationDate', dir: 'desc' })
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (res) => { this.quoteRows = res.data.rows; this.listPage = res.data.pagination; this.listLoading = false; this.cdr.markForCheck(); },
          error: onError,
        });
    } else {
      this.svc.getPayments({ ...base, sort: 'paymentDate', dir: 'desc' })
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (res) => { this.paymentRows = res.data.rows; this.listPage = res.data.pagination; this.listLoading = false; this.cdr.markForCheck(); },
          error: onError,
        });
    }
  }

  // ── Drill-down ─────────────────────────────────────────────────────────────
  private get tenantName(): string { return this.tenant?.businessName || this.tenant?.ownerName || this.tenantId; }

  openQuotes(title: string, extra: QuotationsFilters = {}): void {
    this.drill = {
      kind: 'quotes', title, subtitle: `${this.tenantName} · ${this.periodText}`,
      filters: { ...periodParams(this.period), tenantId: this.tenantId, ...extra },
    };
    this.cdr.markForCheck();
  }

  openPayments(title: string): void {
    this.drill = {
      kind: 'payments', title, subtitle: `${this.tenantName} · ${this.periodText}`,
      filters: { ...periodParams(this.period), tenantId: this.tenantId },
    };
    this.cdr.markForCheck();
  }

  openQuote(tenantId: string, quoteId: string): void {
    this.drill = { kind: 'quote', tenantId, quoteId, tenantName: this.tenantName };
    this.cdr.markForCheck();
  }

  closeDrill(): void { this.drill = null; this.cdr.markForCheck(); }

  payLabel(s: string): string {
    return ({ paid: 'Paid', partially_paid: 'Partial', pending: 'Pending', failed: 'Failed', refunded: 'Refunded' } as Record<string, string>)[s] ?? s;
  }

  outcomeLabel(o?: string): string {
    return ({ approved: 'Approved', pending: 'Pending', rejectedOrExpired: 'Rejected / Expired' } as Record<string, string>)[o ?? ''] ?? '—';
  }

  goBack(): void { this.router.navigate(['/admin/tenants']); }

  // ── Royalty % editor ─────────────────────────────────────────────────────
  startEditRoyalty(): void {
    if (!this.tenant) return;
    this.royaltyDraft = this.tenant.royalty.percentage ?? 0;
    this.royaltyErr = '';
    this.royaltyEditing = true;
    this.cdr.markForCheck();
  }

  cancelEditRoyalty(): void {
    this.royaltyEditing = false;
    this.cdr.markForCheck();
  }

  saveRoyalty(): void {
    if (!this.tenant || this.royaltyDraft == null || this.royaltyDraft < 0 || this.royaltyDraft > 100) {
      this.royaltyErr = 'Enter a percentage between 0 and 100';
      return;
    }
    this.royaltySaving = true;
    this.royaltyErr = '';
    this.cdr.markForCheck();

    this.http.patch<any>(
      `${Environment.API_URL}/api/admin/tenants/${this.tenantId}/royalty-config`,
      { percentage: this.royaltyDraft },
    ).pipe(takeUntil(this.destroy$), finalize(() => { this.royaltySaving = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: (res) => {
          if (this.tenant) this.tenant = { ...this.tenant, royalty: { ...this.tenant.royalty, percentage: res.data.percentage } };
          this.royaltyEditing = false;
        },
        error: (err) => {
          this.royaltyErr = err.error?.message || 'Failed to update royalty percentage.';
        },
      });
  }

  fmtINR(n: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR',
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n ?? 0);
  }

  fmtDate(s: string | null): string {
    if (!s) return '—';
    return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  fmtDateTime(s: string | null): string {
    if (!s) return '—';
    return new Date(s).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  initials(name: string): string {
    return (name || '?').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
  }

  syncStatusLabel(): string {
    if (!this.tenant) return '';
    if (this.tenant.syncStatus === 'not_configured') return 'CRM not connected';
    if (this.tenant.syncStatus === 'error') return this.tenant.syncError || 'Sync failed';
    return this.tenant.lastSyncAt ? `Synced ${this.fmtDateTime(this.tenant.lastSyncAt)}` : 'Synced';
  }
}
