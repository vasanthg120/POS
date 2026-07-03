import { Component, OnInit, OnDestroy } from "@angular/core";
import { CommonModule, NgFor, NgIf } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Subject, debounceTime, takeUntil } from "rxjs";
import {
  Margin,
  MarginJobRecord,
  JobStats,
} from "../services/margin";

/* ── interfaces ── */
interface LineItem {
  id: string;
  item: string;
  qty: number;
  unitCost: number;
  decoUnit: number;
  setup: number;
  ship: number;
  quoteUnit: number;
}

interface LineItemCalc extends LineItem {
  cog: number;
  decoCost: number;
  totalCost: number;
  costPerUnit: number;
  quoteCost: number;
  marginUnit: number;
  totalMargin: number;
  marginPct: number;
}

interface Summary {
  totalQty: number;
  totalCog: number;
  totalDecoCost: number;
  totalSetup: number;
  totalShip: number;
  totalCost: number;
  totalQuote: number;
  totalMargin: number;
  totalMarginPct: number;
  subtotal: number;
  inclDelivery: number;
  setupTotal: number;
  grandTotal: number;
  profitSubtotal: number;
  incGst: number;
  overallMarginPct: number;
}

type MarginHealth = "poor" | "fair" | "ok" | "great";

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
  calced: LineItemCalc[] = [];
  summary: Summary = this.emptyS();
  idCounter: number = 0;

  /* ── job fields ── */
  jobName: string = "";
  setupCount: number = 1;
  setupUnit: number = 0;
  shipping: number = 0;
  gstRate: number = 18;

  /* ── DB integration ── */
  currentJobId: string | null = null;        // ID of the loaded/saved job
  isSaving = false;
  isSaved  = false;
  isLoading = false;

  /* Jobs drawer */
  drawerOpen = false;
  jobsList: MarginJobRecord[] = [];
  jobsListLoading = false;
  jobSearchQuery = "";
  jobStats: JobStats | null = null;

  /* Status options */
  readonly statusOptions = ['draft', 'finalised', 'archived'] as const;

  /* Autosave debounce */
  private autosave$ = new Subject<void>();
  private destroy$  = new Subject<void>();

  /* ── toast ── */
  toastVisible = false;
  toastMessage = "";
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private jobSvc: Margin) {}

  /* ════════════════════════════════════════
     LIFECYCLE
     ═════════════════════════════════════════ */
  ngOnInit(): void {
    this.addRow();
    this.loadStats();

    // Autosave: debounce 1.5s after any change
    this.autosave$
      .pipe(debounceTime(1500), takeUntil(this.destroy$))
      .subscribe(() => this.autosaveJob());
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /* ════════════════════════════════════════
     ROW MANAGEMENT
     ═════════════════════════════════════════ */
  addRow(): void {
    this.rows.push({
      id: `r${++this.idCounter}`,
      item: "", qty: 0, unitCost: 0,
      decoUnit: 0, setup: 0, ship: 0, quoteUnit: 0,
    });
    this.recalc();
  }

  deleteRow(id: string): void {
    this.rows = this.rows.filter((r) => r.id !== id);
    this.recalc();
  }

  clearRows(): void {
    this.rows = [];
    this.recalc();
    this.showToast("All rows cleared");
  }

  trackById(_: number, row: LineItem): string { return row.id; }

  /* ════════════════════════════════════════
     CALC ENGINE
     ═════════════════════════════════════════ */
  recalc(): void {
    this.calced = this.rows.map((r) => this.calcRow(r));
    const c = this.calced;

    const totalQty      = c.reduce((s, r) => s + (r.qty || 0), 0);
    const totalCog      = c.reduce((s, r) => s + r.cog, 0);
    const totalDecoCost = c.reduce((s, r) => s + r.decoCost, 0);
    const totalSetup    = c.reduce((s, r) => s + (r.setup || 0), 0);
    const totalShip     = c.reduce((s, r) => s + (r.ship || 0), 0);
    const totalCost     = c.reduce((s, r) => s + r.totalCost, 0);
    const totalQuote    = c.reduce((s, r) => s + r.quoteCost, 0);
    const totalMargin   = totalQuote - totalCost;
    const totalMarginPct = totalQuote > 0 ? totalMargin / totalQuote : 0;

    const shippingVal = this.shipping   || 0;
    const setupTotal  = (this.setupCount || 0) * (this.setupUnit || 0);
    const subtotal    = totalQuote;
    const inclDelivery = subtotal + shippingVal;
    const grandTotal  = inclDelivery + setupTotal;
    const profitSubtotal = grandTotal - totalCost;
    const gstFraction = this.gstRate / 100;
    const incGst = grandTotal + grandTotal * gstFraction;
    const overallMarginPct = grandTotal > 0 ? profitSubtotal / grandTotal : 0;

    this.summary = {
      totalQty, totalCog, totalDecoCost, totalSetup, totalShip,
      totalCost, totalQuote, totalMargin, totalMarginPct,
      subtotal, inclDelivery, setupTotal, grandTotal,
      profitSubtotal, incGst, overallMarginPct,
    };

    // Trigger autosave if a job is loaded
    this.isSaved = false;
    this.autosave$.next();
  }

  private calcRow(r: LineItem): LineItemCalc {
    const qty      = r.qty       || 0;
    const unitCost = r.unitCost  || 0;
    const decoUnit = r.decoUnit  || 0;
    const setup    = r.setup     || 0;
    const ship     = r.ship      || 0;
    const quoteUnit = r.quoteUnit || 0;

    const cog        = qty * unitCost;
    const decoCost   = qty * decoUnit;
    const totalCost  = cog + decoCost + setup + ship;
    const costPerUnit = qty > 0 ? totalCost / qty : 0;
    const quoteCost  = qty * quoteUnit;
    const marginUnit = quoteUnit - costPerUnit;
    const totalMargin = quoteCost - totalCost;
    const marginPct  = quoteCost > 0 ? totalMargin / quoteCost : 0;

    return { ...r, cog, decoCost, totalCost, costPerUnit, quoteCost, marginUnit, totalMargin, marginPct };
  }

  /* ════════════════════════════════════════
     DB OPERATIONS
     ═════════════════════════════════════════ */
  buildPayload() {
    return {
      jobName   : this.jobName,
      setupCount: this.setupCount,
      setupUnit : this.setupUnit,
      shipping  : this.shipping,
      gstRate   : this.gstRate,
      rows      : this.rows.map(({ id, ...rest }) => rest),  // strip local id
      summary   : this.summary as any,
    };
  }

  saveJob(): void {
    this.isSaving = true;
    const payload = this.buildPayload();

    const req$ = this.currentJobId
      ? this.jobSvc.updateJob(this.currentJobId, payload)
      : this.jobSvc.createJob(payload);

    req$.subscribe({
      next: (res) => {
        this.currentJobId = res.data._id;
        this.isSaving = false;
        this.isSaved  = true;
        this.showToast(this.currentJobId ? "Job saved ✓" : "Job created ✓");
        this.loadStats();
      },
      error: () => {
        this.isSaving = false;
        this.showToast("Save failed — check connection");
      },
    });
  }

  private autosaveJob(): void {
    if (!this.currentJobId) return;   // only autosave existing jobs
    const payload = this.buildPayload();
    this.jobSvc.updateJob(this.currentJobId, payload).subscribe({
      next: () => { this.isSaved = true; },
      error: () => {},
    });
  }

  loadJobFromDrawer(job: MarginJobRecord): void {
    this.isLoading = true;
    this.jobSvc.getJob(job._id).subscribe({
      next: (res) => {
        const d = res.data;
        this.currentJobId = d._id;
        this.jobName   = d.jobName;
        this.setupCount = d.setupCount;
        this.setupUnit  = d.setupUnit;
        this.shipping   = d.shipping;
        this.gstRate    = d.gstRate;

        // Restore rows with local IDs
        this.idCounter = 0;
        this.rows = (d.rows || []).map((r: any) => ({
          id: `r${++this.idCounter}`,
          ...r,
        }));
        this.recalc();
        this.drawerOpen = false;
        this.isLoading  = false;
        this.isSaved = true;
        this.showToast(`Loaded: ${d.jobName || 'Untitled'}`);
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
        this.loadJobFromDrawer(res.data);
        this.showToast("Job duplicated");
        this.openDrawer();
      },
      error: () => this.showToast("Duplicate failed"),
    });
  }

  archiveJob(job: MarginJobRecord, event: Event): void {
    event.stopPropagation();
    this.jobSvc.setStatus(job._id, 'archived').subscribe({
      next: () => {
        this.jobsList = this.jobsList.filter(j => j._id !== job._id);
        if (this.currentJobId === job._id) {
          this.currentJobId = null;
          this.isSaved = false;
        }
        this.showToast("Job archived");
        this.loadStats();
      },
      error: () => this.showToast("Archive failed"),
    });
  }

  finaliseJob(): void {
    if (!this.currentJobId) return;
    this.jobSvc.setStatus(this.currentJobId, 'finalised').subscribe({
      next: () => {
        this.showToast("Job finalised ✓");
        this.loadStats();
      },
      error: () => this.showToast("Finalise failed"),
    });
  }

  /* ════════════════════════════════════════
     DRAWER
     ═════════════════════════════════════════ */
  openDrawer(): void {
    this.drawerOpen = true;
    this.fetchJobsList();
  }

  closeDrawer(): void {
    this.drawerOpen = false;
  }

  fetchJobsList(): void {
    this.jobsListLoading = true;
    this.jobSvc.fetchJobs({ q: this.jobSearchQuery || undefined }).subscribe({
      next: (res) => {
        this.jobsList = res.data;
        this.jobsListLoading = false;
      },
      error: () => { this.jobsListLoading = false; },
    });
  }

  onJobSearch(): void {
    this.fetchJobsList();
  }

  loadStats(): void {
    this.jobSvc.getStats().subscribe({
      next: (res) => { this.jobStats = res.data; },
      error: () => {},
    });
  }

  /* ════════════════════════════════════════
     NEW JOB (clear canvas)
     ═════════════════════════════════════════ */
  newJob(): void {
    this.currentJobId = null;
    this.isSaved = false;
    this.rows = [];
    this.jobName = "";
    this.setupCount = 1;
    this.setupUnit = 0;
    this.shipping = 0;
    this.gstRate = 18;
    this.addRow();
    this.drawerOpen = false;
    this.showToast("New job started");
  }

  /* ════════════════════════════════════════
     RESET
     ═════════════════════════════════════════ */
  resetAll(): void {
    this.currentJobId = null;
    this.isSaved = false;
    this.rows = [];
    this.jobName = "";
    this.setupCount = 1;
    this.setupUnit = 0;
    this.shipping = 0;
    this.gstRate = 18;
    this.addRow();
    this.showToast("Calculator reset");
  }

  /* ════════════════════════════════════════
     CSV EXPORT
     ═════════════════════════════════════════ */
  exportCsv(): void {
    const headers = [
      "Product","Qty","Cost/Unit (₹)","Item Cost (₹)","Print/Unit (₹)",
      "Print Total (₹)","Setup (₹)","Shipping (₹)","Expense (₹)",
      "Sell Price (₹)","Revenue (₹)","Profit/Unit (₹)","Total Profit (₹)","Profit %",
    ];
    const dataRows = this.calced.map((r) => [
      `"${r.item}"`, r.qty, r.unitCost.toFixed(2), r.cog.toFixed(2),
      r.decoUnit.toFixed(2), r.decoCost.toFixed(2), r.setup.toFixed(2),
      r.ship.toFixed(2), r.totalCost.toFixed(2), r.quoteUnit.toFixed(2),
      r.quoteCost.toFixed(2), r.marginUnit.toFixed(2), r.totalMargin.toFixed(2),
      `${(r.marginPct * 100).toFixed(1)}%`,
    ].join(","));

    const s = this.summary;
    const name = this.jobName.trim() || "N/A";
    const gstLabel = this.gstRate === 0 ? "No GST" : `${this.gstRate}% GST`;

    const summaryRows = [
      "", `"Client / Job","${name}"`,
      `"Setup Fees","${this.setupCount} screens × ₹${this.setupUnit.toFixed(2)}"`,
      `"Shipping Total","₹${(this.shipping || 0).toFixed(2)}"`,
      `"Subtotal (ex GST)","₹${s.grandTotal.toFixed(2)}"`,
      `"Net Profit","₹${s.profitSubtotal.toFixed(2)}"`,
      `"Total with ${gstLabel}","₹${s.incGst.toFixed(2)}"`,
      `"Overall Profit %","${(s.overallMarginPct * 100).toFixed(1)}%"`,
    ];

    const csv = [headers.join(","), ...dataRows, ...summaryRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `margin-${name.replace(/\s+/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast("CSV exported");
  }

  /* ════════════════════════════════════════
     HELPERS
     ═════════════════════════════════════════ */
  fmt(n: number): string {
    if (!isFinite(n) || isNaN(n)) return "—";
    const abs = n < 0 ? -n : n;
    const formatted = new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(abs);
    return n >= 0 ? `₹${formatted}` : `-₹${formatted}`;
  }

  fmtPct(n: number): string {
    if (!isFinite(n) || isNaN(n)) return "—";
    return `${(n * 100).toFixed(1)}%`;
  }

  fmtCurrency(n: number): string {
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency: "INR", maximumFractionDigits: 0,
    }).format(n || 0);
  }

  health(pct: number): MarginHealth {
    if (!isFinite(pct) || isNaN(pct) || pct < 0.2) return "poor";
    if (pct < 0.35) return "fair";
    if (pct < 0.5)  return "ok";
    return "great";
  }

  healthLabel(pct: number): string {
    return { poor: "Poor", fair: "Fair", ok: "Good", great: "Excellent" }[this.health(pct)];
  }

  gaugeWidth(pct: number): string {
    if (!isFinite(pct) || isNaN(pct)) return "0%";
    return `${Math.min(Math.max(pct * 100, 0), 100).toFixed(1)}%`;
  }

  statusBadgeClass(status: string): string {
    return { draft: 'badge--draft', finalised: 'badge--finalised', archived: 'badge--archived' }[status] || '';
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  }

  get gstAmount(): string {
    const gstAmt = this.summary.grandTotal * (this.gstRate / 100);
    return gstAmt > 0 ? this.fmt(gstAmt) : "₹0.00";
  }

  get jobDisplay(): string { return this.jobName.trim() || "No job loaded"; }
  get hasJobName(): boolean { return this.jobName.trim().length > 0; }

  get saveLabel(): string {
    if (this.isSaving) return "Saving…";
    if (this.isSaved)  return "Saved ✓";
    return this.currentJobId ? "Update" : "Save Job";
  }

  private showToast(msg: string, ms = 2500): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastMessage = msg;
    this.toastVisible = true;
    this.toastTimer = setTimeout(() => { this.toastVisible = false; }, ms);
  }

  private emptyS(): Summary {
    return {
      totalQty: 0, totalCog: 0, totalDecoCost: 0, totalSetup: 0, totalShip: 0,
      totalCost: 0, totalQuote: 0, totalMargin: 0, totalMarginPct: 0,
      subtotal: 0, inclDelivery: 0, setupTotal: 0, grandTotal: 0,
      profitSubtotal: 0, incGst: 0, overallMarginPct: 0,
    };
  }
}
