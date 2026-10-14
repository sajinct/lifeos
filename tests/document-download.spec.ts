import { createDownloadGateway } from '../supabase/functions/document-download/gateway';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createDocumentDownloadHandler,
  DownloadGrant,
} from '../supabase/functions/document-download/worker';
const id = '11111111-1111-4111-8111-111111111111';
const grant: DownloadGrant = {
  bucket_id: 'personal-documents',
  object_path: 'owner/workspace/file.txt',
  size_bytes: 5,
  revision: 1,
};
function setup() {
  const gateway = {
    verify: vi.fn().mockResolvedValue(true),
    grant: vi.fn().mockResolvedValue(grant),
    bytes: vi.fn().mockResolvedValue(new Blob(['hello'])),
  };
  return { gateway, handle: createDocumentDownloadHandler(gateway) };
}
function request(
  body: unknown = { share_id: id },
  token = 'valid-session',
  origin = 'https://lifeos.sajinct.com',
) {
  return new Request('https://example.test/document-download', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: origin },
    body: JSON.stringify(body),
  });
}
describe('Document download proxy', () => {
  it('returns a no-store attachment only after authenticated access checks before and after fetching', async () => {
    const { gateway, handle } = setup();
    const response = await handle(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(gateway.grant).toHaveBeenCalledTimes(2);
    expect(gateway.verify).toHaveBeenCalledWith('valid-session');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://lifeos.sajinct.com');
  });
  it('denies missing and invalid sessions before accessing bytes', async () => {
    const { gateway, handle } = setup();
    expect((await handle(new Request('https://example.test', { method: 'POST' }))).status).toBe(
      401,
    );
    gateway.verify.mockResolvedValue(false);
    expect((await handle(request())).status).toBe(401);
    expect(gateway.grant).not.toHaveBeenCalled();
    expect(gateway.bytes).not.toHaveBeenCalled();
  });
  it('denies inaccessible grants without fetching objects', async () => {
    const { gateway, handle } = setup();
    gateway.grant.mockResolvedValue(null);
    expect((await handle(request())).status).toBe(403);
    expect(gateway.bytes).not.toHaveBeenCalled();
  });
  it('discards bytes when revoked, removed, or changed during the object fetch', async () => {
    for (const current of [
      null,
      { ...grant, revision: 2 },
      { ...grant, object_path: 'another/file.txt' },
    ]) {
      const { gateway, handle } = setup();
      gateway.grant.mockResolvedValueOnce(grant).mockResolvedValueOnce(current);
      const response = await handle(request());
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('hello');
    }
  });
  it('rejects non-document buckets, oversized files, and mismatched bytes', async () => {
    for (const changed of [
      { ...grant, bucket_id: 'financial-receipts' },
      { ...grant, size_bytes: 10485761 },
      { ...grant, size_bytes: 0 },
    ]) {
      const { gateway, handle } = setup();
      gateway.grant.mockResolvedValue(changed);
      expect((await handle(request())).status).toBe(403);
      expect(gateway.bytes).not.toHaveBeenCalled();
    }
    const { gateway, handle } = setup();
    gateway.bytes.mockResolvedValue(new Blob(['wrong size']));
    expect((await handle(request())).status).toBe(502);
  });
  it('limits request bodies and does not accept arbitrary object paths', async () => {
    const { gateway, handle } = setup();
    for (const body of [
      { object_path: 'arbitrary' },
      null,
      { share_id: 'bad' },
      { share_id: id, padding: 'x'.repeat(1024) },
    ])
      expect((await handle(request(body))).status).toBe(400);
    expect(gateway.grant).not.toHaveBeenCalled();
  });
  it('handles CORS and errors without exposing paths or tokens', async () => {
    const { gateway, handle } = setup();
    expect((await handle(request({}, 'valid-session', 'https://untrusted.test'))).status).toBe(403);
    const preflight = await handle(
      new Request('https://example.test', {
        method: 'OPTIONS',
        headers: { Origin: 'https://lifeos.sajinct.com' },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(gateway.verify).not.toHaveBeenCalled();
    gateway.bytes.mockRejectedValue(new Error('secret path and token'));
    const response = await handle(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret');
  });
});

describe('Server byte gateway credential separation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses the user JWT for Auth and grants, and server credentials only for private bytes', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 'reader' }))
      .mockResolvedValueOnce(Response.json([grant]))
      .mockResolvedValueOnce(new Response(new Blob(['hello'])))
      .mockResolvedValueOnce(Response.json([grant]));
    vi.stubGlobal('fetch', fetcher);
    const handle = createDocumentDownloadHandler(
      createDownloadGateway('https://project.test', 'server-role-test-value'),
    );
    const response = await handle(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
      'https://project.test/auth/v1/user',
      'https://project.test/rest/v1/rpc/document_share_download',
      'https://project.test/storage/v1/object/authenticated/personal-documents/owner/workspace/file.txt',
      'https://project.test/rest/v1/rpc/document_share_download',
    ]);
    for (const index of [0, 1, 3])
      expect(fetcher.mock.calls[index][1].headers.Authorization).toBe('Bearer valid-session');
    expect(fetcher.mock.calls[2][1].headers.Authorization).toBe('Bearer server-role-test-value');
    expect(fetcher.mock.calls[1][1].body).toBe(JSON.stringify({ entry: id }));
    for (const call of fetcher.mock.calls) expect(call[1].cache).toBe('no-store');
  });
  it('supports built-in secret keys without sending them as JWTs and encodes Storage paths', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Blob(['hello'])));
    vi.stubGlobal('fetch', fetcher);
    const gateway = createDownloadGateway('https://project.test', 'sb_secret_test_only');
    await gateway.bytes({ ...grant, object_path: 'owner/workspace/file #?.txt' });
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://project.test/storage/v1/object/authenticated/personal-documents/owner/workspace/file%20%23%3F.txt',
    );
    expect(fetcher.mock.calls[0][1].headers).toEqual({ apikey: 'sb_secret_test_only' });
  });
});
