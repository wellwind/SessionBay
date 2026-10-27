import { t } from '../i18n';
export interface ImagePreview {
  blob: Blob;
  width: number;
  height: number;
  sourceFormat: 'png' | 'jpeg' | 'gif' | 'webp' | 'svg';
  firstFrameOnly: boolean;
}
const HEADER_LIMIT = 4096;
const PAYLOAD_LIMIT = 20 * 1024 * 1024;
const SVG_LIMIT = 512 * 1024;
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

/** A bounded binary IPC envelope, never a JSON array or base64 copy of the image. */
export function parseWorkspaceImage(buffer: ArrayBuffer): ImagePreview {
  const invalid = () => new Error(t('Invalid image preview response'));
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 9 || buffer.byteLength > 8 + HEADER_LIMIT + PAYLOAD_LIMIT) throw invalid();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 83 || bytes[1] !== 66 || bytes[2] !== 73 || bytes[3] !== 49) throw invalid();
  const length = new DataView(buffer).getUint32(4, true);
  if (length === 0 || length > HEADER_LIMIT || 8 + length >= bytes.length) throw invalid();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + length))); }
  catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const header = value as Record<string, unknown>;
  const { mime, width, height, sourceFormat, firstFrameOnly } = header;
  if ((mime !== 'image/png' && mime !== 'image/svg+xml') || typeof width !== 'number' || typeof height !== 'number'
    || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192
    || width * height > 16_000_000 || typeof firstFrameOnly !== 'boolean'
    || typeof sourceFormat !== 'string' || !['png', 'jpeg', 'gif', 'webp', 'svg'].includes(sourceFormat)
    || (sourceFormat === 'svg') !== (mime === 'image/svg+xml')) throw invalid();
  const payload = bytes.subarray(8 + length);
  if (payload.byteLength > (mime === 'image/svg+xml' ? SVG_LIMIT : PAYLOAD_LIMIT)) throw invalid();
  if (mime === 'image/png' && !PNG.every((byte, i) => payload[i] === byte)) throw invalid();
  return { blob: new Blob([payload], { type: mime }), width, height, sourceFormat: sourceFormat as ImagePreview['sourceFormat'], firstFrameOnly };
}
