// settings.component.ts
import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule, DOCUMENT, TitleCasePipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import {
  ReactiveFormsModule, FormBuilder, FormGroup, Validators, AbstractControl,
} from '@angular/forms';
import { Tenant } from '../services/tenant';
import { Auth } from '../services/auth';
import { Crm, CrmSyncStatus } from '../services/crm';
import { describeHttpError } from '../services/api-error';
import { AfterViewChecked } from '@angular/core';

/** The server's message from an HttpErrorResponse (err.message is Angular's generic text). */
const apiMessage = (err: any, fallback: string): string => describeHttpError(err, fallback);

/** Display names for the `crm.provider` values the backend stores. */
const CRM_PROVIDER_LABELS: Record<string, string> = { prospectconnect: 'ProspectConnect' };

export type SettingsTab = 'business' | 'razorpay' | 'crm' | 'payment' | 'password';

function passwordMatchValidator(g: AbstractControl) {
  return g.get('newPassword')?.value === g.get('confirmPassword')?.value
    ? null : { passwordMismatch: true };
}

// Maps setupStep → which tab is unlocked up to
const STEP_ORDER: Record<string, number> = {
  business: 0,
  razorpay: 1,
  crm: 2,
  complete: 3,
};

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, TitleCasePipe],
  templateUrl: './settings.html',
  styleUrls: ['./settings.css'],
})
export class Settings implements OnInit {

  showQR = signal(false);
  activeTab = signal<SettingsTab>('business');
  loading = signal(false);
  testingCRM = signal(false);
  success = signal('');
  error = signal('');
  showRazorpaySecret = signal(false);
  showCRMKey = signal(false);
  copied = signal(false);
  private qrGenerated = false;

  // ── CRM sync status (Settings → CRM) ────────────────────────────────────
  private crm = inject(Crm);
  crmSync = signal<CrmSyncStatus | null>(null);
  syncingCRM = signal(false);
  /** Why the sync status could not be loaded — shown instead of "not synced yet". */
  crmSyncError = signal<string | null>(null);

  /** Connected provider's name, from the tenant settings the backend returned. */
  crmProviderLabel(): string {
    const p = this.auth.currentTenant()?.crm?.provider;
    return p ? (CRM_PROVIDER_LABELS[p] ?? p) : '—';
  }

  /** Base of the public payment link — same origin the copy/QR actions use */
  readonly payBaseUrl = `${inject(DOCUMENT).location.origin}/pay/`;

  businessForm!: FormGroup;
  razorpayForm!: FormGroup;
  crmForm!: FormGroup;
  passwordForm!: FormGroup;

  // ── Setup wizard state ──────────────────────────────────────────────────
  /** Index of the highest unlocked step (0=business, 1=razorpay, 2=crm, 3=complete) */
  unlockedStep = computed(() => STEP_ORDER[this.auth.currentTenant()?.setupStep ?? 'business'] ?? 0);

  isSetupComplete = computed(() => this.auth.currentTenant()?.setupStep === 'complete');

  setupSteps = [
    { id: 'business', label: 'Business', icon: 'home' },
    { id: 'razorpay', label: 'Razorpay', icon: 'card' },
    { id: 'crm', label: 'CRM', icon: 'share' },
    { id: 'payment', label: 'Payment Page', icon: 'link' },
  ];

  /** Pct for progress bar (0–100) */
  get setupProgressPct(): number {
    const map: Record<string, number> = { business: 25, razorpay: 50, crm: 75, complete: 100 };
    return map[this.auth.currentTenant()?.setupStep ?? 'business'] ?? 25;
  }

  cityLocked = computed(() => !!this.auth.currentTenant()?.city);

  constructor(
    private fb: FormBuilder,
    private tenant: Tenant,
    public auth: Auth,
    private route: ActivatedRoute,
  ) { }

  ngOnInit(): void {
    const t = this.auth.currentTenant();

    this.businessForm = this.fb.group({
      businessName: [t?.businessName || ''],
      businessAddress: [''],
      city: [{ value: t?.city || '', disabled: !!t?.city }],
      currency: [t?.currency || 'INR'],
      gstNumber: [''],
      phone: [''],
      timezone: ['Asia/Kolkata'],
    });

    this.razorpayForm = this.fb.group({
      keyId: ['', Validators.required],
      keySecret: ['', Validators.required],
      webhookSecret: [''],
    });

    this.crmForm = this.fb.group({
      provider: ['prospectconnect'],
      apiKey: ['', Validators.required],
      apiUrl: ['', [Validators.required, Validators.pattern(/^https?:\/\/.+/)]],
    });

    this.passwordForm = this.fb.group(
      {
        currentPassword: ['', Validators.required],
        newPassword: ['', [Validators.required, Validators.minLength(6)]],
        confirmPassword: ['', Validators.required],
      },
      { validators: passwordMatchValidator },
    );

    // If redirected from setup guard, open the right tab automatically
    this.route.queryParams.subscribe(params => {
      if (params['setup']) {
        const stepToTab: Record<string, SettingsTab> = {
          business: 'business',
          razorpay: 'razorpay',
          crm: 'crm',
        };
        const tab = stepToTab[params['setup']];
        if (tab) this.activeTab.set(tab);
      }
    });

    // If setup is complete, default to the payment page tab on first open
    if (t?.setupStep === 'complete') {
      this.activeTab.set('payment');
    }

    this.tenant.getSettings().subscribe({
      next: (res) => {
        if (res.success && res.data) {
          const d = res.data;
          this.businessForm.patchValue({
            businessName: d.businessName || '',
            businessAddress: d.businessAddress || '',
            city: d.city || '',
            currency: d.currency || 'INR',
            gstNumber: d.gstNumber || '',
            phone: d.phone || '',
            timezone: d.timezone || 'Asia/Kolkata',
          });
          if (d.city) this.businessForm.get('city')?.disable();
          // Re-evaluate payment tab after data loads
          if (d.setupStep === 'complete') this.activeTab.set('payment');
          // currentTenant is now fresh — load real CRM sync health for the CRM card.
          this.loadCrmSyncStatus();
        }
      },
    });
  }

  setTab(tab: SettingsTab): void {
    this.activeTab.set(tab);
    this.success.set('');
    this.error.set('');
    if (tab === 'crm') this.loadCrmSyncStatus();
  }

  /** Real sync health for the connected-CRM card (replaces the old hardcoded "Active"). */
  loadCrmSyncStatus(): void {
    if (!this.auth.currentTenant()?.crm?.isConfigured) {
      this.crmSync.set(null); this.crmSyncError.set(null); return;
    }
    this.crm.getSyncStatus().subscribe({
      next: (res) => { this.crmSync.set(res.data); this.crmSyncError.set(null); },
      error: (err) => {
        this.crmSync.set(null);
        this.crmSyncError.set(describeHttpError(err, 'Could not load the CRM sync status.'));
      },
    });
  }

  syncCRMNow(): void {
    this.syncingCRM.set(true);
    this.clearMessages();
    this.crm.syncNow().subscribe({
      next: (res) => {
        this.success.set(res.message || 'CRM sync complete.');
        this.crmSync.set(res.data?.status ?? null);
        this.crmSyncError.set(null);
        this.syncingCRM.set(false);
      },
      error: (err) => {
        this.error.set(apiMessage(err, 'CRM sync failed.'));
        if (err?.error?.data?.status) this.crmSync.set(err.error.data.status);
        this.syncingCRM.set(false);
      },
    });
  }

  crmSyncLabel(): string {
    const s = this.crmSync();
    if (!s) return this.crmSyncError() ? '● Unavailable' : '—';
    switch (s.status) {
      case 'running': return '● Syncing…';
      case 'success': return '● Healthy';
      case 'partial': return '● Partial';
      case 'error':   return '● Failing';
      default:        return 'Not synced yet';
    }
  }

  ngAfterViewChecked(): void {
    if (this.showQR() && !this.qrGenerated) {
      const el = document.getElementById('qr-canvas');
      if (el && el.childElementCount === 0) {
        const slug = this.auth.currentTenant()?.paymentPageSlug;
        const url = `${window.location.origin}/pay/${slug}`;
        // @ts-ignore
        new QRCode(el, {
          text: url,
          width: 220,
          height: 220,
          colorDark: '#0067b0',
          colorLight: '#ffffff',
          correctLevel: (window as any).QRCode?.CorrectLevel?.H,
        });
        this.qrGenerated = true;
      }
    }
    if (!this.showQR()) {
      this.qrGenerated = false;
      const el = document.getElementById('qr-canvas');
      if (el) el.innerHTML = '';
    }
  }

  downloadQR(): void {
    const canvas = document.querySelector('#qr-canvas canvas') as HTMLCanvasElement;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `payment-qr-${this.auth.currentTenant()?.paymentPageSlug || 'code'}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  /** Returns true if a setup tab is accessible based on progress */
  isTabAccessible(tab: SettingsTab): boolean {
    if (tab === 'password') return true; // always accessible
    const idx: Record<SettingsTab, number> = {
      business: 0, razorpay: 1, crm: 2, payment: 3, password: 99,
    };
    return this.unlockedStep() >= idx[tab];
  }

  saveBusinessInfo(): void {
    if (this.businessForm.invalid) return;
    this.loading.set(true);
    this.clearMessages();
    this.tenant.updateBusinessInfo(this.businessForm.getRawValue()).subscribe({
      next: (res) => {
        this.success.set('Business info updated successfully.');
        this.loading.set(false);
        if (res.data?.city) this.businessForm.get('city')?.disable();
        // Auto-advance to Razorpay tab
        if (res.data?.setupStep === 'razorpay') {
          setTimeout(() => { this.success.set(''); this.setTab('razorpay'); }, 1200);
        }
      },
      error: (err) => { this.error.set(err?.message || 'Update failed.'); this.loading.set(false); },
    });
  }

  saveRazorpay(): void {
    if (this.razorpayForm.invalid) { this.razorpayForm.markAllAsTouched(); return; }
    this.loading.set(true);
    this.clearMessages();
    this.tenant.saveRazorpayCredentials(this.razorpayForm.value).subscribe({
      next: (res) => {
        this.success.set('Razorpay credentials verified and saved.');
        this.razorpayForm.reset();
        this.loading.set(false);
        // Auto-advance to CRM tab
        if (res.data?.setupStep === 'crm') {
          setTimeout(() => { this.success.set(''); this.setTab('crm'); }, 1200);
        }
      },
      error: (err) => { this.error.set(err?.message || 'Failed to save Razorpay credentials.'); this.loading.set(false); },
    });
  }

  removeRazorpay(): void {
    if (!confirm('Remove Razorpay integration? Payments will be disabled.')) return;
    this.clearMessages();
    this.tenant.removeRazorpayCredentials().subscribe({
      next: () => this.success.set('Razorpay integration removed.'),
      error: (err) => this.error.set(err?.message || 'Failed.'),
    });
  }

  saveCRM(): void {
    if (this.crmForm.invalid) { this.crmForm.markAllAsTouched(); return; }
    this.loading.set(true);
    this.clearMessages();
    this.tenant.saveCRMCredentials(this.crmForm.value).subscribe({
      next: (res) => {
        this.success.set(res?.message || 'CRM credentials saved and verified.');
        this.crmForm.reset({ provider: 'prospectconnect' });
        this.loading.set(false);
        // The first import runs in the background on the server; show its result.
        setTimeout(() => this.loadCrmSyncStatus(), 5000);
        // Setup complete — advance to Payment Page tab
        if (res.data?.setupStep === 'complete') {
          setTimeout(() => {
            this.success.set('🎉 Setup complete! Your payment page is now live.');
            this.setTab('payment');
          }, 100);
        }
      },
      error: (err) => { this.error.set(apiMessage(err, 'Failed to save CRM credentials.')); this.loading.set(false); },
    });
  }

  testCRM(): void {
    this.testingCRM.set(true);
    this.clearMessages();
    this.tenant.testCRMConnection().subscribe({
      next: (res) => { this.success.set(res.message || 'CRM connection test successful.'); this.testingCRM.set(false); },
      error: (err) => { this.error.set(apiMessage(err, 'CRM connection test failed.')); this.testingCRM.set(false); },
    });
  }

  removeCRM(): void {
    if (!confirm('Remove CRM integration? Quotes synced from the CRM will be cleared from the POS (payment tracking is kept).')) return;
    this.clearMessages();
    this.tenant.removeCRMCredentials().subscribe({
      next: () => {
        this.success.set('CRM integration removed.');
        this.crmSync.set(null);
        this.crmSyncError.set(null);
      },
      error: (err) => this.error.set(apiMessage(err, 'Failed.')),
    });
  }

  changePassword(): void {
    if (this.passwordForm.invalid) { this.passwordForm.markAllAsTouched(); return; }
    this.loading.set(true);
    this.clearMessages();
    const { currentPassword, newPassword } = this.passwordForm.value;
    this.tenant.changePassword(currentPassword, newPassword).subscribe({
      next: () => {
        this.success.set('Password updated. Signing out in 3 seconds…');
        this.passwordForm.reset();
        this.loading.set(false);
        setTimeout(() => this.auth.logout().subscribe(), 3000);
      },
      error: (err) => { this.error.set(err?.message || 'Failed to change password.'); this.loading.set(false); },
    });
  }

  copyPaymentUrl(): void {
    const slug = this.auth.currentTenant()?.paymentPageSlug;
    if (!slug) return;
    const url = `${window.location.origin}/pay/${slug}`;
    navigator.clipboard?.writeText(url).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2500);
    });
  }

  private clearMessages(): void { this.success.set(''); this.error.set(''); }
}
