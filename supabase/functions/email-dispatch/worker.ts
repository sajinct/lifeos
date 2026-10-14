export type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export interface EmailJob {
  id: string;
  lease: string;
  payload: { from: string; to: string[]; subject: string; text: string };
}
export interface EmailEnvironment {
  dispatchKey?: string;
  resendKey?: string;
  sender?: string;
}
type Outcome = {
  outcome: 'accepted' | 'retry' | 'failed' | 'uncertain';
  provider: string | null;
  code: string | null;
};
const response = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
function equalSecret(actual: string, expected: string) {
  if (actual.length !== 64 || expected.length !== 64) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}
export function senderAddress(value: string | undefined) {
  if (!value || value.length > 320 || /[\r\n]/.test(value)) return null;
  const address = (value.match(/^[^<>]+<([^<>]+)>$/)?.[1] ?? value).trim();
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address) ? address : null;
}
export async function sendResend(
  job: EmailJob,
  key: string,
  request: typeof fetch = fetch,
): Promise<Outcome> {
  try {
    const result = await request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `lifeos-email/${job.id}`,
      },
      body: JSON.stringify(job.payload),
      signal: AbortSignal.timeout(8000),
    });
    if (result.ok) {
      const data: unknown = await result.json();
      if (
        typeof data === 'object' &&
        data !== null &&
        'id' in data &&
        typeof data.id === 'string' &&
        /^[a-zA-Z0-9_-]{1,200}$/.test(data.id)
      )
        return { outcome: 'accepted', provider: data.id, code: null };
      return { outcome: 'retry', provider: null, code: 'invalid_provider_response' };
    }
    if (result.status === 429)
      return { outcome: 'retry', provider: null, code: 'provider_rate_limited' };
    if (result.status >= 500)
      return { outcome: 'retry', provider: null, code: 'provider_server_error' };
    if (result.status === 409)
      return { outcome: 'uncertain', provider: null, code: 'provider_idempotency_conflict' };
    return { outcome: 'failed', provider: null, code: 'provider_rejected' };
  } catch {
    return { outcome: 'retry', provider: null, code: 'network_outcome_unknown' };
  }
}
export function createEmailHandler(
  environment: EmailEnvironment,
  rpc: Rpc,
  request: typeof fetch = fetch,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  return async (input: Request): Promise<Response> => {
    if (input.method !== 'POST') return response(405, { error: 'method_not_allowed' });
    if (
      !environment.dispatchKey ||
      !equalSecret(input.headers.get('x-lifeos-dispatch-key') ?? '', environment.dispatchKey)
    )
      return response(401, { error: 'unauthorized' });
    let mode = 'dispatch';
    try {
      const text = await input.text();
      if (text.length > 100) return response(400, { error: 'invalid_request' });
      if (text) {
        const data: unknown = JSON.parse(text);
        if (
          !data ||
          typeof data !== 'object' ||
          Array.isArray(data) ||
          Object.keys(data).some((key) => key !== 'mode') ||
          ('mode' in data && !['dispatch', 'probe'].includes(String(data.mode)))
        )
          return response(400, { error: 'invalid_request' });
        if ('mode' in data) mode = String(data.mode);
      }
    } catch {
      return response(400, { error: 'invalid_request' });
    }
    const sender = senderAddress(environment.sender),
      ready = !!sender && !!environment.resendKey?.startsWith('re_');
    try {
      await rpc('set_email_delivery_ready', { available: ready });
      if (!ready)
        return response(503, { configured: false, error: 'email_provider_not_configured' });
      if (mode === 'probe') return response(200, { configured: true });
      const queued = await rpc('queue_email_deliveries', {}),
        counts = { processed: 0, accepted: 0, retried: 0, failed: 0, uncertain: 0 },
        deadline = Date.now() + 90000;
      for (let i = 0; i < 10 && Date.now() < deadline; i++) {
        const job = (await rpc('claim_email_delivery', { sender })) as EmailJob | null;
        if (!job) break;
        const outcome = await sendResend(job, environment.resendKey!, request);
        await rpc('finish_email_delivery', {
          entry: job.id,
          lease: job.lease,
          outcome: outcome.outcome,
          provider: outcome.provider,
          code: outcome.code,
        });
        counts.processed++;
        if (outcome.outcome === 'retry') counts.retried++;
        else counts[outcome.outcome]++;
        if (outcome.code === 'provider_rate_limited' || outcome.code === 'provider_rejected') break;
        await pause(550);
      }
      return response(200, { configured: true, queued, ...counts });
    } catch {
      return response(503, { error: 'dispatch_incomplete_retry_safely' });
    }
  };
}
