import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, takeUntil, finalize } from 'rxjs';

import {
  SuperAdminBillingService, BillingRow, BillingSummary, Pagination,
  TenantBillingDetail, InvoiceDetail, AuditLogEntry, FollowUpBuckets,
  BillingCalendar, CalendarEvent, BillingAnalytics,
} from '../services/billing';
import { SubscriptionPlansService, SubscriptionPlan } from '../services/subscription-plans';
import { BillingSettingsService, BillingSettings } from '../services/billing-settings';
import { describeHttpError } from '../services/api-error';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

type Tab = 'overview' | 'plans' | 'followups' | 'calendar' | 'analytics' | 'settings';

@Component({
  selector: 'app-super-admin-billing',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './super-admin-billing.html',
  styleUrls: ['./super-admin-billing.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SuperAdminBilling implements OnInit, OnDestroy {

  activeTab: Tab = 'overview';
  private loadedTabs = new Set<Tab>();

  readonly monthOptions = MONTH_NAMES.map((label, i) => ({ value: i + 1, label }));
  readonly yearOptions: number[] = (() => {
    const y = new Date().getFullYear();
    return [y - 1, y, y + 1];
  })();

  // ── Toast (success/error notifications) ──────────────────────────────────
  showToast = false;
  toastMsg = '';
  toastType: 'success' | 'error' = 'success';
  private toastTimer?: ReturnType<typeof setTimeout>;

  showToastMsg(msg: string, type: 'success' | 'error' = 'success'): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastMsg = msg;
    this.toastType = type;
    this.showToast = true;
    this.cdr.markForCheck();
    this.toastTimer = setTimeout(() => { this.showToast = false; this.cdr.markForCheck(); }, 2600);
  }

  private destroy$ = new Subject<void>();

  constructor(
    private svc: SuperAdminBillingService,
    private plansSvc: SubscriptionPlansService,
    private settingsSvc: BillingSettingsService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.overviewFilterTrigger$.pipe(debounceTime(250), takeUntil(this.destroy$)).subscribe(() => this.loadOverview());
    this.calendarFilterTrigger$.pipe(debounceTime(300), takeUntil(this.destroy$)).subscribe(() => this.loadCalendar());
    this.loadOverview();
    this.plansSvc.list(true).pipe(takeUntil(this.destroy$)).subscribe({
      next: (res) => { this.allPlans = res.data; this.cdr.markForCheck(); },
      error: () => {},
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next(); this.destroy$.complete();
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  switchTab(tab: Tab): void {
    this.activeTab = tab;
    if (!this.loadedTabs.has(tab)) {
      this.loadedTabs.add(tab);
      if (tab === 'followups') this.loadFollowUpBuckets();
      if (tab === 'calendar') this.loadCalendar();
      if (tab === 'analytics') this.loadAnalytics();
      if (tab === 'settings') this.loadSettings();
    }
    this.cdr.markForCheck();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB 1 — OVERVIEW
  // ══════════════════════════════════════════════════════════════════════════

  rows: BillingRow[] = [];
  summary: BillingSummary = this.emptySummary();
  pagination: Pagination = { page: 1, limit: 25, total: 0, pages: 1 };
  isLoading = true;
  isExporting = false;
  skeletonRows = Array(6);
  filtersCollapsed = true;

  selectedMonth = new Date().getMonth() + 1;
  selectedYear = new Date().getFullYear();
  searchQuery = '';
  activeStatus = '';
  planFilter = '';
  paymentMethodFilter = '';
  minAmountFilter: number | null = null;
  maxAmountFilter: number | null = null;
  dueWindowFilter = '';
  followUpStatusFilter = '';
  pageSize = 25;

  readonly statusOptions = [
    { value: '', label: 'All' },
    { value: 'trial', label: 'Trial' },
    { value: 'active', label: 'Active' },
    { value: 'grace_period', label: 'Grace Period' },
    { value: 'overdue', label: 'Overdue' },
    { value: 'suspended', label: 'Suspended' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'unenrolled', label: 'Unenrolled' },
  ];

  readonly dueWindowOptions = [
    { value: '', label: 'Any time' },
    { value: 'today', label: 'Due Today' },
    { value: 'week', label: 'Due This Week' },
    { value: 'month', label: 'Due This Month' },
  ];

  readonly overviewPaymentMethodOptions = ['Bank Transfer', 'UPI', 'Cheque', 'Cash', 'Other'];

  private overviewFilterTrigger$ = new Subject<void>();

  loadOverview(resetPage = true): void {
    if (resetPage) this.pagination = { ...this.pagination, page: 1 };
    this.isLoading = true;
    this.cdr.markForCheck();

    this.svc.getOverview({
      month: this.selectedMonth, year: this.selectedYear,
      status: this.activeStatus, search: this.searchQuery.trim(),
      planId: this.planFilter, paymentMethod: this.paymentMethodFilter,
      minAmount: this.minAmountFilter ?? undefined, maxAmount: this.maxAmountFilter ?? undefined,
      dueWindow: this.dueWindowFilter || undefined, followUpStatus: this.followUpStatusFilter,
      page: this.pagination.page, limit: this.pageSize,
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: (res) => {
        this.rows = res.data.rows;
        this.summary = res.data.summary;
        this.pagination = res.data.pagination;
        this.isLoading = false;
        this.lastRefreshedAt = new Date();
        this.cdr.markForCheck();
      },
      // Used to fail silently, leaving an empty billing page with no reason.
      error: (err) => {
        this.isLoading = false;
        this.showToastMsg(describeHttpError(err, 'Could not load billing.'), 'error');
        this.cdr.markForCheck();
      },
    });
  }

  lastRefreshedAt = new Date();

  refresh(): void { this.loadOverview(false); }
  onPeriodChange(): void { this.overviewFilterTrigger$.next(); }
  applyFiltersDebounced(): void { this.overviewFilterTrigger$.next(); }
  toggleFilters(): void { this.filtersCollapsed = !this.filtersCollapsed; }

  /** KPI cards are clickable — jumps to the Overview tab pre-filtered to that status. */
  filterByStatus(status: string): void {
    this.activeTab = 'overview';
    this.activeStatus = status;
    this.overviewFilterTrigger$.next();
    this.cdr.markForCheck();
  }

  resetFilters(): void {
    const now = new Date();
    this.selectedMonth = now.getMonth() + 1;
    this.selectedYear = now.getFullYear();
    this.searchQuery = '';
    this.activeStatus = '';
    this.planFilter = '';
    this.paymentMethodFilter = '';
    this.minAmountFilter = null;
    this.maxAmountFilter = null;
    this.dueWindowFilter = '';
    this.followUpStatusFilter = '';
    this.overviewFilterTrigger$.next();
  }

  get activeFilterCount(): number {
    return [
      this.searchQuery, this.activeStatus, this.planFilter, this.paymentMethodFilter,
      this.minAmountFilter, this.maxAmountFilter, this.dueWindowFilter, this.followUpStatusFilter,
    ].filter((v) => v !== '' && v !== null && v !== undefined).length;
  }

  goToPage(page: number): void {
    if (page < 1 || page > this.pagination.pages || page === this.pagination.page) return;
    this.pagination = { ...this.pagination, page };
    this.loadOverview(false);
  }

  onPageSizeChange(): void { this.loadOverview(true); }

  exportCSV(): void {
    if (this.isExporting) return;
    this.isExporting = true;
    this.cdr.markForCheck();

    this.svc.getOverview({
      month: this.selectedMonth, year: this.selectedYear,
      status: this.activeStatus, search: this.searchQuery.trim(),
      planId: this.planFilter, paymentMethod: this.paymentMethodFilter,
      minAmount: this.minAmountFilter ?? undefined, maxAmount: this.maxAmountFilter ?? undefined,
      dueWindow: this.dueWindowFilter || undefined, followUpStatus: this.followUpStatusFilter,
      page: 1, limit: 5000,
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: (res) => { this.isExporting = false; this.downloadCSV(res.data.rows); this.cdr.markForCheck(); },
      error: () => { this.isExporting = false; this.cdr.markForCheck(); },
    });
  }

  private downloadCSV(rows: BillingRow[]): void {
    const headers = [
      'Tenant', 'Owner', 'Email', 'Plan', 'Enrolled', 'Monthly Fee', 'GST %', 'Billing Day',
      'Status', 'Invoice #', 'Invoice Period', 'Amount Due', 'Due Date', 'Days Overdue',
      'Paid Amount', 'Outstanding', 'Last Payment Date', 'Last Payment Amount',
    ];
    const csvRows = rows.map(r => [
      r.tenantName, r.ownerName, r.email, r.planName, r.isEnrolled ? 'Yes' : 'No', r.monthlyFee, r.gstPercent, r.billingDay,
      r.billingState, r.currentInvoice?.invoiceNumber ?? '—',
      r.currentInvoice ? `${this.monthOptions[r.currentInvoice.periodMonth - 1].label} ${r.currentInvoice.periodYear}` : '—',
      r.currentInvoice?.totalAmount ?? '', r.currentInvoice?.dueDate ?? '', r.currentInvoice?.daysOverdue ?? 0,
      r.currentInvoice?.paidAmount ?? '', r.outstandingAmount, r.lastPayment?.paidAt ?? '', r.lastPayment?.amount ?? '',
    ]);
    const csv = [headers, ...csvRows]
      .map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url, download: `billing-${this.selectedYear}-${String(this.selectedMonth).padStart(2, '0')}.csv`,
    }).click();
    URL.revokeObjectURL(url);
  }

  // ── Detail drawer ──────────────────────────────────────────────────────────
  drawerVisible = false;
  drawerOpen = false;
  detailLoading = false;
  detail: TenantBillingDetail | null = null;
  detailErrorMsg = '';
  allPlans: SubscriptionPlan[] = [];
  get activePlans(): SubscriptionPlan[] { return this.allPlans.filter(p => p.isActive); }

  drawerSection: 'config' | 'statement' | 'activity' = 'config';

  cfgIsEnrolled = false;
  cfgMonthlyFee: number | null = 0;
  cfgGstPercent: number | null = 18;
  cfgDiscountType: 'percent' | 'flat' = 'percent';
  cfgDiscountValue: number | null = 0;
  cfgBillingDay = 1;
  cfgGracePeriodDays: number | null = null;
  cfgTrialDays: number | null = 0;
  cfgSaving = false;
  cfgErrorMsg = '';
  cfgSuccessMsg = '';

  selectedPlanId = '';
  planChanging = false;

  reactivating = false;
  cancelling = false;
  cancelReason = '';
  showCancelConfirm = false;

  statementFrom = '';
  statementTo = '';

  auditLog: AuditLogEntry[] = [];
  auditLoading = false;

  openDetail(row: BillingRow): void {
    this.drawerVisible = true;
    this.drawerSection = 'config';
    setTimeout(() => this.drawerOpen = true, 10);
    this.loadDetail(row.tenantId);
  }

  closeDetail(): void {
    this.drawerOpen = false;
    setTimeout(() => { this.drawerVisible = false; this.detail = null; this.auditLog = []; }, 300);
  }

  onOverlayClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains('sb-scrim')) this.closeDetail();
  }

  loadDetail(tenantId: string): void {
    this.detailLoading = true;
    this.detailErrorMsg = '';
    this.cfgSuccessMsg = '';
    this.cdr.markForCheck();

    this.svc.getTenantDetail(tenantId).pipe(takeUntil(this.destroy$)).subscribe({
      next: (res) => {
        this.detail = res.data;
        const s = res.data.subscription;
        this.cfgIsEnrolled = s.isEnrolled;
        this.cfgMonthlyFee = s.monthlyFee;
        this.cfgGstPercent = s.gstPercent;
        this.cfgDiscountType = s.discountType;
        this.cfgDiscountValue = s.discountValue;
        this.cfgBillingDay = s.billingDay;
        this.cfgGracePeriodDays = s.gracePeriodDays;
        this.selectedPlanId = s.planId || '';
        this.detailLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.detailErrorMsg = err.error?.message || 'Failed to load billing detail.';
        this.detailLoading = false;
        this.cdr.markForCheck();
      },
    });
  }

  switchDrawerSection(section: 'config' | 'statement' | 'activity'): void {
    this.drawerSection = section;
    if (section === 'activity' && this.detail && !this.auditLog.length) this.loadAuditLog();
    this.cdr.markForCheck();
  }

  loadAuditLog(): void {
    if (!this.detail) return;
    this.auditLoading = true;
    this.cdr.markForCheck();
    this.svc.getAuditLog(this.detail.tenant.tenantId)
      .pipe(takeUntil(this.destroy$), finalize(() => { this.auditLoading = false; this.cdr.markForCheck(); }))
      .subscribe({ next: (res) => { this.auditLog = res.data; }, error: () => {} });
  }

  saveConfig(): void {
    if (!this.detail) return;
    this.cfgSaving = true;
    this.cfgErrorMsg = '';
    this.cfgSuccessMsg = '';
    this.cdr.markForCheck();

    this.svc.updateConfig(this.detail.tenant.tenantId, {
      isEnrolled: this.cfgIsEnrolled,
      monthlyFee: this.cfgMonthlyFee ?? 0,
      gstPercent: this.cfgGstPercent ?? 0,
      discountType: this.cfgDiscountType,
      discountValue: this.cfgDiscountValue ?? 0,
      billingDay: this.cfgBillingDay,
      gracePeriodDays: this.cfgGracePeriodDays,
      trialDays: this.cfgTrialDays ?? 0,
    }).pipe(takeUntil(this.destroy$), finalize(() => { this.cfgSaving = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.cfgSuccessMsg = 'Billing configuration saved.';
          this.showToastMsg('Billing configuration saved.');
          this.loadDetail(this.detail!.tenant.tenantId);
          this.loadOverview(false);
        },
        error: (err) => {
          this.cfgErrorMsg = err.error?.message || 'Failed to save configuration.';
          this.showToastMsg(this.cfgErrorMsg, 'error');
        },
      });
  }

  applyPlan(): void {
    if (!this.detail || !this.selectedPlanId) return;
    this.planChanging = true;
    this.cdr.markForCheck();
    this.svc.changePlan(this.detail.tenant.tenantId, this.selectedPlanId)
      .pipe(takeUntil(this.destroy$), finalize(() => { this.planChanging = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg('Plan applied.');
          this.loadDetail(this.detail!.tenant.tenantId); this.loadOverview(false);
        },
        error: (err) => {
          this.cfgErrorMsg = err.error?.message || 'Failed to change plan.';
          this.showToastMsg(this.cfgErrorMsg, 'error');
        },
      });
  }

  planLabel(p: SubscriptionPlan): string {
    return `${p.name} — ${this.fmtINR(p.monthlyPrice)}/mo${p.isActive ? '' : ' (inactive)'}`;
  }

  doReactivate(): void {
    if (!this.detail) return;
    this.reactivating = true;
    this.cdr.markForCheck();
    this.svc.reactivate(this.detail.tenant.tenantId)
      .pipe(takeUntil(this.destroy$), finalize(() => { this.reactivating = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg('Tenant reactivated.');
          this.loadDetail(this.detail!.tenant.tenantId); this.loadOverview(false);
        },
        error: (err) => this.showToastMsg(err.error?.message || 'Failed to reactivate.', 'error'),
      });
  }

  // ── Manual suspend ─────────────────────────────────────────────────────────
  suspending = false;
  suspendReason = '';
  showSuspendConfirm = false;

  openSuspendConfirm(): void { this.showSuspendConfirm = true; this.suspendReason = ''; }
  closeSuspendConfirm(): void { this.showSuspendConfirm = false; }

  doSuspend(): void {
    if (!this.detail) return;
    this.suspending = true;
    this.cdr.markForCheck();
    this.svc.suspend(this.detail.tenant.tenantId, this.suspendReason)
      .pipe(takeUntil(this.destroy$), finalize(() => { this.suspending = false; this.showSuspendConfirm = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg('Tenant suspended.');
          this.loadDetail(this.detail!.tenant.tenantId); this.loadOverview(false);
        },
        error: (err) => this.showToastMsg(err.error?.message || 'Failed to suspend.', 'error'),
      });
  }

  openCancelConfirm(): void { this.showCancelConfirm = true; this.cancelReason = ''; }
  closeCancelConfirm(): void { this.showCancelConfirm = false; }

  doCancelSubscription(): void {
    if (!this.detail) return;
    this.cancelling = true;
    this.cdr.markForCheck();
    this.svc.cancelSubscription(this.detail.tenant.tenantId, this.cancelReason)
      .pipe(takeUntil(this.destroy$), finalize(() => { this.cancelling = false; this.showCancelConfirm = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg('Subscription cancelled.');
          this.loadDetail(this.detail!.tenant.tenantId); this.loadOverview(false);
        },
        error: (err) => this.showToastMsg(err.error?.message || 'Failed to cancel subscription.', 'error'),
      });
  }

  // ── Statement (per-tenant invoice ledger) ─────────────────────────────────
  get filteredStatementInvoices(): InvoiceDetail[] {
    if (!this.detail) return [];
    let invs = this.detail.subscription.invoices;
    if (this.statementFrom) invs = invs.filter(i => new Date(i.createdAt) >= new Date(this.statementFrom));
    if (this.statementTo) invs = invs.filter(i => new Date(i.createdAt) <= new Date(this.statementTo + 'T23:59:59'));
    return [...invs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  get statementTotals() {
    const invs = this.detail?.subscription.invoices ?? [];
    const totalBilled = round2(invs.reduce((s, i) => s + i.totalAmount, 0));
    const totalPaid = round2(invs.reduce((s, i) => s + i.paidAmount, 0));
    const totalOutstanding = round2(invs.filter(i => !['paid', 'cancelled', 'refunded'].includes(i.status))
      .reduce((s, i) => s + Math.max(0, i.totalAmount - i.paidAmount), 0));
    const totalOverdue = round2(invs.filter(i => i.status === 'overdue')
      .reduce((s, i) => s + Math.max(0, i.totalAmount - i.paidAmount), 0));
    const totalRefunded = round2(invs.reduce((s, i) => s + i.refunds.reduce((rs, r) => rs + r.amount, 0), 0));
    const lastPaid = invs.filter(i => i.paidAt).sort((a, b) => new Date(b.paidAt!).getTime() - new Date(a.paidAt!).getTime())[0] ?? null;
    const nextDue = invs.filter(i => ['pending', 'overdue', 'partially_paid'].includes(i.status))
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())[0] ?? null;
    return { totalBilled, totalPaid, totalOutstanding, totalOverdue, totalRefunded, lastPaid, nextDue };
  }

  clearStatementFilter(): void { this.statementFrom = ''; this.statementTo = ''; }

  exportStatementCSV(): void {
    if (!this.detail) return;
    const headers = ['Date', 'Invoice', 'Description', 'Amount', 'Paid', 'Balance', 'Status'];
    const rows = this.filteredStatementInvoices.map(i => [
      this.fmtDate(i.createdAt), i.invoiceNumber, `${i.planName || 'Subscription'} — ${this.periodLabel(i.periodMonth, i.periodYear)}`,
      i.totalAmount, i.paidAmount, round2(Math.max(0, i.totalAmount - i.paidAmount)), this.invoiceStatusLabel(i.status),
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: `statement-${this.detail.tenant.tenantId}.csv` }).click();
    URL.revokeObjectURL(url);
  }

  downloadPdf(invoice: InvoiceDetail, mode: 'invoice' | 'receipt'): void {
    if (!this.detail) return;
    this.svc.downloadInvoicePdf(this.detail.tenant.tenantId, invoice._id, mode)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (blob) => {
          const url = URL.createObjectURL(blob);
          Object.assign(document.createElement('a'), { href: url, download: `${mode}-${invoice.invoiceNumber}.pdf` }).click();
          URL.revokeObjectURL(url);
        },
        error: () => this.showToastMsg('Failed to download PDF.', 'error'),
      });
  }

  remindingId: string | null = null;

  sendReminderNow(invoice: InvoiceDetail): void {
    if (!this.detail) return;
    this.remindingId = invoice._id;
    this.cdr.markForCheck();
    this.svc.sendReminder(this.detail.tenant.tenantId, invoice._id)
      .pipe(takeUntil(this.destroy$), finalize(() => { this.remindingId = null; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => this.showToastMsg(`Reminder sent for ${invoice.invoiceNumber}.`),
        error: (err) => this.showToastMsg(err.error?.message || 'Failed to send reminder.', 'error'),
      });
  }

  // ── Record payment modal ──────────────────────────────────────────────────
  paymentTarget: InvoiceDetail | null = null;
  paymentAmount: number | null = null;
  paymentMethod = 'Bank Transfer';
  paymentReference = '';
  paymentNotes = '';
  paymentDate = '';
  paymentSaving = false;
  paymentErrorMsg = '';

  readonly paymentMethodOptions = ['Bank Transfer', 'UPI', 'Cheque', 'Cash', 'Other'];

  openPaymentModal(invoice: InvoiceDetail): void {
    this.paymentTarget = invoice;
    this.paymentAmount = round2(invoice.totalAmount - (invoice.paidAmount || 0));
    this.paymentMethod = 'Bank Transfer';
    this.paymentReference = '';
    this.paymentNotes = '';
    this.paymentDate = new Date().toISOString().slice(0, 10);
    this.paymentErrorMsg = '';
    this.cdr.markForCheck();
  }

  cancelPayment(): void { this.paymentTarget = null; }

  submitPayment(): void {
    if (!this.detail || !this.paymentTarget) return;
    if (!this.paymentAmount || this.paymentAmount <= 0) {
      this.paymentErrorMsg = 'Enter an amount greater than 0.';
      return;
    }
    this.paymentSaving = true;
    this.paymentErrorMsg = '';
    this.cdr.markForCheck();

    this.svc.recordPayment(this.detail.tenant.tenantId, this.paymentTarget._id, {
      amount: this.paymentAmount, method: this.paymentMethod,
      referenceNumber: this.paymentReference, notes: this.paymentNotes,
      paidAt: this.paymentDate || undefined,
    }).pipe(takeUntil(this.destroy$), finalize(() => { this.paymentSaving = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg('Payment recorded.');
          this.paymentTarget = null;
          this.loadDetail(this.detail!.tenant.tenantId);
          this.loadOverview(false);
        },
        error: (err) => { this.paymentErrorMsg = err.error?.message || 'Failed to record payment.'; },
      });
  }

  // ── Mark failed modal ──────────────────────────────────────────────────────
  failTarget: InvoiceDetail | null = null;
  failReason = '';
  failSaving = false;

  openFailModal(invoice: InvoiceDetail): void { this.failTarget = invoice; this.failReason = ''; }
  cancelFail(): void { this.failTarget = null; }

  submitFail(): void {
    if (!this.detail || !this.failTarget) return;
    this.failSaving = true;
    this.cdr.markForCheck();
    this.svc.markPaymentFailed(this.detail.tenant.tenantId, this.failTarget._id, this.failReason)
      .pipe(takeUntil(this.destroy$), finalize(() => { this.failSaving = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg('Payment marked as failed.');
          this.failTarget = null; this.loadDetail(this.detail!.tenant.tenantId); this.loadOverview(false);
        },
        error: (err) => { this.failTarget = null; this.showToastMsg(err.error?.message || 'Failed to update invoice.', 'error'); },
      });
  }

  // ── Refund modal ────────────────────────────────────────────────────────
  refundTarget: InvoiceDetail | null = null;
  refundAmount: number | null = null;
  refundReason = '';
  refundSaving = false;
  refundErrorMsg = '';

  openRefundModal(invoice: InvoiceDetail): void {
    this.refundTarget = invoice;
    this.refundAmount = round2(invoice.paidAmount - invoice.refunds.reduce((s, r) => s + r.amount, 0));
    this.refundReason = '';
    this.refundErrorMsg = '';
  }
  cancelRefund(): void { this.refundTarget = null; }

  submitRefund(): void {
    if (!this.detail || !this.refundTarget) return;
    if (!this.refundAmount || this.refundAmount <= 0) { this.refundErrorMsg = 'Enter an amount greater than 0.'; return; }
    this.refundSaving = true;
    this.refundErrorMsg = '';
    this.cdr.markForCheck();
    this.svc.issueRefund(this.detail.tenant.tenantId, this.refundTarget._id, { amount: this.refundAmount, reason: this.refundReason })
      .pipe(takeUntil(this.destroy$), finalize(() => { this.refundSaving = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg('Refund recorded.');
          this.refundTarget = null; this.loadDetail(this.detail!.tenant.tenantId); this.loadOverview(false);
        },
        error: (err) => { this.refundErrorMsg = err.error?.message || 'Failed to record refund.'; },
      });
  }

  // ── Adjustment (credit/debit) modal ───────────────────────────────────────
  adjustmentTarget: InvoiceDetail | null = null;
  adjustmentAmount: number | null = null;
  adjustmentType: 'credit' | 'debit' = 'credit';
  adjustmentReason = '';
  adjustmentSaving = false;
  adjustmentErrorMsg = '';

  openAdjustmentModal(invoice: InvoiceDetail): void {
    this.adjustmentTarget = invoice;
    this.adjustmentAmount = null;
    this.adjustmentType = 'credit';
    this.adjustmentReason = '';
    this.adjustmentErrorMsg = '';
  }
  cancelAdjustment(): void { this.adjustmentTarget = null; }

  submitAdjustment(): void {
    if (!this.detail || !this.adjustmentTarget) return;
    if (!this.adjustmentAmount || this.adjustmentAmount <= 0) { this.adjustmentErrorMsg = 'Enter an amount greater than 0.'; return; }
    this.adjustmentSaving = true;
    this.adjustmentErrorMsg = '';
    this.cdr.markForCheck();
    this.svc.applyAdjustment(this.detail.tenant.tenantId, this.adjustmentTarget._id, {
      amount: this.adjustmentAmount, type: this.adjustmentType, reason: this.adjustmentReason,
    }).pipe(takeUntil(this.destroy$), finalize(() => { this.adjustmentSaving = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg(`${this.adjustmentType === 'credit' ? 'Credit' : 'Debit'} applied.`);
          this.adjustmentTarget = null; this.loadDetail(this.detail!.tenant.tenantId); this.loadOverview(false);
        },
        error: (err) => { this.adjustmentErrorMsg = err.error?.message || 'Failed to apply adjustment.'; },
      });
  }

  // ── Follow-up modal ────────────────────────────────────────────────────────
  followUpTarget: InvoiceDetail | null = null;
  followUpNote = '';
  followUpType: string = 'call';
  followUpContact = '';
  followUpStaff = '';
  followUpStatusVal: string = 'pending';
  followUpDate = '';
  followUpSaving = false;
  followUpErrorMsg = '';

  readonly followUpTypeOptions = [
    { value: 'call', label: 'Phone Call' }, { value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'sms', label: 'SMS' }, { value: 'in_person', label: 'In Person' }, { value: 'other', label: 'Other' },
  ];
  readonly followUpStatusOptions = [
    { value: 'pending', label: 'Pending' }, { value: 'contacted', label: 'Contacted' },
    { value: 'promised_to_pay', label: 'Promised to Pay' }, { value: 'payment_received', label: 'Payment Received' },
    { value: 'escalated', label: 'Escalated' }, { value: 'no_response', label: 'No Response' }, { value: 'closed', label: 'Closed' },
  ];

  openFollowUpModal(invoice: InvoiceDetail): void {
    this.followUpTarget = invoice;
    this.followUpNote = '';
    this.followUpType = 'call';
    this.followUpContact = '';
    this.followUpStaff = '';
    this.followUpStatusVal = 'pending';
    this.followUpDate = '';
    this.followUpErrorMsg = '';
    this.cdr.markForCheck();
  }

  cancelFollowUp(): void { this.followUpTarget = null; }

  submitFollowUp(): void {
    if (!this.detail || !this.followUpTarget) return;
    if (!this.followUpNote.trim()) { this.followUpErrorMsg = 'Enter a note.'; return; }
    this.followUpSaving = true;
    this.followUpErrorMsg = '';
    this.cdr.markForCheck();

    this.svc.addFollowUp(this.detail.tenant.tenantId, this.followUpTarget._id, {
      note: this.followUpNote.trim(), type: this.followUpType as any, contactMethod: this.followUpContact,
      assignedStaffName: this.followUpStaff, followUpStatus: this.followUpStatusVal as any,
      nextFollowUpDate: this.followUpDate || null,
    }).pipe(takeUntil(this.destroy$), finalize(() => { this.followUpSaving = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg('Follow-up added.');
          this.followUpTarget = null; this.loadDetail(this.detail!.tenant.tenantId); this.loadOverview(false);
        },
        error: (err) => { this.followUpErrorMsg = err.error?.message || 'Failed to add follow-up.'; },
      });
  }

  updateFollowUpStatusInline(invoice: InvoiceDetail, followUpId: string, status: string): void {
    if (!this.detail) return;
    this.svc.updateFollowUpStatus(this.detail.tenant.tenantId, invoice._id, followUpId, status as any)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => { this.showToastMsg('Follow-up status updated.'); this.loadDetail(this.detail!.tenant.tenantId); },
        error: (err) => this.showToastMsg(err.error?.message || 'Failed to update follow-up.', 'error'),
      });
  }

  // ── Waive confirm ──────────────────────────────────────────────────────────
  waiveTarget: InvoiceDetail | null = null;
  waiveSaving = false;

  confirmWaive(invoice: InvoiceDetail): void { this.waiveTarget = invoice; }
  cancelWaive(): void { this.waiveTarget = null; }

  doWaive(): void {
    if (!this.detail || !this.waiveTarget) return;
    this.waiveSaving = true;
    this.cdr.markForCheck();
    this.svc.waiveInvoice(this.detail.tenant.tenantId, this.waiveTarget._id)
      .pipe(takeUntil(this.destroy$), finalize(() => { this.waiveSaving = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg('Invoice waived.');
          this.waiveTarget = null; this.loadDetail(this.detail!.tenant.tenantId); this.loadOverview(false);
        },
        error: (err) => { this.waiveTarget = null; this.showToastMsg(err.error?.message || 'Failed to waive invoice.', 'error'); },
      });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB 2 — SUBSCRIPTION PLANS
  // ══════════════════════════════════════════════════════════════════════════

  plansLoading = false;
  planDrawerVisible = false;
  planDrawerMode: 'create' | 'edit' = 'create';
  planForm = { name: '', description: '', monthlyPrice: 0, gstPercent: 18, trialDays: 0, gracePeriodDays: null as number | null, featuresText: '' };
  planSaving = false;
  planErrorMsg = '';
  editingPlan: SubscriptionPlan | null = null;

  loadPlans(): void {
    this.plansLoading = true;
    this.cdr.markForCheck();
    this.plansSvc.list(true).pipe(takeUntil(this.destroy$), finalize(() => { this.plansLoading = false; this.cdr.markForCheck(); }))
      .subscribe({ next: (res) => { this.allPlans = res.data; }, error: () => {} });
  }

  openCreatePlan(): void {
    this.planDrawerMode = 'create';
    this.editingPlan = null;
    this.planForm = { name: '', description: '', monthlyPrice: 0, gstPercent: 18, trialDays: 0, gracePeriodDays: null, featuresText: '' };
    this.planErrorMsg = '';
    this.planDrawerVisible = true;
  }

  openEditPlan(plan: SubscriptionPlan): void {
    this.planDrawerMode = 'edit';
    this.editingPlan = plan;
    this.planForm = {
      name: plan.name, description: plan.description, monthlyPrice: plan.monthlyPrice,
      gstPercent: plan.gstPercent, trialDays: plan.trialDays, gracePeriodDays: plan.gracePeriodDays,
      featuresText: plan.features.join('\n'),
    };
    this.planErrorMsg = '';
    this.planDrawerVisible = true;
  }

  closePlanDrawer(): void { this.planDrawerVisible = false; }

  savePlan(): void {
    if (!this.planForm.name.trim() || this.planForm.monthlyPrice < 0) {
      this.planErrorMsg = 'Enter a valid plan name and price.';
      return;
    }
    this.planSaving = true;
    this.planErrorMsg = '';
    this.cdr.markForCheck();

    const payload = {
      name: this.planForm.name.trim(), description: this.planForm.description,
      monthlyPrice: this.planForm.monthlyPrice, gstPercent: this.planForm.gstPercent,
      trialDays: this.planForm.trialDays, gracePeriodDays: this.planForm.gracePeriodDays,
      features: this.planForm.featuresText.split('\n').map(f => f.trim()).filter(Boolean),
    };

    const obs = this.planDrawerMode === 'edit' && this.editingPlan
      ? this.plansSvc.update(this.editingPlan._id, payload)
      : this.plansSvc.create(payload);

    obs.pipe(takeUntil(this.destroy$), finalize(() => { this.planSaving = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: () => {
          this.showToastMsg(this.planDrawerMode === 'edit' ? 'Plan updated.' : 'Plan created.');
          this.planDrawerVisible = false; this.loadPlans();
        },
        error: (err) => { this.planErrorMsg = err.error?.message || 'Failed to save plan.'; },
      });
  }

  togglePlanStatus(plan: SubscriptionPlan): void {
    this.plansSvc.setStatus(plan._id, !plan.isActive).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => { this.showToastMsg(`Plan ${plan.isActive ? 'deactivated' : 'activated'}.`); this.loadPlans(); },
      error: (err) => this.showToastMsg(err.error?.message || 'Failed to update plan.', 'error'),
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB 3 — PAYMENT FOLLOW-UPS
  // ══════════════════════════════════════════════════════════════════════════

  followUpBuckets: FollowUpBuckets | null = null;
  followUpsLoading = false;

  readonly followUpBucketMeta: { key: keyof FollowUpBuckets; label: string; cls: string }[] = [
    { key: 'upcoming', label: 'Upcoming', cls: 'fu-col--info' },
    { key: 'dueToday', label: 'Due Today', cls: 'fu-col--warn' },
    { key: 'gracePeriod', label: 'Grace Period', cls: 'fu-col--warn' },
    { key: 'finalWarning', label: 'Final Warning', cls: 'fu-col--danger' },
    { key: 'suspended', label: 'Suspended', cls: 'fu-col--danger' },
    { key: 'paid', label: 'Paid', cls: 'fu-col--success' },
  ];

  loadFollowUpBuckets(): void {
    this.followUpsLoading = true;
    this.cdr.markForCheck();
    this.svc.getFollowUpBuckets().pipe(takeUntil(this.destroy$), finalize(() => { this.followUpsLoading = false; this.cdr.markForCheck(); }))
      .subscribe({ next: (res) => { this.followUpBuckets = res.data; }, error: () => {} });
  }

  openTenantFromFollowUp(tenantId: string): void {
    this.activeTab = 'overview';
    const row = this.rows.find(r => r.tenantId === tenantId);
    if (row) { this.openDetail(row); return; }
    // Not in the currently loaded page — fetch detail directly.
    this.drawerVisible = true;
    this.drawerSection = 'statement';
    setTimeout(() => this.drawerOpen = true, 10);
    this.loadDetail(tenantId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB 4 — BILLING CALENDAR
  // ══════════════════════════════════════════════════════════════════════════

  calendarMonth = new Date().getMonth() + 1;
  calendarYear = new Date().getFullYear();
  calendar: BillingCalendar | null = null;
  calendarLoading = false;
  selectedCalendarDay: string | null = null;

  calendarSearch = '';
  calendarPlanId = '';
  calendarStatus = '';
  private calendarFilterTrigger$ = new Subject<void>();

  readonly calendarStatusOptions = [
    { value: '', label: 'All' }, { value: 'pending', label: 'Pending' }, { value: 'overdue', label: 'Overdue' },
    { value: 'partially_paid', label: 'Partially Paid' }, { value: 'paid', label: 'Paid' },
  ];

  loadCalendar(): void {
    this.calendarLoading = true;
    this.selectedCalendarDay = null;
    this.cdr.markForCheck();
    this.svc.getCalendar({
      month: this.calendarMonth, year: this.calendarYear,
      search: this.calendarSearch.trim(), planId: this.calendarPlanId, status: this.calendarStatus,
    }).pipe(takeUntil(this.destroy$), finalize(() => { this.calendarLoading = false; this.cdr.markForCheck(); }))
      .subscribe({ next: (res) => { this.calendar = res.data; }, error: () => {} });
  }

  applyCalendarFiltersDebounced(): void { this.calendarFilterTrigger$.next(); }

  resetCalendarFilters(): void {
    this.calendarSearch = ''; this.calendarPlanId = ''; this.calendarStatus = '';
    this.loadCalendar();
  }

  calendarPrevMonth(): void {
    this.calendarMonth--;
    if (this.calendarMonth < 1) { this.calendarMonth = 12; this.calendarYear--; }
    this.loadCalendar();
  }
  calendarNextMonth(): void {
    this.calendarMonth++;
    if (this.calendarMonth > 12) { this.calendarMonth = 1; this.calendarYear++; }
    this.loadCalendar();
  }

  get calendarDays(): { date: number; iso: string; events: CalendarEvent[] }[] {
    if (!this.calendar) return [];
    const daysInMonth = new Date(this.calendarYear, this.calendarMonth, 0).getDate();
    const byDay = new Map<string, CalendarEvent[]>();
    for (const ev of this.calendar.events) {
      const key = new Date(ev.date).toISOString().slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(ev);
    }
    const out: { date: number; iso: string; events: CalendarEvent[] }[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${this.calendarYear}-${String(this.calendarMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      out.push({ date: d, iso, events: byDay.get(iso) ?? [] });
    }
    return out;
  }

  get calendarLeadingBlanks(): number[] {
    const first = new Date(this.calendarYear, this.calendarMonth - 1, 1).getDay();
    return Array(first).fill(0);
  }

  selectCalendarDay(iso: string): void {
    this.selectedCalendarDay = this.selectedCalendarDay === iso ? null : iso;
    this.cdr.markForCheck();
  }

  get selectedDayEvents(): CalendarEvent[] {
    if (!this.selectedCalendarDay || !this.calendar) return [];
    return this.calendar.events.filter(e => new Date(e.date).toISOString().slice(0, 10) === this.selectedCalendarDay);
  }

  calendarEventDotClass(type: string): string {
    return 'cal-dot--' + (type === 'due' ? 'due' : type === 'overdue' ? 'overdue' : type === 'suspension' ? 'suspend' : 'followup');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB 5 — ANALYTICS
  // ══════════════════════════════════════════════════════════════════════════

  analytics: BillingAnalytics | null = null;
  analyticsLoading = false;
  hoveredTrendIndex = -1;

  loadAnalytics(): void {
    this.analyticsLoading = true;
    this.cdr.markForCheck();
    this.svc.getAnalytics().pipe(takeUntil(this.destroy$), finalize(() => { this.analyticsLoading = false; this.cdr.markForCheck(); }))
      .subscribe({ next: (res) => { this.analytics = res.data; }, error: () => {} });
  }

  get revenueByPlanEntries(): { plan: string; amount: number; pct: number }[] {
    if (!this.analytics) return [];
    const entries = Object.entries(this.analytics.revenue.revenueByPlan);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return entries.map(([plan, amount]) => ({ plan, amount, pct: Math.round((amount / max) * 100) }))
      .sort((a, b) => b.amount - a.amount);
  }

  get revenueByTenantEntries(): { tenant: string; amount: number; pct: number }[] {
    if (!this.analytics) return [];
    const entries = Object.entries(this.analytics.revenue.revenueByTenant);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return entries.map(([tenant, amount]) => ({ tenant, amount, pct: Math.round((amount / max) * 100) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 15);
  }

  // Hand-rolled inline-SVG trend chart — same approach as the Payments/
  // Statements page (getTrendLinePath/getTrendAreaPath/getTrendPoints), just
  // plotted over the 12 monthly revenueTrend points instead of daily ones.
  get trendPoints(): { x: number; y: number }[] {
    const trend = this.analytics?.revenue.revenueTrend;
    if (!trend?.length) return [];
    const W = 700, H = 180, PAD_TOP = 20, PAD_BOTTOM = 10;
    const maxAmt = Math.max(...trend.map(d => d.billed), 1);
    const n = trend.length;
    return trend.map((d, i) => ({
      x: n === 1 ? W / 2 : (i / (n - 1)) * W,
      y: PAD_TOP + (1 - d.collected / maxAmt) * (H - PAD_TOP - PAD_BOTTOM),
    }));
  }

  get trendLinePath(): string {
    const pts = this.trendPoints;
    if (pts.length < 2) return '';
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  }

  get trendAreaPath(): string {
    const pts = this.trendPoints;
    if (pts.length < 2) return '';
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    const first = pts[0];
    return `${line} L${last.x.toFixed(1)},200 L${first.x.toFixed(1)},200 Z`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB 6 — SETTINGS
  // ══════════════════════════════════════════════════════════════════════════

  settings: BillingSettings | null = null;
  settingsLoading = false;
  settingsSaving = false;
  settingsErrorMsg = '';
  showSettingsConfirm = false;
  newBeforeDay: number | null = null;
  newOverdueDay: number | null = null;

  settingsForm = {
    defaultGstPercent: 18, defaultGracePeriodDays: 7,
    reminderDaysBeforeDue: [] as number[], reminderDaysOverdue: [] as number[],
    invoiceNumberPrefix: 'INV', companyLegalName: '', companyGSTIN: '', companyAddress: '', companyLogoUrl: '',
  };

  loadSettings(): void {
    this.settingsLoading = true;
    this.cdr.markForCheck();
    this.settingsSvc.get().pipe(takeUntil(this.destroy$), finalize(() => { this.settingsLoading = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: (res) => {
          this.settings = res.data;
          this.settingsForm = {
            defaultGstPercent: res.data.defaultGstPercent, defaultGracePeriodDays: res.data.defaultGracePeriodDays,
            reminderDaysBeforeDue: [...res.data.reminderDaysBeforeDue].sort((a, b) => b - a),
            reminderDaysOverdue: [...res.data.reminderDaysOverdue].sort((a, b) => a - b),
            invoiceNumberPrefix: res.data.invoiceNumberPrefix, companyLegalName: res.data.companyLegalName,
            companyGSTIN: res.data.companyGSTIN, companyAddress: res.data.companyAddress, companyLogoUrl: res.data.companyLogoUrl,
          };
        },
        error: () => {},
      });
  }

  addBeforeDay(): void {
    const d = this.newBeforeDay;
    if (d === null || d < 0 || this.settingsForm.reminderDaysBeforeDue.includes(d)) return;
    this.settingsForm.reminderDaysBeforeDue = [...this.settingsForm.reminderDaysBeforeDue, d].sort((a, b) => b - a);
    this.newBeforeDay = null;
  }
  removeBeforeDay(d: number): void {
    this.settingsForm.reminderDaysBeforeDue = this.settingsForm.reminderDaysBeforeDue.filter(x => x !== d);
  }
  addOverdueDay(): void {
    const d = this.newOverdueDay;
    if (d === null || d < 0 || this.settingsForm.reminderDaysOverdue.includes(d)) return;
    this.settingsForm.reminderDaysOverdue = [...this.settingsForm.reminderDaysOverdue, d].sort((a, b) => a - b);
    this.newOverdueDay = null;
  }
  removeOverdueDay(d: number): void {
    this.settingsForm.reminderDaysOverdue = this.settingsForm.reminderDaysOverdue.filter(x => x !== d);
  }

  openSettingsConfirm(): void { this.showSettingsConfirm = true; }
  closeSettingsConfirm(): void { this.showSettingsConfirm = false; }

  saveSettings(): void {
    this.settingsSaving = true;
    this.settingsErrorMsg = '';
    this.cdr.markForCheck();
    this.settingsSvc.update(this.settingsForm)
      .pipe(takeUntil(this.destroy$), finalize(() => { this.settingsSaving = false; this.showSettingsConfirm = false; this.cdr.markForCheck(); }))
      .subscribe({
        next: (res) => { this.settings = res.data; this.showToastMsg('Billing settings updated.'); },
        error: (err) => {
          this.settingsErrorMsg = err.error?.message || 'Failed to save settings.';
          this.showToastMsg(this.settingsErrorMsg, 'error');
        },
      });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SHARED DISPLAY HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  fmtINR(n: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n ?? 0);
  }

  fmtDate(s: string | null | undefined): string {
    if (!s) return '—';
    return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  periodLabel(month: number, year: number): string {
    return `${this.monthOptions[month - 1]?.label ?? month} ${year}`;
  }

  stateLabel(state: string): string {
    const map: Record<string, string> = {
      unenrolled: 'Not Enrolled', trial: 'Trial', active: 'Active', grace_period: 'Grace Period',
      suspended: 'Suspended', cancelled: 'Cancelled', overdue: 'Overdue',
    };
    return map[state] ?? state;
  }

  invoiceStatusLabel(status: string): string {
    const map: Record<string, string> = {
      draft: 'Draft', generated: 'Generated', pending: 'Pending', partially_paid: 'Partially Paid',
      paid: 'Paid', overdue: 'Overdue', failed: 'Failed', cancelled: 'Cancelled', refunded: 'Refunded',
    };
    return map[status] ?? status;
  }

  followUpStatusLabel(status: string): string {
    return this.followUpStatusOptions.find(o => o.value === status)?.label ?? status;
  }

  auditActionLabel(action: string): string {
    const map: Record<string, string> = {
      enrolled: 'Enrolled in Billing', invoice_generated: 'Invoice Generated', invoice_overdue: 'Invoice Overdue',
      payment_recorded: 'Payment Recorded', payment_failed: 'Payment Failed', refund_issued: 'Refund Issued',
      suspended: 'Suspended', reactivated: 'Reactivated', invoice_waived: 'Invoice Waived',
      plan_changed: 'Plan Changed', subscription_cancelled: 'Subscription Cancelled', follow_up_added: 'Follow-up Added',
      trial_ended: 'Trial Ended',
    };
    return map[action] ?? action;
  }

  initials(name: string): string {
    return (name || '?').split(' ').filter(Boolean).map(p => p[0]).join('').slice(0, 2).toUpperCase();
  }

  private emptySummary(): BillingSummary {
    return {
      totalTenants: 0, enrolled: 0, trial: 0, active: 0, gracePeriod: 0, overdue: 0,
      suspended: 0, cancelled: 0, unenrolled: 0, mrr: 0, totalOutstanding: 0, paidThisMonth: 0,
    };
  }

  trackByRow(_: number, r: BillingRow): string { return r.tenantId; }
  trackByInvoice(_: number, i: InvoiceDetail): string { return i._id; }
  trackByPlan(_: number, p: SubscriptionPlan): string { return p._id; }
  trackByIdx(i: number): number { return i; }
}

function round2(n: number): number { return Math.round((n || 0) * 100) / 100; }
