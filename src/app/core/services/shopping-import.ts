import { effect, inject, Injectable } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { ShoppingList, ShoppingItem } from '../models/domain';
import {
  ShoppingImportRow,
  ShoppingImportSource,
  ShoppingImportResult,
  ShoppingImportReview,
  parseShoppingImport,
  validateShoppingImportRow,
} from '../../shared/utilities/shopping-import';
export interface ShoppingImportRequest {
  id: string;
  workspace: string;
  user: string;
  session: number;
  payload: ShoppingImportRow[];
}
@Injectable({ providedIn: 'root' })
export class ShoppingImporter {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private readonly sources = new Map<string, string>();
  private readonly batches = new Map<string, { payload: string; result: ShoppingImportResult }>();
  private session = -1;
  constructor() {
    effect(() => {
      this.store.fileSession();
      this.syncSession();
    });
  }
  private syncSession() {
    const s = this.store.fileSession();
    if (s !== this.session) {
      this.sources.clear();
      this.batches.clear();
      this.session = s;
    }
  }
  context() {
    this.syncSession();
    const workspace = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (
      !workspace ||
      !user ||
      !this.store.writable() ||
      (!this.store.auth.demo() && this.store.auth.user()?.id !== user)
    )
      throw new Error('Workspace write access required.');
    return { workspace, user, session };
  }
  current(c: Omit<ShoppingImportRequest, 'id' | 'payload'>) {
    return (
      c.workspace === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private key(c: Omit<ShoppingImportRequest, 'id' | 'payload'>, source: string) {
    return JSON.stringify([c.workspace, c.user, source]);
  }
  private demoReview(
    rows: ShoppingImportRow[],
    c: ReturnType<ShoppingImporter['context']>,
  ): ShoppingImportReview[] {
    return rows.map((row) => {
      const prior = this.sources.get(this.key(c, row.source_id));
      return {
        source_id: row.source_id,
        state: prior
          ? prior === JSON.stringify(row)
            ? 'duplicate'
            : 'invalid'
          : this.store
                .shoppingLists()
                .some(
                  (i) =>
                    i.workspace_id === c.workspace &&
                    i.owner_id === c.user &&
                    i.id.toLowerCase() === row.source_id.toLowerCase(),
                )
            ? 'invalid'
            : 'ready',
        message: prior
          ? prior === JSON.stringify(row)
            ? 'Already imported; later destination edits, checks and archives are preserved'
            : 'Source ID contents changed; omit this list'
          : 'New source IDs create new private lists. Existing destination IDs cannot be imported again here.',
      };
    });
  }
  async preview(text: string) {
    const context = this.context(),
      source = parseShoppingImport(text),
      rows = source.rows.filter((r) => r.row).map((r) => r.row!);
    let review: ShoppingImportReview[] = [];
    if (rows.length) {
      if (this.store.auth.demo()) review = this.demoReview(rows, context);
      else {
        const { data, error } = await this.backend.requireClient().rpc('preview_shopping_import', {
          w: context.workspace,
          payload: rows.map((r) => ({ ...r })),
        });
        if (error) throw error;
        review = data ?? [];
      }
    }
    if (!this.current(context)) throw new Error('Workspace changed; preview again.');
    return { context, source, review };
  }
  prepare(
    source: ShoppingImportSource,
    review: ShoppingImportReview[],
    selected: Set<number>,
  ): ShoppingImportRequest {
    const c = this.context(),
      payload = source.rows
        .filter(
          (r) =>
            r.row &&
            selected.has(r.index) &&
            review.some((v) => v.source_id === r.row!.source_id && v.state === 'ready'),
        )
        .map((r) => validateShoppingImportRow(r.row!));
    if (!payload.length) throw new Error('Select at least one ready shopping list.');
    return { id: crypto.randomUUID(), ...c, payload: JSON.parse(JSON.stringify(payload)) };
  }
  async save(request: ShoppingImportRequest): Promise<ShoppingImportResult> {
    if (!this.current(request)) throw new Error('Workspace changed; preview again.');
    if (!this.store.auth.demo()) {
      const { data, error } = await this.backend.requireClient().rpc('import_shopping_json', {
        entry: request.id,
        w: request.workspace,
        payload: request.payload.map((r) => ({ ...r })),
      });
      if (error) throw error;
      if (!data) throw new Error('Import result unavailable; retry this batch.');
      if (this.current(request)) {
        await this.store.switchWorkspace(this.store.workspace()!);
        if (this.current(request) && this.store.error())
          throw new Error('Import saved, but refresh failed. Retry this batch safely.');
      }
      return data;
    }
    this.context();
    const payload = JSON.stringify([request.workspace, request.user, request.payload]),
      prior = this.batches.get(request.id);
    if (prior) {
      if (prior.payload !== payload) throw new Error('Shopping import request reused.');
      return prior.result;
    }
    if (
      !request.payload.length ||
      request.payload.length > 100 ||
      new Set(request.payload.map((r) => r.source_id)).size !== request.payload.length ||
      request.payload.reduce((n, r) => n + r.items.length, 0) > 500 ||
      new TextEncoder().encode(JSON.stringify(request.payload)).length > 5 * 1024 * 1024
    )
      throw new Error('Check shopping IDs and batch size.');
    const rows = request.payload.map((r) => validateShoppingImportRow(r)),
      review = this.demoReview(rows, request);
    if (review.some((r) => r.state === 'invalid'))
      throw new Error('Source ID contents changed or identifies existing shopping.');
    const lists: ShoppingList[] = [],
      items: ShoppingItem[] = [],
      bindings: [string, string][] = [];
    const result = { lists_imported: 0, items_imported: 0, skipped: 0 },
      now = new Date().toISOString();
    const base = {
      workspace_id: request.workspace,
      owner_id: request.user,
      created_at: now,
      updated_at: now,
    };
    for (const r of rows) {
      if (review.find((v) => v.source_id === r.source_id)!.state === 'duplicate') {
        result.skipped++;
        continue;
      }
      const id = crypto.randomUUID();
      lists.push({
        ...base,
        id,
        visibility: 'private',
        kind: r.kind,
        title: r.title,
        notes: r.notes,
        archived: r.archived,
        revision: 1,
      });
      items.push(
        ...r.items.map((i) => ({
          ...base,
          ...i,
          id: crypto.randomUUID(),
          list_id: id,
          revision: 1,
          checked_by: i.checked ? request.user : null,
          checked_at: i.checked ? now : null,
        })),
      );
      bindings.push([this.key(request, r.source_id), JSON.stringify(r)]);
      result.lists_imported++;
      result.items_imported += r.items.length;
    }
    this.store.shoppingLists.update((v) => [...lists, ...v]);
    this.store.shoppingItems.update((v) => [...items, ...v]);
    bindings.forEach(([k, v]) => this.sources.set(k, v));
    this.batches.set(request.id, { payload, result });
    return result;
  }
}
