// tracking.service.ts
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { Environment } from '../environment/environment';

// ─── Shared types ─────────────────────────────────────────────────────────────

export type PayStatus = 'pending' | 'paid' | 'failed' | 'partially_paid' | 'refunded';
export type QuotStage =
  | 'Created' | 'In Progress' | 'Processing' | 'Awaiting Payment'
  | 'Payment Completed' | 'Delivered' | 'Closed' | 'Cancelled';

export interface TimelineEntry {
  event : string;
  date  : string;
  by    : string;
  type  : 'status' | 'payment' | 'note' | 'warning' | 'error';
}

export interface ManualPaymentEntry {
  amount          : number;
  method          : string;
  referenceNumber : string;
  paymentDate     : string;
  notes           : string;
}

export interface TrackingRecord {
  // identifiers
  id           : string;
  ticketNumber : string;
  quoteName    : string;
  // customer
  customerName  : string;
  customerEmail : string;
  customerPhone : string;
  // financials
  amount      : number;
  paidAmount  : number;
  currency    : string;
  // statuses
  paymentStatus    : PayStatus;
  quotationStatus  : QuotStage;
  paymentMethod    : string;
  // bank / manual
  bankTransferRef   : string;
  bankTransferNotes : string;
  manualPayments    : ManualPaymentEntry[];
  // meta
  notes     : string;
  createdAt : string;
  paidAt    : string;
  expiresAt : string;
  timeline  : TimelineEntry[];
  // internal refs
  _quoteId    ?: string;
  _paymentId  ?: string;
  _adminOverride ?: boolean;
  // Razorpay extras
  rzpBank   ?: string | null;
  rzpVpa    ?: string | null;
  rzpWallet ?: string | null;
}

export interface EditForm {
  quotationStatus   : QuotStage;
  paymentStatus     : PayStatus;
  paymentMethod     : string;
  paidAmount        : number;
  bankTransferRef   : string;
  bankTransferNotes : string;
  notes             : string;
}

export interface ManualPaymentForm {
  method          : string;
  amount          : number | null;
  referenceNumber : string;
  paymentDate     : string;
  notes           : string;
}

export interface TrackingStats {
  total          : number;
  totalRevenue   : number;
  pendingRevenue : number;
  overdueRevenue : number;
  conversionRate : number;
  paidCount      : number;
  pendingCount   : number;
  failedCount    : number;
  partialCount   : number;
  overdueCount   : number;
  avgDealSize    : number;
}

// ─── Method normalisation map ─────────────────────────────────────────────────

const METHOD_MAP: Record<string, string> = {
  upi: 'UPI', card: 'Card', netbanking: 'Net Banking',
  nb: 'Net Banking', net_banking: 'Net Banking',
  cash: 'Cash', wallet: 'Wallet', emi: 'EMI',
  bank_transfer: 'Bank Transfer', banktransfer: 'Bank Transfer',
  neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', cheque: 'Cheque',
  manual: 'Manual',
};

@Injectable({ providedIn: 'root' })
export class TrackingService {
  private readonly http = inject(HttpClient);
  private readonly base = Environment.API_URL ?? '';

  // ── Load all quotes (auto-syncs Razorpay on the server side) ─────────────

  /**
   * Errors are passed to the caller, not turned into an empty list: an
   * empty list read as "no CRM quotes" and hid real failures (CRM errors,
   * or the API path not reaching the backend in production).
   */
  loadAll(): Observable<TrackingRecord[]> {
    return this.http
      .get<any>(`${this.base}/tenant/quotes`)
      .pipe(
        map(r => {
          const quotes: any[] = r?.data?.quotes ?? r?.data ?? [];
          return quotes.map(q => this.mapQuote(q));
        }),
      );
  }

  // ── Stats (richer KPIs from server) ──────────────────────────────────────

  loadStats(): Observable<TrackingStats> {
    return this.http
      .get<any>(`${this.base}/tenant/quotes/stats`)
      .pipe(
        map(r => r?.data ?? this.emptyStats()),
        catchError(() => of(this.emptyStats())),
      );
  }

  // ── On-demand bulk Razorpay sync ──────────────────────────────────────────

  syncRazorpay(): Observable<{ synced: number; message: string }> {
    return this.http
      .post<any>(`${this.base}/tenant/quotes/sync-razorpay`, {})
      .pipe(
        // No catchError: a failed request used to come back as { synced: 0 },
        // which the page announced as "Already up to date".
        map(r => ({ synced: r?.data?.synced ?? 0, message: r?.message ?? '' })),
      );
  }

  // ── General tracking update (stage, notes, method, admin overrides) ───────

  updateRecord(
    quoteId : string,
    payload : Partial<TrackingRecord> & { timelineEntry?: TimelineEntry } & Record<string, any>,
  ): Observable<any> {
    return this.http
      .patch(`${this.base}/tenant/quotes/${encodeURIComponent(quoteId)}/track`, payload)
      .pipe(catchError(err => of({ success: false, message: err?.error?.message || 'Network error' })));
  }

  // ── Manual payment recording (Bank Transfer / Cash / NEFT etc.) ───────────

  recordManualPayment(
    quoteId     : string,
    form        : ManualPaymentForm,
    totalAmount : number,
  ): Observable<any> {
    return this.http
      .post(`${this.base}/tenant/quotes/${encodeURIComponent(quoteId)}/manual-payment`, {
        method          : form.method,
        amount          : form.amount,
        referenceNumber : form.referenceNumber,
        paymentDate     : form.paymentDate,
        notes           : form.notes,
        totalAmount,
      })
      .pipe(catchError(err => of({ success: false, message: err?.error?.message || 'Network error' })));
  }

  // ── Razorpay payment detail (for drawer sync button) ─────────────────────

  getRazorpayPayment(paymentId: string): Observable<any> {
    return this.http
      .get(`${this.base}/tenant/statements/payments/${encodeURIComponent(paymentId)}`)
      .pipe(catchError(() => of(null)));
  }

  // ── Private mapping ───────────────────────────────────────────────────────

  private mapQuote(q: any): TrackingRecord {
    return {
      id           : q.id ?? q.quoteId ?? '',
      ticketNumber : q.quoteNumber ?? String(q.id ?? ''),
      quoteName    : q.title ?? '',
      customerName  : q.customerName  ?? '—',
      customerEmail : q.email         ?? '—',
      customerPhone : q.phone         ?? '',
      amount        : q.amount        ?? 0,
      paidAmount    : q.paidAmount    ?? 0,
      currency      : q.currency      ?? 'INR',
      paymentStatus   : q.paymentStatus   ?? 'pending',
      quotationStatus : q.quotationStatus ?? 'Created',
      paymentMethod   : this.normaliseMethod(q.paymentMethod ?? ''),
      bankTransferRef   : q.bankTransferRef   ?? '',
      bankTransferNotes : q.bankTransferNotes ?? '',
      manualPayments    : Array.isArray(q.manualPayments) ? q.manualPayments : [],
      notes     : q.notes     ?? '',
      createdAt : q.createdAt ?? '',
      paidAt    : q.paidAt    ?? '',
      expiresAt : q.expiryDate ?? q.expiresAt ?? '',
      timeline  : Array.isArray(q.timeline) ? q.timeline : [],
      _quoteId       : q.quoteId ?? q.id,
      _paymentId     : q._paymentId     ?? undefined,
      _adminOverride : q._adminOverride ?? false,
      rzpBank   : q.rzpBank   ?? null,
      rzpVpa    : q.rzpVpa    ?? null,
      rzpWallet : q.rzpWallet ?? null,
    };
  }

  private normaliseMethod(raw: string): string {
    const key = String(raw).toLowerCase().trim().replace(/\s+/g, '_');
    return METHOD_MAP[key] ?? (raw ? String(raw) : '');
  }

  private emptyStats(): TrackingStats {
    return {
      total: 0, totalRevenue: 0, pendingRevenue: 0, overdueRevenue: 0,
      conversionRate: 0, paidCount: 0, pendingCount: 0, failedCount: 0,
      partialCount: 0, overdueCount: 0, avgDealSize: 0,
    };
  }
}
