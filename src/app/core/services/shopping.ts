import { computed, effect, inject, Injectable } from '@angular/core';
import { ShoppingList, ShoppingItem, ShoppingListInput, ShoppingItemInput } from '../models/domain';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import {
  shoppingProgress,
  validateShoppingList,
  validateShoppingItem,
} from '../../shared/utilities/shopping';
@Injectable({ providedIn: 'root' })
export class ShoppingLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private readonly requests = new Map<
    string,
    { w: string; user: string; session: number; payload: string; done: boolean }
  >();
  private requestSession = -1;
  readonly lists = computed(() =>
    this.store
      .shoppingLists()
      .filter((l) => l.workspace_id === this.store.workspace()?.id && this.readable(l)),
  );
  constructor() {
    effect(() => {
      this.store.fileSession();
      this.syncRequests();
    });
  }
  readable(list: ShoppingList) {
    return list.owner_id === this.store.profile()?.id || list.visibility === 'workspace';
  }
  private syncRequests() {
    const s = this.store.fileSession();
    if (s !== this.requestSession) {
      this.requests.clear();
      this.requestSession = s;
    }
  }
  private stamp() {
    return {
      w: this.store.workspace()?.id,
      user: this.store.profile()?.id,
      session: this.store.fileSession(),
    };
  }
  private current(c: ReturnType<ShoppingLibrary['stamp']>) {
    return (
      c.w === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private context(request: string) {
    this.syncRequests();
    const c = this.stamp(),
      old = this.requests.get(request),
      retry = !this.store.auth.demo() && old && this.current(old);
    if (
      !c.w ||
      !c.user ||
      (!this.store.writable() && !retry) ||
      (!this.store.auth.demo() && c.user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { ...c, w: c.w, user: c.user };
  }
  private remember(request: string, c: ReturnType<ShoppingLibrary['context']>, payload: unknown) {
    const p = JSON.stringify(payload),
      old = this.requests.get(request);
    if (
      old &&
      (old.w !== c.w || old.user !== c.user || old.session !== c.session || old.payload !== p)
    )
      throw new Error('Request was already used for another change.');
    this.requests.set(request, { ...c, payload: p, done: old?.done ?? false });
    return !!old?.done;
  }
  private finish(request: string) {
    const r = this.requests.get(request)!;
    this.requests.set(request, { ...r, done: true });
  }
  private async reload(c: ReturnType<ShoppingLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error())
      throw new Error('Shopping change saved, but refresh failed. Retry this change safely.');
  }

  private parent(
    previous: ShoppingList,
    c: ReturnType<ShoppingLibrary['context']>,
    retry: boolean,
  ) {
    const old = this.lists().find((l) => l.id === previous.id);
    if (!this.store.auth.demo() && retry && previous.workspace_id === c.w) return old ?? previous;
    if (!old) throw new Error('Shopping list is inaccessible.');
    return old;
  }
  items(list: ShoppingList) {
    return this.store
      .shoppingItems()
      .filter(
        (i) => i.list_id === list.id && i.workspace_id === list.workspace_id && this.readable(list),
      )
      .sort((a, b) => a.position - b.position);
  }
  progress(list: ShoppingList) {
    return shoppingProgress(this.items(list));
  }
  async save(request: string, id: string, input: ShoppingListInput, previous?: ShoppingList) {
    const c = this.context(request),
      v = validateShoppingList(input),
      retry = this.requests.has(request),
      old = previous ? this.parent(previous, c, retry) : this.lists().find((l) => l.id === id);
    const done = this.remember(request, c, ['list', id, previous?.revision ?? null, v]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_shopping_list', {
        request,
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        list_title: v.title,
        list_kind: v.kind,
        list_notes: v.notes,
        sharing: v.visibility,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (old && !this.store.canEdit(old)) throw new Error('Shopping list is inaccessible.');
    if (done) return;
    if (old && (!previous || old.revision !== previous.revision))
      throw new Error('Shopping list changed; refresh and try again.');
    if (previous && !old) throw new Error('Shopping list is inaccessible.');
    if (old?.archived) throw new Error('Restore the shopping list before editing.');
    if (old && old.kind !== v.kind) throw new Error('List type cannot change.');
    if (old && old.visibility !== v.visibility && old.owner_id !== c.user)
      throw new Error('Only the list creator can change sharing.');
    const now = new Date().toISOString();
    this.store.shoppingLists.update((rows) => [
      {
        ...v,
        id,
        workspace_id: c.w,
        owner_id: old?.owner_id ?? c.user,
        created_at: old?.created_at ?? now,
        updated_at: now,
        revision: old ? old.revision + 1 : 1,
        archived: false,
      },
      ...rows.filter((l) => l.id !== id),
    ]);
    this.finish(request);
  }
  async item(
    request: string,
    id: string,
    list: ShoppingList,
    input: ShoppingItemInput,
    previous?: ShoppingItem,
  ) {
    const c = this.context(request),
      v = validateShoppingItem(input),
      parent = this.parent(list, c, this.requests.has(request)),
      old = this.store.shoppingItems().find((i) => i.id === id),
      done = this.remember(request, c, [
        'item',
        id,
        list.id,
        list.revision,
        previous?.revision ?? null,
        v,
      ]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_shopping_item', {
        request,
        entry: id,
        parent: list.id,
        expected_revision: previous?.revision ?? null,
        expected_parent_revision: list.revision,
        item_name: v.name,
        item_category: v.category,
        item_quantity: v.quantity,
        item_unit: v.unit,
        item_notes: v.notes,
        is_checked: v.checked,
        is_archived: v.archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (!this.readable(parent)) throw new Error('Shopping list is inaccessible.');
    if (done) return;
    if (parent.archived) throw new Error('Restore the shopping list before changing items.');
    if (parent.revision !== list.revision)
      throw new Error('Shopping list changed; refresh and try again.');
    if (old && (old.list_id !== list.id || old.workspace_id !== c.w))
      throw new Error('Shopping item is inaccessible.');
    if (old && (!previous || old.revision !== previous.revision))
      throw new Error('Shopping item changed; refresh and try again.');
    if (previous && !old) throw new Error('Shopping item is inaccessible.');
    if (
      old?.archived &&
      (v.archived ||
        ['name', 'category', 'quantity', 'unit', 'notes', 'checked'].some(
          (k) => v[k as keyof typeof v] !== old[k as keyof ShoppingItem],
        ))
    )
      throw new Error('Restore the item before editing.');
    if (!old && v.archived) throw new Error('New items must be current.');
    const position = old?.position ?? Math.max(0, ...this.items(parent).map((i) => i.position)) + 1;
    if (position > 500)
      throw new Error('A shopping list supports up to 500 items, including archives.');
    const now = new Date().toISOString();
    this.store.shoppingItems.update((rows) => [
      {
        ...v,
        id,
        list_id: list.id,
        workspace_id: c.w,
        owner_id: old?.owner_id ?? c.user,
        position,
        revision: old ? old.revision + 1 : 1,
        created_at: old?.created_at ?? now,
        updated_at: now,
        checked_by: v.checked ? (old?.checked ? old.checked_by : c.user) : null,
        checked_at: v.checked ? (old?.checked ? old.checked_at : now) : null,
      },
      ...rows.filter((i) => i.id !== id),
    ]);
    this.store.shoppingLists.update((rows) =>
      rows.map((l) => (l.id === list.id ? { ...l, revision: l.revision + 1, updated_at: now } : l)),
    );
    this.finish(request);
  }
  async archive(request: string, list: ShoppingList, archived: boolean) {
    const c = this.context(request),
      old = this.parent(list, c, this.requests.has(request)),
      done = this.remember(request, c, ['archive', list.id, list.revision, archived]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_shopping_archived', {
        request,
        entry: list.id,
        expected_revision: list.revision,
        is_archived: archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (!this.store.canEdit(old)) throw new Error('Shopping list is inaccessible.');
    if (done) return;
    if (old.revision !== list.revision)
      throw new Error('Shopping list changed; refresh and try again.');
    if (typeof archived !== 'boolean') throw new Error('Choose archive or restore.');
    this.store.shoppingLists.update((rows) =>
      rows.map((l) =>
        l.id === list.id
          ? { ...l, archived, revision: l.revision + 1, updated_at: new Date().toISOString() }
          : l,
      ),
    );
    this.finish(request);
  }
}
