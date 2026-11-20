import { HttpErrorResponse } from '@angular/common/http';

import { describeHttpError, isHtmlInsteadOfJson } from './api-error';

const INDEX_HTML = '<!DOCTYPE html><html lang="en"><head><title>Home</title></head><body></body></html>';

describe('api-error', () => {
  it('names an HTML page served for a GET (HttpClient JSON parse failure, status 200)', () => {
    // Shape HttpClient produces when a 200 body is not valid JSON.
    const err = new HttpErrorResponse({
      error: { error: new SyntaxError('Unexpected token <'), text: INDEX_HTML },
      status: 200, statusText: 'OK',
      url: 'https://pos.pantheras.io/tenant/quotes',
    });
    expect(isHtmlInsteadOfJson(err)).toBe(true);
    const msg = describeHttpError(err, 'Could not load quotations.');
    expect(msg).toContain('/tenant/quotes');
    expect(msg).toContain('not reaching the POS backend');
  });

  it("names nginx's HTML 405 page for a POST", () => {
    const err = new HttpErrorResponse({
      error: '<html>\r\n<head><title>405 Not Allowed</title></head></html>',
      status: 405, statusText: 'Not Allowed',
      url: 'https://pos.pantheras.io/tenant/quotes/sync',
    });
    expect(isHtmlInsteadOfJson(err)).toBe(true);
    expect(describeHttpError(err, 'CRM sync failed.')).toContain('/tenant/quotes/sync');
  });

  it("shows the backend's own message for a JSON error", () => {
    const err = new HttpErrorResponse({
      error: { success: false, code: 'CRM_ERROR', message: 'CRM sync failed: CRM rejected the API key (401).' },
      status: 502, url: 'https://pos.pantheras.io/tenant/quotes',
    });
    expect(isHtmlInsteadOfJson(err)).toBe(false);
    expect(describeHttpError(err, 'x')).toBe('CRM sync failed: CRM rejected the API key (401).');
  });

  it('reports a network failure (status 0)', () => {
    const err = new HttpErrorResponse({ error: new ProgressEvent('error'), status: 0 });
    expect(describeHttpError(err, 'x')).toContain('Cannot reach the POS server');
  });

  it('falls back with the status when there is no message', () => {
    const err = new HttpErrorResponse({ error: null, status: 500 });
    expect(describeHttpError(err, 'Could not load quotations.')).toBe('Could not load quotations (HTTP 500).');
  });
});
