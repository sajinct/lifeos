import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import {
  Account,
  CreditCard,
  CardStatement,
  CardPayment,
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
  HouseholdMember,
  Habit,
  HabitPeriod,
  HabitCheckin,
  GoalMilestone,
  TravelPlan,
  TravelEntry,
  TravelBudget,
  TravelExpense,
  HealthLog,
  MedicationPlan,
  HealthExpense,
  HealthAppointment,
  HealthDocument,
  CareerRecord,
  CareerDocument,
  Asset,
  AssetDocument,
  MaintenancePlan,
  MaintenanceLog,
  HouseholdEntry,
  Loan,
  LoanRepayment,
  OwnedRecord,
  Profile,
  Project,
  ProjectMilestone,
  ProjectBudget,
  Task,
  TaskList,
  TaskTime,
  TaskMember,
  TaskSeries,
  TaskChecklist,
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
  readonly taskTimes = signal<TaskTime[]>([]);
  readonly taskMembers = signal<TaskMember[]>([]);
  readonly taskLists = signal<TaskList[]>([]);
  readonly taskSeries = signal<TaskSeries[]>([]);
  readonly taskChecklist = signal<TaskChecklist[]>([]);
  readonly tasks = signal<Task[]>([]);
  readonly projectMilestones = signal<ProjectMilestone[]>([]);
  readonly projectBudgets = signal<ProjectBudget[]>([]);
  readonly projects = signal<Project[]>([]);
  readonly events = signal<CalendarEvent[]>([]);
  readonly notes = signal<Note[]>([]);
  readonly goals = signal<Goal[]>([]);
  readonly creditCards = signal<CreditCard[]>([]);
  readonly cardStatements = signal<CardStatement[]>([]);
  readonly cardPayments = signal<CardPayment[]>([]);
  readonly accounts = signal<Account[]>([]);
  readonly transactions = signal<Transaction[]>([]);
  readonly budgets = signal<Budget[]>([]);
  readonly bills = signal<Bill[]>([]);
  readonly recurring = signal<RecurringTransaction[]>([]);
  readonly householdMembers = signal<HouseholdMember[]>([]);
  readonly householdEntries = signal<HouseholdEntry[]>([]);
  readonly habits = signal<Habit[]>([]);
  readonly habitPeriods = signal<HabitPeriod[]>([]);
  readonly habitCheckins = signal<HabitCheckin[]>([]);
  readonly goalMilestones = signal<GoalMilestone[]>([]);
  readonly travelPlans = signal<TravelPlan[]>([]);
  readonly travelEntries = signal<TravelEntry[]>([]);
  readonly travelBudgets = signal<TravelBudget[]>([]);
  readonly travelExpenses = signal<TravelExpense[]>([]);
  readonly healthLogs = signal<HealthLog[]>([]);
  readonly medicationPlans = signal<MedicationPlan[]>([]);
  readonly healthExpenses = signal<HealthExpense[]>([]);
  readonly healthAppointments = signal<HealthAppointment[]>([]);
  readonly healthDocuments = signal<HealthDocument[]>([]);
  readonly careerRecords = signal<CareerRecord[]>([]);
  readonly careerDocuments = signal<CareerDocument[]>([]);
  readonly assets = signal<Asset[]>([]);
  readonly assetDocuments = signal<AssetDocument[]>([]);
  readonly maintenancePlans = signal<MaintenancePlan[]>([]);
  readonly maintenanceLogs = signal<MaintenanceLog[]>([]);
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
    this.creditCards.set(d.creditCards);
    this.cardStatements.set(d.cardStatements);
    this.cardPayments.set(d.cardPayments);
    this.accounts.set(d.accounts);
    this.transactions.set(d.transactions);
    this.budgets.set(d.budgets);
    this.bills.set(d.bills);
    this.recurring.set(d.recurring);
    this.subscriptions.set(d.subscriptions);
    this.loans.set(d.loans);
    this.householdMembers.set(d.householdMembers);
    this.householdEntries.set(d.householdEntries);
    this.habits.set(d.habits);
    this.habitPeriods.set(d.habitPeriods);
    this.habitCheckins.set(d.habitCheckins);
    this.projectMilestones.set(d.projectMilestones);
    this.projectBudgets.set(d.projectBudgets);
    this.taskTimes.set(d.taskTimes);
    this.taskMembers.set([
      { user_id: this.profile()!.id, display_name: this.profile()!.display_name, role: 'owner' },
    ]);
    this.taskLists.set(d.taskLists);
    this.taskSeries.set(d.taskSeries);
    this.taskChecklist.set(d.taskChecklist);
    this.goalMilestones.set(d.goalMilestones);
    this.travelPlans.set(d.travelPlans);
    this.travelEntries.set(d.travelEntries);
    this.travelBudgets.set(d.travelBudgets);
    this.travelExpenses.set(d.travelExpenses);
    this.healthLogs.set(d.healthLogs);
    this.medicationPlans.set(d.medicationPlans);
    this.healthExpenses.set(d.healthExpenses);
    this.healthAppointments.set(d.healthAppointments);
    this.healthDocuments.set(d.healthDocuments);
    this.careerRecords.set(d.careerRecords);
    this.careerDocuments.set(d.careerDocuments);
    this.assets.set(d.assets);
    this.assetDocuments.set(d.assetDocuments);
    this.maintenancePlans.set(d.maintenancePlans);
    this.maintenanceLogs.set(d.maintenanceLogs);
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
    this.creditCards.set([]);
    this.cardStatements.set([]);
    this.cardPayments.set([]);
    this.accounts.set([]);
    this.transactions.set([]);
    this.budgets.set([]);
    this.bills.set([]);
    this.recurring.set([]);
    this.subscriptions.set([]);
    this.loans.set([]);
    this.householdMembers.set([]);
    this.householdEntries.set([]);
    this.habits.set([]);
    this.habitPeriods.set([]);
    this.habitCheckins.set([]);
    this.projectMilestones.set([]);
    this.projectBudgets.set([]);
    this.taskTimes.set([]);
    this.taskMembers.set([]);
    this.taskLists.set([]);
    this.taskSeries.set([]);
    this.taskChecklist.set([]);
    this.goalMilestones.set([]);
    this.travelPlans.set([]);
    this.travelEntries.set([]);
    this.travelBudgets.set([]);
    this.travelExpenses.set([]);
    this.healthLogs.set([]);
    this.medicationPlans.set([]);
    this.healthExpenses.set([]);
    this.healthAppointments.set([]);
    this.healthDocuments.set([]);
    this.careerRecords.set([]);
    this.careerDocuments.set([]);
    this.assets.set([]);
    this.assetDocuments.set([]);
    this.maintenancePlans.set([]);
    this.maintenanceLogs.set([]);
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
        creditCards: this.creditCards(),
        cardStatements: this.cardStatements(),
        cardPayments: this.cardPayments(),
        accounts: this.accounts(),
        transactions: this.transactions(),
        budgets: this.budgets(),
        bills: this.bills(),
        recurring: this.recurring(),
        subscriptions: this.subscriptions(),
        loans: this.loans(),
        householdMembers: this.householdMembers(),
        householdEntries: this.householdEntries(),
        habits: this.habits(),
        habitPeriods: this.habitPeriods(),
        habitCheckins: this.habitCheckins(),
        projectMilestones: this.projectMilestones(),
        projectBudgets: this.projectBudgets(),
        taskTimes: this.taskTimes(),
        taskLists: this.taskLists(),
        taskSeries: this.taskSeries(),
        taskChecklist: this.taskChecklist(),
        goalMilestones: this.goalMilestones(),
        travelPlans: this.travelPlans(),
        travelEntries: this.travelEntries(),
        travelBudgets: this.travelBudgets(),
        travelExpenses: this.travelExpenses(),
        healthLogs: this.healthLogs(),
        medicationPlans: this.medicationPlans(),
        healthExpenses: this.healthExpenses(),
        healthAppointments: this.healthAppointments(),
        healthDocuments: this.healthDocuments(),
        careerRecords: this.careerRecords(),
        careerDocuments: this.careerDocuments(),
        assets: this.assets(),
        assetDocuments: this.assetDocuments(),
        maintenancePlans: this.maintenancePlans(),
        maintenanceLogs: this.maintenanceLogs(),
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
        this.creditCards.set(d.creditCards);
        this.cardStatements.set(d.cardStatements);
        this.cardPayments.set(d.cardPayments);
        this.accounts.set(d.accounts);
        this.transactions.set(d.transactions);
        this.budgets.set(d.budgets);
        this.bills.set(d.bills);
        this.recurring.set(d.recurring);
        this.subscriptions.set(d.subscriptions);
        this.loans.set(d.loans);
        this.householdMembers.set(d.householdMembers);
        this.householdEntries.set(d.householdEntries);
        this.habits.set(d.habits);
        this.habitPeriods.set(d.habitPeriods);
        this.habitCheckins.set(d.habitCheckins);
        this.projectMilestones.set(d.projectMilestones);
        this.projectBudgets.set(d.projectBudgets);
        this.taskTimes.set(d.taskTimes);
        this.taskMembers.set([
          {
            user_id: this.profile()!.id,
            display_name: this.profile()!.display_name,
            role: 'owner',
          },
        ]);
        this.taskLists.set(d.taskLists);
        this.taskSeries.set(d.taskSeries);
        this.taskChecklist.set(d.taskChecklist);
        this.goalMilestones.set(d.goalMilestones);
        this.travelPlans.set(d.travelPlans);
        this.travelEntries.set(d.travelEntries);
        this.travelBudgets.set(d.travelBudgets);
        this.travelExpenses.set(d.travelExpenses);
        this.healthLogs.set(d.healthLogs);
        this.medicationPlans.set(d.medicationPlans);
        this.healthExpenses.set(d.healthExpenses);
        this.healthAppointments.set(d.healthAppointments);
        this.healthDocuments.set(d.healthDocuments);
        this.careerRecords.set(d.careerRecords);
        this.careerDocuments.set(d.careerDocuments);
        this.assets.set(d.assets);
        this.assetDocuments.set(d.assetDocuments);
        this.maintenancePlans.set(d.maintenancePlans);
        this.maintenanceLogs.set(d.maintenanceLogs);
        this.contacts.set(d.contacts);
        this.contactLinks.set(d.contactLinks);
        this.loanRepayments.set(d.loanRepayments);
        this.attachments.set(d.attachments);
        this.activity.set(d.activity);
        this.notifications.set(d.notifications);
      }
      this.taskMembers.set([
        {
          user_id: 'demo-user',
          display_name: this.profile()?.display_name ?? 'Alex',
          role: 'owner',
        },
      ]);
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
          .order('id')
          .range(0, 499),
        c
          .from('projects')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at', { ascending: false })
          .order('id')
          .range(0, 499),
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
          .order('id')
          .range(0, 499),
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
      const allMembers: HouseholdMember[] = [],
        allEntries: HouseholdEntry[] = [];
      for (const table of ['household_members', 'household_entries'] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          if (table === 'household_members') allMembers.push(...(page.data as HouseholdMember[]));
          else allEntries.push(...(page.data as HouseholdEntry[]));
          if (page.data.length < 500) break;
        }
      const habitRows: Habit[] = [],
        periodRows: HabitPeriod[] = [],
        checkinRows: HabitCheckin[] = [],
        milestoneRows: GoalMilestone[] = [];
      for (const table of ['habits', 'habit_periods', 'habit_checkins', 'goal_milestones'] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          if (table === 'habits') habitRows.push(...(page.data as Habit[]));
          else if (table === 'habit_periods') periodRows.push(...(page.data as HabitPeriod[]));
          else if (table === 'habit_checkins') checkinRows.push(...(page.data as HabitCheckin[]));
          else milestoneRows.push(...(page.data as GoalMilestone[]));
          if (page.data.length < 500) break;
        }
      const taskRows = [...(t.data ?? [])];
      if (taskRows.length === 500)
        for (let offset = 500; ; offset += 500) {
          const page = await c
            .from('tasks')
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at', { ascending: false })
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          taskRows.push(...page.data);
          if (page.data.length < 500) break;
        }
      const timeRows: TaskTime[] = [],
        directory: TaskMember[] = [];
      for (let offset = 0; ; offset += 500) {
        const page = await c
          .from('task_time_entries')
          .select('*')
          .eq('workspace_id', w.id)
          .order('created_at')
          .order('id')
          .range(offset, offset + 499);
        if (page.error) throw page.error;
        if (run !== this.generation) return;
        timeRows.push(...page.data);
        if (page.data.length < 500) break;
      }
      for (let offset = 0; ; offset += 500) {
        const page = await c.rpc('workspace_task_members', { w: w.id }).range(offset, offset + 499);
        if (page.error) throw page.error;
        if (run !== this.generation) return;
        directory.push(...page.data);
        if (page.data.length < 500) break;
      }
      if (run !== this.generation) return;
      this.taskTimes.set(timeRows);
      this.taskMembers.set(directory);
      const projectRows = [...(p.data ?? [])];
      if (projectRows.length === 500)
        for (let offset = 500; ; offset += 500) {
          const page = await c
            .from('projects')
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at', { ascending: false })
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          projectRows.push(...page.data);
          if (page.data.length < 500) break;
        }
      const projectMilestoneRows: ProjectMilestone[] = [],
        projectBudgetRows: ProjectBudget[] = [];
      for (const table of ['project_milestones', 'project_budgets'] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          if (table === 'project_milestones')
            projectMilestoneRows.push(...(page.data as ProjectMilestone[]));
          else projectBudgetRows.push(...(page.data as ProjectBudget[]));
          if (page.data.length < 500) break;
        }
      if (run !== this.generation) return;
      this.projectMilestones.set(projectMilestoneRows);
      this.projectBudgets.set(projectBudgetRows);
      const taskLists: TaskList[] = [],
        taskSeries: TaskSeries[] = [],
        taskChecklist: TaskChecklist[] = [];
      for (const table of ['task_lists', 'task_series', 'task_checklist'] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          if (table === 'task_lists') taskLists.push(...(page.data as TaskList[]));
          else if (table === 'task_series') taskSeries.push(...(page.data as TaskSeries[]));
          else taskChecklist.push(...(page.data as TaskChecklist[]));
          if (page.data.length < 500) break;
        }
      if (run !== this.generation) return;
      this.taskLists.set(taskLists);
      this.taskSeries.set(taskSeries);
      this.taskChecklist.set(taskChecklist);
      const goalRows = [...(g.data ?? [])];
      if (goalRows.length === 500)
        for (let offset = 500; ; offset += 500) {
          const page = await c
            .from('goals')
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at', { ascending: false })
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          goalRows.push(...page.data);
          if (page.data.length < 500) break;
        }
      if (run !== this.generation) return;
      this.habits.set(habitRows);
      this.habitPeriods.set(periodRows);
      this.habitCheckins.set(checkinRows);
      this.goalMilestones.set(milestoneRows);
      const creditCards: CreditCard[] = [],
        cardStatements: CardStatement[] = [],
        cardPayments: CardPayment[] = [];
      for (const table of ['credit_cards', 'card_statements', 'card_payments'] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          if (table === 'credit_cards') creditCards.push(...(page.data as CreditCard[]));
          else if (table === 'card_statements')
            cardStatements.push(...(page.data as CardStatement[]));
          else cardPayments.push(...(page.data as CardPayment[]));
          if (page.data.length < 500) break;
        }
      if (run !== this.generation) return;
      this.creditCards.set(creditCards);
      this.cardStatements.set(cardStatements);
      this.cardPayments.set(cardPayments);
      const travelPlans: TravelPlan[] = [],
        travelEntries: TravelEntry[] = [],
        travelBudgets: TravelBudget[] = [],
        travelExpenses: TravelExpense[] = [];
      for (const table of [
        'travel_plans',
        'travel_entries',
        'travel_budgets',
        'travel_expenses',
      ] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          if (table === 'travel_plans') travelPlans.push(...(page.data as TravelPlan[]));
          else if (table === 'travel_entries') travelEntries.push(...(page.data as TravelEntry[]));
          else if (table === 'travel_budgets') travelBudgets.push(...(page.data as TravelBudget[]));
          else travelExpenses.push(...(page.data as TravelExpense[]));
          if (page.data.length < 500) break;
        }
      if (run !== this.generation) return;
      this.travelPlans.set(travelPlans);
      this.travelEntries.set(travelEntries);
      this.travelBudgets.set(travelBudgets);
      this.travelExpenses.set(travelExpenses);
      const healthLogs: HealthLog[] = [],
        medicationPlans: MedicationPlan[] = [],
        healthExpenses: HealthExpense[] = [];
      for (const table of ['health_logs', 'medication_plans', 'health_expenses'] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          if (table === 'health_logs') healthLogs.push(...(page.data as HealthLog[]));
          else if (table === 'medication_plans')
            medicationPlans.push(...(page.data as MedicationPlan[]));
          else healthExpenses.push(...(page.data as HealthExpense[]));
          if (page.data.length < 500) break;
        }
      if (run !== this.generation) return;
      this.healthLogs.set(healthLogs);
      this.medicationPlans.set(medicationPlans);
      this.healthExpenses.set(healthExpenses);
      const healthAppointments: HealthAppointment[] = [],
        healthDocuments: HealthDocument[] = [];
      for (const table of ['health_appointments', 'health_documents'] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          if (table === 'health_appointments')
            healthAppointments.push(...(page.data as HealthAppointment[]));
          else healthDocuments.push(...(page.data as HealthDocument[]));
          if (page.data.length < 500) break;
        }
      if (run !== this.generation) return;
      this.healthAppointments.set(healthAppointments);
      this.healthDocuments.set(healthDocuments);
      const careerRecords: CareerRecord[] = [],
        careerDocuments: CareerDocument[] = [];
      for (const table of ['career_records', 'career_documents'] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          if (table === 'career_records') careerRecords.push(...(page.data as CareerRecord[]));
          else careerDocuments.push(...(page.data as CareerDocument[]));
          if (page.data.length < 500) break;
        }
      if (run !== this.generation) return;
      this.careerRecords.set(careerRecords);
      this.careerDocuments.set(careerDocuments);
      const allAssets: Asset[] = [],
        allAssetDocuments: AssetDocument[] = [],
        allMaintenance: MaintenancePlan[] = [],
        allServices: MaintenanceLog[] = [];
      for (const table of [
        'assets',
        'asset_documents',
        'maintenance_plans',
        'maintenance_logs',
      ] as const)
        for (let offset = 0; ; offset += 500) {
          const page = await c
            .from(table)
            .select('*')
            .eq('workspace_id', w.id)
            .order('created_at')
            .order('id')
            .range(offset, offset + 499);
          if (page.error) throw page.error;
          if (run !== this.generation) return;
          if (table === 'assets') allAssets.push(...(page.data as Asset[]));
          else if (table === 'asset_documents')
            allAssetDocuments.push(...(page.data as AssetDocument[]));
          else if (table === 'maintenance_plans')
            allMaintenance.push(...(page.data as MaintenancePlan[]));
          else allServices.push(...(page.data as MaintenanceLog[]));
          if (page.data.length < 500) break;
        }
      if (run !== this.generation) return;
      this.assets.set(allAssets);
      this.assetDocuments.set(allAssetDocuments);
      this.maintenancePlans.set(allMaintenance);
      this.maintenanceLogs.set(allServices);
      this.householdMembers.set(allMembers);
      this.householdEntries.set(allEntries);
      this.contacts.set(allContacts);
      this.contactLinks.set(allContactLinks);
      this.loans.set(allLoans);
      this.loanRepayments.set(allPayments);
      this.tasks.set(taskRows);
      this.projects.set(projectRows);
      this.events.set(e.data ?? []);
      this.notes.set(n.data ?? []);
      this.goals.set(goalRows);
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
    await this.setTaskStatus(task, task.status === 'done' ? 'todo' : 'done');
  }
  async setTaskStatus(task: Task, status: Task['status']) {
    if (
      task.workspace_id !== this.workspace()?.id ||
      !this.canEdit(task) ||
      !['todo', 'in_progress', 'done'].includes(status)
    )
      throw new Error('You cannot edit this task.');
    const generation = this.generation,
      session = this.fileSession();
    if (!this.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_task_status', {
        entry: task.id,
        expected_revision: task.revision,
        target: status,
      });
      if (error) throw error;
      if (generation !== this.generation || session !== this.fileSession()) return;
      await this.switchWorkspace(this.workspace()!);
      if (this.error()) throw new Error(this.error());
      return;
    }
    const current = this.tasks().find((t) => t.id === task.id);
    if (!current) throw new Error('Task is inaccessible.');
    if (current.status !== status && current.revision !== task.revision)
      throw new Error('Task changed; refresh and try again.');
    const row =
      current.status === status ? current : { ...current, status, revision: current.revision + 1 };
    this.tasks.update((rows) => rows.map((t) => (t.id === row.id ? row : t)));
    this.generateNextTask(row);
  }
  generateNextTask(task: Task) {
    if (
      !this.auth.demo() ||
      task.status !== 'done' ||
      !task.series_id ||
      task.occurrence_index === null
    )
      return;
    const series = this.taskSeries().find((s) => s.id === task.series_id);
    if (
      !series?.active ||
      this.tasks().some(
        (t) => t.series_id === series.id && (t.occurrence_index ?? -1) > task.occurrence_index!,
      )
    )
      return;
    const due = recurrenceDate(series.anchor_on, series.frequency, task.occurrence_index + 1);
    if (due > '2100-12-31' || task.occurrence_index >= 100000) {
      this.taskSeries.update((rows) =>
        rows.map((s) =>
          s.id === series.id ? { ...s, active: false, revision: s.revision + 1 } : s,
        ),
      );
      return;
    }
    const next: Task = {
      ...task,
      id: crypto.randomUUID(),
      status: 'todo',
      due_date: due,
      occurrence_index: task.occurrence_index + 1,
      revision: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const items = this.taskChecklist()
      .filter((i) => i.task_id === task.id)
      .map((i) => ({
        ...i,
        id: crypto.randomUUID(),
        task_id: next.id,
        done: false,
        revision: 1,
        created_at: next.created_at,
        updated_at: next.updated_at,
      }));
    this.tasks.update((rows) => [next, ...rows]);
    this.taskChecklist.update((rows) => [...rows, ...items]);
  }
  async updateGoal(goal: Goal, value: string) {
    if (!this.canEdit(goal) || !/^\d+(\.\d{1,2})?$/.test(value))
      throw new Error('Enter a valid non-negative progress value.');
    const current = Number(value);
    if (!Number.isFinite(current) || current >= 1000000000000 || goal.status !== 'active')
      throw new Error('Restore the goal and enter progress below one trillion.');
    const revision = this.goals().find((g) => g.id === goal.id)?.revision;
    if (revision !== goal.revision) throw new Error('Goal changed; refresh and try again.');
    const generation = this.generation;
    if (!this.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_personal_goal', {
        entry: goal.id,
        w: goal.workspace_id,
        expected_revision: goal.revision,
        goal_title: goal.title,
        goal_target: goal.target,
        goal_current: current,
        goal_unit: goal.unit,
        deadline: goal.due_date,
        goal_period: goal.period,
        goal_color: goal.color,
        goal_notes: goal.notes,
        sharing: goal.visibility,
      });
      if (error) throw error;
    }
    if (generation !== this.generation) return;
    this.goals.update((list) =>
      list.map((g) => (g.id === goal.id ? { ...g, current, revision: g.revision + 1 } : g)),
    );
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
  async add(input: Capture, goalRequest?: string) {
    const title = input.title.trim();
    if (!title || title.length > 200) throw new Error('Enter a title of 1–200 characters.');
    const b = { ...this.base(), visibility: input.visibility };
    if (input.kind === 'goal' && goalRequest) b.id = goalRequest;
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
          assignee_id: null,
          revision: 1,
          list_id: null,
          series_id: null,
          occurrence_index: null,
          priority: input.priority,
          due_date: input.date || null,
          project_id: input.project_id || null,
        };
        if (!this.auth.demo()) {
          const { assignee_id, revision, list_id, series_id, occurrence_index, ...insert } = row;
          void assignee_id;
          void revision;
          void list_id;
          void series_id;
          void occurrence_index;
          check((await c!.from('tasks').insert(insert)).error);
        }
        this.tasks.update((v) => [row, ...v]);
        break;
      }
      case 'project': {
        const row: Project = {
          ...b,
          revision: 1,
          title,
          description: input.body,
          status: 'active',
          color: 'purple',
          due_date: input.date || null,
        };
        if (!this.auth.demo()) {
          const { revision, ...insert } = row;
          void revision;
          check((await c!.from('projects').insert(insert)).error);
        }
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
        const existing = this.goals().find((g) => g.id === b.id);
        if (this.auth.demo() && existing) {
          if (existing.owner_id !== b.owner_id || existing.workspace_id !== b.workspace_id)
            throw new Error('Goal is inaccessible.');
          return;
        }
        const row: Goal = {
          ...b,
          title,
          target: parseMoney(input.amount),
          current: 0,
          unit: input.category,
          due_date: input.date || null,
          color: 'purple',
          period: 'long_term',
          status: 'active',
          notes: '',
          revision: 1,
        };
        const generation = this.generation;
        const session = this.fileSession();
        if (!this.auth.demo())
          check(
            (
              await c!.rpc('save_personal_goal', {
                entry: row.id,
                w: row.workspace_id,
                expected_revision: null,
                goal_title: row.title,
                goal_target: row.target,
                goal_current: 0,
                goal_unit: row.unit,
                deadline: row.due_date,
                goal_period: row.period,
                goal_color: row.color,
                goal_notes: row.notes,
                sharing: row.visibility,
              })
            ).error,
          );
        if (generation !== this.generation) return;
        if (!this.auth.demo()) {
          await this.switchWorkspace(this.workspace()!);
          if (
            session === this.fileSession() &&
            b.workspace_id === this.workspace()?.id &&
            this.error()
          )
            throw new Error(this.error());
          return;
        }
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
        if (this.creditCards().some((c) => c.account_id === account.id && c.archived))
          throw new Error('Restore card before recording ledger entries.');
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
    if (this.creditCards().some((c) => c.account_id === source || c.account_id === destination))
      throw new Error('Use Credit cards to record statement payments.');
    if (source === destination) throw new Error('Choose two different accounts.');
    const owned = this.accounts().filter(
      (a) => a.owner_id === (this.auth.demo() ? 'demo-user' : this.auth.user()?.id),
    );
    const a = owned.find((a) => a.id === source),
      b = owned.find((a) => a.id === destination);
    if (
      this.creditCards().some(
        (c) => c.archived && (c.account_id === source || c.account_id === destination),
      )
    )
      throw new Error('Restore card before recording ledger entries.');
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
    if (this.creditCards().some((c) => c.account_id === current.account_id && c.archived)) return 0;
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
      creditCards: this.creditCards(),
      cardStatements: this.cardStatements(),
      cardPayments: this.cardPayments(),
      accounts: this.accounts(),
      transactions: this.transactions(),
      budgets: this.budgets(),
      bills: this.bills(),
      recurring: this.recurring(),
      subscriptions: this.subscriptions(),
      loans: this.loans(),
      householdMembers: this.householdMembers(),
      householdEntries: this.householdEntries(),
      habits: this.habits(),
      habitPeriods: this.habitPeriods(),
      habitCheckins: this.habitCheckins(),
      projectMilestones: this.projectMilestones(),
      projectBudgets: this.projectBudgets(),
      taskTimes: this.taskTimes(),
      taskLists: this.taskLists(),
      taskSeries: this.taskSeries(),
      taskChecklist: this.taskChecklist(),
      goalMilestones: this.goalMilestones(),
      travelPlans: this.travelPlans(),
      travelEntries: this.travelEntries(),
      travelBudgets: this.travelBudgets(),
      travelExpenses: this.travelExpenses(),
      healthLogs: this.healthLogs(),
      medicationPlans: this.medicationPlans(),
      healthExpenses: this.healthExpenses(),
      healthAppointments: this.healthAppointments(),
      healthDocuments: this.healthDocuments(),
      careerRecords: this.careerRecords(),
      careerDocuments: this.careerDocuments(),
      assets: this.assets(),
      assetDocuments: this.assetDocuments(),
      maintenancePlans: this.maintenancePlans(),
      maintenanceLogs: this.maintenanceLogs(),
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
