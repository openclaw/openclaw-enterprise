import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { connect as connectTls } from "node:tls";

export async function launchStrandsSender(t: TestContext, binary: string, configPath: string) {
  const child = spawn(resolve(binary), [configPath], { stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk.toString();
  });
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGINT");
      await exited;
    }
  }
  t.after(async () => {
    t.diagnostic(diagnostic);
    await stop();
  });
  const startup = await new Promise<{ port: number; ca: string }>((fulfill, reject) => {
    let output = "";
    child.on("error", reject);
    child.once("exit", () => reject(new Error(`sender exited: ${diagnostic}`)));
    child.stdout.on("data", (bytes) => {
      output += bytes.toString();
      if (output.includes("\n")) {
        try {
          fulfill(JSON.parse(output.split("\n")[0]!));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  return { ...startup, diagnostics: () => diagnostic, stop };
}

export async function sendThroughStrandsGateway(
  t: TestContext,
  gateway: { port: number; ca: string },
  providerPort: number,
  headers: string,
  body: string,
): Promise<string> {
  const socket = connect(gateway.port, "127.0.0.1");
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const connected = once(socket, "data");
  socket.write(
    `CONNECT provider.example.test:${providerPort} HTTP/1.1\r\nHost: provider.example.test:${providerPort}\r\n\r\n`,
  );
  assert.match((await connected)[0].toString(), /200/);
  const tls = connectTls({
    socket,
    servername: "provider.example.test",
    ca: await readFile(gateway.ca),
  });
  t.after(() => tls.destroy());
  await once(tls, "secureConnect");
  const response = new Promise<string>((fulfill, reject) => {
    let output = "";
    tls.on("data", (chunk) => {
      output += chunk.toString();
    });
    tls.on("end", () => fulfill(output));
    tls.on("error", reject);
    tls.setTimeout(25000, () => tls.destroy(new Error("response timeout")));
  });
  tls.write(
    `POST /v1/responses HTTP/1.1\r\nHost: provider.example.test:${providerPort}\r\n${headers}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
  return response;
}
