import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'auth',
    loadComponent: () => import('./features/auth/auth-page').then((m) => m.AuthPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    children: [
      {
        path: 'reports/progress',
        loadComponent: () =>
          import('./features/reports/progress').then((m) => m.ProgressReportsPage),
      },
      {
        path: 'learning/import-json',
        loadComponent: () =>
          import('./features/learning-import/learning-import').then((m) => m.LearningImportPage),
      },
      {
        path: 'calendar/import-json',
        data: { calendarImport: true },
        loadComponent: () =>
          import('./features/record-json-import/record-json-import').then(
            (m) => m.RecordJsonImportPage,
          ),
      },
      {
        path: 'imports/tasks-notes',
        loadComponent: () =>
          import('./features/record-json-import/record-json-import').then(
            (m) => m.RecordJsonImportPage,
          ),
      },
      {
        path: 'finance/import-json',
        loadComponent: () =>
          import('./features/finance-json-import/finance-json-import').then(
            (m) => m.FinanceJsonImportPage,
          ),
      },
      {
        path: 'finance/import',
        loadComponent: () =>
          import('./features/finance-import/finance-import').then((m) => m.FinanceImportPage),
      },
      {
        path: '',
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },
      ...['inbox', 'tasks', 'calendar', 'finance'].map((path) => ({
        path,
        loadComponent: () => import('./features/records/records').then((m) => m.Records),
      })),
      {
        path: 'notes',
        loadComponent: () => import('./features/notes/notes').then((m) => m.NotesPage),
      },
      {
        path: 'projects',
        loadComponent: () => import('./features/projects/projects').then((m) => m.ProjectsPage),
      },
      {
        path: 'goals',
        loadComponent: () => import('./features/goals/goals').then((m) => m.GoalsPage),
      },
      {
        path: 'travel',
        loadComponent: () => import('./features/travel/travel').then((m) => m.TravelPage),
      },
      {
        path: 'health',
        loadComponent: () => import('./features/health/health').then((m) => m.HealthPage),
      },
      {
        path: 'learning',
        loadComponent: () => import('./features/learning/learning').then((m) => m.LearningPage),
      },
      {
        path: 'career',
        loadComponent: () => import('./features/career/career').then((m) => m.CareerPage),
      },
      {
        path: 'assets',
        loadComponent: () => import('./features/assets/assets').then((m) => m.AssetsPage),
      },
      {
        path: 'family/shopping',
        loadComponent: () => import('./features/shopping/shopping').then((m) => m.ShoppingPage),
      },
      {
        path: 'family',
        loadComponent: () => import('./features/family/family').then((m) => m.FamilyPage),
      },
      {
        path: 'contacts',
        loadComponent: () => import('./features/contacts/contacts').then((m) => m.ContactsPage),
      },
      {
        path: 'reports',
        loadComponent: () => import('./features/reports/reports').then((m) => m.ReportsPage),
      },
      {
        path: 'documents',
        loadComponent: () => import('./features/documents/documents').then((m) => m.DocumentsPage),
      },
      {
        path: 'wealth',
        loadComponent: () => import('./features/wealth/wealth').then((m) => m.WealthPage),
      },
      {
        path: 'cards',
        loadComponent: () => import('./features/cards/cards').then((m) => m.CardsPage),
      },
      {
        path: 'loans',
        loadComponent: () => import('./features/loans/loans').then((m) => m.LoansPage),
      },
      {
        path: 'subscriptions',
        loadComponent: () =>
          import('./features/subscriptions/subscriptions').then((m) => m.SubscriptionsPage),
      },
      {
        path: 'settings',
        loadComponent: () => import('./features/settings/settings').then((m) => m.SettingsPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
