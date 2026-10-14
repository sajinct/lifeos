import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { sha256, verifyFileBundle } from '../scripts/lib/recovery.mjs';
describe('Synthetic file-bundle integrity checks', () => {
  const key =
      'personal-documents/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.txt',
    body = Buffer.from('Original synthetic bytes');
  const entry = {
    bucket: 'personal-documents',
    path: key.slice('personal-documents/'.length),
    mime: 'text/plain',
    bytes: body.length,
    sha256: sha256(body),
  };
  it('verifies a complete separate file bundle and its SHA-256', () => {
    expect(verifyFileBundle([entry], new Map([[key, body]]))).toBe(1);
  });
  it('rejects missing bytes, same-size corruption, changed sizes and unlisted files', () => {
    expect(() => verifyFileBundle([entry], new Map())).toThrow(/Missing/);
    const corrupt = Buffer.from(body);
    corrupt[0] ^= 1;
    expect(() => verifyFileBundle([entry], new Map([[key, corrupt]]))).toThrow(/checksum/);
    expect(() =>
      verifyFileBundle([{ ...entry, bytes: body.length + 1 }], new Map([[key, body]])),
    ).toThrow(/size/);
    expect(() =>
      verifyFileBundle(
        [entry],
        new Map([
          [key, body],
          ['extra', body],
        ]),
      ),
    ).toThrow(/unlisted/);
  });
  it('rejects duplicate entries and unsafe paths instead of overwriting another file', () => {
    expect(() => verifyFileBundle([entry, entry], new Map([[key, body]]))).toThrow(/Duplicate/);
    for (const path of [
      '../escape.txt',
      'C:/escape.txt',
      '/absolute.txt',
      entry.path.replace('.txt', '/../../escape.txt'),
    ])
      expect(() => verifyFileBundle([{ ...entry, path }], new Map([[key, body]]))).toThrow(
        /Invalid/,
      );
  });
  it('rejects wrong bucket, malformed checksums and changed MIME metadata', () => {
    for (const changed of [
      { bucket: 'public-files' },
      { sha256: 'invalid' },
      { mime: 'image/svg+xml' },
    ])
      expect(() => verifyFileBundle([{ ...entry, ...changed }], new Map([[key, body]]))).toThrow(
        /Invalid/,
      );
  });
});
