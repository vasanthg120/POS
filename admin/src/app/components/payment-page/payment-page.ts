import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef, NgZone
} from '@angular/core';
import { CommonModule }       from '@angular/common';
import {
  ReactiveFormsModule, FormsModule,
  FormBuilder, FormGroup, Validators, AbstractControl
} from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { HttpClient }                   from '@angular/common/http';
import { Subject, takeUntil, debounceTime, distinctUntilChanged } from 'rxjs';
import { Environment }                  from '../environment/environment';

export type CheckoutStep =
  | 'lookup' | 'details' | 'payment'
  | 'processing' | 'success' | 'error';

// ─── Minimal interfaces ───────────────────────────────────────────────────────
interface TenantPublicInfo {
  businessName  : string;
  businessAddress?: string;
  city          ?: string;
  currency       : string;
  gstNumber     ?: string;
  phone         ?: string;
  razorpayKeyId  : string;           // public key — safe to expose
  logoUrl       ?: string;
}

interface QuotePreview {
  quotationNo   : string;
  customerName  : string;
  customerEmail : string;
  customerPhone?: string;
  amount        : number;
  status        : string;
  notes        ?: string;
}

interface CreatedOrder {
  _id        : string;
  orderNumber: string;
  total      : number;
  currency   : string;
}

interface RazorpayOrderData {
  razorpayOrderId: string;
  amount         : number;
  currency       : string;
  keyId          : string;
  paymentId      : string;
  prefill        : { name: string; email: string; contact: string };
}

@Component({
  selector   : 'app-payment-page',
  standalone : true,
  imports    : [CommonModule, ReactiveFormsModule, FormsModule, RouterModule],
  templateUrl: './payment-page.html',
  styleUrls  : ['./payment-page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PaymentPage implements OnInit, OnDestroy {

  // ── State ──────────────────────────────────────────────────────────────────
  currentStep   : CheckoutStep = 'lookup';
  isLoading      = false;
  isSearching    = false;
  errorMessage   = '';
  lookupError    = '';
  isDownloading  = false;
  downloadError  = '';

  // ── Tenant & Quote ─────────────────────────────────────────────────────────
  slug           = '';
  tenant         : TenantPublicInfo | null = null;

  // ── Order / payment ────────────────────────────────────────────────────────
  order          : CreatedOrder | null = null;
  orderId        = '';
  paymentId      = '';
  convertedAmount = 0;
  successData    : { id: string } | null = null;

  // ── Forms ──────────────────────────────────────────────────────────────────
  lookupForm !: FormGroup;
  detailsForm!: FormGroup;

  private destroy$ = new Subject<void>();
  private readonly api = Environment.API_URL;   // e.g. https://pos.pantheras.io

  // Incremented on every lookup request; a response is only applied if it
  // still matches the latest sequence number, so a slow/older request can
  // never overwrite the result of a newer one (out-of-order network replies).
  private searchSeq = 0;

  constructor(
    private fb   : FormBuilder,
    private http : HttpClient,
    private route: ActivatedRoute,
    private cdr  : ChangeDetectorRef,
    private zone : NgZone,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  ngOnInit(): void {
    this.buildForms();
    this.loadRazorpayScript();

    // Read slug from /pay/:slug or /:slug
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe(p => {
      this.slug = p.get('slug') ?? '';
      if (this.slug) this.loadTenantInfo();
    });

    // Pre-fill quotation from ?quoteId=
    this.route.queryParamMap.pipe(takeUntil(this.destroy$)).subscribe(p => {
      const qid = p.get('quoteId');
      if (qid) {
        this.lookupForm.patchValue({ quotationNo: qid });
        this.fetchAndTransition(qid.trim());
      }
    });

    // Clear a stale "not found" error as soon as the customer edits the number.
    this.lookupForm.get('quotationNo')!.valueChanges.pipe(
      takeUntil(this.destroy$),
    ).subscribe(() => {
      if (this.lookupError) {
        this.lookupError = '';
        this.cdr.markForCheck();
      }
    });
  }

  ngOnDestroy(): void { this.destroy$.next(); this.destroy$.complete(); }

  // ── Tenant info ────────────────────────────────────────────────────────────
  private loadTenantInfo(): void {
    this.http.get<any>(`${this.api}/public/tenant/${this.slug}`)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next : r => { this.tenant = r.data ?? r; this.cdr.markForCheck(); },
        error: () => { /* non-fatal — page still works */ this.cdr.markForCheck(); },
      });
  }

  // ── Form builders ──────────────────────────────────────────────────────────
  private buildForms(): void {
    this.lookupForm = this.fb.group({
      quotationNo: ['', [
        Validators.required,
        Validators.minLength(1),
        Validators.maxLength(50),
        Validators.pattern(/^[A-Za-z0-9\-\/_.# ]+$/),
      ]],
    });

    // name/email/phone are read-only here — pre-filled from the quotation and
    // no longer editable by the customer, so they carry no client-side
    // validators (an unfixable "invalid" state would just dead-end them). Any
    // bad data still surfaces from the backend when the order is created.
    this.detailsForm = this.fb.group({
      amount     : ['', [Validators.required, Validators.min(0.01)]],
      name       : [''],
      email      : [''],
      phone      : [''],
      quotationNo: ['', [Validators.required, Validators.minLength(1), Validators.maxLength(50)]],
      notes      : [''],
    });

    this.detailsForm.get('amount')!.valueChanges.pipe(
      takeUntil(this.destroy$),
      debounceTime(150),
      distinctUntilChanged(),
    ).subscribe(val => {
      this.convertedAmount = Math.round((parseFloat(val) || 0) * 100) / 100;
      this.cdr.markForCheck();
    });
  }

  // ── Quote lookup ───────────────────────────────────────────────────────────
  // Enter a quotation number, submit, and — if it resolves — go straight to
  // the quotation details step to review and pay. No live/in-place preview.
  onLookupSubmit(): void {
    if (this.lookupForm.invalid) { this.lookupForm.markAllAsTouched(); this.cdr.markForCheck(); return; }
    const qid = (this.lookupForm.value.quotationNo as string).trim();
    this.fetchAndTransition(qid);
  }

  private fetchAndTransition(quoteId: string): void {
    const seq = ++this.searchSeq;
    this.isSearching = true;
    this.lookupError = '';
    this.cdr.markForCheck();

    this.http.get<any>(`${this.api}/public/quotes`, { params: { search: quoteId, slug: this.slug } })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next : r => {
          if (seq !== this.searchSeq) return; // superseded by a newer search
          this.isSearching = false;
          const quote = this.extractFirstQuote(r, quoteId);
          if (!quote) {
            this.lookupError = `No quote found for "${quoteId}". Please check the number and try again.`;
            this.cdr.markForCheck();
            return;
          }
          this.prefillDetails(quote, quoteId);
          this.currentStep = 'details';
          this.cdr.markForCheck();
        },
        error: err => {
          if (seq !== this.searchSeq) return;
          this.isSearching = false;
          this.lookupError = err?.error?.message || 'Could not reach the quoting system. Please try again.';
          this.cdr.markForCheck();
        },
      });
  }

  /**
   * Normalise whatever shape the CRM / backend returns.
   *
   * A short or single-digit search term can match several quotes upstream —
   * previously this always took the first array entry, which could silently
   * resolve to a different customer's quote. Now it prefers the entry whose
   * quotation number is an exact match for what was typed.
   */
  private extractFirstQuote(r: any, searchTerm?: string): QuotePreview | null {
    const list: any[] = r?.data ?? r?.quotes ?? (Array.isArray(r) ? r : []);
    if (!list.length) return null;

    let raw = list[0];
    if (searchTerm) {
      const needle = searchTerm.trim().toLowerCase();
      const exact = list.find(q =>
        String(q.quotationNo ?? q.ticket_number ?? q.id ?? '').toLowerCase() === needle
      );
      if (exact) raw = exact;
    }

    return {
      quotationNo  : raw.quotationNo ?? raw.ticket_number ?? raw.id ?? '',
      customerName : raw.customerName  ?? raw.customer_name  ?? '',
      customerEmail: raw.customerEmail ?? raw.customer_email ?? '',
      customerPhone: raw.customerPhone ?? raw.customer_phone ?? '',
      amount       : parseFloat(raw.quote_amount ?? raw.amount ?? 0) || 0,
      status       : raw.quote_status  ?? raw.status ?? '',
      notes        : raw.notes ?? '',
    };
  }

  private prefillDetails(q: QuotePreview, fallbackId: string): void {
    this.detailsForm.patchValue({
      quotationNo: q.quotationNo || fallbackId,
      name       : q.customerName,
      email      : q.customerEmail,
      phone      : q.customerPhone ?? '',
      amount     : q.amount || '',
      notes      : q.notes ?? '',
    });
    this.convertedAmount = Math.round(q.amount * 100) / 100;
  }

  // ── Step 1 — Create order ──────────────────────────────────────────────────
  async proceedToPayment(): Promise<void> {
    if (this.detailsForm.invalid) { this.detailsForm.markAllAsTouched(); this.cdr.markForCheck(); return; }
    if (this.convertedAmount < 1) {
      this.errorMessage = 'Minimum payable amount is ₹1.00.';
      this.cdr.markForCheck();
      return;
    }

    this.isLoading    = true;
    this.errorMessage = '';
    this.cdr.markForCheck();

    try {
      const fv   = this.detailsForm.value;
      const body = {
        items       : [{ name: fv.quotationNo || 'Payment', quantity: 1, unitPrice: this.convertedAmount }],
        customerInfo: { name: fv.name, email: fv.email, phone: fv.phone ?? '' },
        currency    : 'INR',
        notes       : [fv.quotationNo, fv.notes].filter(Boolean).join(' — ') || '',
        quotationNo : fv.quotationNo,
        slug        : this.slug,           // lets backend resolve the tenant
      };

      const res: any = await this.http
        .post(`${this.api}/payments/create-order`, body)
        .toPromise();

      this.order       = res.data?.order ?? res.order;
      this.orderId     = this.order!._id;
      this.currentStep = 'payment';

    } catch (err: any) {
      this.errorMessage =
        err?.error?.message ||
        err?.error?.errors?.map((e: any) => e.msg).join(', ') ||
        err?.message ||
        'Could not create order. Please try again.';
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  // ── Step 2 — Razorpay ──────────────────────────────────────────────────────
  async processPayment(): Promise<void> {
    if (!this.orderId) return;
    this.isLoading    = true;
    this.errorMessage = '';
    this.currentStep  = 'processing';
    this.cdr.markForCheck();

    try {
      await this.runRazorpayFlow();
    } catch (err: any) {
      const msg: string = err?.message ?? err?.error?.message ?? '';
      if (msg.toLowerCase().includes('cancel')) {
        this.currentStep  = 'payment';
        this.errorMessage = "Payment cancelled. You can try again whenever you're ready.";
      } else {
        this.currentStep  = 'error';
        this.errorMessage = msg || 'Payment failed. Please try again.';
      }
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  private async runRazorpayFlow(): Promise<void> {
    const loaded = await this.loadRazorpayScript();
    if (!loaded) throw new Error('Could not load Razorpay checkout. Check your internet connection.');

    const orderData: RazorpayOrderData = await this.http
      .post<any>(`${this.api}/payments/razorpay/create-order`, { orderId: this.orderId })
      .toPromise()
      .then((r: any) => r.data ?? r);

    if (!orderData?.razorpayOrderId)
      throw new Error('Failed to initialise Razorpay order. Please try again.');

    this.paymentId = orderData.paymentId;
    const fv = this.detailsForm.value;

    const response = await this.openRazorpayCheckout({
      key        : orderData.keyId,
      amount     : orderData.amount,
      currency   : 'INR',
      name       : this.tenant?.businessName ?? 'Payment',
      description: fv.quotationNo ?? 'Payment',
      order_id   : orderData.razorpayOrderId,
      prefill    : { name: fv.name, email: fv.email, contact: fv.phone ?? '' },
      theme      : { color: '#0e64a3' },
      notes      : { orderId: this.orderId, quotationNo: fv.quotationNo ?? '' },
    });

    await this.http.post<any>(`${this.api}/payments/razorpay/verify`, {
      razorpay_order_id  : response.razorpay_order_id,
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_signature : response.razorpay_signature,
      orderId            : this.orderId,
      paymentId          : this.paymentId,
    }).toPromise();

    this.successData = { id: response.razorpay_payment_id };
    this.currentStep = 'success';
  }

  // ── Razorpay helpers ───────────────────────────────────────────────────────
  private loadRazorpayScript(): Promise<boolean> {
    return new Promise(resolve => {
      if ((window as any).Razorpay) { resolve(true); return; }
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.async = true;
      s.onload  = () => resolve(true);
      s.onerror = () => resolve(false);
      document.body.appendChild(s);
    });
  }

  private openRazorpayCheckout(options: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const rzp = new (window as any).Razorpay({
        ...options,
        handler: (r: any) => this.zone.run(() => resolve(r)),
        modal  : { ondismiss: () => this.zone.run(() => reject(new Error('Payment was cancelled'))) },
      });
      rzp.on('payment.failed', (r: any) =>
        this.zone.run(() => reject(new Error(
          r?.error?.description || r?.error?.reason || 'Payment failed',
        ))),
      );
      rzp.open();
    });
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  goBackToLookup(): void {
    this.currentStep  = 'lookup';
    this.lookupError  = '';
    this.errorMessage = '';
    this.order        = null;
    this.orderId      = '';
    this.paymentId    = '';
    this.detailsForm.reset();
    this.cdr.markForCheck();
  }

  goBack(): void {
    this.currentStep  = 'details';
    this.errorMessage = '';
    this.order        = null;
    this.orderId      = '';
    this.paymentId    = '';
    this.cdr.markForCheck();
  }

  retryPayment(): void { this.currentStep = 'payment'; this.errorMessage = ''; this.cdr.markForCheck(); }

  startOver(): void {
    this.currentStep     = 'lookup';
    this.order           = null;
    this.orderId         = '';
    this.successData     = null;
    this.errorMessage    = '';
    this.lookupError     = '';
    this.convertedAmount = 0;
    this.lookupForm.reset();
    this.detailsForm.reset();
    this.cdr.markForCheck();
  }

  // ── Receipt download ───────────────────────────────────────────────────────
  async downloadReceipt(): Promise<void> {
    if (!this.order?._id || this.isDownloading) return;
    this.isDownloading = true;
    this.downloadError = '';
    this.cdr.markForCheck();

    try {
      const url = `${this.api}/payments/receipt/${this.order._id}`;
      const res  = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`Receipt unavailable (${res.status})`);

      const blob   = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href     = blobUrl;
      a.download = `receipt-${this.order._id}.pdf`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    } catch (err: any) {
      this.downloadError = err?.message ?? 'Receipt download failed.';
    } finally {
      this.isDownloading = false;
      this.cdr.markForCheck();
    }
  }

  // ── Form helpers ───────────────────────────────────────────────────────────
  isLookupFieldInvalid(f: string): boolean { const c = this.lookupForm.get(f); return !!(c?.invalid && c?.touched); }
  isFieldInvalid(f: string): boolean       { const c = this.detailsForm.get(f); return !!(c?.invalid && c?.touched); }

  getLookupFieldError(f: string): string { return this.controlError(this.lookupForm.get(f), f); }
  getFieldError(f: string)      : string { return this.controlError(this.detailsForm.get(f), f); }

  private controlError(c: AbstractControl | null, field: string): string {
    if (!c?.errors || !c?.touched) return '';
    if (c.errors['required'])  return 'This field is required';
    if (c.errors['email'])     return 'Enter a valid email address';
    if (c.errors['min'])       return 'Amount must be greater than 0';
    if (c.errors['minlength']) return `Minimum ${c.errors['minlength'].requiredLength} characters`;
    if (c.errors['maxlength']) return `Maximum ${c.errors['maxlength'].requiredLength} characters`;
    if (c.errors['pattern'])   return field === 'phone' ? 'Enter a valid phone number' : 'Invalid format';
    return 'Invalid value';
  }

  formatAmount(n: number): string {
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency', currency: 'INR',
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      }).format(n);
    } catch { return `₹${n.toFixed(2)}`; }
  }
}
