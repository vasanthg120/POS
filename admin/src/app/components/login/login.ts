// src/app/components/login/login.ts
import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule }                 from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import {
  FormBuilder, FormGroup, Validators,
  ReactiveFormsModule,
} from '@angular/forms';
import { Subject }              from 'rxjs';
import { takeUntil, finalize }  from 'rxjs/operators';
import { Auth }                 from '../services/auth';

@Component({
  selector   : 'app-login',
  standalone : true,
  imports    : [CommonModule, RouterModule, ReactiveFormsModule],
  templateUrl: './login.html',
  styleUrl   : './login.css',
})
export class Login implements OnInit, OnDestroy {

  loginForm!    : FormGroup;
  isLoading      = false;
  showPassword   = false;
  serverError    = '';
  billingSuspended = false;
  sessionExpired = false;

  private returnUrl = '/dashboard';
  private destroy$  = new Subject<void>();

  constructor(
    private fb    : FormBuilder,
    private auth  : Auth,
    private router: Router,
    private route : ActivatedRoute,
  ) {}

  ngOnInit(): void {
    this.loginForm = this.fb.group({
      email     : ['', [Validators.required, Validators.email]],
      password  : ['', [Validators.required, Validators.minLength(8)]],
      rememberMe: [false],
    });

    this.returnUrl     = this.route.snapshot.queryParams['returnUrl'] || '/dashboard';
    this.sessionExpired = this.route.snapshot.queryParams['session'] === 'expired';

    // If already logged in, route by role
    this.auth.isLoggedIn$
      .pipe(takeUntil(this.destroy$))
      .subscribe((loggedIn) => {
        if (loggedIn) {
          this.router.navigateByUrl(this.auth.resolveHome(this.returnUrl));
        }
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  isInvalid(field: string): boolean {
    const ctrl = this.loginForm.get(field);
    return !!(ctrl?.invalid && (ctrl.dirty || ctrl.touched));
  }

  getError(field: string): string {
    const errors = this.loginForm.get(field)?.errors;
    if (!errors) return '';
    if (errors['required'])  return 'This field is required.';
    if (errors['email'])     return 'Enter a valid email address.';
    if (errors['minlength']) return `Minimum ${errors['minlength'].requiredLength} characters required.`;
    return 'Invalid value.';
  }

  togglePassword(): void { this.showPassword = !this.showPassword; }

  // ── Submit ────────────────────────────────────────────────────────────────
  onSubmit(): void {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    this.isLoading   = true;
    this.serverError = '';
    this.billingSuspended = false;
    const { email, password } = this.loginForm.value;

    this.auth.login(email, password)
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => (this.isLoading = false)),
      )
      .subscribe({
        next: () => {
          // auth.resolveHome() returns /admin/dashboard for superadmin, returnUrl for tenants
          this.router.navigateByUrl(this.auth.resolveHome(this.returnUrl));
        },
        error: (err) => {
          this.billingSuspended = err?.code === 'BILLING_SUSPENDED';
          switch (err?.code) {
            case 'ACCOUNT_LOCKED'     : this.serverError = err.message; break;
            case 'EMAIL_NOT_VERIFIED' : this.serverError = 'Please verify your email before signing in.'; break;
            case 'ACCOUNT_DISABLED'   : this.serverError = 'Your account has been disabled. Contact your administrator.'; break;
            case 'BILLING_SUSPENDED'  : this.serverError = err.message; break;
            default                   : this.serverError = err?.message || 'Login failed. Please try again.';
          }
        },
      });
  }
}
