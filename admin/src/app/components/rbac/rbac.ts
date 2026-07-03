import {
  Component, OnInit, signal, computed, DestroyRef, inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators, AbstractControl, ValidationErrors } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject } from 'rxjs';
import { MemberService, Member } from '../services/member';

import { RbacService, ApiRole, ApiAuditEntry } from '../services/rbac';
import { Auth } from '../services/auth';

export type PageKey =
  | 'dashboard' | 'payments' | 'quotations' | 'tracking'
  | 'margin-calculator' | 'rbac' | 'settings' | 'tenants';

export type PermissionAction = 'view' | 'create' | 'edit' | 'delete' | 'export';

export interface PagePermission {
  pageKey: PageKey;
  actions: PermissionAction[];
}

export interface Role {
  id: string;
  name: string;
  slug: string;
  description: string;
  color: string;
  isSystem: boolean;
  permissions: PagePermission[];
  memberCount: number;
  createdAt: Date;
}

export interface Page {
  key: PageKey;
  label: string;
  icon: string;
  category: 'core' | 'finance' | 'admin';
  availableActions: PermissionAction[];
}

// ─── Phone validator ──────────────────────────────────────────────────────────
// Matches backend: /^[+]?[\d\s\-()]{7,15}$/
function phoneValidator(control: AbstractControl): ValidationErrors | null {
  const value = control.value;
  if (!value || value.trim() === '') return null; // optional field
  const pattern = /^[+]?[\d\s\-()\u0020]{7,20}$/;
  return pattern.test(value.trim()) ? null : { invalidPhone: true };
}

// ─── Static page metadata ─────────────────────────────────────────────────────

const PAGES: Page[] = [
  {
    key: 'dashboard', label: 'Dashboard', category: 'core',
    availableActions: ['view'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  },
  {
    key: 'payments', label: 'Payment Status', category: 'finance',
    availableActions: ['view', 'create', 'edit', 'delete', 'export'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><circle cx="7" cy="15" r="1" fill="currentColor"/></svg>`,
  },
  {
    key: 'quotations', label: 'Quotation Status', category: 'finance',
    availableActions: ['view', 'create', 'edit', 'delete', 'export'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  },
  {
    key: 'tracking', label: 'Tracking', category: 'core',
    availableActions: ['view', 'edit'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>`,
  },
  {
    key: 'margin-calculator', label: 'Margin Calculator', category: 'finance',
    availableActions: ['view', 'create'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
  },
  {
    key: 'rbac', label: 'RBAC', category: 'admin',
    availableActions: ['view', 'edit'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  },
  {
    key: 'settings', label: 'Settings', category: 'admin',
    availableActions: ['view', 'edit'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  },
  {
    key: 'tenants', label: 'Tenants', category: 'admin',
    availableActions: ['view', 'edit'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  },
];

const ROLE_COLORS = [
  '#1e40af', '#0ea5e9', '#4f46e5', '#059669', '#d97706',
  '#dc2626', '#7c3aed', '#0891b2', '#15803d', '#b45309',
];

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-rbac',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule],
  templateUrl: './rbac.html',
  styleUrl: './rbac.css',
})
export class Rbac implements OnInit {

  private readonly rbacSvc = inject(RbacService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly fb = inject(FormBuilder);
  private readonly memberSvc = inject(MemberService);

  // ── Member state ───────────────────────────────────────────────────────────
  members = signal<Member[]>([]);
  membersLoading = signal(false);
  memberDrawerOpen = signal(false);
  memberDrawerMode = signal<'invite' | 'assign'>('invite');
  memberSaving = signal(false);
  reassignDrawerOpen = signal(false);
  reassignTarget = signal<Member | null>(null);
  reassignRoleId = signal<string | null>(null);
  reassigning = signal(false);
  removeMemberTarget = signal<Member | null>(null);

  inviteForm!: FormGroup;
  assignForm!: FormGroup;

  readonly pages = PAGES;
  readonly actionLabels: Record<PermissionAction, string> = {
    view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', export: 'Export',
  };
  readonly categoryLabels: Record<string, string> = {
    core: 'Core', finance: 'Finance', admin: 'Administration',
  };
  readonly roleColors = ROLE_COLORS;
  readonly ACTIONS: PermissionAction[] = ['view', 'create', 'edit', 'delete', 'export'];

  // ── Role state ─────────────────────────────────────────────────────────────
  roles = signal<Role[]>([]);
  selectedRoleId = signal<string | null>(null);
  drawerOpen = signal(false);
  drawerMode = signal<'create' | 'edit'>('create');
  deleteConfirmId = signal<string | null>(null);
  activeTab = signal<'permissions' | 'members' | 'audit'>('permissions');
  searchQuery = signal('');
  toast = signal<{ type: 'success' | 'error'; message: string } | null>(null);

  loading = signal(true);
  saving = signal(false);
  auditLoading = signal(false);
  auditLogs = signal<ApiAuditEntry[]>([]);

  form!: FormGroup;
  draftPermissions = signal<Map<PageKey, Set<PermissionAction>>>(new Map());

  private searchSubject = new Subject<string>();

  // ── Computed ───────────────────────────────────────────────────────────────
  filteredRoles = computed(() => {
    const q = this.searchQuery().toLowerCase();
    return !q
      ? this.roles()
      : this.roles().filter(r =>
        r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
      );
  });

  selectedRole = computed(() =>
    this.roles().find(r => r.id === this.selectedRoleId()) ?? null
  );

  totalMembers = computed(() =>
    this.roles().reduce((s, r) => s + r.memberCount, 0)
  );

  pagesByCategory = computed(() => {
    const map = new Map<string, Page[]>();
    for (const p of PAGES) {
      if (!map.has(p.category)) map.set(p.category, []);
      map.get(p.category)!.push(p);
    }
    return map;
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this._initForms();
    this._loadRoles();
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  private _loadRoles(): void {
    this.loading.set(true);
    this.rbacSvc.getRoles()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => {
          const mapped = data.map(this._mapApiRole);
          this.roles.set(mapped);
          if (!this.selectedRoleId() && mapped.length > 0) {
            this.selectedRoleId.set(mapped[0].id);
          }
          this.loading.set(false);
        },
        error: (err) => {
          this._showToast('error', err?.error?.message ?? 'Failed to load roles.');
          this.loading.set(false);
        },
      });
  }

  private _mapApiRole = (r: ApiRole): Role => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    color: r.color,
    isSystem: r.isSystem,
    permissions: r.permissions,
    memberCount: r.memberCount,
    createdAt: new Date(r.createdAt),
  });

  // ── Selection ──────────────────────────────────────────────────────────────

  selectRole(id: string): void {
    this.selectedRoleId.set(id);
    this.activeTab.set('permissions');
    this.auditLogs.set([]);
    this.members.set([]);
  }

  onTabChange(tab: 'permissions' | 'members' | 'audit'): void {
    this.activeTab.set(tab);
    if (tab === 'audit' && this.selectedRoleId()) this._loadAuditLog(this.selectedRoleId()!);
    if (tab === 'members' && this.selectedRoleId()) this._loadMembers(this.selectedRoleId()!);
  }

  private _loadAuditLog(roleId: string): void {
    this.auditLoading.set(true);
    this.rbacSvc.getAuditLog(roleId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => { this.auditLogs.set(data); this.auditLoading.set(false); },
        error: () => { this.auditLoading.set(false); },
      });
  }

  // ── Drawer ─────────────────────────────────────────────────────────────────

  openCreateDrawer(): void {
    this.drawerMode.set('create');
    this._initRoleForm();
    this.draftPermissions.set(new Map());
    this.drawerOpen.set(true);
  }

  openEditDrawer(role: Role): void {
    this.drawerMode.set('edit');
    this.form.patchValue({ name: role.name, description: role.description, color: role.color });
    const map = new Map<PageKey, Set<PermissionAction>>();
    for (const p of role.permissions) map.set(p.pageKey, new Set(p.actions));
    this.draftPermissions.set(map);
    this.drawerOpen.set(true);
  }

  closeDrawer(): void { this.drawerOpen.set(false); }

  // ── Permission helpers ─────────────────────────────────────────────────────

  hasPermission(pageKey: PageKey, action: PermissionAction): boolean {
    return this.draftPermissions().get(pageKey)?.has(action) ?? false;
  }

  togglePermission(pageKey: PageKey, action: PermissionAction): void {
    const map = new Map(this.draftPermissions());
    if (!map.has(pageKey)) map.set(pageKey, new Set());
    const actions = new Set(map.get(pageKey)!);
    if (actions.has(action)) {
      if (action === 'view' && actions.size > 1) return; // view is required when others exist
      actions.delete(action);
      if (actions.size === 0) map.delete(pageKey); else map.set(pageKey, actions);
    } else {
      if (action !== 'view') actions.add('view'); // auto-add view
      actions.add(action);
      map.set(pageKey, actions);
    }
    this.draftPermissions.set(map);
  }

  toggleAllOnPage(pageKey: PageKey, page: Page): void {
    const map = new Map(this.draftPermissions());
    const existing = map.get(pageKey);
    if (existing && existing.size === page.availableActions.length) map.delete(pageKey);
    else map.set(pageKey, new Set(page.availableActions));
    this.draftPermissions.set(map);
  }

  isPageFullAccess(pageKey: PageKey, page: Page): boolean {
    const s = this.draftPermissions().get(pageKey);
    return !!s && s.size === page.availableActions.length;
  }

  isPagePartialAccess(pageKey: PageKey): boolean {
    const s = this.draftPermissions().get(pageKey);
    return !!s && s.size > 0;
  }

  getPermissionCount(): number {
    let total = 0;
    for (const set of this.draftPermissions().values()) total += set.size;
    return total;
  }

  roleHasAction(role: Role, pageKey: PageKey, action: PermissionAction): boolean {
    return role.permissions.find(p => p.pageKey === pageKey)?.actions.includes(action) ?? false;
  }

  getRolePermissionSummary(role: Role): string {
    const count = role.permissions.reduce((s, p) => s + p.actions.length, 0);
    return `${role.permissions.length} pages · ${count} actions`;
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  saveRole(): void {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    if (this.saving()) return;

    const { name, description, color } = this.form.value;
    const permissions: PagePermission[] = [];
    for (const [pageKey, actions] of this.draftPermissions()) {
      if (actions.size) permissions.push({ pageKey, actions: Array.from(actions) as PermissionAction[] });
    }

    const payload = { name, description, color, permissions };
    this.saving.set(true);

    const op$ = this.drawerMode() === 'create'
      ? this.rbacSvc.createRole(payload)
      : this.rbacSvc.updateRole(this.selectedRoleId()!, payload);

    op$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (saved) => {
        const mapped = this._mapApiRole(saved);
        if (this.drawerMode() === 'create') {
          this.roles.update(r => [...r, mapped]);
          this.selectedRoleId.set(mapped.id);
          this._showToast('success', `Role "${mapped.name}" created.`);
        } else {
          this.roles.update(r => r.map(x => x.id === mapped.id ? mapped : x));
          this._showToast('success', `Role "${mapped.name}" updated.`);
        }
        this.saving.set(false);
        this.closeDrawer();
      },
      error: (err) => {
        this._showToast('error', err?.error?.message ?? 'Save failed. Please try again.');
        this.saving.set(false);
      },
    });
  }

  confirmDelete(id: string): void { this.deleteConfirmId.set(id); }
  cancelDelete(): void { this.deleteConfirmId.set(null); }

  deleteRole(): void {
    const id = this.deleteConfirmId();
    if (!id) return;
    const name = this.roles().find(r => r.id === id)?.name;

    this.rbacSvc.deleteRole(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.roles.update(r => r.filter(x => x.id !== id));
          if (this.selectedRoleId() === id) {
            this.selectedRoleId.set(this.roles()[0]?.id ?? null);
          }
          this.deleteConfirmId.set(null);
          this._showToast('success', `Role "${name}" deleted.`);
        },
        error: (err) => {
          this.deleteConfirmId.set(null);
          this._showToast('error', err?.error?.message ?? 'Delete failed.');
        },
      });
  }

  duplicateRole(role: Role): void {
    this.rbacSvc.duplicateRole(role.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (copy) => {
          const mapped = this._mapApiRole(copy);
          this.roles.update(r => [...r, mapped]);
          this.selectedRoleId.set(mapped.id);
          this._showToast('success', `Role duplicated as "${mapped.name}".`);
        },
        error: (err) => this._showToast('error', err?.error?.message ?? 'Duplicate failed.'),
      });
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  categoryEntries(): Array<[string, Page[]]> {
    return Array.from(this.pagesByCategory().entries());
  }

  formatAuditTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    return `${days} day${days !== 1 ? 's' : ''} ago`;
  }

  formatActionLabel(action: string): string {
    return action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  trackById(_: number, item: { id: string }) { return item.id; }
  trackByKey(_: number, item: Page) { return item.key; }

  private _initForms(): void {
    this._initRoleForm();
    this._initMemberForms();
  }

  private _initRoleForm(): void {
    this.form = this.fb.group({
      name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(40)]],
      description: ['', [Validators.maxLength(200)]],
      color: [ROLE_COLORS[0]],
    });
  }

  private _initMemberForms(): void {
    this.inviteForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
      firstName: ['', [Validators.maxLength(50)]],
      lastName: ['', [Validators.maxLength(50)]],
      // Optional phone: validated against backend pattern if provided
      phone: ['', [phoneValidator]],
    });

    this.assignForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
    });
  }

  private _showToast(type: 'success' | 'error', message: string): void {
    this.toast.set({ type, message });
    setTimeout(() => this.toast.set(null), 3500);
  }

  // ── Members ────────────────────────────────────────────────────────────────

  private _loadMembers(roleId: string): void {
    this.membersLoading.set(true);
    this.memberSvc.listMembers(roleId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => { this.members.set(data); this.membersLoading.set(false); },
        error: () => { this.membersLoading.set(false); },
      });
  }

  openInvitePanel(mode: 'invite' | 'assign'): void {
    this.memberDrawerMode.set(mode);
    this._initMemberForms(); // always reset forms fresh
    this.memberDrawerOpen.set(true);
  }

  closeMemberDrawer(): void { this.memberDrawerOpen.set(false); }

  sendInvite(): void {
    if (this.inviteForm.invalid) { this.inviteForm.markAllAsTouched(); return; }
    if (this.memberSaving()) return;
    this.memberSaving.set(true);

    const { email, firstName, lastName, phone } = this.inviteForm.value;
    // Only send phone if non-empty
    const payload: any = { email, firstName, lastName, roleId: this.selectedRoleId()! };
    if (phone?.trim()) payload.phone = phone.trim();

    this.memberSvc.invite(payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (m) => {
          this.members.update(list => [m, ...list]);
          // Increment local memberCount on the role
          this.roles.update(roles => roles.map(r =>
            r.id === this.selectedRoleId() ? { ...r, memberCount: r.memberCount + 1 } : r
          ));
          this.memberSaving.set(false);
          this.closeMemberDrawer();
          this._showToast('success', `Invite sent to ${m.email}.`);
        },
        error: (err) => {
          this._showToast('error', err?.error?.message ?? 'Invite failed.');
          this.memberSaving.set(false);
        },
      });
  }

  sendAssign(): void {
    if (this.assignForm.invalid) { this.assignForm.markAllAsTouched(); return; }
    if (this.memberSaving()) return;
    this.memberSaving.set(true);

    const { email } = this.assignForm.value;
    this.memberSvc.assign({ email, roleId: this.selectedRoleId()! })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (m) => {
          this.members.update(list => [m, ...list]);
          // Increment local memberCount on the role
          this.roles.update(roles => roles.map(r =>
            r.id === this.selectedRoleId() ? { ...r, memberCount: r.memberCount + 1 } : r
          ));
          this.memberSaving.set(false);
          this.closeMemberDrawer();
          this._showToast('success', `${m.email} added to team.`);
        },
        error: (err) => {
          this._showToast('error', err?.error?.message ?? 'Assign failed.');
          this.memberSaving.set(false);
        },
      });
  }

  resendInvite(m: Member): void {
    this.memberSvc.resendInvite(m.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this._showToast('success', `Invite resent to ${m.email}.`),
        error: (err) => this._showToast('error', err?.error?.message ?? 'Resend failed.'),
      });
  }

  setMemberStatus(m: Member, status: 'active' | 'suspended'): void {
    this.memberSvc.setStatus(m.id, status)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.members.update(list => list.map(x => x.id === updated.id ? updated : x));
          this._showToast('success', `${m.email} ${status === 'suspended' ? 'suspended' : 'reactivated'}.`);
        },
        error: (err) => this._showToast('error', err?.error?.message ?? 'Update failed.'),
      });
  }

  openReassignDrawer(m: Member): void {
    this.reassignTarget.set(m);
    this.reassignRoleId.set(m.rbacRoleId);
    this.reassignDrawerOpen.set(true);
  }
  closeReassignDrawer(): void { this.reassignDrawerOpen.set(false); }

  confirmReassign(): void {
    const target = this.reassignTarget();
    const roleId = this.reassignRoleId();
    if (!target || !roleId || this.reassigning()) return;

    // Prevent reassigning to the same role
    if (target.rbacRoleId === roleId) {
      this.closeReassignDrawer();
      return;
    }

    this.reassigning.set(true);
    this.memberSvc.reassignRole(target.id, roleId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.members.update(list => list.map(x => x.id === updated.id ? updated : x));
          // Update memberCounts on both old and new role
          this.roles.update(roles => roles.map(r => {
            if (r.id === target.rbacRoleId) return { ...r, memberCount: Math.max(0, r.memberCount - 1) };
            if (r.id === roleId) return { ...r, memberCount: r.memberCount + 1 };
            return r;
          }));
          this.reassigning.set(false);
          this.closeReassignDrawer();
          this._showToast('success', `Role updated for ${updated.email}.`);
        },
        error: (err) => {
          this._showToast('error', err?.error?.message ?? 'Reassign failed.');
          this.reassigning.set(false);
        },
      });
  }

  confirmRemoveMember(m: Member): void { this.removeMemberTarget.set(m); }
  cancelRemoveMember(): void { this.removeMemberTarget.set(null); }

  doRemoveMember(): void {
    const m = this.removeMemberTarget();
    if (!m) return;
    this.memberSvc.remove(m.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.members.update(list => list.filter(x => x.id !== m.id));
          // Decrement local memberCount
          this.roles.update(roles => roles.map(r =>
            r.id === this.selectedRoleId() ? { ...r, memberCount: Math.max(0, r.memberCount - 1) } : r
          ));
          this.removeMemberTarget.set(null);
          this._showToast('success', `${m.email} removed.`);
        },
        error: (err) => {
          this.removeMemberTarget.set(null);
          this._showToast('error', err?.error?.message ?? 'Remove failed.');
        },
      });
  }

  // ── Avatar helpers ─────────────────────────────────────────────────────────
  private readonly AVATAR_PALETTE = [
    '#0ea5e9', '#4f46e5', '#059669', '#d97706', '#dc2626', '#7c3aed',
  ];

  memberInitials(m: Member): string {
    const f = m.firstName?.[0] ?? '';
    const l = m.lastName?.[0] ?? '';
    return (f + l).toUpperCase() || m.email[0].toUpperCase();
  }
  memberAvatarBg(m: Member): string {
    return this.AVATAR_PALETTE[m.email.charCodeAt(0) % this.AVATAR_PALETTE.length] + '18';
  }
  memberAvatarColor(m: Member): string {
    return this.AVATAR_PALETTE[m.email.charCodeAt(0) % this.AVATAR_PALETTE.length];
  }

  // Add to constructor/inject:
  private readonly auth = inject(Auth);

  // Add computed:
  availablePages = computed(() => {
    const user = this.auth.currentUser();
    // Superadmin managing their own RBAC roles can grant 'tenants' access
    if (!user || user.role === 'superadmin') return PAGES;
    // Tenant managing roles: strip 'tenants' page from the matrix
    return PAGES.filter(p => p.key !== 'tenants');
  });
}

