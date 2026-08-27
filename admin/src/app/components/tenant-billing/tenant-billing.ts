import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subject, takeUntil } from 'rxjs';

import { TenantBillingService } from '../services/tenant-billing';
import { InvoiceDetail, SubscriptionDetail } from '../services/billing';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

@Component({
  selector: 'app-tenant-billing',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './tenant-billing.html',
  styleUrls: ['./tenant-billing.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantBilling implements OnInit, OnDestroy {

  isLoading = true;
  errorMsg = '';
  businessName = '';
  subscription: SubscriptionDetail | null = null;
  downloadingId: string | null = null;

  private destroy$ = new Subject<void>();

  constructor(private svc: TenantBillingService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void { this.load(); }
  ngOnDestroy(): void { this.destroy$.next(); this.destroy$.complete(); }

  load(): void {
    this.isLoading = true;
    this.errorMsg = '';
    this.cdr.markForCheck();

    this.svc.getMyBilling().pipe(takeUntil(this.destroy$)).subscribe({
      next: (res) => {
        this.businessName = res.data.tenant.businessName;
        this.subscription = res.data.subscription;
        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.errorMsg = err.error?.message || 'Failed to load billing information.';
        this.isLoading = false;
        this.cdr.markForCheck();
      },
    });
  }

  get currentInvoice(): InvoiceDetail | null {
    if (!this.subscription?.invoices.length) return null;
    return [...this.subscription.invoices].sort((a, b) =>
      (b.periodYear - a.periodYear) || (b.periodMonth - a.periodMonth))[0];
  }

  get sortedInvoices(): InvoiceDetail[] {
    if (!this.subscription) return [];
    return [...this.subscription.invoices].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  get lastPayment(): InvoiceDetail | null {
    const paid = (this.subscription?.invoices ?? []).filter(i => i.paidAt);
    if (!paid.length) return null;
    return paid.sort((a, b) => new Date(b.paidAt!).getTime() - new Date(a.paidAt!).getTime())[0];
  }

  get totalOutstanding(): number {
    return round2((this.subscription?.invoices ?? [])
      .filter(i => !['paid', 'cancelled', 'refunded'].includes(i.status))
      .reduce((s, i) => s + Math.max(0, i.totalAmount - i.paidAmount), 0));
  }

  statusLabel(status: string): string {
    const map: Record<string, string> = {
      trial: 'Trial', active: 'Active', grace_period: 'Grace Period', suspended: 'Suspended', cancelled: 'Cancelled',
    };
    return map[status] ?? status;
  }

  invoiceStatusLabel(status: string): string {
    const map: Record<string, string> = {
      draft: 'Draft', generated: 'Generated', pending: 'Pending', partially_paid: 'Partially Paid',
      paid: 'Paid', overdue: 'Overdue', failed: 'Failed', cancelled: 'Cancelled', refunded: 'Refunded',
    };
    return map[status] ?? status;
  }

  periodLabel(month: number, year: number): string {
    return `${MONTH_NAMES[month - 1] ?? month} ${year}`;
  }

  fmtINR(n: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n ?? 0);
  }

  fmtDate(s: string | null | undefined): string {
    if (!s) return '—';
    return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // ── View invoice (in-page, distinct from download) ────────────────────────
  viewingInvoice: InvoiceDetail | null = null;

  viewInvoice(invoice: InvoiceDetail): void { this.viewingInvoice = invoice; }
  closeInvoiceView(): void { this.viewingInvoice = null; }

  download(invoice: InvoiceDetail, mode: 'invoice' | 'receipt'): void {
    this.downloadingId = invoice._id + mode;
    this.cdr.markForCheck();
    this.svc.downloadInvoicePdf(invoice._id, mode).pipe(takeUntil(this.destroy$)).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: url, download: `${mode}-${invoice.invoiceNumber}.pdf` }).click();
        URL.revokeObjectURL(url);
        this.downloadingId = null;
        this.cdr.markForCheck();
      },
      error: () => { this.downloadingId = null; this.cdr.markForCheck(); },
    });
  }

  trackByInvoice(_: number, i: InvoiceDetail): string { return i._id; }
}

function round2(n: number): number { return Math.round((n || 0) * 100) / 100; }
