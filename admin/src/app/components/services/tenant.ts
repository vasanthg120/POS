import { Injectable }             from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, tap }        from 'rxjs';
import { Environment }            from '../environment/environment';
import { Auth, TenantInfo }       from './auth';

export interface BusinessInfo { businessName?:string; businessAddress?:string; city?:string; currency?:string; gstNumber?:string; timezone?:string; phone?:string; }
export interface RazorpayCredentials { keyId:string; keySecret:string; webhookSecret?:string; }
export interface CRMCredentials { apiKey:string; apiUrl:string; provider:string; }

@Injectable({ providedIn: 'root' })
export class Tenant {
  // ✅ FIXED: was `/tenant` — missing `/api/` prefix caused changePassword,
  // getPayments, and any route only in routes/index.js to 404 or refuse connection
  private base = `${Environment.API_URL}/api/tenant`;

  constructor(private http: HttpClient, private auth: Auth) {}

  private sync(res: any): void { if (res?.success && res?.data) this.auth.currentTenant.set(res.data as TenantInfo); }

  getSettings(): Observable<any>         { return this.http.get(`${this.base}/settings`).pipe(tap(r => this.sync(r))); }
  updateBusinessInfo(data: BusinessInfo): Observable<any> { return this.http.patch(`${this.base}/settings/business`, data).pipe(tap(r => this.sync(r))); }
  saveRazorpayCredentials(creds: RazorpayCredentials): Observable<any> { return this.http.post(`${this.base}/settings/razorpay`, creds).pipe(tap(r => this.sync(r))); }
  removeRazorpayCredentials(): Observable<any> { return this.http.delete(`${this.base}/settings/razorpay`).pipe(tap(r => this.sync(r))); }
  saveCRMCredentials(creds: CRMCredentials): Observable<any> { return this.http.post(`${this.base}/settings/crm`, creds).pipe(tap(r => this.sync(r))); }
  removeCRMCredentials(): Observable<any> { return this.http.delete(`${this.base}/settings/crm`).pipe(tap(r => this.sync(r))); }
  testCRMConnection(): Observable<any>   { return this.http.post(`${this.base}/settings/crm/test`, {}); }
  changePassword(currentPassword: string, newPassword: string): Observable<any> {
    return this.http.patch(`${this.base}/settings/password`, { currentPassword, newPassword });
  }
  getQuotes(search = '', limit = 200, startAfter = 0): Observable<any> {
    const params = new HttpParams().set('search', search).set('limit', String(limit)).set('startAfter', String(startAfter));
    return this.http.get(`${this.base}/quotes`, { params });
  }
  getPayments(filters: Record<string, any> = {}): Observable<any> {
    let params = new HttpParams();
    Object.entries(filters).forEach(([k,v]) => { if (v !== undefined && v !== null && v !== '') params = params.set(k, String(v)); });
    return this.http.get(`${this.base}/payments`, { params });
  }
}
