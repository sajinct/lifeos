import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { ShoppingPage } from './shopping';
describe('Shopping page drafts, completion and failure recovery', () => {
  async function setup() {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: UiService, useValue: { notify: vi.fn() } }],
    });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(ShoppingPage);
    fixture.detectChanges();
    return { fixture, page: fixture.componentInstance, store };
  }
  async function create(page: ShoppingPage) {
    page.create();
    page.form.patchValue({ title: 'Weekly shop', notes: '<script>literal</script>' });
    await page.save();
  }
  async function add(page: ShoppingPage) {
    page.startItem();
    page.itemForm.patchValue({ name: 'Milk', category: 'Dairy', quantity: '1.5', unit: 'litres' });
    await page.saveItem();
  }
  it('creates private lists and items and displays literal text with decimal quantities', async () => {
    const { page, store, fixture } = await setup();
    page.view.set('archived');
    page.search.set('hidden');
    await create(page);
    expect(page.rows()).toHaveLength(1);
    expect(store.shoppingLists()[0].visibility).toBe('private');
    await add(page);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('1.5 litres');
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('<script>literal</script>');
  });
  it('checks, filters, archives and restores items and lists', async () => {
    const { page, store } = await setup();
    await create(page);
    await add(page);
    await page.changeItem(store.shoppingItems()[0], true, false);
    expect(page.progress().percent).toBe(100);
    page.itemView.set('remaining');
    expect(page.items()).toHaveLength(0);
    page.itemView.set('checked');
    await page.changeItem(store.shoppingItems()[0]);
    page.itemView.set('archived');
    expect(page.items()).toHaveLength(1);
    await page.changeItem(store.shoppingItems()[0]);
    await page.archive(page.list()!);
    expect(page.canItems()).toBe(false);
    await page.archive(page.list()!);
    expect(page.canItems()).toBe(true);
    expect(store.shoppingItems()[0].checked).toBe(true);
  });
  it('freezes an exact failed item retry and resets a browser-toggled checkbox', async () => {
    const { page, store } = await setup();
    await create(page);
    await add(page);
    const mock = vi.spyOn(page.library, 'item').mockRejectedValueOnce(new Error('Network failed'));
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    await page.toggleChecked(store.shoppingItems()[0], { target: checkbox } as unknown as Event);
    expect(checkbox.checked).toBe(false);
    expect(store.shoppingItems()[0].checked).toBe(false);
    expect(page.pending()).toBeDefined();
    expect(page.canItems()).toBe(false);
    page.itemForm.patchValue({ name: 'Edited after failure' });
    await page.retry();
    expect(mock.mock.calls[1]).toEqual(mock.mock.calls[0]);
    expect(store.shoppingItems()[0].name).toBe('Milk');
    expect(store.shoppingItems()[0].checked).toBe(true);
  });
  it('retains a draft’s parent revision when sharing changes elsewhere', async () => {
    const { page, store } = await setup();
    await create(page);
    page.startItem();
    page.itemForm.patchValue({ name: 'Stale private draft' });
    store.shoppingLists.update((rows) =>
      rows.map((l) => ({ ...l, visibility: 'workspace', revision: l.revision + 1 })),
    );
    await page.saveItem();
    expect(page.error()).toContain('list changed');
    expect(store.shoppingItems()).toHaveLength(0);
  });
  it('clears private drafts, selection and pending changes when workspace changes', async () => {
    const { page, store, fixture } = await setup();
    await create(page);
    page.startItem();
    page.itemForm.patchValue({ name: 'Private draft' });
    await store.createWorkspace('Another shopping workspace', 'personal');
    fixture.detectChanges();
    expect(page.itemForm.controls.name.value).toBe('');
    expect(page.list()).toBeUndefined();
    expect(page.pending()).toBeUndefined();
  });
  it('does not clear an exact pending retry on a same-workspace refresh', async () => {
    const { page, store, fixture } = await setup();
    await create(page);
    vi.spyOn(page.library, 'archive').mockRejectedValue(new Error('Refresh failed'));
    await page.archive(page.list()!);
    const pending = page.pending();
    store.workspace.set({ ...store.workspace()! });
    fixture.detectChanges();
    expect(page.pending()).toBe(pending);
  });
});
