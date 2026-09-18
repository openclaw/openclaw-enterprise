import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";

const [operation, target, port] = process.argv.slice(2);
const timeoutMs = 2_500;

try {
  if (operation === "http") {
    const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    process.stdout.write(JSON.stringify({ status: response.status }) + "\n");
  } else if (operation === "dns") {
    const result = await lookup(target);
    process.stdout.write(JSON.stringify({ address: result.address }) + "\n");
  } else if (operation === "tcp") {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: target, port: Number(port) });
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error("connection timed out")));
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });
    process.stdout.write(JSON.stringify({ connected: true }) + "\n");
  } else if (operation === "token") {
    const token = await readFile(target, "utf8");
    const [, payload] = token.trim().split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    process.stdout.write(JSON.stringify({ audience: claims.aud, subject: claims.sub }) + "\n");
  } else {
    throw new Error(`Unsupported probe operation: ${operation ?? "missing"}`);
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + "\n");
  process.exitCode = 1;
}
