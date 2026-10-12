import { Injectable, effect, inject } from '@angular/core';
import { Attachment, FileBucket, FileDetails } from '../models/domain';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { safeFileName, validateFile } from '../../shared/utilities/files';

@Injectable({ providedIn: 'root' })
export class FileLibrary {
  private readonly backend = inject(Backend);
  readonly store = inject(LifeStore);
  private readonly demoFiles = new Map<string, Blob>();
  private demoSession = -1;
  private syncSession() {
    const session = this.store.fileSession();
    if (session !== this.demoSession || !this.store.auth.demo()) this.demoFiles.clear();
    this.demoSession = session;
  }
  constructor() {
    effect(() => this.syncSession());
  }
  private userId() {
    this.syncSession();
    return this.store.auth.demo() ? 'demo-user' : this.store.auth.user()?.id;
  }
  private assertOwned(row: Attachment, write = true) {
    if (
      row.owner_id !== this.userId() ||
      row.workspace_id !== this.store.workspace()?.id ||
      (write && !this.store.canEdit(row))
    )
      throw new Error('Open this file in a workspace you can access.');
  }
  private publish(row: Attachment) {
    if (row.owner_id === this.userId() && row.workspace_id === this.store.workspace()?.id)
      this.store.attachments.update((list) => [row, ...list.filter((a) => a.id !== row.id)]);
  }
  private validateDetails(details: FileDetails, bucket: FileBucket) {
    if (!details.category.trim() || details.category.trim().length > 100)
      throw new Error('Enter a category up to 100 characters.');
    if (
      details.expires_on &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(details.expires_on) ||
        Number.isNaN(Date.parse(details.expires_on)) ||
        new Date(details.expires_on + 'T00:00:00Z').toISOString().slice(0, 10) !==
          details.expires_on)
    )
      throw new Error('Choose a valid expiry date.');
    if (details.project_id && !this.store.projects().some((p) => p.id === details.project_id))
      throw new Error('Choose an accessible project.');
    if (
      details.transaction_id &&
      (bucket !== 'financial-receipts' ||
        !this.store
          .transactions()
          .some((t) => t.id === details.transaction_id && t.owner_id === this.userId()))
    )
      throw new Error('Choose a finance entry you own.');
  }
  async upload(file: File, bucket: FileBucket, details: FileDetails, previous?: Attachment) {
    if (!this.store.workspace() || !this.store.writable())
      throw new Error('Select a workspace with write access.');
    const format = validateFile(file, bucket);
    this.validateDetails(details, bucket);
    if (previous) {
      this.assertOwned(previous);
      if (previous.bucket_id !== bucket || !['ready', 'archived'].includes(previous.status))
        throw new Error('Choose a completed version in the same library.');
    }
    const id = crypto.randomUUID();
    const row: Attachment = {
      id,
      workspace_id: this.store.workspace()!.id,
      owner_id: this.userId()!,
      visibility: 'private',
      name: safeFileName(file.name),
      object_path: `${this.userId()}/${this.store.workspace()!.id}/${id}.${format.extension}`,
      mime_type: format.mime,
      size_bytes: file.size,
      bucket_id: bucket,
      status: 'uploading',
      category: details.category.trim(),
      expires_on: details.expires_on || null,
      project_id: details.project_id || null,
      transaction_id: details.transaction_id || null,
      previous_version_id: previous?.id ?? null,
      version_number: previous ? previous.version_number + 1 : 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    let saved = row;
    if (!this.store.auth.demo()) {
      const { data, error } = await this.backend
        .requireClient()
        .from('attachments')
        .insert(row)
        .select('*')
        .single();
      if (error) throw error;
      saved = data;
    } else if (
      previous &&
      this.store.attachments().some((a) => a.previous_version_id === previous.id)
    )
      throw new Error(
        'A newer version already exists. Open that version or cancel its unfinished upload.',
      );
    this.publish(saved);
    await this.retryUpload(saved, file, false);
  }
  async retryUpload(row: Attachment, file: File, checkExisting = true) {
    this.assertOwned(row);
    if (row.status !== 'uploading') throw new Error('This upload is no longer unfinished.');
    const format = validateFile(file, row.bucket_id);
    if (
      format.mime !== row.mime_type ||
      file.size !== Number(row.size_bytes) ||
      safeFileName(file.name) !== row.name
    )
      throw new Error('Choose the same filename, file type and size to retry.');
    if (this.store.auth.demo()) this.demoFiles.set(row.id, file);
    else {
      if (checkExisting) {
        try {
          await this.finish(row);
          return;
        } catch (error) {
          if (
            !this.store
              .message(error)
              .startsWith('Uploaded file not found or metadata does not match')
          )
            throw error;
        }
      }
      const { error } = await this.backend
        .requireClient()
        .storage.from(row.bucket_id)
        .upload(row.object_path, file, {
          contentType: row.mime_type,
          cacheControl: '0',
          upsert: false,
        });
      if (error) {
        // Only the database can confirm that an interrupted request actually stored the file.
        try {
          await this.finish(row);
          return;
        } catch {
          throw new Error(
            `Upload interrupted. Retry from Unfinished uploads. ${this.store.message(error)}`,
          );
        }
      }
    }
    await this.finish(row);
  }
  async finish(row: Attachment) {
    this.assertOwned(row);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('complete_attachment', { upload: row.id });
      if (error) throw error;
    } else if (!this.demoFiles.has(row.id))
      throw new Error('Choose the file to retry this upload.');
    this.publish({ ...row, status: 'ready' });
    if (
      row.previous_version_id &&
      row.workspace_id === this.store.workspace()?.id &&
      row.owner_id === this.userId()
    )
      this.store.attachments.update((list) =>
        list.map((a) => (a.id === row.previous_version_id ? { ...a, status: 'archived' } : a)),
      );
  }
  async archive(row: Attachment, restore = false) {
    this.assertOwned(row);
    if (!['ready', 'archived'].includes(row.status)) throw new Error('Complete the upload first.');
    const status = restore ? 'ready' : 'archived';
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('set_attachment_status', { upload: row.id, target: status });
      if (error) throw error;
    }
    this.publish({ ...row, status });
  }
  async edit(row: Attachment, details: FileDetails) {
    this.assertOwned(row);
    this.validateDetails(details, row.bucket_id);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('update_attachment_details', {
        upload: row.id,
        file_category: details.category.trim(),
        expiry: details.expires_on || null,
        project: details.project_id || null,
        ledger_entry: details.transaction_id || null,
      });
      if (error) throw error;
    }
    this.publish({
      ...row,
      category: details.category.trim(),
      expires_on: details.expires_on || null,
      project_id: details.project_id || null,
      transaction_id: details.transaction_id || null,
    });
  }
  async discard(row: Attachment) {
    this.assertOwned(row);
    if (!['uploading', 'cancelled'].includes(row.status))
      throw new Error('Completed files can be archived and restored.');
    if (!this.store.auth.demo()) {
      const c = this.backend.requireClient();
      const cancel = await c.rpc('cancel_attachment_upload', { upload: row.id });
      if (cancel.error) throw cancel.error;
      this.publish({ ...row, status: 'cancelled' });
      const cleanup = await c.storage.from(row.bucket_id).remove([row.object_path]);
      if (cleanup.error)
        throw new Error('Cleanup interrupted. Retry cleanup from Unfinished uploads.');
      const metadata = await c.rpc('remove_cancelled_attachment', { upload: row.id });
      if (metadata.error) throw metadata.error;
    } else this.demoFiles.delete(row.id);
    if (row.workspace_id === this.store.workspace()?.id && row.owner_id === this.userId())
      this.store.attachments.update((list) => list.filter((a) => a.id !== row.id));
  }
  async download(row: Attachment): Promise<Blob> {
    this.assertOwned(row, false);
    if (!['ready', 'archived'].includes(row.status))
      throw new Error('Complete this upload before downloading.');
    let blob: Blob;
    if (this.store.auth.demo()) {
      const file = this.demoFiles.get(row.id);
      if (!file) throw new Error('This demo file is no longer available.');
      blob = file;
    } else {
      const { data, error } = await this.backend
        .requireClient()
        .storage.from(row.bucket_id)
        .download(row.object_path);
      if (error) throw error;
      blob = data;
    }
    this.assertOwned(row, false);
    return new Blob([blob], { type: 'application/octet-stream' });
  }
}
