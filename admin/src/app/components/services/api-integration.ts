import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Environment } from '../environment/environment';

/** A key as the backend describes it — never includes the key itself. */
export interface ApiKeyInfo {
  id: string;
  keyId: string;
  name: string;
  integration: string;
  status: 'active' | 'revoked';
  /** e.g. pos_live_1a2b3c4d5e6f7a8b_••••••••••••x9Yz */
  maskedKey: string;
  scopes: string[];
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: 'revoked' | 'regenerated' | 'tenant_deleted' | null;
}

export interface ApiKeyStatus {
  status: 'active' | 'revoked' | 'none';
  key: ApiKeyInfo | null;
  integration: string;
  /** Path of the integration API on this server, e.g. "/api/v1". */
  basePath: string;
  /** The full key — present ONLY in the generate / regenerate responses. */
  apiKey?: string;
}

interface Envelope<T> { success: boolean; message: string; data: T; }

/** Settings → API Integration (Haive AI Agent). Account owners only. */
@Injectable({ providedIn: 'root' })
export class ApiIntegration {
  private readonly http = inject(HttpClient);
  private readonly base = `${Environment.API_URL}/api/tenant/integrations/api-key`;

  /** Public base URL Haive calls, e.g. https://pos.pantheras.io/api/v1 */
  readonly apiBaseUrl = `${Environment.API_URL}/api/v1`;

  getStatus(): Observable<Envelope<ApiKeyStatus>> {
    return this.http.get<Envelope<ApiKeyStatus>>(this.base);
  }

  generate(): Observable<Envelope<ApiKeyStatus>> {
    return this.http.post<Envelope<ApiKeyStatus>>(this.base, {});
  }

  regenerate(): Observable<Envelope<ApiKeyStatus>> {
    return this.http.post<Envelope<ApiKeyStatus>>(`${this.base}/regenerate`, {});
  }

  revoke(): Observable<Envelope<ApiKeyStatus>> {
    return this.http.delete<Envelope<ApiKeyStatus>>(this.base);
  }
}
