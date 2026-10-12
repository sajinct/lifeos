import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
export function contactSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
) {
  describe('Private contacts, links and follow-up delivery', () => {
    let db: PGlite,
      w: string,
      other: string,
      project: string,
      loan: string,
      today: string,
      contact: string;
    type Input = {
      id?: string;
      workspace?: string;
      revision?: number;
      name?: string;
      email?: string;
      phone?: string;
      website?: string;
      due?: string | null;
      last?: string | null;
      projects?: string[];
      loans?: string[];
    };
    async function save(v: Input = {}) {
      const id = v.id ?? randomUUID();
      await db.query(
        'select public.save_contact($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
        [
          id,
          v.workspace ?? w,
          v.revision ?? null,
          v.name ?? 'Synthetic contact',
          'person',
          'Synthetic organization',
          'Professional',
          v.email ?? 'sample@example.com',
          v.phone ?? '+91 555 0100',
          v.website ?? 'https://example.com',
          '',
          'Synthetic test only',
          v.due === undefined ? today : v.due,
          'Discuss the project',
          v.last ?? null,
          v.projects ?? [project],
          v.loans ?? [loan],
        ],
      );
      return id;
    }
    async function row(id = contact) {
      return (
        await db.query<{
          revision: number;
          name: string;
          status: string;
          next_follow_up: string | null;
          last_contacted_on: string | null;
        }>(
          'select revision,name,status,next_follow_up::text,last_contacted_on::text from public.contacts where id=$1',
          [id],
        )
      ).rows[0];
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (await db.query<{ id: string }>("select public.create_workspace('Contact tests') as id"))
        .rows[0].id;
      project = (
        await db.query<{ id: string }>(
          "insert into public.projects(workspace_id,title) values($1,'Contact project') returning id",
          [w],
        )
      ).rows[0].id;
      today = (
        await db.query<{ day: string }>(
          "select (now() at time zone 'Asia/Kolkata')::date::text as day",
        )
      ).rows[0].day;
      loan = randomUUID();
      await db.query(
        "select public.create_loan($1,$2,'Contact loan','Synthetic lender','borrowed','INR',10,0,1,$3,$3,'',null)",
        [loan, w, today],
      );
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      other = (
        await db.query<{ id: string }>("select public.create_workspace('Other contacts') as id")
      ).rows[0].id;
      await asUser(A);
    });
    it('requires owner RPCs and validates contact text, dates and safe web links', async () => {
      await expect(
        db.query(
          'insert into public.contacts(id,workspace_id,owner_id,name,kind) values($1,$2,$3,$4,$5)',
          [randomUUID(), w, A, 'Attack', 'person'],
        ),
      ).rejects.toThrow(/permission denied/);
      for (const v of [
        { name: '' },
        { email: 'bad\n@example.com' },
        { phone: '<script>' },
        { website: 'http://example.com' },
        { website: 'https://user:pass@example.com' },
        { due: '2200-01-01' },
        { last: '2200-01-01' },
        { projects: Array.from({ length: 51 }, () => project) },
      ])
        await expect(save(v)).rejects.toThrow();
      contact = await save();
      expect((await row()).revision).toBe(1);
    });
    it('makes create retries safe and uses integer revisions for stale-edit rejection', async () => {
      await save({ id: contact, name: 'Ignored retry' });
      expect((await row()).name).toBe('Synthetic contact');
      expect(
        (await db.query('select id from public.contact_links where contact_id=$1', [contact])).rows,
      ).toHaveLength(2);
      await save({ id: contact, revision: 1, name: 'Updated contact' });
      expect((await row()).revision).toBe(2);
      await expect(save({ id: contact, revision: 1 })).rejects.toThrow(/changed/);
    });
    it('rejects foreign, cross-workspace and missing links without committing edits', async () => {
      const foreign = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Other owned workspace') as id",
        )
      ).rows[0].id;
      const p = (
        await db.query<{ id: string }>(
          "insert into public.projects(workspace_id,title) values($1,'Separate project') returning id",
          [foreign],
        )
      ).rows[0].id;
      await expect(save({ id: contact, revision: 2, projects: [p] })).rejects.toThrow(
        /Own project/,
      );
      await expect(save({ id: contact, revision: 2, loans: [randomUUID()] })).rejects.toThrow(
        /Own loan/,
      );
      expect((await row()).revision).toBe(2);
      expect(
        (await db.query('select id from public.contact_links where contact_id=$1', [contact])).rows,
      ).toHaveLength(2);
      await save({ id: contact, revision: 2, projects: [], loans: [] });
      expect(
        (await db.query('select id from public.contact_links where contact_id=$1', [contact])).rows,
      ).toHaveLength(0);
    });
    it('keeps private contacts and links invisible to viewers and unrelated owners', async () => {
      await asUser(B);
      expect(
        (await db.query('select id from public.contacts where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.contact_links where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(save({ workspace: w, projects: [], loans: [] })).rejects.toThrow(/write/);
      await expect(
        save({ id: contact, workspace: other, projects: [], loans: [] }),
      ).rejects.toThrow(/inaccessible/);
      await expect(
        db.query("select public.set_contact_status($1,3,'archived')", [contact]),
      ).rejects.toThrow(/owner/);
      await asUser(A);
    });
    it('supports archives and restore with no direct metadata/link writes', async () => {
      await db.query("select public.set_contact_status($1,3,'archived')", [contact]);
      await db.query("select public.set_contact_status($1,3,'archived')", [contact]);
      expect((await row()).revision).toBe(4);
      await expect(save({ id: contact, revision: 4 })).rejects.toThrow(/Restore/);
      await expect(
        db.query('update public.contacts set status=$1 where id=$2', ['active', contact]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query('delete from public.contact_links')).rejects.toThrow(
        /permission denied/,
      );
      await db.query("select public.set_contact_status($1,4,'active')", [contact]);
      expect((await row()).revision).toBe(5);
    });
    it('delivers private follow-up notices once and clears them on completion or archival', async () => {
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,true,1)",
      );
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      await db.query('select public.deliver_due_reminders()');
      expect(
        (
          await db.query<{ title: string }>(
            "select title from public.notifications where source_kind='contact' and source_id=$1 and dismissed_at is null",
            [contact],
          )
        ).rows,
      ).toHaveLength(1);
      await asUser(A);
      await db.query('select public.complete_contact_follow_up($1,5)', [contact]);
      await db.query('select public.complete_contact_follow_up($1,5)', [contact]);
      expect(await row()).toMatchObject({
        revision: 6,
        next_follow_up: null,
        last_contacted_on: today,
      });
      expect(
        (
          await db.query(
            'select id from public.notifications where source_id=$1 and dismissed_at is null',
            [contact],
          )
        ).rows,
      ).toHaveLength(0);
      await save({ id: contact, revision: 6, due: '2100-01-01', projects: [], loans: [] });
      await expect(
        db.query('select public.complete_contact_follow_up($1,5)', [contact]),
      ).rejects.toThrow(/changed/);
      const overdue = await save({ due: '2025-01-01' });
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      expect(
        (
          await db.query<{ title: string }>(
            'select title from public.notifications where source_id=$1',
            [overdue],
          )
        ).rows[0].title,
      ).toBe('Contact follow-up overdue: Synthetic contact');
      await asUser(A);
      await db.query("select public.set_contact_status($1,1,'archived')", [overdue]);
      expect(
        (
          await db.query(
            'select id from public.notifications where source_id=$1 and dismissed_at is null',
            [overdue],
          )
        ).rows,
      ).toHaveLength(0);
    });
    it('preserves contact preferences through legacy RPCs and dismisses notices when disabled', async () => {
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3)",
      );
      expect(
        (
          await db.query<{ contact_reminders: boolean }>(
            'select contact_reminders from public.app_settings where id=$1',
            [A],
          )
        ).rows[0].contact_reminders,
      ).toBe(true);
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1)",
      );
      expect(
        (
          await db.query(
            "select id from public.notifications where source_kind='contact' and owner_id=$1 and dismissed_at is null",
            [A],
          )
        ).rows,
      ).toHaveLength(0);
    });
    it('prevents workspace owners reading member-private contacts and revokes removed-member access', async () => {
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
      const member = await save({ projects: [], loans: [] });
      await expect(save({ projects: [project], loans: [] })).rejects.toThrow(/Own project/);
      await asUser(A);
      expect(
        (await db.query('select id from public.contacts where id=$1', [member])).rows,
      ).toHaveLength(0);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.contacts where id=$1', [member])).rows,
      ).toHaveLength(0);
      await expect(
        db.query('select public.complete_contact_follow_up($1,1)', [member]),
      ).rejects.toThrow(/owner/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.contacts')).rejects.toThrow(/permission denied/);
      await asUser(A);
    });
  });
}
