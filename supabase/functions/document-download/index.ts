import { createDocumentDownloadHandler } from './worker.ts';
import { createDownloadGateway } from './gateway.ts';
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
        (v): v is string => typeof v === 'string' && v.startsWith('sb_secret_'),
      );
  } catch {
    key = undefined;
  }
}
Deno.serve(createDocumentDownloadHandler(createDownloadGateway(url, key)));
