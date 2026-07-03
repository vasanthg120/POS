// reset-password.component.ts
import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule }                  from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import {
  FormBuilder, FormGroup, Validators,
  ReactiveFormsModule, AbstractControl, ValidationErrors
} from '@angular/forms';
import { finalize } from 'rxjs/operators';
import { Auth }     from '../services/auth';

// ── Custom validator: passwords must match ────────────────────────
function passwordMatch(group: AbstractControl): ValidationErrors | null {
  const pw  = group.get('password')?.value;
  const cpw = group.get('confirmPassword')?.value;
  if (pw && cpw && pw !== cpw) {
    group.get('confirmPassword')?.setErrors({ mismatch: true });
    return { mismatch: true };
  }
  if (group.get('confirmPassword')?.hasError('mismatch') && pw === cpw) {
    group.get('confirmPassword')?.setErrors(null);
  }
  return null;
}

// ── Custom validator: password strength ──────────────────────────
function strongPassword(ctrl: AbstractControl): ValidationErrors | null {
  const v = ctrl.value as string;
  if (!v) return null;
  const errors: Record<string, boolean> = {};
  if (!/[A-Z]/.test(v))     errors['noUppercase'] = true;
  if (!/[a-z]/.test(v))     errors['noLowercase'] = true;
  if (!/\d/.test(v))        errors['noDigit']     = true;
  if (!/[@$!%*?&]/.test(v)) errors['noSpecial']   = true;
  return Object.keys(errors).length ? errors : null;
}

interface Requirement {
  label: string;
  met  : boolean;
  test : (v: string) => boolean;
}

@Component({
  selector    : 'app-reset-password',
  standalone  : true,
  imports     : [CommonModule, RouterModule, ReactiveFormsModule],
  templateUrl : './reset-password.html',
  styleUrl: './reset-password.css'
})
export class ResetPassword implements OnInit, OnDestroy {

  resetForm!    : FormGroup;
  isLoading      = false;
  showPassword   = false;
  showConfirm    = false;
  serverError    = '';
  resetSuccess   = false;
  tokenInvalid   = false;
  countdown      = 5;
  strengthScore  = 0;
  strengthLabel  = '';

  private resetToken   = '';
  private countdownInt : any;

  requirements: Requirement[] = [
    { label: 'At least 8 characters',            met: false, test: (v) => v.length >= 8 },
    { label: 'One uppercase letter (A–Z)',        met: false, test: (v) => /[A-Z]/.test(v) },
    { label: 'One lowercase letter (a–z)',        met: false, test: (v) => /[a-z]/.test(v) },
    { label: 'One number (0–9)',                  met: false, test: (v) => /\d/.test(v) },
    { label: 'One special character (@$!%*?&)',   met: false, test: (v) => /[@$!%*?&]/.test(v) },
  ];

  constructor(
    private fb    : FormBuilder,
    private auth  : Auth,
    private router: Router,
    private route : ActivatedRoute,
  ) {}

  ngOnInit(): void {
    // Extract token from query param: /auth/reset-password?token=abc123
    this.resetToken = this.route.snapshot.queryParams['token'] || '';

    if (!this.resetToken) {
      this.tokenInvalid = true;
      return;
    }

    this.resetForm = this.fb.group(
      {
        password       : ['', [Validators.required, Validators.minLength(8), strongPassword]],
        confirmPassword: ['', Validators.required],
      },
      { validators: passwordMatch }
    );
  }

  ngOnDestroy(): void {
    if (this.countdownInt) clearInterval(this.countdownInt);
  }

  // ── Password strength ─────────────────────────────────────────────
  updateStrength(): void {
    const v = this.resetForm.get('password')?.value as string || '';

    // Update requirements checklist
    this.requirements.forEach((r) => (r.met = r.test(v)));

    // Score
    let score = 0;
    if (v.length >= 8)           score++;
    if (/[A-Z]/.test(v))         score++;
    if (/[a-z]/.test(v) && /\d/.test(v)) score++;
    if (/[@$!%*?&]/.test(v))    score++;

    this.strengthScore = score;
    this.strengthLabel = ['', 'Weak', 'Fair', 'Good', 'Strong'][score] || '';
  }

  getStrengthClass(segment: number): string {
    if (this.strengthScore < segment) return 'strength-segment';
    const map: Record<number, string> = {
      1: 'active-weak',
      2: 'active-fair',
      3: 'active-good',
      4: 'active-strong',
    };
    return `strength-segment ${map[this.strengthScore]}`;
  }

  // ── Form helpers ──────────────────────────────────────────────────
  togglePassword(): void { this.showPassword = !this.showPassword; }

  isInvalid(field: string): boolean {
    const ctrl = this.resetForm.get(field);
    return !!(ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched));
  }

  getError(field: string): string {
    const ctrl = this.resetForm.get(field);
    if (!ctrl?.errors) return '';
    const e = ctrl.errors;
    if (e['required'])    return 'This field is required.';
    if (e['minlength'])   return `Minimum ${e['minlength'].requiredLength} characters required.`;
    if (e['mismatch'])    return 'Passwords do not match.';
    if (e['noUppercase']) return 'Must contain at least one uppercase letter.';
    if (e['noLowercase']) return 'Must contain at least one lowercase letter.';
    if (e['noDigit'])     return 'Must contain at least one number.';
    if (e['noSpecial'])   return 'Must contain a special character (@$!%*?&).';
    return 'Invalid value.';
  }

  // ── Submit ────────────────────────────────────────────────────────
  onSubmit(): void {
    if (this.resetForm.invalid) {
      this.resetForm.markAllAsTouched();
      return;
    }

    this.isLoading   = true;
    this.serverError = '';

    const { password, confirmPassword } = this.resetForm.value;

    this.auth.resetPassword(this.resetToken, password, confirmPassword)
      .pipe(finalize(() => this.isLoading = false))
      .subscribe({
        next : () => {
          this.resetSuccess = true;
          this.startCountdown();
        },
        error: (err) => {
          if (err?.code === 'INVALID_RESET_TOKEN') {
            this.tokenInvalid = true;
          } else {
            this.serverError = err?.message || 'Password reset failed. Please try again.';
          }
        },
      });
  }

  // ── Auto-redirect countdown ───────────────────────────────────────
  private startCountdown(): void {
    this.countdown = 5;
    this.countdownInt = setInterval(() => {
      this.countdown--;
      if (this.countdown <= 0) {
        clearInterval(this.countdownInt);
        this.router.navigate(['/auth/login']);
      }
    }, 1000);
  }
}
