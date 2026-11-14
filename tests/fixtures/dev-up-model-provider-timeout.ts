import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { asRecord } from "../../packages/utils/src/objects.ts";
import { runDevUpModelProviderCase } from "../helpers/dev-up-model-provider.mjs";
import type { LauncherScope } from "../helpers/dev-up-model-provider.mjs";

const directory = process.env.OCC_TEST_PROVIDER_TIMEOUT_DIRECTORY;
assert.ok(directory, "expected the parent's temporary directory");
const trace = join(directory, "trace.jsonl");
const root = join(directory, "case");
const mark = (event: string) => appendFileSync(trace, JSON.stringify(event) + "\n");
mkdirSync(root);

test("deliberate cancellation", { timeout: 500 }, async (t) => {
  const scope: LauncherScope = {
    signal: t.signal,
    after: (cleanup) =>
      t.after(async () => {
        mark("teardown-start");
        await cleanup();
        mark("teardown-end");
      }),
  };
  await runDevUpModelProviderCase(
    scope,
    {
      root,
      cluster: "owned",
      environment: { OCC_DEVELOPMENT_STATE_DIRECTORY: join(root, "state") },
    },
    async ({ execute, provider }) => {
      // Report actual process closure after the graceful signal, while the
      // timeout has already started the owner's teardown hook.
      await assert.rejects(
        execute(process.execPath, [
          "-e",
          `
            const { appendFileSync } = require("node:fs");
            const mark = (event) => appendFileSync(process.argv[1], JSON.stringify(event) + "\\n");
            process.on("SIGTERM", () => setTimeout(() => { mark("process-settled"); process.exit(0); }, 100));
            mark("command-started");
            setInterval(() => {}, 1000);
          `,
          trace,
        ]),
        (error: unknown) => {
          assert.equal(asRecord(error)?.code, "ABORT_ERR");
          return true;
        },
      );
      assert.equal(existsSync(root), true, "recovery files survive until the body settles");
      await assert.rejects(execute(process.execPath, ["-e", "process.exit(73)"]), {
        name: "AbortError",
      });
      await assert.rejects(provider.route(root), { name: "AbortError" });
      mark("body-settled");
    },
  );
});
