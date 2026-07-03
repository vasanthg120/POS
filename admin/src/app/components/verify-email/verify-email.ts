import { Component, OnInit }               from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { CommonModule }                    from '@angular/common';
import { HttpClient }                      from '@angular/common/http';
import { Environment }                     from '../environment/environment';

@Component({
  selector    : 'app-verify-email',
  standalone  : true,
  imports     : [CommonModule, RouterModule],
  templateUrl : './verify-email.html',
  styleUrl    : './verify-email.css',
})
export class VerifyEmail implements OnInit {
  state       : 'loading' | 'success' | 'error' | 'notoken' = 'loading';
  errorMessage = 'This link is invalid or has expired.';
  resendState : 'idle' | 'sending' | 'sent' | 'failed' = 'idle';

  private email = '';

  constructor(
    private route  : ActivatedRoute,
    private router : Router,
    private http   : HttpClient,
  ) {}

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token');

    if (!token) {
      this.state = 'notoken';
      return;
    }

    // ✅ Mounted at /api/auth per routes/index.js → app.use('/api/auth', auth)
    this.http
      .get<{ message: string }>(`${Environment.API_URL}/api/auth/verify-email`, { params: { token } })
      .subscribe({
        next: () => {
          this.state = 'success';
          setTimeout(() => this.router.navigate(['/auth/login']), 2500);
        },
        error: (err) => {
          this.state        = 'error';
          this.errorMessage = err.error?.message || 'This link is invalid or has expired.';
          this.email        = this.route.snapshot.queryParamMap.get('email') || '';
        },
      });
  }

  resend(): void {
    if (!this.email) {
      const input = window.prompt('Enter your registered email address:');
      if (!input) return;
      this.email = input.trim();
    }

    this.resendState = 'sending';
    // ✅ Mounted at /api/auth per routes/index.js
    this.http
      .post<any>(`${Environment.API_URL}/api/auth/resend-verification`, { email: this.email })
      .subscribe({
        next : () => (this.resendState = 'sent'),
        error: () => (this.resendState = 'failed'),
      });
  }
}
