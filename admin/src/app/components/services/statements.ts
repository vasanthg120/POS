// src/app/services/statements.service.ts
import { Injectable }             from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable }             from 'rxjs';
import { Environment }            from '../environment/environment';

export interface PaymentSummary {
  currency        : string;
  totalCollected  : number;
  totalCount      : number;
  totalRefunds    : number;
  refundCount     : number;
  todayAmount     : number;
  monthAmount     : number;
  lastMonthAmount : number;
  momGrowth       : string | null;
  avgTicket       : number;
  methodBreakdown : Record<string, number>;
  dailyTrend      : { date: string; amount: number }[];
}

export interface Payment {
  id          : string;
  amount      : number;
  currency    : string;
  status      : 'captured' | 'failed' | 'refunded' | 'authorized';
  method      : 'card' | 'upi' | 'netbanking' | 'wallet' | 'emi';
  description : string;
  email       : string;
  contact     : string;
  createdAt   : number;
  fee         : number;
  tax         : number;
  orderId     : string;
  refundStatus: string | null;
  vpa         : string | null;
  bank        : string | null;
  wallet      : string | null;
  card        : { name: string; network: string; last4: string; type: string; issuer: string } | null;
  notes       : Record<string, string>;
  errorCode   : string | null;
  errorDesc   : string | null;
}

export interface Refund {
  id        : string;
  paymentId : string;
  amount    : number;
  currency  : string;
  status    : string;
  speed     : string;
  createdAt : number;
}

export interface PaymentSummary {
  currency        : string;
  totalCollected  : number;
  totalCount      : number;
  totalFees       : number;   // ← NEW
  totalRefunds    : number;
  refundCount     : number;
  todayAmount     : number;
  monthAmount     : number;
  lastMonthAmount : number;
  momGrowth       : string | null;
  avgTicket       : number;
  methodBreakdown : Record<string, number>;
  dailyTrend      : { date: string; amount: number }[];
}

@Injectable({ providedIn: 'root' })
export class Statements {
  private base = `${Environment.API_URL}/tenant/statements`;

  constructor(private http: HttpClient) {}

  getSummary(): Observable<any> {
    return this.http.get(`${this.base}/summary`);
  }

  getPayments(filters: {
    from?   : number;
    to?     : number;
    count?  : number;
    skip?   : number;
    status? : string;
    method? : string;
  } = {}): Observable<any> {
    let params = new HttpParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params = params.set(k, String(v));
    });
    return this.http.get(`${this.base}/payments`, { params });
  }

  getPaymentDetail(id: string): Observable<any> {
    return this.http.get(`${this.base}/payments/${id}`);
  }

  getRefunds(): Observable<any> {
    return this.http.get(`${this.base}/refunds`);
  }
}
