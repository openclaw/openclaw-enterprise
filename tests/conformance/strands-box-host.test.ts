import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as httpServer, request } from "node:http";
import type { IncomingMessage } from "node:http";
import { createConnection, createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  AGENT_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { inflateRawSync } from "node:zlib";
import {
  assertPinnedDirectory,
  fileIdentity,
  splitStockCommand,
} from "../../deploy/examples/strands-box/host/installed-workspace-node.ts";
import {
  canonical,
  digest,
  profileDigest,
  parseOwner,
  reserveExecution,
  stockHarnessCommand,
  validateInstalledGrants,
} from "../../deploy/examples/strands-box/host/control.ts";
import type { serveInstalledControl } from "../../deploy/examples/strands-box/host/control.ts";
import {
  approve,
  currentController,
  durableRecord,
  isApproved,
} from "../../deploy/examples/strands-box/host/admission.ts";
import type { Pending } from "../../deploy/examples/strands-box/host/admission.ts";
import { parseRoute, policy } from "../../deploy/examples/strands-box/host/egress.ts";
import { verifyHarnessImageFile } from "../../deploy/examples/strands-box/host/installed-harness-image.ts";
import { hostConfig, smokeInput, start } from "../../deploy/examples/strands-box/host/launch.ts";
import {
  WORKSPACE_MARKER,
  WORKSPACE_VERIFIER,
  verifyWorkspaceVerifier,
  workspaceVerifierPolicy,
  workspaceVerifierTool,
} from "../../deploy/examples/strands-box/host/workspace-verifier.ts";
import {
  bridge,
  listen,
  processIdentity,
  sameSocket,
  tcpOwnership,
  upgradeStatus,
} from "../../deploy/examples/strands-box/host/transport.ts";

const unsupported = process.platform !== "linux" || process.getuid?.() === 0;

function temporary(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "oce-box-test-"));
}

type InstalledControlFixture = Omit<
  Parameters<typeof serveInstalledControl>[0],
  "mountIdentities" | "approvalDir"
> & { approvalDir: string };

function installedControlFixture(root: string): InstalledControlFixture {
  const runtimeDir = join(root, "run");
  const approvalDir = join(root, "approval");
  const workspace = join(root, "workspace");
  for (const directory of [runtimeDir, approvalDir, workspace]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const binary = realpathSync(process.execPath);
  return {
    agentBuildDir: join(root, "compiled"),
    approvalDir,
    boxBin: binary,
    codexBin: binary,
    endpoint: { url: "wss://box.example.invalid/", workspaceRoot: workspace },
    exec: [],
    image: `fixture.example/agent@sha256:${"0".repeat(64)}`,
    linuxPreview: true,
    nodeBin: binary,
    owner: parseOwner({
      driverId: "box-pilot",
      implementation: "@openclaw-enterprise/example-strands-box-driver@0.1.0",
      namespaceId: "ns_one",
      namespaceName: "agent-one",
      agentId: "agt_one",
      revisionId: "rev_one",
    }),
    read: [],
    runtimeDir,
    workspace,
    workspaceClaim: "fixture-claim",
    writableState: [],
  };
}

function installedControlCommand(config: InstalledControlFixture) {
  const module = new URL("../../deploy/examples/strands-box/host/control.ts", import.meta.url);
  return [
    "--input-type=module",
    "--eval",
    `
    import { serveInstalledControl } from ${JSON.stringify(module.href)};
    await serveInstalledControl({ ...${JSON.stringify(config)}, mountIdentities: new Map() });
  `,
  ];
}

async function controlRequest(socketPath: string, path: string, body?: unknown) {
  const outgoing = request({
    socketPath,
    path,
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" } }),
    signal: AbortSignal.timeout(2_000),
  });
  const incoming = once(outgoing, "response") as Promise<[IncomingMessage]>;
  outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  const [response] = await incoming;
  return { status: response.statusCode, body: JSON.parse(await text(response)) as unknown };
}

test(
  "installed control serves only the chosen socket and keeps its records on the host",
  { skip: unsupported },
  async () => {
    for (const controlSocketMode of [undefined, "worker-directory"] as const) {
      const root = temporary();
      const config = {
        ...installedControlFixture(root),
        ...(controlSocketMode === undefined ? {} : { controlSocketMode }),
      };
      const exported = join(config.runtimeDir, "worker-control");
      if (controlSocketMode !== undefined) {
        mkdirSync(exported, { mode: 0o700 });
      }
      const socket = join(
        controlSocketMode === undefined ? config.runtimeDir : exported,
        "control.sock",
      );
      const child = spawn(process.execPath, installedControlCommand(config), {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = once(child, "exit");
      try {
        const output = createInterface({ input: child.stdout });
        assert.deepEqual(await once(output, "line", { signal: AbortSignal.timeout(5_000) }), [
          "strands-box-control: ready",
        ]);
        assert.equal(lstatSync(socket).isSocket(), true);
        assert.equal(lstatSync(socket).mode & 0o777, 0o600);
        assert.deepEqual(await controlRequest(socket, "/v1/execution"), {
          status: 404,
          body: { error: "execution_absent" },
        });
        const requirements = {
          image: config.image,
          labels: {
            "openclaw.dev/workload-role": "agent",
            "openclaw.dev/namespace": config.owner.namespaceId,
            "openclaw.dev/agent": config.owner.agentId,
            "openclaw.dev/revision": config.owner.revisionId,
          },
          command: [...RUNTIME_WRAPPER_COMMAND, ...nodeProgramArguments(AGENT_RUNTIME_ENTRYPOINT)],
          credentialAttachments: [],
          // No fixed host workspace mounts are available in this isolated wire test.
          workspaceMounts: [],
        };
        assert.deepEqual(stockHarnessCommand(requirements.command), requirements.command);
        assert.deepEqual(
          await controlRequest(socket, "/v1/admission", {
            owner: { ...config.owner, agentId: "agt_other" },
            requirements,
            requirementsDigest: digest(requirements),
          }),
          { status: 409, body: { error: "owner_mismatch" } },
        );
        assert.deepEqual(
          await controlRequest(socket, "/v1/admission", {
            owner: config.owner,
            requirements,
            requirementsDigest: digest(requirements),
          }),
          { status: 422, body: { error: "host_request_refused" } },
        );
        assert.deepEqual(readdirSync(config.approvalDir), []);
        if (controlSocketMode === undefined) {
          assert.deepEqual(readdirSync(config.runtimeDir), ["control.sock"]);
        } else {
          assert.deepEqual(readdirSync(config.runtimeDir), ["worker-control"]);
          writeFileSync(join(config.runtimeDir, "intent.json"), "fixture private record", {
            mode: 0o600,
          });
          assert.deepEqual(readdirSync(exported), ["control.sock"]);
          unlinkSync(join(config.runtimeDir, "intent.json"));
          child.kill("SIGKILL");
          assert.deepEqual(await exited, [null, "SIGKILL"]);
          const prior = lstatSync(socket);
          const refused = spawnSync(process.execPath, installedControlCommand(config), {
            encoding: "utf8",
            timeout: 2_000,
          });
          assert.equal(refused.status, 1, refused.stderr);
          assert.match(refused.stderr, /runtime_already_used/);
          assert.equal(lstatSync(socket).ino, prior.ino);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
        await exited;
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "worker socket export refuses a hostile directory, dirty runtime, or overlapping authority",
  { skip: unsupported },
  () => {
    const root = temporary();
    const config = {
      ...installedControlFixture(root),
      controlSocketMode: "worker-directory" as const,
    };
    const exported = join(config.runtimeDir, "worker-control");
    function refused(message: RegExp, overrides: Partial<typeof config> = {}) {
      const result = spawnSync(
        process.execPath,
        installedControlCommand({ ...config, ...overrides }),
        { encoding: "utf8", timeout: 2_000 },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, message);
      assert.throws(() => lstatSync(join(exported, "control.sock")), { code: "ENOENT" });
      assert.throws(() => lstatSync(join(config.runtimeDir, "control.sock")), { code: "ENOENT" });
    }
    try {
      symlinkSync(config.workspace, exported);
      refused(/noncanonical_path/);
      unlinkSync(exported);
      mkdirSync(exported, { mode: 0o755 });
      chmodSync(exported, 0o755);
      refused(/private_directory/);
      chmodSync(exported, 0o700);
      refused(/worker_control_directory_overlap/, { approvalDir: exported });
      refused(/worker_control_directory_overlap/, { read: [exported] });
      refused(/worker_control_directory_overlap/, { writableState: [exported] });
      writeFileSync(join(config.runtimeDir, "pending.json"), "existing host state");
      refused(/runtime_already_used/);
      assert.equal(
        readFileSync(join(config.runtimeDir, "pending.json"), "utf8"),
        "existing host state",
      );
      unlinkSync(join(config.runtimeDir, "pending.json"));
      writeFileSync(join(exported, "unexpected"), "existing export file");
      refused(/runtime_already_used/);
      assert.deepEqual(readdirSync(exported), ["unexpected"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the file-only mode refuses modified stock commands and replacement mounts", () => {
  const stockArgs = nodeProgramArguments(AGENT_WITH_NODE_ENTRYPOINT);
  const stock = inflateRawSync(Buffer.from(stockArgs.slice(1).join(""), "base64"));
  assert.throws(
    () => splitStockCommand(Buffer.concat([stock, Buffer.from("\nvoid 0;")])),
    /unrecognized_combined_workspace_node_command/,
  );
  const launcher = splitStockCommand(stock);
  const harness = inflateRawSync(
    Buffer.from(launcher.slice(RUNTIME_WRAPPER_COMMAND.length + 1).join(""), "base64"),
  ).toString();
  assert.doesNotMatch(harness, /pair-or-reconnect|OPENCLAW_NODE_SETUP_CODE/);
  assert.match(harness, /ws-token-sha256/);
  const directory = temporary();
  const original = join(directory, "workspace");
  const moved = join(directory, "moved");
  try {
    mkdirSync(original, { mode: 0o700 });
    const pin = fileIdentity(original);
    assertPinnedDirectory(original, pin);
    renameSync(original, moved);
    mkdirSync(original, { mode: 0o700 });
    assert.throws(() => assertPinnedDirectory(original, pin), /workspace_mount_replaced/);
    rmSync(original, { recursive: true });
    symlinkSync(moved, original, "dir");
    assert.throws(() => assertPinnedDirectory(original, pin), /noncanonical_path/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function statusFixture(marker: string) {
  const server = httpServer();
  server.on("upgrade", (request, socket) => {
    socket.on("end", () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.resume();
    if (request.headers.authorization !== `Bearer ${marker}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
  });
  return server;
}

test("host accepts genuine Compute packed command without replacing or truncating argv", () => {
  for (const original of [AGENT_RUNTIME_ENTRYPOINT, AGENT_WITH_NODE_ENTRYPOINT]) {
    const command = [...RUNTIME_WRAPPER_COMMAND, ...nodeProgramArguments(original)];
    assert.equal(command.length, 10, "the old eight-item host check rejected the actual command");
    assert.deepEqual(stockHarnessCommand(command), command);
    assert.equal(digest(stockHarnessCommand(command)), digest(command));
    const [last] = command.slice(-1);
    assert(last);
    for (const wrong of [
      command.slice(0, -1),
      [...command, "AAAA"],
      [...RUNTIME_WRAPPER_COMMAND, original],
      [...command.slice(0, -1), last + "AAAA"],
    ]) {
      assert.throws(() => stockHarnessCommand(wrong), { message: "unsupported_command" });
    }
    const other = [...RUNTIME_WRAPPER_COMMAND, ...nodeProgramArguments(original + "\nvoid 0;\n")];
    assert.notEqual(
      digest(stockHarnessCommand(other)),
      digest(command),
      "valid packing cannot substitute an approved command",
    );
  }
});

test(
  "owner home creation refuses a nonwritable parent with bounded diagnostics",
  { skip: unsupported },
  () => {
    const root = temporary();
    const protectedParent = join(root, "fixture-sensitive-owner-parent");
    const runtimeDir = join(protectedParent, "run");
    const workspace = join(root, "work");
    const agentBuildDir = join(root, "compiled");
    for (const directory of [protectedParent, runtimeDir, workspace, agentBuildDir]) {
      mkdirSync(directory, { mode: 0o700 });
    }
    for (const file of ["box-agent.js", "transport.js", "diagnostics.js"]) {
      writeFileSync(join(agentBuildDir, file), "", { mode: 0o600 });
    }
    const node = realpathSync(process.execPath);
    const config = hostConfig({
      boxBin: node,
      nodeBin: node,
      codexBin: node,
      agentBuildDir,
      runtimeDir,
      workspace,
      read: [],
      exec: [],
      linuxPreview: true,
    });
    try {
      chmodSync(protectedParent, 0o500);
      assert.throws(() => smokeInput(config), { message: "phase=owner-home-create reason=EACCES" });
      assert.throws(() => lstatSync(join(protectedParent, "run-home")), { code: "ENOENT" });
      const cli = fileURLToPath(
        new URL("../../deploy/examples/strands-box/host/launch.ts", import.meta.url),
      );
      const missing = join(root, "fixture-sensitive-config.json");
      const refused = spawnSync(node, [cli, "--preflight", missing], { encoding: "utf8" });
      assert.equal(refused.status, 1);
      assert.equal(
        refused.stderr,
        "strands-box-host: startup refused phase=config-file reason=ENOENT\n",
      );
      assert(!refused.stderr.includes("fixture-sensitive"));
    } finally {
      chmodSync(protectedParent, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("selected package implementation is canonical and bound separately from resource identifiers", () => {
  const owner = {
    driverId: "box-pilot",
    implementation: "@openclaw-enterprise/example-strands-box-driver@0.1.0",
    namespaceId: "ns_one",
    namespaceName: "agent-one",
    agentId: "agt_one",
    revisionId: "rev_one",
  };
  assert.deepEqual(parseOwner(owner), owner);
  assert.throws(() => parseOwner({ ...owner, agentId: owner.implementation }), {
    message: "invalid_owner",
  });
  for (const implementation of [
    "@openclaw-enterprise/../example@0.1.0",
    "@openclaw-enterprise/example@01.1.0",
    "@openclaw-enterprise/example@latest",
    "@openclaw-enterprise/example@0.1.0/child",
  ]) {
    assert.throws(() => parseOwner({ ...owner, implementation }), { message: "invalid_owner" });
  }
});

test("installed grants cannot read or write sibling state through the Harness HOME", () => {
  const state = [
    "/home/node/.codex",
    "/home/node/.openclaw",
    "/home/node/.local",
    "/home/node/openclaw-runtime-assets",
  ];
  assert.deepEqual(
    validateInstalledGrants(state, ["/app", "/opt/oce/runtime"], ["/usr/bin/tini"]),
    state,
  );
  for (const path of [
    "/home",
    "/home/node",
    "/home/node/workspace",
    "/home/node/sibling",
    "/home/node/.ssh",
  ]) {
    assert.throws(() => validateInstalledGrants([path], [], []), {
      message: "unsupported_writable_state",
    });
    assert.throws(() => validateInstalledGrants([], [path], []), {
      message: "protected_host_grant",
    });
  }
  for (const path of ["/etc", "/root", "/var/lib", "/run/secrets", "/proc"]) {
    assert.throws(() => validateInstalledGrants([], [], [path]), {
      message: "protected_host_grant",
    });
  }
});

test(
  "actual host spawn classifies bounded Box stderr without forwarding child bytes",
  { skip: unsupported },
  async (t) => {
    const directory = temporary();
    const runtimeDir = join(directory, "run");
    const workerExport = join(runtimeDir, "worker-control");
    const workspace = join(directory, "workspace");
    const agentBuildDir = join(directory, "build");
    for (const path of [runtimeDir, workerExport, workspace, agentBuildDir]) {
      mkdirSync(path, { mode: 0o700 });
    }
    for (const file of ["box-agent.js", "transport.js", "diagnostics.js"]) {
      writeFileSync(join(agentBuildDir, file), "", { mode: 0o600 });
    }
    const boxBin = join(directory, "fixture-box");
    writeFileSync(
      boxBin,
      '#!/bin/sh\ncp -- "$3" ../generated-box.toml || exit 3\n' +
        "printf '%s' 'strands-box: error: policy load failed: ' >&2\n" +
        "printf '%s\\n' 'fixture-private-diagnostic-credential' >&2\n" +
        "printf '%s\\n' \"strands-box: error: trusted Box executable /private/fixture-private-box cannot inventory mounted executable aliases: invalid mount table for trusted executable aliases\" >&2\n" +
        "printf '%s\\n' \"strands-box: error: containment setup failed during target exec: fixture-private-exec (os error 13)\" >&2\n" +
        "printf '%s\\n' \"strands-box-contain-trampoline: containment apply failed: backend linux-namespace failed to apply: making the mount tree private: Operation not permitted (os error 1)\" >&2\n" +
        "printf '%s\\n' \"strands-box: namespace reaper could not build the view: creating the staging root '/tmp/.strands-box-view.0123456789abcdef': fixture-private-tmp\" >&2\n" +
        "printf '%s\\n' \"Error [ERR_MODULE_NOT_FOUND]: Cannot find module /private/fixture-private-module\" >&2\n" +
        "printf '%s\\n' 'strands-box: error: unknown fixture-private-diagnostic-reason' >&2\n" +
        "printf '%s\\n' 'fixture-private-stdout'\nsleep 0.1\nexit 2\n",
      { mode: 0o700 },
    );
    const node = realpathSync(process.execPath);
    const config = hostConfig({
      boxBin,
      nodeBin: node,
      codexBin: node,
      agentBuildDir,
      runtimeDir,
      workspace,
      read: [],
      exec: [],
      linuxPreview: true,
    });
    const { input } = smokeInput(config);
    const observed: string[] = [];
    const writes = t.mock.method(process.stderr, "write", (value: unknown) => {
      if (typeof value === "string") {
        observed.push(value);
      }
      return true;
    });
    const execution = start(config, input);
    try {
      await assert.rejects(execution.ready, { message: "startup_refused:wait-original-native" });
      assert.equal(await execution.done, 2);
      const generated = readFileSync(join(directory, "generated-box.toml"), "utf8");
      const rows = generated.split("\n").filter((line) => /^(read|write|exec) = \[/.test(line));
      assert.equal(rows.length, 3);
      const grants = rows.flatMap((row) => JSON.parse(row.slice(row.indexOf("["))) as string[]);
      assert(grants.includes(join(runtimeDir, "bridge")));
      for (const path of grants) {
        assert(!path.startsWith(workerExport + sep));
        assert(
          ![runtimeDir, workerExport].some(
            (privatePath) => privatePath === path || privatePath.startsWith(path + sep),
          ),
        );
      }
    } finally {
      await execution.done;
      writes.mock.restore();
      rmSync(directory, { recursive: true, force: true });
    }
    const output = observed.join("");
    assert.match(output, /strands-box-diagnostic source=box stage=policy reason=refused/);
    assert.match(
      output,
      /strands-box-diagnostic source=box stage=filesystem reason=executable-mount-table/,
    );
    assert.match(output, /strands-box-diagnostic source=box stage=exec reason=setup-exec/);
    assert.match(output, /strands-box-diagnostic source=box stage=namespace reason=mount-private/);
    assert.match(output, /strands-box-diagnostic source=box stage=namespace reason=staging-root/);
    assert.match(output, /strands-box-diagnostic source=box stage=exec reason=node-module/);
    assert.match(output, /strands-box-diagnostic source=box stage=stderr reason=unrecognized/);
    assert.match(output, /strands-box-diagnostic source=box stage=exit reason=nonzero/);
    assert(!output.includes("fixture-private"));
  },
);

test(
  "a pre-exec refusal stops the launcher before the Box child is spawned",
  { skip: unsupported },
  async (t) => {
    const directory = temporary();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const runtimeDir = join(directory, "run");
    const workspace = join(directory, "workspace");
    const agentBuildDir = join(directory, "build");
    for (const path of [runtimeDir, workspace, agentBuildDir]) {
      mkdirSync(path, { mode: 0o700 });
    }
    for (const file of ["box-agent.js", "transport.js", "diagnostics.js"]) {
      writeFileSync(join(agentBuildDir, file), "", { mode: 0o600 });
    }
    const boxBin = join(directory, "fixture-box");
    writeFileSync(boxBin, "#!/bin/sh\ntouch ../spawned\nsleep 1\n", { mode: 0o700 });
    const node = realpathSync(process.execPath);
    const config = hostConfig({
      boxBin,
      nodeBin: node,
      codexBin: node,
      agentBuildDir,
      runtimeDir,
      workspace,
      read: [],
      exec: [],
      linuxPreview: true,
    });
    const { input } = smokeInput(config);
    const entry = join(agentBuildDir, "box-agent.js");
    const bytes = "console.log('agent');";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(entry, bytes);
    const original = verifyHarnessImageFile(entry, sha256, false);
    const replacement = join(agentBuildDir, "replacement.js");
    writeFileSync(replacement, bytes, { mode: 0o600 });
    renameSync(replacement, entry);
    let checked = false;
    const execution = start(config, input, undefined, () => {
      checked = true;
      verifyHarnessImageFile(entry, sha256, false, false, original);
    });
    await assert.rejects(execution.spawned, /startup_refused:start-box/);
    await assert.rejects(execution.ready, /startup_refused:start-box/);
    assert.equal(await execution.done, 1);
    assert.equal(checked, true);
    assert.throws(() => lstatSync(join(directory, "spawned")), { code: "ENOENT" });
  },
);

test("operator profile excludes only the revision's native verifier value", () => {
  const first = {
    command: ["node", "-e", "exact program"],
    environment: [
      { name: "APP_TOKEN_SHA", value: "a".repeat(64) },
      { name: "HOME", value: "/home/node" },
    ],
  };
  const rotated = {
    ...first,
    environment: first.environment.map((entry) =>
      entry.name === "APP_TOKEN_SHA" ? { ...entry, value: "b".repeat(64) } : entry,
    ),
  };
  assert.equal(profileDigest(first), profileDigest(rotated));
  assert.notEqual(digest(first), digest(rotated));
  assert.notEqual(
    profileDigest(first),
    profileDigest({ ...first, command: [...first.command, "injected"] }),
  );
  assert.notEqual(
    profileDigest(first),
    profileDigest({
      ...first,
      environment: [...first.environment, { name: "APP_SERVER_TOKEN", value: "invented" }],
    }),
  );
  assert.equal(
    canonical({ z: [true, "x"], a: { y: false, x: null } }),
    '{"a":{"x":null,"y":false},"z":[true,"x"]}',
  );
});

test("operator intent is exclusive before Box and contains only custody data", () => {
  const path = temporary();
  const tuple = {
    driverId: "box-example",
    implementation: "strands-box-pilot",
    namespaceId: "ns_example",
    namespaceName: "agent-example",
    agentId: "agt_example",
    revisionId: "rev_example",
  };
  const intent = {
    owner: tuple,
    requirementsDigest: "c".repeat(64),
    executionId: "first",
    workspaceNodeSetupCode: "fixture-must-not-be-written",
  };
  try {
    reserveExecution(path, intent);
    assert.throws(() => reserveExecution(path, { ...intent, executionId: "replacement" }), {
      code: "EEXIST",
    });
    const file = join(path, "intent.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      version: 1,
      owner: tuple,
      requirementsDigest: "c".repeat(64),
      executionId: "first",
    });
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("held approval binds the exact original request and controller", { skip: unsupported }, () => {
  const directory = temporary();
  const control = join(directory, "control");
  const approvals = join(directory, "approvals");
  mkdirSync(control, { mode: 0o700 });
  mkdirSync(approvals, { mode: 0o700 });
  const tuple = {
    driverId: "box-example",
    implementation: "strands-box-pilot",
    namespaceId: "ns_example",
    namespaceName: "agent-example",
    agentId: "agt_example",
  };
  const pending: Pending = {
    version: 1,
    owner: { ...tuple, revisionId: "rev_one" },
    requirementsDigest: "a".repeat(64),
    profileSha256: "b".repeat(64),
    image: "example.invalid/agent@sha256:" + "c".repeat(64),
    commandSha256: "d".repeat(64),
    counts: { environment: 7, files: 2, mounts: 4 },
    controller: currentController(),
  };
  try {
    durableRecord(control, "pending.json", pending);
    assert.equal(isApproved(approvals, pending), false);
    assert.throws(
      () => approve(control, approvals, tuple, "rev_other", pending.requirementsDigest),
      { message: "approval_custody_mismatch" },
    );
    assert.throws(
      () => approve(control, approvals, tuple, pending.owner.revisionId, "0".repeat(64)),
      { message: "approval_custody_mismatch" },
    );
    assert.throws(
      () =>
        approve(
          control,
          approvals,
          { ...tuple, agentId: "agt_other" },
          pending.owner.revisionId,
          pending.requirementsDigest,
        ),
      { message: "approval_custody_mismatch" },
    );
    assert.equal(isApproved(approvals, pending), false);
    approve(control, approvals, tuple, pending.owner.revisionId, pending.requirementsDigest);
    assert.equal(isApproved(approvals, pending), true);
    assert.equal(isApproved(approvals, { ...pending, requirementsDigest: "f".repeat(64) }), false);
    assert.equal(
      isApproved(approvals, { ...pending, controller: { ...pending.controller, startTicks: "0" } }),
      false,
    );
    assert.throws(
      () =>
        approve(control, approvals, tuple, pending.owner.revisionId, pending.requirementsDigest),
      { code: "EEXIST" },
    );
    assert.equal(lstatSync(join(approvals, "approval.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the operator route pins a private address and exact method and path", () => {
  const model = parseRoute(
    { url: "https://fixture.invalid:8444/v1", address: "10.2.3.4" },
    "controlled-inference",
  );
  const node = parseRoute(
    { url: "wss://gateway.invalid:8443/pair", address: "192.168.8.12" },
    "workspace-node",
  );
  const rules = policy([model, node]);
  assert.match(rules, /context.input has ip4 && context.input.ip4 == "10.2.3.4"/);
  assert.match(rules, /!\(context.input has ip6\)/);
  assert.match(
    rules,
    /context.input.method == "POST" && context.input.path == "\/v1\/responses" && context.input.intercepted == true/,
  );
  assert.match(
    rules,
    /context.input.method == "GET" && context.input.path == "\/pair" && context.input.intercepted == true/,
  );
  assert.throws(
    () =>
      parseRoute(
        { url: "wss://gateway.invalid/pair", address: "169.254.169.254" },
        "workspace-node",
      ),
    { message: "invalid_fixed_egress" },
  );
  assert.throws(
    () =>
      parseRoute(
        { url: "wss://gateway.invalid/pair?unbounded=true", address: "10.2.3.4" },
        "workspace-node",
      ),
    { message: "invalid_fixed_egress" },
  );
  assert.throws(
    () => parseRoute({ url: "ws://gateway.invalid/pair", address: "10.2.3.4" }, "workspace-node"),
    { message: "invalid_fixed_egress" },
  );
});

test(
  "Linux verifies the actual accepted TCP tuple, not just the listener",
  { skip: unsupported },
  async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    const owner = processIdentity(process.pid);
    const listener = tcpOwnership(owner, address.port);
    assert(listener);
    const pending = once(server, "connection");
    const outbound = createConnection({ host: "127.0.0.1", port: address.port });
    const [accepted] = (await pending) as [ReturnType<typeof createConnection>];
    try {
      assert(outbound.localPort);
      const connection = tcpOwnership(owner, address.port, outbound.localPort);
      assert(connection);
      assert.notEqual(connection, listener);
      assert.equal(
        tcpOwnership({ ...owner, startTicks: "0" }, address.port, outbound.localPort),
        undefined,
      );
      assert.equal(
        tcpOwnership(owner, address.port, outbound.localPort === 65535 ? 1 : 65535),
        undefined,
      );
    } finally {
      accepted.destroy();
      outbound.destroy();
      await close(server);
    }
  },
);

test(
  "a pinned Unix inode forwards native auth and refuses an input path replacement",
  { skip: unsupported },
  async () => {
    const directory = temporary();
    const input = join(directory, "inside.sock");
    const pinned = join(directory, "pinned.sock");
    const front = join(directory, "app-server.sock");
    const first = statusFixture("fixture-only");
    const alternate = statusFixture("foreign-only");
    const original = await listen(first, input);
    linkSync(input, pinned);
    const relay = bridge(
      { path: pinned },
      () => sameSocket(input, original) && sameSocket(pinned, original),
    );
    try {
      await listen(relay.server, front);
      assert.equal(await upgradeStatus({ path: front }), 401);
      assert.equal(await upgradeStatus({ path: front }, "foreign-only"), 401);
      assert.equal(await upgradeStatus({ path: front }, "fixture-only"), 101);
      unlinkSync(input);
      await listen(alternate, input);
      assert.equal(await upgradeStatus({ path: pinned }, "fixture-only"), 101);
      assert.equal(await upgradeStatus({ path: input }, "foreign-only"), 101);
      assert.equal(await upgradeStatus({ path: front }, "foreign-only"), undefined);
    } finally {
      relay.close();
      await Promise.all([close(first), close(alternate)]);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function initialize(socketPath: string, bearer: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath,
      path: "/",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.once("error", reject);
    req.once("response", (response) => {
      response.resume();
      reject(new Error(`native_upgrade_status:${response.statusCode}`));
    });
    req.once("upgrade", (_response, socket) => {
      const id = 5;
      const payload = Buffer.from(
        JSON.stringify({
          id,
          method: "initialize",
          params: { clientInfo: { name: "owner-conformance", version: "1" } },
        }),
      );
      assert(payload.length < 126);
      const key = Buffer.from([21, 43, 65, 87]);
      const masked = Buffer.from(payload.map((byte, index) => byte ^ key[index % 4]!));
      let data = Buffer.alloc(0);
      socket.setTimeout(2_500, () => socket.destroy(new Error("native_initialize_timeout")));
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("native_closed_before_initialize")));
      socket.on("data", (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        const size = data[1];
        if (data.length < 2 || size === undefined) {
          return;
        }
        if (size > 126 || data[0] !== 0x81) {
          socket.destroy(new Error("unsupported_native_reply_frame"));
          return;
        }
        const offset = size === 126 ? 4 : 2;
        if (data.length < offset) {
          return;
        }
        const end = offset + (size === 126 ? data.readUInt16BE(2) : size);
        if (data.length < end) {
          return;
        }
        try {
          const parsed: unknown = JSON.parse(data.subarray(offset, end).toString("utf8"));
          resolve(parsed);
          socket.destroy();
        } catch {
          socket.destroy(new Error("invalid_native_reply_json"));
        }
      });
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), key, masked]));
    });
    req.end();
  });
}

// Optional same-host wire check with actual Codex. The CLI stand-in only calls
// the emitted agent and deliberately establishes no Box or namespace evidence.
const codexFixture = process.env.STRANDS_HOST_TEST_CODEX;
const compiledFixture = process.env.STRANDS_HOST_TEST_AGENT_BUILD;
test(
  "owned launcher reaches actual native Codex and retires it without carrying auth material",
  {
    skip: unsupported || codexFixture === undefined || compiledFixture === undefined,
    timeout: 30_000,
  },
  async () => {
    assert(codexFixture && compiledFixture);
    const directory = temporary();
    const runtimeDir = join(directory, "run");
    const workspace = join(directory, "work");
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    const nodeBin = realpathSync(process.execPath);
    const boxBin = join(directory, "box-command-fixture");
    const boxPidPath = join(directory, "fixture-box.pid");
    writeFileSync(boxBin, "", { mode: 0o700 });
    const config = hostConfig({
      agentBuildDir: realpathSync(compiledFixture),
      boxBin,
      nodeBin,
      codexBin: realpathSync(codexFixture),
      runtimeDir,
      workspace,
      read: [],
      exec: [],
      linuxPreview: true,
    });
    const { input, capability } = smokeInput(config);
    const environment = Object.entries(input.environment)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const expected = join(runtimeDir, "authority", "box.toml");
    const args = [
      nodeBin,
      "--jitless",
      join(config.agentBuildDir, "box-agent.js"),
      join(runtimeDir, "input", "agent.json"),
    ].map(shellQuote);
    writeFileSync(
      boxBin,
      `#!/bin/sh\n[ "$1" = run ] && [ "$2" = --config ] && [ "$3" = ${shellQuote(expected)} ] || exit 2\n` +
        `[ -z "\${APP_SERVER_TOKEN+x}\${OPENAI_API_KEY+x}\${AWS_SECRET_ACCESS_KEY+x}" ] || exit 3\n` +
        `printf '%s\\n' "$$" > ${shellQuote(boxPidPath)}\n` +
        `exec env -i ${environment} ${args.join(" ")}\n`,
      { mode: 0o700 },
    );
    const execution = start(config, input, capability);
    try {
      const ready = await execution.ready;
      const front = join(runtimeDir, "app-server.sock");
      assert(sameSocket(front, { dev: ready.socketDev, ino: ready.socketIno }));
      assert.equal(await upgradeStatus({ path: front }), 401);
      assert.equal(await upgradeStatus({ path: front }, "wrong"), 401);
      assert.equal(await upgradeStatus({ path: front }, capability), 101);
      const result = await initialize(front, capability);
      assert(result && typeof result === "object" && "id" in result && result.id === 5);
      assert(
        "result" in result &&
          result.result &&
          typeof result.result === "object" &&
          "userAgent" in result.result,
      );
      const agentInput = readFileSync(join(runtimeDir, "input", "agent.json"), "utf8");
      assert(agentInput.includes(createHash("sha256").update(capability).digest("hex")));
      assert(!agentInput.includes(capability));
      assert(!readFileSync(expected, "utf8").includes(capability));
      assert.equal(lstatSync(join(runtimeDir, "capability")).mode & 0o777, 0o600);
      const originalBoxPid = Number(readFileSync(boxPidPath, "utf8").trim());
      assert.equal(processIdentity(originalBoxPid).ppid, process.pid);
      process.kill(originalBoxPid, "SIGTERM");
      assert.equal(await execution.done, 1);
      assert.equal(await upgradeStatus({ path: front }, capability), undefined);
      assert.throws(() => lstatSync(join(runtimeDir, "ready.json")), { code: "ENOENT" });
      assert.throws(() => lstatSync(join(runtimeDir, "capability")), { code: "ENOENT" });
    } finally {
      await execution.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

const stockShellBox = process.env.OCC_TEST_STRANDS_BOX_SHELL_BOX;
const stockShellVerifierSha = process.env.OCC_TEST_STRANDS_BOX_SHELL_VERIFIER_SHA256;

test(
  "stock Box Shell Calls admit only the fixed read-only workspace verifier",
  {
    skip:
      unsupported || process.arch !== "arm64" || !stockShellBox || !stockShellVerifierSha
        ? "Set the stock ARM64 Box path and reviewed verifier SHA on the dedicated Linux host."
        : false,
    timeout: 55_000,
  },
  async () => {
    assert.ok(stockShellBox && stockShellVerifierSha);
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
