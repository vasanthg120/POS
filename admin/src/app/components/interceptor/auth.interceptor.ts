// src/app/interceptors/auth.interceptor.ts
import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { inject }    from '@angular/core';
import { Router }    from '@angular/router';
import { catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { Auth } from '../services/auth';

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
