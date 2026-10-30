/** Protected RPC probe for pinned OpenShell 0.1.5; never prints credentials. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:http2";

const [host, subject, mode] = process.argv.slice(2);
assert.ok(mode === "owner" || mode === "negative");
assert.match(host ?? "", /^openshell-[a-f0-9]{10}\.oce-[a-f0-9]{15}\.svc$/);
assert.match(subject ?? "", /^bound-controller-[a-f0-9]{10}$/);
const root = "/bound-openshell";
const ca = readFileSync(`${root}/ca.crt`);
if (mode === "negative") {
  assert.equal(existsSync(`${root}/tls.key`), false);
  assert.equal(existsSync(`${root}/tls.crt`), false);
}
const cert = mode === "owner" ? readFileSync(`${root}/tls.crt`) : undefined;
const key = mode === "owner" ? readFileSync(`${root}/tls.key`) : undefined;

async function currentUser(tls: boolean, credential: boolean) {
  return await new Promise<{ status: number; data: Buffer }>((resolve, reject) => {
    const client = connect(
      `${tls ? "https" : "http"}://${host}:8080`,
      tls
        ? {
            ca,
            ...(credential ? { cert, key } : {}),
            rejectUnauthorized: true,
          }
        : {},
    );
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Protected RPC deadline")), 8000);
    function finish(error?: Error, value?: { status: number; data: Buffer }) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value!);
      }
    }
    client.on("error", (error) => finish(error));
    const request = client.request({
      ":method": "POST",
      ":path": "/openshell.v1.OpenShell/GetCurrentUser",
      "content-type": "application/grpc",
      te: "trailers",
      "grpc-timeout": "8S",
    });
    let status = -1;
    let httpStatus = -1;
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("response", (headers) => {
      httpStatus = Number(headers[":status"]);
      if (headers["grpc-status"] !== undefined) {
        status = Number(headers["grpc-status"]);
      }
    });
    request.on("trailers", (headers) => {
      status = Number(headers["grpc-status"]);
    });
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16384) {
        finish(new Error("Protected RPC response too large"));
      } else {
        chunks.push(chunk);
      }
    });
    request.on("error", (error) => finish(error));
    request.on("end", () => {
      if (httpStatus !== 200) {
        finish(new Error("Protected RPC HTTP failure"));
      } else {
        finish(undefined, { status, data: Buffer.concat(chunks) });
      }
    });
    // Empty GetCurrentUserRequest, protobuf frame with compression disabled.
    request.end(Buffer.alloc(5));
  });
}

function identity(data: Buffer) {
  assert.ok(data.length >= 5 && data[0] === 0);
  assert.equal(data.readUInt32BE(1), data.length - 5);
  let cursor = 5;
  const fields = new Map<number, string[]>();
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 28; shift += 7) {
      assert.ok(cursor < data.length);
      const byte = data[cursor++]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) {
        return value;
      }
    }
    throw Error("Invalid identity protobuf");
  };
  while (cursor < data.length) {
    const tag = varint();
    assert.equal(tag & 7, 2);
    const field = tag >>> 3;
    assert.ok(field >= 1 && field <= 5);
    const size = varint();
    assert.ok(cursor + size <= data.length);
    fields.set(field, [
      ...(fields.get(field) ?? []),
      data.subarray(cursor, cursor + size).toString("utf8"),
    ]);
    cursor += size;
  }
  assert.deepEqual(fields.get(1), [subject]);
  assert.deepEqual(fields.get(5), ["mtls"]);
  assert.deepEqual(fields.get(3) ?? [], []); // No reported roles; this does not bound effective platform authority.
  assert.deepEqual(fields.get(4) ?? [], []);
}

if (mode === "owner") {
  const legitimate = await currentUser(true, true);
  assert.equal(legitimate.status, 0);
  identity(legitimate.data);
}
// This supplier accepts an optional client certificate at the socket. Assert
// application UNAUTHENTICATED, not a presumed failed TLS handshake.
const anonymous = await currentUser(true, false);
assert.equal(anonymous.status, 16);
assert.equal(anonymous.data.length, 0);
await assert.rejects(
  currentUser(false, false),
  (error: NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException }) => {
    const code = error.cause?.code ?? error.code;
    return ["ECONNRESET", "ERR_HTTP2_SESSION_ERROR", "ERR_HTTP2_ERROR"].includes(code ?? "");
  },
);
// Demonstrate the target remains available after both negatives.
const after = await currentUser(true, mode === "owner");
assert.equal(after.status, mode === "owner" ? 0 : 16);
if (mode === "owner") {
  identity(after.data);
}
process.stdout.write(
  JSON.stringify({
    nativeIdentityVerified: mode === "owner",
    anonymousRpcDenied: true,
    plaintextDenied: true,
    nonOperatorUserIdentity: mode === "owner",
  }),
);
