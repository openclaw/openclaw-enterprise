import { request } from "node:http";
import { nativeReady } from "./handshake.mjs";

// The private socket reaches the very same Box stdio relay as an authenticated
// Gateway. Neither the kubelet nor the supervisor needs the revision bearer.
export async function nativeStatus(socketPath, workspaceFailure) {
  if (workspaceFailure) return { state: "failed", runtimeFailure: workspaceFailure };
  if (await nativeReady(socketPath)) return { state: "serving" };
  const response = await new Promise((resolve, reject) => {
    request(
      {
        socketPath,
        path: "/openclaw/runtime/status",
        agent: false,
        signal: AbortSignal.timeout(1500),
      },
      resolve,
    )
      .on("error", reject)
      .end();
  });
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error("Native status unavailable");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response) {
    length += chunk.length;
    if (length > 16384) throw new Error("Oversize status");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  return body.runtimeFailure
    ? { state: "failed", runtimeFailure: body.runtimeFailure }
    : { state: "starting" };
}
