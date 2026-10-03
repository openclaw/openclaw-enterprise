import { Transform, Writable } from "node:stream";
import type { Readable, TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
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

/** Buffer one complete request body within the plan's input bounds before dispatch. */
export async function readBoundedInput(
  source: Readable,
  limits: Pick<ExchangeLimits, "inputWireBytes" | "inputDecodedBytes" | "inputMs" | "stallMs">,
  clock: Clock,
  signal: AbortSignal,
): Promise<Buffer> {
  const stop = new AbortController();
  const cancel = () => stop.abort();
  const stall = watchdog(clock, limits.stallMs, cancel);
  const total = clock.schedule(limits.inputMs, cancel);
  signal.addEventListener("abort", cancel, { once: true });
  const parts: Buffer[] = [];
  try {
    if (signal.aborted) {
      throw new Error("cancelled");
    }
    await pipeline(
      source,
      new ByteLimit(Math.min(limits.inputWireBytes, limits.inputDecodedBytes), stall.reset),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          parts.push(chunk);
          callback();
        },
      }),
      { signal: stop.signal },
    );
    return Buffer.concat(parts);
  } finally {
    stall.close();
    total();
    signal.removeEventListener("abort", cancel);
  }
}
