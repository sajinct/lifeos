import {
  OwnedRecord,
  Task,
  Project,
  CalendarEvent,
  Goal,
  Note,
  Account,
  Transaction,
  Activity,
  Attachment,
  Budget,
  Bill,
  RecurringTransaction,
} from '../models/domain';
import { localDate } from '../../shared/utilities/finance';
export function demoData() {
  const today = localDate();
  const date = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return localDate(d);
  };
  const base = (id: string): OwnedRecord => ({
    id,
    workspace_id: 'demo',
    owner_id: 'demo-user',
    visibility: 'private',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const projects: Project[] = [
    {
      ...base('p1'),
      title: 'Personal website',
      description: 'A little corner of the internet to call home.',
      status: 'active',
      color: 'purple',
      due_date: date(12),
    },
    {
      ...base('p2'),
      title: 'Home refresh',
      description: 'Make room for a calmer everyday.',
      status: 'active',
      color: 'orange',
      due_date: date(20),
    },
    {
      ...base('p3'),
      title: 'Learn something new',
      description: 'Build a consistent learning practice.',
      status: 'active',
      color: 'green',
      due_date: date(35),
    },
  ];
  const tasks: Task[] = [
    {
      ...base('t1'),
      title: 'Finish the homepage wireframes',
      status: 'todo',
      priority: 'high',
      due_date: today,
      project_id: 'p1',
    },
    {
      ...base('t2'),
      title: 'Review this month’s budget',
      status: 'todo',
      priority: 'medium',
      due_date: today,
      project_id: null,
    },
    {
      ...base('t3'),
      title: 'Book the annual health checkup',
      status: 'todo',
      priority: 'high',
      due_date: today,
      project_id: null,
    },
    {
      ...base('t4'),
      title: 'Read 20 pages',
      status: 'done',
      priority: 'low',
      due_date: today,
      project_id: 'p3',
    },
    {
      ...base('t5'),
      title: 'Choose plants for the living room',
      status: 'in_progress',
      priority: 'low',
      due_date: date(2),
      project_id: 'p2',
    },
    {
      ...base('t6'),
      title: 'Complete the TypeScript lesson',
      status: 'todo',
      priority: 'medium',
      due_date: date(1),
      project_id: 'p3',
    },
    {
      ...base('t7'),
      title: 'Set up website repository',
      status: 'done',
      priority: 'medium',
      due_date: date(-2),
      project_id: 'p1',
    },
  ];
  const events: CalendarEvent[] = [
    {
      ...base('e1'),
      title: 'Weekly planning',
      starts_at: new Date(`${today}T09:00`).toISOString(),
      ends_at: new Date(`${today}T09:30`).toISOString(),
      location: 'Personal · 30 min',
      project_id: null,
      color: 'purple',
    },
    {
      ...base('e2'),
      title: 'Coffee with the family',
      starts_at: new Date(`${today}T12:30`).toISOString(),
      ends_at: new Date(`${today}T13:30`).toISOString(),
      location: 'Family · 1 hour',
      project_id: null,
      color: 'orange',
    },
    {
      ...base('e3'),
      title: 'Time to move',
      starts_at: new Date(`${today}T18:00`).toISOString(),
      ends_at: new Date(`${today}T18:45`).toISOString(),
      location: 'Wellness · 45 min',
      project_id: null,
      color: 'green',
    },
  ];
  const goals: Goal[] = [
    {
      ...base('g1'),
      title: 'Build an emergency fund',
      target: 200000,
      current: 136000,
      unit: 'INR',
      due_date: date(90),
      color: 'purple',
    },
    {
      ...base('g2'),
      title: 'Read 24 books',
      target: 24,
      current: 16,
      unit: 'books',
      due_date: date(90),
      color: 'green',
    },
    {
      ...base('g3'),
      title: 'Run 100 kilometers',
      target: 100,
      current: 42,
      unit: 'km',
      due_date: date(30),
      color: 'orange',
    },
  ];
  const notes: Note[] = [
    {
      ...base('n1'),
      title: 'A few things to make space for',
      body: 'More time outside. A slower morning. Learning something just for the fun of it.',
      project_id: null,
    },
    {
      ...base('n2'),
      title: 'Website ideas',
      body: 'Keep it simple. A short introduction, selected work, and a way to get in touch.',
      project_id: 'p1',
    },
  ];
  const accounts: Account[] = [
    { ...base('a1'), name: 'Everyday account', currency: 'INR', opening_balance: 182450 },
    { ...base('a2'), name: 'Savings', currency: 'INR', opening_balance: 136000 },
  ];
  const transactions: Transaction[] = [
    {
      ...base('x1'),
      title: 'Monthly income',
      account_id: 'a1',
      amount: 85000,
      kind: 'income',
      category: 'Salary',
      booked_on: today.slice(0, 8) + '01',
      transfer_id: null,
      project_id: null,
    },
    {
      ...base('x2'),
      title: 'Rent & utilities',
      account_id: 'a1',
      amount: 24000,
      kind: 'expense',
      category: 'Home',
      booked_on: today.slice(0, 8) + '02',
      transfer_id: null,
      project_id: null,
    },
    {
      ...base('x3'),
      title: 'Groceries',
      account_id: 'a1',
      amount: 4850,
      kind: 'expense',
      category: 'Food',
      booked_on: today,
      transfer_id: null,
      project_id: null,
    },
    {
      ...base('x4'),
      title: 'Books & learning',
      account_id: 'a1',
      amount: 2350,
      kind: 'expense',
      category: 'Learning',
      booked_on: today,
      transfer_id: null,
      project_id: null,
    },
    {
      ...base('x5'),
      title: 'Everyday essentials',
      account_id: 'a1',
      amount: 6250,
      kind: 'expense',
      category: 'Other',
      booked_on: today,
      transfer_id: null,
      project_id: null,
    },
  ];
  const activity: Activity[] = [
    { ...base('l1'), title: 'Completed “Read 20 pages”' },
    { ...base('l2'), title: 'Added an expense · Groceries' },
    { ...base('l3'), title: 'Updated Personal website' },
  ];
  const budgets: Budget[] = [
    {
      ...base('budget1'),
      category: 'Food',
      month: today.slice(0, 7) + '-01',
      currency: 'INR',
      amount: 12000,
    },
  ];
  const bills: Bill[] = [
    {
      ...base('bill1'),
      title: 'Electricity',
      account_id: 'a1',
      amount: 1450,
      category: 'Utilities',
      due_on: date(3),
      status: 'pending',
      paid_on: null,
      transaction_id: null,
    },
  ];
  const recurring: RecurringTransaction[] = [
    {
      ...base('recurring1'),
      title: 'Monthly rent',
      account_id: 'a1',
      amount: 15000,
      kind: 'expense',
      category: 'Housing',
      start_on: today,
      next_on: today,
      frequency: 'monthly',
      occurrence_count: 0,
      active: true,
      automatic: false,
    },
  ];
  const attachments: Attachment[] = [];
  return {
    projects,
    tasks,
    events,
    goals,
    notes,
    accounts,
    transactions,
    activity,
    budgets,
    bills,
    recurring,
    attachments,
  };
}
