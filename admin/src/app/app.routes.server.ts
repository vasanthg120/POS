import { RenderMode, ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [

  // Dynamic payment pages
  {
    path: 'pay/:slug',
    renderMode: RenderMode.Server
  },

  // Everything else prerendered
  {
    path: '**',
    renderMode: RenderMode.Prerender
  }
];
