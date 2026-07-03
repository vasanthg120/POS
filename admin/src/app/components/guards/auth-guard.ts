// src/app/components/guards/auth-guard.ts
import { inject }                from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Auth }                  from '../services/auth';

// ── authGuard ─────────────────────────────────────────────────────────────────
export const authGuard: CanActivateFn = (route, state) => {
  const auth   = inject(Auth);
  const router = inject(Router);

  if (auth.isAuthenticated()) return true;

  router.navigate(['/auth/login'], { queryParams: { returnUrl: state.url } });
  return false;
};

// ── superAdminGuard ───────────────────────────────────────────────────────────
export const superAdminGuard: CanActivateFn = (_route, _state) => {
  const auth   = inject(Auth);
  const router = inject(Router);

  if (!auth.isAuthenticated()) {
    router.navigate(['/auth/login']);
    return false;
  }

  if (auth.isSuperAdmin()) return true;

  router.navigate(['/dashboard']);
  return false;
};

// ── tenantGuard ───────────────────────────────────────────────────────────────
// Allows both regular tenants AND sub-users (both have role === 'tenant').
export const tenantGuard: CanActivateFn = (_route, _state) => {
  const auth   = inject(Auth);
  const router = inject(Router);

  if (!auth.isAuthenticated()) {
    router.navigate(['/auth/login']);
    return false;
  }

  // Both tenant and sub-user pass here (role === 'tenant' for both)
  if (auth.isTenant()) return true;

  // Superadmin hitting a tenant route → their own space
  if (auth.isSuperAdmin()) {
    router.navigate(['/admin/dashboard']);
    return false;
  }

  router.navigate(['/auth/login']);
  return false;
};

// ── guestGuard ────────────────────────────────────────────────────────────────
export const guestGuard: CanActivateFn = (route, _state) => {
  const auth   = inject(Auth);
  const router = inject(Router);

  if (!auth.isAuthenticated()) return true;

  const returnUrl = route.queryParams['returnUrl'] ?? auth.resolveHome();
  router.navigateByUrl(returnUrl);
  return false;
};

// ── rbacGuard ─────────────────────────────────────────────────────────────────
// Blocks sub-users from pages outside their assigned permissions.
// Non-sub-users (full tenants, superadmins) always pass through.
//
// Add to routes as:  canActivate: [tenantGuard, rbacGuard]
//                    data: { pageKey: 'payments' }
//
export const rbacGuard: CanActivateFn = (route, _state) => {
  const auth   = inject(Auth);
  const router = inject(Router);

  const user = auth.currentUser();

  // Not logged in
  if (!user) {
    router.navigate(['/auth/login']);
    return false;
  }

  // Non-sub-users always pass — full access
  if (!user.isSubUser) return true;

  const pageKey = route.data?.['pageKey'] as string | undefined;

  // No pageKey on the route data → allow (fail open, conservative)
  if (!pageKey) return true;

  // Sub-user has view access → allow
  if (auth.canAccess(pageKey, 'view')) return true;

  // Sub-user does NOT have access → redirect to first allowed page.
  // Never redirect to /auth/login here — that creates a login loop.
  // Settings is the guaranteed safe fallback since sub-users always
  // get at minimum a 'settings view' from the invite.
  const allowed = auth.allowedPages();
  const first   = [
    'dashboard',
    'payments',
    'quotations',
    'tracking',
    'margin-calculator',
    'settings',
  ].find(p => allowed.has(p));

  // Use /settings as the absolute fallback — it's mounted without rbacGuard
  // in a plain canActivate: [tenantGuard] so it never loops
  router.navigate([first ? `/${first}` : '/settings']);
  return false;
};

