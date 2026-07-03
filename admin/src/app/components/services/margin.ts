import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, BehaviorSubject, tap } from 'rxjs';
import { Environment } from '../environment/environment';

/* ── Types ── */
export interface LineItemPayload {
  item     : string;
  qty      : number;
  unitCost : number;
  decoUnit : number;
  setup    : number;
  ship     : number;
  quoteUnit: number;
}

export interface MarginJobPayload {
  jobName    : string;
  setupCount : number;
  setupUnit  : number;
  shipping   : number;
  gstRate    : number;
  rows       : LineItemPayload[];
  summary    : Record<string, number>;
  status?    : 'draft' | 'finalised' | 'archived';
  tags?      : string[];
  notes?     : string;
}

export interface MarginJobRecord extends MarginJobPayload {
  _id      : string;
  createdAt: string;
  updatedAt: string;
  status   : 'draft' | 'finalised' | 'archived';
}

export interface ListMeta {
  page : number;
  limit: number;
  total: number;
  pages: number;
}

export interface ListResponse {
  success: boolean;
  data   : MarginJobRecord[];
  meta   : ListMeta;
}

export interface JobStats {
  totalJobs     : number;
  totalRevenue  : number;
  totalProfit   : number;
  avgMarginPct  : number;
  draftCount    : number;
  finalisedCount: number;
}

export interface ListQuery {
  page?  : number;
  limit? : number;
  status?: string;
  q?     : string;
}

@Injectable({ providedIn: 'root' })
export class Margin {
   private http = inject(HttpClient);
  private base = `${Environment.API_URL}/tenant/margin-jobs`;

  /* Reactive list cache — components subscribe to this */
  private _jobs$ = new BehaviorSubject<MarginJobRecord[]>([]);
  readonly jobs$ = this._jobs$.asObservable();

  private _meta$ = new BehaviorSubject<ListMeta>({ page: 1, limit: 20, total: 0, pages: 0 });
  readonly meta$ = this._meta$.asObservable();

  /* ── List ── */
  fetchJobs(query: ListQuery = {}): Observable<ListResponse> {
    let params = new HttpParams();
    if (query.page)   params = params.set('page',   query.page);
    if (query.limit)  params = params.set('limit',  query.limit);
    if (query.status) params = params.set('status', query.status);
    if (query.q)      params = params.set('q',      query.q);

    return this.http.get<ListResponse>(this.base, { params }).pipe(
      tap(res => {
        this._jobs$.next(res.data);
        this._meta$.next(res.meta);
      }),
    );
  }

  /* ── Single ── */
  getJob(id: string): Observable<{ success: boolean; data: MarginJobRecord }> {
    return this.http.get<{ success: boolean; data: MarginJobRecord }>(`${this.base}/${id}`);
  }

  /* ── Create ── */
  createJob(payload: MarginJobPayload): Observable<{ success: boolean; data: MarginJobRecord }> {
    return this.http.post<{ success: boolean; data: MarginJobRecord }>(this.base, payload).pipe(
      tap(res => {
        const current = this._jobs$.getValue();
        this._jobs$.next([res.data, ...current]);
      }),
    );
  }

  /* ── Update (autosave) ── */
  updateJob(id: string, payload: Partial<MarginJobPayload>): Observable<{ success: boolean; data: MarginJobRecord }> {
    return this.http.put<{ success: boolean; data: MarginJobRecord }>(`${this.base}/${id}`, payload).pipe(
      tap(res => this._replaceInList(res.data)),
    );
  }

  /* ── Status ── */
  setStatus(id: string, status: 'draft' | 'finalised' | 'archived'): Observable<{ success: boolean; data: MarginJobRecord }> {
    return this.http.patch<{ success: boolean; data: MarginJobRecord }>(`${this.base}/${id}/status`, { status }).pipe(
      tap(res => this._replaceInList(res.data)),
    );
  }

  /* ── Delete (soft) ── */
  deleteJob(id: string): Observable<{ success: boolean; message: string }> {
    return this.http.delete<{ success: boolean; message: string }>(`${this.base}/${id}`).pipe(
      tap(() => this._jobs$.next(this._jobs$.getValue().filter(j => j._id !== id))),
    );
  }

  /* ── Duplicate ── */
  duplicateJob(id: string): Observable<{ success: boolean; data: MarginJobRecord }> {
    return this.http.post<{ success: boolean; data: MarginJobRecord }>(`${this.base}/${id}/duplicate`, {}).pipe(
      tap(res => {
        const current = this._jobs$.getValue();
        this._jobs$.next([res.data, ...current]);
      }),
    );
  }

  /* ── Stats ── */
  getStats(): Observable<{ success: boolean; data: JobStats }> {
    return this.http.get<{ success: boolean; data: JobStats }>(`${this.base}/stats/summary`);
  }

  /* ── Internal helpers ── */
  private _replaceInList(updated: MarginJobRecord): void {
    this._jobs$.next(
      this._jobs$.getValue().map(j => j._id === updated._id ? updated : j),
    );
  }
}
