import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
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
import { connect as tlsConnect, createServer as tlsServer } from "node:tls";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  AGENT_WITH_NODE_ENTRYPOINT,
  EXPLICIT_PROXY_AGENT_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { signComputeExecutionRelease } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { inflateRawSync } from "node:zlib";
import {
  assertNodeInputs,
  assertPinnedDirectory,
  fileIdentity,
  splitStockCommand,
} from "../../deploy/examples/strands-box/host/installed-workspace-node.ts";
import {
  boxDialedRoutes,
  canonical,
  confirmControlledInference,
  digest,
  observedView,
  profileDigest,
  protectedWiring,
  verifyRelease,
  wiringConfiguration,
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
import {
  assertPinnedResolution,
  assertUpstreamCaScope,
  BOX_UPSTREAM_CA_KEY,
  loadUpstreamCa,
  nativeHookRoute,
  parseRoute,
  githubCredentials,
  githubPolicy,
  policy,
  routeView,
  sameRouteView,
  upstreamCaPem,
} from "../../deploy/examples/strands-box/host/egress.ts";
import { verifyHarnessImageFile } from "../../deploy/examples/strands-box/host/installed-harness-image.ts";
import { hostConfig, smokeInput, start } from "../../deploy/examples/strands-box/host/launch.ts";
import { collectDiagnostics } from "../../deploy/examples/strands-box/host/diagnostics.ts";
import { PassThrough } from "node:stream";
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
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      let log = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (log += chunk));
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
        // The host names each reply and refusal on stderr: route, status, code, never a body.
        const deadline = Date.now() + 2_000;
        while (!log.includes("POST admission 422") && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.deepEqual(
          log
            .trim()
            .split("\n")
            .map((line) => line.replace(/reason=\S+$/, "reason=<code>")),
          [
            "strands-box-control: GET execution 404 execution_absent",
            "strands-box-control: POST admission 409 owner_mismatch",
            "strands-box-control: refused reason=<code>",
            "strands-box-control: POST admission 422 host_request_refused",
          ],
        );
        assert(!log.includes(config.owner.agentId) && !log.includes("agt_other"));
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
  // Compute renders the explicit-proxy program for a provider-owned Sandbox other than OpenShell.
  const stockArgs = nodeProgramArguments(EXPLICIT_PROXY_AGENT_WITH_NODE_ENTRYPOINT);
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
  // Box names its egress proxy in the Harness environment; the probe keeps it.
  assert.match(harness, /"HTTPS_PROXY", "https_proxy"/);
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

test("Harness startup lines reach the host log as fixed-shape fields only", async (t) => {
  const observed: string[] = [];
  const writes = t.mock.method(process.stderr, "write", (value: unknown) => {
    if (typeof value === "string") {
      observed.push(value);
    }
    return true;
  });
  try {
    // Inside Box: the command's stderr, as the runtime Harness prints it.
    const command = new PassThrough();
    const inner = collectDiagnostics(command, "command");
    command.end(
      [
        JSON.stringify({
          event: "runtime.startup_phase",
          container: "agent",
          phase: "codex-login",
          outcome: "ok",
          ms: 4,
        }),
        JSON.stringify({
          event: "codex.model_probe",
          attempt: 1,
          elapsedMs: 30001,
          exitCode: null,
          signal: "SIGKILL",
          code: "MODEL_PROBE_TIMEOUT",
          cause: { kind: "PROCESS_EXIT", detail: "signal-SIGKILL" },
          failureClass: "network",
        }),
        JSON.stringify({
          event: "codex.model_probe",
          attempt: 2,
          code: "fixture-private-code",
          cause: { kind: "x" },
        }),
        JSON.stringify({
          event: "runtime.startup_phase",
          phase: "model-probe",
          outcome: "failed",
          code: "fixture private",
        }),
        JSON.stringify({ event: "codex.model_probe", attempt: 1, code: "READY" }),
        '{"event":"runtime.startup_phase","phase":"fixture-private-' +
          "x".repeat(40) +
          '","outcome":"ok"}',
        "Harness model authentication probe failed. fixture-private-text",
        "",
      ].join("\n"),
    );
    await inner;
    const forwarded = observed.join("");
    assert.match(forwarded, /^strands-box-harness phase=codex-login outcome=ok$/m);
    assert.match(
      forwarded,
      /^strands-box-harness phase=model-probe-attempt outcome=failed attempt=1 code=MODEL_PROBE_TIMEOUT cause=PROCESS_EXIT\/signal-SIGKILL class=network$/m,
    );
    assert.match(forwarded, /^strands-box-harness phase=model-probe outcome=failed$/m);
    assert.match(
      forwarded,
      /^strands-box-harness phase=model-probe-attempt outcome=ok attempt=1$/m,
    );
    assert(!forwarded.includes("fixture-private"));
    // On the host: Box's stderr carries the in-Box agent's lines; each one is re-checked.
    observed.length = 0;
    const box = new PassThrough();
    const host = collectDiagnostics(box, "box");
    box.end(
      forwarded +
        "strands-box-harness phase=model-probe outcome=failed code=fixture-private\n" +
        "strands-box-harness phase=x outcome=ok class=fixture private\n",
    );
    await host;
    const logged = observed.join("");
    assert.equal(logged, forwarded);
    assert(!logged.includes("fixture-private"));
  } finally {
    writes.mock.restore();
  }
});

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

test("the native hook route is the workspace node's Gateway hook prefix: POST, one relay", () => {
  const node = parseRoute(
    { url: "wss://gateway.invalid:10443/namespaces/ns_1/agents/agt_1/node", address: "10.2.3.5" },
    "workspace-node",
  );
  const hook = nativeHookRoute(node, "a".repeat(64));
  assert.deepEqual(hook, {
    kind: "native-hook",
    url: "https://gateway.invalid:10443/namespaces/ns_1/agents/agt_1/node/__openclaw__/native-hook/",
    address: "10.2.3.5",
    caSha256: "a".repeat(64),
  });
  const rules = policy([hook]);
  const prefix = "/namespaces/ns_1/agents/agt_1/node/__openclaw__/native-hook/";
  assert.match(rules, /context.input.host == "gateway.invalid" && context.input.port == 10443/);
  assert.match(rules, /context.input has ip4 && context.input.ip4 == "10.2.3.5"/);
  assert.ok(
    rules.includes(
      `context.input.method == "POST" && context.input.path like "${prefix}codex-*" && !(context.input.path like "${prefix}codex-*/*") && context.input.intercepted == true`,
    ),
  );
  // Exactly one request rule, and no GET or exact-path rule for the node path itself.
  assert.equal(rules.match(/http:request/g)?.length, 1);
  assert.doesNotMatch(rules, /"GET"/);
  // Only a workspace node route derives it; a hook route is never configured on its own.
  assert.throws(
    () =>
      nativeHookRoute(
        parseRoute({ url: "https://fixture.invalid:8444/v1", address: "10.2.3.4" }, "controlled-inference"),
      ),
    { message: "invalid_fixed_egress" },
  );
  assert.throws(
    () =>
      parseRoute(
        { url: "https://gateway.invalid:10443/elsewhere/", address: "10.2.3.5" },
        "native-hook",
      ),
    { message: "invalid_fixed_egress" },
  );
  // Box applies the upstream bundle to the hook route too, so it must opt in.
  assert.deepEqual(
    boxDialedRoutes({ workspaceNode: node, separateWorkspaceNode: {}, nativeHookRelay: hook }).map(
      ({ kind }) => kind,
    ),
    ["native-hook"],
  );
  assert.throws(
    () =>
      assertUpstreamCaScope({ sha256: "b".repeat(64), pem: "" }, [nativeHookRoute(node)]),
    { message: "upstream_ca_route_not_declared" },
  );
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

test("Box's GitHub routes ask one request-time credential source on GitHub's hosts only", () => {
  const rules = policy([], true);
  for (const host of ["github.com", "api.github.com"]) {
    assert.match(
      rules,
      new RegExp(
        `action == Box::Action::"net:connect", resource\\)\\nwhen \\{ context.input.host == "${host.replaceAll(".", "\\.")}" && context.input.port == 443 \\};`,
      ),
    );
  }
  assert.match(
    rules,
    /context.input.host == "github.com" && context.input.port == 443 && \(context.input.method == "GET" \|\| context.input.method == "POST"\) && context.input.intercepted == true/,
  );
  assert.equal(rules.match(/net:connect/g)?.length, 2);
  assert.equal(rules.match(/intercepted == true/g)?.length, 2);
  assert.doesNotMatch(policy([]), /github/);
  // Both routes name the one source; the tables carry a socket path and variable names only.
  assert.equal(
    githubCredentials({
      socket: "/run/box/source/oce.sock",
      bearerEnv: "OCE_SOURCE_BEARER",
      timeoutMs: 5000,
      maxBodyBytes: 4194304,
    }),
    [
      "[gateway.credential_source.oce]",
      'endpoint = "unix:///run/box/source/oce.sock"',
      'bearer = "env://OCE_SOURCE_BEARER"',
      "timeout_ms = 5000",
      "max_body_bytes = 4194304",
      "",
      "[egress.github-git]",
      'destinations = ["github.com"]',
      'secret.ref = "source://oce"',
      'secret.env = "OCE_GITHUB_GIT_CREDENTIAL"',
      'secret.placement = "basic_auth"',
      'secret.inject = "always"',
      "",
      "[egress.github-api]",
      'destinations = ["api.github.com"]',
      'secret.ref = "source://oce"',
      'secret.env = "GITHUB_TOKEN"',
      'secret.placement = "header"',
      'secret.header = "Authorization"',
      'secret.prefix = "token "',
      'secret.inject = "phantom"',
      "",
    ].join("\n"),
  );
});

test("the host reports the credential source only for the live box run asking it", () => {
  const bearer = randomBytes(32).toString("base64url");
  const recipient = {
    bearerSha256: createHash("sha256").update(bearer).digest("hex"),
    processInstanceId: "boot:7:11",
  };
  const view = {
    owner: parseOwner({
      driverId: "box",
      implementation: "@openclaw-enterprise/example-strands-box-driver@0.1.0",
      namespaceId: "ns",
      namespaceName: "ns",
      agentId: "agent",
      revisionId: "revision",
    }),
    requirementsDigest: "0".repeat(64),
    executionId: "execution",
    endpoint: { url: "wss://box.example.invalid/", workspaceRoot: "/home/node/workspace" },
  };
  const box = { bootId: "boot", pid: 42, startTicks: "99" };
  const source = { boxProcessInstanceId: "boot:42:99" };
  const live = (state: "starting" | "running" | "failed", current: typeof box | undefined) =>
    observedView({
      view: { ...view, state, repositoryRecipient: { ...recipient, source } },
      execution: { boxProcess: () => current, generation: () => "c".repeat(64) },
    });
  assert.deepEqual(live("running", box).repositoryRecipient, { ...recipient, source });
  // A replaced, exited or failed `box run` no longer asks it; the recipient itself remains.
  for (const [state, current] of [
    ["running", { ...box, pid: 43 }],
    ["running", undefined],
    ["failed", box],
  ] as const) {
    assert.deepEqual(live(state, current).repositoryRecipient, recipient);
  }
  assert.deepEqual(
    observedView({ view: { ...view, state: "starting", repositoryRecipient: recipient } }),
    { ...view, state: "starting", repositoryRecipient: recipient },
  );
  assert.equal(
    observedView({ view: { ...view, state: "running" } }).repositoryRecipient,
    undefined,
  );
  assert.ok(!JSON.stringify(live("running", box)).includes(bearer));
});

test(
  "the source bearer reaches only the box run environment and never the disk",
  { skip: unsupported },
  async () => {
    const directory = temporary();
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
    // The fixture records the config, its policy and only digests of the values it received.
    writeFileSync(
      boxBin,
      '#!/bin/sh\ncp -- "$3" ../generated-box.toml || exit 3\n' +
        'policy=$(sed -n \'s/^policy = "\\(.*\\)"$/\\1/p\' "$3")\n' +
        'cp -- "$policy" ../generated-policy.dw || exit 4\n' +
        "printf '%s' \"$OCE_SOURCE_BEARER\" | sha256sum > ../bearer.sha256\n" +
        "env | cut -d= -f1 | sort > ../box-env\n" +
        "sleep 2\nexit 2\n",
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
    const bearer = randomBytes(32).toString("base64url");
    const reservationGeneration = "a".repeat(64);
    const credentialSource = { socket: join(runtimeDir, "source", "oce.sock"), bearer };
    const releaseGate = true as const;
    const { input } = smokeInput(config);
    try {
      for (const refused of [
        { ...input, credentialSource },
        { ...input, reservationGeneration },
        { ...input, credentialSource, reservationGeneration },
        { ...input, releaseGate, reservationGeneration },
        { ...input, credentialSource, releaseGate, reservationGeneration: "short" },
        {
          ...input,
          credentialSource: { ...credentialSource, bearer: "short" },
          releaseGate,
          reservationGeneration,
        },
        {
          ...input,
          credentialSource: { ...credentialSource, socket: join(directory, "elsewhere.sock") },
          releaseGate,
          reservationGeneration,
        },
        {
          ...input,
          environment: { ...input.environment, GITHUB_TOKEN: "x" },
          credentialSource,
          releaseGate,
          reservationGeneration,
        },
        {
          ...input,
          environment: { ...input.environment, OCE_SOURCE_BEARER: "x" },
          credentialSource,
          releaseGate,
          reservationGeneration,
        },
      ]) {
        const scratch = join(directory, `refused-${randomBytes(4).toString("hex")}`);
        mkdirSync(scratch, { mode: 0o700 });
        const refusedExecution = start({ ...config, runtimeDir: scratch }, refused);
        await assert.rejects(refusedExecution.ready, { message: "startup_refused:stage-inputs" });
        await refusedExecution.done.catch(() => undefined);
        assert.equal(refusedExecution.boxProcess(), undefined);
      }
      // The one protected start: held at the release gate, with the source routes from the start.
      const execution = start(config, {
        ...input,
        credentialSource,
        releaseGate,
        reservationGeneration,
      });
      await execution.spawned;
      assert.ok(execution.boxProcess());
      assert.equal(execution.generation(), reservationGeneration);
      // The fixture exits while the run is still held at the gate; nothing reaches the workload.
      await assert.rejects(execution.ready, { message: "startup_refused:wait-release" });
      assert.equal(await execution.done, 2);
      const generated = readFileSync(join(directory, "generated-box.toml"), "utf8");
      assert.ok(
        generated.includes(
          `\n${githubCredentials({
            socket: credentialSource.socket,
            bearerEnv: "OCE_SOURCE_BEARER",
            timeoutMs: 5000,
            maxBodyBytes: 4 * 1024 * 1024,
          })}`,
        ),
      );
      assert.match(generated, new RegExp(`box_dir = "${runtimeDir}/box-state"`));
      assert.doesNotMatch(
        generated,
        /\[agent\.env\][^[]*(?:GITHUB_TOKEN|OCE_GITHUB_GIT_CREDENTIAL|OCE_SOURCE_BEARER)/,
      );
      assert.ok(
        readFileSync(join(directory, "generated-policy.dw"), "utf8").includes(githubPolicy()),
      );
      assert.equal(
        readFileSync(join(directory, "bearer.sha256"), "utf8").split(" ")[0],
        createHash("sha256").update(bearer).digest("hex"),
      );
      assert.deepEqual(
        readFileSync(join(directory, "box-env"), "utf8")
          .trim()
          .split("\n")
          .filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name)),
        [
          "EXPERIMENTAL_LINUX_SUPPORT",
          ...(process.arch === "x64" ? ["EXPERIMENTAL_X86_SUPPORT"] : []),
          "HOME",
          "LANG",
          "OCE_SOURCE_BEARER",
          "PATH",
        ],
      );
      // Nothing the host wrote (runtime records, box.toml, policy, staged inputs) holds it.
      const files: string[] = [];
      const walk = (path: string) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isDirectory()) {
            walk(child);
          } else if (entry.isFile()) {
            files.push(child);
          }
        }
      };
      walk(directory);
      assert.ok(files.length > 3);
      for (const file of files) {
        assert.ok(!readFileSync(file).includes(bearer), file);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

function certificate(directory: string, name: string, ca: boolean): string {
  const out = join(directory, `${name}.pem`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-subj",
      `/CN=${name}`,
      "-days",
      "1",
      "-addext",
      ca ? "basicConstraints=critical,CA:TRUE" : "basicConstraints=critical,CA:FALSE",
      "-keyout",
      join(directory, `${name}.key`),
      "-out",
      out,
    ],
    { stdio: "ignore" },
  );
  chmodSync(out, 0o600);
  return out;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("a controlled inference DNS name is accepted only with its one pinned private IPv4", () => {
  const url = "https://model.pilot.example:8444/v1";
  const route = parseRoute({ url, address: "10.0.0.9" }, "controlled-inference");
  assert.deepEqual(routeView(route), { url, address: "10.0.0.9" });
  const rules = policy([route]);
  assert.match(
    rules,
    /context.input.host == "model.pilot.example" && context.input.port == 8444 && !\(context.input has ip6\) && \(!\(context.input has ip4\) \|\| \(context.input has ip4 && context.input.ip4 == "10.0.0.9"\)\)/,
  );
  assert.match(rules, /context.input.path == "\/v1\/responses"/);
  for (const [value, kind] of [
    // Public, metadata, shared and loopback addresses.
    [{ url, address: "8.8.8.8" }, "controlled-inference"],
    [{ url, address: "169.254.169.254" }, "controlled-inference"],
    [{ url, address: "100.64.0.9" }, "controlled-inference"],
    [{ url, address: "127.0.0.1" }, "controlled-inference"],
    [{ url: "https://203.0.113.7/v1", address: "203.0.113.7" }, "controlled-inference"],
    // A private literal must be its own pinned address.
    [{ url: "https://10.0.0.9/v1", address: "10.0.0.10" }, "controlled-inference"],
    // Names that are not one operator FQDN.
    [{ url: "https://model/v1", address: "10.0.0.9" }, "controlled-inference"],
    [{ url: "https://model.localhost/v1", address: "10.0.0.9" }, "controlled-inference"],
    [{ url: "https://model.pilot.example./v1", address: "10.0.0.9" }, "controlled-inference"],
    [{ url: "https://[fd00::9]/v1", address: "10.0.0.9" }, "controlled-inference"],
    // Compute never produces these spellings, so the host refuses them at load.
    [{ url: "https://model.pilot.example/v1/", address: "10.0.0.9" }, "controlled-inference"],
    [{ url: "https://model.pilot.example/openai/v1", address: "10.0.0.9" }, "controlled-inference"],
    // A route opts in to the upstream CA bundle by digest only; the bundle is execution-wide.
    [{ url: "wss://gateway.pilot.example/pair", address: "10.0.0.1", ca: {} }, "workspace-node"],
    [{ url, address: "10.0.0.9", caSha256: "A".repeat(64) }, "controlled-inference"],
    [{ url, address: "10.0.0.9", extra: true }, "controlled-inference"],
  ] as const) {
    assert.throws(() => parseRoute(value, kind), { message: /invalid_fixed_egress/ });
  }
});

test("the Driver's stated model route must equal the host route, including its CA digest", () => {
  const url = "https://model.pilot.example:8444/v1";
  const route = parseRoute({ url, address: "10.0.0.9" }, "controlled-inference");
  assert.equal(sameRouteView({ url, address: "10.0.0.9" }, route), true);
  confirmControlledInference(route, true, { url, address: "10.0.0.9" });
  confirmControlledInference(route, false, undefined);
  for (const stated of [
    { url, address: "10.0.0.10" },
    { url: "https://other.pilot.example:8444/v1", address: "10.0.0.9" },
    { url, address: "10.0.0.9", caSha256: "a".repeat(64) },
    { url, address: "10.0.0.9", extra: "x" },
    { url },
    true,
    [url, "10.0.0.9"],
  ]) {
    assert.equal(sameRouteView(stated, route), false);
    assert.throws(() => confirmControlledInference(route, true, stated), {
      message: "controlled_inference_route_mismatch",
    });
  }
  assert.throws(() => confirmControlledInference(route, true, undefined), {
    message: "controlled_inference_unconfirmed",
  });
  assert.throws(() => confirmControlledInference(route, false, { url, address: "10.0.0.9" }), {
    message: "controlled_inference_unconfirmed",
  });
  assert.throws(() => confirmControlledInference(undefined, true, { url, address: "10.0.0.9" }), {
    message: "controlled_inference_route_mismatch",
  });
});

test("the host refuses a name that resolves anywhere but the pinned address", async () => {
  const route = parseRoute(
    { url: "https://model.pilot.example/v1", address: "10.0.0.9" },
    "controlled-inference",
  );
  const answers =
    (value: readonly { address: string; family: number }[] | Error) => async (hostname: string) => {
      assert.equal(hostname, "model.pilot.example");
      if (value instanceof Error) {
        throw value;
      }
      return value;
    };
  await assertPinnedResolution(route, answers([{ address: "10.0.0.9", family: 4 }]));
  for (const value of [
    [{ address: "10.0.0.10", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }],
    [
      { address: "10.0.0.9", family: 4 },
      { address: "10.0.0.10", family: 4 },
    ],
    [
      { address: "10.0.0.9", family: 4 },
      { address: "fd00::9", family: 6 },
    ],
    [],
  ]) {
    await assert.rejects(assertPinnedResolution(route, answers(value)), {
      message: "egress_name_not_pinned",
    });
  }
  await assert.rejects(assertPinnedResolution(route, answers(new Error("ENOTFOUND"))), {
    message: "egress_name_unresolved",
  });
  await assert.rejects(
    assertPinnedResolution(route, () => new Promise(() => undefined), 20),
    {
      message: "egress_name_unresolved",
    },
  );
  const literal = parseRoute(
    { url: "https://10.0.0.9/v1", address: "10.0.0.9" },
    "controlled-inference",
  );
  await assertPinnedResolution(literal, () => assert.fail("a literal needs no lookup"));
});

test(
  "an upstream CA bundle is loaded once by digest, must be CA certificates, and reaches only Box's authority files",
  { skip: unsupported },
  async () => {
    const directory = temporary();
    try {
      const url = "https://model.pilot.example:8444/v1";
      const caFile = certificate(directory, "route-ca", true);
      const sha256 = sha256File(caFile);
      const ca = loadUpstreamCa({ file: caFile, sha256 });
      assert.equal(ca.sha256, sha256);
      const route = parseRoute(
        { url, address: "10.0.0.9", caSha256: sha256 },
        "controlled-inference",
      );
      assert.deepEqual(routeView(route), { url, address: "10.0.0.9", caSha256: sha256 });
      assert.equal(upstreamCaPem(ca, [route]), readFileSync(caFile, "utf8").trim() + "\n");
      assert.equal(upstreamCaPem(undefined, []), undefined);
      // The opt-in digest does not change the network pin.
      assert.equal(
        policy([route]),
        policy([parseRoute({ url, address: "10.0.0.9" }, "controlled-inference")]),
      );
      const refused = (value: unknown, message: string) =>
        assert.throws(() => loadUpstreamCa(value), { message });
      refused({ file: caFile, sha256: "0".repeat(64) }, "upstream_ca_mismatch");
      const leaf = certificate(directory, "leaf", false);
      refused({ file: leaf, sha256: sha256File(leaf) }, "invalid_upstream_ca");
      const linked = join(directory, "linked.pem");
      symlinkSync(caFile, linked);
      refused({ file: linked, sha256 }, "invalid_upstream_ca");
      const padded = join(directory, "padded.pem");
      writeFileSync(padded, `${readFileSync(caFile, "utf8")}\nnot a certificate\n`, {
        mode: 0o600,
      });
      refused({ file: padded, sha256: sha256File(padded) }, "invalid_upstream_ca");
      const writable = join(directory, "writable.pem");
      writeFileSync(writable, readFileSync(caFile));
      chmodSync(writable, 0o666);
      refused({ file: writable, sha256 }, "invalid_upstream_ca");
      refused({ file: "relative.pem", sha256 }, "invalid_upstream_ca");
      refused({ file: caFile, sha256: sha256.toUpperCase() }, "invalid_upstream_ca");
      refused({ file: caFile, sha256, extra: true }, "invalid_upstream_ca");

      // Launch writes the verified bytes into the authority directory and names them in
      // box.toml; the operator file can change afterwards without reaching Box.
      const runtimeDir = join(directory, "run");
      const workspace = join(directory, "workspace");
      const agentBuildDir = join(directory, "build");
      for (const path of [runtimeDir, workspace, agentBuildDir]) {
        mkdirSync(path, { mode: 0o700 });
      }
      for (const file of ["box-agent.js", "transport.js", "diagnostics.js"]) {
        writeFileSync(join(agentBuildDir, file), "", { mode: 0o600 });
      }
      const verified = readFileSync(caFile, "utf8");
      writeFileSync(caFile, readFileSync(leaf));
      const boxBin = join(directory, "fixture-box");
      writeFileSync(
        boxBin,
        '#!/bin/sh\ncp -- "$3" ../generated-box.toml || exit 3\n' +
          `ca=$(sed -n 's/^${BOX_UPSTREAM_CA_KEY} = "\\(.*\\)"$/\\1/p' "$3")\n` +
          'cp -- "$ca" ../generated-ca.pem || exit 4\n' +
          'cp -- "$(dirname "$3")/policy.dw" ../generated-policy.dw || exit 5\nexit 2\n',
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
      // An undeclared route refuses the bundle before Box starts.
      const undeclared = parseRoute({ url, address: "10.0.0.9" }, "controlled-inference");
      const refusedRuntime = join(directory, "refused-run");
      mkdirSync(refusedRuntime, { mode: 0o700 });
      const refusedStart = start(
        { ...config, runtimeDir: refusedRuntime },
        { ...input, egress: [undeclared], upstreamCa: ca },
      );
      await assert.rejects(refusedStart.ready, { message: "startup_refused:stage-inputs" });
      await refusedStart.done;
      assert.throws(() => readFileSync(join(directory, "generated-box.toml")), { code: "ENOENT" });
      const execution = start(config, { ...input, egress: [route], upstreamCa: ca });
      await assert.rejects(execution.ready, { message: /^startup_refused:/ });
      assert.equal(await execution.done, 2);
      const generated = readFileSync(join(directory, "generated-box.toml"), "utf8");
      const line = generated.split("\n").find((row) => row.startsWith(`${BOX_UPSTREAM_CA_KEY} = `));
      assert.ok(line, generated);
      // One scalar path, as strands-agents/box#147 reads it.
      const path = JSON.parse(line.slice(line.indexOf("=") + 1).trim()) as string;
      const policyLine = generated.match(/^policy = (".*")$/m);
      assert.ok(policyLine);
      // Box excludes its own configuration directory from every grant.
      assert.equal(dirname(path), dirname(JSON.parse(policyLine[1]!) as string));
      assert.equal(
        readFileSync(join(directory, "generated-ca.pem"), "utf8"),
        verified.trim() + "\n",
      );
      assert.match(
        readFileSync(join(directory, "generated-policy.dw"), "utf8"),
        /context.input.ip4 == "10.0.0.9"/,
      );
      const rows = generated.split("\n").filter((row) => /^(read|write|exec) = \[/.test(row));
      const grants = rows.flatMap((row) => JSON.parse(row.slice(row.indexOf("["))) as string[]);
      for (const grant of grants) {
        assert(!(path === grant || path.startsWith(grant + sep)), `${grant} covers the route CA`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

function protectedFixture() {
  const owner = parseOwner({
    driverId: "box",
    implementation: "@openclaw-enterprise/example-strands-box-driver@0.1.0",
    namespaceId: "ns",
    namespaceName: "ns",
    agentId: "agent",
    revisionId: "revision",
  });
  const configured = { provider: "github" as const };
  const execution = {
    installationId: "installation",
    namespaceId: owner.namespaceId,
    agentId: owner.agentId,
    servicePrincipalId: "principal",
    revisionId: owner.revisionId,
    executionId: "occ-execution",
  };
  const plan = {
    id: "plan",
    generation: 1,
    execution,
    sandboxDriverId: owner.driverId,
    egressDriverId: owner.driverId,
    driver: { id: owner.driverId, implementation: owner.implementation, configurationId: "c" },
    repositoryGitAuthorization: "online-request" as const,
    repositoryGit: {
      driver: { id: "repo", implementation: "fixture/repo" },
      deadlineWallMs: Date.now() + 60_000,
      bindings: [
        {
          repositoryRef: "selected",
          profile: "github-repository" as const,
          backendId: "repo",
          grant: { providerInstanceId: "p", repositoryId: "r", grantId: "g" },
        },
      ],
    },
    routes: [],
  };
  const wiring = { plan, configuration: wiringConfiguration("github") };
  return { owner, configured, plan, wiring };
}

test("the host admits only the paired one-repository plan for its own GitHub routes", () => {
  const { owner, configured, plan, wiring } = protectedFixture();
  assert.deepEqual(wiring.configuration, {
    version: 4,
    protectedRepository: {
      provider: "github",
      hosts: ["github.com", "api.github.com"],
      delivery: "box-source-v1",
    },
  });
  assert.deepEqual(protectedWiring(configured, wiring, owner), plan);
  for (const refused of [
    { ...wiring, configuration: { ...wiring.configuration, version: 1 } },
    {
      ...wiring,
      configuration: {
        version: 2,
        protectedRepository: { ...wiring.configuration.protectedRepository, hosts: ["github.com"] },
      },
    },
    {
      ...wiring,
      configuration: {
        version: 1,
        repositorySender: { url: "https://sender.example.test:9443/", address: "10.4.5.6" },
      },
    },
    { ...wiring, plan: { ...plan, repositoryGitAuthorization: "request-hook-observed" } },
    { ...wiring, plan: { ...plan, routes: [{}] } },
    { ...wiring, plan: { ...plan, egressDriverId: "other" } },
    { ...wiring, plan: { ...plan, execution: { ...plan.execution, revisionId: "other" } } },
    { ...wiring, plan: { ...plan, policyReductionVersion: 2 } },
    {
      ...wiring,
      plan: {
        ...plan,
        repositoryGit: {
          ...plan.repositoryGit,
          bindings: [{ ...plan.repositoryGit.bindings[0], profile: "github-installation" }],
        },
      },
    },
    { ...wiring, extra: true },
  ]) {
    assert.throws(() => protectedWiring(configured, refused, owner), {
      message: /^(?:unadmitted_protected_wiring|unknown_field)$/,
    });
  }
  assert.throws(() => protectedWiring(undefined, wiring, owner), {
    message: "unadmitted_protected_wiring",
  });
});

test("only Compute's signed release for this held box run opens the startup gate", () => {
  const { plan } = protectedFixture();
  const keys = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const bearerSha256 = "b".repeat(64);
  const expected = {
    executionId: "host-execution",
    processInstanceId: "boot:42:99",
    bearerSha256,
  };
  const installation = (recipient: Record<string, string> = {}) => ({
    plan,
    sandboxId: expected.executionId,
    sender: { id: "box-sender", generation: 1 },
    installedAt: new Date(0).toISOString(),
    enforcement: {
      instanceId: expected.executionId,
      configurationId: "configuration",
      policyHash: "a".repeat(64),
      authorityScope: "execution" as const,
      repositoryGitRecipient: {
        providerId: "box-sender",
        attachmentEpoch: expected.executionId,
        processInstanceId: expected.processInstanceId,
        networkInstanceId: `box-source-sha256:${bearerSha256}`,
        authorization: "online-request" as const,
        deliveryProfile: "github_repository" as const,
        ...recipient,
      },
    },
  });
  const startup = { releaseKey: keys.publicKey, plan };
  const startupId = randomUUID();
  const signed = signComputeExecutionRelease(keys.privateKey, startupId, installation());
  const accepted = verifyRelease(startup, structuredClone(signed), expected);
  assert.equal(accepted.startupId, startupId);
  assert.match(accepted.startupSha256, /^[a-f0-9]{64}$/);
  const refusals: [unknown, typeof expected, number?][] = [
    [signComputeExecutionRelease(other.privateKey, startupId, installation()), expected],
    [{ ...signed, expiresAt: signed.expiresAt + 1 }, expected],
    [signed, expected, signed.expiresAt],
    [signed, { ...expected, processInstanceId: "boot:43:99" }],
    [signed, { ...expected, bearerSha256: "c".repeat(64) }],
    [signed, { ...expected, executionId: "replacement" }],
    [
      signComputeExecutionRelease(
        keys.privateKey,
        startupId,
        installation({ processInstanceId: "boot:43:99" }),
      ),
      expected,
    ],
    [
      signComputeExecutionRelease(keys.privateKey, startupId, {
        ...installation(),
        plan: { ...plan, generation: 2 },
      }),
      expected,
    ],
    [{ ...signed, extra: true }, expected],
  ];
  for (const [release, identity, now] of refusals) {
    assert.throws(() => verifyRelease(startup, release, identity, now), {
      message: /^(?:release_signature_refused|release_outside_held_execution|unknown_field)$/,
    });
  }
});

test(
  "a protected box run waits at the host gate until the verified release",
  { skip: unsupported },
  async () => {
    const directory = temporary();
    const runtimeDir = join(directory, "run");
    const workspace = join(directory, "workspace");
    const agentBuildDir = join(directory, "build");
    for (const path of [runtimeDir, workspace, agentBuildDir]) {
      mkdirSync(path, { mode: 0o700 });
    }
    for (const file of ["box-agent.js", "transport.js", "diagnostics.js"]) {
      writeFileSync(join(agentBuildDir, file), "", { mode: 0o600 });
    }
    const node = realpathSync(process.execPath);
    // Stands in for box-agent: read the staged input, wait for the gate, record its answer.
    const waiter = join(directory, "waiter.mjs");
    writeFileSync(
      waiter,
      `import { readFileSync, writeFileSync, existsSync } from "node:fs";
       import { createConnection } from "node:net";
       const config = readFileSync(process.argv[2], "utf8");
       const input = JSON.parse(readFileSync(JSON.parse(config.match(/^command = (.*)$/m)[1])[3], "utf8"));
       while (!existsSync(input.releaseSocket)) await new Promise((r) => setTimeout(r, 20));
       const socket = createConnection({ path: input.releaseSocket });
       let text = "";
       for await (const chunk of socket) text += chunk;
       writeFileSync(process.argv[3], text);`,
      { mode: 0o600 },
    );
    const boxBin = join(directory, "fixture-box");
    writeFileSync(
      boxBin,
      `#!/bin/sh\n${shellQuote(node)} ${shellQuote(waiter)} "$3" ../released || exit 3\nexit 2\n`,
      { mode: 0o700 },
    );
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
    const reservationGeneration = randomBytes(32).toString("hex");
    try {
      // A protected run always carries Box's credential source; the gate holds it all the same.
      const credentialSource = {
        socket: join(runtimeDir, "source", "oce.sock"),
        bearer: randomBytes(32).toString("base64url"),
      };
      const execution = start(config, {
        ...input,
        releaseGate: true,
        reservationGeneration,
        credentialSource,
      });
      await execution.spawned;
      const generation = execution.generation();
      assert.equal(generation, reservationGeneration);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.throws(() => lstatSync(join(directory, "released")), { code: "ENOENT" });
      assert.equal(execution.generation(), generation);
      await execution.release();
      await assert.rejects(execution.release(), { message: "release_gate_unavailable" });
      await assert.rejects(execution.ready, { message: "startup_refused:wait-original-native" });
      assert.equal(await execution.done, 2);
      assert.equal(readFileSync(join(directory, "released"), "utf8"), "released\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "box-agent starts the command only after the release socket answers the fixed line",
  { skip: unsupported, timeout: 20_000 },
  async () => {
    const directory = temporary();
    const marker = join(directory, "started");
    const releaseSocket = join(directory, "release.sock");
    const inputFile = join(directory, "agent.json");
    const node = realpathSync(process.execPath);
    writeFileSync(
      inputFile,
      JSON.stringify({
        command: [node, "-e", "require('node:fs').writeFileSync(process.argv[1], 'x')", marker],
        workspace: directory,
        codexBin: join(directory, "absent-codex"),
        socketPath: join(directory, "inner.sock"),
        releaseSocket,
      }),
      { mode: 0o600 },
    );
    const agent = spawn(
      node,
      [
        fileURLToPath(
          new URL("../../deploy/examples/strands-box/host/box-agent.ts", import.meta.url),
        ),
        inputFile,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    const servers: Server[] = [];
    const answer = async (line: string) => {
      const server = createServer((socket) => socket.end(line));
      servers.push(server);
      server.listen(releaseSocket);
      await once(server, "listening");
      return server;
    };
    const absent = () => {
      try {
        lstatSync(marker);
        return false;
      } catch {
        return true;
      }
    };
    try {
      // No socket, then a socket with the wrong answer: the command never starts.
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.ok(absent());
      const wrong = await answer("release\n");
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.ok(absent());
      await new Promise<void>((resolve) => wrong.close(() => resolve()));
      await answer("released\n");
      const deadline = Date.now() + 10_000;
      while (absent() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(absent(), false);
    } finally {
      agent.kill("SIGKILL");
      for (const server of servers) {
        server.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

function signedLeaf(directory: string, ca: string, name: string, san: string): string {
  const key = join(directory, `${name}.key`);
  const csr = join(directory, `${name}.csr`);
  const out = join(directory, `${name}.pem`);
  const extensions = join(directory, `${name}.ext`);
  writeFileSync(extensions, `basicConstraints=critical,CA:FALSE\nsubjectAltName=${san}\n`);
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-subj",
      `/CN=${name}`,
      "-keyout",
      key,
      "-out",
      csr,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      ca.replace(/\.pem$/, ".key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      extensions,
      "-out",
      out,
    ],
    { stdio: "ignore" },
  );
  return out;
}

async function handshake(port: number, servername: string, ca?: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      servername,
      ...(ca === undefined ? {} : { ca }),
    });
    socket.once("secureConnect", () => {
      socket.end();
      resolve("trusted");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}

test(
  "the bundle the host hands Box completes TLS to a leaf it issued for the pinned name",
  { skip: unsupported },
  async (t) => {
    const directory = temporary();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const caFile = certificate(directory, "route-ca", true);
    const ca = loadUpstreamCa({ file: caFile, sha256: sha256File(caFile) });
    const route = parseRoute(
      { url: "https://model.pilot.example:8444/v1", address: "10.0.0.9", caSha256: ca.sha256 },
      "controlled-inference",
    );
    // Hostname verification only: Box would trust this CA for any name its policy permits,
    // which is why every route Box dials must opt in to the bundle.
    const bundle = upstreamCaPem(ca, [route]);
    assert.ok(bundle);
    const leaves = {
      named: signedLeaf(directory, caFile, "model", "DNS:model.pilot.example"),
      other: signedLeaf(directory, caFile, "other", "DNS:other.pilot.example"),
    };
    for (const [kind, leaf] of Object.entries(leaves)) {
      const server = tlsServer({
        cert: readFileSync(leaf),
        key: readFileSync(leaf.replace(/\.pem$/, ".key")),
      });
      server.on("tlsClientError", () => undefined);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert(address !== null && typeof address !== "string");
      try {
        const result = await handshake(address.port, "model.pilot.example", bundle);
        if (kind === "named") {
          assert.equal(result, "trusted");
          // Without the route CA only public roots apply, as in stock Box.
          assert.notEqual(await handshake(address.port, "model.pilot.example"), "trusted");
          assert.notEqual(
            await handshake(
              address.port,
              "model.pilot.example",
              readFileSync(leaves.other, "utf8"),
            ),
            "trusted",
          );
        } else {
          assert.equal(result, "ERR_TLS_CERT_ALTNAME_INVALID");
        }
      } finally {
        server.close();
      }
    }
  },
);

test(
  "an upstream CA bundle needs every route Box dials to declare its digest",
  { skip: unsupported },
  () => {
    const directory = temporary();
    try {
      const caFile = certificate(directory, "route-ca", true);
      const ca = loadUpstreamCa({ file: caFile, sha256: sha256File(caFile) });
      const otherFile = certificate(directory, "other-ca", true);
      const other = sha256File(otherFile);
      const model = (caSha256?: string) =>
        parseRoute(
          {
            url: "https://model.pilot.example:8444/v1",
            address: "10.0.0.9",
            ...(caSha256 === undefined ? {} : { caSha256 }),
          },
          "controlled-inference",
        );
      const node = (caSha256?: string) =>
        parseRoute(
          {
            url: "wss://gateway.pilot.example:8443/pair",
            address: "10.0.0.1",
            ...(caSha256 === undefined ? {} : { caSha256 }),
          },
          "workspace-node",
        );
      // One route declaring.
      assertUpstreamCaScope(ca, [model(ca.sha256)]);
      // Two routes, both declaring.
      assertUpstreamCaScope(ca, [node(ca.sha256), model(ca.sha256)]);
      assert.equal(upstreamCaPem(ca, [node(ca.sha256), model(ca.sha256)]), `${ca.pem.trim()}\n`);
      // One of two not declaring: the inline node would carry the pairing code under this trust.
      for (const routes of [
        [node(), model(ca.sha256)],
        [model(ca.sha256), node()],
      ]) {
        assert.throws(() => assertUpstreamCaScope(ca, routes), {
          message: "upstream_ca_route_not_declared",
        });
        assert.throws(() => upstreamCaPem(ca, routes), {
          message: "upstream_ca_route_not_declared",
        });
      }
      // Mismatched digests.
      assert.throws(() => assertUpstreamCaScope(ca, [node(ca.sha256), model(other)]), {
        message: "upstream_ca_digest_mismatch",
      });
      // A declared digest with no bundle configured.
      assert.throws(() => assertUpstreamCaScope(undefined, [model(ca.sha256)]), {
        message: "upstream_ca_not_configured",
      });
      assertUpstreamCaScope(undefined, [node(), model()]);
      // Config load counts the workspace node only when it runs inside Box.
      assert.deepEqual(
        boxDialedRoutes({ workspaceNode: node(), controlledInference: model(ca.sha256) }).map(
          ({ kind }) => kind,
        ),
        ["workspace-node", "controlled-inference"],
      );
      const separate = boxDialedRoutes({
        workspaceNode: node(),
        separateWorkspaceNode: {},
        controlledInference: model(ca.sha256),
      });
      assert.deepEqual(
        separate.map(({ kind }) => kind),
        ["controlled-inference"],
      );
      assertUpstreamCaScope(ca, separate);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("the file node mount inventory admits a host's namespace file binds", () => {
  const root = mkdtempSync(join(tmpdir(), "box-node-inventory-"));
  try {
    const directory = (name: string) => {
      const path = join(root, name);
      mkdirSync(path, { mode: 0o700 });
      return path;
    };
    const [rootfs, workspace, node] = [
      directory("rootfs"),
      directory("workspace"),
      directory("node"),
    ];
    const line = (id: number, device: string, source: string, path: string) =>
      `${id} 1 ${device} ${source} ${path} rw,relatime - ext4 /dev/vda1 rw`;
    const input = (extra: string) => ({
      installation: {
        mode: "file-only-v1" as const,
        rootfs,
        rootfsIdentity: fileIdentity(rootfs),
        runtimeSha256: "0".repeat(64),
        workspaceVolume: { claimUid: "claim", volumeName: "volume" },
      },
      workspace,
      workspaceIdentity: fileIdentity(workspace),
      stateIdentity: fileIdentity(node),
      volumeMounts: [
        { path: workspace, subPath: "workspace", identity: fileIdentity(workspace) },
        { path: node, subPath: "workspace-node-a-h", identity: fileIdentity(node) },
      ],
      runtime: join(root, "unused"),
      route: {
        kind: "workspace-node" as const,
        url: "wss://gateway.example.test:10443/agents/a/node",
        address: "10.0.0.1",
      },
      displayName: "node",
      mountinfo: () =>
        [
          line(30, "252:1", "/", "/"),
          line(31, "252:1", "/pv/workspace", workspace),
          line(32, "252:1", "/pv/workspace-node-a-h", node),
          extra,
        ].join("\n"),
    });
    // A Kubernetes node's CNI network namespaces are nsfs binds whose root is not a path.
    assert.doesNotThrow(() =>
      assertNodeInputs(input(line(40, "0:4", "net:[4026532620]", "/run/netns/cni-1"))),
    );
    assert.throws(
      () => assertNodeInputs(input(line(41, "0:4", "relative", "/run/other"))),
      /invalid_file_node_mount_inventory/,
    );
    assert.throws(
      () => assertNodeInputs(input(line(42, "0:4", "net:[4026532621]", join(workspace, "ns")))),
      /file_node_nested_mount/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
