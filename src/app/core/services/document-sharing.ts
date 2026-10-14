import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Attachment, DocumentShare } from '../models/domain';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { FileLibrary } from './file-library';

@Injectable({ providedIn: 'root' })
export class DocumentSharing {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private readonly files = inject(FileLibrary);
  readonly rows = signal<DocumentShare[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  private generation = 0;
  private session = -1;
  private readonly demoRows = new Map<string, DocumentShare>();
  private readonly completed = new Set<string>();
  private readonly receipts = new Map<string, string>();
  readonly choices = computed(() =>
    this.store
      .attachments()
      .filter(
        (a) =>
          a.workspace_id === this.store.workspace()?.id &&
          a.owner_id === this.store.profile()?.id &&
          a.bucket_id === 'personal-documents' &&
          ['ready', 'archived'].includes(a.status),
      ),
  );
  readonly recipients = computed(() => {
    const w = this.store.workspace()?.id;
    const members = this.store
      .members()
      .filter((m) => m.workspace_id === w && m.user_id !== this.store.profile()?.id)
      .map((m) => ({
        ...m,
        display_name:
          this.store.taskMembers().find((p) => p.user_id === m.user_id)?.display_name ||
          'Workspace member',
      }));
    return this.store.auth.demo() && w
      ? [
          ...members,
          {
            workspace_id: w,
            user_id: 'demo-reader',
            role: 'viewer' as const,
            display_name: 'Demo reader (simulated)',
          },
        ]
      : members;
  });
  constructor() {
    effect(() => {
      const session = this.store.fileSession();
      const w = this.store.workspace()?.id;
      const user = this.store.profile()?.id;
      const demo = this.store.auth.demo();
      if (session !== this.session) {
        this.demoRows.clear();
        this.receipts.clear();
        this.completed.clear();
        this.session = session;
      }
      this.rows.set([]);
      this.error.set('');
      if (w && user && (demo || user === this.store.auth.user()?.id)) void this.refresh();
      else {
        this.generation++;
        this.loading.set(false);
      }
    });
  }
  private context() {
    const w = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (!w || !user || (!this.store.auth.demo() && user !== this.store.auth.user()?.id))
      throw new Error('Open a workspace while signed in.');
    return { w, user, session };
  }
  private current(c: ReturnType<DocumentSharing['context']>) {
    return (
      c.w === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  async refresh() {
    const c = this.context(),
      generation = ++this.generation;
    this.loading.set(true);
    this.error.set('');
    try {
      const rows: DocumentShare[] = [];
      if (this.store.auth.demo())
        rows.push(
          ...[...this.demoRows.values()].filter(
            (s) =>
              s.workspace_id === c.w &&
              (s.owner_id === c.user || (s.recipient_id === c.user && !s.revoked)),
          ),
        );
      else {
        let after: string | null = null;
        for (;;) {
          const { data, error } = await this.backend
            .requireClient()
            .rpc('document_share_catalog', { w: c.w, after_id: after });
          if (error) throw error;
          const page: DocumentShare[] = data ?? [];
          if (!this.current(c) || generation !== this.generation) return;
          rows.push(...page);
          if (page.length < 500) break;
          const next: string = page.at(-1)!.id;
          if (next === after) throw new Error('Document sharing pagination did not advance.');
          after = next;
        }
      }
      if (this.current(c) && generation === this.generation) this.rows.set(rows);
    } catch (e) {
      if (this.current(c) && generation === this.generation) {
        this.rows.set([]);
        this.error.set(this.store.message(e));
      }
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
  async set(
    req: string,
    id: string,
    source: string,
    recipient: string,
    revision: number | null,
    revoked: boolean,
  ) {
    const c = this.context();
    if (!revoked && !this.store.writable()) throw new Error('Workspace write access required.');
    const file = this.choices().find((a) => a.id === source);
    if (!file) throw new Error('Choose your own completed document version.');
    if (
      recipient === c.user ||
      (!revoked && !this.recipients().some((m) => m.user_id === recipient))
    )
      throw new Error('Choose another current workspace member.');
    const payload = JSON.stringify([id, c.w, source, recipient, revision, revoked]);
    const prior = this.receipts.get(req);
    if (prior && prior !== payload) throw new Error('Request identity was already used.');
    this.receipts.set(req, payload);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_document_share', {
        req,
        entry: id,
        w: c.w,
        source,
        recipient,
        expected_revision: revision,
        is_revoked: revoked,
      });
      if (error) throw error;
    } else {
      const old = this.demoRows.get(id);
      if (
        old &&
        (old.owner_id !== c.user ||
          old.workspace_id !== c.w ||
          old.attachment_id !== source ||
          old.recipient_id !== recipient)
      )
        throw new Error('Document share binding cannot change.');
      if (this.completed.has(req)) {
        await this.refresh();
        return;
      }
      if (old?.revision !== (revision ?? undefined))
        throw new Error('Document sharing changed; refresh and try again.');
      if (
        !old &&
        [...this.demoRows.values()].filter((s) => s.attachment_id === source).length >= 200
      )
        throw new Error('This version already has 200 sharing records.');
      if (!old && revoked) throw new Error('Refresh document shares before changing access.');
      if (
        !old &&
        [...this.demoRows.values()].some(
          (s) => s.attachment_id === source && s.recipient_id === recipient,
        )
      )
        throw new Error(
          'This version already has a sharing record for this member. Restore that record.',
        );
      this.demoRows.set(id, {
        id,
        workspace_id: c.w,
        owner_id: c.user,
        recipient_id: recipient,
        attachment_id: source,
        revoked,
        revision: (old?.revision ?? 0) + 1,
        name: file.name,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        version_number: file.version_number,
        sender_name: this.store.name(),
        recipient_name:
          this.recipients().find((m) => m.user_id === recipient)?.display_name ?? 'Former member',
      });
    }
    if (!this.current(c)) throw new Error('Workspace changed; refresh document sharing.');
    this.completed.add(req);
    if (this.current(c)) {
      await this.refresh();
      if (this.error()) throw new Error(this.error());
    }
  }
  async download(row: DocumentShare) {
    const c = this.context();
    if (
      row.workspace_id !== c.w ||
      row.revoked ||
      !this.rows().some((s) => s.id === row.id && !s.revoked)
    )
      throw new Error('Refresh sharing to check document access.');
    let blob: Blob;
    if (this.store.auth.demo()) {
      const share = this.demoRows.get(row.id);
      if (!share || share.revoked) throw new Error('Document access is unavailable.');
      const file = this.choices().find((a) => a.id === share.attachment_id);
      if (!file) throw new Error('Document is unavailable.');
      blob = await this.files.download(file);
    } else {
      const { data, error } = await this.backend
        .requireClient()
        .functions.invoke('document-download', { body: { share_id: row.id } });
      if (error || !(data instanceof Blob))
        throw new Error('Document access is unavailable; refresh sharing and try again.');
      blob = data;
    }
    if (!this.current(c)) throw new Error('Workspace changed; download cancelled.');
    return new Blob([blob], { type: 'application/octet-stream' });
  }
  async sample() {
    if (!this.store.auth.demo()) throw new Error('Sample documents are available in demo mode.');
    await this.files.upload(
      new File(['LifeOS demo document. No personal information.'], 'Example document.txt', {
        type: 'text/plain',
      }),
      'personal-documents',
      { category: 'Demo', expires_on: '', project_id: '', transaction_id: '' },
    );
  }
  label(a: Attachment) {
    return `${a.name} · version ${a.version_number}${a.status === 'archived' ? ' · archived' : ''}`;
  }
}
