import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Environment } from '../environment/environment';

/** CRM → POS database sync health, as returned by the backend. */
export interface CrmSyncStatus {
  status             : 'never' | 'running' | 'success' | 'partial' | 'error';
  running            : boolean;
  lastStatus         : 'success' | 'partial' | 'error' | null;
  lastTrigger        : string | null;
  lastAttemptAt      : string | null;
  lastSuccessAt      : string | null;
  lastDurationMs     : number | null;
  lastError          : string | null;
  lastIssues         : string[];
  lastStats          : {
    fetched: number; crmReportedCount: number | null; inserted: number; updated: number;
    unchanged: number; restored: number; skipped: number; failed: number; markedDeleted: number;
  } | null;
  consecutiveFailures: number;
  storedQuotes?      : number;
  intervalMinutes?   : number;
}

export interface QuotesApiResponse {
  success   : boolean;
  message   : string;
  data      : {
    quotes    : any[];
    total     : number | null;
    startAfter: number;
    limit     : number;
    search    : string;
    sync?     : CrmSyncStatus | null;
  };
}

export interface QuoteSearchBody {
  search?    : string;
  limit?     : number;
  startAfter?: number;
  status?    : string;
  dateFrom?  : string;   // ISO date string  e.g. "2024-01-01"
  dateTo?    : string;   // ISO date string  e.g. "2024-12-31"
}

@Injectable({ providedIn: 'root' })
export class Crm {
  private readonly http = inject(HttpClient);
  private readonly base = Environment.API_URL ?? '';   // e.g. "https://api.yourapp.com"

  /** GET /tenant/quotes?search=&limit=&startAfter= */
  getQuotes(search = '', limit = 25, startAfter = 0): Observable<QuotesApiResponse> {
    const params = new HttpParams()
      .set('search',     search)
      .set('limit',      String(limit))
      .set('startAfter', String(startAfter));

    return this.http.get<QuotesApiResponse>(`${this.base}/tenant/quotes`, { params });
  }

  /** GET /tenant/quotes/:quoteId */
  getQuoteById(quoteId: string): Observable<any> {
    return this.http.get<any>(`${this.base}/tenant/quotes/${encodeURIComponent(quoteId)}`);
  }

  /**
   * POST /tenant/quotes/search
   * Advanced search with status, date-range, etc.
   */
  searchQuotes(body: QuoteSearchBody): Observable<QuotesApiResponse> {
    return this.http.post<QuotesApiResponse>(`${this.base}/tenant/quotes/search`, body);
  }

  /** GET /tenant/quotes/sync-status — last sync result, counts and errors. */
  getSyncStatus(): Observable<{ success: boolean; data: CrmSyncStatus }> {
    return this.http.get<{ success: boolean; data: CrmSyncStatus }>(`${this.base}/tenant/quotes/sync-status`);
  }

  /** POST /tenant/quotes/sync — pull every quote from the CRM into the POS now. */
  syncNow(): Observable<{ success: boolean; message: string; data: { status: CrmSyncStatus } }> {
    return this.http.post<{ success: boolean; message: string; data: { status: CrmSyncStatus } }>(
      `${this.base}/tenant/quotes/sync`, {});
  }
}
