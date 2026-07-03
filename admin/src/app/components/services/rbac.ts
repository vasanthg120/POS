import { Injectable }              from '@angular/core';
import { HttpClient, HttpParams }  from '@angular/common/http';
import { Observable }              from 'rxjs';
import { map }                     from 'rxjs/operators';
import { Environment }             from '../environment/environment';
import { PagePermission }          from '../rbac/rbac';

export interface ApiRole {
  id          : string;
  name        : string;
  slug        : string;
  description : string;
  color       : string;
  isSystem    : boolean;
  permissions : PagePermission[];
  memberCount : number;
  createdAt   : string;
  updatedAt   : string;
}

export interface ApiAuditEntry {
  id            : string;
  roleId        : string;
  roleName      : string;
  actorName     : string;
  actorInitials : string;
  actorColor    : string;
  action        : string;
  detail        : string;
  createdAt     : string;
}

export interface RolePayload {
  name        : string;
  description : string;
  color       : string;
  permissions : PagePermission[];
}

@Injectable({ providedIn: 'root' })
export class RbacService {
  private readonly base = `${Environment.API_URL}/api/tenant/rbac/roles`;

  constructor(private http: HttpClient) {}

  getRoles(query?: string): Observable<ApiRole[]> {
    let params = new HttpParams();
    if (query?.trim()) params = params.set('q', query.trim());
    return this.http
      .get<{ success: boolean; data: ApiRole[] }>(this.base, { params })
      .pipe(map(r => r.data));
  }

  createRole(payload: RolePayload): Observable<ApiRole> {
    return this.http
      .post<{ success: boolean; data: ApiRole }>(this.base, payload)
      .pipe(map(r => r.data));
  }

  updateRole(id: string, payload: Partial<RolePayload>): Observable<ApiRole> {
    return this.http
      .patch<{ success: boolean; data: ApiRole }>(`${this.base}/${id}`, payload)
      .pipe(map(r => r.data));
  }

  deleteRole(id: string): Observable<{ success: boolean; message: string }> {
    return this.http.delete<{ success: boolean; message: string }>(`${this.base}/${id}`);
  }

  duplicateRole(id: string): Observable<ApiRole> {
    return this.http
      .post<{ success: boolean; data: ApiRole }>(`${this.base}/${id}/duplicate`, {})
      .pipe(map(r => r.data));
  }

  getAuditLog(roleId: string): Observable<ApiAuditEntry[]> {
    return this.http
      .get<{ success: boolean; data: ApiAuditEntry[] }>(`${this.base}/${roleId}/audit`)
      .pipe(map(r => r.data));
  }
}
