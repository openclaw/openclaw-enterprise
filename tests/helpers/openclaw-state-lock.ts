// OpenClaw's state lock commands as the Kubernetes runtime wrappers run them, and what the
// pinned OpenClaw prints for them. The Gateway's lock cases and the Harness's state migration
// cases share these.

// What `gateway recover-lock --json` prints without --confirm, as a production-shaped test
// install printed it inside a Gateway Pod after the Gateway Pod before it was force-deleted
// (finding 3288).
const recovery =
  "Stop the holder before retrying; if it has already stopped, run `openclaw gateway" +
  " recover-lock` to inspect and explicitly recover the unchanged owner.";
const gatewayPod = "gateway-804a2e28f577-6d77574958-v8sp7";
export const leaseHolder =
  `SQLite Gateway owner lease: holder 44 at ${gatewayPod}/pid-ns` +
  ` 4026536354, last renewed 452 s ago. ${recovery}`;
// OpenClaw lists each lock file it finds before the lease, in the same shape. A lock file whose
// holder renews it, such as the node state's owner lock, says "last renewed".
export function lockFileHolder(
  path: string,
  pid = 44,
  pod = gatewayPod,
  age = "last heartbeat 452 s ago",
) {
  return `${path}: holder ${pid} at ${pod}/pid-ns 4026536354, ${age}. ${recovery}`;
}
export const confirmation = "10e3e307222372d1013b3d238518fc59804660f0bd41e674ba543c63f9a903c0";
export function inspection(holders: readonly string[], present = holders.length > 0) {
  return {
    status: 0,
    stdout: JSON.stringify({
      present,
      holders,
      confirmation,
      command: `openclaw gateway recover-lock --confirm ${confirmation}`,
    }),
  };
}
export const heldLock = inspection([leaseHolder]);
export const freeLock = inspection([]);
// The inspection a wrapper may run: never --confirm, which would recover the lock.
export const expectedInspection = {
  command: "node",
  args: ["/app/openclaw.mjs", "gateway", "recover-lock", "--json"],
  readOnly: "1",
};

// What the exited-state release prints when it recovered the records of this container's own
// child, which it proved dead in this live PID namespace.
export const released = { status: 0, stdout: JSON.stringify({ recovered: true, removed: 1 }) };
// What it does when one record is not attributable to this namespace: it recovers nothing.
export const keptLocks = { status: 1, stdout: "" };

// The line a held start logs before OpenClaw's holders. The Gateway's is the one the tool
// policy step logs when `config validate` meets the lock first; an embedded Gateway reaches
// the same hold, so it names no Gateway kind. The Harness's names the workspace node's lock.
export function lockHoldLine(reported = leaseHolder, owner: "Gateway" | "Harness" = "Gateway") {
  return owner === "Gateway"
    ? "The Gateway cannot start: an earlier Gateway process did not stop cleanly and still holds" +
        " the Gateway state lock, and this container cannot verify that it stopped. It remains" +
        " unready; stop the Agent and recover the lock as the Agent troubleshooting guide" +
        ` describes for an unverifiable state owner. OpenClaw reported: ${reported}`
    : "The Harness cannot start: an earlier OpenClaw process holds the workspace node's state" +
        " lock, and this container cannot verify that it stopped. Recover it as the Agent" +
        ` troubleshooting guide describes. OpenClaw reported: ${reported}`;
}
