import { readFile } from "node:fs/promises";
import { lookup, Resolver } from "node:dns/promises";
import { createConnection } from "node:net";

const [operation, target, port, hostname] = process.argv.slice(2);
const timeoutMs = 2_500;

async function resolveTcp() {
  const question = Buffer.concat([
    ...hostname
      .split(".")
      .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0, 0, 1, 0, 1]), // Root label, A record, Internet class.
  ]);
  const query = Buffer.concat([Buffer.from([0x53, 0x53, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), question]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(query.length);
  const response = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: target, port: Number(port) });
    let received = Buffer.alloc(0);
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("DNS TCP query timed out")));
    socket.once("connect", () => socket.write(Buffer.concat([length, query])));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 2 && received.length >= received.readUInt16BE(0) + 2) {
        resolve(received.subarray(2, received.readUInt16BE(0) + 2));
        socket.destroy();
      }
    });
    socket.once("error", reject);
    socket.once("end", () => reject(new Error("DNS TCP response ended early")));
  });
  if (
    response.readUInt16BE(0) !== 0x5353 ||
    (response.readUInt16BE(2) & 0x800f) !== 0x8000 ||
    response.readUInt16BE(4) !== 1 ||
    response.readUInt16BE(6) < 1
  ) {
    throw new Error("DNS TCP query returned no successful answer");
  }
  const skipName = (offset) => {
    while (offset < response.length && response[offset] !== 0) {
      if ((response[offset] & 0xc0) === 0xc0) {
        return offset + 2;
      }
      offset += response[offset] + 1;
    }
    if (offset >= response.length) {
      throw new Error("DNS TCP response has a truncated name");
    }
    return offset + 1;
  };
  const answer = skipName(skipName(12) + 4);
  if (
    response.readUInt16BE(answer) !== 1 ||
    response.readUInt16BE(answer + 2) !== 1 ||
    response.readUInt16BE(answer + 8) !== 4
  ) {
    throw new Error("DNS TCP query returned an unexpected record");
  }
  return [...response.subarray(answer + 10, answer + 14)].join(".");
}

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
  } else if (operation === "dns-udp" || operation === "dns-tcp") {
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    resolver.setServers([`${target}:${port}`]);
    const address =
      operation === "dns-udp" ? (await resolver.resolve4(hostname))[0] : await resolveTcp();
    process.stdout.write(JSON.stringify({ address }) + "\n");
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
