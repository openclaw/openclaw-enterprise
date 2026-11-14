import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { withoutShellStartup } from "../helpers/environment.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const execute = promisify(execFile);

export function registerUpgradePreflightDraftBudgetTest(repository: string): void {
  test("the drafts budget is the Secret limit less the candidate Installation", async (t) => {
    const directory = await temporaryDirectory(t, "occ-upgrade-drafts-");
    const drafts = join(directory, "agent-drafts.jsonl");

    // About 700 KiB of gzipped drafts fit beside a small Installation, but not
    // beside a 400 KiB Installation. Random data keeps that gap after compression.
    await writeFile(
      drafts,
      JSON.stringify({
        namespaceId: "ns_test",
        agentId: "agt_test",
        name: "Mail triage",
        configurationId: "cfg_agt_test",
        values: {
          plugins: {
            entries: {
              knowledge: { config: { note: randomBytes(700 * 1024).toString("base64") } },
            },
          },
        },
      }) + "\n",
    );
    const gather = async (installationBytes: number) => {
      const installation = join(directory, `installation-${installationBytes}.yaml`);
      await writeFile(installation, "x".repeat(installationBytes));
      await execute(
        process.execPath,
        [
          "scripts/upgrade-startup-preflight.ts",
          "drafts",
          drafts,
          installation,
          join(directory, `drafts-${installationBytes}.json.gz`),
        ],
        { cwd: repository, env: withoutShellStartup(process.env) },
      );
    };

    await gather(1024);
    assert.ok((await stat(join(directory, "drafts-1024.json.gz"))).size > 640 * 1024);
    await assert.rejects(gather(400 * 1024), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === 3);
      assert.ok("stderr" in error && typeof error.stderr === "string");
      assert.match(
        error.stderr,
        /1 Agent drafts take \d+ bytes gzipped; with the 409600-byte candidate Installation that is over the 1048576-byte Secret limit\./,
      );
      return true;
    });
    assert.equal(existsSync(join(directory, "drafts-409600.json.gz")), false);
  });
}
