import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
export function householdSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Household sharing, links and personal reminders', () => {
    let db: PGlite,
      w: string,
      other: string,
      privateMember: string,
      sharedMember: string,
      task: string,
      date: string,
      today: string;
    async function member(
      input: {
        id?: string;
        workspace?: string;
        revision?: number;
        name?: string;
        birthday?: string | null;
        visibility?: string;
      } = {},
    ) {
      const id = input.id ?? randomUUID();
      await db.query('select public.save_household_member($1,$2,$3,$4,$5,$6,$7,$8)', [
        id,
        input.workspace ?? w,
        input.revision ?? null,
        input.name ?? 'Sample family member',
        'Housemate',
        input.birthday === undefined ? today.slice(5) : input.birthday,
        'Synthetic only',
        input.visibility ?? 'private',
      ]);
      return id;
    }
    async function entry(
      input: {
        id?: string;
        workspace?: string;
        revision?: number;
        kind?: string;
        due?: string | null;
        annual?: boolean;
        member?: string | null;
        visibility?: string;
      } = {},
    ) {
      const id = input.id ?? randomUUID();
      await db.query('select public.save_household_entry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
        id,
        input.workspace ?? w,
        input.revision ?? null,
        'Sample responsibility',
        input.kind ?? 'task',
        input.due === undefined ? today : input.due,
        input.annual ?? false,
        input.member ?? null,
        'Synthetic only',
        input.visibility ?? 'private',
      ]);
      return id;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Household checks','family') as id",
        )
      ).rows[0].id;
      today = (
        await db.query<{ day: string }>("select (now() at time zone 'UTC')::date::text as day")
      ).rows[0].day;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
      await asUser(B);
      other = (
        await db.query<{ id: string }>("select public.create_workspace('Other household') as id")
      ).rows[0].id;
      await asUser(A);
    });
    it('denies direct writes, validates birthdays and keeps account memberships unchanged', async () => {
      for (const table of ['household_members', 'household_entries'])
        await expect(db.query(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
      for (const birthday of ['02-30', '13-01', '01-00', '2020-01-01'])
        await expect(member({ birthday })).rejects.toThrow();
      await expect(member({ name: '' })).rejects.toThrow(/Invalid/);
      await expect(entry({ kind: 'date', due: null })).rejects.toThrow(/Invalid/);
      await expect(entry({ annual: true })).rejects.toThrow(/Invalid/);
      await expect(entry({ due: '2200-01-01' })).rejects.toThrow(/Invalid/);
      privateMember = await member();
      sharedMember = await member({ visibility: 'workspace' });
      expect(
        (await db.query('select user_id from public.workspace_members where workspace_id=$1', [w]))
          .rows,
      ).toHaveLength(3);
    });
    it('makes creation retries idempotent and rejects stale edits', async () => {
      await member({ id: privateMember, name: 'Ignored retry' });
      expect(
        (
          await db.query<{ name: string }>(
            'select name from public.household_members where id=$1',
            [privateMember],
          )
        ).rows[0].name,
      ).toBe('Sample family member');
      await member({ id: privateMember, revision: 1, name: 'Edited person' });
      await expect(member({ id: privateMember, revision: 1 })).rejects.toThrow(/changed/);
      task = await entry({ member: sharedMember, visibility: 'workspace' });
      await entry({ id: task });
      expect(
        (
          await db.query<{ revision: number }>(
            'select revision from public.household_entries where id=$1',
            [task],
          )
        ).rows[0].revision,
      ).toBe(1);
    });
    it('prevents private member names being linked into shared entries, including atomic edits', async () => {
      await expect(entry({ member: privateMember, visibility: 'workspace' })).rejects.toThrow(
        /matching sharing/,
      );
      await expect(
        entry({ id: task, revision: 1, member: privateMember, visibility: 'workspace' }),
      ).rejects.toThrow(/matching sharing/);
      expect(
        (
          await db.query<{ member_id: string }>(
            'select member_id from public.household_entries where id=$1',
            [task],
          )
        ).rows[0].member_id,
      ).toBe(sharedMember);
      await expect(member({ id: sharedMember, revision: 1 })).rejects.toThrow(/Unlink/);
      await asUser(B);
      const foreign = await member({ workspace: other });
      await asUser(A);
      await expect(entry({ member: foreign })).rejects.toThrow(/accessible/);
      await expect(entry({ member: randomUUID() })).rejects.toThrow(/accessible/);
    });
    it('lets viewers read shared records, without private reads or writes', async () => {
      await asUser(C);
      expect(
        (await db.query('select id from public.household_members where workspace_id=$1', [w])).rows,
      ).toEqual([{ id: sharedMember }]);
      expect(
        (await db.query('select id from public.household_entries where workspace_id=$1', [w])).rows,
      ).toEqual([{ id: task }]);
      await expect(member()).rejects.toThrow(/write/);
      await expect(
        db.query("select public.set_household_status('entry',$1,1,'done')", [task]),
      ).rejects.toThrow(/write/);
      await asUser(A);
    });
    it('prevents other editors editing shared records or hijacking creation IDs', async () => {
      await asUser(B);
      await expect(entry({ id: task, revision: 1, visibility: 'workspace' })).rejects.toThrow(
        /inaccessible/,
      );
      await expect(entry({ id: task, visibility: 'workspace' })).rejects.toThrow(/inaccessible/);
      await expect(member({ id: privateMember, workspace: other })).rejects.toThrow(/inaccessible/);
      await expect(entry({ member: privateMember })).rejects.toThrow(/accessible/);
      await asUser(A);
    });
    it('allows workspace owners to edit shared content but only creators may change sharing', async () => {
      await asUser(B);
      const shared = await member({ visibility: 'workspace' }),
        personal = await member();
      await asUser(A);
      expect(
        (await db.query('select id from public.household_members where id=$1', [personal])).rows,
      ).toHaveLength(0);
      await expect(member({ id: shared, revision: 1, visibility: 'private' })).rejects.toThrow(
        /creator/,
      );
      await expect(member({ id: shared, visibility: 'workspace' })).rejects.toThrow(/inaccessible/);
      await member({ id: shared, revision: 1, visibility: 'workspace', name: 'Owner correction' });
      await expect(member({ id: personal, revision: 1 })).rejects.toThrow(/inaccessible/);
    });
    it('handles completion, reopen, archives and retries without losing links', async () => {
      await db.query("select public.set_household_status('entry',$1,1,'done')", [task]);
      await db.query("select public.set_household_status('entry',$1,1,'done')", [task]);
      await expect(entry({ id: task, revision: 2 })).rejects.toThrow(/Reopen/);
      await db.query("select public.set_household_status('entry',$1,2,'active')", [task]);
      await expect(
        db.query("select public.set_household_status('entry',$1,1,'done')", [task]),
      ).rejects.toThrow(/changed/);
      await db.query("select public.set_household_status('member',$1,1,'archived')", [
        sharedMember,
      ]);
      await expect(entry({ member: sharedMember, visibility: 'workspace' })).rejects.toThrow(
        /accessible/,
      );
      await entry({ id: task, revision: 3, member: sharedMember, visibility: 'workspace' });
      await db.query("select public.set_household_status('member',$1,2,'active')", [sharedMember]);
      date = await entry({ kind: 'date', annual: true });
      await expect(
        db.query("select public.set_household_status('entry',$1,1,'done')", [date]),
      ).rejects.toThrow(/Invalid/);
      await expect(
        db.query("select public.set_household_status('member',$1,3,'done')", [sharedMember]),
      ).rejects.toThrow(/Invalid/);
    });
    it('computes annual occurrences and February 29 without drifting their anchors', async () => {
      await db.exec('reset role');
      for (const [anchor, day, expected] of [
        ['2000-02-29', '2027-02-28', '2027-02-28'],
        ['2000-02-29', '2027-03-01', '2028-02-29'],
        ['2000-12-31', '2026-12-31', '2026-12-31'],
        ['2000-01-01', '2026-12-31', '2027-01-01'],
      ])
        expect(
          (
            await db.query<{ day: string }>(
              'select private.household_anniversary($1,$2)::text as day',
              [anchor, day],
            )
          ).rows[0].day,
        ).toBe(expected);
      await asUser(A);
    });
    it('delivers opt-in reminders once to creators only and dismisses completed and archived sources', async () => {
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,true,7)",
      );
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      await db.query('select public.deliver_due_reminders()');
      const notices = (
        await db.query<{ owner_id: string; visibility: string; source_kind: string }>(
          'select owner_id,visibility,source_kind from public.notifications where source_id=$1 and dismissed_at is null',
          [task],
        )
      ).rows;
      expect(notices).toEqual([{ owner_id: A, visibility: 'private', source_kind: 'family_task' }]);
      expect(
        (
          await db.query(
            'select id from public.notifications where source_id=$1 and dismissed_at is null',
            [sharedMember],
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await db.query(
            'select id from public.notifications where source_id=$1 and dismissed_at is null',
            [date],
          )
        ).rows,
      ).toHaveLength(1);
      await asUser(C);
      expect(
        (await db.query('select id from public.notifications where source_id=$1', [task])).rows,
      ).toHaveLength(0);
      await asUser(A);
      await db.query("select public.set_household_status('entry',$1,4,'done')", [task]);
      await db.query("select public.set_household_status('member',$1,3,'archived')", [
        sharedMember,
      ]);
      for (const id of [task, sharedMember])
        expect(
          (
            await db.query(
              'select id from public.notifications where source_id=$1 and dismissed_at is null',
              [id],
            )
          ).rows,
        ).toHaveLength(0);
    });
    it('preserves family preferences through legacy settings and clears notifications on opt-out', async () => {
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1)",
      );
      expect(
        (
          await db.query<{ family_reminders: boolean }>(
            'select family_reminders from public.app_settings where id=$1',
            [A],
          )
        ).rows[0].family_reminders,
      ).toBe(true);
      await expect(
        db.query(
          "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,true,91)",
        ),
      ).rejects.toThrow();
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7)",
      );
      expect(
        (
          await db.query(
            "select id from public.notifications where owner_id=$1 and source_kind like 'family_%' and dismissed_at is null",
            [A],
          )
        ).rows,
      ).toHaveLength(0);
    });
    it('revokes removed-member access, and denies anonymous RPCs and scheduler execution', async () => {
      await asUser(B);
      const id = await member();
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.household_members where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(member({ id, revision: 1 })).rejects.toThrow(/write/);
      await expect(db.query('select public.deliver_due_reminders()')).rejects.toThrow(
        /permission denied/,
      );
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.household_members')).rejects.toThrow(
        /permission denied/,
      );
      await expect(member()).rejects.toThrow(/permission denied/);
      await asUser(A);
    });
  });
}
