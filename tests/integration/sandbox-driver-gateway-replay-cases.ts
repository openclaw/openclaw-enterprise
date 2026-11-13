import assert from "node:assert/strict";
import {
  OpenShellRequestReplayRefusedError,
  OpenShellSandboxAlreadyExistsError,
  type OpenShellGatewayClient,
  type OpenShellSandboxCreateRequest,
  type OpenShellSandboxResponse,
  type OpenShellServiceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { AgentRevision, SandboxResourceRef } from "../../packages/contracts/src/index.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type GatewayMethods = Pick<OpenShellGatewayClient, "getSandbox" | "getService" | "createSandbox">;
type ReplayGateway = Omit<ReturnType<typeof workspaceGatewayClient>, keyof GatewayMethods> &
  GatewayMethods;
type ReplayState = {
  handlerError: Error | undefined;
  refuseEverything: string | undefined;
  onRefusal: ((request: OpenShellSandboxCreateRequest) => void) | undefined;
  holdHandler: Promise<void> | undefined;
  reachedHold: (() => void) | undefined;
};
type Provision = (target?: OpenShellSandboxDriver) => Promise<SandboxResourceRef>;

export async function verifySandboxAdoptionRefusals({
  sandboxes,
  services,
  name,
  revision,
  provision,
}: {
  sandboxes: Map<string, OpenShellSandboxResponse>;
  services: Pick<Map<string, string>, "delete">;
  name: string;
  revision: Pick<AgentRevision, "id">;
  provision: () => Promise<SandboxResourceRef>;
}) {
  const existing = () => {
    const sandbox = sandboxes.get(name);
    assert.ok(sandbox);
    return sandbox;
  };
  sandboxes.set(name, {
    ...existing(),
    annotations: { ...existing().annotations, "openclaw.dev/revision-id": "rev_other" },
  });
  await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
  sandboxes.set(name, {
    ...existing(),
    annotations: { ...existing().annotations, "openclaw.dev/revision-id": revision.id },
  });
  // A Sandbox on its way out is never adopted as this revision's Harness.
  for (const [phase, message] of [
    ["SANDBOX_PHASE_DELETING", /is being deleted; it can be created again once deletion finishes/],
    ["SANDBOX_PHASE_STOPPED", /has stopped; remove the stale Sandbox/],
    ["SANDBOX_PHASE_COMPLETED", /has stopped; remove the stale Sandbox/],
  ] as const) {
    sandboxes.set(name, { ...existing(), phase });
    await assert.rejects(provision(), message);
  }
  sandboxes.set(name, { ...existing(), phase: "SANDBOX_PHASE_READY" });
  services.delete(name);
  await assert.rejects(provision(), /exists without its exact bearer-passthrough Harness service/);
}

export async function prepareGatewayReplayFixture({
  openShellDriver,
  prepareProvision,
  harnessService,
  storedSandbox,
}: {
  openShellDriver: (gatewayClient: ReplayGateway) => OpenShellSandboxDriver;
  prepareProvision: (driver: OpenShellSandboxDriver) => Provision;
  harnessService: (
    sandbox: string,
    name: string,
    url: string | undefined,
  ) => OpenShellServiceResponse | undefined;
  storedSandbox: (
    request: OpenShellSandboxCreateRequest,
    fields: Pick<OpenShellSandboxResponse, "id">,
  ) => OpenShellSandboxResponse;
}) {
  const replayState: ReplayState = {
    handlerError: undefined,
    refuseEverything: undefined,
    onRefusal: undefined,
    holdHandler: undefined,
    reachedHold: undefined,
  };
  const gatewayClient: ReplayGateway = workspaceGatewayClient();
  const sandboxes = new Map<string, OpenShellSandboxResponse>();
  const admissions = new Map<string, { payload: string; sandboxId?: string }>();
  const calls: [string, string?][] = [];
  let nextId = 0;
  const refused = (reason: string) => new OpenShellRequestReplayRefusedError(reason, reason);
  gatewayClient.getSandbox = async ({ name }) => {
    calls.push(["getSandbox"]);
    return sandboxes.get(name);
  };
  gatewayClient.getService = async (_workspace, sandbox, service) => {
    calls.push(["getService"]);
    return harnessService(sandbox, service, sandboxes.get(sandbox)?.serviceUrls[""]);
  };
  gatewayClient.createSandbox = async (request) => {
    calls.push(["createSandbox", request.requestId]);
    const payload = JSON.stringify({ ...request, requestId: undefined });
    const admitted = admissions.get(request.requestId);
    let refusal: OpenShellRequestReplayRefusedError | undefined;
    if (replayState.refuseEverything !== undefined) {
      refusal = refused(replayState.refuseEverything);
    } else if (admitted !== undefined) {
      if (admitted.payload !== payload) {
        refusal = refused("REQUEST_ID_PAYLOAD_MISMATCH");
      } else if (admitted.sandboxId === undefined) {
        refusal = refused("REQUEST_OUTCOME_UNCERTAIN");
      } else if (sandboxes.get(request.name)?.id !== admitted.sandboxId) {
        refusal = refused("REQUEST_REPLAY_UNAVAILABLE");
      } else {
        const replayed = sandboxes.get(request.name);
        assert.ok(replayed);
        return replayed;
      }
    }
    if (refusal !== undefined) {
      replayState.onRefusal?.(request);
      replayState.onRefusal = undefined;
      throw refusal;
    }
    const admission: { payload: string; sandboxId?: string } = { payload };
    admissions.set(request.requestId, admission);
    if (replayState.handlerError !== undefined) {
      const error = replayState.handlerError;
      replayState.handlerError = undefined;
      throw error;
    }
    if (replayState.holdHandler !== undefined) {
      const held = replayState.holdHandler;
      replayState.holdHandler = undefined;
      assert.ok(replayState.reachedHold);
      replayState.reachedHold();
      await held;
    }
    // OpenShell keeps Sandbox names unique per Workspace.
    if (sandboxes.has(request.name)) {
      throw new OpenShellSandboxAlreadyExistsError(request.name);
    }
    const sandbox = storedSandbox(request, { id: `sandbox-${nextId++}` });
    sandboxes.set(request.name, sandbox);
    assert.ok(sandbox.id);
    admission.sandboxId = sandbox.id;
    return sandbox;
  };
  const provision = prepareProvision(openShellDriver(gatewayClient));
  const trace = () => {
    const seen = calls.map(([call, id]) => (id === undefined ? call : `${call}:${id}`));
    calls.length = 0;
    return seen;
  };
  const id0 = "00000000-0000-4000-8000-000000000004";
  return { gatewayClient, sandboxes, provision, trace, id0, replayState };
}

export async function verifyFreshRequestAfterRefusal({
  sandboxes,
  provision,
  trace,
  id0,
  replayState,
}: Awaited<ReturnType<typeof prepareGatewayReplayFixture>>) {
  // A create that errors server-side leaves its request_id unresolved.
  replayState.handlerError = new Error("provider 'model' not found");
  await assert.rejects(provision(), /provider 'model' not found/);
  assert.deepEqual(trace(), ["getSandbox", `createSandbox:${id0}`]);

  // The next pass sees the refusal and no Sandbox, then creates with the next request_id.
  const first = await provision();
  const [, refusedCreate, , freshCreate] = trace();
  assert.equal(refusedCreate, `createSandbox:${id0}`);
  assert.ok(freshCreate);
  const id1 = freshCreate.slice("createSandbox:".length);
  assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id1, id0);
  assert.equal(sandboxes.size, 1);

  // Each failing pass spends at most one new request_id.
  sandboxes.clear();
  replayState.handlerError = new Error("compute driver unavailable");
  await assert.rejects(provision(), /compute driver unavailable/);
  const failed = trace();
  assert.deepEqual(failed.slice(0, 4), [
    "getSandbox",
    `createSandbox:${id0}`,
    "getSandbox",
    `createSandbox:${id1}`,
  ]);
  assert.equal(failed.length, 6);
  const failedCreate = failed[5];
  assert.ok(failedCreate);
  const id2 = failedCreate.slice("createSandbox:".length);
  return { first, id1, id2 };
}

export async function verifyConcurrentReplayAndExhaustion({
  sandboxes,
  provision,
  trace,
  first,
  replayState,
}: {
  sandboxes: Map<string, OpenShellSandboxResponse>;
  provision: Provision;
  trace: () => string[];
  first: SandboxResourceRef;
  replayState: ReplayState;
}) {
  sandboxes.clear();
  let release: (() => void) | undefined;
  replayState.holdHandler = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    replayState.reachedHold = resolve;
  });
  const held = provision();
  // Wait for the first pass to take the hold, or to end without reaching it.
  await Promise.race([reached, held]);
  assert.equal(replayState.holdHandler, undefined, "the first pass never reached CreateSandbox");
  assert.deepEqual(await provision(), first);
  assert.ok(release);
  release();
  assert.deepEqual(await held, first);
  assert.equal(sandboxes.size, 1);
  const creates = trace().filter((call) => call.startsWith("createSandbox"));
  // The held pass walks to request_id X; the other walks the same IDs, is refused X, and
  // creates under the next one, Y.
  const walked = (creates.length - 1) / 2;
  assert.deepEqual(creates.slice(walked, -1), creates.slice(0, walked));
  assert.equal(new Set(creates).size, walked + 1);

  // The request_ids are bounded; exhausting them never creates a Sandbox.
  sandboxes.clear();
  replayState.refuseEverything = "REQUEST_OUTCOME_UNCERTAIN";
  await assert.rejects(provision(), /refused all 16 create request IDs .*deploy a new revision/);
  const exhausted = trace().filter((call) => call.startsWith("createSandbox"));
  assert.equal(exhausted.length, 16);
  assert.equal(new Set(exhausted).size, 16);
  assert.equal(sandboxes.size, 0);
  // Every ID refused as unreplayable also points at the gateway's key material.
  replayState.refuseEverything = "REQUEST_REPLAY_UNAVAILABLE";
  await assert.rejects(provision(), /refused all 16 .*key material is readable/);
  assert.equal(sandboxes.size, 0);
}
