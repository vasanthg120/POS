// src/app/shared/interceptors/jwt.interceptor.ts
import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject }    from '@angular/core';
import { Router }    from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { Auth } from '../services/auth';

export const jwtInterceptor: HttpInterceptorFn = (req, next) => {
  const auth   = inject(Auth);
  const router = inject(Router);
  const token  = auth.accessToken;

  const cloned = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(cloned).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401 && error.error?.code === 'TOKEN_INVALID') {
        auth.silentRefresh();
      }
      return throwError(() => error);
    })
  );
};
