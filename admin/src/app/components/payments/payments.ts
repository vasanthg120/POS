// statements.component.ts
import {
  Component, OnInit, OnDestroy, signal, computed, ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule, DatePipe, TitleCasePipe } from '@angular/common';
import { FormsModule }    from '@angular/forms';
import { RouterModule }   from '@angular/router';
import { Statements, Payment, PaymentSummary } from '../services/statements';
import { Auth }           from '../services/auth';

export interface QuickRange {
  key: string;
  label: string;
}

@Component({
  selector        : 'app-payments',
  standalone      : true,
  imports         : [CommonModule, FormsModule, RouterModule, DatePipe, TitleCasePipe],
  templateUrl     : './payments.html',
  styleUrls       : ['./payments.css'],
  changeDetection : ChangeDetectionStrategy.OnPush,
})
export class Payments implements OnInit, OnDestroy {

  // ── Signals ──────────────────────────────────────────────────────────────
  summary         = signal<PaymentSummary | null>(null);
  payments        = signal<Payment[]>([]);
  loading         = signal(false);
  paymentsLoading = signal(false);
  loadingMore     = signal(false);
  error           = signal('');
  selectedPayment = signal<Payment | null>(null);
  hoveredPoint    = signal(-1);

  // ── Filter state ─────────────────────────────────────────────────────────
  filterStatus  = '';
  filterMethod  = '';
  searchQuery   = '';
  dateFrom      = '';
  dateTo        = '';
  activeRange   = 'all';
  showCustomDate = false;

  // ── Sort state ────────────────────────────────────────────────────────────
  sortCol = 'createdAt';
  sortDir: 'asc' | 'desc' = 'desc';

  // ── Pagination ────────────────────────────────────────────────────────────
  currentPage = 1;
  pageSize    = 25;
  totalCount  = 0;

  // ── Selection ─────────────────────────────────────────────────────────────
  selectedIds = new Set<string>();

  // ── Misc ──────────────────────────────────────────────────────────────────
  today        = new Date();
  todayISO     = new Date().toISOString().split('T')[0];

  private skipCount   = 0;
  private searchTimer: any;

  readonly quickRanges: QuickRange[] = [
    { key: 'all',       label: 'All time'    },
    { key: 'today',     label: 'Today'       },
    { key: 'yesterday', label: 'Yesterday'   },
    { key: 'week',      label: 'Last 7 days' },
    { key: 'month',     label: 'Last 30 days'},
    { key: 'thismonth', label: 'This month'  },
    { key: 'lastmonth', label: 'Last month'  },
  ];

  private readonly METHOD_LABELS: Record<string, string> = {
    card       : 'Card',
    upi        : 'UPI',
    netbanking : 'Net Banking',
    wallet     : 'Wallet',
    emi        : 'EMI',
    other      : 'Other',
  };

  constructor(
    private svc : Statements,
    public  auth: Auth,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  ngOnInit(): void {
    if (this.auth.currentTenant()?.razorpay?.isConfigured) {
      this.loadAll();
    }
  }

  ngOnDestroy(): void {
    clearTimeout(this.searchTimer);
  }

  // ── Computed ──────────────────────────────────────────────────────────────
  get totalPages(): number {
    return Math.max(1, Math.ceil(this.filteredSorted().length / this.pageSize));
  }

  get activeFilterCount(): number {
    let count = 0;
    if (this.filterStatus)   count++;
    if (this.filterMethod)   count++;
    if (this.activeRange !== 'all') count++;
    return count;
  }

  get customDateLabel(): string {
    if (this.dateFrom && this.dateTo) {
      return `${this.dateFrom} → ${this.dateTo}`;
    }
    if (this.dateFrom) return `From ${this.dateFrom}`;
    if (this.dateTo)   return `Until ${this.dateTo}`;
    return 'Custom range';
  }

  // ── Filtering + sorting pipeline ─────────────────────────────────────────
  filteredSorted(): Payment[] {
    let list = this.payments();

    // Search
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      list = list.filter(p =>
        p.id?.toLowerCase().includes(q) ||
        p.email?.toLowerCase().includes(q) ||
        p.contact?.includes(q) ||
        p.vpa?.toLowerCase().includes(q) ||
        p.orderId?.toLowerCase().includes(q)
      );
    }

    // Sort
    list = [...list].sort((a, b) => {
      let va: any, vb: any;
      switch (this.sortCol) {
        case 'id':        va = a.id;        vb = b.id;        break;
        case 'amount':    va = a.amount;    vb = b.amount;    break;
        case 'createdAt': va = a.createdAt; vb = b.createdAt; break;
        default:          va = a.createdAt; vb = b.createdAt;
      }
      if (va < vb) return this.sortDir === 'asc' ? -1 : 1;
      if (va > vb) return this.sortDir === 'asc' ?  1 : -1;
      return 0;
    });

    return list;
  }

  pagedPayments(): Payment[] {
    const list = this.filteredSorted();
    const start = (this.currentPage - 1) * this.pageSize;
    return list.slice(start, start + this.pageSize);
  }

  // ── Sort ──────────────────────────────────────────────────────────────────
  sortBy(col: string): void {
    if (this.sortCol === col) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortCol = col;
      this.sortDir = 'desc';
    }
    this.currentPage = 1;
  }

  // ── Master load ───────────────────────────────────────────────────────────
  loadAll(): void {
    this.error.set('');
    this.loadSummary();
    this.loadPayments();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  private loadSummary(): void {
    this.loading.set(true);
    this.svc.getSummary().subscribe({
      next: (res) => {
        if (res.success) this.summary.set(res.data);
        else this.error.set(res.message || 'Could not load summary.');
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to load payment summary.');
        this.loading.set(false);
      },
    });
  }

  // ── Payments ──────────────────────────────────────────────────────────────
  loadPayments(): void {
    this.skipCount = 0;
    this.payments.set([]);
    this.currentPage = 1;
    this.selectedIds.clear();
    this.paymentsLoading.set(true);
    this.error.set('');

    const params: any = {
      count  : 100,          // fetch a larger batch; client-side pagination handles display
      skip   : 0,
      status : this.filterStatus || undefined,
      method : this.filterMethod || undefined,
      from   : this.dateFrom ? Math.floor(new Date(this.dateFrom).getTime() / 1000) : undefined,
      to     : this.dateTo   ? Math.floor(new Date(this.dateTo + 'T23:59:59').getTime() / 1000) : undefined,
    };

    this.svc.getPayments(params).subscribe({
      next: (res) => {
        if (res.success) {
          const items = res.data.items || [];
          this.payments.set(items);
          this.totalCount = res.data.count ?? items.length;
        } else {
          this.error.set(res.message || 'Could not load payments.');
        }
        this.paymentsLoading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to load payments.');
        this.paymentsLoading.set(false);
      },
    });
  }

  loadMore(): void {
    if (this.loadingMore()) return;
    this.skipCount += 100;
    this.loadingMore.set(true);

    this.svc.getPayments({
      count  : 100,
      skip   : this.skipCount,
      status : this.filterStatus || undefined,
      method : this.filterMethod || undefined,
    }).subscribe({
      next: (res) => {
        if (res.success) {
          this.payments.update(prev => [...prev, ...(res.data.items || [])]);
          this.totalCount = this.payments().length;
        }
        this.loadingMore.set(false);
      },
      error: () => this.loadingMore.set(false),
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────
  onSearchChange(): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.currentPage = 1;
    }, 250);
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.currentPage = 1;
  }

  // ── Quick date ranges ─────────────────────────────────────────────────────
  applyQuickRange(key: string): void {
    this.activeRange    = key;
    this.showCustomDate = false;
    const now   = new Date();
    const today = now.toISOString().split('T')[0];

    switch (key) {
      case 'all':
        this.dateFrom = '';
        this.dateTo   = '';
        break;
      case 'today':
        this.dateFrom = today;
        this.dateTo   = today;
        break;
      case 'yesterday': {
        const d = new Date(now);
        d.setDate(d.getDate() - 1);
        const s = d.toISOString().split('T')[0];
        this.dateFrom = s;
        this.dateTo   = s;
        break;
      }
      case 'week': {
        const d = new Date(now);
        d.setDate(d.getDate() - 6);
        this.dateFrom = d.toISOString().split('T')[0];
        this.dateTo   = today;
        break;
      }
      case 'month': {
        const d = new Date(now);
        d.setDate(d.getDate() - 29);
        this.dateFrom = d.toISOString().split('T')[0];
        this.dateTo   = today;
        break;
      }
      case 'thismonth': {
        const d = new Date(now.getFullYear(), now.getMonth(), 1);
        this.dateFrom = d.toISOString().split('T')[0];
        this.dateTo   = today;
        break;
      }
      case 'lastmonth': {
        const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const last  = new Date(now.getFullYear(), now.getMonth(), 0);
        this.dateFrom = first.toISOString().split('T')[0];
        this.dateTo   = last.toISOString().split('T')[0];
        break;
      }
    }
    this.loadPayments();
  }

  toggleCustomDate(): void {
    this.showCustomDate = !this.showCustomDate;
  }

  onCustomDateChange(): void {
    this.activeRange = 'custom';
  }

  applyCustomDate(): void {
    this.showCustomDate = false;
    this.activeRange    = 'custom';
    this.loadPayments();
  }

  clearDateRange(): void {
    this.dateFrom       = '';
    this.dateTo         = '';
    this.activeRange    = 'all';
    this.showCustomDate = false;
    this.loadPayments();
  }

  getActiveRangeLabel(): string {
    const r = this.quickRanges.find(r => r.key === this.activeRange);
    if (r) return r.label;
    if (this.activeRange === 'custom') return this.customDateLabel;
    return '';
  }

  // ── Filter helpers ────────────────────────────────────────────────────────
  clearFilter(type: 'status' | 'method' | 'range'): void {
    if (type === 'status')  { this.filterStatus = ''; }
    if (type === 'method')  { this.filterMethod = ''; }
    if (type === 'range')   { this.clearDateRange(); return; }
    this.loadPayments();
  }

  clearAllFilters(): void {
    this.filterStatus = '';
    this.filterMethod = '';
    this.searchQuery  = '';
    this.dateFrom     = '';
    this.dateTo       = '';
    this.activeRange  = 'all';
    this.currentPage  = 1;
    this.loadPayments();
  }

  hasActiveFilters(): boolean {
    return !!(this.filterStatus || this.filterMethod || this.searchQuery || this.dateFrom || this.dateTo);
  }

  // ── Pagination ────────────────────────────────────────────────────────────
  goToPage(page: number): void {
    if (page < 1 || page > this.totalPages) return;
    this.currentPage = page;
    this.selectedIds.clear();
  }

  prevPage(): void { this.goToPage(this.currentPage - 1); }
  nextPage(): void { this.goToPage(this.currentPage + 1); }

  onPageSizeChange(): void {
    this.currentPage = 1;
    this.selectedIds.clear();
  }

  visiblePages(): number[] {
    const total = this.totalPages;
    const cur   = this.currentPage;
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

    const pages: number[] = [1];
    if (cur > 3)           pages.push(-1);
    for (let i = Math.max(2, cur - 1); i <= Math.min(total - 1, cur + 1); i++) {
      pages.push(i);
    }
    if (cur < total - 2)   pages.push(-1);
    pages.push(total);
    return pages;
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  isSelected(id: string): boolean {
    return this.selectedIds.has(id);
  }

  toggleSelect(id: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (checked) this.selectedIds.add(id);
    else         this.selectedIds.delete(id);
  }

  allSelected(): boolean {
    const page = this.pagedPayments();
    return page.length > 0 && page.every(p => this.selectedIds.has(p.id));
  }

  toggleSelectAll(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.pagedPayments().forEach(p => {
      if (checked) this.selectedIds.add(p.id);
      else         this.selectedIds.delete(p.id);
    });
  }

  clearSelection(): void {
    this.selectedIds.clear();
  }

  exportSelected(): void {
    const rows = this.payments().filter(p => this.selectedIds.has(p.id));
    if (!rows.length) return;
    this._downloadCSV(rows);
  }

  // ── Detail drawer navigation ──────────────────────────────────────────────
  openDetail(payment: Payment): void  { this.selectedPayment.set(payment); }
  closeDetail(): void                  { this.selectedPayment.set(null); }

  currentPaymentIndex(): number {
    const p = this.selectedPayment();
    if (!p) return -1;
    return this.filteredSorted().findIndex(x => x.id === p.id);
  }

  hasPrevPayment(): boolean { return this.currentPaymentIndex() > 0; }
  hasNextPayment(): boolean {
    const idx = this.currentPaymentIndex();
    return idx >= 0 && idx < this.filteredSorted().length - 1;
  }

  prevPayment(): void {
    const idx = this.currentPaymentIndex();
    if (idx > 0) this.selectedPayment.set(this.filteredSorted()[idx - 1]);
  }

  nextPayment(): void {
    const idx = this.currentPaymentIndex();
    const all = this.filteredSorted();
    if (idx >= 0 && idx < all.length - 1) this.selectedPayment.set(all[idx + 1]);
  }

  // ── Clipboard ─────────────────────────────────────────────────────────────
  copyId(id: string, event: MouseEvent): void {
    event.stopPropagation();
    navigator.clipboard?.writeText(id).catch(() => {});
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  exportCSV(): void {
    this._downloadCSV(this.filteredSorted());
  }

  private _downloadCSV(rows: Payment[]): void {
    if (!rows.length) return;

    const headers = [
      'Payment ID', 'Date', 'Email', 'Contact',
      'Amount (paise)', 'Amount (INR)', 'Currency',
      'Method', 'Status', 'Fee', 'Tax', 'Net',
      'Order ID', 'Refund Status', 'VPA', 'Bank',
    ];

    const lines = rows.map(p => [
      p.id,
      new Date(p.createdAt * 1000).toISOString(),
      p.email      || '',
      p.contact    || '',
      p.amount,
      (p.amount / 100).toFixed(2),
      p.currency,
      p.method,
      p.status,
      p.fee  || 0,
      p.tax  || 0,
      ((p.amount - (p.fee || 0) - (p.tax || 0)) / 100).toFixed(2),
      p.orderId       || '',
      p.refundStatus  || '',
      p.vpa           || '',
      p.bank          || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    const csv  = [headers.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `statements-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Formatting ────────────────────────────────────────────────────────────
  formatAmount(paise: number | undefined | null): string {
    if (paise == null || isNaN(paise)) return '0.00';
    return (paise / 100).toLocaleString('en-IN', {
      minimumFractionDigits : 2,
      maximumFractionDigits : 2,
    });
  }

  // ── Method helpers ────────────────────────────────────────────────────────
  getMethodLabel(key: string): string {
    return this.METHOD_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Other');
  }

  getMethodEntries(): { key: string; value: number }[] {
    const map = this.summary()?.methodBreakdown || {};
    return Object.entries(map)
      .map(([key, value]) => ({ key, value: value as number }))
      .sort((a, b) => b.value - a.value);
  }

  getMethodPct(value: number): number {
    const total = Object.values(this.summary()?.methodBreakdown || {})
      .reduce((s: number, v) => s + (v as number), 0);
    return total > 0 ? (value / total) * 100 : 0;
  }

  getSuccessRate(): string {
  const s = this.summary();
  if (!s || !s.totalCount) return '0.0';
  const all      = this.payments();
  const total    = all.length;
  const captured = all.filter(p => p.status === 'captured').length;
  if (total === 0) return (100).toFixed(1);
  return ((captured / total) * 100).toFixed(1);
}

  // ── Notes helper ──────────────────────────────────────────────────────────
  getNoteEntries(notes: Record<string, string>): { key: string; value: string }[] {
    return Object.entries(notes || {}).map(([key, value]) => ({ key, value: String(value) }));
  }

  // ── Trend chart calculations ──────────────────────────────────────────────
  getTrendPoints(): { x: number; y: number }[] {
    const trend = this.summary()?.dailyTrend;
    if (!trend?.length) return [];

    const W = 700, H = 180, PAD_TOP = 20, PAD_BOTTOM = 10;
    const maxAmt = Math.max(...trend.map(d => d.amount), 1);
    const n      = trend.length;

    return trend.map((d, i) => ({
      x: n === 1 ? W / 2 : (i / (n - 1)) * W,
      y: PAD_TOP + (1 - d.amount / maxAmt) * (H - PAD_TOP - PAD_BOTTOM),
    }));
  }

  getTrendLinePath(): string {
    const pts = this.getTrendPoints();
    if (pts.length < 2) return '';
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  }

  getTrendAreaPath(): string {
    const pts = this.getTrendPoints();
    if (pts.length < 2) return '';
    const line  = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const last  = pts[pts.length - 1];
    const first = pts[0];
    return `${line} L${last.x.toFixed(1)},200 L${first.x.toFixed(1)},200 Z`;
  }
}
