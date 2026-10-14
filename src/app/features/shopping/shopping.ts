import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { ShoppingList, ShoppingItem } from '../../core/models/domain';
import { ShoppingLibrary } from '../../core/services/shopping';
import { UiService } from '../../core/services/ui';
import {
  shoppingCsv,
  validateShoppingItem,
  validateShoppingList,
} from '../../shared/utilities/shopping';
@Component({
  selector: 'app-shopping',
  imports: [DatePipe, DecimalPipe, ReactiveFormsModule, RouterLink],
  templateUrl: './shopping.html',
  styleUrl: './shopping.css',
})
export class ShoppingPage {
  readonly library = inject(ShoppingLibrary);
  readonly store = this.library.store;
  private readonly ui = inject(UiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap);
  readonly linked = computed(() => this.params()?.get('linked') ?? '');
  readonly search = signal('');
  readonly view = signal('current');
  readonly kind = signal('all');
  readonly selectedId = signal('');
  readonly rows = computed(() =>
    this.library
      .lists()
      .filter((l) =>
        this.linked()
          ? l.id === this.linked()
          : l.archived === (this.view() === 'archived') &&
            (this.kind() === 'all' || l.kind === this.kind()) &&
            [l.title, l.notes].join(' ').toLowerCase().includes(this.search().trim().toLowerCase()),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)),
  );
  readonly list = computed(() =>
    this.library.lists().find((l) => l.id === (this.selectedId() || this.linked())),
  );
  readonly itemView = signal('all');
  readonly category = signal('all');
  readonly categories = computed(() =>
    [
      ...new Set(
        (this.list() ? this.library.items(this.list()!) : [])
          .filter((i) => !i.archived)
          .map((i) => i.category),
      ),
    ].sort(),
  );
  readonly items = computed(() =>
    this.list()
      ? this.library
          .items(this.list()!)
          .filter((i) =>
            this.itemView() === 'archived'
              ? i.archived
              : !i.archived &&
                (this.itemView() === 'all' || i.checked === (this.itemView() === 'checked')) &&
                (this.category() === 'all' || i.category === this.category()),
          )
      : [],
  );
  readonly progress = computed(() =>
    this.list()
      ? this.library.progress(this.list()!)
      : { total: 0, checked: 0, remaining: 0, percent: 0 },
  );
  readonly busy = signal(false);
  readonly error = signal('');
  readonly editing = signal(false);
  readonly previous = signal<ShoppingList | undefined>(undefined);
  readonly editingItem = signal<ShoppingItem | undefined>(undefined);
  readonly itemEditor = signal(false);
  readonly form = inject(FormBuilder).nonNullable.group({
    title: [''],
    kind: ['grocery' as ShoppingList['kind']],
    notes: [''],
    visibility: ['private' as ShoppingList['visibility']],
  });
  readonly itemForm = inject(FormBuilder).nonNullable.group({
    name: [''],
    category: ['Other'],
    quantity: ['1'],
    unit: ['items'],
    notes: [''],
  });
  readonly pending = signal<
    | { run: () => Promise<void>; message: string; editor?: 'list' | 'item'; entry?: string }
    | undefined
  >(undefined);
  readonly canChange = computed(
    () =>
      this.store.writable() &&
      !this.store.loading() &&
      !this.store.error() &&
      !this.busy() &&
      !this.pending(),
  );
  readonly canItems = computed(() => this.canChange() && !!this.list() && !this.list()!.archived);
  private readonly context = computed(() =>
    [this.store.workspace()?.id, this.store.profile()?.id, this.store.fileSession()].join(':'),
  );
  private request = crypto.randomUUID();
  private entry: string = crypto.randomUUID();
  private itemRequest = crypto.randomUUID();
  private itemEntry: string = crypto.randomUUID();
  private itemParent: ShoppingList | undefined;
  constructor() {
    effect(() => {
      this.context();
      untracked(() => {
        this.resetDraft();
        this.selectedId.set('');
        this.search.set('');
        this.view.set('current');
        this.kind.set('all');
        this.itemView.set('all');
        this.category.set('all');
      });
    });
  }
  resetDraft() {
    this.form.reset();
    this.itemForm.reset();
    this.editing.set(false);
    this.previous.set(undefined);
    this.itemEditor.set(false);
    this.editingItem.set(undefined);
    this.itemParent = undefined;
    this.pending.set(undefined);
    this.error.set('');
    this.request = crypto.randomUUID();
    this.entry = crypto.randomUUID();
    this.itemRequest = crypto.randomUUID();
    this.itemEntry = crypto.randomUUID();
  }
  create() {
    if (!this.canChange()) return;
    this.resetDraft();
    this.editing.set(true);
  }
  edit(list: ShoppingList) {
    if (!this.canChange() || list.archived || !this.store.canEdit(list)) return;
    this.resetDraft();
    this.previous.set(list);
    this.entry = list.id;
    this.selectedId.set(list.id);
    this.form.reset({
      title: list.title,
      kind: list.kind,
      notes: list.notes,
      visibility: list.visibility,
    });
    this.editing.set(true);
  }
  open(list: ShoppingList) {
    if (this.busy() || this.pending()) return;
    this.resetDraft();
    this.selectedId.set(list.id);
    this.itemView.set('all');
    this.category.set('all');
  }
  async save() {
    if (!this.canChange()) return;
    try {
      const input = validateShoppingList(this.form.getRawValue()),
        request = this.request,
        id = this.entry,
        old = this.previous();
      this.pending.set({
        run: () => this.library.save(request, id, input, old),
        message: old ? 'List updated' : 'List created',
        editor: 'list',
        entry: id,
      });
      await this.retry();
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  startItem(item?: ShoppingItem) {
    if (!this.canItems() || item?.archived) return;
    this.itemParent = this.list();
    this.itemRequest = crypto.randomUUID();
    this.itemEntry = item?.id ?? crypto.randomUUID();
    this.editingItem.set(item);
    this.itemForm.reset({
      name: item?.name ?? '',
      category: item?.category ?? 'Other',
      quantity: String(item?.quantity ?? 1),
      unit: item?.unit ?? 'items',
      notes: item?.notes ?? '',
    });
    this.itemEditor.set(true);
  }
  closeItem() {
    this.itemForm.reset();
    this.itemEditor.set(false);
    this.editingItem.set(undefined);
    this.itemParent = undefined;
  }
  async saveItem() {
    if (!this.canItems() || !this.itemParent) return;
    try {
      const old = this.editingItem(),
        input = { ...this.itemForm.getRawValue(), checked: old?.checked ?? false, archived: false },
        parent = this.itemParent,
        request = this.itemRequest,
        id = this.itemEntry;
      validateShoppingItem(input);
      this.pending.set({
        run: () => this.library.item(request, id, parent, input, old),
        message: old ? 'Item updated' : 'Item added',
        editor: 'item',
      });
      await this.retry();
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  async toggleChecked(item: ShoppingItem, event: Event) {
    const target = event.target as HTMLInputElement,
      checked = target.checked;
    target.checked = item.checked;
    if (!this.canItems() || item.archived) return;
    await this.changeItem(item, checked, item.archived);
  }
  async changeItem(item: ShoppingItem, checked = item.checked, archived = !item.archived) {
    if (!this.canItems()) return;
    const parent = this.list()!,
      request = crypto.randomUUID(),
      input = {
        name: item.name,
        category: item.category,
        quantity: String(item.quantity),
        unit: item.unit,
        notes: item.notes,
        checked,
        archived,
      };
    this.pending.set({
      run: () => this.library.item(request, item.id, parent, input, item),
      message:
        archived !== item.archived
          ? archived
            ? 'Item archived'
            : 'Item restored'
          : checked
            ? 'Item checked'
            : 'Item reopened',
    });
    await this.retry();
  }
  async archive(list: ShoppingList) {
    if (!this.canChange() || !this.store.canEdit(list)) return;
    const request = crypto.randomUUID();
    this.pending.set({
      run: () => this.library.archive(request, list, !list.archived),
      message: list.archived ? 'List restored' : 'List archived',
    });
    await this.retry();
  }
  async retry() {
    const p = this.pending();
    if (!p || this.busy()) return;
    const context = this.context();
    this.busy.set(true);
    this.error.set('');
    try {
      await p.run();
      if (context !== this.context()) return;
      this.ui.notify(p.message);
      if (p.editor === 'list') {
        this.resetDraft();
        this.selectedId.set(p.entry!);
        this.view.set('current');
        this.search.set('');
        this.kind.set('all');
        if (this.linked()) void this.clearLink();
      } else {
        if (p.editor === 'item') this.closeItem();
        this.pending.set(undefined);
      }
    } catch (e) {
      if (context === this.context()) this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  async refresh() {
    if (this.busy() || this.pending() || !this.store.workspace()) return;
    this.resetDraft();
    const context = this.context();
    this.busy.set(true);
    try {
      await this.store.switchWorkspace(this.store.workspace()!);
      if (context === this.context() && this.store.error()) this.error.set(this.store.error());
    } catch (e) {
      if (context === this.context()) this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  exportCsv() {
    if (this.store.loading() || this.store.error() || !this.list() || !this.items().length) return;
    const url = URL.createObjectURL(
        new Blob([shoppingCsv([this.list()!], this.items())], { type: 'text/csv;charset=utf-8' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = 'lifeos-shopping-items.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  clearLink() {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { linked: null },
      queryParamsHandling: 'merge',
    });
  }
}
