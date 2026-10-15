import { Transform } from "node:stream";
import type { Readable, TransformCallback } from "node:stream";
import type { Clock, ExchangeLimits } from "../backend-contracts.ts";

export class ByteLimit extends Transform {
  #bytes = 0;
  private readonly maximum: number;
  private readonly progress: () => void;
  constructor(maximum: number, progress: () => void = () => {}) {
    super();
    this.maximum = maximum;
    this.progress = progress;
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#bytes += chunk.length;
    if (this.#bytes > this.maximum) {
      callback(new Error("limit-exceeded"));
      return;
    }
    this.progress();
    callback(null, chunk);
  }
}

export function watchdog(
  clock: Clock,
  delayMs: number,
  expired: () => void,
): Readonly<{ reset(): void; close(): void }> {
  let cancel: (() => void) | undefined;
  let closed = false;
  const reset = () => {
    if (!closed) {
      cancel?.();
      cancel = clock.schedule(delayMs, expired);
    }
  };
  reset();
  return {
    reset,
    close() {
      closed = true;
      cancel?.();
    },
  };
}

/**
 * Buffer one complete request body within the plan's input bounds before dispatch.
 * It never destroys `source`: on "limit-exceeded" the caller can still answer on the
 * same connection. Every other failure ("input-failed") leaves the caller to destroy it.
 */
export function readBoundedInput(
  source: Readable,
  limits: Pick<ExchangeLimits, "inputWireBytes" | "inputDecodedBytes" | "inputMs" | "stallMs">,
  clock: Clock,
  signal: AbortSignal,
): Promise<Buffer> {
  const maximum = Math.min(limits.inputWireBytes, limits.inputDecodedBytes);
  return new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      stall.close();
      total();
      signal.removeEventListener("abort", failed);
      source.off("data", data);
      source.off("end", end);
      source.off("error", failed);
      source.off("close", closed);
      source.pause();
      if (error) {
        parts.length = 0;
        reject(error);
      } else {
        resolve(Buffer.concat(parts, bytes));
      }
    };
    const failed = () => finish(new Error("input-failed"));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) {
        finish(new Error("limit-exceeded"));
        return;
      }
      stall.reset();
      parts.push(chunk);
    };
    const end = () => finish();
    // "close" before "end" means the peer went away mid-body. Deferring only breaks the
    // tie when both are queued; an abort usually arrives first through `signal`.
    const closed = () => setImmediate(failed);
    const stall = watchdog(clock, limits.stallMs, failed);
    const total = clock.schedule(limits.inputMs, failed);
    if (signal.aborted || source.readableEnded || source.destroyed) {
      failed();
      return;
    }
    signal.addEventListener("abort", failed, { once: true });
    source.on("data", data);
    source.once("end", end);
    source.once("error", failed);
    source.once("close", closed);
    source.resume();
  });
}
