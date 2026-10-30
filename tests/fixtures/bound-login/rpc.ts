/** Private stdin/stdout transport; stdout contains session material: never log it. */
import fs from "node:fs";
import type { RpcFailure } from "./failure.ts";

function fail(failure: RpcFailure) {
  process.exitCode = 2;
  process.stdout.write(JSON.stringify(failure));
}

const mode = process.argv[2];
if (!["operator", "peer"].includes(mode ?? "")) {
  throw Error("RPC target required");
}
const deadline = AbortSignal.timeout(20000);
try {
  const response = await fetch(
    mode === "operator" ? "http://127.0.0.1:39084/command" : "http://127.0.0.1:39083/authorize",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: fs.readFileSync(0, "utf8"),
      signal: deadline,
    },
  );
  if (!response.ok) {
    fail({
      kind: "bound-login-rpc-failure",
      failureClass: "http-status",
      httpStatus: response.status,
    });
  } else {
    process.stdout.write(await response.text());
  }
} catch {
  fail({
    kind: "bound-login-rpc-failure",
    failureClass: deadline.aborted ? "timeout" : "unknown-reply",
  });
}
