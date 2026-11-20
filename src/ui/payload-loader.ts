import type { BootSource } from '../engine/worker-client.ts';

/**
 * Downloads the canonical graph on the main thread only to report byte progress; the
 * worker parses it from a Blob URL, so JSON.parse and seeding never block the UI.
 */
export async function fetchPayloadAsBlobUrl(
  url: string,
  onProgress: (loadedBytes: number, totalBytes: number | null) => void,
): Promise<BootSource> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const header = response.headers.get('content-length');
  const declared = header === null ? Number.NaN : Number(header);
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
  const body = response.body;
  let blob: Blob;
  if (body === null) {
    blob = await response.blob();
    onProgress(blob.size, totalBytes ?? blob.size);
  } else {
    const reader = body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let loadedBytes = 0;
    for (;;) {
      // Stream reads are sequential by nature; each await is one progress tick.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      loadedBytes += value.byteLength;
      onProgress(loadedBytes, totalBytes);
    }
    blob = new Blob(chunks, { type: 'application/json' });
  }
  // Never revoked: the worker client re-boots from this URL after a respawn or a restore.
  // react-doctor-disable-next-line no-create-object-url-without-revoke
  return { payloadUrl: URL.createObjectURL(blob) };
}
