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
        path: '',
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },
      ...['inbox', 'tasks', 'calendar', 'finance', 'projects', 'goals', 'notes'].map((path) => ({
        path,
        loadComponent: () => import('./features/records/records').then((m) => m.Records),
      })),
      {
        path: 'assets',
        loadComponent: () => import('./features/assets/assets').then((m) => m.AssetsPage),
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
