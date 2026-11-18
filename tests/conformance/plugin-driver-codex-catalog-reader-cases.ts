import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { NativeCodexPluginCatalogReader } from "../../apps/controller/src/drivers/plugin/stdio-catalog-reader.ts";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import { NotImplementedError } from "../../packages/occ/src/index.ts";
import type { CodexCatalogPeer } from "../fixtures/codex-catalog-peer.mts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor } from "../helpers/wait-for.ts";
import {
  calendarPluginId,
  codexCatalogFixture,
  context as driverContext,
  linearPluginId,
  thirdPluginId,
} from "./plugin-driver-fixtures.ts";

function writePeerSettings(directory: string, settings: CodexCatalogPeer) {
  return writeFile(join(directory, "peer.json"), JSON.stringify(settings));
}

async function installPeer(directory: string, settings: CodexCatalogPeer): Promise<string> {
  const executable = join(directory, "codex-fixture.mts");
  await copyFile(new URL("../fixtures/codex-catalog-peer.mts", import.meta.url), executable);
  await writePeerSettings(directory, settings);
  await chmod(executable, 0o755);
  return executable;
}

test("native Codex catalog reader accepts initialized logged-in accounts and opaque remote IDs", async (context) => {
  const directory = await temporaryDirectory(context, "occ-codex-plugin-reader-");
  const catalogResponse = codexCatalogFixture();
  const executable = await installPeer(directory, {
    scenario: "catalog",
    accountType: "chatgpt",
    catalog: catalogResponse,
  });

  const reader = new NativeCodexPluginCatalogReader({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 1_000,
  });

  const catalog = await reader.listCatalog();
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    [linearPluginId, calendarPluginId, thirdPluginId],
  );
  const third = catalog[2];
  assert.ok(third);
  assert.equal(third.name, "Third Plugin");

  await writePeerSettings(directory, {
    scenario: "catalog",
    accountType: "apiKey",
    catalog: catalogResponse,
  });
  await assert.rejects(reader.listCatalog(), /ChatGPT\/Codex-backed account/);
});

test("native Codex catalog reader rejects, without crashing, when Codex closes its input early", async (context) => {
  const directory = await temporaryDirectory(context, "occ-codex-plugin-reader-");
  // Answers initialize after closing stdin, so the reader's next write hits a closed pipe.
  const executable = await installPeer(directory, { scenario: "closed-input" });
  const uncaught: NodeJS.ErrnoException[] = [];
  const record = (error: NodeJS.ErrnoException) => {
    uncaught.push(error);
  };
  // Record any uncaught error so the assertion below names it.
  process.prependListener("uncaughtException", record);
  context.after(() => process.off("uncaughtException", record));

  const reader = new NativeCodexPluginCatalogReader({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 5_000,
  });
  await assert.rejects(reader.listCatalog(), (error: unknown) => {
    assert.ok(error instanceof NotImplementedError);
    assert.equal(
      error.message,
      "Codex plugin catalog discovery could not send its request to Codex.",
    );
    return true;
  });
  await delay(100);
  assert.deepEqual(
    uncaught.map((error) => error.code ?? error.message),
    [],
  );
});

test("native Codex catalog reader does not echo the Codex app-server error message", async (context) => {
  const directory = await temporaryDirectory(context, "occ-codex-plugin-reader-");
  const executable = await installPeer(directory, { scenario: "rpc-error" });

  const reader = new NativeCodexPluginCatalogReader({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 5_000,
  });
  const error = await reader.listCatalog().then(
    () => assert.fail("the catalog read must fail"),
    (rejection: unknown) => rejection,
  );
  assert.ok(error instanceof NotImplementedError, String(error));
  // The 501 body carries this message; it names the request, never the app-server's text.
  const body = requestFailure(error);
  assert.equal(body.status, 501);
  assert.equal(body.message, "Codex plugin catalog discovery failed during account/read.");
  assert.ok(!body.message.includes(directory));
});

test("native Codex catalog reader kills a Codex process that ignores SIGTERM after an abort", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-codex-plugin-reader-"));
  const pidFile = join(directory, "codex.pid");
  let cleanupPid: number | undefined;
  context.after(async () => {
    if (cleanupPid !== undefined) {
      try {
        process.kill(cleanupPid, "SIGKILL");
      } catch {
        // Already gone: the reader stopped it.
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  // The PID file appears only once the SIGTERM handler is installed (rename is atomic).
  const executable = await installPeer(directory, { scenario: "ignore-term" });

  const reader = new NativeCodexPluginCatalogReader({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 60_000,
  });
  const controller = new AbortController();
  const listed = reader.listCatalog(controller.signal);
  listed.catch(() => {});
  const pid = await waitFor(
    "the Codex fixture to start",
    () =>
      readFile(pidFile, "utf8").then(
        (text) => Number(text) || undefined,
        () => undefined,
      ),
    30_000,
  );
  cleanupPid = pid;
  assert.ok(pid > 0, "the Codex fixture did not start");
  controller.abort();
  await assert.rejects(listed, /aborted/);
  // The aborted Codex app-server must not outlive the request.
  await waitFor(
    "the aborted Codex app-server to exit",
    () => {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch {
        return true;
      }
    },
    { timeoutMs: 5_000, intervalMs: 50 },
  );
  cleanupPid = undefined;
});

test("Codex native catalog rejects a non-object response without escaping discovery", async (t) => {
  const directory = await temporaryDirectory(t, "oce-codex-catalog-shape-");
  // The configured peer writes valid JSON with an invalid JSON-RPC envelope.
  // Exercise the public Driver and real OS pipes, not a substituted reader.
  const executable = await installPeer(directory, { scenario: "invalid-envelope" });
  const driver = new CodexPluginDriver({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 1_000,
  });
  await assert.rejects(driver.listCatalog(driverContext("dedicated")), (error: unknown) => {
    assert.ok(error instanceof NotImplementedError);
    assert.match(error.message, /returned an invalid JSON-RPC response/);
    return true;
  });
});

test("Codex native catalog rejects a malformed plugin/list result as discovery failure", async (t) => {
  const directory = await temporaryDirectory(t, "oce-codex-catalog-result-");
  const resultFile = join(directory, "plugin-list-result.json");
  // Valid envelopes from a logged-in account; only the plugin/list result varies.
  const executable = await installPeer(directory, { scenario: "catalog-file" });
  const driver = new CodexPluginDriver({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 5_000,
  });
  const listWith = async (result: unknown) => {
    await writeFile(resultFile, JSON.stringify(result));
    return await driver.listCatalog(driverContext("dedicated"));
  };
  const curated = (plugins: unknown) => ({
    marketplaces: [{ name: "openai-curated-remote", plugins }],
  });

  // Control: the same fixture serves a well-formed catalog.
  assert.deepEqual(
    (await listWith(codexCatalogFixture())).map((entry) => entry.id),
    [linearPluginId, calendarPluginId, thirdPluginId],
  );
  for (const empty of [
    { marketplaces: [] },
    { marketplaces: [{ name: "another-marketplace", plugins: [] }] },
    curated([]),
  ]) {
    assert.deepEqual(await listWith(empty), []);
  }
  const malformed = {
    "null result": null,
    "array result": [],
    "string result": "catalog",
    "result without marketplaces": {},
    "null marketplaces": { marketplaces: null },
    "curated marketplace without plugins": curated(undefined),
    "null curated plugin list": curated(null),
    "non-array curated plugin list": curated({}),
    "null plugin summary": curated([null]),
    "plugin without an ID": curated([{ remotePluginId: "linear" }]),
    "plugin from another marketplace": curated([
      { id: "linear@openai-internal-testing", remotePluginId: "linear" },
    ]),
  };
  for (const [name, result] of Object.entries(malformed)) {
    await assert.rejects(
      listWith(result),
      (error: unknown) => {
        assert.ok(error instanceof NotImplementedError, `${name}: ${error}`);
        assert.equal(
          error.message,
          "Codex plugin catalog discovery returned an invalid plugin catalog.",
          name,
        );
        return true;
      },
      name,
    );
  }
});
