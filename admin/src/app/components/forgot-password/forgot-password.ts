// forgot-password.component.ts
import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule }                  from '@angular/common';
import { RouterModule }                  from '@angular/router';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { finalize } from 'rxjs/operators';
import { Auth }     from '../services/auth';

@Component({
  selector    : 'app-forgot-password',
  standalone  : true,
  imports     : [CommonModule, RouterModule, ReactiveFormsModule],
  templateUrl : './forgot-password.html',
  styleUrl: './forgot-password.css'
})
export class ForgotPassword implements OnInit, OnDestroy {

  forgotForm!   : FormGroup;
  isLoading      = false;
  emailSent      = false;
  submittedEmail = '';
  serverError    = '';
  resendCooldown = 0;

  private cooldownInterval: any;

  constructor(
    private fb  : FormBuilder,
    private auth: Auth,
  ) {}

  ngOnInit(): void {
    this.forgotForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
    });
  }

  ngOnDestroy(): void {
    if (this.cooldownInterval) clearInterval(this.cooldownInterval);
  }

  // ── Form helpers ──────────────────────────────────────────────────
  isInvalid(field: string): boolean {
    const ctrl = this.forgotForm.get(field);
    return !!(ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched));
  }

  getError(field: string): string {
    const ctrl = this.forgotForm.get(field);
    if (!ctrl?.errors) return '';
    if (ctrl.errors['required']) return 'Email address is required.';
    if (ctrl.errors['email'])    return 'Please enter a valid email address.';
    return 'Invalid value.';
  }

  // ── Submit ────────────────────────────────────────────────────────
  onSubmit(): void {
    if (this.forgotForm.invalid) {
      this.forgotForm.markAllAsTouched();
      return;
    }

    this.isLoading   = true;
    this.serverError = '';
    const { email }  = this.forgotForm.value;

    this.auth.forgotPassword(email)
      .pipe(finalize(() => this.isLoading = false))
      .subscribe({
        next : () => {
          this.emailSent      = true;
          this.submittedEmail = email;
          this.startCooldown(120); // 2-min cooldown
        },
        error: (err) => {
          if (err?.code === 'RESET_THROTTLE') {
            this.emailSent      = true;
            this.submittedEmail = email;
            this.startCooldown(120);
          } else {
            this.serverError = err?.message || 'Something went wrong. Please try again.';
          }
        },
      });
  }

  // ── Resend ────────────────────────────────────────────────────────
  resend(): void {
    if (this.resendCooldown > 0) return;
    this.emailSent = false;
    this.forgotForm.get('email')?.setValue(this.submittedEmail);
    // Small delay for UX
    setTimeout(() => this.onSubmit(), 100);
  }

  // ── Cooldown timer ────────────────────────────────────────────────
  private startCooldown(seconds: number): void {
    this.resendCooldown = seconds;
    this.cooldownInterval = setInterval(() => {
      this.resendCooldown--;
      if (this.resendCooldown <= 0) {
        this.resendCooldown = 0;
        clearInterval(this.cooldownInterval);
      }
    }, 1000);
  }
}
