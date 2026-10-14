import { createEmailHandler } from './worker.ts';
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};
const url = Deno.env.get('SUPABASE_URL');
let key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!key) {
  try {
    const keys: unknown = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys && typeof keys === 'object' && !Array.isArray(keys))
      key = Object.values(keys).find(
        (value): value is string => typeof value === 'string' && value.startsWith('sb_secret_'),
      );
  } catch {
    key = undefined;
  }
}
Deno.serve(
  createEmailHandler(
    {
      dispatchKey: Deno.env.get('LIFEOS_EMAIL_DISPATCH_KEY'),
      resendKey: Deno.env.get('RESEND_API_KEY'),
      sender: Deno.env.get('LIFEOS_EMAIL_FROM'),
    },
    async (name, args) => {
      if (!url || !key) throw new Error('Server configuration unavailable');
      const result = await fetch(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: key,
          ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10000),
      });
      if (!result.ok) throw new Error('Email database operation failed');
      const text = await result.text();
      return text ? JSON.parse(text) : null;
    },
  ),
);
