import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WORKSPACE_SETUP_RUNTIME,
  workspaceSetupVerifier,
} from "../../apps/controller/src/drivers/compute/workspace-setup-runtime.ts";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";

const executable = process.env.OCC_TEST_WORKSPACE_OPENCLAW_PATH;
const image = executable === undefined ? process.env.OCC_TEST_RUNTIME_IMAGE : undefined;
const identity = { id: "setup-one", namespaceId: "namespace-one", agentId: "agent-one" };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "oce-workspace-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "home"));
  const workspace = join(root, "workspace");
  const env = {
    HOME: join(root, "home"),
    OPENCLAW_STATE_DIR: join(root, "state"),
    OPENCLAW_WORKSPACE_DIR: workspace,
    OPENCLAW_EXECUTABLE:
      executable ?? (image === undefined ? join(root, "absent-runtime.mjs") : "/app/openclaw.mjs"),
    OPENCLAW_WORKSPACE_SETUP_PATH: undefined,
  };
  const execute = (script, input, extraEnv = {}) => {
    const runtimeEnv = { ...env, ...extraEnv };
    const options = { input, encoding: "utf8", timeout: 300000 };
    if (image === undefined) {
      return spawnSync(process.execPath, ["-e", script], {
        ...options,
        env: { ...process.env, ...runtimeEnv },
      });
    }
    return spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--interactive",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        String(process.getuid()) + ":" + String(process.getgid()),
        "--volume",
        root + ":" + root,
        ...Object.entries(runtimeEnv).flatMap(([key, value]) =>
          value === undefined ? [] : ["--env", key + "=" + value],
        ),
        "--entrypoint",
        "node",
        image,
        "-e",
        script,
      ],
      options,
    );
  };
  return {
    root,
    workspace,
    execute,
    run: (payload, extraEnv = {}) =>
      execute(WORKSPACE_SETUP_RUNTIME, JSON.stringify(payload), extraEnv),
  };
}
function failed(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "WORKSPACE_SETUP_FAILED\n");
}
function passed(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { completed: true, id: identity.id });
}

test("workspace setup fails closed for invalid delivery, lost completed workspace, and symlink escape", (t) => {
  const f = fixture(t);
  for (const files of [
    { "USER.md": "secret\0value" },
    { "USER.md": "\ud800" },
    { "../USER.md": "secret" },
  ]) {
    failed(f.run({ ...identity, completed: false, files }));
  }
  failed(f.run({ ...identity, completed: true }));
  assert.equal(existsSync(f.workspace), false);
  mkdirSync(join(f.root, "outside"));
  symlinkSync(join(f.root, "outside"), f.workspace);
  failed(f.run({ ...identity, completed: false, files: { "USER.md": "secret" } }));
  assert.equal(existsSync(join(f.root, "outside", "USER.md")), false);
});

test("workspace completion verification uses the Sandbox runtime path and retains edited files", (t) => {
  const f = fixture(t);
  const sandboxWorkspace = join(f.root, "sandbox-workspace");
  mkdirSync(sandboxWorkspace);
  // A prior successful initializer left this exact identity marker. Its workspace is
  // now mounted at the Sandbox path rather than Compute's native path.
  writeFileSync(join(sandboxWorkspace, ".oce-workspace-setup.json"), JSON.stringify(identity));
  writeFileSync(join(sandboxWorkspace, "USER.md"), "edited after initialization");
  const verify = workspaceSetupVerifier(identity, { environment: "OPENCLAW_WORKSPACE_DIR" });
  const verified = f.execute(verify, "", { OPENCLAW_WORKSPACE_DIR: sandboxWorkspace });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(
    readFileSync(join(sandboxWorkspace, "USER.md"), "utf8"),
    "edited after initialization",
  );
  assert.equal(
    existsSync(f.workspace),
    false,
    "verification must not initialize the old mount path",
  );
  failed(f.execute(verify, ""));
  writeFileSync(
    join(sandboxWorkspace, ".oce-workspace-setup.json"),
    JSON.stringify({ ...identity, agentId: "another-agent" }),
  );
  failed(f.execute(verify, "", { OPENCLAW_WORKSPACE_DIR: sandboxWorkspace }));
});

const native = {
  skip:
    executable === undefined && image === undefined
      ? "Set OCC_TEST_WORKSPACE_OPENCLAW_PATH or OCC_TEST_RUNTIME_IMAGE to the pinned native runtime."
      : false,
};
test(
  "native workspace setup preserves stock provisioning, template parity, and later edits across restart",
  native,
  (t) => {
    const f = fixture(t);
    const setup = {
      ...identity,
      defaultsId: WORKSPACE_DEFAULTS_ID,
      completed: false,
      files: WORKSPACE_DEFAULTS,
    };
    const delivery = join(f.root, "delivery.json");
    writeFileSync(delivery, JSON.stringify(setup), { mode: 0o600 });
    passed(f.run(setup, { OPENCLAW_WORKSPACE_SETUP_PATH: delivery }));
    assert.equal(existsSync(delivery), false);
    for (const [name, content] of Object.entries(WORKSPACE_DEFAULTS)) {
      assert.equal(readFileSync(join(f.workspace, name), "utf8"), content);
    }
    assert.equal(existsSync(join(f.workspace, ".git")), true);
    assert.equal(existsSync(join(f.workspace, "BOOTSTRAP.md")), true);
    writeFileSync(join(f.workspace, "USER.md"), "later gateway edit\r\n");
    // A lost completion acknowledgement may resend the original payload; it must not replay.
    passed(f.run(setup));
    const completed = { ...identity, defaultsId: WORKSPACE_DEFAULTS_ID, completed: true };
    writeFileSync(delivery, JSON.stringify(completed), { mode: 0o600 });
    passed(
      f.run(completed, {
        OPENCLAW_WORKSPACE_SETUP_PATH: delivery,
        OPENCLAW_EXECUTABLE: "/missing-upgraded-runtime",
      }),
    );
    assert.equal(existsSync(delivery), true);
    assert.equal(readFileSync(join(f.workspace, "USER.md"), "utf8"), "later gateway edit\r\n");
    const verified = f.execute(workspaceSetupVerifier(completed, f.workspace), "");
    assert.equal(verified.status, 0, verified.stderr);
    failed(f.run({ ...completed, agentId: "another-agent" }));
    rmSync(join(f.workspace, ".oce-workspace-setup.json"));
    failed(f.run(completed));
  },
);

test(
  "native workspace setup preserves empty/exact API content and resumes partial writes without clobbering divergence",
  native,
  (t) => {
    const f = fixture(t);
    passed(f.run({ ...identity, completed: false, files: WORKSPACE_DEFAULTS }));
    rmSync(join(f.workspace, ".oce-workspace-setup.json"));
    const files = { "SOUL.md": "", "USER.md": "profile\r\nwith exact newlines\r" };
    // An atomic file replacement survived but its setup completion marker did not.
    writeFileSync(join(f.workspace, "SOUL.md"), "");
    writeFileSync(join(f.workspace, ".oce-workspace-setup.tmp"), "interrupted private content");
    passed(f.run({ ...identity, completed: false, files }));
    assert.equal(readFileSync(join(f.workspace, "SOUL.md"), "utf8"), "");
    assert.equal(existsSync(join(f.workspace, ".oce-workspace-setup.tmp")), false);
    assert.equal(readFileSync(join(f.workspace, "USER.md"), "utf8"), files["USER.md"]);
    assert.equal(existsSync(join(f.workspace, "BOOTSTRAP.md")), false);
    rmSync(join(f.workspace, ".oce-workspace-setup.json"));
    writeFileSync(join(f.workspace, "USER.md"), "independent user change");
    failed(f.run({ ...identity, completed: false, files }));
    assert.equal(readFileSync(join(f.workspace, "USER.md"), "utf8"), "independent user change");
  },
);

test(
  "native workspace setup rejects stale defaults and hard-linked files without modifying external data",
  native,
  (t) => {
    const f = fixture(t);
    failed(
      f.run({
        ...identity,
        defaultsId: "0".repeat(64),
        completed: false,
        files: { "USER.md": "private" },
      }),
    );
    assert.equal(existsSync(f.workspace), false);
    // Reject a changed runtime before even raw API setup can create workspace files.
    const changedRuntime = join(f.root, "changed-runtime");
    const copied = f.execute(
      `const fs = require("node:fs");
       const path = require("node:path");
       let root = path.dirname(fs.realpathSync(process.env.OPENCLAW_EXECUTABLE));
       while (JSON.parse(fs.readFileSync(path.join(root, "package.json"))).name !== "openclaw") {
         root = path.dirname(root);
       }
       const target = ${JSON.stringify(changedRuntime)};
       fs.mkdirSync(target);
       fs.copyFileSync(path.join(root, "package.json"), path.join(target, "package.json"));
       fs.cpSync(path.join(root, "docs"), path.join(target, "docs"), { recursive: true });
       fs.writeFileSync(path.join(target, "openclaw.mjs"), "throw new Error('must not execute');");`,
      "",
    );
    assert.equal(copied.status, 0, copied.stderr);
    const manifestPath = join(changedRuntime, "package.json");
    const manifest = readFileSync(manifestPath, "utf8");
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...JSON.parse(manifest), version: "unsupported-runtime" }),
    );
    const changedEnv = { OPENCLAW_EXECUTABLE: join(changedRuntime, "openclaw.mjs") };
    const rawSetup = { ...identity, completed: false, files: { "USER.md": "private" } };
    failed(f.run(rawSetup, changedEnv));
    assert.equal(existsSync(f.workspace), false);
    writeFileSync(manifestPath, manifest);
    writeFileSync(join(changedRuntime, "docs", "reference", "templates", "USER.md"), "changed");
    failed(f.run(rawSetup, changedEnv));
    assert.equal(existsSync(f.workspace), false);
    mkdirSync(f.workspace);
    const external = join(f.root, "outside.txt");
    writeFileSync(external, WORKSPACE_DEFAULTS["USER.md"]);
    linkSync(external, join(f.workspace, "USER.md"));
    failed(f.run({ ...identity, completed: false, files: { "USER.md": "private" } }));
    assert.equal(readFileSync(external, "utf8"), WORKSPACE_DEFAULTS["USER.md"]);
  },
);
