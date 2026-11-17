import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";

interface FilePolicy {
  readonly maxBytes: number;
  readonly refusal: string;
  readonly canonical?: boolean;
  readonly accepts?: (stat: BigIntStats) => boolean;
}

/** Check the open file and read at most one byte beyond the validated size. */
export function readBoundedFile(path: string, policy: FilePolicy) {
  const { maxBytes, refusal, accepts, canonical } = policy;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.size > BigInt(maxBytes) ||
      (accepts !== undefined && !accepts(stat))
    ) {
      throw new Error(refusal);
    }

    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }

    const after = fstatSync(fd, { bigint: true });
    if (
      BigInt(length) !== stat.size ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs ||
      (canonical && realpathSync(path) !== path)
    ) {
      throw new Error(refusal);
    }
    const current = lstatSync(path, { bigint: true });
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.ctimeNs !== stat.ctimeNs) {
      throw new Error(refusal);
    }
    return { bytes: buffer.subarray(0, length), stat };
  } finally {
    closeSync(fd);
  }
}
