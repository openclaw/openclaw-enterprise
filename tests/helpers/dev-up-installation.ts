import assert from "node:assert/strict";
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { asRecord } from "../../packages/utils/src/objects.ts";

type InstallationOptions = {
  requestLog: string;
  tlsDirectoryFile: string;
  scenario: string;
  installationId: string;
};

type ListeningPorts = { http: number; https: number };
type InstallationChild = ChildProcessByStdio<null, Readable, null>;

function parseListeningPorts(line: string): ListeningPorts {
  const parsed: unknown = JSON.parse(line);
  const ports = asRecord(parsed);
  const isPort = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535;
  assert.ok(
    ports && isPort(ports.http) && isPort(ports.https) && ports.http !== ports.https,
    "Invalid dev-up Installation fixture listening ports",
  );
  return { http: ports.http, https: ports.https };
}

// A child can emit the port line in several chunks, or close before finishing it.
function readListeningPorts(child: InstallationChild): Promise<ListeningPorts> {
  return new Promise((resolve, reject: (reason: unknown) => void) => {
    let pending = "";
    const deadline = setTimeout(
      () => fail(new Error("Timed out waiting for dev-up Installation fixture listeners")),
      10_000,
    );
    function detach() {
      clearTimeout(deadline);
      child.stdout.off("data", receive);
      child.stdout.off("error", fail);
      child.off("error", fail);
      child.off("close", closed);
    }
    function fail(error: Error) {
      detach();
      reject(error);
    }
    function closed(code: number | null, signal: NodeJS.Signals | null) {
      fail(
        new Error(
          `Dev-up Installation fixture exited before reporting listeners (${signal ?? code})`,
        ),
      );
    }
    function receive(chunk: Buffer) {
      pending += chunk.toString("utf8");
      if (pending.length > 1024) {
        fail(new Error("Invalid dev-up Installation fixture port line"));
        return;
      }
      const lineEnd = pending.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }
      try {
        const ports = parseListeningPorts(pending.slice(0, lineEnd));
        detach();
        resolve(ports);
      } catch (error) {
        detach();
        reject(error);
      }
    }
    child.once("error", fail);
    child.once("close", closed);
    child.stdout.once("error", fail);
    child.stdout.on("data", receive);
  });
}

export async function startDevUpInstallationServer(
  t: TestContext,
  { requestLog, tlsDirectoryFile, scenario, installationId }: InstallationOptions,
  stopProcess: (child: ChildProcess) => Promise<void>,
): Promise<ListeningPorts> {
  const entry = fileURLToPath(new URL("../fixtures/dev-up-installation-http.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [entry, requestLog, tlsDirectoryFile, scenario, installationId],
    { env: {}, stdio: ["ignore", "pipe", "inherit"] },
  );
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  t.after(async () => {
    try {
      await stopProcess(child);
    } finally {
      await closed;
    }
  });
  return readListeningPorts(child);
}
