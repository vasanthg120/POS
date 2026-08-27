import {
  Component,
  signal,
  Output,
  EventEmitter,
  HostListener,
  OnInit,
} from '@angular/core';
import { CommonModule }                                        from '@angular/common';
import { RouterModule, RouterLink, RouterLinkActive }         from '@angular/router';
import { DomSanitizer, SafeHtml }                             from '@angular/platform-browser';
import { Auth, UserRole }                                     from '../services/auth';

interface NavItem {
  label   : string;
  route   : string;
  icon    : string;
  badge?  : string;
  roles   : UserRole[];
  pageKey?: string;   // maps to RBAC pageKey for sub-user filtering
}

// Same as NavItem but with the icon already sanitized for [innerHTML] binding.
interface RenderNavItem extends Omit<NavItem, 'icon'> {
  icon: SafeHtml;
}

const ALL_NAV_ITEMS: NavItem[] = [
  {
    label  : 'Dashboard',
    route  : '',
    roles  : ['superadmin', 'tenant'],
    pageKey: 'dashboard',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5"/>
                <rect x="14" y="3" width="7" height="7" rx="1.5"/>
                <rect x="3" y="14" width="7" height="7" rx="1.5"/>
                <rect x="14" y="14" width="7" height="7" rx="1.5"/>
              </svg>`,
  },
  {
    label  : 'Payment Status',
    route  : '',
    roles  : ['superadmin', 'tenant'],
    pageKey: 'payments',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="5" width="20" height="14" rx="2"/>
                <path d="M2 10h20"/>
                <circle cx="7" cy="15" r="1" fill="currentColor"/>
              </svg>`,
  },
  {
    label  : 'Quotation Status',
    route  : '',
    roles  : ['superadmin', 'tenant'],
    pageKey: 'quotations',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>`,
  },
  {
    label  : 'Tracking',
    route  : '',
    roles  : ['superadmin', 'tenant'],
    pageKey: 'tracking',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
              </svg>`,
  },
  {
    label  : 'Margin Calculator',
    route  : '',
    roles  : ['superadmin', 'tenant'],
    pageKey: 'margin-calculator',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
              </svg>`,
  },
  {
    label  : 'Royalty',
    route  : '',
    roles  : ['superadmin', 'tenant'],
    pageKey: 'royalty',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 6v12M8 9.5c0-1.9 1.8-3.5 4-3.5s4 1.6 4 3.5-1.8 2.8-4 3.5c-2.2.7-4 1.6-4 3.5s1.8 3.5 4 3.5 4-1.6 4-3.5"/>
              </svg>`,
  },
  {
    // Labeled "Subscription" (not "Billing") on purpose — the superadmin's
    // "Billing" admin-section item below shares the ADMIN_LABELS lookup by
    // exact label text, and this one must stay in the tenant's main nav.
    label  : 'Subscription',
    route  : '',
    roles  : ['tenant'],
    pageKey: 'billing',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="5" width="20" height="14" rx="2"/>
                <path d="M2 10h20"/>
                <path d="M6 15h4"/>
              </svg>`,
  },
  // ── Admin section ──────────────────────────────────────────────────────────
  {
    label  : 'Add Tenant',
    route  : '/admin/tenants',
    roles  : ['superadmin'],
    pageKey: 'tenants',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <line x1="19" y1="8" x2="19" y2="14"/>
                <line x1="22" y1="11" x2="16" y2="11"/>
              </svg>`,
  },
  {
    label  : 'Billing',
    route  : '/admin/billing',
    roles  : ['superadmin'],
    pageKey: 'tenants',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="5" width="20" height="14" rx="2"/>
                <path d="M2 10h20"/>
                <path d="M6 15h4"/>
              </svg>`,
  },
  {
    label  : 'Roles & Permissions',
    route  : '',
    roles  : ['superadmin', 'tenant'],
    pageKey: 'rbac',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>`,
  },
  {
    label  : 'Settings',
    route  : '',
    roles  : ['superadmin', 'tenant'],
    pageKey: 'settings',
    icon   : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>`,
  },
];

const ROUTE_SEGMENT: Record<string, string> = {
  'Dashboard'           : 'dashboard',
  'Payment Status'      : 'payments',
  'Quotation Status'    : 'quotations',
  'Tracking'            : 'tracking',
  'Margin Calculator'   : 'margin-calculator',
  'Royalty'             : 'royalty',
  'Subscription'        : 'billing',
  'Roles & Permissions' : 'rbac',
  'Settings'            : 'settings',
};

/**
 * The superadmin's tenantId as stored in MongoDB.
 * Must match the value in auth.ts SUPERADMIN_TENANT_ID.
 */
const SUPERADMIN_TENANT_ID = 'SUPERADMIN';

@Component({
  selector   : 'app-sidebar',
  standalone : true,
  imports    : [CommonModule, RouterModule, RouterLink, RouterLinkActive],
  templateUrl: './sidebar.html',
  styleUrl   : './sidebar.css',
})
export class Sidebar implements OnInit {

  @Output() collapseChange = new EventEmitter<boolean>();

  collapsed  = signal(false);
  mobileOpen = signal(false);

  navItems     : RenderNavItem[] = [];
  userInitials  = '';
  userName      = '';
  userRole      = '';
  isSuperAdmin  = false;

  private readonly ADMIN_LABELS = new Set(['Add Tenant', 'Billing', 'Roles & Permissions', 'Settings']);

  get mainNavItems(): RenderNavItem[] {
    return this.navItems.filter(i => !this.ADMIN_LABELS.has(i.label));
  }

  get adminNavItems(): RenderNavItem[] {
    return this.navItems.filter(i => this.ADMIN_LABELS.has(i.label));
  }

  constructor(private auth: Auth, private sanitizer: DomSanitizer) {}

  ngOnInit(): void {
    const user = this.auth.currentUser();
    const role = user?.role as UserRole | undefined;
    if (!role) return;

    // isSuperAdmin drives the '/admin' route prefix.
    this.isSuperAdmin = role === 'superadmin';
    const prefix      = this.isSuperAdmin ? '/admin' : '';

    // Pages this user is allowed to view
    const allowedPages = this.auth.allowedPages();
    const isSubUser    = user?.isSubUser ?? false;

    // Is this a sub-user whose parent is a tenant (not superadmin)?
    // These users can NEVER see Add Tenant even if permissions say otherwise.
    const isTenantSubUser =
      isSubUser && user?.parentTenantId !== SUPERADMIN_TENANT_ID;

    this.navItems = ALL_NAV_ITEMS
      .filter(item => {
        // ── Step 1: top-level role must match ──────────────────────────────
        if (!item.roles.includes(role)) return false;

        // ── Step 2: hard-block Add Tenant for tenant sub-users ─────────────
        // Belt-and-suspenders on top of allowedPages() which already strips
        // 'tenants' for tenant sub-users. This prevents any edge case where
        // a stale session or legacy permission data could leak the item.
        if (isTenantSubUser && item.pageKey === 'tenants') return false;

        // ── Step 3: all sub-users filtered by their allowedPages set ───────
        // For superadmin sub-users this includes 'tenants' if granted.
        // For tenant sub-users 'tenants' was already deleted in allowedPages().
        if (isSubUser && item.pageKey) {
          return allowedPages.has(item.pageKey);
        }

        return true;
      })
      .map(item => ({
        ...item,
        // Items with a hardcoded route (Add Tenant) keep it;
        // rest resolve dynamically from ROUTE_SEGMENT
        route: item.route || `${prefix}/${ROUTE_SEGMENT[item.label] ?? item.label.toLowerCase()}`,
        // Sanitize the raw SVG so Angular's [innerHTML] doesn't strip it
        icon: this.sanitizer.bypassSecurityTrustHtml(item.icon),
      }));

    // ── User display info ──────────────────────────────────────────────────
    this.userInitials = `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase() || '?';
    this.userName     = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'User';
    this.userRole     = isSubUser
      ? (user?.rbacRoleName ?? 'Team Member')
      : role === 'superadmin'
        ? 'Super Admin'
        : 'Tenant';
  }

  toggleCollapse(): void {
    this.collapsed.update(v => !v);
    this.collapseChange.emit(this.collapsed());
  }

  openMobile()  : void { this.mobileOpen.set(true);  }
  closeMobile() : void { this.mobileOpen.set(false); }
  toggleMobile(): void { this.mobileOpen.update(v => !v); }

  logout(): void { this.auth.logout().subscribe(); }

  @HostListener('window:resize')
  onResize(): void {
    if (window.innerWidth > 768) this.mobileOpen.set(false);
  }
}
