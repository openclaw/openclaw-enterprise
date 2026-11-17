import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { policy } from "../../deploy/examples/strands-box/host/egress.ts";
import {
  WORKSPACE_MARKER,
  WORKSPACE_VERIFIER,
  verifyWorkspaceVerifier,
  workspaceVerifierPolicy,
  workspaceVerifierTool,
} from "../../deploy/examples/strands-box/host/workspace-verifier.ts";

// Manual lane strands-box-native (docs/testing/strands-box.md). These cases
// need host material CI does not have, so they run only when the lane selects
// them and then fail, never skip, on a missing prerequisite.
const selection =
  process.env.OCC_TEST_STRANDS_BOX_NATIVE === "1"
    ? false
    : "select the strands-box-native lane (OCC_TEST_STRANDS_BOX_NATIVE=1)";

function assertOwnedLinux() {
  assert.equal(process.platform, "linux", "the Box host checks read Linux process identity");
  assert.notEqual(process.getuid?.(), 0, "run the Box host checks as an unprivileged user");
}

function temporary(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "oce-box-test-"));
}

const stockShellBox = process.env.OCC_TEST_STRANDS_BOX_SHELL_BOX;
const stockShellVerifierSha = process.env.OCC_TEST_STRANDS_BOX_SHELL_VERIFIER_SHA256;

test(
  "stock Box Shell Calls admit only the fixed read-only workspace verifier",
  {
    skip: selection,
    timeout: 55_000,
  },
  async () => {
    assertOwnedLinux();
    assert.equal(process.arch, "arm64", "the stock Box Shell Calls check runs on ARM64");
    assert.ok(
      stockShellBox && stockShellVerifierSha,
      "set OCC_TEST_STRANDS_BOX_SHELL_BOX and OCC_TEST_STRANDS_BOX_SHELL_VERIFIER_SHA256",
    );
    const box = realpathSync(stockShellBox);
    for (const [name, sha256] of [
      ["box", "ba33afffe5ae54bdc2e6eaa377f96e54f89d3b10cbb35c666d553854a3a2741b"],
      [
        "strands-box-contain-trampoline",
        "58ab37fa0f8fb27a83ae072064cf78f865db4d6334f2c648252af9567983b54c",
      ],
      [
        "strands-box-sock-alias",
        "7c0e69499deb257a7dcfe2d18862742131e3e4fbaa6487f04151f74462909a69",
      ],
    ]) {
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(dirname(box), name!)))
          .digest("hex"),
        sha256,
      );
    }
    assert.equal(box, join(dirname(box), "box"));
    const root = temporary();
    let canRemove = true;
    try {
      const workspace = join(root, "workspace");
      const operator = join(root, "operator");
      const home = join(root, "agent");
      for (const directory of [workspace, operator, home]) {
        mkdirSync(directory, { mode: 0o700 });
      }
      const marker = randomBytes(24).toString("hex");
      writeFileSync(join(workspace, WORKSPACE_MARKER), marker + "\n", { mode: 0o600, flag: "wx" });
      const identity = lstatSync(join(workspace, WORKSPACE_MARKER), { bigint: true });
      verifyWorkspaceVerifier(stockShellVerifierSha, workspace);

      const { default: compiler } = await import("typescript-compiler-api");
      const source = fileURLToPath(
        new URL("../helpers/strands-box-shell-probe.ts", import.meta.url),
      );
      const probe = join(root, "probe.mjs");
      const compiled = compiler.transpileModule(readFileSync(source, "utf8"), {
        compilerOptions: {
          target: compiler.ScriptTarget.ES2022,
          module: compiler.ModuleKind.ESNext,
        },
        fileName: source,
        reportDiagnostics: true,
      });
      assert.equal(compiled.diagnostics?.length ?? 0, 0);
      writeFileSync(probe, compiled.outputText, { mode: 0o400, flag: "wx" });
      const node = realpathSync(process.execPath);
      const config = join(root, "box.toml");
      const policyPath = join(root, "policy.dw");
      writeFileSync(policyPath, policy([]) + workspaceVerifierPolicy(workspace), {
        mode: 0o600,
        flag: "wx",
      });
      writeFileSync(
        config,
        [
          'name = "oce-shell-calls-fixture"',
          `box_dir = ${JSON.stringify(join(root, "state"))}`,
          `policy = ${JSON.stringify(policyPath)}`,
          "[agent]",
          `command = ${JSON.stringify([node, "--jitless", probe, WORKSPACE_VERIFIER])}`,
          `workspace = ${JSON.stringify(workspace)}`,
          "[agent.env]",
          `HOME = ${JSON.stringify(home)}`,
          'PATH = "/usr/local/bin:/usr/bin:/bin"',
          "[agent.filesystem]",
          `read = ${JSON.stringify([workspace, home, probe])}`,
          `write = ${JSON.stringify([home])}`,
          `exec = ${JSON.stringify([node])}`,
          workspaceVerifierTool(workspace),
        ].join("\n"),
        { mode: 0o600, flag: "wx" },
      );
      const result = spawnSync(box, ["run", "--config", config], {
        cwd: root,
        env: { HOME: operator, PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeout: 45_000,
        maxBuffer: 256_000,
        encoding: "utf8",
      });
      if (result.error !== undefined || result.signal !== null) {
        canRemove = false;
      }
      assert.ifError(result.error);
      assert.equal(result.status, 0, "the stock Box run must finish successfully");
      const prefix = "OCE_BOX_SHELL_TEST_JSON ";
      const lines = result.stdout.split("\n").filter((line) => line.startsWith(prefix));
      assert.equal(
        lines.length,
        1,
        "the original Box workload must return one Shell Calls receipt",
      );
      const receipt: unknown = JSON.parse(lines[0]!.slice(prefix.length));
      const denied = { exitCode: 126, stdout: "", policyDenied: true };
      assert.deepEqual(receipt, {
        marker: {
          exitCode: 0,
          stdout: `OCE_BOX_MARKER_IDENTITY ${process.geteuid!()} ${identity.dev} ${identity.ino}\nOCE_BOX_MODEL_MARKER ${marker}\n`,
          policyDenied: false,
        },
        extraArgument: denied,
        builtin: denied,
        nestedShell: denied,
      });
      const telemetry = join(root, "state/private/telemetry/records.jsonl");
      assert.ok(lstatSync(telemetry).size < 1_000_000, "bounded stock decision log");
      interface DecisionEvent {
        resourceLogs?: {
          scopeLogs?: {
            scope?: { name?: string };
            logRecords?: { attributes?: { key: string; value?: { stringValue?: string } }[] }[];
          }[];
        }[];
      }
      let admitted = 0;
      for (const line of readFileSync(telemetry, "utf8").trimEnd().split("\n")) {
        const record = JSON.parse(line) as DecisionEvent;
        for (const resource of record.resourceLogs ?? []) {
          for (const scope of resource.scopeLogs ?? []) {
            if (scope.scope?.name !== "strands-box.policy") {
              continue;
            }
            for (const log of scope.logRecords ?? []) {
              const attributes = new Map(
                (log.attributes ?? []).map(({ key, value }) => [key, value?.stringValue]),
              );
              if (
                attributes.get("strands.box.policy.action") === "shell:spawn" &&
                attributes.get("strands.box.policy.verdict") === "permit" &&
                attributes.get("strands.box.policy.rule") === "oce_workspace_verifier"
              ) {
                admitted++;
              }
            }
          }
        }
      }
      assert.equal(admitted, 1, "stock Box recorded the named shell:spawn permit");
      assert.equal(readFileSync(join(workspace, WORKSPACE_MARKER), "utf8"), marker + "\n");
    } finally {
      if (canRemove) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
