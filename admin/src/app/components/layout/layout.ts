import {
  Component,
  signal,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, RouterOutlet } from '@angular/router';
import { Sidebar } from '../sidebar/sidebar';
import { Header } from '../header/header';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterOutlet, Sidebar, Header],
  templateUrl: './layout.html',
  styleUrl: './layout.css',
})
export class Layout {

  @ViewChild('sidebarRef') sidebarRef!: Sidebar;

  /** Mirrors the sidebar's collapsed state so the header offset stays in sync */
  sidebarCollapsed = signal(false);

  onCollapseChange(collapsed: boolean): void {
    this.sidebarCollapsed.set(collapsed);
  }
}
