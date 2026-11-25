import { Component, OnInit, OnDestroy } from "@angular/core";
import { CommonModule, NgFor, NgIf } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Subject, debounceTime, takeUntil } from "rxjs";
import {
  Margin,
  MarginJobRecord,
  MarginJobPayload,
  JobStats,
} from "../services/margin";
import { Auth } from "../services/auth";
import {
  calculate, health as marginHealth,
  CalcResult, Health, RowResult, HEALTH_MARGIN_BANDS, ROUNDING_STEPS,
} from "./margin-engine";

/* ── interfaces ── */
interface LineItem {
  id: string;
  item: string;
  qty: number | null;
  unitCost: number | null;
  decoUnit: number | null;
  setup: number | null;
  ship: number | null;
  quoteUnit: number | null;
}

type JobFilter = "active" | "draft" | "finalised" | "archived";

/**
 * Margin calculator.
 *
 * All maths lives in margin-engine.ts (mirrored on the server, which
 * recomputes every saved job). This component holds the inputs, renders the
 * results, and handles saving/loading jobs.
 *
 * Margin is MARGIN ON COST: profit ÷ cost. Cost ₹100 sold at ₹200 = 100%.
 */
@Component({
  selector: "app-margin-calculator",
  standalone: true,
  imports: [CommonModule, FormsModule, NgFor, NgIf],
  templateUrl: "./margin-calculator.html",
  styleUrls: ["./margin-calculator.css"],
})
export class MarginCalculator implements OnInit, OnDestroy {
  /* ── state ── */
  rows: LineItem[] = [];
  result: CalcResult = calculate({ rows: [] });
  idCounter = 0;

  /* ── job fields ── */
  jobName = "";
  // Billed to the client (revenue)
  setupCount: number | null = 1;
  setupUnit: number | null = 0;
  shipping: number | null = 0;
  discountPct: number | null = 0;
  // Job costs not on a line item
  otherCost: number | null = 0;
  paymentFeePct: number | null = 0;
  // Tax
  gstRate: number | null = 18;
  readonly gstPresets = [0, 5, 12, 18, 28];
  // Pricing target: margin on cost, in %
  targetPct: number | null = 50;
  priceRounding = 1;
  readonly roundingSteps = ROUNDING_STEPS;

  /* ── display ── */
  showHelp = false;

  /* ── DB integration ── */
  currentJobId: string | null = null;
  currentJobStatus: "draft" | "finalised" | "archived" | null = null;
  isSaving = false;
  isSaved = false;
  isLoading = false;

  /* Jobs drawer */
  drawerOpen = false;
  jobsList: MarginJobRecord[] = [];
  jobsListLoading = false;
  jobSearchQuery = "";
  jobFilter: JobFilter = "active";
  jobStats: JobStats | null = null;

  /* Autosave / search debounce */
  private autosave$ = new Subject<void>();
  private search$ = new Subject<void>();
  private destroy$ = new Subject<void>();
  /** Set while applying a loaded job, so loading doesn't trigger a save. */
  private suppressAutosave = false;

  /* ── toast ── */
  toastVisible = false;
  toastMessage = "";
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private jobSvc: Margin, public auth: Auth) {}

  /* ════════════════════════════════════════
     LIFECYCLE
     ═════════════════════════════════════════ */
  ngOnInit(): void {
    this.addRow();
    this.loadStats();

    this.autosave$
      .pipe(debounceTime(1500), takeUntil(this.destroy$))
      .subscribe(() => this.autosaveJob());
    this.search$
      .pipe(debounceTime(300), takeUntil(this.destroy$))
      .subscribe(() => this.fetchJobsList());
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  /* ════════════════════════════════════════
     ROW MANAGEMENT
     ═════════════════════════════════════════ */
  addRow(): void {
    this.rows.push({
      id: `r${++this.idCounter}`,
      item: "", qty: null, unitCost: null,
      decoUnit: null, setup: null, ship: null, quoteUnit: null,
    });
    this.recalc();
  }

  duplicateRow(index: number): void {
    const src = this.rows[index];
    this.rows.splice(index + 1, 0, { ...src, id: `r${++this.idCounter}`, item: src.item ? `${src.item} (copy)` : "" });
    this.recalc();
  }

  deleteRow(id: string): void {
    this.rows = this.rows.filter((r) => r.id !== id);
    this.recalc();
  }

  clearRows(): void {
    if (this.rows.some(r => r.item || r.qty || r.unitCost || r.quoteUnit)
      && !confirm("Remove all line items from this job?")) return;
    this.rows = [];
    this.recalc();
    this.showToast("All rows cleared");
  }

  trackById(_: number, row: LineItem): string { return row.id; }

  /* ════════════════════════════════════════
     CALC
     ═════════════════════════════════════════ */
  recalc(): void {
    this.result = calculate(this.engineInput());
    if (this.suppressAutosave) return;
    this.isSaved = false;
    this.autosave$.next();
  }

  private engineInput() {
    return {
      rows: this.rows,
      setupCount: this.setupCount, setupUnit: this.setupUnit, shipping: this.shipping,
      gstRate: this.gstRate, discountPct: this.discountPct, otherCost: this.otherCost,
      paymentFeePct: this.paymentFeePct, targetPct: this.targetPct,
      priceRounding: this.priceRounding,
    };
  }

  get summary() { return this.result.summary; }
  get target() { return this.result.target; }
  calcRow(i: number): RowResult | undefined { return this.result.rows[i]; }

  setGst(rate: number): void { this.gstRate = rate; this.recalc(); }

  /* ── Target pricing ── */
  get canApplySuggestions(): boolean {
    return this.result.rows.some((r, i) => r.suggestedUnitPrice !== null && r.suggestedUnitPrice !== this.rows[i]?.quoteUnit);
  }

  applySuggestedPrice(i: number): void {
    const p = this.result.rows[i]?.suggestedUnitPrice;
    if (p === null || p === undefined) return;
    this.rows[i].quoteUnit = p;
    this.recalc();
  }

  applySuggestedPrices(): void {
    let changed = 0;
    this.result.rows.forEach((r, i) => {
      if (r.suggestedUnitPrice !== null && this.rows[i]) { this.rows[i].quoteUnit = r.suggestedUnitPrice; changed++; }
    });
    this.recalc();
    this.showToast(changed
      ? `Prices set for a ${this.fmtPct(this.target.marginPct, 0)} margin`
      : "Nothing to price — add quantities and costs first");
  }

  /* ════════════════════════════════════════
     DISPLAY HELPERS
     ═════════════════════════════════════════ */
  /** Health of a margin on cost (bands in margin-engine.ts). */
  health(marginPct: number | null | undefined): Health { return marginHealth(marginPct ?? null); }

  healthLabel(marginPct: number | null | undefined): string {
    return {
      loss: "Loss", poor: "Poor", fair: "Fair", good: "Good", excellent: "Excellent", none: "No price set",
    }[this.health(marginPct)];
  }

  /** The health bands, for the legend under the gauge. */
  get bandLabels(): { cls: string; text: string }[] {
    const [a, b, c] = HEALTH_MARGIN_BANDS;
    const show = (m: number) => this.fmtPct(m, 0);
    return [
      { cls: "band--poor", text: `Poor <${show(a)}` },
      { cls: "band--fair", text: `Fair ${show(a)}–${show(b)}` },
      { cls: "band--ok", text: `Good ${show(b)}–${show(c)}` },
      { cls: "band--great", text: `Excellent ≥${show(c)}` },
    ];
  }

  rowStateHint(i: number): string {
    const r = this.result.rows[i];
    if (!r) return "";
    switch (r.state) {
      case "loss": return "Selling below cost";
      case "no-price": return "Set a selling price";
      case "no-qty": return "Set a quantity";
      default: return "";
    }
  }

  fmt(n: number | null | undefined): string {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    const abs = Math.abs(n);
    const formatted = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs);
    return n < 0 ? `-₹${formatted}` : `₹${formatted}`;
  }

  fmtPct(n: number | null | undefined, digits = 1): string {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    return `${(n * 100).toFixed(digits)}%`;
  }

  fmtCurrency(n: number | null | undefined): string {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n || 0);
  }

  /** Gauge fill: the bar is full at the "excellent" band (100% margin). */
  gaugeWidth(marginPct: number | null): string {
    if (marginPct === null || !isFinite(marginPct)) return "0%";
    const full = HEALTH_MARGIN_BANDS[2];
    return `${Math.min(Math.max(marginPct / full * 100, 0), 100).toFixed(1)}%`;
  }

  statusBadgeClass(status: string): string {
    return ({ draft: "badge--draft", finalised: "badge--finalised", archived: "badge--archived" } as Record<string, string>)[status] || "";
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  }

  /**
   * A saved job's margin on cost, from its stored totals — works the same for
   * jobs saved before margin-on-cost existed: profit ÷ (revenue − profit).
   */
  jobMargin(job: MarginJobRecord): number | null {
    const revenue = Number(job.summary?.["grandTotal"] ?? 0);
    const profit = Number(job.summary?.["profitSubtotal"] ?? 0);
    const cost = revenue - profit;
    return revenue > 0 && cost > 0 ? profit / cost : null;
  }

  get jobDisplay(): string { return this.jobName.trim() || "Untitled job"; }
  get hasJobName(): boolean { return this.jobName.trim().length > 0; }
  get canSave(): boolean { return this.auth.canAccess("margin-calculator", "create"); }

  get saveLabel(): string {
    if (this.isSaving) return "Saving…";
    if (this.isSaved) return "Saved ✓";
    return this.currentJobId ? "Save changes" : "Save Job";
  }

  /* ════════════════════════════════════════
     DB OPERATIONS
     ═════════════════════════════════════════ */
  private buildPayload(): MarginJobPayload {
    const n = (v: number | null) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0);
    return {
      jobName: this.jobName.trim(),
      setupCount: n(this.setupCount),
      setupUnit: n(this.setupUnit),
      shipping: n(this.shipping),
      gstRate: n(this.gstRate),
      discountPct: n(this.discountPct),
      otherCost: n(this.otherCost),
      paymentFeePct: n(this.paymentFeePct),
      targetPct: n(this.targetPct),
      priceRounding: this.priceRounding,
      rows: this.rows.map(({ id, ...r }) => ({
        item: r.item ?? "", qty: n(r.qty), unitCost: n(r.unitCost), decoUnit: n(r.decoUnit),
        setup: n(r.setup), ship: n(r.ship), quoteUnit: n(r.quoteUnit),
      })),
    };
  }

  saveJob(): void {
    if (this.isSaving) return;
    this.isSaving = true;
    const isNew = !this.currentJobId;
    const req$ = isNew
      ? this.jobSvc.createJob(this.buildPayload())
      : this.jobSvc.updateJob(this.currentJobId as string, this.buildPayload());

    req$.subscribe({
      next: (res) => {
        this.currentJobId = res.data._id;
        this.currentJobStatus = res.data.status;
        this.isSaving = false;
        this.isSaved = true;
        this.showToast(isNew ? "Job created ✓" : "Job saved ✓");
        this.loadStats();
      },
      error: (err) => {
        this.isSaving = false;
        this.showToast(err?.error?.message || "Save failed — check your connection");
      },
    });
  }

  private autosaveJob(): void {
    if (!this.currentJobId || !this.canSave || this.isSaving) return;
    this.jobSvc.updateJob(this.currentJobId, this.buildPayload()).subscribe({
      next: () => { this.isSaved = true; },
      error: () => { this.isSaved = false; },
    });
  }

  private applyJob(d: MarginJobRecord): void {
    this.suppressAutosave = true;
    this.currentJobId = d._id;
    this.currentJobStatus = d.status;
    this.jobName = d.jobName ?? "";
    this.setupCount = d.setupCount ?? 1;
    this.setupUnit = d.setupUnit ?? 0;
    this.shipping = d.shipping ?? 0;
    this.gstRate = d.gstRate ?? 18;
    this.discountPct = d.discountPct ?? 0;
    this.otherCost = d.otherCost ?? 0;
    this.paymentFeePct = d.paymentFeePct ?? 0;
    this.targetPct = d.targetPct ?? 50;
    this.priceRounding = d.priceRounding ?? 1;
    this.idCounter = 0;
    this.rows = (d.rows || []).map((r) => ({
      id: `r${++this.idCounter}`,
      item: r.item ?? "", qty: r.qty ?? null, unitCost: r.unitCost ?? null, decoUnit: r.decoUnit ?? null,
      setup: r.setup ?? null, ship: r.ship ?? null, quoteUnit: r.quoteUnit ?? null,
    }));
    this.recalc();
    this.suppressAutosave = false;
    this.isSaved = true;
  }

  loadJobFromDrawer(job: MarginJobRecord): void {
    this.isLoading = true;
    this.jobSvc.getJob(job._id).subscribe({
      next: (res) => {
        this.applyJob(res.data);
        this.drawerOpen = false;
        this.isLoading = false;
        this.showToast(`Loaded: ${res.data.jobName || "Untitled job"}`);
      },
      error: () => {
        this.isLoading = false;
        this.showToast("Failed to load job");
      },
    });
  }

  duplicateJob(job: MarginJobRecord, event: Event): void {
    event.stopPropagation();
    this.jobSvc.duplicateJob(job._id).subscribe({
      next: (res) => {
        this.applyJob(res.data);
        this.drawerOpen = false;
        this.showToast(`Duplicated as “${res.data.jobName}”`);
        this.loadStats();
      },
      error: () => this.showToast("Duplicate failed"),
    });
  }

  setJobStatus(job: MarginJobRecord, status: "draft" | "archived", event: Event): void {
    event.stopPropagation();
    this.jobSvc.setStatus(job._id, status).subscribe({
      next: () => {
        this.jobsList = this.jobsList.filter(j => j._id !== job._id);
        if (this.currentJobId === job._id) this.currentJobStatus = status;
        this.showToast(status === "archived" ? "Job archived" : "Job restored to drafts");
        this.loadStats();
      },
      error: () => this.showToast("Couldn’t change the job status"),
    });
  }

  toggleFinalised(): void {
    if (!this.currentJobId) return;
    const next = this.currentJobStatus === "finalised" ? "draft" : "finalised";
    this.jobSvc.setStatus(this.currentJobId, next).subscribe({
      next: () => {
        this.currentJobStatus = next;
        this.showToast(next === "finalised" ? "Job finalised ✓" : "Job moved back to draft");
        this.loadStats();
      },
      error: () => this.showToast("Couldn’t change the job status"),
    });
  }

  /* ════════════════════════════════════════
     DRAWER
     ═════════════════════════════════════════ */
  openDrawer(): void {
    this.drawerOpen = true;
    this.fetchJobsList();
  }

  closeDrawer(): void { this.drawerOpen = false; }

  setJobFilter(f: JobFilter): void {
    this.jobFilter = f;
    this.fetchJobsList();
  }

  fetchJobsList(): void {
    this.jobsListLoading = true;
    this.jobSvc.fetchJobs({
      q: this.jobSearchQuery.trim() || undefined,
      status: this.jobFilter === "active" ? undefined : this.jobFilter,
      limit: 50,
    }).subscribe({
      next: (res) => { this.jobsList = res.data; this.jobsListLoading = false; },
      error: () => { this.jobsListLoading = false; this.showToast("Couldn’t load saved jobs"); },
    });
  }

  onJobSearch(): void { this.search$.next(); }

  loadStats(): void {
    this.jobSvc.getStats().subscribe({
      next: (res) => { this.jobStats = res.data; },
      error: () => {},
    });
  }

  /** Margin on cost across the active saved jobs. */
  get statsPct(): number | null {
    const s = this.jobStats;
    return s && s.totalRevenue ? s.avgMarginPct : null;
  }

  /* ════════════════════════════════════════
     NEW / RESET
     ═════════════════════════════════════════ */
  private resetFields(): void {
    this.currentJobId = null;
    this.currentJobStatus = null;
    this.isSaved = false;
    this.rows = [];
    this.jobName = "";
    this.setupCount = 1;
    this.setupUnit = 0;
    this.shipping = 0;
    this.discountPct = 0;
    this.otherCost = 0;
    this.paymentFeePct = 0;
    this.gstRate = 18;
    this.targetPct = 50;
    this.priceRounding = 1;
    this.addRow();
  }

  newJob(): void {
    this.resetFields();
    this.drawerOpen = false;
    this.showToast("New job started");
  }

  resetAll(): void {
    if (!confirm("Clear the calculator? Unsaved changes will be lost.")) return;
    this.resetFields();
    this.showToast("Calculator reset");
  }

  /* ════════════════════════════════════════
     CSV EXPORT
     ═════════════════════════════════════════ */
  exportCsv(): void {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const m = (v: number | null) => (v === null ? "" : v.toFixed(2));
    const p = (v: number | null) => (v === null ? "" : `${(v * 100).toFixed(1)}%`);
    const s = this.summary;

    const headers = [
      "Product", "Qty", "Cost/Unit", "Item Cost", "Print/Unit", "Print Total", "Setup Cost", "Shipping Cost",
      "Total Cost", "All-in Cost/Unit", "Sell Price/Unit", "Revenue", "Profit/Unit", "Profit", "Margin % (on cost)",
      "Target Price/Unit",
    ];
    const lines = this.rows.map((r, i) => {
      const c = this.result.rows[i];
      return [
        q(r.item), c.qty, m(r.unitCost ?? 0), m(c.cog), m(r.decoUnit ?? 0), m(c.decoCost), m(r.setup ?? 0), m(r.ship ?? 0),
        m(c.totalCost), m(c.costPerUnit), m(r.quoteUnit ?? 0), m(c.revenue), m(c.profitPerUnit), m(c.profit),
        p(c.marginPct), m(c.suggestedUnitPrice),
      ].join(",");
    });

    const name = this.jobName.trim() || "Untitled job";
    const summary = [
      "",
      [q("Client / Job"), q(name)].join(","),
      [q("Line items (after discount)"), m(s.lineRevenue)].join(","),
      [q(`Discount (${this.discountPct ?? 0}%)`), m(-s.discountAmount)].join(","),
      [q(`Setup fees billed (${this.setupCount ?? 0} × ${m(this.setupUnit ?? 0)})`), m(s.setupFees)].join(","),
      [q("Shipping billed"), m(s.shippingFee)].join(","),
      [q("Taxable value (ex GST)"), m(s.taxableValue)].join(","),
      [q(`GST (${this.gstRate ?? 0}%)`), m(s.gstAmount)].join(","),
      [q("Invoice total (incl. GST)"), m(s.invoiceTotal)].join(","),
      [q("Line item costs"), m(s.lineCost)].join(","),
      [q("Other job costs"), m(s.otherCost)].join(","),
      [q(`Payment fee (${this.paymentFeePct ?? 0}%)`), m(s.paymentFee)].join(","),
      [q("All-in cost"), m(s.allInCost)].join(","),
      [q("Net profit"), m(s.netProfit)].join(","),
      [q("Margin % (profit ÷ cost)"), p(s.marginPct)].join(","),
      [q("Break-even taxable value"), m(s.breakEvenTaxable)].join(","),
    ];

    // BOM so Excel opens ₹ and other UTF-8 text correctly.
    const csv = "﻿" + [headers.map(q).join(","), ...lines, ...summary].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `margin-${name.replace(/[^\w-]+/g, "-").replace(/-+/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast("CSV exported");
  }

  private showToast(msg: string, ms = 2500): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastMessage = msg;
    this.toastVisible = true;
    this.toastTimer = setTimeout(() => { this.toastVisible = false; }, ms);
  }
}
