import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnChanges, SimpleChanges, inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { QuoteDetailData, QuotePaymentEntry } from './quote-detail.model';

type Tab = 'overview' | 'pricing' | 'payments' | 'activity' | 'crm';

interface ActivityRow {
  title: string;
  detail: string;
  when: string | null;
  sortKey: number;
  tone: 'info' | 'success' | 'warning' | 'error' | 'muted';
}

interface RawRow { key: string; value: string; long: boolean; }

/**
 * Everything known about one quotation, in tabs: overview, price build-up,
 * payments, activity and the raw CRM record. Display-only — pages that edit
 * a quote (Tracking) keep their own forms.
 */
@Component({
  selector: 'app-quote-detail',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './quote-detail.html',
  styleUrls: ['./quote-detail.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuoteDetail implements OnChanges {
  @Input({ required: true }) quote!: QuoteDetailData;
  /** Shown in the facts grid on cross-tenant (Super Admin) views. */
  @Input() tenantName = '';

  private readonly cdr = inject(ChangeDetectorRef);

  tab: Tab = 'overview';
  rawFilter = '';
  copied = '';

  activity: ActivityRow[] = [];
  payments: QuotePaymentEntry[] = [];
  rawRows: RawRow[] = [];

  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'payments', label: 'Payments' },
    { id: 'activity', label: 'Activity' },
    { id: 'crm', label: 'CRM record' },
  ];

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['quote'] && this.quote) {
      const prevId = (ch['quote'].previousValue as QuoteDetailData | undefined)?.quoteId;
      if (prevId !== this.quote.quoteId) { this.tab = 'overview'; this.rawFilter = ''; }
      this.payments = this.buildPayments();
      this.activity = this.buildActivity();
      this.rawRows = this.buildRaw();
    }
  }

  // ── Derived values ────────────────────────────────────────────────────────

  get currency(): string { return this.quote.currency || 'INR'; }
  get paid(): number { return Math.max(0, this.quote.paidAmount ?? 0); }
  get balance(): number {
    return this.quote.balanceDue ?? Math.max(0, (this.quote.amount ?? 0) - this.paid);
  }
  get paidPct(): number {
    const total = this.quote.amount ?? 0;
    return total > 0 ? Math.min(100, Math.round((this.paid / total) * 100)) : 0;
  }
  get daysToExpiry(): number | null {
    if (!this.quote.expiryDate) return null;
    const t = new Date(this.quote.expiryDate).getTime();
    return Number.isNaN(t) ? null : Math.ceil((t - Date.now()) / 86_400_000);
  }
  get displayTitle(): string {
    return this.quote.dealName || this.quote.title || `Quotation #${this.quote.quoteNumber}`;
  }

  approvalLabel(): string {
    const map: Record<string, string> = {
      approved: 'Client approved', rejected: 'Client rejected', pending: 'Awaiting client', draft: 'Draft',
    };
    return map[this.quote.approvalStatus ?? ''] ?? (this.quote.clientApprovalStatus || 'Unknown');
  }
  approvalTone(): string {
    return ({ approved: 'success', rejected: 'error', pending: 'warning', draft: 'muted' } as Record<string, string>)[this.quote.approvalStatus ?? ''] ?? 'muted';
  }
  payLabel(s = this.quote.paymentStatus ?? ''): string {
    const map: Record<string, string> = {
      paid: 'Paid', partially_paid: 'Partially paid', pending: 'Payment pending', failed: 'Lost / failed', refunded: 'Refunded',
    };
    return map[s] ?? (s || '—');
  }
  payTone(s = this.quote.paymentStatus ?? ''): string {
    return ({ paid: 'success', partially_paid: 'violet', pending: 'warning', failed: 'error', refunded: 'info' } as Record<string, string>)[s] ?? 'muted';
  }

  // ── Builders ──────────────────────────────────────────────────────────────

  private buildPayments(): QuotePaymentEntry[] {
    const q = this.quote;
    if (Array.isArray(q.payments) && q.payments.length) return q.payments;
    if (Array.isArray(q.manualPayments) && q.manualPayments.length) {
      return q.manualPayments.map(m => ({
        source: 'Manual', amount: m.amount, date: m.paymentDate ?? null, reference: m.referenceNumber ?? null,
      }));
    }
    if (q._paymentId) return [{ source: 'Razorpay', amount: q.paidAmount ?? 0, date: q.paidAt ?? null, reference: q._paymentId }];
    if ((q.paidAmount ?? 0) > 0) {
      return [{ source: 'Manual', amount: q.paidAmount ?? 0, date: q.paidAt ?? q.trackingUpdatedAt ?? null, reference: q.bankTransferRef || null }];
    }
    return [];
  }

  private buildActivity(): ActivityRow[] {
    const q = this.quote;
    const rows: ActivityRow[] = [];
    const key = (d: string | null | undefined) => { const t = d ? Date.parse(d) : NaN; return Number.isNaN(t) ? 0 : t; };

    if (q.createdAt) rows.push({ title: 'Quotation created in CRM', detail: q.ownerName ? `by ${q.ownerName}` : '', when: q.createdAt, sortKey: key(q.createdAt), tone: 'info' });
    if (q.updatedAt && q.updatedAt !== q.createdAt) rows.push({ title: 'Last modified in CRM', detail: '', when: q.updatedAt, sortKey: key(q.updatedAt), tone: 'muted' });
    if (q.approvalStatus === 'approved') rows.push({ title: 'Approved by client', detail: '', when: null, sortKey: key(q.updatedAt) - 1, tone: 'success' });
    if (q.approvalStatus === 'rejected') rows.push({ title: 'Rejected by client', detail: '', when: null, sortKey: key(q.updatedAt) - 1, tone: 'error' });
    for (const f of q.clientFeedback ?? []) {
      rows.push({ title: f.fromClient ? 'Client feedback' : 'Approval feedback', detail: f.text, when: f.date, sortKey: key(f.date), tone: 'info' });
    }
    if (q.expiryDate) {
      const past = (this.daysToExpiry ?? 1) < 0;
      rows.push({ title: past ? 'Offer expired' : 'Offer expires', detail: '', when: q.expiryDate, sortKey: key(q.expiryDate), tone: past ? 'warning' : 'muted' });
    }
    for (const p of this.payments) {
      rows.push({
        title: `Payment received · ${this.money(p.amount)}`,
        detail: [p.source, p.reference].filter(Boolean).join(' · '),
        when: p.date, sortKey: key(p.date), tone: 'success',
      });
    }
    for (const t of q.timeline ?? []) {
      // Payment entries are already listed above from the structured records.
      if (t.type === 'payment' && this.payments.length) continue;
      const tone: ActivityRow['tone'] = t.type === 'error' ? 'error' : t.type === 'warning' ? 'warning' : t.type === 'payment' ? 'success' : 'info';
      rows.push({ title: t.event, detail: t.by ? `by ${t.by}` : '', when: t.date, sortKey: key(t.date), tone });
    }
    return rows.sort((a, b) => b.sortKey - a.sortKey);
  }

  private buildRaw(): RawRow[] {
    const raw = this.quote.raw ?? {};
    const rows: RawRow[] = [];
    const walk = (obj: unknown, prefix: string, depth: number) => {
      if (obj === null || obj === undefined || typeof obj !== 'object') {
        rows.push({ key: prefix, value: obj === null || obj === undefined || obj === '' ? '—' : String(obj), long: false });
        return;
      }
      if (Array.isArray(obj)) {
        if (!obj.length) { rows.push({ key: prefix, value: '[]', long: false }); return; }
        if (depth >= 2 || obj.every(v => v === null || typeof v !== 'object')) {
          const s = obj.every(v => typeof v !== 'object') ? obj.join(', ') : JSON.stringify(obj, null, 2);
          rows.push({ key: prefix, value: s, long: s.length > 60 });
          return;
        }
        obj.forEach((v, i) => walk(v, `${prefix}[${i}]`, depth + 1));
        return;
      }
      const entries = Object.entries(obj as Record<string, unknown>);
      if (!entries.length) { rows.push({ key: prefix, value: '{}', long: false }); return; }
      if (depth >= 3) { const s = JSON.stringify(obj, null, 2); rows.push({ key: prefix, value: s, long: true }); return; }
      for (const [k, v] of entries) walk(v, prefix ? `${prefix}.${k}` : k, depth + 1);
    };
    walk(raw, '', 0);
    return rows.filter(r => r.key);
  }

  get filteredRaw(): RawRow[] {
    const f = this.rawFilter.trim().toLowerCase();
    if (!f) return this.rawRows;
    return this.rawRows.filter(r => r.key.toLowerCase().includes(f) || r.value.toLowerCase().includes(f));
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  setTab(t: Tab): void { this.tab = t; }

  copy(text: string, what: string): void {
    navigator.clipboard?.writeText(text).then(() => {
      this.copied = what;
      this.cdr.markForCheck();
      setTimeout(() => { if (this.copied === what) { this.copied = ''; this.cdr.markForCheck(); } }, 1500);
    }).catch(() => {});
  }

  copyRaw(): void { this.copy(JSON.stringify(this.quote.raw ?? {}, null, 2), 'json'); }

  // ── Formatting ────────────────────────────────────────────────────────────

  money(n: number | null | undefined): string {
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency', currency: this.currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
      }).format(n ?? 0);
    } catch {
      return `${this.currency} ${(n ?? 0).toFixed(2)}`;
    }
  }

  date(s: string | null | undefined, withTime = false): string {
    if (!s) return '—';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString('en-IN', withTime
      ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: 'short', year: 'numeric' });
  }

  relative(s: string | null | undefined): string {
    if (!s) return '';
    const t = new Date(s).getTime();
    if (Number.isNaN(t)) return '';
    const days = Math.round((t - Date.now()) / 86_400_000);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    return days > 0 ? `in ${days} days` : `${-days} days ago`;
  }

  initials(name?: string): string {
    return (name || '?').split(/\s+/).filter(Boolean).map(p => p[0]).join('').slice(0, 2).toUpperCase() || '?';
  }

  paymentOptionLabel(): string {
    const map: Record<string, string> = { noPayment: 'Not collected via CRM', fullPayment: 'Full payment', partialPayment: 'Partial payment' };
    return map[this.quote.paymentOption ?? ''] ?? (this.quote.paymentOption || '—');
  }

  trackByIdx(i: number): number { return i; }
}
