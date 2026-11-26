import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import type { TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createOpenAiStaticProvider } from "../../apps/controller/src/drivers/egress-proxy/openai-provider.ts";
import {
  egressAssociationInstallation,
  type AcceptedEgressAssociation,
  type EgressExecution,
  type EgressInstallation,
  type EgressPeer,
  type EgressRequest,
  type EgressResolution,
  type EgressRoute,
  type StaticEgressSource,
} from "../../packages/contracts/src/index.ts";
import {
  CredentialProxy,
  type CredentialProxyCapacity,
  type EgressAuthorityPorts,
} from "../../packages/occ/src/credential-proxy.ts";
import type {
  EgressSendReceipts,
  SendAttempt,
} from "../../packages/occ/src/egress-send-receipts.ts";
import { listen } from "./listen.ts";
import { requestId } from "./static-egress-request-id.ts";

type DispatchReceipts = Pick<EgressSendReceipts, "begin" | "record" | "observe" | "authorize">;
type DispatchPorts = EgressAuthorityPorts & { readonly receipts: DispatchReceipts };

function unavailableReceiptStore(): never {
  throw new Error("This fixture has no send receipt store.");
}

/** Explicit trusted acceptance profile for dispatch tests only. The captured owner
 * holds the actual sender and reply recipient; no bearer or header establishes custody. */
export async function syntheticDispatchFixture(t: TestContext, receipts?: DispatchReceipts) {
  const openAiStaticProvider = createOpenAiStaticProvider();
  const ref = () => ({ id: randomUUID(), generation: 1 });
  const now = Date.now();
  const deadlineAt = new Date(now + 25_000).toISOString();
  const execution: EgressExecution = {
    installationId: randomUUID(),
    namespaceId: randomUUID(),
    agentId: randomUUID(),
    servicePrincipalId: randomUUID(),
    revisionId: randomUUID(),
    executionId: randomUUID(),
  };
  const sender = ref();
  const peer = { sender, sandboxId: randomUUID(), instanceId: randomUUID(), expiresAt: deadlineAt };
  const source: StaticEgressSource = {
    key: {
      installationId: execution.installationId,
      namespaceId: execution.namespaceId,
      source: ref(),
      backend: ref(),
      provider: ref(),
    },
    schemaVersion: 1,
    adoption: "live",
    materialRefId: randomUUID(),
    secret: { kind: "secret", namespaceId: execution.namespaceId, id: randomUUID() },
    secretDriver: ref(),
    sender,
    resolver: ref(),
    retention: "none",
  };
  const route: EgressRoute = {
    route: ref(),
    binding: {
      binding: ref(),
      execution,
      source: source.key,
      grant: { kind: "inference", models: ["fixture-model"], providerTools: "none" },
      grantHash: "synthetic",
      isolationId: randomUUID(),
    },
    origin: "https://provider.example.test",
    path: "/v1/responses",
    method: "POST",
    operationPolicy: ref(),
    responsePolicy: ref(),
    deadlineMs: 30_000,
  };
  const policyHash = "fb".repeat(32);
  const installation: EgressInstallation = {
    sender,
    sandboxId: peer.sandboxId,
    installedAt: new Date(now).toISOString(),
    enforcement: {
      instanceId: peer.instanceId,
      configurationId: randomUUID(),
      policyHash,
      authorityScope: "execution",
    },
    plan: {
      ...ref(),
      execution,
      sandboxDriverId: "synthetic",
      egressDriverId: sender.id,
      routes: [route],
    },
  };
  const request = {
    id: requestId(now),
    method: "POST",
    url: route.origin + route.path,
    verifiedExecutionPolicyHash: policyHash,
    headers: [["content-type", "application/json"]],
    body: Buffer.from(JSON.stringify({ model: "fixture-model", input: "hello", store: false })),
    deadlineAt,
  } satisfies EgressRequest;
  const custody = { id: randomUUID(), reply: { id: randomUUID(), chunks: new Array<Buffer>() } };
  const association: AcceptedEgressAssociation = {
    execution,
    installation: {
      sandboxId: peer.sandboxId,
      ...installation.enforcement,
      plan: { id: installation.plan.id, generation: installation.plan.generation },
    },
    exchangeId: randomUUID(),
    responseId: custody.reply.id,
    custodyId: custody.id,
  };
  let reads = 0;
  let arrivals = 0;
  let permits = 0;
  let current = true;
  let clock = now;
  let ready: EgressResolution | undefined;
  const lifecycle = new AbortController();
  t.after(() => lifecycle.abort());
  // Count the first bytes on each connection before parsing any application data.
  const origin = createServer((socket) =>
    socket.once("data", () => {
      arrivals++;
      socket.end("synthetic response");
    }),
  );
  const originPort = await listen(t, origin);
  const exchangeOwner: EgressAuthorityPorts["exchangeOwner"] = {
    verify: async () => peer,
    capture(use) {
      return current && use.request.id === request.id ? association : undefined;
    },
    owns(value, use) {
      return (
        current &&
        JSON.stringify(value) === JSON.stringify(association) &&
        use.request.id === request.id &&
        Buffer.from(use.request.body).equals(request.body)
      );
    },
  };
  const ports: DispatchPorts = {
    exchangeOwner,
    // Resolve-only fixtures have no receipt store. A dispatch attempt must fail closed.
    receipts: receipts ?? {
      begin: unavailableReceiptStore,
      authorize: unavailableReceiptStore,
      record: unavailableReceiptStore,
      observe: unavailableReceiptStore,
    },
    now: () => clock,
    installation: async () => installation,
    provider: () => openAiStaticProvider,
    // Synthetic policy is immutable; real OCC uses its policy-and-receipt transaction.
    async authorizeSend(this: DispatchPorts, use, selected, attempt, mintAuthorization) {
      const decision = await this.check(use, attempt.material ?? undefined);
      if (!("key" in decision)) {
        return decision;
      }
      if (!isDeepStrictEqual(decision, selected)) {
        return { kind: "denied", code: "stale_configuration" };
      }
      const authorization = mintAuthorization();
      if ("kind" in authorization) {
        return authorization;
      }
      return this.receipts.authorize(use.peer.sender, attempt, authorization);
    },
    // Policy and Secret dependencies are synthetic; dispatch, persistence and sockets are real.
    check: async () => source,
    read: async () => {
      reads++;
      return {
        value: "synthetic-material",
        version: "N",
        materialId: "synthetic-material-id",
        authoritativeObservedAt: new Date(now).toISOString(),
      };
    },
  };
  let forwarder = new CredentialProxy(ports);
  const authorizeSend = (signal = lifecycle.signal) => {
    assert.equal(ready?.kind, "ready");
    return forwarder.authorizeSend(
      "synthetic-peer",
      peer.sandboxId,
      request.id,
      ready.handle,
      ready.evidence,
      ready.injectionDigest,
      request.deadlineAt,
      signal,
    );
  };
  return {
    startedAt: new Date(now).toISOString(),
    get reads() {
      return reads;
    },
    request,
    association,
    sender,
    ports,
    get arrivals() {
      return arrivals;
    },
    get permits() {
      return permits;
    },
    advance(ms: number) {
      clock += ms;
    },
    replaceCustody() {
      current = false;
    },
    restart() {
      forwarder = new CredentialProxy(ports);
    },
    /**
     * One proxy shared by several Sandboxes of this sender, each with its own enrolled
     * installation and a long-lived peer. `wrap` may replace any of its ports, and `capacity`
     * sets the proxy's request-time bounds (defaults otherwise). `resolve(name, fields)` authenticates as the
     * named Sandbox with a fresh UUIDv7 request ID and deadline unless `fields` sets them.
     */
    sandboxes(
      wrap: (ports: DispatchPorts) => DispatchPorts = (ports) => ports,
      capacity?: Partial<CredentialProxyCapacity>,
    ) {
      const enrolled = new Map<string, { peer: EgressPeer; installation: EgressInstallation }>();
      const accepted = new Set<string>();
      const enroll = (name: string) => {
        const existing = enrolled.get(name);
        if (existing) {
          return existing;
        }
        const sandboxPeer: EgressPeer = {
          sender,
          sandboxId: randomUUID(),
          instanceId: randomUUID(),
          expiresAt: new Date(now + 3_600_000).toISOString(),
        };
        const sandbox = {
          peer: sandboxPeer,
          installation: {
            ...installation,
            sandboxId: sandboxPeer.sandboxId,
            enforcement: { ...installation.enforcement, instanceId: sandboxPeer.instanceId },
          },
        };
        enrolled.set(name, sandbox);
        return sandbox;
      };
      const proxy = new CredentialProxy(
        wrap({
          ...ports,
          exchangeOwner: {
            verify: async (name) => enroll(name).peer,
            capture(use) {
              accepted.add(use.id);
              return {
                ...association,
                installation: egressAssociationInstallation(use.installation),
                responseId: use.id,
              };
            },
            owns: (value, use) => accepted.has(use.id) && value.responseId === use.id,
          },
          installation: async (sandboxPeer) =>
            [...enrolled.values()].find((entry) => entry.peer.sandboxId === sandboxPeer.sandboxId)
              ?.installation,
        }),
        capacity,
      );
      const build = (fields: Partial<EgressRequest> = {}) => ({
        ...request,
        id: requestId(clock),
        deadlineAt: new Date(clock + 20_000).toISOString(),
        ...fields,
      });
      return {
        proxy,
        request: build,
        resolve: (name: string, fields?: Partial<EgressRequest>, signal = lifecycle.signal) =>
          proxy.resolve(name, enroll(name).peer.sandboxId, build(fields), signal),
      };
    },
    async resolve() {
      ready = await forwarder.resolve("synthetic-peer", peer.sandboxId, request, lifecycle.signal);
      return ready;
    },
    authorizeSend,
    async dispatch(signal?: AbortSignal) {
      const decision = await authorizeSend(signal);
      if (decision.kind !== "allow") {
        return decision;
      }
      permits++;
      // The real sender retains this accepted operation and destination. A permit for
      // any other operation/custody or an expired permit cannot reach the socket.
      assert.deepEqual(decision.authorization.association, association);
      assert.equal(ready?.kind, "ready");
      assert.equal(decision.injectionDigest, ready.injectionDigest);
      assert.equal(
        decision.authorization.requestDigest,
        createHash("sha256")
          .update(JSON.stringify({ ...request, body: request.body.toString("base64") }))
          .digest("hex"),
      );
      assert.ok(current && clock < Date.parse(decision.sendStartBy));
      const socket = connect(originPort, "127.0.0.1");
      socket.on("data", (bytes) => custody.reply.chunks.push(Buffer.from(bytes)));
      try {
        await once(socket, "connect");
        assert.ok(current && clock < Date.parse(decision.sendStartBy));
        socket.end(request.body);
        await once(socket, "close");
      } finally {
        socket.destroy();
      }
      assert.equal(Buffer.concat(custody.reply.chunks).toString(), "synthetic response");
      return decision;
    },
    attempt(): SendAttempt {
      assert.equal(ready?.kind, "ready");
      return {
        sender,
        instanceId: peer.instanceId,
        useId: request.id,
        attemptId: request.id,
        material: ready.evidence,
        deadlineAt,
      };
    },
  };
}
