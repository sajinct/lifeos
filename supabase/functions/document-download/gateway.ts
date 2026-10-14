import { DownloadGateway, DownloadGrant } from './worker.ts';
// Server credentials are used for bytes only; every grant RPC keeps the caller's JWT.
export function createDownloadGateway(
  url: string | undefined,
  key: string | undefined,
): DownloadGateway {
  function request(path: string, token?: string, body?: unknown) {
    if (!url || !key) throw new Error('Server configuration unavailable');
    return fetch(`${url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        apikey: key,
        ...(token
          ? { Authorization: `Bearer ${token}` }
          : key.startsWith('sb_secret_')
            ? {}
            : { Authorization: `Bearer ${key}` }),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
  }
  return {
    async verify(token) {
      const response = await request('/auth/v1/user', token);
      if (!response.ok) return false;
      const user = await response.json();
      return typeof user.id === 'string';
    },
    async grant(token, id) {
      const response = await request('/rest/v1/rpc/document_share_download', token, { entry: id });
      if (!response.ok) throw new Error('Access check failed');
      const rows: DownloadGrant[] = await response.json();
      return rows[0] ?? null;
    },
    async bytes(grant) {
      const path = grant.object_path.split('/').map(encodeURIComponent).join('/');
      const response = await request(`/storage/v1/object/authenticated/${grant.bucket_id}/${path}`);
      if (!response.ok) throw new Error('Storage unavailable');
      return response.blob();
    },
  };
}
