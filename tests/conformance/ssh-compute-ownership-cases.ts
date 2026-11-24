import assert from "node:assert/strict";
import test from "node:test";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createSshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import {
  agentBinding,
  bind,
  digest,
  expectedRuntimeConfiguration,
  fixture,
  fixtureGroupId,
  fixtureUserId,
  json,
  missing,
  options,
  prepare,
  readRecord,
  revision,
  runtimeAccountName,
  runtimeContext,
  seedHistoricalSnapshot,
  stage,
  tenant,
} from "./ssh-compute-fixture.ts";

test("SSH Namespace preparation creates exact ownership, rejects adoption, and classifies failures", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.driver.ensureNamespace({ ...tenant, name: "unmapped" }), {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
  });
  assert.deepEqual(await f.driver.ensureNamespace({ ...tenant, existingNamespace: "adopt" }), {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
  });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.driver.ensureNamespace(tenant)).namespaceReady, true);
  const marker = join(f.nsDir, "namespace.json");
  const original = await readRecord(marker);
  assert.deepEqual(original, {
    driverId: "compute-ssh",
    implementation: "occ/ssh",
    namespaceId: tenant.id,
    namespaceName: tenant.name,
  });
  assert.equal((await stat(marker)).mode & 0o777, 0o600);
  // Replace the directory entry; never follow an unexpected link to change its target.
  const replaceMarker = async (value: Record<string, unknown>) => {
    const replacement = marker + ".replacement";
    await writeFile(replacement, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(replacement, marker);
  };
  for (const key of Object.keys(original)) {
    await replaceMarker({ ...original, [key]: "foreign" });
    assert.equal((await f.driver.ensureNamespace(tenant)).failure, "permanent");
    assert.equal((await f.driver.deleteNamespace(tenant)).failure, "permanent");
    assert.equal((await readRecord(marker))[key], "foreign");
    await replaceMarker(original);
  }
  await rm(marker);
  assert.equal((await f.driver.ensureNamespace(tenant)).failure, "permanent");
  await assert.rejects(access(marker), { code: "ENOENT" });
  await replaceMarker(original);
  const unowned = revision(f.driver, 1, "agent-ssh-unowned");
  const account = runtimeAccountName(tenant, unowned.agentId, f.configured.runtime.user);
  await Promise.all([
    mkdir(join(f.state, "accounts", "users"), { recursive: true }),
    mkdir(join(f.state, "accounts", "groups"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(f.state, "accounts", "users", account),
      `${fixtureUserId()}\n${fixtureGroupId()}\n`,
    ),
    writeFile(join(f.state, "accounts", "groups", account), `${fixtureGroupId()}\n`),
  ]);
  bind(f.driver, unowned);
  await assert.rejects(f.driver.prepareRevision(unowned), /foreign ownership|snapshot/);
  const transport = createSshComputeDriver(options(), {
    executor: {
      execute: async () => {
        throw new Error("transport unavailable");
      },
    },
  });
  assert.equal((await transport.ensureNamespace(tenant)).failure, "retryable");
});

test("SSH embedded revisions stop without deleting snapshots or persistent Agent state", async (t) => {
  const f = await fixture(t);
  const rev = await stage(f);
  const dir = f.agentDir(rev);
  const port = f.configured.network.gatewayPortRange.start;
  const agent = await readRecord(join(dir, "agent.json"));
  assert.equal(agent.port, port);
  assert.equal(agent.servicePrincipalId, rev.servicePrincipalId);
  assert.ok(typeof agent.runtimeUser === "string");
  assert.match(agent.runtimeUser, /^.+-[a-f0-9]{12}$/);
  assert.equal(agent.runtimeGroup, agent.runtimeUser);
  for (const name of ["home", "state"]) {
    const info = await stat(join(dir, name));
    assert.equal(info.mode & 0o777, 0o700);
    assert.equal(info.uid, fixtureUserId());
  }
  for (const path of [
    join(dir, "agent.json"),
    join(dir, "gateway-password.env"),
    join(f.revisionDir(rev), "revision.json"),
  ]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  // The admitted document is controller-owned and only group-readable by the
  // Agent runtime account, so a live gateway cannot rewrite it and bypass admission.
  const snapshot = await stat(join(f.revisionDir(rev), "openclaw.json"));
  assert.equal(snapshot.mode & 0o777, 0o640);
  assert.equal(snapshot.uid, fixtureUserId());
  assert.deepEqual(
    await json(join(f.revisionDir(rev), "openclaw.json")),
    expectedRuntimeConfiguration(rev),
  );
  assert.equal(
    (await readRecord(join(f.revisionDir(rev), "revision.json"))).configurationHash,
    digest(JSON.stringify(expectedRuntimeConfiguration(rev))),
  );
  await missing(join(dir, "current"));
  await missing(join(dir, "served.json"));
  await missing(join(f.units, f.unit(rev)));
  await missing(join(f.state, "systemctl.log"));
  // Runtime auth is operator-owned. Even an invalid key must not gate process readiness.
  const operatorEnv = join(dir, "env");
  const operatorContents = "OPENAI_API_KEY=invalid-operator-key\n";
  await writeFile(operatorEnv, operatorContents, { flag: "wx", mode: 0o600 });
  // Read identity and contents from one descriptor; reopen the name at each observation.
  const inspectOperatorEnv = async () => {
    const file = await open(operatorEnv, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const { dev, ino, mode, mtimeNs } = await file.stat({ bigint: true });
      assert.equal(await file.readFile("utf8"), operatorContents);
      return { dev, ino, mode, mtimeNs };
    } finally {
      await file.close();
    }
  };
  const operatorBefore = await inspectOperatorEnv();
  await f.driver.activateRevision(rev, runtimeContext);
  assert.equal((await stat(join(dir, "served.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await json(join(dir, "served.json")), { revisionId: rev.id });
  assert.equal(await readlink(join(dir, "current")), `revisions/${digest(rev.id).slice(0, 12)}`);
  assert.match(
    await readFile(join(dir, "gateway-password.env"), "utf8"),
    /^OPENCLAW_GATEWAY_PASSWORD=[a-f0-9]{64}\n$/,
  );
  assert.deepEqual(await inspectOperatorEnv(), operatorBefore);
  assert.equal(
    await readFile(join(f.units, f.unit(rev)), "utf8"),
    `[Unit]
Description=OpenClaw Enterprise gateway ${rev.agentId}
# openclaw-enterprise namespace=${tenant.id} agent=${rev.agentId}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${agent.runtimeUser}
WorkingDirectory=${dir}/state
Environment=HOME=${dir}/home
Environment=OPENCLAW_STATE_DIR=${dir}/state
Environment=OPENCLAW_CONFIG_PATH=${dir}/current/openclaw.json
Environment=OPENCLAW_GATEWAY_PORT=${port}
Environment=OPENCLAW_NO_AUTO_UPDATE=1
EnvironmentFile=${dir}/gateway-password.env
EnvironmentFile=-${dir}/env
ExecStart=${process.execPath} ${f.configured.runtime.openclawPath} gateway --port ${port}
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`,
  );
  assert.match(await readFile(join(f.state, "readyz.log"), "utf8"), /GET \/readyz/);
  await f.driver.activateRevision(rev);
  await f.driver.activateRevision(rev);
  await f.driver.deactivateRevision(rev);
  assert.equal((await f.driver.prepareRevision(rev)).ready, true);
  assert.equal(
    (await readFile(join(f.state, "systemctl.log"), "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("restart ")).length,
    1,
  );
  await writeFile(join(dir, "state", "retained-after-stop"), "persistent");
  await f.driver.stopRevision(rev);
  await f.driver.stopRevision(rev);
  await missing(join(f.state, `${f.unit(rev)}.pid`));
  await missing(join(dir, "current"));
  await missing(join(dir, "served.json"));
  assert.equal((await stat(f.revisionDir(rev))).isDirectory(), true);
  assert.equal(await readFile(join(dir, "state", "retained-after-stop"), "utf8"), "persistent");
  await f.driver.activateRevision(rev);
  const replacement = revision(f.driver, 2);
  assert.equal((await f.driver.prepareRevision(replacement)).ready, true);
  await f.driver.activateRevision(replacement);
  await f.driver.retireRevision(rev);
  await f.driver.stopRevision(replacement);
  assert.deepEqual(await inspectOperatorEnv(), operatorBefore);
  assert.ok(
    (await readFile(join(f.state, "readyz.log"), "utf8"))
      .trim()
      .split("\n")
      .every((line) => line === "GET /readyz"),
  );
});

test("SSH can verify, stop and retire a previously admitted native TLS snapshot", async (t) => {
  const f = await fixture(t);
  const rev = revision(f.driver, 1, "agent-ssh-old-tls", {
    gateway: { tls: { enabled: true } },
  });
  await f.driver.ensureNamespace(tenant);
  bind(f.driver, rev);
  await assert.rejects(f.driver.prepareRevision(rev), /gateway\.tls\.enabled/);
  // Seed the exact configuration/hash the old producer admitted through the
  // real host helper, not by editing its private ownership/snapshot records.
  // SSH/systemd remain fixtures; this protects persisted teardown semantics.
  const configuration = expectedRuntimeConfiguration(rev);
  await seedHistoricalSnapshot(f, rev, configuration);
  assert.deepEqual(await json(join(f.revisionDir(rev), "openclaw.json")), configuration);
  await f.driver.deactivateRevision(rev);
  const changed = {
    ...rev,
    configuration: { ...rev.configuration, gateway: { tls: { enabled: false } } },
  };
  await assert.rejects(f.driver.stopRevision(changed), /immutable snapshot mismatch/);
  await access(f.revisionDir(rev));
  await f.driver.stopRevision(rev);
  await access(f.revisionDir(rev));
  await f.driver.retireRevision(rev);
  await assert.rejects(access(f.revisionDir(rev)), { code: "ENOENT" });
  await f.driver.deleteAgentRuntimeCredentials(agentBinding(rev));
  await assert.rejects(access(f.agentDir(rev)), { code: "ENOENT" });
});

test("SSH trusted-proxy omits gateway.env, and allocation spans Agents and Namespaces on a host", async (t) => {
  const f = await fixture(t);
  const first = await prepare(f);
  const second = revision(f.driver, 1, "agent-ssh-2", {
    gateway: { auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-user" } } },
  });
  bind(f.driver, second);
  assert.equal((await f.driver.prepareRevision(second)).ready, true);
  await f.driver.activateRevision(second);
  assert.equal(
    (await readRecord(join(f.agentDir(second), "agent.json"))).port,
    f.configured.network.gatewayPortRange.start + 1,
  );
  assert.notEqual(
    (await readRecord(join(f.agentDir(second), "agent.json"))).runtimeUser,
    (await readRecord(join(f.agentDir(first), "agent.json"))).runtimeUser,
  );
  const secondUnit = await readFile(join(f.units, f.unit(second)), "utf8");
  assert.doesNotMatch(
    secondUnit,
    /EnvironmentFile=.*gateway(?:-password)?\.env|OPENCLAW_GATEWAY_PASSWORD|OPENCLAW_LOG_LEVEL/,
  );
  await missing(join(f.agentDir(second), "gateway.env"));
  await missing(join(f.agentDir(second), "gateway-password.env"));
  assert.equal(
    (await readRecord(join(f.agentDir(first), "agent.json"))).port,
    f.configured.network.gatewayPortRange.start,
  );
  // A second Namespace shares the physical root and must share its port allocation.
  const other = { ...tenant, id: "ns-ssh-other" };
  const third = { ...revision(f.driver, 1, "agent-ssh-3"), namespaceId: other.id };
  assert.equal((await f.driver.ensureNamespace(other)).namespaceReady, true);
  bind(f.driver, third, other);
  assert.equal((await f.driver.prepareRevision(third)).ready, true);
  const otherDir = join(f.root, "namespaces", digest(other.id).slice(0, 12));
  assert.equal(
    (await readRecord(join(otherDir, "agents", digest(third.agentId).slice(0, 12), "agent.json")))
      .port,
    f.configured.network.gatewayPortRange.start + 2,
  );
  assert.notEqual(
    (await readRecord(join(otherDir, "agents", digest(third.agentId).slice(0, 12), "agent.json")))
      .runtimeGroup,
    (await readRecord(join(f.agentDir(second), "agent.json"))).runtimeGroup,
  );
  const exhausted = revision(f.driver, 1, "agent-ssh-4");
  bind(f.driver, exhausted);
  await assert.rejects(f.driver.prepareRevision(exhausted), /configuration/);
  assert.equal((await f.driver.deleteNamespace(tenant)).namespaceDeleted, true);
  assert.equal((await stat(otherDir)).isDirectory(), true);
  await f.driver.activateRevision(third);
  assert.equal((await f.driver.deleteNamespace(other)).namespaceDeleted, true);
});

test("SSH Agent deletion frees the Agent's host port, unit, account, and state", async (t) => {
  const f = await fixture(t);
  const { start } = f.configured.network.gatewayPortRange;
  const kept = await prepare(f);
  const deleted = await prepare(f, revision(f.driver, 1, "agent-ssh-2"));
  await prepare(f, revision(f.driver, 1, "agent-ssh-3"));
  const dir = f.agentDir(deleted);
  const { runtimeUser } = await readRecord(join(dir, "agent.json"));
  assert.ok(typeof runtimeUser === "string");
  await writeFile(join(dir, "env"), "OPERATOR_OWNED=deleted with the Agent\n", { mode: 0o600 });
  const binding = agentBinding(deleted);
  // The worker retires every revision, then deletes the Agent's durable runtime state.
  await f.driver.retireRevision(deleted);
  // An interrupted deletion leaves only the account; the retry finishes it.
  await writeFile(join(f.state, "groupdel.fail"), "once");
  await assert.rejects(f.driver.deleteAgentRuntimeCredentials(binding), /SSH host operation/);
  await missing(dir);
  await f.driver.deleteAgentRuntimeCredentials(binding);
  // The gateway process is stopped, not just its unit file removed, so its port is free.
  await missing(join(f.state, `${f.unit(deleted)}.pid`));
  await missing(join(f.units, f.unit(deleted)));
  await missing(join(f.root, "accounts", `${runtimeUser}.json`));
  await missing(join(f.state, "accounts", "users", runtimeUser));
  await missing(join(f.state, "accounts", "groups", runtimeUser));
  // Idempotent: a retried deletion with nothing left succeeds, as does an Agent never prepared.
  await f.driver.deleteAgentRuntimeCredentials(binding);
  await f.driver.deleteAgentRuntimeCredentials({
    ...binding,
    agent: { ...binding.agent, id: "agent-ssh-never", servicePrincipalId: "agent-ssh-never-p" },
  });
  assert.equal((await stat(join(f.units, f.unit(kept)))).isFile(), true);
  assert.equal((await readRecord(join(f.agentDir(kept), "agent.json"))).port, start);
  // The full range is reusable: a new Agent receives the freed port.
  const replacement = await prepare(f, revision(f.driver, 1, "agent-ssh-4"));
  assert.equal((await readRecord(join(f.agentDir(replacement), "agent.json"))).port, start + 1);
  assert.equal((await f.driver.deleteNamespace(tenant)).namespaceDeleted, true);
});
