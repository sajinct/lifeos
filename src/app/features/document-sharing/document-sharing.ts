import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DocumentShare } from '../../core/models/domain';
import { DocumentSharing } from '../../core/services/document-sharing';
import { fileSize } from '../../shared/utilities/files';
@Component({
  selector: 'app-document-sharing',
  imports: [FormsModule, RouterLink],
  templateUrl: './document-sharing.html',
  styleUrl: './document-sharing.css',
})
export class DocumentSharingPage {
  readonly library = inject(DocumentSharing);
  readonly store = this.library.store;
  readonly source = signal('');
  readonly recipient = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly filter = signal('active');
  readonly size = fileSize;
  readonly sent = computed(() =>
    this.library
      .rows()
      .filter(
        (s) => s.owner_id === this.store.profile()?.id && (this.filter() === 'all' || !s.revoked),
      ),
  );
  readonly received = computed(() =>
    this.library.rows().filter((s) => s.recipient_id === this.store.profile()?.id && !s.revoked),
  );
  private draft: {
    req: string;
    id: string;
    source: string;
    recipient: string;
    revision: number | null;
    revoked: boolean;
  } | null = null;
  constructor() {
    effect(() => {
      void this.store.workspace()?.id;
      void this.store.profile()?.id;
      this.store.fileSession();
      this.source.set('');
      this.recipient.set('');
      this.error.set('');
      this.message.set('');
      this.draft = null;
    });
  }
  resetDraft() {
    this.draft = null;
    this.error.set('');
  }
  async share() {
    await this.perform(async () => {
      if (!this.source() || !this.recipient())
        throw new Error('Choose a document version and a recipient.');
      const old = this.library
        .rows()
        .find(
          (s) =>
            s.owner_id === this.store.profile()?.id &&
            s.attachment_id === this.source() &&
            s.recipient_id === this.recipient(),
        );
      if (old && !old.revoked) throw new Error('This version is already shared with that member.');
      if (
        this.draft &&
        (this.draft.revoked ||
          this.draft.source !== this.source() ||
          this.draft.recipient !== this.recipient())
      )
        this.draft = null;
      this.draft ??= {
        req: crypto.randomUUID(),
        id: old?.id ?? crypto.randomUUID(),
        source: this.source(),
        recipient: this.recipient(),
        revision: old?.revision ?? null,
        revoked: false,
      };
      const d = this.draft;
      await this.library.set(d.req, d.id, d.source, d.recipient, d.revision, d.revoked);
      this.draft = null;
      this.message.set(
        this.library.rows().find((s) => s.id === d.id)?.revoked
          ? 'This share is currently revoked. Refresh access before restoring it.'
          : 'Selected version shared with this member.',
      );
    });
  }
  async change(row: DocumentShare) {
    await this.perform(async () => {
      const revoked = !row.revoked;
      if (!this.draft || this.draft.id !== row.id || this.draft.revoked !== revoked)
        this.draft = {
          req: crypto.randomUUID(),
          id: row.id,
          source: row.attachment_id,
          recipient: row.recipient_id,
          revision: row.revision,
          revoked,
        };
      const d = this.draft;
      await this.library.set(d.req, d.id, d.source, d.recipient, d.revision, d.revoked);
      this.draft = null;
      const actual = this.library.rows().find((s) => s.id === d.id);
      this.message.set(
        actual && actual.revoked !== revoked
          ? 'Sharing refreshed; another change has already updated access. Review the current status.'
          : revoked
            ? 'Access revoked. Saved copies remain with the recipient.'
            : 'Access restored to the selected version.',
      );
    });
  }
  async download(row: DocumentShare) {
    await this.perform(async () => {
      const blob = await this.library.download(row),
        url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = row.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.message.set('Download started.');
    });
  }
  canRestore(row: DocumentShare) {
    return this.library.recipients().some((m) => m.user_id === row.recipient_id);
  }
  async sample() {
    await this.perform(() => this.library.sample());
  }
  async refresh() {
    this.draft = null;
    await this.library.refresh();
  }
  private async perform(action: () => Promise<void>) {
    if (this.busy()) return;
    const context = JSON.stringify([
      this.store.workspace()?.id,
      this.store.profile()?.id,
      this.store.fileSession(),
    ]);
    const current = () =>
      context ===
      JSON.stringify([
        this.store.workspace()?.id,
        this.store.profile()?.id,
        this.store.fileSession(),
      ]);
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      await action();
      if (!current()) {
        this.message.set('');
        this.error.set('');
      }
    } catch (e) {
      if (current()) this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
