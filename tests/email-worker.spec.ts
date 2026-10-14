import { describe, it, expect, vi } from 'vitest';
import {
  createEmailHandler,
  sendResend,
  senderAddress,
  EmailJob,
} from '../supabase/functions/email-dispatch/worker';
const secret = 'a'.repeat(64),
  job: EmailJob = {
    id: 'synthetic-mail',
    lease: 'synthetic-lease',
    payload: {
      from: 'sender@example.test',
      to: ['owner@example.test'],
      subject: 'Private subject',
      text: 'Private content',
    },
  };
const env = {
  dispatchKey: secret,
  resendKey: 're_test_only',
  sender: 'LifeOS <sender@example.test>',
};
const input = (body = '{}', key = secret) =>
  new Request('https://example.test/email-dispatch', {
    method: 'POST',
    headers: { 'x-lifeos-dispatch-key': key },
    body,
  });
describe('Scheduler-only email worker', () => {
  it('rejects missing/wrong scheduler credentials and malformed bodies before database/provider access', async () => {
    const rpc = vi.fn(),
      transport = vi.fn(),
      handler = createEmailHandler(env, rpc, transport as typeof fetch);
    for (const req of [
      input('{}', 'user-token'),
      input('{}', 'b'.repeat(64)),
      input('{"to":"someone@example.test"}'),
      input('not json'),
    ])
      expect((await handler(req)).status).toBeGreaterThanOrEqual(400);
    expect((await handler(new Request('https://example.test'))).status).toBe(405);
    expect(rpc).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it('probes server configuration without queueing or sending and disables readiness for absent secrets', async () => {
    const rpc = vi.fn().mockResolvedValue(null),
      transport = vi.fn();
    expect(
      (await createEmailHandler(env, rpc, transport as typeof fetch)(input('{"mode":"probe"}')))
        .status,
    ).toBe(200);
    expect(rpc.mock.calls).toEqual([['set_email_delivery_ready', { available: true }]]);
    rpc.mockClear();
    expect((await createEmailHandler({ ...env, resendKey: undefined }, rpc)(input())).status).toBe(
      503,
    );
    expect(rpc.mock.calls).toEqual([['set_email_delivery_ready', { available: false }]]);
    expect(transport).not.toHaveBeenCalled();
    expect(senderAddress('Sender\n<sender@example.test>')).toBeNull();
  });
  it('sends a frozen payload with a stable idempotency key and records provider acceptance without leaking private content', async () => {
    let claims = 0;
    const rpc = vi.fn(async (name: string) =>
        name === 'claim_email_delivery'
          ? claims++ === 0
            ? job
            : null
          : name === 'queue_email_deliveries'
            ? 1
            : null,
      ),
      transport = vi.fn().mockResolvedValue(new Response('{"id":"provider-id"}', { status: 200 }));
    const result = await createEmailHandler(env, rpc, transport as typeof fetch, async () => {})(
      input(),
    );
    expect(await result.json()).toMatchObject({ accepted: 1, processed: 1 });
    expect(transport.mock.calls[0][1].headers['Idempotency-Key']).toBe(
      'lifeos-email/synthetic-mail',
    );
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual(job.payload);
    expect(rpc).toHaveBeenCalledWith(
      'finish_email_delivery',
      expect.objectContaining({
        entry: job.id,
        lease: job.lease,
        outcome: 'accepted',
        provider: 'provider-id',
      }),
    );
    expect(
      JSON.stringify(
        await (
          await createEmailHandler(env, vi.fn().mockResolvedValue(null))(input('{"mode":"probe"}'))
        ).json(),
      ),
    ).not.toContain('Private');
  });
  it('classifies rate limits, provider rejections, unknown network outcomes and idempotency conflicts without echoing provider errors', async () => {
    for (const [status, outcome, code] of [
      [429, 'retry', 'provider_rate_limited'],
      [503, 'retry', 'provider_server_error'],
      [403, 'failed', 'provider_rejected'],
      [409, 'uncertain', 'provider_idempotency_conflict'],
    ] as const) {
      expect(
        await sendResend(
          job,
          env.resendKey,
          vi
            .fn()
            .mockResolvedValue(new Response('private provider detail', { status })) as typeof fetch,
        ),
      ).toEqual({ outcome, provider: null, code });
    }
    expect(
      await sendResend(
        job,
        env.resendKey,
        vi.fn().mockRejectedValue(new Error('private transport detail')) as typeof fetch,
      ),
    ).toMatchObject({ outcome: 'retry', code: 'network_outcome_unknown' });
    expect(
      await sendResend(
        job,
        env.resendKey,
        vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) as typeof fetch,
      ),
    ).toMatchObject({ outcome: 'retry' });
  });
  it('leaves a claimed job safely recoverable when recording an accepted result fails', async () => {
    const rpc = vi.fn(async (name: string) => {
        if (name === 'claim_email_delivery') return job;
        if (name === 'finish_email_delivery') throw new Error('database unavailable');
        return 1;
      }),
      transport = vi.fn().mockResolvedValue(new Response('{"id":"provider-id"}', { status: 200 }));
    expect(
      (await createEmailHandler(env, rpc, transport as typeof fetch, async () => {})(input()))
        .status,
    ).toBe(503);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
