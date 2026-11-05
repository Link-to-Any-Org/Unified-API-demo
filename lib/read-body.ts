export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

// Reads a request body as text with a hard byte cap. Checking the
// Content-Length header alone isn't enough: chunked requests omit it, so the
// cap is enforced on the bytes actually read, and reading stops (and the
// stream is cancelled) as soon as it's exceeded.
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
