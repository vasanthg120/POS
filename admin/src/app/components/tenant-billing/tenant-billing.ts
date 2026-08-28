import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef, NgZone,
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

  constructor(private svc: TenantBillingService, private cdr: ChangeDetectorRef, private zone: NgZone) {}

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

  // ── Pay Now (Razorpay Checkout, per-invoice order) ─────────────────────────
  payingId: string | null = null;
  payErrorMsg = '';

  get payableInvoice(): InvoiceDetail | null {
    // The invoice actually shown as "outstanding" up top — pay that one.
    return (this.subscription?.invoices ?? [])
      .filter(i => !['paid', 'cancelled', 'refunded'].includes(i.status) && i.totalAmount - i.paidAmount > 0)
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())[0] ?? null;
  }

  async payNow(invoice: InvoiceDetail | null): Promise<void> {
    if (!invoice || this.payingId) return;
    this.payingId = invoice._id;
    this.payErrorMsg = '';
    this.cdr.markForCheck();

    try {
      const scriptLoaded = await this.loadRazorpayScript();
      if (!scriptLoaded) throw new Error('Could not load the payment window. Check your internet connection.');

      const orderRes = await this.svc.createPaymentOrder(invoice._id).toPromise();
      const order = orderRes!.data;

      const result = await this.openRazorpayCheckout({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: 'Platform Subscription',
        description: `${order.invoiceNumber} — subscription payment`,
        order_id: order.razorpayOrderId,
        theme: { color: '#0284c7' },
      });

      await this.svc.verifyPayment(invoice._id, {
        razorpay_order_id: result.razorpay_order_id,
        razorpay_payment_id: result.razorpay_payment_id,
        razorpay_signature: result.razorpay_signature,
      }).toPromise();

      this.payingId = null;
      this.cdr.markForCheck();
      this.load();
    } catch (err: any) {
      this.payingId = null;
      this.payErrorMsg = err?.error?.message || err?.message || 'Payment failed. Please try again.';
      this.cdr.markForCheck();
    }
  }

  private loadRazorpayScript(): Promise<boolean> {
    return new Promise(resolve => {
      if ((window as any).Razorpay) { resolve(true); return; }
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.body.appendChild(s);
    });
  }

  private openRazorpayCheckout(options: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const rzp = new (window as any).Razorpay({
        ...options,
        handler: (r: any) => this.zone.run(() => resolve(r)),
        modal: { ondismiss: () => this.zone.run(() => reject(new Error('Payment window closed.'))) },
      });
      rzp.on('payment.failed', (r: any) =>
        this.zone.run(() => reject(new Error(r?.error?.description || r?.error?.reason || 'Payment failed.'))));
      rzp.open();
    });
  }
}

function round2(n: number): number { return Math.round((n || 0) * 100) / 100; }
