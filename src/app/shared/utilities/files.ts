import { FileBucket } from '../../core/models/domain';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const formats: Record<string, { mime: string; extension: string }> = {
  pdf: { mime: 'application/pdf', extension: 'pdf' },
  jpg: { mime: 'image/jpeg', extension: 'jpg' },
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  txt: { mime: 'text/plain', extension: 'txt' },
};
export function validateFile(file: Pick<File, 'name' | 'size' | 'type'>, bucket: FileBucket) {
  if (!file.name.trim() || file.name.length > 200)
    throw new Error('Use a file name between 1 and 200 characters.');
  if (!file.size || file.size > MAX_FILE_BYTES)
    throw new Error('Choose a non-empty file up to 10 MiB.');
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const format = formats[extension];
  if (
    !format ||
    (file.type && file.type.toLowerCase() !== format.mime) ||
    (bucket === 'financial-receipts' && format.mime === 'text/plain')
  )
    throw new Error(
      bucket === 'financial-receipts'
        ? 'Receipts support PDF, JPG and PNG files.'
        : 'Documents support PDF, JPG, PNG and TXT files.',
    );
  return format;
}
export function safeFileName(name: string) {
  return Array.from(name, (char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\'
      ? '_'
      : char,
  )
    .join('')
    .trim();
}
export function fileSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
