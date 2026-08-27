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

export interface RoyaltyRow {
  quoteId: string;
  quotationNo: string;
  customerName: string;
  quotationDate: string | null;
  paymentDate: string;
  paymentReference: string;
  paymentSource: 'Manual' | 'Razorpay';
  paymentAmount: number;
  royaltyPercent: number;
  royaltyAmount: number;
  paymentStatus: string;
  quotationStatus: string;
  royaltyStatus: string;
}

export interface RoyaltySummary {
  /** All quotations created within the selected period, regardless of payment status. */
  quotationsInPeriod: number;
  totalPayments: number;
  totalEligibleAmount: number;
  royaltyPercentage: number;
  totalRoyaltyPayable: number;
  quotationCount: number;
  manualCount: number;
  razorpayCount: number;
  /** Every quotation matched by the current search, regardless of payment status. */
  scannedQuotations: number;
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
  period: { from: string | null; to: string | null };
}

export interface RoyaltyReportFilters {
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
