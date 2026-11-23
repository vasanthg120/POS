import { Injectable, signal, inject, PLATFORM_ID } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, throwError } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { isPlatformBrowser } from '@angular/common';
import { Environment } from '../environment/environment';

// ── Interfaces ────────────────────────────────────────────────────────────────
// 'tenant' is the primary role assigned by superadmin via the console.
// 'owner', 'admin', 'staff' are legacy roles kept for backwards compatibility.
export type UserRole = 'superadmin' | 'tenant' | 'owner' | 'admin' | 'staff';

export interface RbacPermission {
  pageKey: string;
  actions: string[];
}

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  tenantId: string;
  businessName?: string;
  city?: string;
  currency?: string;
  setupStep?: string;
  paymentPageUrl?: string;
  paymentPageSlug?: string;

  // Sub-user fields
  isSubUser?: boolean;
  parentTenantId?: string;
  rbacRoleId?: string;
  rbacRoleName?: string;
  subUserStatus?: 'active' | 'suspended' | null;
  permissions?: RbacPermission[];
}

export interface TenantUser extends User {
  businessAddress?: string;
  gstNumber?: string;
  timezone?: string;
  phone?: string;
  setupStep: 'business' | 'razorpay' | 'crm' | 'complete';
}

export interface TenantInfo {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  businessName?: string;
  businessAddress?: string;
  city?: string;
  currency: string;
  gstNumber?: string;
  timezone?: string;
  role: UserRole;
  setupStep: 'business' | 'razorpay' | 'crm' | 'complete';
  paymentPageUrl?: string;
  paymentPageSlug?: string;
  razorpay: { isConfigured: boolean };
  crm: { isConfigured: boolean; provider?: string };
}

export interface AuthState {
  user: TenantUser | null;
  accessToken: string | null;
  expiresAt: number | null;
}

// ── Storage keys ──────────────────────────────────────────────────────────────
const KEYS = {
  TOKEN  : 'pos_token',
  USER   : 'pos_user',
  EXPIRES: 'pos_expires',
  TENANT : 'pos_tenant',
} as const;

// ── Role constants ────────────────────────────────────────────────────────────
const TENANT_ROLES: ReadonlySet<UserRole> = new Set([
  'tenant',
  'owner',
  'admin',
  'staff',
]);

/**
 * The superadmin's tenantId as stored in MongoDB.
 * Sub-users created by the superadmin will have parentTenantId === this value.
 * This is the single source of truth for distinguishing superadmin sub-users
 * from tenant sub-users in the frontend.
 */
const SUPERADMIN_TENANT_ID = 'SUPERADMIN';

@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly api = `${Environment.API_URL}/api`;

  private platformId = inject(PLATFORM_ID);

  private get isBrowser(): boolean {
    return isPlatformBrowser(this.platformId);
  }

  // ── Reactive state ─────────────────────────────────────────────────────────
  private _state = new BehaviorSubject<AuthState>({
    user       : null,
    accessToken: null,
    expiresAt  : null,
  });

  state$      = this._state.asObservable();
  user$       = this.state$.pipe(map((s) => s.user));
  isLoggedIn$ = this.state$.pipe(map((s) => !!s.accessToken));

  // Signals for template / guard consumption
  currentUser   = signal<TenantUser | null>(null);
  currentTenant = signal<TenantInfo | null>(null);

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private http  : HttpClient,
    private router: Router,
  ) {
    this.restoreSession();
  }

  // ── Role helpers ───────────────────────────────────────────────────────────

  /** Returns true if a user is authenticated with a valid token. */
  isAuthenticated(): boolean {
    return !!this._state.value.accessToken;
  }

  /**
   * Returns true ONLY for the organisation Super Admin account itself. Team
   * members are never role 'superadmin' (the backend enforces this too); the
   * isSubUser check is belt-and-braces for a stale or edited session.
   */
  isSuperAdmin(): boolean {
    const user = this._state.value.user;
    return user?.role === 'superadmin' && user?.isSubUser !== true;
  }

  /** Returns true for any regular tenant user. */
  isTenant(): boolean {
    const role = this._state.value.user?.role;
    return !!role && TENANT_ROLES.has(role);
  }

  /** Returns true if current user is a sub-user. */
  isSubUser(): boolean {
    return this.currentUser()?.isSubUser === true;
  }

  /**
   * Returns true if the current sub-user was created by the superadmin.
   * Determined by parentTenantId === SUPERADMIN_TENANT_ID.
   * Always false for non-sub-users.
   */
  isUnderSuperAdmin(): boolean {
    const user = this.currentUser();
    if (!user?.isSubUser) return false;
    return user.parentTenantId === SUPERADMIN_TENANT_ID;
  }

  /**
   * Returns the set of page keys this user is allowed to view in the sidebar
   * and via route guards.
   *
   * Rules:
   *  ┌─────────────────────────────────────────────────────────────────┐
   *  │ Organisation Super Admin account                                │
   *  │   → Everything, including 'tenants' (Tenant Management)         │
   *  ├─────────────────────────────────────────────────────────────────┤
   *  │ Tenant owner (not a sub-user)                                   │
   *  │   → All tenant pages; never 'tenants'                           │
   *  ├─────────────────────────────────────────────────────────────────┤
   *  │ Any sub-user (staff of a tenant OR of the Super Admin)          │
   *  │   → Exactly what their RBAC role grants; never 'tenants'.       │
   *  │     Tenant Management is not grantable through RBAC — the       │
   *  │     backend strips it from roles and tokens and refuses every   │
   *  │     /api/admin call from anyone but the Super Admin account.    │
   *  └─────────────────────────────────────────────────────────────────┘
   */
  allowedPages(): Set<string> {
    const user = this.currentUser();

    if (!user) return new Set();

    // ── Non-sub-users: full access ─────────────────────────────────────────
    if (!user.isSubUser) {
      const pages = new Set([
        'dashboard',
        'payments',
        'quotations',
        'tracking',
        'margin-calculator',
        'royalty',
        'billing',
        'settings',
      ]);
      if (this.isSuperAdmin()) pages.add('tenants');
      return pages;
    }

    // ── All sub-users: resolve from their assigned RBAC permissions ─────────
    const perms   = user.permissions ?? [];
    const allowed = new Set(
      perms
        .filter(p => p.actions.includes('view'))
        .map(p => p.pageKey),
    );

    // ── No sub-user ever gets Tenant Management, whatever the role data says ─
    allowed.delete('tenants');

    return allowed;
  }

  /** Check page + action permission */
  canAccess(
    pageKey: string,
    action: 'view' | 'create' | 'edit' | 'delete' | 'export' = 'view',
  ): boolean {
    const user = this.currentUser();

    if (!user) return false;

    // Tenant Management belongs to the Super Admin account alone.
    if (pageKey === 'tenants') return this.isSuperAdmin();

    // Full access for tenant/superadmin owners
    if (!user.isSubUser) return true;

    const perms = user.permissions ?? [];

    return perms.some(
      (p) => p.pageKey === pageKey && p.actions.includes(action),
    );
  }

  /** Returns true if the current user has the exact given role. */
  hasRole(role: UserRole): boolean {
    return this._state.value.user?.role === role;
  }

  get accessToken(): string | null {
    return this._state.value.accessToken;
  }

  // ── Routing helper ─────────────────────────────────────────────────────────

  /**
   * Resolve post-login route.
   */
  resolveHome(returnUrl = '/dashboard'): string {
    if (this.isSuperAdmin()) {
      return '/admin/dashboard';
    }

    // Prevent tenant entering admin routes
    if (returnUrl.startsWith('/admin')) {
      return '/dashboard';
    }

    return returnUrl;
  }

  // ── Auth actions ───────────────────────────────────────────────────────────

  login(email: string, password: string): Observable<any> {
    return this.http
      .post<any>(
        `${this.api}/auth/login`,
        { email, password },
        { withCredentials: true },
      )
      .pipe(
        tap((res) => {
          this.saveSession(res.accessToken, res.user, res.expiresIn);

          if (res.tenant) {
            this.currentTenant.set(res.tenant);
          }
        }),
        catchError(this.handleError),
      );
  }

  forgotPassword(email: string): Observable<any> {
    return this.http
      .post(`${this.api}/auth/forgot-password`, { email })
      .pipe(catchError(this.handleError));
  }

  resetPassword(
    token: string,
    password: string,
    confirmPassword: string,
  ): Observable<any> {
    return this.http
      .post(`${this.api}/auth/reset-password`, {
        token,
        password,
        confirmPassword,
      })
      .pipe(catchError(this.handleError));
  }

  verifyEmail(token: string): Observable<any> {
    return this.http
      .get(`${this.api}/auth/verify-email?token=${token}`)
      .pipe(catchError(this.handleError));
  }

  resendVerification(email: string): Observable<any> {
    return this.http
      .post(`${this.api}/auth/resend-verification`, { email })
      .pipe(catchError(this.handleError));
  }

  logout(): Observable<any> {
    return this.http
      .post(
        `${this.api}/auth/logout`,
        {},
        { withCredentials: true },
      )
      .pipe(
        tap(() => {
          this.clearSession();
          this.router.navigate(['/auth/login']);
        }),
        catchError(() => {
          this.clearSession();
          this.router.navigate(['/auth/login']);
          return throwError(() => new Error('Logout error'));
        }),
      );
  }

  /**
   * Ends the session locally after the backend refused the account itself
   * (disabled, suspended, billing-suspended, or deleted) and sends the user to
   * sign-in with the reason. Not a logout call: the server has already revoked
   * the session.
   */
  endSessionForAccountState(code: string): void {
    if (!this._state.value.accessToken) return;
    this.clearSession();
    this.router.navigate(['/auth/login'], { queryParams: { session: code.toLowerCase() } });
  }

  silentRefresh(): void {
    this.http
      .post<any>(
        `${this.api}/auth/refresh`,
        {},
        { withCredentials: true },
      )
      .subscribe({
        next: (res) => {
          const user = this._state.value.user;
          if (!user) {
            this.clearSession();
            return;
          }
          this.saveSession(res.accessToken, user, res.expiresIn);
        },
        error: () => {
          this.clearSession();
          this.router.navigate(['/auth/login'], {
            queryParams: { session: 'expired' },
          });
        },
      });
  }

  refreshTenantInfo(): Observable<any> {
    return this.http.get<any>(`${this.api}/tenant/settings`).pipe(
      tap((res) => {
        if (res.success) {
          this.currentTenant.set(res.data);
        }
      }),
      catchError(this.handleError),
    );
  }

  // ── Session helpers ────────────────────────────────────────────────────────

  private saveSession(
    token    : string,
    user     : TenantUser,
    expiresIn: string,
  ): void {
    if (!this.isBrowser) return;

    const expiresAt = Date.now() + this.parseDuration(expiresIn);

    sessionStorage.setItem(KEYS.TOKEN,   token);
    sessionStorage.setItem(KEYS.USER,    JSON.stringify(user));
    sessionStorage.setItem(KEYS.EXPIRES, String(expiresAt));

    this._state.next({ user, accessToken: token, expiresAt });
    this.currentUser.set(user);
    this.scheduleRefresh(expiresAt);
  }

  private clearSession(): void {
    if (!this.isBrowser) return;

    Object.values(KEYS).forEach((key) => sessionStorage.removeItem(key));

    if (this.refreshTimer) clearTimeout(this.refreshTimer);

    this._state.next({ user: null, accessToken: null, expiresAt: null });
    this.currentUser.set(null);
    this.currentTenant.set(null);
  }

  private restoreSession(): void {
    if (!this.isBrowser) return;

    const token     = sessionStorage.getItem(KEYS.TOKEN);
    const userJson  = sessionStorage.getItem(KEYS.USER);
    const expiresAt = Number(sessionStorage.getItem(KEYS.EXPIRES));

    if (token && userJson && expiresAt > Date.now()) {
      const user = JSON.parse(userJson) as TenantUser;
      this._state.next({ user, accessToken: token, expiresAt });
      this.currentUser.set(user);
      this.scheduleRefresh(expiresAt);
    } else {
      this.clearSession();
    }
  }

  private scheduleRefresh(expiresAt: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);

    // Refresh 1 minute before expiry
    const delay = expiresAt - Date.now() - 60_000;

    if (delay <= 0) {
      this.silentRefresh();
      return;
    }

    this.refreshTimer = setTimeout(() => this.silentRefresh(), delay);
  }

  private parseDuration(duration: string): number {
    const map: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };

    const match = duration?.match(/^(\d+)([smhd])$/);
    if (!match) return 15 * 60_000;

    const value = parseInt(match[1], 10);
    const unit  = match[2];
    return value * (map[unit] || 60_000);
  }

  private handleError = (error: HttpErrorResponse): Observable<never> => {
    const msg = error.error?.message || 'An unexpected error occurred.';
    return throwError(() => ({ ...error.error, message: msg }));
  };
}
