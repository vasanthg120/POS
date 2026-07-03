// tracking.component.ts — Fixed auto-reload + enterprise redesign
import {
  Component, OnInit, OnDestroy,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, takeUntil, forkJoin } from 'rxjs';

import {
  TrackingService, TrackingRecord, TrackingStats,
  EditForm, ManualPaymentForm, TimelineEntry, PayStatus, QuotStage,
} from '../services/tracking';

const AVATAR_PALETTE = [
  '#1d4ed8', '#0891b2', '#059669', '#7c3aed',
  '#d97706', '#dc2626', '#0284c7', '#9333ea',
  '#0f766e', '#b45309', '#3b82f6', '#ef4444',
];

@Component({
  selector: 'app-tracking',
  standalone: true,
  imports: [CommonModule, FormsModule, DecimalPipe],
  templateUrl: './tracking.html',
  styleUrls: ['./tracking.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Tracking implements OnInit, OnDestroy {
  Math = Math;

  // ── Data ──────────────────────────────────────────────────────────────────
  allRecords: TrackingRecord[] = [];
  filteredRecords: TrackingRecord[] = [];
  pagedRecords: TrackingRecord[] = [];

  // ── UI state ──────────────────────────────────────────────────────────────
  isLoading = true;
  // FIX: guard flag prevents overlapping loads triggered by interval
  private isLoadingInProgress = false;
  isSyncing = false;
  lastUpdated = '';
  skeletonRows = Array(6);

  // ── Filters ───────────────────────────────────────────────────────────────
  searchQuery = '';
  activePaymentStatus = '';
  activeQuotationStatus = '';
  activePaymentMethod = '';
  activeRange = '';
  dateFrom = '';
  dateTo = '';
  minAmount: number | null = null;
  maxAmount: number | null = null;
  filtersCollapsed = true;

  // ── Sort ──────────────────────────────────────────────────────────────────
  sortField = 'createdAt';
  sortDir: 'asc' | 'desc' = 'desc';

  // ── Pagination ────────────────────────────────────────────────────────────
  currentPage = 1;
  pageSize = 20;
  totalPages = 1;
  visiblePages: number[] = [];

  // ── Stats ─────────────────────────────────────────────────────────────────
  stats: TrackingStats = {
    total: 0, totalRevenue: 0, pendingRevenue: 0, overdueRevenue: 0,
    conversionRate: 0, paidCount: 0, pendingCount: 0,
    failedCount: 0, partialCount: 0, overdueCount: 0, avgDealSize: 0,
  };
  payStatusCounts = new Map<string, number>();
  methodCounts = new Map<string, number>();
  quotStatusCounts = new Map<string, number>();

  // ── Drawer ────────────────────────────────────────────────────────────────
  drawerOpen = false;
  drawerTab: 'details' | 'timeline' | 'payments' = 'details';
  selectedRecord: TrackingRecord | null = null;
  editForm: EditForm = this.blankForm();
  isSaving = false;
  isFetchingRzp = false;
  isAddingNote = false;
  saveOk = '';
  saveErr = '';
  newTimelineNote = '';
  rzpDetails: any = null;

  // ── Manual payment modal ──────────────────────────────────────────────────
  manualPayModal = false;
  isSubmittingManual = false;
  manualPayOk = '';
  manualPayErr = '';
  manualPayPct: number | null = null;
  manualPayForm: ManualPaymentForm = this.blankManualForm();

  // ── Toast ─────────────────────────────────────────────────────────────────
  showToast = false;
  toastMsg = '';
  toastType: 'success' | 'error' = 'success';
  private toastTimer?: ReturnType<typeof setTimeout>;

  // ── Config ────────────────────────────────────────────────────────────────
  readonly paymentStatusOptions = [
    { value: '', label: 'All', color: '' },
    { value: 'paid', label: 'Paid', color: 'green' },
    { value: 'pending', label: 'Pending', color: 'amber' },
    { value: 'failed', label: 'Failed', color: 'red' },
    { value: 'partially_paid', label: 'Partial', color: 'violet' },
    { value: 'refunded', label: 'Refunded', color: 'blue' },
  ];

  readonly quotationStatusOptions = [
    { value: '', label: 'All' },
    { value: 'Created', label: 'Created' },
    { value: 'In Progress', label: 'In Progress' },
    { value: 'Processing', label: 'Processing' },
    { value: 'Awaiting Payment', label: 'Awaiting Payment' },
    { value: 'Payment Completed', label: 'Paid' },
    { value: 'Delivered', label: 'Delivered' },
    { value: 'Closed', label: 'Closed' },
    { value: 'Cancelled', label: 'Cancelled' },
  ];

  readonly paymentMethodOptions = [
    { value: '', label: 'All Methods' },
    { value: 'UPI', label: 'UPI' },
    { value: 'Card', label: 'Card' },
    { value: 'Net Banking', label: 'Net Banking' },
    { value: 'Cash', label: 'Cash' },
    { value: 'Bank Transfer', label: 'Bank Transfer' },
    { value: 'NEFT', label: 'NEFT' },
    { value: 'RTGS', label: 'RTGS' },
    { value: 'IMPS', label: 'IMPS' },
    { value: 'Cheque', label: 'Cheque' },
    { value: 'Wallet', label: 'Wallet' },
    { value: 'EMI', label: 'EMI' },
  ];

  readonly manualMethodOptions = [
    'Bank Transfer', 'NEFT', 'RTGS', 'IMPS', 'Cash', 'Cheque', 'UPI (Manual)', 'Other',
  ];

  readonly rangeOptions = [
    { value: 'today', label: 'Today' },
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: '90d', label: '90 days' },
    { value: 'thisMonth', label: 'This month' },
    { value: 'lastMonth', label: 'Last month' },
  ];

  readonly paymentStatusList = [
    { key: 'paid', label: 'Paid' },
    { key: 'pending', label: 'Pending' },
    { key: 'failed', label: 'Failed' },
    { key: 'partially_paid', label: 'Partial' },
    { key: 'refunded', label: 'Refunded' },
  ];

  readonly methodList = ['UPI', 'Card', 'Net Banking', 'Bank Transfer', 'NEFT', 'RTGS', 'Cash', 'Cheque', 'Wallet', 'EMI'];

  readonly pipelineStages = [
    { value: 'Created' as QuotStage, label: 'Created', cls: 'pipe-blue' },
    { value: 'In Progress' as QuotStage, label: 'In Prog.', cls: 'pipe-indigo' },
    { value: 'Processing' as QuotStage, label: 'Processing', cls: 'pipe-cyan' },
    { value: 'Awaiting Payment' as QuotStage, label: 'Await Pay', cls: 'pipe-amber' },
    { value: 'Payment Completed' as QuotStage, label: 'Pay Done', cls: 'pipe-emerald' },
    { value: 'Delivered' as QuotStage, label: 'Delivered', cls: 'pipe-teal' },
    { value: 'Closed' as QuotStage, label: 'Closed', cls: 'pipe-gray' },
    { value: 'Cancelled' as QuotStage, label: 'Cancelled', cls: 'pipe-rose' },
  ];

  readonly stageWorkflow = [
    { value: 'Created' as QuotStage, label: 'Created', cls: 'stage-blue' },
    { value: 'In Progress' as QuotStage, label: 'In Progress', cls: 'stage-indigo' },
    { value: 'Processing' as QuotStage, label: 'Processing', cls: 'stage-cyan' },
    { value: 'Awaiting Payment' as QuotStage, label: 'Awaiting Payment', cls: 'stage-amber' },
    { value: 'Payment Completed' as QuotStage, label: 'Payment Completed', cls: 'stage-emerald' },
    { value: 'Delivered' as QuotStage, label: 'Delivered', cls: 'stage-teal' },
    { value: 'Closed' as QuotStage, label: 'Closed', cls: 'stage-gray' },
    { value: 'Cancelled' as QuotStage, label: 'Cancelled', cls: 'stage-rose' },
  ];

  private destroy$ = new Subject<void>();
  private filterTrigger$ = new Subject<void>();
  // FIX: store interval ref properly typed
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private svc: TrackingService,
    private cdr: ChangeDetectorRef,
  ) { }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.filterTrigger$
      .pipe(debounceTime(180), takeUntil(this.destroy$))
      .subscribe(() => this.runFilter());

    this.loadAll();
    this.updateTimestamp();

    // FIX: Only auto-refresh when tab is visible, and guard against overlapping loads
    this.refreshTimer = setInterval(() => {
      // Skip if tab is hidden (prevents background hammering)
      if (document.hidden) return;
      // Skip if a load is already in progress
      if (this.isLoadingInProgress) return;
      this.loadAll(false); // silent refresh — no loading spinner
      this.updateTimestamp();
    }, 60_000);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  // ─── Data ──────────────────────────────────────────────────────────────────

  /**
   * FIX: Added `showSpinner` param. Auto-refresh uses `false` so the table
   * doesn't flash on every 60s tick. Manual refresh uses `true` (default).
   */
  loadAll(showSpinner = true): void {
    // FIX: Guard — if already loading, don't start another request
    if (this.isLoadingInProgress) return;

    this.isLoadingInProgress = true;
    if (showSpinner) {
      this.isLoading = true;
      this.cdr.markForCheck();
    }

    forkJoin({
      records: this.svc.loadAll(),
      stats: this.svc.loadStats(),
    })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: ({ records, stats }) => {
          this.allRecords = records;
          this.stats = stats;
          this.isLoadingInProgress = false;
          this.rebuildAnalytics();
          this.filterTrigger$.next(); // triggers runFilter → no more loadAll() call inside
          this.isLoading = false;
          this.cdr.markForCheck();
        },
        error: () => {
          this.isLoadingInProgress = false;
          this.isLoading = false;
          this.cdr.markForCheck();
        },
      });
  }

  // ─── On-demand Razorpay sync ───────────────────────────────────────────────

  onSyncRazorpay(): void {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.cdr.markForCheck();

    this.svc.syncRazorpay()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: ({ synced }) => {
          this.isSyncing = false;
          this.showToastMsg(
            synced > 0
              ? `${synced} payment${synced > 1 ? 's' : ''} synced from Razorpay`
              : 'Already up to date',
            'success',
          );
          // FIX: only reload if there were actual new payments
          if (synced > 0) this.loadAll(true);
          else this.cdr.markForCheck();
        },
        error: () => {
          this.isSyncing = false;
          this.showToastMsg('Razorpay sync failed', 'error');
          this.cdr.markForCheck();
        },
      });
  }

  // ─── Analytics ─────────────────────────────────────────────────────────────

  rebuildAnalytics(): void {
    this.payStatusCounts.clear();
    this.methodCounts.clear();
    this.quotStatusCounts.clear();
    for (const r of this.allRecords) {
      this.payStatusCounts.set(r.paymentStatus, (this.payStatusCounts.get(r.paymentStatus) ?? 0) + 1);
      if (r.paymentMethod) {
        this.methodCounts.set(r.paymentMethod, (this.methodCounts.get(r.paymentMethod) ?? 0) + 1);
      }
      this.quotStatusCounts.set(r.quotationStatus, (this.quotStatusCounts.get(r.quotationStatus) ?? 0) + 1);
    }
  }

  getPayCount(key: string): number { return this.payStatusCounts.get(key) ?? 0; }
  getMethodCount(m: string): number { return this.methodCounts.get(m) ?? 0; }
  getQuotCount(s: string): number { return this.quotStatusCounts.get(s) ?? 0; }

  getPayPercent(key: string): number {
    const max = Math.max(...this.paymentStatusList.map(s => this.getPayCount(s.key)), 1);
    return Math.round((this.getPayCount(key) / max) * 100);
  }

  getMethodPercent(m: string): number {
    const max = Math.max(...this.methodList.map(x => this.getMethodCount(x)), 1);
    return Math.round((this.getMethodCount(m) / max) * 100);
  }

  getPipelinePercent(s: string): number {
    const max = Math.max(...this.pipelineStages.map(x => this.getQuotCount(x.value)), 1);
    return Math.round((this.getQuotCount(s) / max) * 100);
  }

  // ─── Filters ───────────────────────────────────────────────────────────────

  applyFilters(): void { this.filterTrigger$.next(); }

  private runFilter(): void {
    const q = this.searchQuery.toLowerCase().trim();

    let result = this.allRecords.filter(r => {
      const matchSearch = !q
        || r.customerName.toLowerCase().includes(q)
        || r.customerEmail.toLowerCase().includes(q)
        || r.ticketNumber.toLowerCase().includes(q)
        || (r.quoteName || '').toLowerCase().includes(q)
        || (r.bankTransferRef || '').toLowerCase().includes(q);

      const matchPay = !this.activePaymentStatus || r.paymentStatus === this.activePaymentStatus;
      const matchQuot = !this.activeQuotationStatus || r.quotationStatus === this.activeQuotationStatus;
      const matchMethod = !this.activePaymentMethod || r.paymentMethod === this.activePaymentMethod;

      let matchDate = true;
      if (this.dateFrom && r.createdAt) matchDate = matchDate && r.createdAt.slice(0, 10) >= this.dateFrom;
      if (this.dateTo && r.createdAt) matchDate = matchDate && r.createdAt.slice(0, 10) <= this.dateTo;

      let matchAmt = true;
      if (this.minAmount != null) matchAmt = matchAmt && r.amount >= this.minAmount;
      if (this.maxAmount != null) matchAmt = matchAmt && r.amount <= this.maxAmount;

      return matchSearch && matchPay && matchQuot && matchMethod && matchDate && matchAmt;
    });

    const asc = this.sortDir === 'asc';
    const sf = this.sortField;
    result.sort((a, b) => {
      const av = (a as any)[sf] ?? '';
      const bv = (b as any)[sf] ?? '';
      if (typeof av === 'number') return asc ? av - bv : bv - av;
      return asc
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });

    this.filteredRecords = result;
    this.totalPages = Math.max(1, Math.ceil(result.length / this.pageSize));
    this.currentPage = 1;
    this.visiblePages = this.buildVisiblePages();
    this.updatePage();
    this.cdr.markForCheck();
  }

  private updatePage(): void {
    const start = (this.currentPage - 1) * this.pageSize;
    this.pagedRecords = this.filteredRecords.slice(start, start + this.pageSize);
  }

  setPayFilter(v: string): void { this.activePaymentStatus = v; this.applyFilters(); }
  setQuotFilter(v: string): void { this.activeQuotationStatus = v; this.applyFilters(); }
  setMethodFilter(v: string): void { this.activePaymentMethod = v; this.applyFilters(); }
  toggleFilters(): void { this.filtersCollapsed = !this.filtersCollapsed; }

  resetFilters(): void {
    this.searchQuery = '';
    this.activePaymentStatus = '';
    this.activeQuotationStatus = '';
    this.activePaymentMethod = '';
    this.activeRange = '';
    this.dateFrom = '';
    this.dateTo = '';
    this.minAmount = null;
    this.maxAmount = null;
    this.filterTrigger$.next();
  }

  applyRange(range: string): void {
    this.activeRange = range;
    const now = new Date();
    const fmt = (d: Date) => d.toISOString().split('T')[0];
    this.dateTo = fmt(now);
    switch (range) {
      case 'today': this.dateFrom = fmt(now); break;
      case '7d': { const d = new Date(now); d.setDate(d.getDate() - 7); this.dateFrom = fmt(d); break; }
      case '30d': { const d = new Date(now); d.setDate(d.getDate() - 30); this.dateFrom = fmt(d); break; }
      case '90d': { const d = new Date(now); d.setDate(d.getDate() - 90); this.dateFrom = fmt(d); break; }
      case 'thisMonth': { const d = new Date(now.getFullYear(), now.getMonth(), 1); this.dateFrom = fmt(d); break; }
      case 'lastMonth': {
        const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const e = new Date(now.getFullYear(), now.getMonth(), 0);
        this.dateFrom = fmt(s); this.dateTo = fmt(e); break;
      }
    }
    this.filterTrigger$.next();
  }

  get activeFilterCount(): number {
    return [
      this.searchQuery, this.activePaymentStatus, this.activeQuotationStatus,
      this.activePaymentMethod, this.dateFrom, this.dateTo,
      this.minAmount != null ? '1' : '', this.maxAmount != null ? '1' : '',
    ].filter(Boolean).length;
  }

  // ─── Sort ──────────────────────────────────────────────────────────────────

  sortBy(field: string): void {
    this.sortDir = this.sortField === field ? (this.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    this.sortField = field;
    this.filterTrigger$.next();
  }

  sortIcon(field: string): string {
    if (this.sortField !== field) return '⇅';
    return this.sortDir === 'asc' ? '↑' : '↓';
  }

  // ─── Pagination ────────────────────────────────────────────────────────────

  goToPage(page: number): void {
    if (page < 1 || page > this.totalPages || page === this.currentPage) return;
    this.currentPage = page;
    this.visiblePages = this.buildVisiblePages();
    this.updatePage();
    this.cdr.markForCheck();
  }

  onPageSizeChange(): void {
    this.totalPages = Math.max(1, Math.ceil(this.filteredRecords.length / this.pageSize));
    this.currentPage = 1;
    this.visiblePages = this.buildVisiblePages();
    this.updatePage();
    this.cdr.markForCheck();
  }

  private buildVisiblePages(): number[] {
    const pages: number[] = [];
    const start = Math.max(1, this.currentPage - 2);
    const end = Math.min(this.totalPages, this.currentPage + 2);
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  }

  // ─── Drawer ────────────────────────────────────────────────────────────────

  openDrawer(r: TrackingRecord): void {
    this.selectedRecord = r;
    this.drawerOpen = true;
    this.drawerTab = 'details';
    this.saveOk = '';
    this.saveErr = '';
    this.newTimelineNote = '';
    this.rzpDetails = null;
    this.manualPayOk = '';
    this.manualPayErr = '';
    this.editForm = {
      quotationStatus: r.quotationStatus,
      paymentStatus: r.paymentStatus,
      paymentMethod: r.paymentMethod,
      paidAmount: r.paidAmount || r.amount,
      bankTransferRef: r.bankTransferRef || '',
      bankTransferNotes: r.bankTransferNotes || '',
      notes: r.notes || '',
    };
    this.manualPayForm = this.blankManualForm();
    this.cdr.markForCheck();
    if (r._paymentId) this.syncRazorpayDetail(r._paymentId);
  }

  closeDrawer(): void {
    this.drawerOpen = false;
    this.selectedRecord = null;
    this.rzpDetails = null;
    this.cdr.markForCheck();
  }

  // ─── Razorpay detail sync ──────────────────────────────────────────────────

  syncRazorpayDetail(paymentId: string): void {
    this.isFetchingRzp = true;
    this.cdr.markForCheck();

    this.svc.getRazorpayPayment(paymentId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: res => {
          if (res?.success && res?.data) {
            this.rzpDetails = res.data;
            if (!this.editForm.paymentMethod && res.data.method) {
              this.editForm.paymentMethod = this.normaliseMethod(res.data.method);
            }
          }
          this.isFetchingRzp = false;
          this.cdr.markForCheck();
        },
        error: () => { this.isFetchingRzp = false; this.cdr.markForCheck(); },
      });
  }

  private normaliseMethod(raw: string): string {
    const map: Record<string, string> = {
      upi: 'UPI', card: 'Card', netbanking: 'Net Banking',
      net_banking: 'Net Banking', cash: 'Cash', wallet: 'Wallet',
      emi: 'EMI', bank_transfer: 'Bank Transfer',
    };
    return map[raw.toLowerCase().replace(/\s+/g, '_')] ?? raw;
  }

  onMethodChange(): void {
    if (!['Bank Transfer', 'NEFT', 'RTGS', 'IMPS', 'Cheque'].includes(this.editForm.paymentMethod)) {
      this.editForm.bankTransferRef = '';
      this.editForm.bankTransferNotes = '';
    }
  }

  onManualAmountChange(): void {
    if (!this.manualPayForm.amount || !this.manualPayMaxAmount) {
      this.manualPayPct = null;
      return;
    }
    // Sync pct from amount
    this.manualPayPct = Math.round(
      (this.manualPayForm.amount / this.manualPayMaxAmount) * 100
    );
  }

  onManualPctChange(): void {
    if (this.manualPayPct == null || this.manualPayPct <= 0) {
      this.manualPayForm.amount = null;
      return;
    }
    const clamped = Math.min(100, Math.max(1, this.manualPayPct));
    this.manualPayPct = clamped;
    // Round to whole rupees
    this.manualPayForm.amount = Math.round(
      (clamped / 100) * this.manualPayMaxAmount
    );
  }

  // ─── Manual Payment Modal ──────────────────────────────────────────────────

  openManualPayModal(): void {
    this.manualPayModal = true;
    this.manualPayOk = '';
    this.manualPayErr = '';
    this.manualPayPct = null;
    this.manualPayForm = this.blankManualForm();
    this.cdr.markForCheck();
  }

  closeManualPayModal(): void {
    this.manualPayModal = false;
    this.cdr.markForCheck();
  }

  get manualPayMaxAmount(): number {
    if (!this.selectedRecord) return 0;
    return this.selectedRecord.amount - (this.selectedRecord.paidAmount ?? 0);
  }

  submitManualPayment(): void {
    if (!this.selectedRecord || this.isSubmittingManual) return;
    if (!this.manualPayForm.method) { this.manualPayErr = 'Select a payment method'; return; }
    if (!this.manualPayForm.amount || this.manualPayForm.amount <= 0) {
      this.manualPayErr = 'Enter a valid amount'; return;
    }
    if (this.manualPayForm.amount > this.manualPayMaxAmount + 0.01) {
      this.manualPayErr = `Amount cannot exceed balance due (${this.fmtINR(this.manualPayMaxAmount)})`; return;
    }

    this.isSubmittingManual = true;
    this.manualPayErr = '';
    this.cdr.markForCheck();

    const id = this.selectedRecord._quoteId || this.selectedRecord.id;

    this.svc.recordManualPayment(id, this.manualPayForm, this.selectedRecord.amount)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: res => {
          if (!res?.success) {
            this.manualPayErr = res?.message || 'Failed to record payment';
            this.isSubmittingManual = false;
            this.cdr.markForCheck();
            return;
          }

          const newPaid = (this.selectedRecord!.paidAmount ?? 0) + Number(this.manualPayForm.amount);
          const newStatus: PayStatus = newPaid >= this.selectedRecord!.amount ? 'paid' : 'partially_paid';

          const entry: TimelineEntry = {
            event: `Manual payment ₹${Number(this.manualPayForm.amount).toLocaleString('en-IN')} via ${this.manualPayForm.method}${this.manualPayForm.referenceNumber ? ' · Ref: ' + this.manualPayForm.referenceNumber : ''}`,
            date: new Date(this.manualPayForm.paymentDate || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
            by: 'Admin · Manual',
            type: 'payment',
          };

          const updated: TrackingRecord = {
            ...this.selectedRecord!,
            paidAmount: newPaid,
            paymentStatus: newStatus,
            paymentMethod: this.manualPayForm.method,
            bankTransferRef: this.manualPayForm.referenceNumber || this.selectedRecord!.bankTransferRef,
            bankTransferNotes: this.manualPayForm.notes || this.selectedRecord!.bankTransferNotes,
            timeline: [...(this.selectedRecord!.timeline ?? []), entry],
          };

          this.allRecords = this.allRecords.map(r => r.id === updated.id ? updated : r);
          this.selectedRecord = updated;
          this.editForm.paymentStatus = newStatus;
          this.editForm.paidAmount = newPaid;
          this.editForm.paymentMethod = this.manualPayForm.method;
          this.rebuildAnalytics();
          this.filterTrigger$.next();

          this.isSubmittingManual = false;
          this.manualPayOk = `✓ ₹${Number(this.manualPayForm.amount).toLocaleString('en-IN')} recorded`;
          this.manualPayForm = this.blankManualForm();
          this.cdr.markForCheck();

          setTimeout(() => {
            this.manualPayModal = false;
            this.manualPayOk = '';
            this.cdr.markForCheck();
          }, 1800);
        },
        error: err => {
          this.manualPayErr = err?.error?.message || 'Network error';
          this.isSubmittingManual = false;
          this.cdr.markForCheck();
        },
      });
  }

  // ─── Save ──────────────────────────────────────────────────────────────────

  saveRecord(): void {
    if (!this.selectedRecord) return;
    this.isSaving = true; this.saveOk = ''; this.saveErr = '';
    this.cdr.markForCheck();

    const id = this.selectedRecord._quoteId || this.selectedRecord.id;

    let paidAmount = this.editForm.paidAmount ?? 0;
    if (this.editForm.paymentStatus === 'paid') paidAmount = this.selectedRecord.amount;
    else if (this.editForm.paymentStatus === 'partially_paid') paidAmount = Math.min(Math.max(0, paidAmount), this.selectedRecord.amount);
    else paidAmount = 0;

    const becomingPaid = this.editForm.paymentStatus === 'paid' && this.selectedRecord.paymentStatus !== 'paid';
    const wasPaid = this.selectedRecord.paymentStatus === 'paid' && this.editForm.paymentStatus !== 'paid';
    const paidAt = becomingPaid
      ? new Date().toISOString()
      : wasPaid ? null : this.selectedRecord.paidAt || null;

    const changes: string[] = [];
    if (this.editForm.quotationStatus !== this.selectedRecord.quotationStatus)
      changes.push(`Stage → ${this.editForm.quotationStatus}`);
    if (this.editForm.paymentStatus !== this.selectedRecord.paymentStatus)
      changes.push(`Payment → ${this.payLabel(this.editForm.paymentStatus)}`);
    if (this.editForm.paymentMethod !== this.selectedRecord.paymentMethod && this.editForm.paymentMethod)
      changes.push(`Method → ${this.editForm.paymentMethod}`);

    const timelineEntry: TimelineEntry | undefined = changes.length ? {
      event: changes.join(' · '),
      date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      by: 'Admin',
      type: this.editForm.paymentStatus === 'paid' ? 'payment' : 'status',
    } : undefined;

    const payload: Record<string, any> = {
      quotationStatus: this.editForm.quotationStatus,
      paymentStatus: this.editForm.paymentStatus,
      paymentMethod: this.editForm.paymentMethod,
      paidAmount, paidAt,
      bankTransferRef: this.editForm.bankTransferRef,
      bankTransferNotes: this.editForm.bankTransferNotes,
      notes: this.editForm.notes,
      customerName: this.selectedRecord.customerName,
      customerEmail: this.selectedRecord.customerEmail,
      amount: this.selectedRecord.amount,
    };
    if (timelineEntry) payload['timelineEntry'] = timelineEntry;

    this.svc.updateRecord(id, payload)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: res => {
          if (!res?.success) {
            this.saveErr = res?.message || 'Save failed';
            this.isSaving = false;
            this.cdr.markForCheck();
            return;
          }

          const updatedTimeline = timelineEntry
            ? [...(this.selectedRecord!.timeline ?? []), timelineEntry]
            : (this.selectedRecord!.timeline ?? []);

          const updated: TrackingRecord = {
            ...this.selectedRecord!,
            ...this.editForm,
            paidAmount,
            paidAt: paidAt ?? this.selectedRecord!.paidAt,
            timeline: updatedTimeline,
          };

          this.allRecords = this.allRecords.map(r => r.id === updated.id ? updated : r);
          this.selectedRecord = updated;
          this.rebuildAnalytics();
          this.filterTrigger$.next();

          this.isSaving = false;
          this.saveOk = '✓ Saved successfully';
          this.cdr.markForCheck();
          setTimeout(() => { this.saveOk = ''; this.cdr.markForCheck(); }, 3000);
        },
        error: err => {
          this.saveErr = err?.error?.message || 'Network error — please retry';
          this.isSaving = false;
          this.cdr.markForCheck();
        },
      });
  }

  // ─── Timeline note ─────────────────────────────────────────────────────────

  addNote(): void {
    if (!this.selectedRecord || !this.newTimelineNote.trim() || this.isAddingNote) return;

    const note = this.newTimelineNote.trim();
    const dateLabel = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const entry: TimelineEntry = { event: note, date: dateLabel, by: 'Admin', type: 'note' };

    this.isAddingNote = true;
    this.newTimelineNote = '';
    this.cdr.markForCheck();

    const id = this.selectedRecord._quoteId || this.selectedRecord.id;

    this.svc.updateRecord(id, { timelineEntry: entry })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          if (this.selectedRecord) {
            this.selectedRecord = {
              ...this.selectedRecord,
              timeline: [...(this.selectedRecord.timeline ?? []), entry],
            };
            this.allRecords = this.allRecords.map(r =>
              r.id === this.selectedRecord!.id ? this.selectedRecord! : r,
            );
          }
          this.isAddingNote = false;
          this.cdr.markForCheck();
        },
        error: () => {
          // Optimistic fallback on error
          if (this.selectedRecord) {
            this.selectedRecord = {
              ...this.selectedRecord,
              timeline: [...(this.selectedRecord.timeline ?? []), entry],
            };
          }
          this.isAddingNote = false;
          this.cdr.markForCheck();
        },
      });
  }

  // ─── CSV export ────────────────────────────────────────────────────────────

  exportCSV(): void {
    const headers = [
      'Ticket #', 'Quote Name', 'Customer', 'Email', 'Phone',
      'Amount (INR)', 'Paid Amount', 'Balance Due', 'Pay Status', 'Method',
      'Quot. Status', 'Created', 'Paid On', 'Expires', 'Bank Ref', 'Notes',
    ];
    const rows = this.filteredRecords.map(r => [
      r.ticketNumber, r.quoteName, r.customerName, r.customerEmail, r.customerPhone,
      r.amount, r.paidAmount, Math.max(0, r.amount - (r.paidAmount ?? 0)),
      r.paymentStatus, r.paymentMethod,
      r.quotationStatus, r.createdAt, r.paidAt, r.expiresAt, r.bankTransferRef, r.notes,
    ]);
    const csv = [headers, ...rows]
      .map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url, download: `tracking-${new Date().toISOString().split('T')[0]}.csv`,
    }).click();
    URL.revokeObjectURL(url);
  }

  // ─── Clipboard ─────────────────────────────────────────────────────────────

  copy(text: string): void {
    if (!text) return;
    navigator.clipboard?.writeText(text).catch(() => { });
    this.showToastMsg('Copied to clipboard', 'success');
  }

  // ─── Toast ─────────────────────────────────────────────────────────────────

  private showToastMsg(msg: string, type: 'success' | 'error'): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastMsg = msg;
    this.toastType = type;
    this.showToast = true;
    this.cdr.markForCheck();
    this.toastTimer = setTimeout(() => {
      this.showToast = false;
      this.cdr.markForCheck();
    }, 2400);
  }

  // ─── Overdue ───────────────────────────────────────────────────────────────

  isOverdue(r: TrackingRecord): boolean {
    if (!r.expiresAt) return false;
    if (['paid', 'partially_paid', 'refunded'].includes(r.paymentStatus)) return false;
    return new Date(r.expiresAt) < new Date();
  }

  daysOverdue(r: TrackingRecord): number {
    if (!r.expiresAt) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(r.expiresAt).getTime()) / 86_400_000));
  }

  // ─── Display helpers ───────────────────────────────────────────────────────

  fmtINR(n: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR',
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n ?? 0);
  }

  fmtDate(s: string): string {
    if (!s) return '—';
    return new Date(s).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  fmtDateShort(s: string): string {
    if (!s) return '—';
    return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  fmtTime(s: string): string {
    if (!s) return '';
    return new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  avatarColor(name: string): string {
    return AVATAR_PALETTE[(name?.charCodeAt(0) ?? 0) % AVATAR_PALETTE.length];
  }

  initials(name: string): string {
    return (name || '?').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
  }

  payLabel(status: string): string {
    const map: Record<string, string> = {
      paid: 'Paid', pending: 'Pending', failed: 'Failed',
      partially_paid: 'Partial', refunded: 'Refunded',
    };
    return map[status] ?? status;
  }

  formatStatusClass(status: string): string {
    return (status || '').toLowerCase().replace(/\s+/g, '-');
  }

  rzpMethodLabel(method: string): string {
    const map: Record<string, string> = {
      upi: 'UPI', card: 'Card', netbanking: 'Net Banking',
      wallet: 'Wallet', emi: 'EMI', bank_transfer: 'Bank Transfer',
    };
    return map[(method || '').toLowerCase()] ?? method;
  }

  updateTimestamp(): void {
    this.lastUpdated = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    this.cdr.markForCheck();
  }

  onRefresh(): void {
    this.loadAll(true);
    this.updateTimestamp();
  }

  // ─── Computed ──────────────────────────────────────────────────────────────

  get isManualMethod(): boolean {
    return ['Bank Transfer', 'NEFT', 'RTGS', 'IMPS', 'Cheque', 'Cash'].includes(this.editForm.paymentMethod);
  }

  get balanceDue(): number {
    if (!this.selectedRecord) return 0;
    if (this.editForm.paymentStatus === 'paid') return 0;
    if (this.editForm.paymentStatus === 'partially_paid')
      return this.selectedRecord.amount - (this.editForm.paidAmount ?? 0);
    return this.selectedRecord.amount;
  }

  get paidPercent(): number {
    if (!this.selectedRecord || this.selectedRecord.amount === 0) return 0;
    return Math.min(100, Math.round(((this.selectedRecord.paidAmount || 0) / this.selectedRecord.amount) * 100));
  }

  private blankForm(): EditForm {
    return {
      quotationStatus: 'Created',
      paymentStatus: 'pending',
      paymentMethod: '',
      paidAmount: 0,
      bankTransferRef: '',
      bankTransferNotes: '',
      notes: '',
    };
  }

  private blankManualForm(): ManualPaymentForm {
    return {
      method: '',
      amount: null,
      referenceNumber: '',
      paymentDate: new Date().toISOString().split('T')[0],
      notes: '',
    };
  }

  // ─── trackBy helpers ───────────────────────────────────────────────────────
  trackById(_: number, r: TrackingRecord): string { return r.id; }
  trackByKey(_: number, item: { key: string }): string { return item.key; }
  trackByVal(_: number, item: { value: string }): string { return item.value; }
  trackByIdx(i: number): number { return i; }
}
