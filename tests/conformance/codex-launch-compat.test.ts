import type { AgentRevision, ProxyPlan } from "../../packages/contracts/src/index.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import {
  launchCompute,
  launchRequirements,
  sandboxPeer,
  sandboxContext,
} from "../helpers/codex-launch-compat.ts";

const fixture: {
  revision: AgentRevision;
  cases: { node: boolean; command: string[]; args: string[] }[];
  protectedPrograms: {
    plainSha256: string;
    nodeSha256: string;
    plainArgs: string[];
    nodeArgs: string[];
  };
} = JSON.parse(
  readFileSync(new URL("../fixtures/codex-launch-before-workspace.json", import.meta.url), "utf8"),
);
const program = (args: readonly string[]) =>
  inflateRawSync(Buffer.from(args.slice(1).join(""), "base64")).toString();

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
// Independently captured from the unversioned commands at 108782a40, after the native timeout fix.
const mainCommands = {
  plain: "4f7c80a40d965b6a53c67a486484a74a03fcdea6731440e0f7fa20c4bbf1175a",
  node: "bffcc3ffde3308c2b966fffe175133bb77c02de602c4ccead5929668e5ad5135",
};
for (const sample of fixture.cases) {
  test(`stored Codex ${sample.node ? "workspace-node" : "plain"} admission retains pre-change bytes and adopts without replay`, async () => {
    const compute = launchCompute();
    const rendered = launchRequirements(compute, fixture.revision, sample.node);
    assert.equal(
      hash(JSON.stringify({ command: rendered.command, args: rendered.args })),
      sample.node ? mainCommands.node : mainCommands.plain,
    );
    const mainPeer = sandboxPeer();
    const mainContext = sandboxContext(fixture.revision, rendered.requirements);
    await mainPeer.driver().provisionHarness(mainContext);
    await mainPeer.driver().provisionHarness(mainContext);
    assert.equal(mainPeer.creates, 1);
    const peer = sandboxPeer();
    const oldContext = sandboxContext(fixture.revision, {
      ...rendered.requirements,
      command: [...sample.command, ...sample.args],
    });
    const ref = await peer.driver().provisionHarness(oldContext);
    const live = peer.sandboxes.get(ref.resourceName);
    assert.ok(live);
    const command = live.spec.command;
    assert.ok(Array.isArray(command));
    const annotations = { ...live.annotations };
    Object.assign(live, { annotations });
    const admittedCommand = JSON.stringify(command);
    await peer.driver().provisionHarness(sandboxContext(fixture.revision, rendered.requirements));
    assert.equal(peer.creates, 1);
    assert.equal(peer.sandboxes.get(ref.resourceName), live);
    assert.equal(
      JSON.stringify(live.spec.command),
      admittedCommand,
      "coordination wrapper also retains exact bytes",
    );
    const part = command.at(-1);
    assert.ok(typeof part === "string");
    command[command.length - 1] = part.slice(0, -1) + (part.endsWith("A") ? "B" : "A");
    await assert.rejects(
      peer.driver().provisionHarness(mainContext),
      /exact AgentRevision ownership and content/,
    );
    command[command.length - 1] = part;
    annotations["openclaw.dev/revision-id"] = "wrong-owner";
    await assert.rejects(
      peer.driver().provisionHarness(mainContext),
      /exact AgentRevision ownership and content/,
    );
    annotations["openclaw.dev/revision-id"] = fixture.revision.id;
    assert.equal(peer.creates, 1);
    const enrollmentPlan = plan();
    await assert.rejects(
      peer.driver().enrollHarness(
        {
          ...oldContext,
          transportToken: "synthetic-transport-token",
          revision: {
            ...fixture.revision,
            sandboxDriverId: "sandbox-compat",
            egressPlan: enrollmentPlan,
          },
        },
        {
          plan: enrollmentPlan,
          sandboxId: "wrong-sandbox-uid",
          sender: { id: "sender", generation: 1 },
          installedAt: fixture.revision.createdAt,
          enforcement: {
            instanceId: "instance",
            configurationId: "a".repeat(64),
            policyHash: "b".repeat(64),
            authorityScope: "execution",
          },
        },
        async () => assert.fail("wrong recipient must not receive release"),
      ),
      /installed Sandbox/,
    );
    const freshCandidate = {
      ...fixture.revision,
      id: "rev_00000000-0000-4000-8000-000000000010",
    };
    const fresh: AgentRevision = {
      ...freshCandidate,
      compute: { ...freshCandidate.compute, admission: admission(compute, freshCandidate) },
    };
    assert.equal(fresh.compute.admission, "codex-launch:v2:");
    const newRendered = launchRequirements(compute, fresh, sample.node);
    assert.notEqual(program(newRendered.args), program(sample.args));
    const freshContext = sandboxContext(fresh, newRendered.requirements);
    await peer.driver().provisionHarness(freshContext);
    await peer.driver().provisionHarness(freshContext);
    assert.equal(peer.creates, 2, "fresh launch created once and then adopted");
    const changedBinding = {
      ...fixture.revision,
      compute: { ...fixture.revision.compute, admission: fresh.compute.admission },
    };
    await assert.rejects(
      peer
        .driver()
        .provisionHarness(
          sandboxContext(
            changedBinding,
            launchRequirements(compute, changedBinding, sample.node).requirements,
          ),
        ),
      /exact AgentRevision ownership and content/,
    );
    assert.equal(peer.creates, 2, "a binding substitution must not replay creation");
  });
}

test("launch binding rejects unknown payloads and wrong Harness", () => {
  const compute = launchCompute();
  for (const admission of [
    "codex-launch:v2:invented",
    "codex-launch:v3:",
    "codex-launch:v2:codex-launch:v2:",
  ]) {
    assert.throws(
      () =>
        launchRequirements(compute, {
          ...fixture.revision,
          compute: { ...fixture.revision.compute, admission },
        }),
      /admission is invalid/,
    );
  }
  assert.throws(
    () =>
      compute["computeAdmission"]({
        ...fixture.revision,
        harness: { id: "openclaw", mode: "embedded", version: "1.0.0" },
        compute: { ...fixture.revision.compute, admission: "codex-launch:v2:" },
      }),
    /launch binding is invalid/,
  );
});

test("stored protected and public-reader bindings retain their semantics across launch versions", async () => {
  const compute = launchCompute();
  const protectedRevision: AgentRevision = {
    ...fixture.revision,
    executionAdmission: { version: 3, mode: "protected" },
    harnessAuth: {
      method: "credential_source",
      loginMode: "api_key",
      sourceId: "source",
      sourceType: "api-key",
      credentialGatewayId: "driver",
    },
    egressPlan: plan(true),
    compute: { ...fixture.revision.compute, admission: "protected-codex-no-connection-retry:v1" },
  };
  const old = compute["pluginRuntimeSnapshot"](
    protectedRevision,
    undefined,
    "https://127.0.0.1/v1",
  );
  assert.ok(old);
  assert.equal(
    hash(old.entrypoint),
    "ad842f41da06dee8c9e48afe2a3c45fc3d22faf75cb33d7cfc2af319b1ddb4ef",
  );
  assert.equal(
    hash(old.workspaceEntrypoint),
    "9f10d1438112b82ef3f8047f2c1a6830d4ecdfa19e2c7dd0e1446f0183b6d5b2",
  );
  for (const node of [false, true]) {
    const args = node ? fixture.protectedPrograms.nodeArgs : fixture.protectedPrograms.plainArgs;
    assert.equal(
      hash(program(args)),
      node ? fixture.protectedPrograms.nodeSha256 : fixture.protectedPrograms.plainSha256,
    );
    const requirements = launchRequirements(compute, fixture.revision, node);
    const peer = sandboxPeer();
    // The Compute snapshot above verifies the protected grant. Exercise the Sandbox
    // command comparison with its stored retry binding and synthetic transport.
    const stored = { ...fixture.revision, compute: protectedRevision.compute };
    const expected = node ? old.workspaceEntrypoint : old.entrypoint;
    const historicalContext = sandboxContext(stored, {
      ...requirements.requirements,
      command: [...requirements.command, ...args],
    });
    await peer.driver().provisionHarness(historicalContext);
    await peer.driver().provisionHarness(
      sandboxContext(stored, {
        ...requirements.requirements,
        command: [...requirements.command, ...nodeProgramArguments(expected)],
      }),
    );
    assert.equal(peer.creates, 1);
    await assert.rejects(
      peer.driver().provisionHarness(sandboxContext(stored, requirements.requirements)),
      /exact AgentRevision ownership and content/,
    );
  }
  const next: AgentRevision = {
    ...protectedRevision,
    compute: { ...protectedRevision.compute, admission: admission(compute, protectedRevision) },
  };
  assert.equal(next.compute.admission, "codex-launch:v2:protected-codex-no-connection-retry:v1");
  const current = compute["pluginRuntimeSnapshot"](next, undefined, "https://127.0.0.1/v1");
  assert.ok(current);
  assert.notEqual(current.entrypoint, old.entrypoint);
  const { egressPlan: _egressPlan, ...unprotectedRevision } = next;
  assert.throws(
    () =>
      compute["pluginRuntimeSnapshot"]({
        ...unprotectedRevision,
        executionAdmission: { version: 2, mode: "unprotected" },
      }),
    /admission is invalid/,
  );
  assert.equal(protectedRevision.harnessAuth.method, "credential_source");
  const workspace: AgentRevision = {
    ...protectedRevision,
    harnessAuth: {
      ...protectedRevision.harnessAuth,
      loginMode: "codex_pat",
      sourceType: "codex-pat",
    },
    egressPlan: plan(true, true),
  };
  assert.throws(
    () => compute["pluginRuntimeSnapshot"](workspace),
    /requires its Compute launch binding/,
  );
  const workspaceLaunch = compute["pluginRuntimeSnapshot"]({
    ...workspace,
    compute: { ...workspace.compute, admission: admission(compute, workspace) },
  });
  assert.ok(workspaceLaunch);
  assert.equal(workspaceLaunch.runtime.nativePat, true);
  assert.equal(workspaceLaunch.entrypoint, current.entrypoint);
  assert.equal(workspaceLaunch.workspaceEntrypoint, current.workspaceEntrypoint);
  const reader = { address: "127.0.0.1", namespace: "reader", podLabels: { app: "reader" } };
  assert.ok(compute["options"].network);
  compute["options"].network.publicGithubRead = reader;
  const binding =
    "public-github-read:v1:" +
    hash(JSON.stringify([reader.address, reader.namespace, Object.entries(reader.podLabels)]));
  const { sandboxDriverId: _sandboxDriverId, ...readerRevision } = fixture.revision;
  const reading: AgentRevision = {
    ...readerRevision,
    configuration: {
      ...fixture.revision.configuration,
      plugins: {
        entries: {
          codex: {
            config: {
              appServer: { networkProxy: { enabled: true, domains: { "127.0.0.1": "allow" } } },
            },
          },
        },
      },
    },
    compute: { ...fixture.revision.compute, admission: binding },
  };
  assert.ok(compute["publicGithubReadForRevision"](reading));
  const admittedReading: AgentRevision = {
    ...reading,
    compute: { ...reading.compute, admission: admission(compute, reading) },
  };
  assert.equal(admittedReading.compute.admission, "codex-launch:v2:" + binding);
  assert.ok(compute["publicGithubReadForRevision"](admittedReading));
  compute["options"].network.publicGithubRead = { ...reader, address: "127.0.0.2" };
  assert.equal(
    compute["publicGithubReadForRevision"](admittedReading),
    undefined,
    "changed reader does not inherit the stored grant",
  );
});

function plan(withRoute = false, workspace = false): ProxyPlan {
  const revision = fixture.revision;
  const execution = {
    installationId: "installation",
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    servicePrincipalId: revision.servicePrincipalId,
    revisionId: revision.id,
    executionId: "execution",
  };
  const ref = { id: "route", generation: 1 };
  return {
    id: "plan",
    generation: 1,
    driver: { id: "driver", implementation: "synthetic", configurationId: "a".repeat(64) },
    sandboxDriverId: "sandbox-compat",
    egressDriverId: "driver",
    execution,
    routes: withRoute
      ? [
          {
            route: ref,
            origin: "https://127.0.0.1",
            path: "/v1",
            method: "POST",
            operationPolicy: ref,
            responsePolicy: ref,
            deadlineMs: 1000,
            binding: {
              binding: ref,
              execution,
              source: {
                installationId: "installation",
                namespaceId: revision.namespaceId,
                source: { id: "source", generation: 1 },
                backend: ref,
                provider: ref,
              },
              grant: workspace
                ? {
                    kind: "workspace_inference",
                    models: [],
                    providerTools: "none",
                    workspaceId: "workspace",
                  }
                : { kind: "inference", models: [], providerTools: "none" },
              grantHash: "a".repeat(64),
              isolationId: "isolation",
            },
          },
        ]
      : [],
  };
}

function admission(compute: ReturnType<typeof launchCompute>, revision: AgentRevision): string {
  const value = compute.admitRevision(revision);
  assert.ok(value);
  return value;
}
