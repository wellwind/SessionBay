import { describe, expect, it } from 'vitest';
import { parseWorkspaceImage } from './components/image-reader';
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const metadata = { mime: 'image/png', width: 10, height: 20, sourceFormat: 'png', firstFrameOnly: false };
function packet(header: unknown = metadata, payload = png): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const buffer = new ArrayBuffer(8 + json.length + payload.length);
  const bytes = new Uint8Array(buffer); bytes.set([83, 66, 73, 49]);
  new DataView(buffer).setUint32(4, json.length, true); bytes.set(json, 8); bytes.set(payload, 8 + json.length); return buffer;
}
describe('bounded image IPC envelope', () => {
  it('builds a typed blob and retains dimensions', () => {
    const value = parseWorkspaceImage(packet()); expect(value).toMatchObject({ width: 10, height: 20, sourceFormat: 'png', firstFrameOnly: false });
    expect(value.blob.size).toBe(png.length); expect(value.blob.type).toBe('image/png');
  });
  it('accepts a validated SVG payload only with SVG metadata', () => {
    const value = parseWorkspaceImage(packet({ ...metadata, mime: 'image/svg+xml', sourceFormat: 'svg' }, new TextEncoder().encode('<svg/>')));
    expect(value.blob.type).toBe('image/svg+xml');
  });
  it.each([null, [], {}, { ...metadata, width: 0 }, { ...metadata, width: 8193 }, { ...metadata, width: 4001, height: 4000 },
    { ...metadata, height: 1.5 }, { ...metadata, firstFrameOnly: 1 }, { ...metadata, sourceFormat: 'html' }, { ...metadata, sourceFormat: ['png'] },
    { ...metadata, mime: 'text/html' }, { ...metadata, sourceFormat: 'svg' }, { ...metadata, mime: 'image/svg+xml' }])('rejects invalid metadata %#', value => {
    expect(() => parseWorkspaceImage(packet(value))).toThrow('無效');
  });
  it('rejects empty payload, forged PNG and oversized SVG', () => {
    expect(() => parseWorkspaceImage(packet(metadata, new Uint8Array()))).toThrow();
    expect(() => parseWorkspaceImage(packet(metadata, new Uint8Array([1, 2])))).toThrow();
    expect(() => parseWorkspaceImage(packet({ ...metadata, mime: 'image/svg+xml', sourceFormat: 'svg' }, new Uint8Array(512 * 1024 + 1)))).toThrow();
  });
  it('rejects malformed magic, truncated packet and overlong header', () => {
    const bad = packet(); new Uint8Array(bad)[0] = 0; expect(() => parseWorkspaceImage(bad)).toThrow();
    expect(() => parseWorkspaceImage(new ArrayBuffer(7))).toThrow();
    const long = packet(); new DataView(long).setUint32(4, 4097, true); expect(() => parseWorkspaceImage(long)).toThrow();
  });
  it('rejects non UTF-8 JSON headers and unknown protocols', () => {
    const bad = packet(); new Uint8Array(bad)[8] = 255; expect(() => parseWorkspaceImage(bad)).toThrow();
    expect(() => parseWorkspaceImage([] as unknown as ArrayBuffer)).toThrow();
  });
});
