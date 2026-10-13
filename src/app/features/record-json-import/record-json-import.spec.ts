import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { RecordJsonImportPage } from './record-json-import';
describe('Tasks and Notes import review lifecycle', () => {
  async function setup(calendar = false) {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    if (calendar) TestBed.inject(ActivatedRoute).snapshot.data['calendarImport'] = true;
    const fixture = TestBed.createComponent(RecordJsonImportPage);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.form.controls.text.setValue(
      JSON.stringify({
        events: [
          {
            id: 'event-one',
            title: 'Calendar review meeting',
            starts_at: '2027-01-01T09:00:00+05:30',
            ends_at: '2027-01-01T10:00:00+05:30',
            location: 'Studio',
            color: 'green',
            project_id: 'source-project',
          },
          {
            id: 'event-two',
            title: 'Calendar left out',
            starts_at: '2027-01-02T09:00:00Z',
            ends_at: '2027-01-02T10:00:00Z',
            project_id: null,
          },
        ],
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
  it('uses Calendar-only review, UTC details and row selection while retaining saved mappings on reupload', async () => {
    const { fixture, page, store } = await setup(true);
    expect(fixture.nativeElement.querySelector('h1').textContent).toBe('Import Calendar');
    expect(page.rows().map((r) => r.kind)).toEqual(['event', 'event']);
    expect(fixture.nativeElement.textContent).toContain('Start (UTC): 2027-01-01T03:30:00.000Z');
    expect(fixture.nativeElement.textContent).toContain('Other sections left out: tasks, notes.');
    page.toggle(1);
    await page.save();
    fixture.detectChanges();
    expect(page.result()?.events_imported).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('1 event added');
    expect(store.events().some((e) => e.title === 'Calendar left out')).toBe(false);
    await page.preview();
    fixture.detectChanges();
    expect(page.rows().map((r) => r.state)).toEqual(['duplicate', 'ready']);
    expect(fixture.nativeElement.querySelector('select').value).toBe(store.projects()[0].id);
    expect(fixture.nativeElement.querySelector('select').disabled).toBe(true);
  });
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
