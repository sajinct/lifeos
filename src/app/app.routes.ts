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
      ...['inbox', 'tasks', 'calendar', 'finance', 'projects', 'goals', 'notes', 'reports'].map(
        (path) => ({
          path,
          loadComponent: () => import('./features/records/records').then((m) => m.Records),
        }),
      ),
      {
        path: 'documents',
        loadComponent: () => import('./features/documents/documents').then((m) => m.DocumentsPage),
      },
      {
        path: 'settings',
        loadComponent: () => import('./features/settings/settings').then((m) => m.SettingsPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
