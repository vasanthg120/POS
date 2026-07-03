// quotations.component.ts
import {
  Component, OnInit, OnDestroy, computed, signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule, DatePipe, TitleCasePipe, DecimalPipe } from '@angular/common';
import { FormsModule  } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Crm }          from '../services/crm';
import { Auth }         from '../services/auth';

/* ── Domain types ─────────────────────────────────────────────────── */
export interface QuoteItem {
  name     : string;
  qty      : number;
  unitPrice: number;
  total    : number;
}

export interface Quote {
  id                  : string;
  quoteId?            : string;
  quoteNumber?        : string;
  title?              : string;
  // FIX: explicit fields now returned by normalise
  dealName?           : string;
  ownerName?          : string;
  ownerEmail?         : string;
  clientApprovalStatus?: string;
  // legacy field aliases kept for backwards compat
  subject?            : string;
  opportunityName?    : string;
  deal_name?          : string;
  opportunity?        : string;
  owner?              : string;
  assignedTo?         : string;
  assigned_to?        : string;
  created_by?         : string;
  createdBy?          : string;
  // client
  customerName?       : string;
  contactName?        : string;
  email?              : string;
  phone?              : string;
  // financial
  amount?             : number;
  total?              : number;
  quote_amount?       : number;
  currency?           : string;
  // status
  status?             : string;
  quote_status?       : string;
  quotationStatus?    : string;    // tracking override
  // dates
  createdAt?          : string | number;
  updatedAt?          : string | number;
  expiryDate?         : string;
  expiry_date?        : string;
  validUntil?         : string;
  valid_until?        : string;
  // products
  items?              : QuoteItem[];
  line_items?         : any[];
  products?           : any[];
  notes?              : string;
  // raw CRM object for any unmapped fields
  raw?                : Record<string, any>;
  [key: string]       : any;
}

export type SortField = 'createdAt' | 'amount' | 'status' | 'customer' | 'quoteId' | '';
export type SortDir   = 'asc' | 'desc';

/* ── Component ────────────────────────────────────────────────────── */
@Component({
  selector        : 'app-quotations',
  standalone      : true,
  imports         : [CommonModule, FormsModule, RouterModule, DatePipe, TitleCasePipe, DecimalPipe],
  templateUrl     : './quotations.html',
  styleUrls       : ['./quotations.css'],
  changeDetection : ChangeDetectionStrategy.OnPush,
})
export class Quotations implements OnInit, OnDestroy {

  /* ── Server state ─────────────────────────────────────────────── */
  quotes        = signal<Quote[]>([]);
  loading       = signal(false);
  loadingMore   = signal(false);
  error         = signal('');
  selectedQuote = signal<Quote | null>(null);
  totalCount    = signal<number | null>(null);

  /* ── Filter / sort state ──────────────────────────────────────── */
  searchTerm    = signal('');
  filterStatus  = signal('');
  dateFrom      = signal('');
  dateTo        = signal('');
  sortField     = signal<SortField>('createdAt');
  sortDir       = signal<SortDir>('desc');
  showDateFilter= signal(false);

  /* ── Pagination ───────────────────────────────────────────────── */
  pageSize    = 25;
  currentPage = signal(1);

  /* ── Misc ─────────────────────────────────────────────────────── */
  today    = new Date();
  todayISO = new Date().toISOString().split('T')[0];

  private startAfter    = 0;
  private readonly PAGE = 25;
  private searchTimeout: ReturnType<typeof setTimeout> | null = null;

  /* ── Stats (computed) ─────────────────────────────────────────── */
  stats = computed(() => {
    const all = this.quotes();
    if (!all.length) return null;

    const totalValue    = all.reduce((s, q) => s + this.getAmount(q), 0);
    const accepted      = all.filter(q => ['accepted', 'approved', 'paid'].includes(this.getApprovalStatus(q)));
    const pending       = all.filter(q => ['sent', 'open', 'draft', 'published'].includes(this.getApprovalStatus(q)));
    const expiringSoon  = all.filter(q => this.isExpiringSoon(q) && !this.isExpired(q));
    const conversionRate = all.length ? Math.round((accepted.length / all.length) * 100) : 0;

    return {
      totalValue,
      acceptedCount : accepted.length,
      pendingCount  : pending.length,
      expiringSoon  : expiringSoon.length,
      conversionRate,
      avgValue      : all.length ? totalValue / all.length : 0,
      currency      : this.getCurrency(all[0]),
    };
  });

  /* ── Filtered + sorted (computed) ────────────────────────────── */
  filteredQuotes = computed(() => {
    let list    = this.quotes();
    const q     = this.searchTerm().toLowerCase().trim();
    const status = this.filterStatus();
    const from   = this.dateFrom();
    const to     = this.dateTo();
    const field  = this.sortField();
    const dir    = this.sortDir();

    if (q) {
      list = list.filter(item =>
        this.getQuoteId(item).toLowerCase().includes(q)    ||
        this.getCustomer(item).toLowerCase().includes(q)   ||
        this.getDealName(item).toLowerCase().includes(q)   ||
        this.getOwner(item).toLowerCase().includes(q)      ||
        (item.email || '').toLowerCase().includes(q)
      );
    }

    if (status) {
      list = list.filter(item => this.getApprovalStatus(item) === status.toLowerCase());
    }

    if (from) {
      const fromMs = new Date(from).getTime();
      list = list.filter(item => {
        const d = this.getDate(item.createdAt);
        return d ? d.getTime() >= fromMs : true;
      });
    }
    if (to) {
      const toMs = new Date(to + 'T23:59:59').getTime();
      list = list.filter(item => {
        const d = this.getDate(item.createdAt);
        return d ? d.getTime() <= toMs : true;
      });
    }

    if (field) {
      list = [...list].sort((a, b) => {
        let av: any, bv: any;
        switch (field) {
          case 'createdAt': av = this.getDate(a.createdAt)?.getTime() ?? 0; bv = this.getDate(b.createdAt)?.getTime() ?? 0; break;
          case 'amount'   : av = this.getAmount(a);  bv = this.getAmount(b);  break;
          case 'status'   : av = this.getApprovalStatus(a); bv = this.getApprovalStatus(b); break;
          case 'customer' : av = this.getCustomer(a).toLowerCase(); bv = this.getCustomer(b).toLowerCase(); break;
          case 'quoteId'  : av = parseInt(this.getQuoteId(a)) || 0; bv = parseInt(this.getQuoteId(b)) || 0; break;
          default         : return 0;
        }
        if (av < bv) return dir === 'asc' ? -1 :  1;
        if (av > bv) return dir === 'asc' ?  1 : -1;
        return 0;
      });
    }
    return list;
  });

  /* ── Pagination computeds ─────────────────────────────────────── */
  totalPages = computed(() => Math.max(1, Math.ceil(this.filteredQuotes().length / this.pageSize)));

  pagedQuotes = computed(() => {
    const start = (this.currentPage() - 1) * this.pageSize;
    return this.filteredQuotes().slice(start, start + this.pageSize);
  });

  visiblePages = computed(() => {
    const total = this.totalPages();
    const cur   = this.currentPage();
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages: number[] = [1];
    if (cur > 3) pages.push(-1);
    for (let i = Math.max(2, cur - 1); i <= Math.min(total - 1, cur + 1); i++) pages.push(i);
    if (cur < total - 2) pages.push(-1);
    pages.push(total);
    return pages;
  });

  /* ── Derived booleans ─────────────────────────────────────────── */
  hasMore = computed(() => {
    const total = this.totalCount();
    if (total === null) return this.quotes().length >= this.PAGE;
    return this.quotes().length < total;
  });

  hasActiveFilters = computed(() =>
    !!(this.searchTerm() || this.filterStatus() || this.dateFrom() || this.dateTo())
  );

  constructor(private crm: Crm, public auth: Auth) {}

  ngOnInit(): void {
    if (this.auth.currentTenant()?.crm?.isConfigured) this.loadQuotes();
  }

  ngOnDestroy(): void {
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
  }

  /* ── Load ─────────────────────────────────────────────────────── */
  loadQuotes(reset = true): void {
    if (reset) { this.startAfter = 0; this.quotes.set([]); this.currentPage.set(1); }
    this.loading.set(true);
    this.error.set('');

    const hasFilters = this.filterStatus() || this.dateFrom() || this.dateTo();
    const obs$ = hasFilters
      ? this.crm.searchQuotes({
          search    : this.searchTerm(),
          limit     : this.PAGE,
          startAfter: this.startAfter,
          status    : this.filterStatus() || undefined,
          dateFrom  : this.dateFrom()    || undefined,
          dateTo    : this.dateTo()      || undefined,
        })
      : this.crm.getQuotes(this.searchTerm(), this.PAGE, this.startAfter);

    obs$.subscribe({
      next: (res) => {
        if (res.success) {
          const incoming: Quote[] =
            res.data?.quotes ||
            (res.data && 'items' in res.data ? (res.data as any).items : []) ||
            [];
          this.quotes.update(prev => reset ? incoming : [...prev, ...incoming]);
          this.totalCount.set(res.data?.total ?? null);
          console.log(res)
        } else {
          this.error.set((res as any).message || 'Could not load quotes.');
        }
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to fetch quotes from CRM.');
        this.loading.set(false);
      },
    });
  }

  loadMore(): void {
    if (this.loadingMore()) return;
    this.startAfter += this.PAGE;
    this.loadingMore.set(true);
    const hasFilters = this.filterStatus() || this.dateFrom() || this.dateTo();
    const obs$ = hasFilters
      ? this.crm.searchQuotes({ search: this.searchTerm(), limit: this.PAGE, startAfter: this.startAfter })
      : this.crm.getQuotes(this.searchTerm(), this.PAGE, this.startAfter);
    obs$.subscribe({
      next : (res) => {
        if (res.success) this.quotes.update(prev => [...prev, ...(res.data?.quotes || [])]);
        this.loadingMore.set(false);
      },
      error: () => { this.startAfter -= this.PAGE; this.loadingMore.set(false); },
    });
  }

  /* ── Sort ─────────────────────────────────────────────────────── */
  toggleSort(field: SortField): void {
    if (this.sortField() === field) {
      this.sortDir.update(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortField.set(field);
      this.sortDir.set(field === 'createdAt' ? 'desc' : 'asc');
    }
    this.currentPage.set(1);
  }

  /* ── Search / filter ──────────────────────────────────────────── */
  onSearch(value: string): void {
    this.searchTerm.set(value);
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => { this.currentPage.set(1); this.loadQuotes(); }, 350);
  }

  onStatusChange(value: string): void { this.filterStatus.set(value); this.loadQuotes(); }
  onDateChange(): void { this.loadQuotes(); }

  clearFilters(): void {
    this.searchTerm.set(''); this.filterStatus.set('');
    this.dateFrom.set(''); this.dateTo.set('');
    this.loadQuotes();
  }

  toggleDateFilter(): void { this.showDateFilter.update(v => !v); }

  clearDates(): void {
    this.dateFrom.set(''); this.dateTo.set('');
    this.showDateFilter.set(false);
    this.loadQuotes();
  }

  refresh(): void { this.loadQuotes(); }

  /* ── Pagination ───────────────────────────────────────────────── */
  goToPage(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.currentPage.set(page);
  }
  prevPage(): void { this.goToPage(this.currentPage() - 1); }
  nextPage(): void { this.goToPage(this.currentPage() + 1); }
  onPageSizeChange(): void { this.currentPage.set(1); }

  /* ── Detail drawer ────────────────────────────────────────────── */
  openDetail(quote: Quote): void  { this.selectedQuote.set(quote); }
  closeDetail(): void              { this.selectedQuote.set(null);  }

  currentQuoteIndex(): number {
    const q = this.selectedQuote();
    if (!q) return -1;
    return this.filteredQuotes().findIndex(x => x.id === q.id || x.quoteId === q.quoteId);
  }

  hasPrevQuote(): boolean { return this.currentQuoteIndex() > 0; }
  hasNextQuote(): boolean {
    const idx = this.currentQuoteIndex();
    return idx >= 0 && idx < this.filteredQuotes().length - 1;
  }

  prevQuote(): void {
    const idx = this.currentQuoteIndex();
    if (idx > 0) this.selectedQuote.set(this.filteredQuotes()[idx - 1]);
  }
  nextQuote(): void {
    const idx = this.currentQuoteIndex();
    const all = this.filteredQuotes();
    if (idx >= 0 && idx < all.length - 1) this.selectedQuote.set(all[idx + 1]);
  }

  /* ── Clipboard ────────────────────────────────────────────────── */
  copyText(text: string, event: MouseEvent): void {
    event.stopPropagation();
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  /* ── CSV export ───────────────────────────────────────────────── */
  exportCSV(): void {
    const rows = this.filteredQuotes();
    if (!rows.length) return;
    const headers = ['Quote #', 'Deal Name', 'Client', 'Email', 'Owner', 'Products', 'Currency', 'Amount', 'Created', 'Expires', 'Approval Status'];
    const lines = rows.map(q => [
      this.getQuoteId(q),
      `"${this.getDealName(q).replace(/"/g, '""')}"`,
      `"${this.getCustomer(q).replace(/"/g, '""')}"`,
      q.email || '',
      `"${this.getOwner(q).replace(/"/g, '""')}"`,
      `"${this.getItemRows(q).map(i => i.name).join('; ').replace(/"/g, '""')}"`,
      this.getCurrency(q),
      this.getAmount(q).toFixed(2),
      this.getDate(q.createdAt)?.toISOString().split('T')[0] || '',
      this.getExpiryDateStr(q),
      this.getApprovalStatus(q),
    ].join(','));
    const csv  = [headers.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `quotes-${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  /* ══════════════════════════════════════════════════════════════
     CORE FIELD HELPERS  — read normalised field first, fall back to raw
     ══════════════════════════════════════════════════════════════ */

  /** Quote number / ID */
  getQuoteId(q: Quote): string {
    return q.quoteNumber || q.quoteId || q.id || '—';
  }

  /**
   * Deal / opportunity name.
   * FIX: normalise now returns dealName from quote_name / deal.name.
   * Falls back through raw object for safety.
   */
  getDealName(q: Quote): string {
    return (
      q.dealName               ||
      q.raw?.['quote_name']    ||
      q.raw?.['deal']?.['name'] ||
      q.opportunityName        ||
      q.deal_name              ||
      q.title                  ||
      q.subject                ||
      `Quote ${this.getQuoteId(q)}`
    );
  }

  /**
   * Quote owner name.
   * FIX: normalise now returns ownerName from quote_owner.name.
   */
  getOwner(q: Quote): string {
    return (
      q.ownerName                        ||
      q.raw?.['quote_owner']?.['name']   ||
      q.owner                            ||
      q.assignedTo                       ||
      q.assigned_to                      ||
      q.createdBy                        ||
      q.created_by                       ||
      ''
    );
  }

  getOwnerInitial(q: Quote): string {
    return this.getOwner(q)?.[0]?.toUpperCase() || '?';
  }

  /** Client / customer display name */
  getCustomer(q: Quote): string {
    return q.customerName || q.contactName || q.email || '—';
  }

  /** Quote total amount */
  getAmount(q: Quote): number {
    return q.amount ?? q.quote_amount ?? q.total ?? 0;
  }

  /**
   * Client approval status — the status the CLIENT set on the quote.
   * FIX: reads from clientApprovalStatus (now in normalise) and raw fallback.
   * Maps ProspectConnect values to our display values.
   */
getApprovalStatus(q: Quote): string {
  if (q.quotationStatus) return q.quotationStatus.toLowerCase().replace(/\s+/g, '_');

  const raw =
    q.clientApprovalStatus          ||
    q.raw?.['client_approval_status'] ||
    '';

  const normalised = raw.toLowerCase().trim();

  if (normalised === 'approved')              return 'accepted';
  if (normalised === 'declined')              return 'rejected';
  if (normalised === 'pending')               return 'sent';
  if (normalised === 'approved_by_client')    return 'accepted';
  if (normalised === 'in progress')           return 'in_progress';
  if (normalised === 'payment completed')     return 'payment_completed';
  if (normalised === 'awaiting_response')     return 'awaiting_response';
  if (normalised)                             return normalised.replace(/\s+/g, '_');

  const qs = (q.raw?.['quote_status'] || q.status || '').toLowerCase();
  if (qs === 'published') return 'sent';
  return qs || 'draft';
}

  /** Quote publish status (internal — used for badge colour context) */
  getStatus(q: Quote): string {
    return this.getApprovalStatus(q);
  }

  /** Currency code */
  getCurrency(q: Quote): string {
    return q.currency || this.auth.currentTenant()?.currency || 'INR';
  }

  /** Format a number with locale-aware commas */
  formatAmount(val: number | undefined | null): string {
    if (val == null || isNaN(val)) return '0.00';
    return val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Parse any date value to a JS Date, or null */
  getDate(val: string | number | undefined | null): Date | null {
    if (!val) return null;
    const d = typeof val === 'number'
      ? new Date(val > 1e10 ? val : val * 1000)
      : new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Resolve expiry date from normalised field first, then raw fallback.
   * FIX: the normalise function now maps expiration_date → expiryDate,
   * but raw is checked here as a belt-and-suspenders safety net.
   */
  getExpiryDate(q: Quote): Date | null {
    const raw =
      q.expiryDate                         ||
      q.raw?.['expiration_date']           ||
      q.raw?.['expiry_date']               ||
      q.expiry_date                        ||
      q.validUntil                         ||
      q.valid_until                        ||
      null;
    return this.getDate(raw);
  }

  getExpiryDateStr(q: Quote): string {
    return this.getExpiryDate(q)?.toISOString().split('T')[0] || '';
  }

  /** True if expiring within 7 days and not yet expired */
  isExpiringSoon(q: Quote): boolean {
    const exp = this.getExpiryDate(q);
    if (!exp) return false;
    const diff = (exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 7;
  }

  /** True if expiry date is in the past */
  isExpired(q: Quote): boolean {
    const exp = this.getExpiryDate(q);
    if (!exp) return false;
    return exp.getTime() < Date.now();
  }

  /** Days remaining until expiry (null if no expiry date) */
  getDaysToExpiry(q: Quote): number | null {
    const exp = this.getExpiryDate(q);
    if (!exp) return null;
    return Math.ceil((exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  }

  /** Normalise line items from various CRM structures */
  getItemRows(q: Quote): QuoteItem[] {
    const raw: any[] = q.items || q.raw?.['items'] || q.line_items || q.raw?.['line_items'] || q.products || [];
    return raw
      .filter(i => i && (i.name || i.product_name || i.productName || i.description))
      .map(i => ({
        name     : i.name || i.product_name || i.productName || i.description || 'Item',
        qty      : i.qty  || i.quantity || i.count || 1,
        unitPrice: i.unitPrice || i.unit_price || i.price || i.rate || 0,
        total    : i.total || i.line_total || i.amount ||
                   ((i.qty || i.quantity || 1) * (i.unitPrice || i.unit_price || i.price || i.rate || 0)),
      }));
  }

  getTotalItems(q: Quote): number {
    return (q.items || q.raw?.['items'] || q.line_items || q.products || []).length;
  }

  /** Avatar colour deterministically from name */
  getAvatarColor(name: string): string {
    const colors = [
      'var(--avatar-violet)', 'var(--avatar-sky)', 'var(--avatar-emerald)',
      'var(--avatar-amber)', 'var(--avatar-rose)', 'var(--avatar-teal)',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }
}
