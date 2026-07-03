// app.config.ts — Standalone application configuration
import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding }      from '@angular/router';
import { provideHttpClient, withInterceptors }           from '@angular/common/http';
import { provideClientHydration }                        from '@angular/platform-browser';
import { routes }         from './app.routes';
import { jwtInterceptor } from './components/interceptor/jwt.interceptor';
import { authInterceptor } from './components/interceptor/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(
      withInterceptors([authInterceptor]),
    ),
    provideClientHydration(),
  ],
};
