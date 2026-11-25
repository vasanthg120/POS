import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Only public pages are rendered on the server. Every signed-in page renders
 * in the browser (RenderMode.Client): the session lives in sessionStorage,
 * which the server can't see, so a server or prerender pass ran the auth
 * guards as "signed out" and baked a redirect to /auth/login into the page.
 * Opening or reloading /admin/billing, /admin/royalty or any other signed-in
 * URL then bounced to the login page and on to the dashboard.
 *
 * Production nginx (admin/nginx.conf) falls back to index.csr.html — the
 * client shell — for every path that has no prerendered file.
 */
export const serverRoutes: ServerRoute[] = [

  // ── Public pages ────────────────────────────────────────────────────────
  { path: '',                      renderMode: RenderMode.Prerender },
  { path: 'auth/login',            renderMode: RenderMode.Prerender },
  { path: 'auth/forgot-password',  renderMode: RenderMode.Prerender },
  { path: 'auth/reset-password',   renderMode: RenderMode.Prerender },
  { path: 'verify-email',          renderMode: RenderMode.Prerender },

  // Customer payment pages — one per tenant slug, rendered on request.
  { path: 'pay/:slug',             renderMode: RenderMode.Server },

  // ── Everything else needs a signed-in session ───────────────────────────
  { path: '**',                    renderMode: RenderMode.Client },
];
