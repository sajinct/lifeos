import { Injectable } from '@angular/core';
import { createClient } from '@supabase/supabase-js';
import { Database } from '../models/domain';
import { backendConfig } from './config';
@Injectable({ providedIn: 'root' })
export class Backend {
  readonly configured = Boolean(backendConfig.url && backendConfig.key);
  readonly client = this.configured
    ? createClient<Database>(backendConfig.url, backendConfig.key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          flowType: 'pkce',
        },
      })
    : null;
  requireClient() {
    if (!this.client) throw new Error('Connect a Supabase project to use your account.');
    return this.client;
  }
}
