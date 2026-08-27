import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Environment } from '../environment/environment';
import { SubscriptionDetail } from './billing';

export interface MyBillingResponse {
  tenant: { tenantId: string; businessName: string; billingSuspended: boolean };
  subscription: SubscriptionDetail;
}

@Injectable({ providedIn: 'root' })
export class TenantBillingService {
  private readonly http = inject(HttpClient);
  private readonly base = `${Environment.API_URL}/api/tenant/billing`;

  getMyBilling(): Observable<{ success: boolean; data: MyBillingResponse }> {
    return this.http.get<{ success: boolean; data: MyBillingResponse }>(this.base);
  }

  downloadInvoicePdf(invoiceId: string, mode: 'invoice' | 'receipt' = 'invoice'): Observable<Blob> {
    return this.http.get(`${this.base}/invoices/${invoiceId}/pdf`, {
      params: { mode }, responseType: 'blob',
    });
  }
}
