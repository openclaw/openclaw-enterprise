import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as httpServer, request } from "node:http";
import { createConnection, createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  AGENT_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  canonical,
  digest,
  profileDigest,
  parseOwner,
  reserveExecution,
  stockHarnessCommand,
  validateInstalledGrants,
} from "../../deploy/examples/strands-box/host/control.ts";
import {
  approve,
  currentController,
  durableRecord,
  isApproved,
} from "../../deploy/examples/strands-box/host/admission.ts";
import type { Pending } from "../../deploy/examples/strands-box/host/admission.ts";
import { parseRoute, policy } from "../../deploy/examples/strands-box/host/egress.ts";
import { hostConfig, smokeInput, start } from "../../deploy/examples/strands-box/host/launch.ts";
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
    const workspace = join(directory, "workspace");
    const agentBuildDir = join(directory, "build");
    for (const path of [runtimeDir, workspace, agentBuildDir]) {
      mkdirSync(path, { mode: 0o700 });
    }
    for (const file of ["box-agent.js", "transport.js", "diagnostics.js"]) {
      writeFileSync(join(agentBuildDir, file), "", { mode: 0o600 });
    }
    const boxBin = join(directory, "fixture-box");
    writeFileSync(
      boxBin,
      "#!/bin/sh\nprintf '%s' 'strands-box: error: policy load failed: ' >&2\n" +
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
