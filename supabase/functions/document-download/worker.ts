export interface DownloadGrant {
  bucket_id: string;
  object_path: string;
  size_bytes: number;
  revision: number;
}
export interface DownloadGateway {
  verify(token: string): Promise<boolean>;
  grant(token: string, id: string): Promise<DownloadGrant | null>;
  bytes(grant: DownloadGrant): Promise<Blob>;
}
export function createDocumentDownloadHandler(gateway: DownloadGateway) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('Origin');
    const allowed =
      !origin ||
      origin === 'https://lifeos.sajinct.com' ||
      origin === 'https://sajinct.github.io' ||
      /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
    const headers = new Headers({
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      Vary: 'Origin',
    });
    if (origin && allowed) headers.set('Access-Control-Allow-Origin', origin);
    const error = (status: number, message: string) =>
      Response.json({ message }, { status, headers });
    if (!allowed) return error(403, 'Origin unavailable');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return error(405, 'Use POST');
    const token = req.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return error(401, 'Sign in to download this document');
    try {
      if (!(await gateway.verify(token))) return error(401, 'Sign in to download this document');
      const text = await req.text();
      if (text.length > 1024) return error(400, 'Invalid download request');
      let body: { share_id?: unknown };
      try {
        body = JSON.parse(text);
      } catch {
        return error(400, 'Invalid download request');
      }
      if (
        !body ||
        typeof body.share_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.share_id)
      )
        return error(400, 'Invalid download request');
      const grant = await gateway.grant(token, body.share_id);
      if (
        !grant ||
        grant.bucket_id !== 'personal-documents' ||
        !Number.isSafeInteger(grant.size_bytes) ||
        grant.size_bytes < 1 ||
        grant.size_bytes > 10485760
      )
        return error(403, 'Document access is unavailable; refresh sharing');
      const bytes = await gateway.bytes(grant);
      // A revoke or membership removal during the Storage fetch discards the fetched bytes.
      const current = await gateway.grant(token, body.share_id);
      if (
        !current ||
        current.revision !== grant.revision ||
        current.object_path !== grant.object_path ||
        current.size_bytes !== grant.size_bytes
      )
        return error(403, 'Document access changed; refresh sharing');
      if (bytes.size !== grant.size_bytes) return error(502, 'Document bytes are unavailable');
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Disposition', 'attachment');
      return new Response(bytes, { headers });
    } catch {
      return error(503, 'Document download unavailable; try again');
    }
  };
}
