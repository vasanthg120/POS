// guards/setup.guard.ts
// Redirects tenant users to /settings until their setup is complete.
// Does NOT affect superadmin routes.

import { inject }              from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Auth }                from '../services/auth';

export const setupGuard: CanActivateFn = (route) => {
  const auth   = inject(Auth);
  const router = inject(Router);

  // Only applies to regular tenant users
  if (!auth.isTenant()) return true;

  const tenant = auth.currentTenant();

  // If tenant info hasn't loaded yet, allow navigation
  // (auth guard already ensures they're authenticated)
  if (!tenant) return true;

  // If setup is already complete, allow all routes
  if (tenant.setupStep === 'complete') return true;

  // Allow access to /settings so they can complete setup
  const targetPath = route.routeConfig?.path ?? '';
  if (targetPath === 'settings') return true;

  // Redirect everything else to settings with a hint param
  return router.createUrlTree(['/settings'], {
    queryParams: { setup: tenant.setupStep },
  });
};
