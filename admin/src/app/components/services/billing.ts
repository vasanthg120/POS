import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Environment } from '../environment/environment';

export type TenantStatus = 'trial' | 'active' | 'grace_period' | 'suspended' | 'cancelled';
export type BillingState = TenantStatus | 'unenrolled';
export type InvoiceStatus = 'draft' | 'generated' | 'pending' | 'partially_paid' | 'paid' | 'overdue' | 'failed' | 'cancelled' | 'refunded';
export type FollowUpType = 'call' | 'email' | 'whatsapp' | 'sms' | 'in_person' | 'other';
export type FollowUpStatus = 'pending' | 'contacted' | 'promised_to_pay' | 'payment_received' | 'escalated' | 'no_response' | 'closed';

export interface CurrentInvoiceSummary {
  id: string;
  invoiceNumber: string;
  periodMonth: number;
  periodYear: number;
  totalAmount: number;
  dueDate: string;
  status: InvoiceStatus;
  paidAmount: number;
  paymentMethod: string;
  daysOverdue: number;
  followUpCount: number;
  followUpStatuses: FollowUpStatus[];
}

export interface BillingRow {
  tenantId: string;
  tenantName: string;
  ownerName: string;
  email: string;
  isEnrolled: boolean;
  planId: string | null;
  planName: string;
  monthlyFee: number;
  gstPercent: number;
  billingDay: number;
  gracePeriodDays: number | null;
  billingSuspended: boolean;
  billingState: BillingState;
  subscriptionStartDate: string | null;
  currentInvoice: CurrentInvoiceSummary | null;
  lastPayment: { amount: number; paidAt: string; method: string } | null;
  outstandingAmount: number;
}

export interface BillingSummary {
  totalTenants: number;
  enrolled: number;
  trial: number;
  active: number;
  gracePeriod: number;
  overdue: number;
  suspended: number;
  cancelled: number;
  unenrolled: number;
  mrr: number;
  totalOutstanding: number;
  paidThisMonth: number;
}

export interface Pagination { page: number; limit: number; total: number; pages: number; }

export interface BillingOverviewResponse {
  rows: BillingRow[];
  summary: BillingSummary;
  pagination: Pagination;
  period: { month: number; year: number };
}

export interface FollowUpEntry {
  _id: string;
  note: string;
  type: FollowUpType;
  contactMethod: string;
  assignedStaffName: string;
  followUpStatus: FollowUpStatus;
  nextFollowUpDate: string | null;
  addedByName: string;
  createdAt: string;
}

export interface RefundEntry {
  _id: string;
  amount: number;
  reason: string;
  refundedAt: string;
  refundedByName: string;
}

export interface AdjustmentEntry {
  _id: string;
  amount: number;
  type: 'credit' | 'debit';
  reason: string;
  addedByName: string;
  createdAt: string;
}

export interface InvoiceDetail {
  _id: string;
  invoiceNumber: string;
  periodMonth: number;
  periodYear: number;
  planName: string;
  baseAmount: number;
  discountAmount: number;
  gstPercent: number;
  gstAmount: number;
  totalAmount: number;
  dueDate: string;
  status: InvoiceStatus;
  paidAmount: number;
  paidAt: string | null;
  paymentMethod: string;
  referenceNumber: string;
  paymentNotes: string;
  recordedByName: string;
  failedAt: string | null;
  failureReason: string;
  refunds: RefundEntry[];
  adjustments: AdjustmentEntry[];
  cancelledAt: string | null;
  cancelReason: string;
  suspendedAt: string | null;
  remindersSent: string[];
  followUps: FollowUpEntry[];
  createdAt: string;
}

export interface SubscriptionDetail {
  tenantId: string;
  createdAt: string;
  isEnrolled: boolean;
  planId: string | null;
  planName: string;
  monthlyFee: number;
  gstPercent: number;
  discountType: 'percent' | 'flat';
  discountValue: number;
  billingDay: number;
  gracePeriodDays: number | null;
  trialEndsAt: string | null;
  tenantStatus: TenantStatus;
  cancelledAt: string | null;
  cancelReason: string;
  invoices: InvoiceDetail[];
}

export interface TenantBillingDetail {
  tenant: {
    tenantId: string;
    businessName: string;
    ownerName: string;
    email: string;
    billingSuspended: boolean;
  };
  subscription: SubscriptionDetail;
}

export interface AuditLogEntry {
  _id: string;
  action: string;
  description: string;
  invoiceNumber: string;
  amount: number | null;
  previousStatus: string;
  newStatus: string;
  performedByName: string;
  createdAt: string;
}

export interface BillingOverviewFilters {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  month?: number;
  year?: number;
  planId?: string;
  paymentMethod?: string;
  minAmount?: number;
  maxAmount?: number;
  dueWindow?: string;
  followUpStatus?: string;
}

export interface AdjustmentPayload {
  amount: number;
  type: 'credit' | 'debit';
  reason?: string;
}

export interface BillingConfigPayload {
  isEnrolled?: boolean;
  monthlyFee?: number;
  gstPercent?: number;
  discountType?: 'percent' | 'flat';
  discountValue?: number;
  billingDay?: number;
  gracePeriodDays?: number | null;
  trialDays?: number;
}

export interface RecordPaymentPayload {
  amount: number;
  method?: string;
  referenceNumber?: string;
  notes?: string;
  paidAt?: string;
}

export interface FollowUpPayload {
  note: string;
  type?: FollowUpType;
  contactMethod?: string;
  assignedStaffName?: string;
  followUpStatus?: FollowUpStatus;
  nextFollowUpDate?: string | null;
}

export interface FollowUpBucketEntry {
  tenantId: string;
  tenantName: string;
  email: string;
  invoiceNumber: string;
  totalAmount: number;
  outstanding: number;
  dueDate: string;
  daysUntilDue: number;
  followUpCount: number;
}

export interface FollowUpBuckets {
  upcoming: FollowUpBucketEntry[];
  dueToday: FollowUpBucketEntry[];
  overdue: FollowUpBucketEntry[];
  gracePeriod: FollowUpBucketEntry[];
  finalWarning: FollowUpBucketEntry[];
  suspended: FollowUpBucketEntry[];
  paid: FollowUpBucketEntry[];
}

export interface CalendarEvent {
  date: string;
  type: 'due' | 'overdue' | 'suspension' | 'follow_up';
  tenantId: string;
  tenantName: string;
  invoiceNumber: string;
  amount?: number;
  status?: string;
  note?: string;
  assignedStaffName?: string;
}

export interface BillingCalendar {
  period: { month: number; year: number };
  events: CalendarEvent[];
}

export interface CalendarFilters {
  month: number;
  year: number;
  search?: string;
  planId?: string;
  status?: string;
  assignedStaffName?: string;
}

export interface BillingAnalytics {
  revenue: {
    mrr: number; arr: number; collectedThisYear: number; billedThisYear: number;
    outstanding: number; refunded: number; failedPayments: number;
    revenueByPlan: Record<string, number>;
    revenueByTenant: Record<string, number>;
  };
  subscriptions: {
    active: number; trial: number; gracePeriod: number; suspended: number; cancelled: number;
    newLast30Days: number; cancelledLast30Days: number; reactivatedLast30Days: number;
    trialConversionRate: number; churnRate: number; renewalRate: number;
  };
  payments: {
    collectionRate: number; onTimeRate: number; lateRate: number; failedRate: number; averagePaymentDelayDays: number;
  };
}

@Injectable({ providedIn: 'root' })
export class SuperAdminBillingService {
  private readonly http = inject(HttpClient);
  private readonly base = `${Environment.API_URL}/api/admin/billing`;

  private toParams(obj: object): HttpParams {
    let params = new HttpParams();
    Object.entries(obj as Record<string, unknown>).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params = params.set(k, String(v));
    });
    return params;
  }

  getOverview(filters: BillingOverviewFilters): Observable<{ success: boolean; data: BillingOverviewResponse }> {
    return this.http.get<{ success: boolean; data: BillingOverviewResponse }>(
      `${this.base}/tenants`, { params: this.toParams(filters) },
    );
  }

  getTenantDetail(tenantId: string): Observable<{ success: boolean; data: TenantBillingDetail }> {
    return this.http.get<{ success: boolean; data: TenantBillingDetail }>(`${this.base}/tenants/${tenantId}`);
  }

  getAuditLog(tenantId: string): Observable<{ success: boolean; data: AuditLogEntry[] }> {
    return this.http.get<{ success: boolean; data: AuditLogEntry[] }>(`${this.base}/tenants/${tenantId}/audit`);
  }

  updateConfig(tenantId: string, payload: BillingConfigPayload): Observable<{ success: boolean; message: string; data: SubscriptionDetail }> {
    return this.http.patch<{ success: boolean; message: string; data: SubscriptionDetail }>(
      `${this.base}/tenants/${tenantId}/config`, payload,
    );
  }

  changePlan(tenantId: string, planId: string): Observable<{ success: boolean; message: string; data: SubscriptionDetail }> {
    return this.http.post<{ success: boolean; message: string; data: SubscriptionDetail }>(
      `${this.base}/tenants/${tenantId}/change-plan`, { planId },
    );
  }

  cancelSubscription(tenantId: string, reason: string): Observable<{ success: boolean; message: string; data: SubscriptionDetail }> {
    return this.http.post<{ success: boolean; message: string; data: SubscriptionDetail }>(
      `${this.base}/tenants/${tenantId}/cancel`, { reason },
    );
  }

  recordPayment(tenantId: string, invoiceId: string, payload: RecordPaymentPayload): Observable<{ success: boolean; message: string; data: any }> {
    return this.http.post<{ success: boolean; message: string; data: any }>(
      `${this.base}/tenants/${tenantId}/invoices/${invoiceId}/payment`, payload,
    );
  }

  markPaymentFailed(tenantId: string, invoiceId: string, reason: string): Observable<{ success: boolean; message: string; data: InvoiceDetail }> {
    return this.http.post<{ success: boolean; message: string; data: InvoiceDetail }>(
      `${this.base}/tenants/${tenantId}/invoices/${invoiceId}/fail`, { reason },
    );
  }

  issueRefund(tenantId: string, invoiceId: string, payload: { amount: number; reason?: string }): Observable<{ success: boolean; message: string; data: InvoiceDetail }> {
    return this.http.post<{ success: boolean; message: string; data: InvoiceDetail }>(
      `${this.base}/tenants/${tenantId}/invoices/${invoiceId}/refund`, payload,
    );
  }

  addFollowUp(tenantId: string, invoiceId: string, payload: FollowUpPayload): Observable<{ success: boolean; message: string; data: InvoiceDetail }> {
    return this.http.post<{ success: boolean; message: string; data: InvoiceDetail }>(
      `${this.base}/tenants/${tenantId}/invoices/${invoiceId}/followup`, payload,
    );
  }

  updateFollowUpStatus(tenantId: string, invoiceId: string, followUpId: string, followUpStatus: FollowUpStatus): Observable<{ success: boolean; message: string; data: InvoiceDetail }> {
    return this.http.patch<{ success: boolean; message: string; data: InvoiceDetail }>(
      `${this.base}/tenants/${tenantId}/invoices/${invoiceId}/followup/${followUpId}`, { followUpStatus },
    );
  }

  waiveInvoice(tenantId: string, invoiceId: string): Observable<{ success: boolean; message: string; data: InvoiceDetail }> {
    return this.http.post<{ success: boolean; message: string; data: InvoiceDetail }>(
      `${this.base}/tenants/${tenantId}/invoices/${invoiceId}/waive`, {},
    );
  }

  reactivate(tenantId: string): Observable<{ success: boolean; message: string; data: { billingSuspended: boolean } }> {
    return this.http.post<{ success: boolean; message: string; data: { billingSuspended: boolean } }>(
      `${this.base}/tenants/${tenantId}/reactivate`, {},
    );
  }

  suspend(tenantId: string, reason?: string): Observable<{ success: boolean; message: string; data: { billingSuspended: boolean } }> {
    return this.http.post<{ success: boolean; message: string; data: { billingSuspended: boolean } }>(
      `${this.base}/tenants/${tenantId}/suspend`, { reason },
    );
  }

  sendReminder(tenantId: string, invoiceId: string): Observable<{ success: boolean; message: string; data: InvoiceDetail }> {
    return this.http.post<{ success: boolean; message: string; data: InvoiceDetail }>(
      `${this.base}/tenants/${tenantId}/invoices/${invoiceId}/remind`, {},
    );
  }

  applyAdjustment(tenantId: string, invoiceId: string, payload: AdjustmentPayload): Observable<{ success: boolean; message: string; data: InvoiceDetail }> {
    return this.http.post<{ success: boolean; message: string; data: InvoiceDetail }>(
      `${this.base}/tenants/${tenantId}/invoices/${invoiceId}/adjustment`, payload,
    );
  }

  downloadInvoicePdf(tenantId: string, invoiceId: string, mode: 'invoice' | 'receipt' = 'invoice'): Observable<Blob> {
    return this.http.get(`${this.base}/tenants/${tenantId}/invoices/${invoiceId}/pdf`, {
      params: this.toParams({ mode }), responseType: 'blob',
    });
  }

  getFollowUpBuckets(): Observable<{ success: boolean; data: FollowUpBuckets }> {
    return this.http.get<{ success: boolean; data: FollowUpBuckets }>(`${this.base}/follow-ups`);
  }

  getCalendar(filters: CalendarFilters): Observable<{ success: boolean; data: BillingCalendar }> {
    return this.http.get<{ success: boolean; data: BillingCalendar }>(`${this.base}/calendar`, { params: this.toParams(filters) });
  }

  getAnalytics(): Observable<{ success: boolean; data: BillingAnalytics }> {
    return this.http.get<{ success: boolean; data: BillingAnalytics }>(`${this.base}/analytics`);
  }
}
