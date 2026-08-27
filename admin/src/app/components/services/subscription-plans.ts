import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Environment } from '../environment/environment';

export interface SubscriptionPlan {
  _id: string;
  name: string;
  slug: string;
  description: string;
  monthlyPrice: number;
  gstPercent: number;
  trialDays: number;
  gracePeriodDays: number | null;
  features: string[];
  isActive: boolean;
  createdAt: string;
}

export interface PlanPayload {
  name: string;
  description?: string;
  monthlyPrice: number;
  gstPercent?: number;
  trialDays?: number;
  gracePeriodDays?: number | null;
  features?: string[];
}

@Injectable({ providedIn: 'root' })
export class SubscriptionPlansService {
  private readonly http = inject(HttpClient);
  private readonly base = `${Environment.API_URL}/api/admin/billing/plans`;

  list(includeInactive = false): Observable<{ success: boolean; data: SubscriptionPlan[] }> {
    return this.http.get<{ success: boolean; data: SubscriptionPlan[] }>(
      `${this.base}${includeInactive ? '?includeInactive=true' : ''}`,
    );
  }

  create(payload: PlanPayload): Observable<{ success: boolean; message: string; data: SubscriptionPlan }> {
    return this.http.post<{ success: boolean; message: string; data: SubscriptionPlan }>(this.base, payload);
  }

  update(planId: string, payload: Partial<PlanPayload>): Observable<{ success: boolean; message: string; data: SubscriptionPlan }> {
    return this.http.patch<{ success: boolean; message: string; data: SubscriptionPlan }>(`${this.base}/${planId}`, payload);
  }

  setStatus(planId: string, isActive: boolean): Observable<{ success: boolean; message: string; data: SubscriptionPlan }> {
    return this.http.patch<{ success: boolean; message: string; data: SubscriptionPlan }>(`${this.base}/${planId}/status`, { isActive });
  }
}
