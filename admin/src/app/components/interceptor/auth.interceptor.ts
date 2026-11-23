// src/app/interceptors/auth.interceptor.ts
import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { inject }    from '@angular/core';
import { Router }    from '@angular/router';
import { catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { Auth } from '../services/auth';

const ACCOUNT_STATE_CODES = new Set(['ACCOUNT_DISABLED', 'ACCOUNT_SUSPENDED', 'BILLING_SUSPENDED']);

export const authInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
) => {
  const auth   = inject(Auth);
  const router = inject(Router);

  const token = auth.accessToken;
  const authReq = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(authReq).pipe(
    catchError((err: HttpErrorResponse) => {
      // The server refused the account itself (tenant disabled by the Super
      // Admin, member suspended, billing suspended, account deleted): the
      // session is over, so sign out with the reason instead of leaving the
      // user on a page where every call fails.
      const code = err.error?.code;
      if (
        typeof window !== 'undefined' &&
        !req.url.includes('/auth/login') &&
        ((err.status === 403 && ACCOUNT_STATE_CODES.has(code)) ||
         (err.status === 401 && code === 'ACCOUNT_NOT_FOUND'))
      ) {
        auth.endSessionForAccountState(code);
        return throwError(() => err);
      }

      if (
        err.status === 401 &&
        err.error?.code === 'TOKEN_EXPIRED' &&
        !req.url.includes('/auth/login') &&
        !req.url.includes('/auth/refresh') &&
        typeof window !== 'undefined'
      ) {
        auth.silentRefresh();
      }
      return throwError(() => err);
    }),
  );
};
