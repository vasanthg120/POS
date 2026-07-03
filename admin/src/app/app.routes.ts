// src/app/app.routes.ts
import { Routes }                from '@angular/router';
import {
  authGuard,
  guestGuard,
  superAdminGuard,
  tenantGuard,
  rbacGuard,
}                                from './components/guards/auth-guard';
import { setupGuard }            from './components/guards/setup-guard';
import { Layout }                from './components/layout/layout';

export const routes: Routes = [

  // ── Homepage ───────────────────────────────────────────────────────────────
  {
    path         : '',
    loadComponent: () =>
      import('./components/homepage/homepage').then(m => m.Homepage),
    title        : 'Home',
  },

  // ── Auth (guest only) ──────────────────────────────────────────────────────
  {
    path       : 'auth',
    canActivate: [guestGuard],
    children   : [
      {
        path         : 'login',
        loadComponent: () =>
          import('./components/login/login').then(m => m.Login),
        title        : 'Sign In',
      },
      {
        path         : 'forgot-password',
        loadComponent: () =>
          import('./components/forgot-password/forgot-password')
            .then(m => m.ForgotPassword),
        title        : 'Reset Password',
      },
      {
        path         : 'reset-password',
        loadComponent: () =>
          import('./components/reset-password/reset-password')
            .then(m => m.ResetPassword),
        title        : 'New Password',
      },
      { path: '', redirectTo: 'login', pathMatch: 'full' },
    ],
  },

  // ── Email verification (public) ────────────────────────────────────────────
  {
    path         : 'verify-email',
    loadComponent: () =>
      import('./components/verify-email/verify-email').then(m => m.VerifyEmail),
    title        : 'Verify Email',
  },

  // ── Public payment page ────────────────────────────────────────────────────
  {
    path         : 'pay/:slug',
    loadComponent: () =>
      import('./components/payment-page/payment-page').then(m => m.PaymentPage),
    title        : 'Pay',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SUPERADMIN  /admin/*
  // ══════════════════════════════════════════════════════════════════════════
  {
    path       : 'admin',
    component  : Layout,
    canActivate: [superAdminGuard],
    children   : [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path         : 'dashboard',
        loadComponent: () =>
          import('./components/dashboard/dashboard').then(m => m.Dashboard),
        title        : 'Admin Dashboard',
      },
      {
        path         : 'tenants',
        loadComponent: () =>
          import('./components/addtenant/addtenant').then(m => m.AddTenant),
        title        : 'Manage Tenants',
      },
      {
        path         : 'payments',
        loadComponent: () =>
          import('./components/payments/payments').then(m => m.Payments),
        title        : 'All Payments',
      },
      {
        path         : 'quotations',
        loadComponent: () =>
          import('./components/quotations/quotations').then(m => m.Quotations),
        title        : 'All Quotations',
      },
      {
        path         : 'tracking',
        loadComponent: () =>
          import('./components/tracking/tracking').then(m => m.Tracking),
        title        : 'Tracking',
      },
      {
        path         : 'settings',
        loadComponent: () =>
          import('./components/settings/settings').then(m => m.Settings),
        title        : 'Admin Settings',
      },
      {
        path         : 'margin-calculator',
        loadComponent: () =>
          import('./components/margin-calculator/margin-calculator')
            .then(m => m.MarginCalculator),
        title        : 'Margin Calculator',
      },
      {
        path         : 'rbac',
        loadComponent: () =>
          import('./components/rbac/rbac').then(m => m.Rbac),
        title        : 'Roles & Permissions',
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TENANT + SUB-USER  (role === 'tenant' for both)
  // ══════════════════════════════════════════════════════════════════════════
  {
    path       : '',
    component  : Layout,
    canActivate: [tenantGuard],
    children   : [

      // ── Dashboard ─────────────────────────────────────────────────────────
      {
        path        : 'dashboard',
        canActivate : [setupGuard, rbacGuard],
        data        : { pageKey: 'dashboard' },
        loadComponent: () =>
          import('./components/dashboard/dashboard').then(m => m.Dashboard),
        title       : 'Dashboard',
      },

      // ── Payments ──────────────────────────────────────────────────────────
      {
        path        : 'payments',
        canActivate : [setupGuard, rbacGuard],
        data        : { pageKey: 'payments' },
        loadComponent: () =>
          import('./components/payments/payments').then(m => m.Payments),
        title       : 'Payment Status',
      },

      // ── Quotations ────────────────────────────────────────────────────────
      {
        path        : 'quotations',
        canActivate : [setupGuard, rbacGuard],
        data        : { pageKey: 'quotations' },
        loadComponent: () =>
          import('./components/quotations/quotations').then(m => m.Quotations),
        title       : 'Quotation Status',
      },

      // ── Tracking ──────────────────────────────────────────────────────────
      {
        path        : 'tracking',
        canActivate : [setupGuard, rbacGuard],
        data        : { pageKey: 'tracking' },
        loadComponent: () =>
          import('./components/tracking/tracking').then(m => m.Tracking),
        title       : 'Tracking',
      },

      // ── Margin Calculator ─────────────────────────────────────────────────
      {
        path        : 'margin-calculator',
        canActivate : [setupGuard, rbacGuard],
        data        : { pageKey: 'margin-calculator' },
        loadComponent: () =>
          import('./components/margin-calculator/margin-calculator')
            .then(m => m.MarginCalculator),
        title       : 'Margin Calculator',
      },

      // ── Settings — NO rbacGuard intentionally ─────────────────────────────
      // This is the safe fallback landing page for sub-users.
      // Adding rbacGuard here would cause an infinite redirect loop
      // when a sub-user has no 'settings' permission.
      {
        path        : 'settings',
        canActivate : [tenantGuard],
        loadComponent: () =>
          import('./components/settings/settings').then(m => m.Settings),
        title       : 'Settings',
      },

      // ── RBAC ──────────────────────────────────────────────────────────────
      {
        path        : 'rbac',
        canActivate : [rbacGuard],
        data        : { pageKey: 'settings' },
        loadComponent: () =>
          import('./components/rbac/rbac').then(m => m.Rbac),
        title       : 'Roles & Permissions',
      },
    ],
  },

  { path: '**', redirectTo: 'auth/login' },
];
