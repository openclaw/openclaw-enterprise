import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { followContainer } from "../helpers/docker-follow.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import {
  assertDispatchReport,
  dispatchEffectsScript,
  prepareDispatchInputs,
} from "./automation-model-only-dispatch-inputs.ts";

export async function runEmbeddedAutomationDispatchProbe(t: TestContext, image: string) {
  const nonce = randomUUID();
  const name = `oce-supplemental-dispatch-openclaw-${nonce}`;
  const directory = await mkdtemp(join(tmpdir(), `${name}-`));
  t.after(async () => {
    const present = await runDocker(["ps", "-aq", "--filter", `name=^/${name}$`]);
    if (present.stdout.trim()) {
      await runDocker(["rm", "--force", "--volumes", name]);
    }
    assert.equal(
      (await runDocker(["ps", "-aq", "--filter", `name=^/${name}$`])).stdout.trim(),
      "",
      "owned container must be absent after cleanup",
    );
    // Retain mounted input if Docker cleanup fails; never hide a running container.
    await rm(directory, { recursive: true, force: true });
  });
  await prepareDispatchInputs(directory, { nonce, harness: "openclaw", probeTool: "write" });
  await runDocker([
    "run",
    "--detach",
    "--pull=never",
    "--name",
    name,
    "--network",
    "none",
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=0",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--tmpfs",
    "/home/node:uid=1000,gid=1000,mode=700",
    "--tmpfs",
    "/tmp:uid=1000,gid=1000,mode=1777",
    "--volume",
    `${directory}:/fixture:ro`,
    "--volume",
    `${join(directory, "hosts")}:/etc/hosts:ro`,
    "--volume",
    `${join(directory, "resolv.conf")}:/etc/resolv.conf:ro`,
    "--security-opt",
    "no-new-privileges",
    "--entrypoint",
    "node",
    image,
    "/fixture/automation-model-only-dispatch-runtime.mjs",
  ]);
  const logs = followContainer(undefined, name, { exit: false });
  let report: Record<string, unknown> | undefined;
  try {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const seen = logs.changes.version;
      const output = logs.read();
      for (const line of `${output.stdout}\n${output.stderr}`.split("\n")) {
        if (line.startsWith('{"kind":"supplemental-dispatch-projection')) {
          report = JSON.parse(line) as Record<string, unknown>;
        }
      }
      if (report) {
        break;
      }
      assert.ok(output.following, "supplemental runner ended without a dispatch report");
      await logs.changes.wait(seen, Math.min(1000, deadline - Date.now()));
    }
  } finally {
    await logs.stop();
  }
  assertDispatchReport(report, "openclaw", "write");
  const effects = await runDocker([
    "exec",
    name,
    "node",
    "-e",
    dispatchEffectsScript,
    "/home/node/.openclaw/workspace",
    nonce,
  ]);
  assert.deepEqual(
    JSON.parse(effects.stdout),
    { positiveMatches: true, negativeAbsent: true },
    JSON.stringify(report),
  );
  await runDocker([
    "exec",
    name,
    "node",
    "-e",
    'require("node:fs").writeFileSync("/tmp/dispatch-proof-release", "done");',
  ]);
  t.diagnostic(
    JSON.stringify({
      ...report,
      positiveFileEffect: true,
      negativeFileAbsent: true,
      placement: "embedded Gateway in a network-none container",
    }),
  );
}
