import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Environment } from '../environment/environment';
import { QuoteDetailData } from '../shared/quote-detail/quote-detail.model';

export interface TenantQuotationStats {
  total: number;
  pending: number;
  approved: number;
  rejectedOrExpired: number;
}

export interface TenantPaymentStats {
  count: number;
  totalCollected: number;
  pendingAmount: number;
  failedCount: number;
}

export interface TenantRoyaltyStats {
  percentage: number;
  totalPayable: number;
}

export interface TenantSnapshot {
  id: string;
  tenantId: string;
  businessName: string;
  ownerName: string;
  email: string;
  phone: string;
  city: string;
  isActive: boolean;
  setupStep: string;
  createdAt: string;
  crm: { isConfigured: boolean; provider: string | null; verifiedAt: string | null };
  razorpay: { isConfigured: boolean; verifiedAt: string | null };
  syncStatus: 'ok' | 'not_configured' | 'error';
  syncError: string | null;
  lastSyncAt: string | null;
  quotations: TenantQuotationStats;
  invoicedAmount: number;
  payments: TenantPaymentStats;
  royalty: TenantRoyaltyStats;
}

export interface TenantsOverviewFilters {
  /** 'all' = no date bounds (every synced quotation). */
  period?: 'all';
  month?: number;   // 1-12
  year?: number;
  dateFrom?: string;
  dateTo?: string;
  /** Bypasses the backend's short-lived per-tenant cache for an explicit "Refresh". */
  refresh?: boolean;
}

export interface TenantsOverviewResponse {
  tenants: TenantSnapshot[];
  period: { from: string | null; to: string | null };
}

export interface TenantErrorEntry {
  tenantId: string;
  tenantName: string;
  error: string;
}

export interface TenantLite {
  tenantId: string;
  businessName: string;
  ownerName: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface QuotationRow {
  tenantId: string;
  tenantName: string;
  quoteId: string;
  quotationNo: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  companyName?: string;
  quotationDate: string | null;
  expiryDate?: string | null;
  isExpired?: boolean;
  amount: number;
  currency?: string;
  quotationStatus: string;
  paymentStatus: string;
  approvalStatus?: 'approved' | 'rejected' | 'pending' | 'draft' | string;
  /** Dashboard KPI bucket. */
  outcome?: QuoteOutcome;
  paidAmount: number;
  balanceDue?: number;
  createdBy: string | null;
  relatedDeal: string | null;
  lastUpdated: string | null;
}

export type QuoteOutcome = 'approved' | 'pending' | 'rejectedOrExpired';

export interface QuotationsFilters extends TenantsOverviewFilters {
  tenantId?: string;
  status?: string;
  paymentStatus?: string;
  outcome?: QuoteOutcome | '';
  approval?: string;
  sort?: 'amount' | 'customerName' | 'quotationDate' | 'paidAmount';
  dir?: 'asc' | 'desc';
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  page?: number;
  limit?: number;
}

export interface QuotationsSummary {
  total: number;
  totalAmount: number;
  paidAmount?: number;
  balanceDue?: number;
  approved: number;
  pending: number;
  rejectedExpired: number;
}

export interface QuotationsResponse {
  rows: QuotationRow[];
  summary: QuotationsSummary;
  pagination: Pagination;
  tenantErrors: TenantErrorEntry[];
  period: { from: string | null; to: string | null };
}

export interface PaymentRow {
  tenantId: string;
  tenantName: string;
  quoteId: string;
  quotationNo: string;
  customerName: string;
  customerEmail: string;
  paymentDate: string;
  paymentMethod: string | null;
  paymentAmount: number;
  paymentStatus: string;
  paymentSource: 'Manual' | 'Razorpay';
  transactionReference: string | null;
  refundStatus: string | null;
  createdBy: string;
  lastUpdated: string | null;
}

export interface PaymentsFilters extends TenantsOverviewFilters {
  tenantId?: string;
  source?: string;
  status?: string;
  method?: string;
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  page?: number;
  limit?: number;
  sort?: 'paymentDate' | 'paymentAmount' | 'customerName';
  dir?: 'asc' | 'desc';
}

export interface PaymentsResponse {
  rows: PaymentRow[];
  summary: { totalCount: number; totalCollected: number; manualCount: number; razorpayCount: number };
  pagination: Pagination;
  tenantErrors: TenantErrorEntry[];
  period: { from: string | null; to: string | null };
}

export interface ActivityEvent {
  tenantId: string;
  tenantName: string;
  type: 'quotation_created' | 'quotation_updated' | 'payment_recorded' | 'sync_failed';
  title: string;
  detail: string;
  timestamp: string;
  severity: 'info' | 'success' | 'error';
}

export interface ActivityFilters extends TenantsOverviewFilters {
  tenantId?: string;
  type?: string;
  severity?: string;
  page?: number;
  limit?: number;
}

export interface ActivitySummary {
  total: number;
  quotationEvents: number;
  paymentEvents: number;
  syncFailures: number;
}

export interface ActivityResponse {
  events: ActivityEvent[];
  summary: ActivitySummary;
  pagination: Pagination;
  tenantErrors: TenantErrorEntry[];
  period: { from: string | null; to: string | null };
}

export interface QuoteDetailResponse {
  tenant: { tenantId: string; tenantName: string };
  quote: QuoteDetailData;
  lastSyncAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class SuperAdminService {
  private readonly http = inject(HttpClient);
  private readonly base = `${Environment.API_URL}/api/admin`;

  private toParams(filters: object): HttpParams {
    let params = new HttpParams();
    Object.entries(filters as Record<string, unknown>).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params = params.set(k, String(v));
    });
    return params;
  }

  getTenantsOverview(filters: TenantsOverviewFilters = {}): Observable<{ success: boolean; data: TenantsOverviewResponse }> {
    return this.http.get<{ success: boolean; data: TenantsOverviewResponse }>(
      `${this.base}/tenants/overview`, { params: this.toParams(filters) },
    );
  }

  getTenantOverview(tenantId: string, filters: TenantsOverviewFilters = {}): Observable<{ success: boolean; data: { tenant: TenantSnapshot; period: any } }> {
    return this.http.get<{ success: boolean; data: { tenant: TenantSnapshot; period: any } }>(
      `${this.base}/tenants/${tenantId}/overview`, { params: this.toParams(filters) },
    );
  }

  getQuotations(filters: QuotationsFilters = {}): Observable<{ success: boolean; data: QuotationsResponse }> {
    return this.http.get<{ success: boolean; data: QuotationsResponse }>(
      `${this.base}/quotations`, { params: this.toParams(filters) },
    );
  }

  /** One quotation in full (CRM + tracking + payments) for the detail drawer. */
  getQuoteDetail(tenantId: string, quoteId: string): Observable<{ success: boolean; data: QuoteDetailResponse }> {
    return this.http.get<{ success: boolean; data: QuoteDetailResponse }>(
      `${this.base}/tenants/${encodeURIComponent(tenantId)}/quotes/${encodeURIComponent(quoteId)}`,
    );
  }

  getPayments(filters: PaymentsFilters = {}): Observable<{ success: boolean; data: PaymentsResponse }> {
    return this.http.get<{ success: boolean; data: PaymentsResponse }>(
      `${this.base}/payments`, { params: this.toParams(filters) },
    );
  }

  /** Lightweight {tenantId, businessName, ownerName} list — no CRM/Razorpay
   *  calls. Use for filter dropdowns instead of getTenantsOverview(). */
  getTenantsLite(): Observable<{ success: boolean; data: { tenants: TenantLite[] } }> {
    return this.http.get<{ success: boolean; data: { tenants: TenantLite[] } }>(`${this.base}/tenants/lite`);
  }

  getActivityFeed(filters: ActivityFilters = {}): Observable<{ success: boolean; data: ActivityResponse }> {
    return this.http.get<{ success: boolean; data: ActivityResponse }>(
      `${this.base}/activity`, { params: this.toParams(filters) },
    );
  }
}
