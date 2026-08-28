import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Environment } from '../environment/environment';

export interface BillingSettings {
  _id: string;
  defaultGstPercent: number;
  defaultGracePeriodDays: number;
  reminderDaysBeforeDue: number[];
  reminderDaysOverdue: number[];
  invoiceNumberPrefix: string;
  companyLegalName: string;
  companyGSTIN: string;
  companyAddress: string;
  companyLogoUrl: string;
  createdAt: string;
  updatedAt: string;
}

export type BillingSettingsPayload = Partial<Omit<BillingSettings, '_id' | 'createdAt' | 'updatedAt'>>;

@Injectable({ providedIn: 'root' })
export class BillingSettingsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${Environment.API_URL}/api/admin/billing/settings`;

  get(): Observable<{ success: boolean; data: BillingSettings }> {
    return this.http.get<{ success: boolean; data: BillingSettings }>(this.base);
  }

  update(payload: BillingSettingsPayload): Observable<{ success: boolean; message: string; data: BillingSettings }> {
    return this.http.patch<{ success: boolean; message: string; data: BillingSettings }>(this.base, payload);
  }
}
