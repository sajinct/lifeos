import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { NotesPage } from './notes';
import { UiService } from '../../core/services/ui';
describe('Notes editor and journal lifecycle', () => {
  async function setup() {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: UiService, useValue: { notify: vi.fn() } }],
    });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(NotesPage);
    fixture.detectChanges();
    return { fixture, page: fixture.componentInstance, store };
  }
  it('saves journals privately and renders note markup as literal text', async () => {
    const { fixture, page, store } = await setup();
    page.create(true);
    page.form.patchValue({ body: '<script>literal text</script>', tags: 'Reflection, ideas' });
    await page.save();
    fixture.detectChanges();
    const journal = store.notes().find((n) => n.journal_on === page.library.today())!;
    expect(journal.visibility).toBe('private');
    expect(journal.tags).toEqual(['ideas', 'reflection']);
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('<script>literal text</script>');
    page.create(true);
    expect(page.previous()?.id).toBe(journal.id);
  });
  it('archives/restores from the UI without discarding body or tags', async () => {
    const { fixture, page, store } = await setup();
    page.create();
    page.form.patchValue({ title: 'Archive review', body: 'Keep this body', tags: 'Planning' });
    await page.save();
    const note = store.notes().find((n) => n.title === 'Archive review')!;
    await page.archive(note);
    page.view.set('archived');
    fixture.detectChanges();
    expect(page.rows().some((n) => n.id === note.id)).toBe(true);
    await page.archive(store.notes().find((n) => n.id === note.id)!);
    page.view.set('active');
    fixture.detectChanges();
    expect(store.notes().find((n) => n.id === note.id)).toMatchObject({
      archived: false,
      body: 'Keep this body',
      tags: ['planning'],
    });
  });
  it('uploads a private file and saves its chosen version with a shared note', async () => {
    const { page, store } = await setup();
    page.create();
    page.form.patchValue({
      title: 'Shared file context',
      body: 'Shared text, private file',
      visibility: 'workspace',
    });
    page.file.set(new File(['hello'], 'context.txt', { type: 'text/plain' }));
    await page.upload();
    expect(page.selectedDocuments()).toHaveLength(1);
    await page.save();
    const note = store.notes().find((n) => n.title === 'Shared file context')!;
    expect(note.visibility).toBe('workspace');
    const linked = page.library.links(note);
    expect(linked[0].visibility).toBe('private');
    expect((await page.files.download(linked[0])).size).toBe(5);
    expect(store.noteDocuments()[0].note_id).toBe(note.id);
  });
  it('clears private drafts, file selections and pending callbacks on workspace changes', async () => {
    const { fixture, page, store } = await setup();
    page.open(store.notes()[0]);
    page.form.controls.body.setValue('Private unsaved draft');
    page.selectedDocuments.set(['old-file']);
    page.pending.set({ run: async () => {}, message: 'Old context' });
    await store.createWorkspace('Other notes editor', 'personal');
    fixture.detectChanges();
    expect(page.editing()).toBe(false);
    expect(page.form.controls.body.value).toBe('');
    expect(page.previous()).toBeUndefined();
    expect(page.pending()).toBeUndefined();
    expect(page.selectedDocuments()).toEqual([]);
  });
  it('shows a newly saved note even when the previous filters would hide it', async () => {
    const { page } = await setup();
    page.view.set('archived');
    page.search.set('unrelated text');
    page.tag.set('other');
    page.kind.set('journal');
    page.create();
    page.form.patchValue({ title: 'Visible new note', body: 'Saved successfully' });
    await page.save();
    expect(page.rows().some((n) => n.title === 'Visible new note')).toBe(true);
  });
});
