// Run the same bounded TCP client in the owned operator and ordinary probe Pod.
// A transport rejection is evidence only alongside live-listener and egress controls.
export function tcpProbeCommand(
  targets: { label: string; host: string; port: number; expect: string }[],
  { waitForInitialEgress = false }: { waitForInitialEgress?: boolean } = {},
) {
  return [
    "node",
    "--input-type=module",
    "-e",
    `import { createConnection, isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
const denied = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"]);
const { targets, waitForInitialEgress } = JSON.parse(process.argv[1]);
if (waitForInitialEgress && (targets[0]?.label !== "egress-before" || targets[0]?.expect !== "connected")) {
  throw new Error("startup retry requires the initial positive egress control");
}
for (const [index, target] of targets.entries()) {
  const { label, host, port, expect } = target;
  const retry = waitForInitialEgress && index === 0;
  const deadline = performance.now() + (retry ? 8000 : 2500);
  for (let attempt = 1; ; attempt++) {
    let outcome = "connected";
    let code;
    let message;
    let syscall;
    try {
      if (!isIP(host)) throw Object.assign(new Error("literal IP address required"), { code: "INVALID_ADDRESS" });
      await new Promise((resolve, reject) => {
        const socket = createConnection({ host, port });
        socket.setTimeout(Math.max(1, Math.min(2500, deadline - performance.now())), () => socket.destroy(Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" })));
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
      });
    } catch (error) {
      code = error.code;
      message = error.message;
      syscall = error.syscall;
      outcome = denied.has(code) ? "denied" : "error";
    }
    console.log(JSON.stringify({ label, host, port, attempt, outcome, ...(code ? { code, message, syscall } : {}) }));
    if (retry && outcome === "denied" && attempt < 33 && performance.now() < deadline) {
      await delay(Math.min(250, deadline - performance.now()));
      if (performance.now() < deadline) continue;
    }
    if (outcome !== expect || !["connected", "denied"].includes(expect)) process.exitCode = 1;
    break;
  }
  if (process.exitCode) break;
}`,
    JSON.stringify({ targets, waitForInitialEgress }),
  ];
}

export function tcpControlCommand(port: number) {
  return [
    "node",
    "--input-type=module",
    "-e",
    `import { createServer } from "node:net";
const server = createServer(socket => socket.end());
server.listen(Number(process.argv[1]), "0.0.0.0", () => console.log(JSON.stringify(server.address())));
process.once("SIGTERM", () => server.close());`,
    String(port),
  ];
}
