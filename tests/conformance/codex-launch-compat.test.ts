import type { AgentRevision, ProxyPlan } from "../../packages/contracts/src/index.ts";
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
  protectedPrograms: { plainSha256: string; nodeSha256: string };
} = JSON.parse(
  readFileSync(new URL("../fixtures/codex-launch-before-workspace.json", import.meta.url), "utf8"),
);
const program = (args: readonly string[]) =>
  inflateRawSync(Buffer.from(args.slice(1).join(""), "base64")).toString();

function innerProgram(args: readonly string[], node: boolean) {
  const outer = program(args);
  if (!node) {
    return outer;
  }
  const encoded = /name: "Codex",\n {4}args: (\[.*\]),/.exec(outer);
  assert.ok(encoded?.[1], "workspace supervisor contains the Codex invocation");
  return program(JSON.parse(encoded[1]).slice(1));
}

for (const sample of fixture.cases) {
  test(`stored Codex ${sample.node ? "workspace-node" : "plain"} admission retains pre-change bytes and adopts without replay`, async () => {
    const compute = launchCompute();
    const rendered = launchRequirements(compute, fixture.revision, sample.node);
    assert.equal(
      JSON.stringify({ command: rendered.command, args: rendered.args }),
      JSON.stringify({ command: sample.command, args: sample.args }),
    );
    assert.equal(program(rendered.args), program(sample.args));
    assert.equal(innerProgram(rendered.args, sample.node), innerProgram(sample.args, sample.node));
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
    command.push("substituted");
    await assert.rejects(
      peer.driver().provisionHarness(oldContext),
      /exact AgentRevision ownership and content/,
    );
    command.pop();
    annotations["openclaw.dev/revision-id"] = "wrong-owner";
    await assert.rejects(
      peer.driver().provisionHarness(oldContext),
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

test("stored protected and public-reader bindings retain their semantics across launch versions", () => {
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
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  assert.ok(old);
  assert.equal(hash(old.entrypoint), fixture.protectedPrograms.plainSha256);
  assert.equal(hash(old.workspaceEntrypoint), fixture.protectedPrograms.nodeSha256);
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
