import {
  Component,
  Input,
  Output,
  EventEmitter,
  signal,
  HostListener,
  inject,
  OnInit,
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';

import { Auth } from '../services/auth';

interface Notification {
  icon: string;
  message: string;
  time: string;
  unread: boolean;
}

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
  templateUrl: './header.html',
  styleUrls: ['./header.css'],
})
export class Header implements OnInit {

  /* ----------------------------------------------------------
   * INPUTS / OUTPUTS
   * ---------------------------------------------------------- */

  @Input() sidebarCollapsed = false;

  @Output() menuToggle = new EventEmitter<void>();

  /* ----------------------------------------------------------
   * SIGNALS
   * ---------------------------------------------------------- */

  notifOpen = signal(false);
  profileOpen = signal(false);

  /* ----------------------------------------------------------
   * SERVICES
   * ---------------------------------------------------------- */

  private router = inject(Router);
  private auth = inject(Auth);

  /* ----------------------------------------------------------
   * USER DATA
   * ---------------------------------------------------------- */

  userInitials = 'A';
  userName = 'Admin User';
  userRole = 'Super Admin';
  userEmail = 'admin@company.com';

  /* ----------------------------------------------------------
   * SEARCH
   * ---------------------------------------------------------- */

  searchQuery = '';

  /* ----------------------------------------------------------
   * NOTIFICATIONS
   * ---------------------------------------------------------- */

  notifications: Notification[] = [
    {
      icon: '💳',
      message: 'Payment of ₹12,400 received',
      time: '2 min ago',
      unread: true,
    },
    {
      icon: '📄',
      message: 'New quotation #QT-0042 created',
      time: '1 hr ago',
      unread: true,
    },
    {
      icon: '🚚',
      message: 'Order #ORD-881 dispatched',
      time: '3 hrs ago',
      unread: false,
    },
    {
      icon: '⚠️',
      message: 'Low stock alert: SKU-204 — 3 left',
      time: '5 hrs ago',
      unread: false,
    },
  ];

  /* ----------------------------------------------------------
   * INIT
   * ---------------------------------------------------------- */

  ngOnInit(): void {
    const user = this.auth.currentUser?.();

    if (user) {
      const firstName = user.firstName || '';
      const lastName = user.lastName || '';

      this.userInitials =
        `${firstName[0] || ''}${lastName[0] || ''}`.toUpperCase() || 'A';

      this.userName =
        `${firstName} ${lastName}`.trim() || 'Admin User';

      this.userRole =
        user.role === 'superadmin'
          ? 'Super Admin'
          : 'Tenant User';

      this.userEmail =
        user.email || 'admin@company.com';
    }
  }

  /* ----------------------------------------------------------
   * GETTERS
   * ---------------------------------------------------------- */

  get unreadCount(): number {
    return this.notifications.filter(n => n.unread).length;
  }

  get currentRouteLabel(): string {
    const url = this.router.url.split('?')[0];

    const map: Record<string, string> = {
      '/dashboard': 'Dashboard',
      '/admin/dashboard': 'Dashboard',

      '/payments': 'Payment Status',
      '/admin/payments': 'Payment Status',

      '/quotations': 'Quotation Status',
      '/admin/quotations': 'Quotation Status',

      '/tracking': 'Tracking',
      '/admin/tracking': 'Tracking',

      '/admin/tenants': 'Add Tenant',

      '/margin-calculator': 'Margin Calculator',
      '/admin/margin-calculator': 'Margin Calculator',

      '/settings': 'Settings',
      '/admin/settings': 'Settings',
    };

    return map[url] ?? 'Dashboard';
  }

  /* ----------------------------------------------------------
   * DROPDOWNS
   * ---------------------------------------------------------- */

  toggleNotif(event?: Event): void {
    event?.stopPropagation();

    this.notifOpen.update(v => !v);

    if (this.notifOpen()) {
      this.profileOpen.set(false);
    }
  }

  toggleProfile(event?: Event): void {
    event?.stopPropagation();

    this.profileOpen.update(v => !v);

    if (this.profileOpen()) {
      this.notifOpen.set(false);
    }
  }

  closeDropdowns(): void {
    this.notifOpen.set(false);
    this.profileOpen.set(false);
  }

  /* ----------------------------------------------------------
   * ACTIONS
   * ---------------------------------------------------------- */

  onMenuToggle(): void {
    this.menuToggle.emit();
  }

  navigateTo(route: string): void {
    this.router.navigate([route]);
    this.closeDropdowns();
  }

  markAllRead(): void {
    this.notifications = this.notifications.map(notification => ({
      ...notification,
      unread: false,
    }));
  }

  onSignOut(): void {
    this.closeDropdowns();

    this.auth.logout().subscribe({
      next: () => {
        this.router.navigate(['/login']);
      },
      error: (err: any) => {
        console.error('Logout failed', err);
      },
    });
  }

  /* ----------------------------------------------------------
   * HOST LISTENERS
   * ---------------------------------------------------------- */

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;

    if (!target.closest('.dropdown-anchor')) {
      this.closeDropdowns();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeDropdowns();
  }
}
