import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Server, Socket } from "node:net";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createFixedIngress } from "../../deploy/examples/strands-box/ingress/host-ingress.ts";
import { createFixedRelay, probeNative } from "../../deploy/examples/strands-box/ingress/relay.ts";
import { certificateAuthority, signedLeaf } from "../helpers/certificates.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const authority = "box-harness.pilot.svc.cluster.local";
const transportPort = 8443;
const magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const cli = fileURLToPath(
  new URL("../../deploy/examples/strands-box/ingress/host-ingress.ts", import.meta.url),
);
const run = promisify(execFile);

async function listenUnix(server: Server, path: string): Promise<void> {
  server.listen(path);
  await once(server, "listening");
  await chmod(path, 0o600);
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function writeReady(runtimeDir: string, pid: number): Promise<string> {
  const [stat, bootId, socket] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    lstat(join(runtimeDir, "app-server.sock"), { bigint: true }),
  ]);
  const startTicks = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)[19];
  assert.ok(startTicks);
  const value = JSON.stringify({
    version: 1,
    pid,
    uid: process.getuid?.(),
    bootId: bootId.trim(),
    startTicks,
    socketDev: String(socket.dev),
    socketIno: String(socket.ino),
  });
  await writeFile(join(runtimeDir, "ready.json"), value, { mode: 0o600 });
  return createHash("sha256").update(value).digest("hex");
}

async function materials(t: TestContext) {
  const dir = await temporaryDirectory(t, "box-ingress-");
  const runtimeDir = join(dir, "owner");
  await mkdir(runtimeDir, { mode: 0o700 });
  const socketPath = join(runtimeDir, "app-server.sock");
  const ca = await certificateAuthority(dir, {
    caName: "Ingress test CA",
    caKeyPem: undefined,
    days: 1,
  });
  const leaf = await signedLeaf(dir, ca, {
    name: "server",
    keyPem: undefined,
    commonName: "Ingress test leaf",
    subjectAltName: `DNS:${authority}`,
    days: 1,
  });
  const caBundle = await readFile(ca.caPath);
  const tls = { cert: Buffer.from(leaf.cert), key: Buffer.from(leaf.key) };
  return { runtimeDir, socketPath, tls, leaf, caBundle };
}

async function fixture(t: TestContext) {
  const material = await materials(t);
  const { runtimeDir, socketPath } = material;
  const capability = `Bearer ${randomBytes(24).toString("base64url")}`;
  const nativeSockets = new Set<Socket>();
  const seen: { path: string | undefined; authorization: string | undefined }[] = [];
  const native = createServer();
  native.on("connection", (socket) => {
    nativeSockets.add(socket);
    socket.once("close", () => nativeSockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  native.on("upgrade", (message, socket) => {
    assert.equal(message.headers["x-forwarded-host"], undefined);
    seen.push({ path: message.url, authorization: message.headers.authorization });
    if (message.headers.authorization !== capability) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const key = message.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = createHash("sha1")
      .update(String(key) + magic)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // Independent native-side frame check. Client text is masked; server reply is not.
    socket.once("data", (frame: Buffer) => {
      assert.deepEqual([...frame], [0x81, 0x82, 1, 2, 3, 4, 0x6e, 0x69]);
      socket.write(Buffer.from([0x81, 2, 0x6f, 0x6b]));
    });
  });
  await listenUnix(native, socketPath);
  t.after(async () => {
    for (const socket of nativeSockets) {
      socket.destroy();
    }
    await close(native);
  });
  const readySha256 = await writeReady(runtimeDir, process.pid);
  return { ...material, readySha256, capability, seen };
}

async function startTls(
  t: TestContext,
  f: Awaited<ReturnType<typeof materials>> & { readySha256: string },
) {
  const ingress = await createFixedIngress(
    {
      authority,
      runtimeDir: f.runtimeDir,
      readySha256: f.readySha256,
    },
    f.tls,
  );
  // Test isolation: exercise the same unbound handler over loopback. The
  // shipped executable refuses loopback and owns the private bind itself.
  ingress.server.listen(0, "127.0.0.1");
  await once(ingress.server, "listening");
  const address = ingress.server.address();
  assert.ok(address && typeof address !== "string");
  t.after(() => {
    ingress.stop();
  });
  return { ...ingress, port: address.port };
}

async function client(
  t: TestContext,
  port: number,
  ca: Buffer | Buffer[],
  name = authority,
): Promise<TLSSocket> {
  const socket = tlsConnect({
    host: "127.0.0.1",
    port,
    servername: name,
    ca,
    rejectUnauthorized: true,
  });
  t.after(() => {
    socket.destroy();
  });
  socket.on("error", () => socket.destroy());
  await once(socket, "secureConnect");
  return socket;
}

function unknownIssuer(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      error.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY")
  );
}

function upgrade(path = "/", authorization?: string, extra = ""): string {
  return (
    `GET ${path} HTTP/1.1\r\nHost: ${authority}:${transportPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
    (authorization === undefined ? "" : `Authorization: ${authorization}\r\n`) +
    extra +
    "\r\n"
  );
}

async function handshake(socket: TLSSocket, bytes: string): Promise<string> {
  const received = new Promise<string>((resolve, reject) => {
    let text = "";
    function data(chunk: Buffer) {
      text += chunk.toString("ascii");
      const end = text.indexOf("\r\n\r\n");
      if (end >= 0) {
        socket.off("data", data);
        socket.off("close", missing);
        resolve(text.slice(0, end));
      }
    }
    function missing() {
      reject(new Error("TLS connection closed before HTTP response."));
    }
    socket.on("data", data);
    socket.once("close", missing);
  });
  socket.write(bytes);
  return received;
}

test(
  "private ingress forwards root WebSocket upgrades to the original Unix native endpoint",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const ingress = await startTls(t, f);
    const send = async (wire: string) => handshake(await client(t, ingress.port, f.caBundle), wire);

    assert.match(await send(upgrade()), /^HTTP\/1\.1 401 /);
    assert.match(await send(upgrade("/", "Bearer wrong")), /^HTTP\/1\.1 401 /);
    assert.deepEqual(f.seen, [
      { path: "/", authorization: undefined },
      { path: "/", authorization: "Bearer wrong" },
    ]);

    // Wrong targets and ambiguous authentication never reach native.
    assert.match(await send(upgrade("http://other.example/", f.capability)), /^HTTP\/1\.1 400 /);
    assert.match(await send(upgrade("/?destination=other", f.capability)), /^HTTP\/1\.1 400 /);
    assert.match(
      await send(upgrade("/", f.capability, "Authorization: Bearer duplicate\r\n")),
      /^HTTP\/1\.1 400 /,
    );
    await assert.rejects(client(t, ingress.port, []), unknownIssuer);
    await assert.rejects(client(t, ingress.port, f.caBundle, "other.example"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    assert.equal(f.seen.length, 2);

    const socket = await client(t, ingress.port, f.caBundle);
    const response = await handshake(
      socket,
      upgrade("/", f.capability, "X-Forwarded-Host: other.example\r\n"),
    );
    assert.match(response, /^HTTP\/1\.1 101 /);
    assert.match(response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    const echoed = once(socket, "data");
    socket.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x6e, 0x69]));
    const [frame] = await echoed;
    assert.deepEqual(frame, Buffer.from([0x81, 2, 0x6f, 0x6b]));
    assert.deepEqual(f.seen.at(-1), { path: "/", authorization: f.capability });
  },
);

test(
  "a replaced owner socket retires established ingress and never receives a capability",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const ingress = await startTls(t, f);
    const socket = await client(t, ingress.port, f.caBundle);
    assert.match(await handshake(socket, upgrade("/", f.capability)), /^HTTP\/1\.1 101 /);
    const retired = once(ingress.server, "generationLost");
    const disconnected = once(socket, "close");
    const replacement = createServer();
    let replacementConnections = 0;
    replacement.on("connection", (peer) => {
      replacementConnections++;
      peer.destroy();
    });
    await rename(f.socketPath, join(f.runtimeDir, "retired.sock"));
    await listenUnix(replacement, f.socketPath);
    t.after(() => close(replacement));
    await retired;
    await disconnected;
    assert.equal(ingress.server.listening, false);
    await assert.rejects(client(t, ingress.port, f.caBundle), { code: "ECONNREFUSED" });
    await assert.rejects(
      createFixedIngress(
        {
          authority,
          runtimeDir: f.runtimeDir,
          readySha256: f.readySha256,
        },
        f.tls,
      ),
      { message: "The socket pathname does not identify the original owner socket." },
    );
    assert.equal(replacementConnections, 0);
    assert.equal(f.seen.length, 1);
  },
);

test(
  "ingress rejects a live process that does not own the listener and the CLI refuses loopback",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const finished = once(unrelated, "exit");
    t.after(async () => {
      unrelated.kill();
      await finished;
    });
    await once(unrelated, "spawn");
    assert.ok(unrelated.pid);
    const unrelatedPin = await writeReady(f.runtimeDir, unrelated.pid);
    await assert.rejects(
      createFixedIngress(
        {
          authority,
          runtimeDir: f.runtimeDir,
          readySha256: unrelatedPin,
        },
        f.tls,
      ),
      /does not own the Unix listener/,
    );
    const readySha256 = await writeReady(f.runtimeDir, process.pid);
    const cfg = join(f.runtimeDir, "ingress.json");
    await writeFile(
      cfg,
      JSON.stringify({
        authority,
        bindAddress: "127.0.0.1",
        certFile: f.leaf.certPath,
        keyFile: f.leaf.keyPath,
        readySha256,
        runtimeDir: f.runtimeDir,
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      run(process.execPath, [cli, cfg], { timeout: 3_000 }),
      (error: unknown) =>
        error instanceof Error &&
        "stderr" in error &&
        error.stderr ===
          "Box ingress startup refused. Check configuration, TLS and original generation.\n",
    );
  },
);

test(
  "owner exit retires the route even while the original filesystem socket remains",
  { timeout: 10_000 },
  async (t) => {
    const f = await materials(t);
    const owner = spawn(
      process.execPath,
      [
        "-e",
        `
    const fs = require("node:fs");
    const http = require("node:http");
    const path = process.argv[1];
    const server = http.createServer();
    server.on("upgrade", (_message, socket) => {
      socket.end("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n");
    });
    server.listen(path, () => {
      fs.chmodSync(path, 0o600);
      process.stdout.write("ready\\n");
    });
  `,
        f.socketPath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const finished = once(owner, "exit");
    t.after(async () => {
      owner.kill();
      await finished;
    });
    const [ready] = await once(owner.stdout, "data");
    assert.equal(String(ready), "ready\n");
    assert.ok(owner.pid);
    const original = await lstat(f.socketPath, { bigint: true });
    const readySha256 = await writeReady(f.runtimeDir, owner.pid);
    const ingress = await startTls(t, { ...f, readySha256 });
    const socket = await client(t, ingress.port, f.caBundle);
    assert.match(await handshake(socket, upgrade()), /^HTTP\/1\.1 401 /);

    const lost = once(ingress.server, "generationLost");
    owner.kill("SIGKILL");
    await finished;
    const stale = await lstat(f.socketPath, { bigint: true });
    assert.equal(
      stale.ino,
      original.ino,
      "the pathname alone does not establish an active listener",
    );
    await lost;
    assert.equal(ingress.server.listening, false);
    await assert.rejects(client(t, ingress.port, f.caBundle), { code: "ECONNREFUSED" });
  },
);

test(
  "relay readiness verifies TLS through the actual TCP relay and reaches native without a bearer",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const ingress = await startTls(t, f);
    const relay = createFixedRelay(() => connect(ingress.port, "127.0.0.1"));
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    t.after(() => {
      relay.stop();
    });
    const address = relay.server.address();
    assert.ok(address && typeof address !== "string");

    const options = { host: "127.0.0.1", port: address.port, authority, ca: f.caBundle };
    await probeNative(options);
    assert.deepEqual(f.seen, [{ path: "/", authorization: undefined }]);
    const foreignDir = await temporaryDirectory(t, "box-other-ca-");
    const foreignCa = await certificateAuthority(foreignDir, {
      caName: "Other CA",
      caKeyPem: undefined,
      days: 1,
    });
    await assert.rejects(
      probeNative({ ...options, ca: await readFile(foreignCa.caPath) }),
      unknownIssuer,
    );
    await assert.rejects(probeNative({ ...options, authority: "other.example" }), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    await assert.rejects(
      probeNative({ ...options, ca: Buffer.concat([f.caBundle, f.tls.key]) }),
      /public CA certificates/,
    );
    assert.equal(f.seen.length, 1);
    ingress.stop();
    await assert.rejects(
      probeNative(options),
      (error: unknown) =>
        error instanceof Error &&
        (("code" in error && error.code === "ECONNRESET") ||
          error.message === "Native readiness closed without a response."),
    );
    assert.equal(f.seen.length, 1);
  },
);
