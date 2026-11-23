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
const secretLimitBytes = 1024 * 1024;

export function registerUpgradePreflightDraftBudgetTest(repository: string): void {
  test("the startup preflight Secret preserves API draft admission and fits direct-egress guard targets when possible", async (t) => {
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
        executionMode: "dedicated",
        values: {
          channels: { slack: { enabled: true } },
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
      return execute(
        process.execPath,
        [
          "scripts/upgrade-startup-preflight.ts",
          "drafts",
          drafts,
          installation,
          join(directory, `drafts-${installationBytes}.json.gz`),
          join(directory, `targets-${installationBytes}.json.gz`),
        ],
        { cwd: repository, env: withoutShellStartup(process.env) },
      );
    };

    const bothFit = await gather(1024);
    assert.equal(bothFit.stderr, "");
    const apiBytes = (await stat(join(directory, "drafts-1024.json.gz"))).size;
    assert.ok(apiBytes > 640 * 1024);
    assert.ok((await stat(join(directory, "targets-1024.json.gz"))).size < 1024);

    // At the exact limit the API draft still fits. The direct-egress guard targets are the only omission.
    const fitsDraftOnly = secretLimitBytes - apiBytes;
    const draftOnly = await gather(fitsDraftOnly);
    assert.equal((await stat(join(directory, `drafts-${fitsDraftOnly}.json.gz`))).size, apiBytes);
    assert.equal(existsSync(join(directory, `targets-${fitsDraftOnly}.json.gz`)), false);
    assert.match(
      draftOnly.stderr,
      /channel direct-egress guard forecast was skipped because its targets do not fit in the startup preflight Secret beside the candidate Installation and the recorded Agents' drafts\./,
    );

    await assert.rejects(gather(400 * 1024), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === 3);
      assert.ok("stderr" in error && typeof error.stderr === "string");
      assert.match(
        error.stderr,
        /1 Agent drafts take \d+ bytes gzipped; with the 409600-byte candidate Installation that is over the 1048576-byte Secret limit\./,
      );
      assert.doesNotMatch(error.stderr, /direct-egress guard forecast was skipped/);
      return true;
    });
    assert.equal(existsSync(join(directory, "drafts-409600.json.gz")), false);
    assert.ok((await stat(join(directory, "targets-409600.json.gz"))).size < 1024);

    // When neither input fits, the channel warning names only the Installation.
    const installationBytes = secretLimitBytes - 1;
    await assert.rejects(gather(installationBytes), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === 3);
      assert.ok("stderr" in error && typeof error.stderr === "string");
      assert.match(
        error.stderr,
        /channel direct-egress guard forecast was skipped because its targets do not fit in the startup preflight Secret beside the candidate Installation\./,
      );
      return true;
    });
    assert.equal(existsSync(join(directory, `drafts-${installationBytes}.json.gz`)), false);
    assert.equal(existsSync(join(directory, `targets-${installationBytes}.json.gz`)), false);
  });

  test("drafts without eligible channels use no channel input space", async (t) => {
    const directory = await temporaryDirectory(t, "occ-upgrade-drafts-");
    const drafts = join(directory, "agent-drafts.jsonl");
    const installation = join(directory, "installation.yaml");
    const draftOutput = join(directory, "drafts.json.gz");
    const channelOutput = join(directory, "targets.json.gz");
    await writeFile(installation, "{}");
    const ineligible = [
      { executionMode: "dedicated", channels: {} },
      { executionMode: "dedicated", channels: { slack: { enabled: false }, defaults: {} } },
      { executionMode: "embedded", channels: { slack: { enabled: true } } },
    ];
    await writeFile(
      drafts,
      ineligible
        .map(({ executionMode, channels }, index) =>
          JSON.stringify({
            namespaceId: "ns_test",
            agentId: `agt_${index}`,
            name: `Agent ${index}`,
            configurationId: `cfg_${index}`,
            executionMode,
            values: { channels },
          }),
        )
        .join("\n") + "\n",
    );

    const { stderr } = await execute(
      process.execPath,
      [
        "scripts/upgrade-startup-preflight.ts",
        "drafts",
        drafts,
        installation,
        draftOutput,
        channelOutput,
      ],
      { cwd: repository, env: withoutShellStartup(process.env) },
    );
    assert.equal(stderr, "");
    assert.ok(existsSync(draftOutput));
    assert.equal(existsSync(channelOutput), false);
  });
}
