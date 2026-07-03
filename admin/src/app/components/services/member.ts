import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Environment } from '../environment/environment';

export interface Member {
  id: string;
  tenantId: string;
  parentTenantId: string;
  rbacRoleId: string;
  rbacRoleName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  isSubUser: boolean;
  subUserStatus: 'invited' | 'active' | 'suspended';
  invitedAt: string;
  lastLogin: string | null;
  createdAt: string;
}

export interface InvitePayload {
  email: string;
  roleId: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface AssignPayload {
  email: string;
  roleId: string;
}

@Injectable({ providedIn: 'root' })
export class MemberService {
  private readonly base = `${Environment.API_URL}/api/tenant/members`;
  private readonly pubBase = `${Environment.API_URL}/api/members`;

  constructor(private http: HttpClient) { }

  listMembers(roleId?: string, status?: string): Observable<Member[]> {
    let params = new HttpParams();
    if (roleId) params = params.set('roleId', roleId);
    if (status) params = params.set('status', status);
    return this.http
      .get<{ success: boolean; data: Member[] }>(this.base, { params })
      .pipe(map(r => r.data));
  }

  invite(payload: InvitePayload): Observable<Member> {
    return this.http
      .post<{ success: boolean; data: Member }>(`${this.base}/invite`, payload)
      .pipe(map(r => r.data));
  }

  assign(payload: AssignPayload): Observable<Member> {
    return this.http
      .post<{ success: boolean; data: Member }>(`${this.base}/assign`, payload)
      .pipe(map(r => r.data));
  }

  reassignRole(memberId: string, roleId: string): Observable<Member> {
    return this.http
      .patch<{ success: boolean; data: Member }>(`${this.base}/${memberId}/role`, { roleId })
      .pipe(map(r => r.data));
  }

  setStatus(memberId: string, status: 'active' | 'suspended'): Observable<Member> {
    return this.http
      .patch<{ success: boolean; data: Member }>(`${this.base}/${memberId}/status`, { status })
      .pipe(map(r => r.data));
  }

  remove(memberId: string): Observable<{ success: boolean; message: string }> {
    return this.http.delete<{ success: boolean; message: string }>(`${this.base}/${memberId}`);
  }

  resendInvite(memberId: string): Observable<{ success: boolean; message: string }> {
    return this.http.post<{ success: boolean; message: string }>(
      `${this.base}/${memberId}/resend-invite`, {}
    );
  }

  acceptInvite(token: string, password: string, firstName: string, lastName: string) {
    return this.http.post<{ success: boolean; message: string }>(
      `${this.pubBase}/accept-invite`,
      { token, password, firstName, lastName }
    );
  }
}
