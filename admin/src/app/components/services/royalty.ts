import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Environment } from '../environment/environment';

export interface RoyaltyHistoryEntry {
  _id: string;
  percentage: number;
  effectiveFrom: string;
  changedBy?: string;
  changedByName: string;
  createdAt: string;
}

export interface RoyaltyConfig {
  percentage: number | null;
  history: RoyaltyHistoryEntry[];
}

/**
 * Why a payment got its rate:
 *  history    — the rate in force on the payment date
 *  first-rate — the payment predates the first rate ever set, so that rate applies
 *  override   — a rate set for this quotation specifically
 *  unset      — no rate has been configured yet (0%)
 */
export type RoyaltyRateBasis = 'history' | 'first-rate' | 'override' | 'unset';

export interface RoyaltyRow {
  quoteId: string;
  quotationNo: string;
  quotationTitle: string;
  customerName: string;
  customerEmail: string;
  quotationDate: string | null;
  paymentDate: string;
  paymentReference: string;
  paymentSource: 'Manual' | 'Razorpay';
  paymentMethod: string;
  paymentAmount: number;
  royaltyPercent: number;
  royaltyAmount: number;
  rateBasis: RoyaltyRateBasis;
  rateEffectiveFrom: string | null;
  quoteAmount: number;
  paidToDate: number;
  balanceDue: number;
  paymentStatus: string;
  quotationStatus: string;
  royaltyStatus: string;
}

export interface RoyaltySummary {
  /** All quotations created within the selected period, regardless of payment status. */
  quotationsInPeriod: number;
  /** Of those, how many have a payment recorded. */
  paidQuotationsInPeriod: number;
  totalPayments: number;
  totalEligibleAmount: number;
  royaltyPercentage: number;
  /** false until the platform admin sets a rate for this tenant. */
  rateConfigured: boolean;
  /** When the current rate took effect. */
  rateSince: string | null;
  totalRoyaltyPayable: number;
  /** Distinct quotations the period's payments belong to. */
  quotationCount: number;
  manualCount: number;
  razorpayCount: number;
  /** Every quotation matched by the current search, regardless of payment status. */
  scannedQuotations: number;
}

export interface RoyaltySourceSplit {
  source: 'Manual' | 'Razorpay';
  count: number;
  amount: number;
  royalty: number;
}

export interface RoyaltyRateLine {
  percentage: number;
  count: number;
  amount: number;
  royalty: number;
}

export interface RoyaltyStatusBreakdownEntry {
  status: 'pending' | 'paid' | 'partially_paid' | 'failed' | 'refunded';
  count: number;
  amount: number;
}

export interface RoyaltyReport {
  summary: RoyaltySummary;
  rows: RoyaltyRow[];
  /** Payment-status breakdown across all matched quotations — explains why
   *  the report may be empty even when quotations exist (e.g. a quote's
   *  workflow stage says "Payment Completed" but no payment was recorded). */
  statusBreakdown: RoyaltyStatusBreakdownEntry[];
  /** Manual vs Razorpay, taken before the source filter is applied. */
  sourceSplit: RoyaltySourceSplit[];
  /** One line per rate applied in the period (several if the rate changed). */
  rateBreakdown: RoyaltyRateLine[];
  period: { from: string | null; to: string | null };
}

export interface RoyaltyReportFilters {
  /** 'all' → no date bounds */
  period?: 'all';
  month?: number;   // 1-12
  year?: number;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  source?: string;
  status?: string;
}

@Injectable({ providedIn: 'root' })
export class RoyaltyService {
  private readonly http = inject(HttpClient);
  private readonly base = `${Environment.API_URL}/tenant/royalty`;

  getReport(filters: RoyaltyReportFilters): Observable<{ success: boolean; data: RoyaltyReport }> {
    let params = new HttpParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params = params.set(k, String(v));
    });
    return this.http.get<{ success: boolean; data: RoyaltyReport }>(this.base, { params });
  }

  getConfig(): Observable<{ success: boolean; data: RoyaltyConfig }> {
    return this.http.get<{ success: boolean; data: RoyaltyConfig }>(`${this.base}/config`);
  }
}
