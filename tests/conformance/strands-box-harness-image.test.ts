import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  nodeProgramArguments,
  withoutLineComments,
} from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  splitSelectedHarnessImageCommand,
  stockHarnessCommand,
} from "../../deploy/examples/strands-box/host/control.ts";
import {
  assertHarnessImageCommand,
  assertHarnessImageExecutables,
  assertHarnessImageMounts,
  assertHarnessImageView,
  readHarnessImageSplit,
  verifyHarnessImageFile,
} from "../../deploy/examples/strands-box/host/installed-harness-image.ts";
import { splitStockCommand } from "../../deploy/examples/strands-box/host/installed-workspace-node.ts";

const stockPath =
  "/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const selectedRoot = "37 14 8:1 /prepared/harness / ro,nosuid,nodev - ext4 /dev/root rw";
const workspace = "47 37 8:2 /claim/workspace /home/node/workspace rw - ext4 /dev/work rw";
const supportTool = "48 37 8:2 /bin/bwrap /usr/bin/bwrap ro - ext4 /dev/work rw";
const scratch = "49 37 0:31 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw";

test("a selected Harness root may share the view with the independent workspace and host tool", () => {
  assert.doesNotThrow(() =>
    assertHarnessImageMounts([selectedRoot, workspace, supportTool, scratch].join("\n"), "37"),
  );
});

test("a selected Harness root refuses mount replacement, writable aliases and runtime shadows", () => {
  const verify = (...rows: string[]) =>
    assertHarnessImageMounts([...rows, scratch].join("\n"), "37");
  assert.throws(() => verify(selectedRoot.replace("37 ", "55 ")), /root_not_read_only_or_replaced/);
  assert.throws(() => verify(selectedRoot.replace("ro,", "rw,")), /root_not_read_only_or_replaced/);
  assert.throws(() => verify(selectedRoot, selectedRoot), /root_not_read_only_or_replaced/);
  assert.throws(
    () => assertHarnessImageMounts(selectedRoot, "37"),
    /requires_separate_box_scratch/,
  );
  assert.throws(
    () => verify(selectedRoot, "50 37 8:1 /prepared /backing rw - ext4 /dev/root rw"),
    /writable_alias/,
  );
  for (const path of ["/opt", "/usr/local/bin/node", "/lib", "/app/plugin\\040assets"]) {
    assert.throws(
      () => verify(selectedRoot, `50 37 8:2 /unrelated ${path} ro - ext4 /dev/work rw`),
      /runtime_overmounted/,
    );
  }
  assert.throws(
    () =>
      assertHarnessImageView({
        bootId: "00000000-0000-0000-0000-000000000000",
        mountId: "37",
        root: { dev: "0", ino: "1" },
        commandSha256: "0".repeat(64),
      }),
    /root_identity_changed/,
  );
});

test("a selected Harness root pins its independent read-only support mounts", () => {
  const support = ["/opt/box/bin", "/opt/oce-box/compiled-agent"];
  const box = "51 37 8:3 /box /opt/box ro - ext4 /dev/tools ro";
  const agent = "52 37 8:4 /agent /opt/oce-box/compiled-agent ro - ext4 /dev/agent ro";
  const inventory = (...rows: string[]) => [selectedRoot, scratch, workspace, ...rows].join("\n");
  const snapshot = assertHarnessImageMounts(inventory(box, agent), "37", support);
  assert.equal(assertHarnessImageMounts(inventory(agent, box), "37", support, snapshot), snapshot);
  assert.throws(
    () =>
      assertHarnessImageMounts(
        inventory(box.replace("51 ", "53 "), agent),
        "37",
        support,
        snapshot,
      ),
    /support_mount_replaced/,
  );
  assert.throws(
    () => assertHarnessImageMounts(inventory(box, agent.replace(" ro ", " rw ")), "37", support),
    /support_mount_refused/,
  );
  for (const overlay of [
    "53 52 8:5 /replacement /opt/oce-box/compiled-agent/box-agent.js ro - ext4 /dev/replacement ro",
    "54 37 8:3 /box /backing-box rw - ext4 /dev/tools rw",
  ]) {
    assert.throws(
      () => assertHarnessImageMounts(inventory(box, agent, overlay), "37", support, snapshot),
      /support_mount_refused/,
    );
  }
});

test("support file verification refuses changed bytes and a byte-identical replacement", (t) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "oce-harness-support-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const path = join(parent, "box-agent.js");
  const replacement = join(parent, "replacement.js");
  const bytes = "console.log('first');";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(path, bytes, { mode: 0o600 });
  const original = verifyHarnessImageFile(path, sha256, false);
  writeFileSync(path, "console.log('other');");
  assert.throws(
    () => verifyHarnessImageFile(path, sha256, false, false, original),
    /harness_image_file_changed/,
  );
  writeFileSync(replacement, bytes, { mode: 0o600 });
  renameSync(replacement, path);
  assert.throws(
    () => verifyHarnessImageFile(path, sha256, false, false, original),
    /harness_image_support_file_replaced/,
  );
});

test("image admission requires the executed standalone argv and unmodified stock PATH", () => {
  const combined = stockHarnessCommand([
    ...RUNTIME_WRAPPER_COMMAND,
    ...nodeProgramArguments(AGENT_WITH_NODE_ENTRYPOINT),
  ]);
  const program = Buffer.from(withoutLineComments(AGENT_WITH_NODE_ENTRYPOINT));
  const actual = splitStockCommand(program);
  const installation = {
    bootId: "00000000-0000-0000-0000-000000000000",
    mountId: "37",
    root: { dev: "8", ino: "1" },
    commandSha256: createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
  };
  assert.doesNotThrow(() => assertHarnessImageCommand(installation, actual, stockPath));
  assert.throws(
    () => assertHarnessImageCommand(installation, combined, stockPath),
    /command_changed/,
  );
  assert.throws(
    () => assertHarnessImageCommand(installation, actual, "/tmp/codex:" + stockPath),
    /requires_stock_path/,
  );
  assert.throws(() => splitSelectedHarnessImageCommand(program, actual), /split_argv_changed/);
  assert.throws(
    () => splitSelectedHarnessImageCommand(Buffer.concat([program, Buffer.from("\n")]), actual),
    /unrecognized_combined_workspace_node_command/,
  );
  assert.throws(() => readHarnessImageSplit("/absent", installation), /split_not_approved/);
});

test("the existing image PATH alias chooses the selected executable and refuses substitution", (t) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "oce-harness-path-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const exitCode of [21, 22]) {
    const root = join(parent, String(exitCode));
    const native = join(root, "opt/oce/runtime/codex/codex");
    const node = join(root, "usr/local/bin/node");
    const alias = join(root, "app/node_modules/.bin/codex");
    for (const path of [native, node, alias]) {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(native, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o700 });
    writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    symlinkSync("../../../opt/oce/runtime/codex/codex", alias);
    assert.doesNotThrow(() => assertHarnessImageExecutables(root));
    assert.equal(spawnSync(alias, { env: {} }).status, exitCode);
    writeFileSync(join(dirname(alias), "node"), "substitute", { mode: 0o700 });
    assert.throws(() => assertHarnessImageExecutables(root), /node_path_shadowed/);
    unlinkSync(alias);
    symlinkSync("node", alias);
    assert.throws(() => assertHarnessImageExecutables(root), /codex_alias_changed/);
  }
});
