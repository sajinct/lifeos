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
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  due_date: string | null;
  project_id: string | null;
}
export interface Project extends OwnedRecord {
  title: string;
  description: string;
  status: 'active' | 'paused' | 'completed';
  color: string;
  due_date: string | null;
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
}
export interface Account extends OwnedRecord {
  name: string;
  currency: string;
  opening_balance: number;
}
export interface Transaction extends OwnedRecord {
  title: string;
  account_id: string;
  amount: number;
  kind: 'income' | 'expense' | 'transfer_in' | 'transfer_out';
  category: string;
  booked_on: string;
  transfer_id: string | null;
  project_id: string | null;
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
export interface Activity extends OwnedRecord {
  title: string;
}
export interface Notification extends OwnedRecord {
  title: string;
  reminder_id: string | null;
  read_at: string | null;
}
export interface Settings {
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
export interface TableRows {
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
