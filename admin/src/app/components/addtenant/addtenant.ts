import {
  Component, OnInit, OnDestroy, inject
} from '@angular/core';
import { CommonModule, TitleCasePipe, DatePipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, AbstractControl, Validators } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil, debounceTime, distinctUntilChanged, finalize } from 'rxjs/operators';
import { Environment } from '../environment/environment';
import { SuperAdminService, TenantSnapshot } from '../services/super-admin';

interface Tenant {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  businessName?: string;
  city?: string;
  currency: string;
  role: string;
  isActive: boolean;
  isSubUser: boolean;
  setupStep: string;
  createdAt: string;
  razorpay?: { isConfigured: boolean };
  crm?: { isConfigured: boolean };
  // Populated separately from /api/admin/tenants/overview — undefined until
  // that call resolves, so the table can show a lightweight loading state
  // for these columns without blocking the rest of the tenant list.
  snapshot?: TenantSnapshot;
}

@Component({
  selector: 'app-addtenant',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, TitleCasePipe],
  templateUrl: './addtenant.html',
  styleUrls: ['./addtenant.css'],
})
export class AddTenant implements OnInit, OnDestroy {

  // ── List state ─────────────────────────────────────────────
  tenants: Tenant[] = [];
  filteredTenants: Tenant[] = [];
  loading = false;
  searchQuery = '';
  activeFilter = 'all';
  currentPage = 1;
  pageSize = 15;
  totalTenants = 0;
  totalPages = 1;

  get activeTenants(): number {
    return this.tenants.filter(t => t.role !== 'superadmin' && t.isActive).length;
  }
  get setupPending(): number {
    return this.tenants.filter(t => t.role !== 'superadmin' && t.setupStep !== 'complete').length;
  }

  togglingId = '';
  resettingId = false;
  deletingId = false;

  // ── Modal state ────────────────────────────────────────────
  activeModal: 'view' | 'reset' | 'edit' | 'delete' | null = null;
  selectedTenant: Tenant | null = null;
  editForm!: FormGroup;
  editSubmitting = false;
  editErrorMsg = '';

  // ── Drawer state ───────────────────────────────────────────
  drawerVisible = false;
  drawerOpen = false;
  step = 1;
  submitting = false;
  successMsg = '';
  errorMsg = '';
  form!: FormGroup;

  private destroy$ = new Subject<void>();
  private searchSubject = new Subject<string>();

  // ── Single "tenant" role — no selection UI needed ──────────
  readonly tenantRole = {
    value: 'tenant',
    label: 'Tenant',
    desc: 'Full access to their own account and business settings',
    icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
  };

  // ── Cross-tenant monitoring snapshot (quotations/payments/royalty/integrations) ──
  private superAdminSvc = inject(SuperAdminService);
  private router = inject(Router);
  snapshotsLoading = false;

  constructor(private fb: FormBuilder, private http: HttpClient) { }

  ngOnInit(): void {
    this.buildForm();
    this.buildEditForm();
    this.loadTenants();
    this.searchSubject.pipe(
      debounceTime(300),
      distinctUntilChanged(),
      takeUntil(this.destroy$)
    ).subscribe(() => this.applyFilters());
  }

  // Populates each tenant's `snapshot` (quotations/payments/royalty/CRM/
  // Razorpay monitoring data) from the current-month overview endpoint.
  // Runs independently of loadTenants() so a slow CRM fetch for one tenant
  // never blocks the core tenant list from rendering.
  loadOverviewSnapshots(): void {
    this.snapshotsLoading = true;
    this.superAdminSvc.getTenantsOverview()
      .pipe(takeUntil(this.destroy$), finalize(() => this.snapshotsLoading = false))
      .subscribe({
        next: (res) => {
          const byId = new Map(res.data.tenants.map(s => [s.tenantId, s]));
          this.tenants = this.tenants.map(t => ({ ...t, snapshot: byId.get(t.tenantId) }));
          this.applyFilters();
        },
        error: () => {},
      });
  }

  openTenantOverview(t: Tenant): void {
    this.router.navigate(['/admin/tenants', t.tenantId]);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── Data ───────────────────────────────────────────────────
  loadTenants(): void {
    this.loading = true;
    const params = new URLSearchParams({
      page: String(this.currentPage),
      limit: String(this.pageSize),
      ...(this.searchQuery ? { search: this.searchQuery } : {}),
      ...(this.activeFilter === 'active' ? { active: 'true' } : {}),
      ...(this.activeFilter === 'inactive' ? { active: 'false' } : {}),
    });
    this.http
      .get<any>(`${Environment.API_URL}/api/admin/tenants?${params}`)
      .pipe(takeUntil(this.destroy$), finalize(() => this.loading = false))
      .subscribe({
        next: (res) => {
          // Exclude superadmin accounts from the tenant list
          this.tenants = (res.data || []).filter(
            (t: Tenant) => t.role !== 'superadmin' && !t.isSubUser
          );
          this.totalTenants = this.tenants.length;
          this.totalPages = Math.ceil(this.totalTenants / this.pageSize) || 1;
          this.applyFilters();
          // Re-merge monitoring data onto the freshly-replaced tenant array
          // (loadTenants() reassigns `tenants` wholesale, so any snapshot
          // merged in earlier would otherwise be lost on refresh/filter).
          this.loadOverviewSnapshots();
        },
        error: () => { },
      });
  }

  applyFilters(): void {
    // Always start by excluding superadmin
    let list = this.tenants.filter(t => t.role !== 'superadmin' && !t.isSubUser);

    if (this.activeFilter === 'active') list = list.filter(t => t.isActive);
    if (this.activeFilter === 'inactive') list = list.filter(t => !t.isActive);
    if (this.activeFilter === 'pending') list = list.filter(t => t.setupStep !== 'complete');

    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      list = list.filter(t =>
        `${t.firstName} ${t.lastName}`.toLowerCase().includes(q) ||
        t.email.toLowerCase().includes(q) ||
        (t.businessName || '').toLowerCase().includes(q)
      );
    }

    this.filteredTenants = list;
  }

  onSearch(): void { this.searchSubject.next(this.searchQuery); }
  clearSearch(): void { this.searchQuery = ''; this.applyFilters(); }
  setFilter(f: string): void { this.activeFilter = f; this.currentPage = 1; this.loadTenants(); }
  goToPage(p: number): void { this.currentPage = p; this.loadTenants(); }
  trackById(_: number, t: Tenant): string { return t.id; }

  // ── Tenant actions ─────────────────────────────────────────
  toggleStatus(t: Tenant): void {
    if (this.togglingId) return;
    this.togglingId = t.id;
    this.http
      .patch<any>(`${Environment.API_URL}/api/admin/tenants/${t.tenantId}/status`, { isActive: !t.isActive })
      .pipe(takeUntil(this.destroy$), finalize(() => this.togglingId = ''))
      .subscribe({
        next: (res) => {
          const idx = this.tenants.findIndex(x => x.id === t.id);
          if (idx > -1) this.tenants[idx] = { ...this.tenants[idx], ...res.data };
          this.applyFilters();
        },
        error: () => { },
      });
  }

  viewTenant(t: Tenant): void { this.selectedTenant = t; this.activeModal = 'view'; }
  resetPassword(t: Tenant): void { this.selectedTenant = t; this.activeModal = 'reset'; }
  closeModal(): void { this.activeModal = null; this.selectedTenant = null; }

  confirmResetPassword(): void {
    if (!this.selectedTenant) return;
    this.resettingId = true;
    this.http
      .post<any>(`${Environment.API_URL}/api/admin/tenants/${this.selectedTenant.tenantId}/reset-password`, {})
      .pipe(takeUntil(this.destroy$), finalize(() => this.resettingId = false))
      .subscribe({
        next: () => this.closeModal(),
        error: () => { },
      });
  }

  // ── Edit ───────────────────────────────────────────────────
  buildEditForm(): void {
    this.editForm = this.fb.group({
      firstName: ['', [Validators.required, Validators.maxLength(50)]],
      lastName: ['', [Validators.required, Validators.maxLength(50)]],
      email: ['', [Validators.required, Validators.email, Validators.maxLength(100)]],
      phone: ['', [Validators.required, Validators.pattern(/^[+]?[\d\s\-().]{7,20}$/)]],
      businessName: ['', [Validators.maxLength(100)]],
      city: ['', [Validators.maxLength(50)]],
    });
  }

  editTenant(t: Tenant): void {
    this.selectedTenant = t;
    this.editForm.reset({
      firstName: t.firstName, lastName: t.lastName, email: t.email, phone: t.phone || '',
      businessName: t.businessName || '', city: t.city || '',
    });
    this.editErrorMsg = '';
    this.activeModal = 'edit';
  }

  isEditInvalid(field: string): boolean {
    const c = this.editForm.get(field);
    return !!(c && c.invalid && (c.dirty || c.touched));
  }

  submitEdit(): void {
    if (!this.selectedTenant || this.editForm.invalid) { this.editForm.markAllAsTouched(); return; }
    const target = this.selectedTenant;
    this.editSubmitting = true;
    this.editErrorMsg = '';
    this.http
      .patch<any>(`${Environment.API_URL}/api/admin/tenants/${target.tenantId}`, this.editForm.value)
      .pipe(takeUntil(this.destroy$), finalize(() => this.editSubmitting = false))
      .subscribe({
        next: (res) => {
          const idx = this.tenants.findIndex(x => x.id === target.id);
          if (idx > -1) this.tenants[idx] = { ...this.tenants[idx], ...res.data };
          this.applyFilters();
          this.closeModal();
        },
        error: (err) => {
          this.editErrorMsg = err.error?.message || 'Failed to update tenant.';
        },
      });
  }

  // ── Delete ─────────────────────────────────────────────────
  deleteTenant(t: Tenant): void { this.selectedTenant = t; this.activeModal = 'delete'; }

  confirmDeleteTenant(): void {
    if (!this.selectedTenant) return;
    const target = this.selectedTenant;
    this.deletingId = true;
    this.http
      .delete<any>(`${Environment.API_URL}/api/admin/tenants/${target.tenantId}`)
      .pipe(takeUntil(this.destroy$), finalize(() => this.deletingId = false))
      .subscribe({
        next: () => {
          this.tenants = this.tenants.filter(x => x.id !== target.id);
          this.totalTenants = this.tenants.length;
          this.applyFilters();
          this.closeModal();
        },
        error: () => { },
      });
  }

  // ── Helpers ────────────────────────────────────────────────
  getInitials(t: Tenant): string {
    return `${t.firstName?.[0] || ''}${t.lastName?.[0] || ''}`.toUpperCase();
  }

  getSetupPct(step: string): number {
    const map: Record<string, number> = { business: 25, razorpay: 50, crm: 75, complete: 100 };
    return map[step] ?? 0;
  }

  getSetupLabel(step: string): string {
    const map: Record<string, string> = {
      business: 'Business info',
      razorpay: 'Razorpay pending',
      crm: 'CRM pending',
      complete: 'Complete ✓',
    };
    return map[step] ?? step;
  }

  // ── Drawer ─────────────────────────────────────────────────
  buildForm(): void {
    this.form = this.fb.group({
      firstName: ['', [Validators.required, Validators.maxLength(50), Validators.pattern(/^[a-zA-Z\s'-]+$/)]],
      lastName: ['', [Validators.required, Validators.maxLength(50), Validators.pattern(/^[a-zA-Z\s'-]+$/)]],
      email: ['', [Validators.required, Validators.email, Validators.maxLength(100)]],
      // phone is now REQUIRED
      phone: ['', [Validators.required, Validators.pattern(/^[+]?[\d\s\-().]{7,20}$/)]],
      // role is fixed — always 'tenant', no user selection
      role: ['tenant', Validators.required],
    });
  }

  openDrawer(): void {
    this.form.reset({ role: 'tenant' });
    this.step = 1;
    this.successMsg = '';
    this.errorMsg = '';
    this.drawerVisible = true;
    setTimeout(() => this.drawerOpen = true, 10);
  }

  closeDrawer(): void {
    this.drawerOpen = false;
    setTimeout(() => this.drawerVisible = false, 400);
  }

  onOverlayClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains('at-scrim')) this.closeDrawer();
  }

  drawerNext(): void {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    this.errorMsg = '';
    this.step = 2;
  }

  drawerBack(): void {
    this.errorMsg = '';
    this.step = 1;
  }

  submit(): void {
    if (this.form.invalid) return;
    this.submitting = true;
    this.errorMsg = '';
    this.successMsg = '';
    this.http
      .post<any>(
        `${Environment.API_URL}/api/admin/tenants`,
        { ...this.form.value, role: 'tenant', createdBySuperAdmin: true }
      )
      .pipe(takeUntil(this.destroy$), finalize(() => this.submitting = false))
      .subscribe({
        next: (res) => {
          this.successMsg = `Tenant created! Credentials sent to ${this.form.value.email}`;

          // Prepend the new tenant
          const newTenant = { ...res.data };
          this.tenants.unshift(newTenant);

          // Switch to "Setup Pending" filter so it's immediately visible
          this.activeFilter = 'pending';
          this.totalTenants = this.tenants.filter(t => t.role !== 'superadmin').length;
          this.applyFilters();

          setTimeout(() => this.closeDrawer(), 2200);
        },
        error: (err) => {
          this.errorMsg = err.error?.message || 'Failed to create tenant. Please try again.';
        },
      });
  }

  isInvalid(field: string): boolean {
    const c = this.form.get(field);
    return !!(c && c.invalid && (c.dirty || c.touched));
  }

  getErr(field: string): string {
    return this.errForControl(this.form.get(field));
  }

  getEditErr(field: string): string {
    return this.errForControl(this.editForm.get(field));
  }

  private errForControl(c: AbstractControl | null): string {
    if (!c?.errors) return '';
    if (c.errors['required']) return 'This field is required.';
    if (c.errors['email']) return 'Enter a valid email address.';
    if (c.errors['maxlength']) return `Max ${c.errors['maxlength'].requiredLength} characters.`;
    if (c.errors['pattern']) return 'Enter a valid phone number (e.g. +91 98765 43210).';
    return 'Invalid value.';
  }
}
