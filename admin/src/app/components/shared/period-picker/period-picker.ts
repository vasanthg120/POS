import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  MONTH_NAMES, PERIOD_PRESETS, PeriodPreset, PeriodState, defaultPeriod, yearOptions,
} from '../period';

/** Preset dropdown ("All time", "This month", …) plus month/year pickers for "Pick a month". */
@Component({
  selector: 'app-period-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pp" [class.pp--compact]="compact">
      <label class="pp-label" *ngIf="!compact">Period</label>
      <div class="pp-controls">
        <div class="pp-select-wrap">
          <svg class="pp-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke-linecap="round" />
          </svg>
          <select class="pp-select" aria-label="Reporting period" [ngModel]="value.preset" (ngModelChange)="setPreset($event)">
            <option *ngFor="let p of presets" [ngValue]="p.value">{{ p.label }}</option>
          </select>
        </div>
        <ng-container *ngIf="value.preset === 'month'">
          <select class="pp-select pp-select--sm" aria-label="Month" [ngModel]="value.month" (ngModelChange)="emit({ month: $event })">
            <option *ngFor="let m of months; let i = index" [ngValue]="i + 1">{{ m }}</option>
          </select>
          <select class="pp-select pp-select--sm" aria-label="Year" [ngModel]="value.year" (ngModelChange)="emit({ year: $event })">
            <option *ngFor="let y of years" [ngValue]="y">{{ y }}</option>
          </select>
        </ng-container>
      </div>
    </div>
  `,
  styles: [`
    .pp { display: flex; flex-direction: column; gap: 6px; }
    .pp-label { font-size: .6875rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--text-muted); }
    .pp-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .pp-select-wrap { position: relative; display: flex; align-items: center; }
    .pp-ico { position: absolute; left: 10px; width: 14px; height: 14px; color: var(--text-muted); pointer-events: none; }
    .pp-select {
      height: 34px; padding: 0 30px 0 12px; border: 1px solid var(--border); border-radius: var(--r-md);
      background: var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 16 16' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat right 10px center;
      appearance: none; font: 500 .8125rem var(--font-body); color: var(--text-primary); cursor: pointer;
      transition: border-color var(--t-fast), box-shadow var(--t-fast);
    }
    .pp-select-wrap .pp-select { padding-left: 32px; min-width: 150px; }
    .pp-select--sm { min-width: 0; }
    .pp-select:hover { border-color: var(--border-2); }
    .pp-select:focus { outline: none; border-color: var(--sky); box-shadow: 0 0 0 3px var(--sky-light); }
  `],
})
export class PeriodPicker {
  @Input() value: PeriodState = defaultPeriod();
  @Input() compact = false;
  @Output() valueChange = new EventEmitter<PeriodState>();

  readonly presets = PERIOD_PRESETS;
  readonly months = MONTH_NAMES;
  readonly years = yearOptions();

  setPreset(preset: PeriodPreset): void { this.emit({ preset }); }

  emit(patch: Partial<PeriodState>): void {
    this.value = { ...this.value, ...patch };
    this.valueChange.emit(this.value);
  }
}
