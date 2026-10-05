import type { InputVerdict } from "../../../credentials/backend-contracts.ts";
import { allowsPushRef, decodePushedBranchRef } from "../../../credentials/client-contracts.ts";

// Smart-HTTP receive-pack (protocol v0/v1; v2 has no receive-pack form) sends
// plaintext pkt-line commands, a flush-pkt, then optional push options and the
// packfile. Only the command section is read; the packfile is never parsed.
/** Most ref updates one inspected push may carry; more is refused with its own code. */
export const maximumPushRefs = 256;
const tooManyRefs: InputVerdict = Object.freeze({
  status: 413,
  code: "push-ref-limit-exceeded",
  message: `A push may update at most ${maximumPushRefs} refs. Push the refs in smaller batches.`,
});
const oid = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
// Read as latin1, so each ref byte is one character; UTF-8 is decoded strictly below.
const command = new RegExp(`^(${oid}) (${oid}) (refs/[\\x21-\\x7e\\x80-\\xff]+)$`);
const shallow = /^shallow [0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function packetLength(body: Uint8Array, offset: number): number {
  let length = 0;
  for (let index = offset; index < offset + 4; index++) {
    const digit = body[index]!;
    const value =
      digit >= 0x30 && digit <= 0x39
        ? digit - 0x30
        : digit >= 0x61 && digit <= 0x66
          ? digit - 0x57
          : digit >= 0x41 && digit <= 0x46
            ? digit - 0x37
            : -1;
    if (value < 0) {
      return -1;
    }
    length = length * 16 + value;
  }
  return length;
}

/**
 * Refuse a receive-pack request unless every ref it updates, creates or deletes
 * passes the same matcher as the client push hook. Signed pushes are refused, and
 * a push of more than `maximumPushRefs` refs is refused as `push-ref-limit-exceeded`.
 */
export function allowsReceivePackInput(
  allowlist: readonly string[],
): (body: Uint8Array) => InputVerdict {
  const refs = Object.freeze([...allowlist]);
  return (body) => {
    let offset = 0;
    let commands = 0;
    for (;;) {
      if (offset + 4 > body.length) {
        return false;
      }
      const length = packetLength(body, offset);
      if (length === 0) {
        return true;
      }
      if (length < 5 || offset + length > body.length) {
        return false;
      }
      let end = offset + length;
      if (body[end - 1] === 0x0a) {
        end--;
      }
      const payload = body.subarray(offset + 4, end);
      // Capabilities follow one NUL on the first command only and are printable ASCII.
      // Capability names never select refs, so their spelling is free. Before them, bytes
      // above ASCII may spell a UTF-8 refname; control bytes are refused everywhere.
      let separator = -1;
      for (let index = 0; index < payload.length; index++) {
        const byte = payload[index]!;
        if (byte === 0 && separator < 0 && commands === 0) {
          separator = index;
        } else if (byte < 0x20 || byte === 0x7f || (separator >= 0 && byte > 0x7e)) {
          return false;
        }
      }
      const text = Buffer.from(payload).toString("latin1");
      const line = separator < 0 ? text : text.slice(0, separator);
      offset += length;
      if (line.startsWith("shallow ")) {
        if (separator >= 0 || !shallow.test(line)) {
          return false;
        }
        continue;
      }
      // push-cert (signed pushes) and any other line form are refused.
      const match = command.exec(line);
      if (!match || match[1]!.length !== match[2]!.length) {
        return false;
      }
      // Malformed refnames and invalid UTF-8 are refused here rather than left to upstream.
      const ref = decodePushedBranchRef(Buffer.from(match[3]!, "latin1"));
      if (ref === undefined || !allowsPushRef(refs, ref)) {
        return false;
      }
      commands++;
      if (commands > maximumPushRefs) {
        return tooManyRefs;
      }
    }
  };
}
