export type Visibility = 'private' | 'workspace';
export type WorkspaceKind = 'personal' | 'family' | 'professional' | 'side_project';
export interface OwnedRecord {
  id: string;
  workspace_id: string;
  owner_id: string;
  visibility: Visibility;
  created_at: string;
  updated_at: string;
}
export interface Profile {
  id: string;
  display_name: string;
  currency: string;
  timezone: string;
}
export interface Workspace {
  id: string;
  owner_id: string;
  name: string;
  kind: WorkspaceKind;
}
export interface Member {
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'editor' | 'viewer';
}
export interface Task extends OwnedRecord {
  assignee_id: string | null;
  revision: number;
  list_id: string | null;
  series_id: string | null;
  occurrence_index: number | null;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  due_date: string | null;
  project_id: string | null;
}
export interface TaskMember {
  user_id: string;
  display_name: string;
  role: Member['role'];
}
export interface TaskTime extends OwnedRecord {
  task_id: string | null;
  task_title: string;
  project_id: string | null;
  project_title: string;
  mode: 'manual' | 'timer';
  status: 'running' | 'recorded' | 'void';
  logged_on: string;
  seconds: number;
  started_at: string | null;
  ended_at: string | null;
  notes: string;
  revision: number;
}
export interface TaskList extends OwnedRecord {
  name: string;
  archived: boolean;
  revision: number;
}
export interface TaskSeries extends OwnedRecord {
  frequency: Frequency;
  anchor_on: string;
  active: boolean;
  revision: number;
}
export interface TaskChecklist extends OwnedRecord {
  task_id: string;
  title: string;
  done: boolean;
  revision: number;
}
export interface Project extends OwnedRecord {
  revision: number;
  title: string;
  description: string;
  status: 'active' | 'paused' | 'completed';
  color: string;
  due_date: string | null;
}
export interface ProjectMilestone extends OwnedRecord {
  project_id: string;
  title: string;
  due_on: string | null;
  notes: string;
  done: boolean;
  completed_on: string | null;
  archived: boolean;
  revision: number;
}
export interface ProjectBudget extends OwnedRecord {
  project_id: string;
  currency: string;
  amount: number;
  archived: boolean;
  revision: number;
}
export interface ProjectInput {
  title: string;
  description: string;
  status: Project['status'];
  color: Project['color'];
  due_date: string;
  visibility: Visibility;
}
export interface CalendarEvent extends OwnedRecord {
  title: string;
  starts_at: string;
  ends_at: string;
  location: string;
  project_id: string | null;
  color: string;
}
export interface Note extends OwnedRecord {
  title: string;
  body: string;
  project_id: string | null;
}
export interface Goal extends OwnedRecord {
  title: string;
  target: number;
  current: number;
  unit: string;
  due_date: string | null;
  color: string;
  period: 'long_term' | 'monthly' | 'annual';
  status: 'active' | 'archived';
  notes: string;
  revision: number;
}
export interface Habit extends OwnedRecord {
  title: string;
  routine: string;
  notes: string;
  starts_on: string;
  weekdays: number[];
  status: 'active' | 'paused' | 'archived';
  revision: number;
}
export interface HabitPeriod extends OwnedRecord {
  habit_id: string;
  starts_on: string;
  status: Habit['status'];
}
export interface HabitCheckin extends OwnedRecord {
  habit_id: string;
  completed_on: string;
  done: boolean;
  revision: number;
}
export interface GoalMilestone extends OwnedRecord {
  goal_id: string;
  title: string;
  due_on: string | null;
  notes: string;
  done: boolean;
  completed_on: string | null;
  revision: number;
}
export interface HabitInput {
  title: string;
  routine: string;
  notes: string;
  starts_on: string;
  weekdays: number[];
}
export interface GoalInput {
  title: string;
  target: string;
  current: string;
  unit: string;
  due_date: string;
  period: Goal['period'];
  color: string;
  notes: string;
  visibility: Visibility;
}
export interface MilestoneInput {
  goal_id: string;
  title: string;
  due_on: string;
  notes: string;
}
export interface InvestmentHolding extends OwnedRecord {
  title: string;
  kind: 'stock' | 'fund' | 'bond' | 'deposit' | 'crypto' | 'other';
  currency: string;
  opened_on: string;
  opening_cost: number;
  opening_value: number;
  current_cost: number;
  current_value: number;
  last_entry_on: string;
  next_sequence: number;
  notes: string;
  archived: boolean;
  revision: number;
}
export interface InvestmentEntry extends OwnedRecord {
  holding_id: string;
  sequence: number;
  kind: 'contribution' | 'withdrawal' | 'valuation';
  amount: number;
  basis_removed: number;
  occurred_on: string;
  account_id: string | null;
  transaction_id: string | null;
  reversal_id: string | null;
  voided: boolean;
  before_cost: number;
  before_value: number;
  notes: string;
}
export type WealthSourceKind = 'account' | 'asset' | 'loan' | 'holding';
export interface WealthExclusion extends OwnedRecord {
  source_kind: WealthSourceKind;
  source_id: string;
  excluded: boolean;
  revision: number;
}
export interface WealthAssetValue extends OwnedRecord {
  asset_id: string;
  currency: string;
  amount: number;
  valued_on: string;
  notes: string;
  revision: number;
}
export interface WealthTotals {
  currency: string;
  account_assets: number;
  account_debt: number;
  investments: number;
  physical_assets: number;
  lent_principal: number;
  borrowed_principal: number;
  assets_total: number;
  liabilities_total: number;
  net: number;
}
export interface WealthSnapshot extends OwnedRecord {
  label: string;
  captured_on: string;
  totals: WealthTotals[];
}
export type HoldingInput = Pick<
  InvestmentHolding,
  'title' | 'kind' | 'currency' | 'opened_on' | 'notes'
> & { opening_cost: string; opening_value: string };
export interface InvestmentInput {
  kind: InvestmentEntry['kind'];
  amount: string;
  basis_removed: string;
  occurred_on: string;
  account_id: string;
  notes: string;
}
export interface CreditCard extends OwnedRecord {
  account_id: string;
  title: string;
  last_four: string;
  closing_day: number;
  due_day: number;
  credit_limit: number;
  notes: string;
  reminders_enabled: boolean;
  archived: boolean;
  revision: number;
}
export interface CardStatement extends OwnedRecord {
  card_id: string;
  cycle_end: string;
  due_on: string;
  amount: number;
  minimum_due: number;
  notes: string;
  status: 'open' | 'superseded' | 'cancelled';
  revision: number;
}
export interface CardPayment extends OwnedRecord {
  card_id: string;
  statement_id: string;
  source_account_id: string;
  amount: number;
  booked_on: string;
  notes: string;
  voided: boolean;
  reversal_id: string | null;
}
export type CardInput = Pick<
  CreditCard,
  'title' | 'last_four' | 'closing_day' | 'due_day' | 'notes' | 'reminders_enabled'
> & { currency: string; opening_debt: string; credit_limit: string };
export interface StatementInput {
  cycle_end: string;
  due_on: string;
  amount: string;
  minimum_due: string;
  notes: string;
}
export interface CardPaymentInput {
  source: string;
  amount: string;
  date: string;
  notes: string;
}
export interface Account extends OwnedRecord {
  name: string;
  currency: string;
  opening_balance: number;
}
export interface Transaction extends OwnedRecord {
  import_reference?: string | null;
  import_batch_id?: string | null;
  title: string;
  account_id: string;
  amount: number;
  kind: 'income' | 'expense' | 'transfer_in' | 'transfer_out';
  category: string;
  booked_on: string;
  transfer_id: string | null;
  project_id: string | null;
  subscription_id?: string | null;
  loan_id?: string | null;
  loan_repayment_id?: string | null;
  bill_id?: string | null;
  recurring_id?: string | null;
  occurrence_on?: string | null;
}
export interface Budget extends OwnedRecord {
  category: string;
  month: string;
  currency: string;
  amount: number;
}
export interface Bill extends OwnedRecord {
  title: string;
  account_id: string;
  amount: number;
  category: string;
  due_on: string;
  status: 'pending' | 'paid' | 'cancelled';
  paid_on: string | null;
  transaction_id: string | null;
}
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export interface RecurringTransaction extends OwnedRecord {
  title: string;
  account_id: string;
  amount: number;
  kind: 'income' | 'expense';
  category: string;
  start_on: string;
  next_on: string;
  frequency: Frequency;
  occurrence_count: number;
  active: boolean;
  automatic: boolean;
}
export interface FinancePlanInput {
  title: string;
  account_id: string;
  amount: string;
  category: string;
  date: string;
  frequency: Frequency;
  kind: 'income' | 'expense';
  automatic: boolean;
}
export interface Subscription extends OwnedRecord {
  title: string;
  amount: number;
  currency: string;
  frequency: 'monthly' | 'yearly';
  anchor_on: string;
  next_on: string;
  renewal_count: number;
  status: 'active' | 'trial' | 'cancelled';
  trial_ends_on: string | null;
  category: string;
  provider_url: string;
  notes: string;
  recurring_id: string | null;
}
export interface SubscriptionInput {
  title: string;
  amount: string;
  currency: string;
  frequency: Subscription['frequency'];
  next_on: string;
  status: 'active' | 'trial';
  trial_ends_on: string;
  category: string;
  provider_url: string;
  notes: string;
  link_mode: 'track' | 'create' | 'existing';
  account_id: string;
  recurring_id: string;
  automatic: boolean;
}
export interface Loan extends OwnedRecord {
  title: string;
  counterparty: string;
  direction: 'borrowed' | 'lent';
  currency: string;
  principal: number;
  annual_rate: number;
  interest_total: number;
  installments: number;
  installment_amount: number;
  opened_on: string;
  first_due_on: string;
  next_due_on: string | null;
  principal_paid: number;
  interest_paid: number;
  status: 'active' | 'paid';
  notes: string;
}
export interface LoanRepayment extends OwnedRecord {
  loan_id: string;
  principal_amount: number;
  interest_amount: number;
  booked_on: string;
  account_id: string | null;
  notes: string;
}
export interface LoanInput {
  title: string;
  counterparty: string;
  direction: Loan['direction'];
  currency: string;
  principal: string;
  annual_rate: string;
  installments: number;
  opened_on: string;
  first_due_on: string;
  notes: string;
  account_id: string;
}
export interface RepaymentInput {
  principal: string;
  interest: string;
  date: string;
  account_id: string;
  notes: string;
}
export interface Contact extends OwnedRecord {
  name: string;
  kind: 'person' | 'organization';
  organization: string;
  category: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  notes: string;
  next_follow_up: string | null;
  follow_up_note: string;
  last_contacted_on: string | null;
  status: 'active' | 'archived';
  revision: number;
}
export interface ContactLink extends OwnedRecord {
  contact_id: string;
  project_id: string | null;
  loan_id: string | null;
}
export interface ContactInput {
  name: string;
  kind: Contact['kind'];
  organization: string;
  category: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  notes: string;
  next_follow_up: string;
  follow_up_note: string;
  last_contacted_on: string;
  project_ids: string[];
  loan_ids: string[];
}
export interface Activity extends OwnedRecord {
  title: string;
}
export interface HouseholdMember extends OwnedRecord {
  name: string;
  relationship: string;
  birthday: string | null;
  notes: string;
  status: 'active' | 'archived';
  revision: number;
}
export interface HouseholdEntry extends OwnedRecord {
  title: string;
  kind: 'task' | 'date';
  due_on: string | null;
  annual: boolean;
  member_id: string | null;
  notes: string;
  status: 'active' | 'done' | 'archived';
  revision: number;
}
export interface HouseholdMemberInput {
  name: string;
  relationship: string;
  birthday: string;
  notes: string;
  visibility: Visibility;
}
export interface HouseholdEntryInput {
  title: string;
  kind: HouseholdEntry['kind'];
  due_on: string;
  annual: boolean;
  member_id: string;
  notes: string;
  visibility: Visibility;
}
export interface Notification extends OwnedRecord {
  title: string;
  reminder_id: string | null;
  read_at: string | null;
  source_kind:
    | 'task'
    | 'bill'
    | 'card_statement'
    | 'document'
    | 'subscription'
    | 'trial'
    | 'loan'
    | 'contact'
    | 'family_birthday'
    | 'family_task'
    | 'family_date'
    | 'warranty'
    | 'health_medication'
    | 'health_appointment'
    | 'career_follow_up'
    | 'career_interview'
    | 'certification'
    | 'maintenance'
    | null;
  source_id: string | null;
  occurrence_on: string | null;
  phase: 'upcoming' | 'overdue' | null;
  dismissed_at: string | null;
  snoozed_until: string | null;
}
export interface ReminderPreferences {
  task_reminders: boolean;
  bill_reminders: boolean;
  document_reminders: boolean;
  subscription_reminders: boolean;
  loan_reminders: boolean;
  contact_reminders: boolean;
  family_reminders: boolean;
  medication_reminders: boolean;
  health_reminders: boolean;
  health_lead_days: number;
  career_reminders: boolean;
  career_lead_days: number;
  certification_lead_days: number;
  asset_reminders: boolean;
  warranty_lead_days: number;
  maintenance_lead_days: number;
  task_lead_days: number;
  bill_lead_days: number;
  document_lead_days: number;
  subscription_lead_days: number;
  loan_lead_days: number;
  contact_lead_days: number;
  family_lead_days: number;
  reminder_hour: number;
  reminder_timezone: string;
}
export const DEFAULT_REMINDERS: ReminderPreferences = {
  task_reminders: false,
  bill_reminders: false,
  document_reminders: false,
  subscription_reminders: false,
  loan_reminders: false,
  contact_reminders: false,
  family_reminders: false,
  medication_reminders: false,
  health_reminders: false,
  health_lead_days: 1,
  career_reminders: false,
  career_lead_days: 1,
  certification_lead_days: 30,
  asset_reminders: false,
  warranty_lead_days: 30,
  maintenance_lead_days: 7,
  task_lead_days: 1,
  bill_lead_days: 3,
  document_lead_days: 30,
  subscription_lead_days: 7,
  loan_lead_days: 3,
  contact_lead_days: 1,
  family_lead_days: 7,
  reminder_hour: 9,
  reminder_timezone: 'UTC',
};
export interface Settings extends ReminderPreferences {
  id: string;
  dashboard_widgets: string[];
}
export type FileBucket = 'personal-documents' | 'financial-receipts';
export interface Attachment extends OwnedRecord {
  name: string;
  object_path: string;
  mime_type: string;
  size_bytes: number;
  bucket_id: FileBucket;
  status: 'uploading' | 'ready' | 'archived' | 'cancelled';
  category: string;
  expires_on: string | null;
  project_id: string | null;
  transaction_id: string | null;
  previous_version_id: string | null;
  version_number: number;
}
export interface FileDetails {
  category: string;
  expires_on: string;
  project_id: string;
  transaction_id: string;
}
export interface Asset extends OwnedRecord {
  name: string;
  category: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  location: string;
  purchased_on: string | null;
  purchase_price: number | null;
  currency: string;
  warranty_until: string | null;
  notes: string;
  status: 'active' | 'sold' | 'retired' | 'archived';
  revision: number;
}
export interface AssetDocument extends OwnedRecord {
  asset_id: string;
  attachment_id: string;
}
export interface MaintenancePlan extends OwnedRecord {
  asset_id: string;
  title: string;
  anchor_on: string;
  next_on: string | null;
  frequency: 'once' | 'monthly' | 'yearly';
  occurrence_count: number;
  status: 'active' | 'paused' | 'completed';
  notes: string;
  revision: number;
}
export interface MaintenanceLog extends OwnedRecord {
  asset_id: string;
  plan_id: string;
  scheduled_on: string;
  performed_on: string;
  title: string;
  cost: number | null;
  currency: string;
  notes: string;
}
export interface AssetInput {
  name: string;
  category: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  location: string;
  purchased_on: string;
  purchase_price: string;
  currency: string;
  warranty_until: string;
  notes: string;
  document_ids: string[];
}
export interface MaintenanceInput {
  asset_id: string;
  title: string;
  next_on: string;
  frequency: MaintenancePlan['frequency'];
  notes: string;
}
export interface ServiceInput {
  performed_on: string;
  cost: string;
  notes: string;
}
export interface TravelPlan extends OwnedRecord {
  kind: 'trip' | 'event';
  title: string;
  location: string;
  starts_on: string;
  ends_on: string;
  timezone: string;
  status: 'planning' | 'active' | 'completed' | 'cancelled';
  notes: string;
  archived: boolean;
  revision: number;
}
export type TravelPlanInput = Pick<
  TravelPlan,
  'kind' | 'title' | 'location' | 'starts_on' | 'ends_on' | 'timezone' | 'status' | 'notes'
>;
export interface TravelEntry extends OwnedRecord {
  plan_id: string;
  kind: 'itinerary' | 'booking' | 'checklist' | 'guest';
  title: string;
  date_on: string | null;
  end_on: string | null;
  time_at: string;
  end_time: string;
  location: string;
  reference: string;
  cost: number | null;
  currency: string;
  email: string;
  phone: string;
  guest_count: number | null;
  status: string;
  notes: string;
  archived: boolean;
  revision: number;
}
export type TravelEntryInput = Pick<
  TravelEntry,
  | 'kind'
  | 'title'
  | 'time_at'
  | 'end_time'
  | 'location'
  | 'reference'
  | 'currency'
  | 'email'
  | 'phone'
  | 'status'
  | 'notes'
> & { date_on: string; end_on: string; cost: string; guest_count: string };
export interface TravelBudget extends OwnedRecord {
  plan_id: string;
  currency: string;
  amount: number;
  archived: boolean;
  revision: number;
}
export interface TravelExpense extends OwnedRecord {
  plan_id: string;
  transaction_id: string;
  notes: string;
  archived: boolean;
  revision: number;
}
export type TravelRecordKind = 'plan' | 'entry' | 'budget' | 'expense';
export type TravelAction = 'archive' | 'restore' | 'complete' | 'reopen';
export interface HealthLog extends OwnedRecord {
  kind: 'fitness' | 'measurement';
  title: string;
  logged_on: string;
  minutes: number | null;
  value: number | null;
  unit: string;
  notes: string;
  archived: boolean;
  revision: number;
}
export interface MedicationPlan extends OwnedRecord {
  title: string;
  instructions: string;
  starts_on: string;
  ends_on: string | null;
  weekdays: number[];
  reminder_time: string;
  timezone: string;
  active: boolean;
  archived: boolean;
  revision: number;
}
export interface HealthExpense extends OwnedRecord {
  transaction_id: string;
  appointment_id: string | null;
  notes: string;
  archived: boolean;
  revision: number;
}
export interface HealthLogInput {
  kind: HealthLog['kind'];
  title: string;
  logged_on: string;
  minutes: string;
  value: string;
  unit: string;
  notes: string;
}
export type MedicationInput = Pick<
  MedicationPlan,
  'title' | 'instructions' | 'starts_on' | 'weekdays' | 'reminder_time' | 'timezone'
> & { ends_on: string };
export type HealthTrackingKind = 'log' | 'medication' | 'expense';
export type HealthTrackingAction = 'archive' | 'restore' | 'pause' | 'resume';
export interface HealthAppointment extends OwnedRecord {
  title: string;
  provider: string;
  location: string;
  appointment_on: string;
  appointment_time: string;
  notes: string;
  status: 'scheduled' | 'completed' | 'cancelled';
  archived: boolean;
  revision: number;
}
export interface HealthDocument extends OwnedRecord {
  appointment_id: string;
  attachment_id: string;
}
export type HealthInput = Pick<
  HealthAppointment,
  'title' | 'provider' | 'location' | 'appointment_on' | 'appointment_time' | 'notes' | 'status'
> & { document_ids: string[] };
export type HealthAction = 'complete' | 'cancel' | 'reopen' | 'archive' | 'restore';
export interface CareerRecord extends OwnedRecord {
  kind: 'employment' | 'application' | 'certification';
  title: string;
  organization: string;
  location: string;
  skills: string;
  starts_on: string | null;
  ends_on: string | null;
  applied_on: string | null;
  interview_on: string | null;
  follow_up_on: string | null;
  expires_on: string | null;
  url: string;
  notes: string;
  status:
    | 'active'
    | 'applied'
    | 'interview'
    | 'offer'
    | 'accepted'
    | 'rejected'
    | 'withdrawn'
    | 'archived';
  revision: number;
}
export interface CareerDocument extends OwnedRecord {
  record_id: string;
  attachment_id: string;
}
export type CareerInput = Pick<
  CareerRecord,
  'kind' | 'title' | 'organization' | 'location' | 'skills' | 'url' | 'notes' | 'status'
> & {
  starts_on: string;
  ends_on: string;
  applied_on: string;
  interview_on: string;
  follow_up_on: string;
  expires_on: string;
  document_ids: string[];
};
export interface TableRows {
  finance_json_links: {
    id: string;
    workspace_id: string;
    owner_id: string;
    source_kind: 'account' | 'transaction';
    source_id: string;
    account_id: string;
    transaction_id: string | null;
    details: Record<string, unknown>;
    created_at: string;
  };
  investment_holdings: InvestmentHolding;
  investment_entries: InvestmentEntry;
  wealth_exclusions: WealthExclusion;
  wealth_asset_values: WealthAssetValue;
  wealth_snapshots: WealthSnapshot;
  credit_cards: CreditCard;
  card_statements: CardStatement;
  card_payments: CardPayment;
  travel_plans: TravelPlan;
  travel_entries: TravelEntry;
  travel_budgets: TravelBudget;
  travel_expenses: TravelExpense;
  project_milestones: ProjectMilestone;
  project_budgets: ProjectBudget;
  task_time_entries: TaskTime;
  task_lists: TaskList;
  task_series: TaskSeries;
  task_checklist: TaskChecklist;
  habits: Habit;
  habit_periods: HabitPeriod;
  habit_checkins: HabitCheckin;
  goal_milestones: GoalMilestone;
  health_logs: HealthLog;
  medication_plans: MedicationPlan;
  health_expenses: HealthExpense;
  health_appointments: HealthAppointment;
  health_documents: HealthDocument;
  career_records: CareerRecord;
  career_documents: CareerDocument;
  profiles: Profile;
  workspaces: Workspace;
  workspace_members: Member;
  tasks: Task;
  projects: Project;
  calendar_events: CalendarEvent;
  notes: Note;
  goals: Goal;
  accounts: Account;
  transactions: Transaction;
  budgets: Budget;
  bills: Bill;
  recurring_transactions: RecurringTransaction;
  activity_logs: Activity;
  notifications: Notification;
  app_settings: Settings;
  attachments: Attachment;
  subscriptions: Subscription;
  loans: Loan;
  contacts: Contact;
  contact_links: ContactLink;
  household_members: HouseholdMember;
  household_entries: HouseholdEntry;
  assets: Asset;
  asset_documents: AssetDocument;
  maintenance_plans: MaintenancePlan;
  maintenance_logs: MaintenanceLog;
  loan_repayments: LoanRepayment;
}
type Table<R> = {
  Row: { [P in keyof R]: R[P] };
  Insert: { [P in keyof R]?: R[P] };
  Update: { [P in keyof R]?: R[P] };
  Relationships: [];
};
export type Database = {
  public: {
    Tables: { [K in keyof TableRows]: Table<TableRows[K]> };
    Views: Record<string, never>;
    Functions: {
      import_finance_json: {
        Args: {
          entry: string;
          w: string;
          payload: {
            accounts: { [key: string]: string | boolean | null }[];
            transactions: {
              source_id: string;
              account_source: string;
              row: { [key: string]: string };
            }[];
          };
        };
        Returns: {
          accounts_created: number;
          accounts_reused: number;
          imported: number;
          skipped: number;
        };
      };
      import_finance_csv: {
        Args: { entry: string; w: string; account: string; rows: { [key: string]: string }[] };
        Returns: { imported: number; skipped: number };
      };
      save_investment_holding: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          details: { [key: string]: string | number };
        };
        Returns: string;
      };
      append_investment_entry: {
        Args: {
          entry: string;
          w: string;
          parent: string;
          expected_revision: number;
          entry_kind: string;
          entry_amount: number;
          removed_basis: number;
          entry_date: string;
          bank_account: string | null;
          entry_notes: string;
        };
        Returns: string;
      };
      undo_investment_entry: {
        Args: { entry: string; expected_revision: number };
        Returns: undefined;
      };
      archive_investment_holding: {
        Args: { entry: string; expected_revision: number; archived_value: boolean };
        Returns: undefined;
      };
      set_wealth_exclusion: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          source_kind: WealthSourceKind;
          source_id: string;
          excluded_value: boolean;
        };
        Returns: string;
      };
      save_wealth_asset_value: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          asset: string;
          value_amount: number;
          value_date: string;
          value_notes: string;
        };
        Returns: string;
      };
      capture_wealth_snapshot: {
        Args: { entry: string; w: string; snapshot_label: string };
        Returns: string;
      };
      save_credit_card: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          details: { [key: string]: string | number | boolean };
        };
        Returns: string;
      };
      save_card_statement: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          parent: string;
          details: { [key: string]: string | number };
        };
        Returns: string;
      };
      record_card_payment: {
        Args: {
          entry: string;
          w: string;
          statement: string;
          source: string;
          payment_amount: number;
          payment_date: string;
          payment_notes: string;
        };
        Returns: string;
      };
      void_card_payment: { Args: { entry: string }; Returns: undefined };
      act_on_card_record: {
        Args: { entry: string; record_kind: string; expected_revision: number; action: string };
        Returns: undefined;
      };
      save_travel_plan: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          details: { [key: string]: string };
        };
        Returns: string;
      };
      save_travel_entry: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          parent: string;
          details: { [key: string]: string | number | null };
        };
        Returns: string;
      };
      save_travel_budget: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          parent: string;
          budget_currency: string;
          budget_amount: number;
        };
        Returns: string;
      };
      save_travel_expense: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          parent: string;
          expense: string;
          expense_notes: string;
        };
        Returns: string;
      };
      act_on_travel_record: {
        Args: { entry: string; record_kind: string; expected_revision: number; action: string };
        Returns: undefined;
      };
      save_planned_project: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          project_title: string;
          project_description: string;
          project_status: string;
          project_color: string;
          deadline: string | null;
          sharing: Visibility;
        };
        Returns: string;
      };
      save_project_milestone: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          parent: string;
          milestone_title: string;
          deadline: string | null;
          milestone_notes: string;
        };
        Returns: string;
      };
      act_on_project_milestone: {
        Args: { entry: string; expected_revision: number; action: string };
        Returns: undefined;
      };
      save_project_budget: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          parent: string;
          budget_currency: string;
          budget_amount: number;
        };
        Returns: string;
      };
      set_project_budget_archive: {
        Args: { entry: string; expected_revision: number; archived_value: boolean };
        Returns: undefined;
      };
      link_project_expense: {
        Args: { entry: string; expected_project: string | null; parent: string | null };
        Returns: undefined;
      };
      workspace_task_members: { Args: { w: string }; Returns: TaskMember[] };
      assign_workspace_task: {
        Args: { entry: string; expected_revision: number; assignee: string | null };
        Returns: undefined;
      };
      save_manual_task_time: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          parent: string | null;
          work_day: string;
          duration_seconds: number;
          entry_notes: string;
        };
        Returns: string;
      };
      start_task_timer: {
        Args: { entry: string; w: string; parent: string; entry_notes: string };
        Returns: string;
      };
      act_on_task_time: {
        Args: { entry: string; expected_revision: number; action: string };
        Returns: undefined;
      };
      remove_task_checklist: {
        Args: { entry: string; expected_revision: number };
        Returns: undefined;
      };
      save_task_list: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          list_name: string;
          is_archived: boolean;
        };
        Returns: string;
      };
      configure_task: {
        Args: {
          entry: string;
          expected_revision: number;
          task_list: string | null;
          repeat_frequency: string | null;
        };
        Returns: undefined;
      };
      set_task_status: {
        Args: { entry: string; expected_revision: number; target: string };
        Returns: undefined;
      };
      set_task_series_active: {
        Args: { entry: string; expected_revision: number; enabled: boolean };
        Returns: undefined;
      };
      save_task_checklist: {
        Args: {
          entry: string;
          parent: string;
          expected_revision: number | null;
          item_title: string;
          completed: boolean;
        };
        Returns: string;
      };
      save_personal_goal: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          goal_title: string;
          goal_target: number;
          goal_current: number;
          goal_unit: string;
          deadline: string | null;
          goal_period: string;
          goal_color: string;
          goal_notes: string;
          sharing: Visibility;
        };
        Returns: string;
      };
      set_goal_archive: {
        Args: { entry: string; expected_revision: number; archived: boolean };
        Returns: undefined;
      };
      save_habit: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          habit_title: string;
          routine_name: string;
          habit_notes: string;
          first_day: string;
          scheduled_days: number[];
        };
        Returns: string;
      };
      set_habit_status: {
        Args: { entry: string; expected_revision: number; target: string };
        Returns: undefined;
      };
      set_habit_checkin: {
        Args: { habit: string; day: string; expected_revision: number; completed: boolean };
        Returns: undefined;
      };
      save_goal_milestone: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          goal: string;
          milestone_title: string;
          deadline: string | null;
          milestone_notes: string;
        };
        Returns: string;
      };
      set_goal_milestone_done: {
        Args: { entry: string; expected_revision: number; completed: boolean };
        Returns: undefined;
      };
      save_health_log: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          details: { [key: string]: string | number | null };
        };
        Returns: string;
      };
      save_medication_plan: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          details: { [key: string]: string | number[] | null };
        };
        Returns: string;
      };
      save_health_expense: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          expense: string;
          appointment: string | null;
          expense_notes: string;
        };
        Returns: string;
      };
      act_on_health_tracking: {
        Args: { entry: string; record_kind: string; expected_revision: number; action: string };
        Returns: undefined;
      };
      save_health_appointment: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          details: { [key: string]: string };
          documents: string[];
        };
        Returns: string;
      };
      act_on_health_appointment: {
        Args: { entry: string; expected_revision: number; action: string };
        Returns: undefined;
      };
      save_career_record: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          details: { [key: string]: string | null };
          documents: string[];
        };
        Returns: string;
      };
      act_on_career_record: {
        Args: { entry: string; expected_revision: number; action: string };
        Returns: undefined;
      };
      save_asset: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          asset_name: string;
          asset_category: string;
          asset_manufacturer: string;
          asset_model: string;
          asset_serial: string;
          asset_location: string;
          purchased: string | null;
          price: number | null;
          price_currency: string;
          warranty: string | null;
          asset_notes: string;
          documents: string[];
        };
        Returns: string;
      };
      set_asset_status: {
        Args: { entry: string; expected_revision: number; target: string };
        Returns: undefined;
      };
      save_maintenance_plan: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          asset: string;
          plan_title: string;
          first_due: string;
          repeat_frequency: string;
          plan_notes: string;
        };
        Returns: string;
      };
      set_maintenance_status: {
        Args: { entry: string; expected_revision: number; target: string };
        Returns: undefined;
      };
      record_maintenance: {
        Args: {
          entry: string;
          plan: string;
          expected_revision: number;
          expected_date: string;
          performed: string;
          service_cost: number | null;
          service_notes: string;
        };
        Returns: string;
      };
      save_household_member: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          member_name: string;
          relation: string;
          birthday_month_day: string | null;
          member_notes: string;
          sharing: Visibility;
        };
        Returns: string;
      };
      save_household_entry: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          entry_title: string;
          entry_kind: string;
          entry_date: string | null;
          repeats_annually: boolean;
          household_member: string | null;
          entry_notes: string;
          sharing: Visibility;
        };
        Returns: string;
      };
      set_household_status: {
        Args: { record_kind: string; entry: string; expected_revision: number; target: string };
        Returns: undefined;
      };
      save_contact: {
        Args: {
          entry: string;
          w: string;
          expected_revision: number | null;
          contact_name: string;
          contact_kind: string;
          contact_organization: string;
          contact_category: string;
          contact_email: string;
          contact_phone: string;
          contact_website: string;
          contact_address: string;
          contact_notes: string;
          follow_up: string | null;
          follow_up_description: string;
          last_contact: string | null;
          projects: string[];
          loans: string[];
        };
        Returns: string;
      };
      set_contact_status: {
        Args: { entry: string; expected_revision: number; target: string };
        Returns: undefined;
      };
      complete_contact_follow_up: {
        Args: { entry: string; expected_revision: number };
        Returns: undefined;
      };
      create_loan: {
        Args: {
          entry: string;
          w: string;
          loan_title: string;
          party: string;
          loan_direction: string;
          loan_currency: string;
          principal_amount: number;
          rate: number;
          term: number;
          opened: string;
          first_due: string;
          loan_notes: string;
          initial_account: string | null;
        };
        Returns: string;
      };
      record_loan_repayment: {
        Args: {
          entry: string;
          loan: string;
          principal_amount: number;
          interest_amount: number;
          payment_date: string;
          payment_account: string | null;
          payment_notes: string;
        };
        Returns: string;
      };
      save_subscription: {
        Args: {
          entry: string;
          w: string;
          revision: string | null;
          service_name: string;
          price: number;
          price_currency: string;
          billing_frequency: string;
          first_renewal: string;
          trial_end: string | null;
          subscription_status: string;
          service_category: string;
          service_url: string;
          service_notes: string;
          link_mode: string;
          expense_account: string | null;
          existing_schedule: string | null;
          auto_record: boolean;
        };
        Returns: string;
      };
      cancel_subscription: { Args: { entry: string }; Returns: undefined };
      advance_subscription: { Args: { entry: string; expected_date: string }; Returns: undefined };
      save_reminder_preferences: {
        Args: {
          tasks_enabled: boolean;
          bills_enabled: boolean;
          documents_enabled: boolean;
          task_days: number;
          bill_days: number;
          document_days: number;
          delivery_hour: number;
          delivery_timezone: string;
          subscriptions_enabled: boolean;
          subscription_days: number;
          loans_enabled: boolean;
          loan_days: number;
          contacts_enabled: boolean;
          contact_days: number;
          family_enabled: boolean;
          family_days: number;
          assets_enabled: boolean;
          warranty_days: number;
          maintenance_days: number;
          medications_enabled: boolean;
          health_enabled: boolean;
          health_days: number;
          career_enabled: boolean;
          career_days: number;
          certification_days: number;
        };
        Returns: undefined;
      };
      act_on_notification: {
        Args: { notice: string; action: 'read' | 'dismiss' | 'snooze'; snooze_minutes: number };
        Returns: undefined;
      };
      complete_attachment: { Args: { upload: string }; Returns: undefined };
      set_attachment_status: {
        Args: { upload: string; target: 'ready' | 'archived' };
        Returns: undefined;
      };
      update_attachment_details: {
        Args: {
          upload: string;
          file_category: string;
          expiry: string | null;
          project: string | null;
          ledger_entry: string | null;
        };
        Returns: undefined;
      };
      cancel_attachment_upload: { Args: { upload: string }; Returns: undefined };
      remove_cancelled_attachment: { Args: { upload: string }; Returns: undefined };
      settle_bill: { Args: { bill: string }; Returns: string };
      cancel_bill: { Args: { bill: string }; Returns: undefined };
      post_recurring_due: { Args: { plan: string }; Returns: number };
      create_workspace: {
        Args: { workspace_name: string; workspace_type: WorkspaceKind };
        Returns: string;
      };
      set_workspace_member: {
        Args: { w: string; member_id: string; member_access: 'editor' | 'viewer' };
        Returns: undefined;
      };
      remove_workspace_member: { Args: { w: string; member_id: string }; Returns: undefined };
      record_transaction: {
        Args: {
          w: string;
          account: string;
          transaction_title: string;
          transaction_amount: number;
          transaction_kind: string;
          transaction_category: string;
          transaction_date: string;
        };
        Returns: string;
      };
      transfer_funds: {
        Args: {
          w: string;
          source_account: string;
          destination_account: string;
          transfer_amount: number;
          request_id: string;
        };
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
export type CaptureKind =
  'task' | 'expense' | 'income' | 'project' | 'event' | 'note' | 'goal' | 'account';
export interface Capture {
  kind: CaptureKind;
  title: string;
  date: string;
  time: string;
  end_time: string;
  amount: string;
  body: string;
  category: string;
  priority: Task['priority'];
  visibility: Visibility;
  account_id: string;
  project_id: string;
}
export const ALL_WIDGETS = ['tasks', 'calendar', 'finance', 'projects', 'goals', 'activity'];
