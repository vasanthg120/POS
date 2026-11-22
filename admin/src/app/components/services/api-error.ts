import { HttpErrorResponse } from '@angular/common/http';

/**
 * True when an API call was answered with an HTML page instead of JSON.
 *
 * That happens when the reverse proxy does not forward the API path to the
 * backend and serves the Angular index.html instead (GET → 200 text/html,
 * which HttpClient reports as "Http failure during parsing") or nginx's own
 * error page (POST → 405 text/html). On pos.pantheras.io this silently
 * emptied the Tracking page, because only /api/ was proxied.
 */
export function isHtmlInsteadOfJson(err: unknown): boolean {
  const e = err as HttpErrorResponse | undefined;
  const body: unknown = (e?.error as any)?.text ?? e?.error;
  return typeof body === 'string' && /^\s*</.test(body);
}

/** A readable message for a failed API call — never "Http failure during parsing". */
export function describeHttpError(err: unknown, fallback: string): string {
  const e = err as HttpErrorResponse | undefined;
  if (isHtmlInsteadOfJson(e)) {
    const path = e?.url ? new URL(e.url, 'http://x').pathname : 'this API';
    return `The server answered ${path} with a web page instead of data — the request is not ` +
           `reaching the POS backend. Check the server's proxy routing for this path.`;
  }
  if (e?.status === 0) return 'Cannot reach the POS server. Check your connection and try again.';
  const serverMessage = (e?.error as any)?.message;
  if (typeof serverMessage === 'string' && serverMessage) return serverMessage;
  return e?.status ? `${fallback.replace(/\.$/, '')} (HTTP ${e.status}).` : fallback;
}
