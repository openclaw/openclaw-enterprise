/** Convert separate Set-Cookie fields to a Cookie header without splitting Expires commas. */
export function cookieHeaderFromSetCookie(values: string | readonly string[] | undefined): string {
  const entries = Array.isArray(values) ? values : values === undefined ? [] : [values];
  return entries
    .filter((value) => !/(?:^|;)\s*Max-Age=0(?:\s*;|$)/i.test(value))
    .map((value) => value.split(";", 1)[0]?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("; ");
}

/** The part of a web ReadableStream that readCappedBody uses: DOM and undici streams fit. */
interface ByteStream {
  getReader(): {
    read(): Promise<
      { done: true; value?: Uint8Array | undefined } | { done: false; value: Uint8Array }
    >;
    cancel(): Promise<void>;
    releaseLock(): void;
  };
}

/**
 * Read a response body without buffering more than `maxBytes`: past the limit the
 * stream is cancelled and the result is undefined. A missing body reads as empty,
 * as `Response.text()` does.
 */
export async function readCappedBody(
  body: ByteStream | null | undefined,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (body === null || body === undefined) {
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return Buffer.concat(chunks, bytes);
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
