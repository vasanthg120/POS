// set-password.component.ts
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import {
  FormBuilder, FormGroup, Validators, ReactiveFormsModule, AbstractControl
} from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Environment } from '../environment/environment';

type PageState = 'verifying' | 'ready' | 'invalid' | 'done';

function passwordMatchValidator(g: AbstractControl) {
  const pwd  = g.get('password')?.value;
  const conf = g.get('confirmPassword')?.value;
  return pwd === conf ? null : { mismatch: true };
}

@Component({
  selector: 'app-set-password',
  standalone: true,
  imports: [CommonModule, RouterModule, ReactiveFormsModule],
  templateUrl: './set-password.html',
  styleUrls: ['./set-password.css'],
})
export class SetPassword implements OnInit {
  pageState  : PageState = 'verifying';
  pageError  = 'This link is invalid or has expired.';
  tenantName = '';
  serverError = '';
  loading    = false;
  showPwd    = false;
  showConfirm = false;

  // Password strength
  strength   = 0;
  hasUpper   = false;
  hasLower   = false;
  hasNumber  = false;
  hasSpecial = false;

  form!: FormGroup;
  private token = '';

  constructor(
    private fb    : FormBuilder,
    private http  : HttpClient,
    private route : ActivatedRoute,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.form = this.fb.group(
      {
        password       : ['', [
          Validators.required,
          Validators.minLength(8),
          Validators.pattern(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[@$!%*?&])/),
        ]],
        confirmPassword: ['', Validators.required],
      },
      { validators: passwordMatchValidator },
    );

    this.token = this.route.snapshot.queryParamMap.get('token') || '';

    if (!this.token) {
      this.pageState = 'invalid';
      this.pageError = 'No token provided. Please use the link sent to your email.';
      return;
    }

    // Validate token before showing form
    this.http
      .post<any>(`${Environment.API_URL}/api/auth/validate-invite`, { token: this.token })
      .subscribe({
        next: (res) => {
          this.tenantName = res.data?.firstName || 'there';
          this.pageState  = 'ready';
        },
        error: (err) => {
          this.pageState = 'invalid';
          this.pageError = err.error?.message || 'This invite link is invalid or has expired.';
        },
      });
  }

  onPasswordInput(): void {
    const val = this.form.get('password')?.value || '';
    this.hasUpper   = /[A-Z]/.test(val);
    this.hasLower   = /[a-z]/.test(val);
    this.hasNumber  = /\d/.test(val);
    this.hasSpecial = /[@$!%*?&]/.test(val);
    const score = [val.length >= 8, this.hasUpper, this.hasLower, this.hasNumber, this.hasSpecial]
      .filter(Boolean).length;
    this.strength = Math.min(4, Math.floor(score * 0.85));
  }

  strengthClass(seg: number): string {
    if (seg > this.strength) return 'seg-empty';
    if (this.strength <= 1)  return 'seg-weak';
    if (this.strength === 2) return 'seg-fair';
    if (this.strength === 3) return 'seg-good';
    return 'seg-strong';
  }

  get strengthLabel(): string {
    const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
    return labels[this.strength] || '';
  }

  get strengthLabelClass(): string {
    return ['', 'weak', 'fair', 'good', 'strong'][this.strength] || '';
  }

  isInvalid(field: string): boolean {
    const c = this.form.get(field);
    return !!(c && c.invalid && (c.dirty || c.touched));
  }

  getErr(field: string): string {
    const c = this.form.get(field);
    if (!c?.errors) return '';
    if (c.errors['required'])   return 'This field is required.';
    if (c.errors['minlength'])  return 'Password must be at least 8 characters.';
    if (c.errors['pattern'])    return 'Must include uppercase, lowercase, number and special character.';
    return 'Invalid value.';
  }

  onSubmit(): void {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    this.loading     = true;
    this.serverError = '';

    const { password, confirmPassword } = this.form.value;

    this.http
      .post<any>(`${Environment.API_URL}/api/auth/set-password`, {
        token: this.token,
        password,
        confirmPassword,
      })
      .subscribe({
        next: () => {
          this.pageState = 'done';
          setTimeout(() => this.router.navigate(['/auth/login']), 2500);
        },
        error: (err) => {
          this.serverError = err.error?.message || 'Failed to set password. Please try again.';
          this.loading = false;
        },
      });
  }
}
