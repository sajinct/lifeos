import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { RecordJsonImportPage } from './record-json-import';
describe('Tasks and Notes import review lifecycle', () => {
  async function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(RecordJsonImportPage);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.form.controls.text.setValue(
      JSON.stringify({
        projects: [{ id: 'source-project', title: 'Source project' }],
        tasks: [
          {
            id: 'task',
            title: 'Import test task',
            status: 'todo',
            priority: 'low',
            due_date: null,
            project_id: 'source-project',
          },
        ],
        notes: [
          { id: 'note', title: 'Import test note', body: 'Body', project_id: 'source-project' },
        ],
      }),
    );
    await page.preview();
    page.mapping.set({ 'source-project': store.projects()[0].id });
    page.rebuild();
    fixture.detectChanges();
    return { fixture, page, store };
  }
  it('renders the chosen project and preserves selected-row filtering', async () => {
    const { fixture, page, store } = await setup();
    expect(fixture.nativeElement.querySelector('select').value).toBe(store.projects()[0].id);
    page.toggle(1);
    await page.save();
    expect(page.result()).toEqual({ tasks_imported: 1, notes_imported: 0, skipped: 0 });
    fixture.detectChanges();
    await page.preview();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('select').value).toBe(store.projects()[0].id);
    expect(fixture.nativeElement.querySelector('select').disabled).toBe(true);
    expect(page.rows().map((r) => r.state)).toEqual(['duplicate', 'ready']);
  });
  it('keeps the exact batch for retry and locks edits after a failed request', async () => {
    const { fixture, page } = await setup();
    const save = vi
      .spyOn(page.importer, 'save')
      .mockRejectedValueOnce(new Error('Connection failed'))
      .mockResolvedValueOnce({ tasks_imported: 1, notes_imported: 1, skipped: 0 });
    await page.save();
    fixture.detectChanges();
    const pending = page.pending();
    expect(pending).not.toBeNull();
    expect(fixture.nativeElement.querySelector('textarea').disabled).toBe(true);
    await page.save();
    expect(save.mock.calls[1][0]).toBe(pending);
    expect(page.result()?.notes_imported).toBe(1);
  });
  it('discards private previews, file reads and retry state when a session resets', async () => {
    const { fixture, page, store } = await setup();
    let finish!: (v: ArrayBuffer) => void;
    const input = {
      value: 'old.json',
      files: [
        {
          size: 20,
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((resolve) => {
              finish = resolve;
            }),
        },
      ],
    };
    const reading = page.file({ target: input } as unknown as Event);
    store.clear();
    fixture.detectChanges();
    finish(new TextEncoder().encode('old private data').buffer);
    await reading;
    expect(page.source()).toBeNull();
    expect(page.rows()).toEqual([]);
    expect(page.pending()).toBeNull();
    expect(page.form.controls.text.value).toBe('');
    expect(page.busy()).toBe(false);
  });
});
