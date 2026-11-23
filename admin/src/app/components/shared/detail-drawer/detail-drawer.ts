import {
  ChangeDetectionStrategy, Component, EventEmitter, HostListener, Input, Output,
} from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Right-hand slide-over panel used by every "click a card / row → see the
 * details" interaction. Content is projected:
 *   <app-detail-drawer [open]="…" title="…" (closed)="…">
 *     <div drawer-actions>…header buttons…</div>
 *     …body…
 *     <div drawer-footer>…</div>
 *   </app-detail-drawer>
 */
@Component({
  selector: 'app-detail-drawer',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dd-backdrop" [class.open]="open" (click)="close()" aria-hidden="true"></div>
    <aside class="dd" [class.open]="open" [class.dd--wide]="wide" role="dialog" aria-modal="true"
      [attr.aria-hidden]="!open" [attr.aria-label]="title">
      <header class="dd-head">
        <button class="dd-icon-btn" *ngIf="showBack" (click)="back.emit()" title="Back" aria-label="Back">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 3 5 8l5 5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <div class="dd-titles">
          <span class="dd-eyebrow" *ngIf="eyebrow">{{ eyebrow }}</span>
          <h2 class="dd-title">{{ title }}</h2>
          <span class="dd-sub" *ngIf="subtitle">{{ subtitle }}</span>
        </div>
        <div class="dd-actions"><ng-content select="[drawer-actions]"></ng-content></div>
        <button class="dd-icon-btn" (click)="close()" title="Close (Esc)" aria-label="Close">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round" /></svg>
        </button>
      </header>
      <div class="dd-body">
        <ng-content></ng-content>
      </div>
      <footer class="dd-foot"><ng-content select="[drawer-footer]"></ng-content></footer>
    </aside>
  `,
  styles: [`
    :host { position: relative; z-index: 1000; }
    .dd-backdrop {
      position: fixed; inset: 0; background: rgba(15, 23, 42, .38); backdrop-filter: blur(2px);
      opacity: 0; pointer-events: none; transition: opacity var(--t-base); z-index: 1000;
    }
    .dd-backdrop.open { opacity: 1; pointer-events: auto; }
    .dd {
      position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100vw);
      background: var(--surface-2); box-shadow: var(--sh-xl); z-index: 1001;
      display: flex; flex-direction: column; transform: translateX(104%);
      transition: transform var(--t-slow); visibility: hidden;
    }
    .dd.open { transform: translateX(0); visibility: visible; }
    .dd--wide { width: min(760px, 100vw); }
    .dd-head {
      display: flex; align-items: flex-start; gap: 10px; padding: 18px 20px 16px;
      background: var(--surface); border-bottom: 1px solid var(--border);
    }
    .dd-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .dd-eyebrow { font-size: .6875rem; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--sky); }
    .dd-title {
      font: 700 1.125rem/1.3 var(--font-display); color: var(--text-primary); margin: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dd-sub { font-size: .8125rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dd-actions { display: flex; gap: 6px; align-items: center; }
    .dd-actions:empty { display: none; }
    .dd-icon-btn {
      flex-shrink: 0; width: 32px; height: 32px; border-radius: var(--r-md); border: 1px solid var(--border);
      background: var(--surface); color: var(--text-secondary); display: grid; place-items: center; cursor: pointer;
      transition: background var(--t-fast), border-color var(--t-fast);
    }
    .dd-icon-btn svg { width: 14px; height: 14px; }
    .dd-icon-btn:hover { background: var(--surface-3); border-color: var(--border-2); }
    .dd-icon-btn:focus-visible { outline: 2px solid var(--sky); outline-offset: 2px; }
    .dd-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
    .dd-foot { border-top: 1px solid var(--border); background: var(--surface); }
    .dd-foot:empty { display: none; }
    @media (prefers-reduced-motion: reduce) { .dd, .dd-backdrop { transition: none; } }
  `],
})
export class DetailDrawer {
  @Input() open = false;
  @Input() title = '';
  @Input() subtitle = '';
  @Input() eyebrow = '';
  @Input() wide = false;
  @Input() showBack = false;
  @Output() closed = new EventEmitter<void>();
  @Output() back = new EventEmitter<void>();

  @HostListener('document:keydown.escape')
  onEsc(): void { if (this.open) this.close(); }

  close(): void { this.closed.emit(); }
}
