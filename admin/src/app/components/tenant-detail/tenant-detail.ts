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

import { SuperAdminService, TenantSnapshot } from '../services/super-admin';
import { Environment } from '../environment/environment';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

@Component({
  selector: 'app-tenant-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './tenant-detail.html',
  styleUrls: ['./tenant-detail.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantDetail implements OnInit, OnDestroy {

  tenantId = '';
  tenant: TenantSnapshot | null = null;
  isLoading = true;
  errorMsg = '';

  readonly monthOptions = MONTH_NAMES.map((label, i) => ({ value: i + 1, label }));
  readonly yearOptions: number[] = (() => {
    const y = new Date().getFullYear();
    return [y - 2, y - 1, y, y + 1];
  })();
  selectedMonth = new Date().getMonth() + 1;
  selectedYear = new Date().getFullYear();

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

    this.svc.getTenantOverview(this.tenantId, { month: this.selectedMonth, year: this.selectedYear })
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

  onPeriodChange(): void { this.load(); }

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
    return 'Synced just now';
  }
}
