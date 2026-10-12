import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import {
  Account,
  Attachment,
  Budget,
  Bill,
  RecurringTransaction,
  FinancePlanInput,
  Activity,
  ALL_WIDGETS,
  CalendarEvent,
  Capture,
  Goal,
  Member,
  Note,
  Notification,
  ReminderPreferences,
  DEFAULT_REMINDERS,
  Subscription,
  Contact,
  ContactLink,
  Loan,
  LoanRepayment,
  OwnedRecord,
  Profile,
  Project,
  Task,
  Transaction,
  Workspace,
  WorkspaceKind,
} from '../models/domain';
import { demoData } from './demo';
import {
  accountBalance,
  csv,
  localDate,
  parseMoney,
  recurrenceDate,
} from '../../shared/utilities/finance';
@Injectable({ providedIn: 'root' })
export class LifeStore {
  readonly auth = inject(AuthService);
  private readonly backend = inject(Backend);
  readonly profile = signal<Profile | null>(null);
  readonly workspaces = signal<Workspace[]>([]);
  readonly workspace = signal<Workspace | null>(null);
  readonly members = signal<Member[]>([]);
  readonly tasks = signal<Task[]>([]);
  readonly projects = signal<Project[]>([]);
  readonly events = signal<CalendarEvent[]>([]);
  readonly notes = signal<Note[]>([]);
  readonly goals = signal<Goal[]>([]);
  readonly accounts = signal<Account[]>([]);
  readonly transactions = signal<Transaction[]>([]);
  readonly budgets = signal<Budget[]>([]);
  readonly bills = signal<Bill[]>([]);
  readonly recurring = signal<RecurringTransaction[]>([]);
  readonly contacts = signal<Contact[]>([]);
  readonly contactLinks = signal<ContactLink[]>([]);
  readonly loans = signal<Loan[]>([]);
  readonly loanRepayments = signal<LoanRepayment[]>([]);
  readonly subscriptions = signal<Subscription[]>([]);
  readonly attachments = signal<Attachment[]>([]);
  readonly fileSession = signal(0);
  readonly activity = signal<Activity[]>([]);
  readonly notifications = signal<Notification[]>([]);
  readonly reminderPreferences = signal<ReminderPreferences>({ ...DEFAULT_REMINDERS });
  readonly widgets = signal(ALL_WIDGETS);
  readonly loading = signal(false);
  readonly error = signal('');
  private generation = 0;
  private readonly demoCache = new Map<string, ReturnType<typeof demoData>>();
  readonly currency = computed(() => this.profile()?.currency ?? 'INR');
  readonly name = computed(() => this.profile()?.display_name || 'there');
  readonly pending = computed(() => this.tasks().filter((t) => t.status !== 'done'));
  readonly monthlyEntries = computed(() =>
    this.transactions().filter(
      (t) =>
        t.booked_on.startsWith(localDate().slice(0, 7)) &&
        this.accounts().some((a) => a.id === t.account_id && a.currency === this.currency()),
    ),
  );
  readonly income = computed(
    () =>
      this.monthlyEntries()
        .filter((t) => t.kind === 'income')
        .reduce((sum, t) => sum + Math.round(Number(t.amount) * 100), 0) / 100,
  );
  readonly expenses = computed(
    () =>
      this.monthlyEntries()
        .filter((t) => t.kind === 'expense')
        .reduce((sum, t) => sum + Math.round(Number(t.amount) * 100), 0) / 100,
  );
  readonly balance = computed(
    () =>
      this.accounts()
        .filter((a) => a.currency === this.currency())
        .reduce((sum, a) => sum + Math.round(accountBalance(a, this.transactions()) * 100), 0) /
      100,
  );
  readonly writable = computed(
    () =>
      this.auth.demo() ||
      this.members().some((m) => m.user_id === this.auth.user()?.id && m.role !== 'viewer'),
  );
  readonly owner = computed(
    () => this.auth.demo() || this.workspace()?.owner_id === this.auth.user()?.id,
  );
  canEdit(row: OwnedRecord) {
    return (
      this.writable() &&
      (row.owner_id === (this.auth.demo() ? 'demo-user' : this.auth.user()?.id) ||
        (row.visibility === 'workspace' && this.owner()))
    );
  }
  async initialize() {
    this.clear();
    if (this.auth.demo()) {
      this.seedDemo();
      return;
    }
    this.loading.set(true);
    const run = this.generation;
    try {
      const client = this.backend.requireClient();
      const [p, w, s] = await Promise.all([
        client.from('profiles').select('*').single(),
        client.from('workspaces').select('*').order('created_at'),
        client.from('app_settings').select('*').maybeSingle(),
      ]);
      if (p.error) throw p.error;
      if (w.error) throw w.error;
      if (s.error) throw s.error;
      if (run !== this.generation) return;
      this.profile.set(p.data);
      this.workspaces.set(w.data);
      this.widgets.set(s.data?.dashboard_widgets ?? ALL_WIDGETS);
      if (s.data) this.reminderPreferences.set(s.data);
      if (w.data[0]) await this.switchWorkspace(w.data[0]);
    } catch (e) {
      this.error.set(this.message(e));
    } finally {
      this.loading.set(false);
    }
  }
  private seedDemo() {
    const d = demoData();
    this.profile.set({
      id: 'demo-user',
      display_name: 'Alex',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    });
    const w: Workspace = {
      id: 'demo',
      name: 'Personal workspace',
      kind: 'personal',
      owner_id: 'demo-user',
    };
    this.workspaces.set([w]);
    this.workspace.set(w);
    this.members.set([{ workspace_id: 'demo', user_id: 'demo-user', role: 'owner' }]);
    this.tasks.set(d.tasks);
    this.projects.set(d.projects);
    this.events.set(d.events);
    this.notes.set(d.notes);
    this.goals.set(d.goals);
    this.accounts.set(d.accounts);
    this.transactions.set(d.transactions);
    this.budgets.set(d.budgets);
    this.bills.set(d.bills);
    this.recurring.set(d.recurring);
    this.subscriptions.set(d.subscriptions);
    this.loans.set(d.loans);
    this.contacts.set(d.contacts);
    this.contactLinks.set(d.contactLinks);
    this.loanRepayments.set(d.loanRepayments);
    this.attachments.set(d.attachments);
    this.activity.set(d.activity);
    this.notifications.set(d.notifications);
  }
  private clearRecords() {
    this.tasks.set([]);
    this.projects.set([]);
    this.events.set([]);
    this.notes.set([]);
    this.goals.set([]);
    this.accounts.set([]);
    this.transactions.set([]);
    this.budgets.set([]);
    this.bills.set([]);
    this.recurring.set([]);
    this.subscriptions.set([]);
    this.loans.set([]);
    this.contacts.set([]);
    this.contactLinks.set([]);
    this.loanRepayments.set([]);
    this.attachments.set([]);
    this.activity.set([]);
    this.members.set([]);
    this.notifications.set([]);
  }
  clear() {
    this.fileSession.update((value) => value + 1);
    this.generation++;
    this.demoCache.clear();
    this.clearRecords();
    this.workspace.set(null);
    this.workspaces.set([]);
    this.profile.set(null);
    this.error.set('');
    this.widgets.set(ALL_WIDGETS);
    this.reminderPreferences.set({ ...DEFAULT_REMINDERS });
  }
  async switchWorkspace(w: Workspace) {
    const run = ++this.generation;
    if (this.auth.demo() && this.workspace())
      this.demoCache.set(this.workspace()!.id, {
        tasks: this.tasks(),
        projects: this.projects(),
        events: this.events(),
        notes: this.notes(),
        goals: this.goals(),
        accounts: this.accounts(),
        transactions: this.transactions(),
        budgets: this.budgets(),
        bills: this.bills(),
        recurring: this.recurring(),
        subscriptions: this.subscriptions(),
        loans: this.loans(),
        contacts: this.contacts(),
        contactLinks: this.contactLinks(),
        loanRepayments: this.loanRepayments(),
        attachments: this.attachments(),
        activity: this.activity(),
        notifications: this.notifications(),
      });
    this.clearRecords();
    this.workspace.set(w);
    this.loading.set(true);
    this.error.set('');
    if (this.auth.demo()) {
      const d = this.demoCache.get(w.id);
      if (d) {
        this.tasks.set(d.tasks);
        this.projects.set(d.projects);
        this.events.set(d.events);
        this.notes.set(d.notes);
        this.goals.set(d.goals);
        this.accounts.set(d.accounts);
        this.transactions.set(d.transactions);
        this.budgets.set(d.budgets);
        this.bills.set(d.bills);
        this.recurring.set(d.recurring);
        this.subscriptions.set(d.subscriptions);
        this.loans.set(d.loans);
        this.contacts.set(d.contacts);
        this.contactLinks.set(d.contactLinks);
        this.loanRepayments.set(d.loanRepayments);
        this.attachments.set(d.attachments);
        this.activity.set(d.activity);
        this.notifications.set(d.notifications);
      }
      this.members.set([{ workspace_id: w.id, user_id: 'demo-user', role: 'owner' }]);
      this.loading.set(false);
      return;
    }
    try {
      const c = this.backend.requireClient();
      const [
        t,
        p,
        e,
        n,
        g,
        a,
        x,
        l,
        m,
        notifications,
        budgets,
        bills,
        recurring,
        attachments,
        subscriptions,
      ] = await Promise.all([
        c
          .from('tasks')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at', { ascending: false })
          .limit(500),
        c
          .from('projects')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at', { ascending: false })
          .limit(500),
        c
          .from('calendar_events')
          .select('*')
          .eq('workspace_id', w.id)
          .order('starts_at', { ascending: false })
          .limit(500),
        c
          .from('notes')
          .select('*')
          .eq('workspace_id', w.id)
          .order('updated_at', { ascending: false })
          .limit(500),
        c
          .from('goals')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at', { ascending: false })
          .limit(500),
        c
          .from('accounts')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at')
          .order('id')
          .range(0, 499),
        c
          .from('transactions')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at')
          .order('id')
          .range(0, 499),
        c
          .from('activity_logs')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at', { ascending: false })
          .limit(30),
        c.from('workspace_members').select('*').eq('workspace_id', w.id),
        c
          .from('notifications')
          .select('*')
          .eq('workspace_id', w.id)
          .is('dismissed_at', null)
          .order('created_at', { ascending: false })
          .limit(100),
        c
          .from('budgets')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at')
          .order('id')
          .range(0, 499),
        c
          .from('bills')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at', { ascending: false })
          .limit(500),
        c
          .from('recurring_transactions')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at', { ascending: false })
          .limit(500),
        c
          .from('attachments')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at', { ascending: false })
          .limit(500),
        c
          .from('subscriptions')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at')
          .order('id')
          .range(0, 499),
      ]);
      for (const result of [
        t,
        p,
        e,
        n,
        g,
        a,
        x,
        l,
        m,
        notifications,
        budgets,
        bills,
        recurring,
        attachments,
        subscriptions,
      ])
        if (result.error) throw result.error;
      // Finance needs the complete visible ledger; page rather than silently truncating balances.
      const ledger = [...(x.data ?? [])];
      const subscriptionRows = [...(subscriptions.data ?? [])];
      for (let offset = 500; subscriptions.data?.length === 500; offset += 500) {
        const page = await c
          .from('subscriptions')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at')
          .order('id')
          .range(offset, offset + 499);
        if (page.error) throw page.error;
        subscriptionRows.push(...page.data);
        if (page.data.length < 500) break;
      }
      for (let offset = 500; x.data?.length === 500; offset += 500) {
        const page = await c
          .from('transactions')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at')
          .order('id')
          .range(offset, offset + 499);
        if (page.error) throw page.error;
        ledger.push(...page.data);
        if (page.data.length < 500) break;
      }
      const accountRows = [...(a.data ?? [])],
        budgetRows = [...(budgets.data ?? [])];
      for (const table of ['accounts', 'budgets'] as const) {
        const first = table === 'accounts' ? a : budgets;
        if (first.data?.length === 500)
          for (let offset = 500; ; offset += 500) {
            const page = await c
              .from(table)
              .select('*')
              .eq('workspace_id', w.id)
              .order('created_at')
              .order('id')
              .range(offset, offset + 499);
            if (page.error) throw page.error;
            if (table === 'accounts') accountRows.push(...(page.data as Account[]));
            else budgetRows.push(...(page.data as Budget[]));
            if (page.data.length < 500) break;
          }
      }
      const allLoans: Loan[] = [],
        allPayments: LoanRepayment[] = [];
      for (const table of ['loans', 'loan_repayments'] as const) {
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (table === 'loans') allLoans.push(...(page.data as Loan[]));
          else allPayments.push(...(page.data as LoanRepayment[]));
          if (page.data.length < 500) break;
        }
      }
      const allContacts: Contact[] = [],
        allContactLinks: ContactLink[] = [];
      for (const table of ['contacts', 'contact_links'] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (table === 'contacts') allContacts.push(...(page.data as Contact[]));
          else allContactLinks.push(...(page.data as ContactLink[]));
          if (page.data.length < 500) break;
        }
      if (run !== this.generation) return;
      this.contacts.set(allContacts);
      this.contactLinks.set(allContactLinks);
      this.loans.set(allLoans);
      this.loanRepayments.set(allPayments);
      this.tasks.set(t.data ?? []);
      this.projects.set(p.data ?? []);
      this.events.set(e.data ?? []);
      this.notes.set(n.data ?? []);
      this.goals.set(g.data ?? []);
      this.accounts.set(accountRows);
      this.transactions.set(ledger);
      this.budgets.set(budgetRows);
      this.bills.set(bills.data ?? []);
      this.recurring.set(recurring.data ?? []);
      this.subscriptions.set(subscriptionRows);
      this.attachments.set(attachments.data ?? []);
      this.activity.set(l.data ?? []);
      this.members.set(m.data ?? []);
      this.notifications.set(notifications.data ?? []);
    } catch (e) {
      if (run === this.generation) this.error.set(this.message(e));
    } finally {
      if (run === this.generation) this.loading.set(false);
    }
  }
  async createWorkspace(name: string, kind: WorkspaceKind) {
    if (!name.trim()) throw new Error('Enter a workspace name.');
    let w: Workspace;
    if (this.auth.demo())
      w = { id: crypto.randomUUID(), name: name.trim(), kind, owner_id: 'demo-user' };
    else {
      const { data, error } = await this.backend
        .requireClient()
        .rpc('create_workspace', { workspace_name: name.trim(), workspace_type: kind });
      if (error) throw error;
      w = { id: data, name: name.trim(), kind, owner_id: this.auth.user()!.id };
    }
    this.workspaces.update((list) => [...list, w]);
    await this.switchWorkspace(w);
  }
  async saveProfile(name: string, currency: string) {
    const p = this.profile();
    if (!p) return;
    if (!this.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .from('profiles')
        .update({ display_name: name, currency })
        .eq('id', p.id);
      if (error) throw error;
    }
    this.profile.set({ ...p, display_name: name, currency });
  }
  async saveWidgets(widgets: string[]) {
    if (!this.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .from('app_settings')
        .upsert({ id: this.auth.user()!.id, dashboard_widgets: widgets }, { onConflict: 'id' });
      if (error) throw error;
    }
    this.widgets.set(widgets);
  }
  async setMember(id: string, role: 'editor' | 'viewer') {
    if (this.auth.demo())
      throw new Error('Membership changes require a connected Supabase account.');
    const { error } = await this.backend
      .requireClient()
      .rpc('set_workspace_member', { w: this.workspace()!.id, member_id: id, member_access: role });
    if (error) throw error;
    await this.switchWorkspace(this.workspace()!);
  }
  async removeMember(id: string) {
    const { error } = await this.backend
      .requireClient()
      .rpc('remove_workspace_member', { w: this.workspace()!.id, member_id: id });
    if (error) throw error;
    await this.switchWorkspace(this.workspace()!);
  }
  async toggleTask(task: Task) {
    if (!this.canEdit(task)) throw new Error('You cannot edit this task.');
    const status = task.status === 'done' ? 'todo' : 'done';
    if (!this.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .from('tasks')
        .update({ status })
        .eq('id', task.id);
      if (error) throw error;
    }
    this.tasks.update((list) => list.map((t) => (t.id === task.id ? { ...t, status } : t)));
    this.log(`${status === 'done' ? 'Completed' : 'Reopened'} “${task.title}”`);
  }
  async setTaskStatus(task: Task, status: Task['status']) {
    if (!this.canEdit(task)) throw new Error('You cannot edit this task.');
    if (!this.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .from('tasks')
        .update({ status })
        .eq('id', task.id);
      if (error) throw error;
    }
    this.tasks.update((list) => list.map((t) => (t.id === task.id ? { ...t, status } : t)));
  }
  async updateGoal(goal: Goal, value: string) {
    if (!this.canEdit(goal) || !/^\d+(\.\d{1,2})?$/.test(value))
      throw new Error('Enter a valid non-negative progress value.');
    const current = Number(value);
    if (!this.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .from('goals')
        .update({ current })
        .eq('id', goal.id);
      if (error) throw error;
    }
    this.goals.update((list) => list.map((g) => (g.id === goal.id ? { ...g, current } : g)));
  }
  async deleteNote(note: Note) {
    if (!this.canEdit(note)) throw new Error('You cannot delete this note.');
    if (!this.auth.demo()) {
      const { error } = await this.backend.requireClient().from('notes').delete().eq('id', note.id);
      if (error) throw error;
    }
    this.notes.update((list) => list.filter((n) => n.id !== note.id));
  }
  private base(): OwnedRecord {
    if (!this.workspace() || !this.writable())
      throw new Error('Select a workspace with edit permission.');
    return {
      id: crypto.randomUUID(),
      workspace_id: this.workspace()!.id,
      owner_id: this.auth.demo() ? 'demo-user' : this.auth.user()!.id,
      visibility: 'private',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
  async add(input: Capture) {
    const title = input.title.trim();
    if (!title || title.length > 200) throw new Error('Enter a title of 1–200 characters.');
    const b = { ...this.base(), visibility: input.visibility };
    const c = this.backend.client;
    const check = (error: { message: string } | null) => {
      if (error) throw new Error(error.message);
    };
    switch (input.kind) {
      case 'task': {
        const row: Task = {
          ...b,
          title,
          status: 'todo',
          priority: input.priority,
          due_date: input.date || null,
          project_id: input.project_id || null,
        };
        if (!this.auth.demo()) check((await c!.from('tasks').insert(row)).error);
        this.tasks.update((v) => [row, ...v]);
        break;
      }
      case 'project': {
        const row: Project = {
          ...b,
          title,
          description: input.body,
          status: 'active',
          color: 'purple',
          due_date: input.date || null,
        };
        if (!this.auth.demo()) check((await c!.from('projects').insert(row)).error);
        this.projects.update((v) => [row, ...v]);
        break;
      }
      case 'note': {
        const row: Note = { ...b, title, body: input.body, project_id: input.project_id || null };
        if (!this.auth.demo()) check((await c!.from('notes').insert(row)).error);
        this.notes.update((v) => [row, ...v]);
        break;
      }
      case 'goal': {
        const row: Goal = {
          ...b,
          title,
          target: parseMoney(input.amount),
          current: 0,
          unit: input.category,
          due_date: input.date || null,
          color: 'purple',
        };
        if (!this.auth.demo()) check((await c!.from('goals').insert(row)).error);
        this.goals.update((v) => [row, ...v]);
        break;
      }
      case 'event': {
        if (!input.date || !input.time || !input.end_time)
          throw new Error('Choose a date, start time and end time.');
        const starts_at = new Date(`${input.date}T${input.time}`).toISOString();
        const ends_at = new Date(`${input.date}T${input.end_time}`).toISOString();
        if (ends_at <= starts_at) throw new Error('End time must be later than start time.');
        const row: CalendarEvent = {
          ...b,
          title,
          starts_at,
          ends_at,
          location: input.body,
          project_id: input.project_id || null,
          color: 'purple',
        };
        if (!this.auth.demo()) check((await c!.from('calendar_events').insert(row)).error);
        this.events.update((v) =>
          [...v, row].sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
        );
        break;
      }
      case 'account': {
        const row: Account = {
          ...b,
          name: title,
          currency: this.currency(),
          opening_balance: input.amount ? parseMoney(input.amount) : 0,
        };
        if (!this.auth.demo()) check((await c!.from('accounts').insert(row)).error);
        this.accounts.update((v) => [...v, row]);
        break;
      }
      case 'income':
      case 'expense': {
        const account = this.accounts().find(
          (a) => a.id === input.account_id && a.owner_id === b.owner_id,
        );
        if (!account) throw new Error('Choose an account you own.');
        const row: Transaction = {
          ...b,
          visibility: 'private',
          title,
          account_id: account.id,
          amount: parseMoney(input.amount),
          kind: input.kind,
          category: input.category,
          booked_on: input.date || localDate(),
          transfer_id: null,
          project_id: null,
        };
        if (!this.auth.demo()) {
          const { data, error } = await c!.rpc('record_transaction', {
            w: b.workspace_id,
            account: account.id,
            transaction_title: title,
            transaction_amount: row.amount,
            transaction_kind: row.kind,
            transaction_category: row.category,
            transaction_date: row.booked_on,
          });
          check(error);
          row.id = data!;
        }
        this.transactions.update((v) => [...v, row]);
        break;
      }
    }
    this.log(`Added ${input.kind} · ${title}`);
  }
  async transfer(source: string, destination: string, amount: string, requestId: string) {
    const value = parseMoney(amount);
    if (source === destination) throw new Error('Choose two different accounts.');
    const owned = this.accounts().filter(
      (a) => a.owner_id === (this.auth.demo() ? 'demo-user' : this.auth.user()?.id),
    );
    const a = owned.find((a) => a.id === source),
      b = owned.find((a) => a.id === destination);
    if (!a || !b || a.currency !== b.currency)
      throw new Error('Choose accounts you own with matching currencies.');
    if (!this.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('transfer_funds', {
        w: this.workspace()!.id,
        source_account: source,
        destination_account: destination,
        transfer_amount: value,
        request_id: requestId,
      });
      if (error) throw error;
      await this.switchWorkspace(this.workspace()!);
    } else if (!this.transactions().some((t) => t.transfer_id === requestId)) {
      const base = this.base();
      this.transactions.update((v) => [
        ...v,
        {
          ...base,
          id: crypto.randomUUID(),
          title: 'Account transfer',
          account_id: source,
          amount: value,
          kind: 'transfer_out',
          category: 'Transfer',
          booked_on: localDate(),
          transfer_id: requestId,
          project_id: null,
        },
        {
          ...base,
          id: crypto.randomUUID(),
          title: 'Account transfer',
          account_id: destination,
          amount: value,
          kind: 'transfer_in',
          category: 'Transfer',
          booked_on: localDate(),
          transfer_id: requestId,
          project_id: null,
        },
      ]);
    }
  }
  async saveBudget(category: string, month: string, currency: string, amount: string) {
    const base = this.base();
    if (
      !category.trim() ||
      category.trim().length > 100 ||
      !/^\d{4}-\d{2}$/.test(month) ||
      !validFinanceDate(month + '-01') ||
      !/^[A-Z]{3}$/.test(currency)
    )
      throw new Error('Choose a valid month, category and three-letter currency.');
    const value = parseMoney(amount);
    const existing = this.budgets().find(
      (b) => b.category === category.trim() && b.month === month + '-01' && b.currency === currency,
    );
    const row: Budget = {
      ...base,
      id: existing?.id ?? base.id,
      category: category.trim(),
      month: month + '-01',
      currency,
      amount: value,
    };
    if (!this.auth.demo()) {
      const c = this.backend.requireClient();
      const result = existing
        ? await c.from('budgets').update({ amount: value }).eq('id', existing.id)
        : await c.from('budgets').insert(row);
      if (result.error) throw result.error;
    }
    this.budgets.update((list) => [row, ...list.filter((b) => b.id !== row.id)]);
  }
  async deleteBudget(budget: Budget) {
    if (!this.canEdit(budget)) throw new Error('You cannot change this budget.');
    if (!this.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .from('budgets')
        .delete()
        .eq('id', budget.id);
      if (error) throw error;
    }
    this.budgets.update((list) => list.filter((b) => b.id !== budget.id));
  }
  async createFinancePlan(type: 'bill' | 'recurring', input: FinancePlanInput) {
    const base = this.base();
    const account = this.accounts().find(
      (a) => a.id === input.account_id && a.owner_id === base.owner_id,
    );
    if (
      !account ||
      !input.title.trim() ||
      input.title.trim().length > 200 ||
      !validFinanceDate(input.date) ||
      !input.category.trim() ||
      input.category.trim().length > 100
    )
      throw new Error('Enter a title, valid date, category and an account you own.');
    const common = {
      ...base,
      title: input.title.trim(),
      account_id: account.id,
      amount: parseMoney(input.amount),
      category: input.category.trim(),
    };
    if (type === 'bill') {
      const row: Bill = {
        ...common,
        due_on: input.date,
        status: 'pending',
        paid_on: null,
        transaction_id: null,
      };
      if (!this.auth.demo()) {
        const { error } = await this.backend.requireClient().from('bills').insert(row);
        if (error) throw error;
      }
      this.bills.update((list) => [row, ...list]);
    } else {
      if (
        !['daily', 'weekly', 'monthly', 'yearly'].includes(input.frequency) ||
        !['income', 'expense'].includes(input.kind)
      )
        throw new Error('Choose a valid frequency and transaction type.');
      const row: RecurringTransaction = {
        ...common,
        start_on: input.date,
        next_on: input.date,
        occurrence_count: 0,
        frequency: input.frequency,
        kind: input.kind,
        active: true,
        automatic: input.automatic,
      };
      if (!this.auth.demo()) {
        const { error } = await this.backend
          .requireClient()
          .from('recurring_transactions')
          .insert(row);
        if (error) throw error;
      }
      this.recurring.update((list) => [row, ...list]);
    }
  }
  async settleBill(bill: Bill) {
    if (!this.canEdit(bill)) throw new Error('You cannot change this bill.');
    if (!this.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('settle_bill', { bill: bill.id });
      if (error) throw error;
      await this.switchWorkspace(this.workspace()!);
      if (this.error()) throw new Error(this.error());
    } else {
      const current = this.bills().find((b) => b.id === bill.id);
      if (!current || current.status === 'cancelled')
        throw new Error('Cancelled bills cannot be paid.');
      if (current.status === 'paid') return;
      const id = crypto.randomUUID();
      this.transactions.update((list) => [
        ...list,
        {
          ...this.base(),
          id,
          title: current.title,
          account_id: current.account_id,
          amount: current.amount,
          kind: 'expense',
          category: current.category,
          booked_on: localDate(),
          transfer_id: null,
          project_id: null,
          bill_id: current.id,
        },
      ]);
      this.bills.update((list) =>
        list.map((b) =>
          b.id === current.id
            ? { ...b, status: 'paid', paid_on: localDate(), transaction_id: id }
            : b,
        ),
      );
    }
  }
  async cancelBill(bill: Bill) {
    if (!this.canEdit(bill)) throw new Error('You cannot change this bill.');
    if (!this.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('cancel_bill', { bill: bill.id });
      if (error) throw error;
    } else if (this.bills().find((b) => b.id === bill.id)?.status === 'paid')
      throw new Error('Paid bills cannot be cancelled.');
    this.bills.update((list) =>
      list.map((b) => (b.id === bill.id ? { ...b, status: 'cancelled' } : b)),
    );
  }
  async setRecurringActive(plan: RecurringTransaction) {
    if (!this.canEdit(plan)) throw new Error('You cannot change this schedule.');
    const active = !plan.active;
    if (
      active &&
      this.subscriptions().some((s) => s.recurring_id === plan.id && s.status !== 'active')
    )
      throw new Error('Trial or cancelled subscriptions cannot resume expense recording.');
    if (!this.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .from('recurring_transactions')
        .update({ active })
        .eq('id', plan.id);
      if (error) throw error;
    }
    this.recurring.update((list) => list.map((r) => (r.id === plan.id ? { ...r, active } : r)));
  }
  async postRecurring(plan: RecurringTransaction) {
    if (!this.canEdit(plan)) throw new Error('You cannot change this schedule.');
    if (!this.auth.demo()) {
      const { data, error } = await this.backend
        .requireClient()
        .rpc('post_recurring_due', { plan: plan.id });
      if (error) throw error;
      await this.switchWorkspace(this.workspace()!);
      if (this.error()) throw new Error(this.error());
      return data;
    }
    const current = this.recurring().find((r) => r.id === plan.id);
    if (!current?.active) return 0;
    if (this.subscriptions().some((s) => s.recurring_id === current.id && s.status !== 'active'))
      return 0;
    let count = current.occurrence_count;
    let next = current.next_on;
    let posted = 0;
    const entries: Transaction[] = [];
    while (next <= localDate() && posted < 100) {
      entries.push({
        ...this.base(),
        title: current.title,
        account_id: current.account_id,
        amount: current.amount,
        kind: current.kind,
        category: current.category,
        booked_on: next,
        transfer_id: null,
        project_id: null,
        subscription_id:
          this.subscriptions().find((s) => s.recurring_id === current.id)?.id ?? null,
        recurring_id: current.id,
        occurrence_on: next,
      });
      next = recurrenceDate(current.start_on, current.frequency, ++count);
      posted++;
    }
    this.transactions.update((list) => [...list, ...entries]);
    this.recurring.update((list) =>
      list.map((r) => (r.id === current.id ? { ...r, next_on: next, occurrence_count: count } : r)),
    );
    this.subscriptions.update((rows) =>
      rows.map((s) =>
        s.recurring_id === current.id
          ? { ...s, next_on: next, renewal_count: count, updated_at: new Date().toISOString() }
          : s,
      ),
    );
    return posted;
  }
  private log(title: string) {
    this.activity.update((v) => [{ ...this.base(), title }, ...v].slice(0, 30));
  }
  money(value: number) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: this.currency(),
      maximumFractionDigits: 0,
    }).format(value);
  }
  progress(goal: Goal) {
    return Math.min(100, Math.round((Number(goal.current) / Number(goal.target)) * 100));
  }
  projectProgress(project: Project) {
    const tasks = this.tasks().filter((t) => t.project_id === project.id);
    return tasks.length
      ? Math.round((tasks.filter((t) => t.status === 'done').length / tasks.length) * 100)
      : 0;
  }
  projectTitle(id: string | null) {
    return this.projects().find((p) => p.id === id)?.title ?? 'Personal';
  }
  download(format: 'json' | 'csv') {
    const records = {
      workspace: this.workspace(),
      tasks: this.tasks(),
      projects: this.projects(),
      events: this.events(),
      notes: this.notes(),
      goals: this.goals(),
      accounts: this.accounts(),
      transactions: this.transactions(),
      budgets: this.budgets(),
      bills: this.bills(),
      recurring: this.recurring(),
      subscriptions: this.subscriptions(),
      loans: this.loans(),
      contacts: this.contacts(),
      contactLinks: this.contactLinks(),
      loanRepayments: this.loanRepayments(),
      attachments: this.attachments(),
    };
    const text =
      format === 'json'
        ? JSON.stringify(records, null, 2)
        : csv(
            this.transactions().map((t) => ({
              date: t.booked_on,
              title: t.title,
              kind: t.kind,
              amount: t.amount,
              currency: this.accounts().find((a) => a.id === t.account_id)?.currency,
              category: t.category,
              account: this.accounts().find((a) => a.id === t.account_id)?.name,
            })),
          );
    const url = URL.createObjectURL(
      new Blob([text], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-${localDate()}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  message(error: unknown) {
    return error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : 'Something went wrong. Please try again.';
  }
}
function validFinanceDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
  );
}
