import { RenderMode, ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [

  // Dynamic payment pages
  {
    path: 'pay/:slug',
    renderMode: RenderMode.Server
  },

  // Dynamic tenant detail page (superadmin) — one page per tenantId, can't
  // be enumerated at build time
  {
    path: 'admin/tenants/:tenantId',
    renderMode: RenderMode.Server
  },

  // Everything else prerendered
  {
    path: '**',
    renderMode: RenderMode.Prerender
  }
];
