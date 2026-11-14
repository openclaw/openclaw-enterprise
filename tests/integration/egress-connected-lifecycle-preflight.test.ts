import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openShellExchangeCapabilities as capabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { safeConnectedFailure } from "../helpers/egress-connected-failure.mjs";
import {
  observeControllerUpgrade,
  prepareControllerUpgrade,
} from "../helpers/egress-controller-upgrade.mjs";
import { createRunEvidence } from "../helpers/egress-installed-stack.mjs";
import { requireSupervisorReconnect } from "../helpers/egress-supervisor-reconnect.mjs";
import {
  acceptedSupervisorSessions,
  supervisorSessionLifecycle,
  type ObservedSession,
} from "../helpers/egress-supervisor-sessions.ts";
import { listen } from "../helpers/listen.mjs";

type ControllerProcess = {
  name: string;
  uid: string;
  containerID: string;
  imageID: string;
  startedAt: string;
  configurationSha256: string;
  installationSha256: string;
};

type PrivateCheckpoint =
  | {
      phase: "reconnect-wait-start";
      supervisor: { containerId: string };
      harness: { image: string };
      supplierProcesses: { podUid: string }[];
      sandboxId: string;
    }
  | { phase: "reconnect-before-policy"; instanceId: string }
  | { phase: "reconnect-baseline"; sessions: ObservedSession[]; baselineAt: string }
  | { phase: "reconnect-accepted"; reconnect: ObservedSession; logThrough: string }
  | { phase: "reconnect-after-policy"; loaded?: false }
  | { phase: "reconnect-before-turn"; deploymentId: string; deploymentReady: boolean }
  | {
      phase: "controller-upgrade-ready";
      controllers: ControllerProcess[];
      fromCommit: string;
      toCommit: string;
      fromImage: string;
      toImage: string;
      retainedStateSha256: string;
    }
  | { phase: "controller-upgrade-observed"; controllers: ControllerProcess[] };

function readDiagnostic(line: string): Record<string, unknown> {
  const details: unknown = JSON.parse(line.slice(line.indexOf("{")));
  assert.ok(typeof details === "object" && details !== null && !Array.isArray(details));
  return details as Record<string, unknown>;
}

type LedgerCheckpoint = { phase: string; [field: string]: unknown };

function isLedgerCheckpoint(value: unknown): value is LedgerCheckpoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "phase" in value &&
    typeof value.phase === "string"
  );
}

async function readPrivatePhases(directory: string): Promise<LedgerCheckpoint[]> {
  const parsed: unknown = JSON.parse(await readFile(`${directory}/observations.json`, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null && "phases" in parsed);
  const phases = parsed.phases;
  assert.ok(Array.isArray(phases) && phases.every(isLedgerCheckpoint));
  return phases;
}

function requirePhase<Phase extends PrivateCheckpoint["phase"]>(
  phases: LedgerCheckpoint[],
  name: Phase,
): Extract<PrivateCheckpoint, { phase: Phase }> {
  const phase = phases.find(
    (entry): entry is Extract<PrivateCheckpoint, { phase: Phase }> => entry.phase === name,
  );
  assert.ok(phase, `missing private checkpoint ${name}`);
  return phase;
}

// These log-shape controls test the observer, not supplier authentication or a
// live reconnect. UUIDs and lines are synthetic; the real lane supplies evidence.
test("reconnect observer counts accepted sessions once and preserves uint64 epochs", async () => {
  const sandboxId = "10000000-0000-4000-8000-000000000001";
  const instanceId = "20000000-0000-4000-8000-000000000001";
  const first = "30000000-0000-4000-8000-000000000001";
  const second = "30000000-0000-4000-8000-000000000002";
  const line = (session: string, epoch: string) =>
    `2026-01-01T00:00:00.000Z 2026-01-01T00:00:00Z  INFO openshell_server::supervisor_session: supervisor session: accepted sandbox_id=${sandboxId} session_id=${session} instance_id=${instanceId} connection_epoch=${epoch} replica_id=gateway-0 config_push=false`;
  const accepted = line(first, "9007199254740992");
  const ansi = accepted.replace("INFO", "\u001b[32mINFO\u001b[0m");
  const next = line(second, "9007199254740993");
  const sessions = acceptedSupervisorSessions(
    [
      accepted,
      ansi,
      next,
      accepted.replace("session: accepted", "session: failed"),
      accepted.replace("openshell_server::supervisor_session:", "untrusted::logger:"),
      accepted.replace(`sandbox_id=${sandboxId}`, "sandbox_id=foreign"),
    ].join("\n"),
    sandboxId,
    instanceId,
  );
  assert.deepEqual(sessions, [
    { sessionId: first, epoch: "9007199254740992", at: "2026-01-01T00:00:00.000Z" },
    { sessionId: second, epoch: "9007199254740993", at: "2026-01-01T00:00:00.000Z" },
  ]);
  const maxEpoch = "18446744073709551615";
  assert.equal(
    acceptedSupervisorSessions(line(first, maxEpoch), sandboxId, instanceId)[0]?.epoch,
    maxEpoch,
  );
  for (const invalid of ["0", "01", "18446744073709551616"]) {
    assert.throws(() => acceptedSupervisorSessions(line(first, invalid), sandboxId, instanceId), {
      code: "ERR_ASSERTION",
    });
  }
  assert.throws(
    () =>
      acceptedSupervisorSessions(
        accepted.replace(`instance_id=${instanceId}`, "instance_id=other"),
        sandboxId,
        instanceId,
      ),
    { name: "AssertionError", message: /accepted supervisor instance changed/ },
  );
  // A real observer failure must retain its source location without copying
  // the rejected supplier field into terminal diagnostics.
  let failure: unknown;
  const privateField = "PRIVATE-OBSERVATION-SENTINEL";
  assert.throws(
    () =>
      acceptedSupervisorSessions(
        accepted.replace(`instance_id=${instanceId}`, `instance_id=${privateField}`),
        sandboxId,
        instanceId,
      ),
    (error) => {
      failure = error;
      return error instanceof assert.AssertionError && error.code === "ERR_ASSERTION";
    },
  );
  const safe = await safeConnectedFailure(failure, "reconnect-before-policy");
  assert.match(safe.message, /\(egress-supervisor-sessions\.ts:\d+:\d+\)/);
  assert.equal(safe.message.includes(privateField), false);
  assert.throws(
    () =>
      acceptedSupervisorSessions(
        [accepted, line(first, "9007199254740993")].join("\n"),
        sandboxId,
        instanceId,
      ),
    { name: "AssertionError", message: /conflicting accepted session event/ },
  );
  const closed = `2026-01-01T00:00:01.000Z 2026-01-01T00:00:01Z  INFO openshell_server::supervisor_session: supervisor session: stream closed by supervisor sandbox_id=${sandboxId} session_id=${first}`;
  const ended = closed.replace("stream closed by supervisor", "ended");
  const gatewayClosed = closed.replace(
    "stream closed by supervisor",
    "superseded or closed by the gateway, shutting down",
  );
  const lifecycleLines = [accepted, closed, ansi, gatewayClosed, next, ended];
  assert.deepEqual(supervisorSessionLifecycle(lifecycleLines.join("\n"), sandboxId, instanceId), {
    total: 6,
    truncated: false,
    events: [
      {
        sessionId: first,
        epoch: "9007199254740992",
        at: "2026-01-01T00:00:00.000Z",
        event: "accepted",
      },
      { sessionId: first, at: "2026-01-01T00:00:01.000Z", event: "inbound_eof" },
      {
        sessionId: first,
        epoch: "9007199254740992",
        at: "2026-01-01T00:00:00.000Z",
        event: "accepted",
      },
      { sessionId: first, at: "2026-01-01T00:00:01.000Z", event: "gateway_closed" },
      {
        sessionId: second,
        epoch: "9007199254740993",
        at: "2026-01-01T00:00:00.000Z",
        event: "accepted",
      },
      { sessionId: first, at: "2026-01-01T00:00:01.000Z", event: "ended" },
    ],
  });
  assert.deepEqual(
    supervisorSessionLifecycle(
      closed.replace("openshell_server::", "untrusted::"),
      sandboxId,
      instanceId,
    ).events,
    [],
  );
  assert.throws(
    () =>
      supervisorSessionLifecycle(closed.replace(first, "unchecked-secret"), sandboxId, instanceId),
    { code: "ERR_ASSERTION" },
  );
  // A distinct head record exposes an incorrect first-nine slice. Repeated
  // endings must still contribute to the full count.
  const endings = Array.from({ length: 8 }, () => ended);
  const bounded = supervisorSessionLifecycle(
    [accepted, closed, ...endings, gatewayClosed].join("\n"),
    sandboxId,
    instanceId,
  );
  assert.deepEqual(bounded, {
    total: 11,
    truncated: true,
    events: [
      ...endings.map(() => ({ sessionId: first, at: "2026-01-01T00:00:01.000Z", event: "ended" })),
      { sessionId: first, at: "2026-01-01T00:00:01.000Z", event: "gateway_closed" },
    ],
  });
});
test(
  "reconnect checkpoints keep correlation in the private ledger on success and failure",
  { concurrency: false },
  async (t) => {
    for (const failFinalReadiness of [false, true]) {
      await t.test(
        failFinalReadiness ? "failed final readiness" : "successful reconnect",
        async (t) => {
          const sandboxId = "10000000-0000-4000-8000-000000000001";
          const instanceId = "20000000-0000-4000-8000-000000000001";
          const first = "30000000-0000-4000-8000-000000000001";
          const second = "30000000-0000-4000-8000-000000000002";
          const agent = { id: "private-agent-id", servicePrincipalId: "private-principal-id" };
          const revision = { id: "private-revision-id" };
          const namespace = { id: "private-namespace-id" };
          const placement = "private-placement";
          const image = (name: string) =>
            `registry.example/private-${name}@sha256:${"b".repeat(64)}`;
          const images = {
            supervisor: image("supervisor"),
            agent: image("agent"),
            openShellGateway: image("openShellGateway"),
          };
          const pod = (name: string, image: string) => ({
            metadata: {
              name,
              uid: `private-${name}-uid`,
              namespace: placement,
              labels: {
                "openshell.ai/sandbox-id": sandboxId,
                "openshell.ai/boundary-role": "supervisor",
              },
            },
            spec: { containers: [{ name: `private-${name}-container`, image }] },
            status: {
              containerStatuses: [
                {
                  name: `private-${name}-container`,
                  ready: true,
                  containerID: `containerd://private-${name}`,
                  imageID: `private-${name}-image-id`,
                  restartCount: 0,
                  state: { running: { startedAt: "2026-01-01T01:02:03Z" } },
                },
              ] as const,
            },
          });
          const supervisor = pod("supervisor", images.supervisor);
          const harness = pod("harness", images.agent);
          const supplier = pod("supplier", images.openShellGateway);
          const pods = [supervisor, harness, supplier];
          const key = Buffer.alloc(32, 1);
          const policyHash = "a".repeat(64);
          // Fixed consistent input for the observer. This case does not test pin derivation.
          const committed = {
            sandboxId,
            plan: {
              generation: 7,
              execution: {
                namespaceId: namespace.id,
                agentId: agent.id,
                revisionId: revision.id,
                installationId: "private-installation-id",
                servicePrincipalId: agent.servicePrincipalId,
              },
            },
            enforcement: {
              instanceId,
              policyHash,
              peerKeyId: key.toString("base64url"),
              authorityScope: "execution",
              configurationId: "b010bc3c3d213c355e43eccffbee704648968a7f42fc973f8ab1a4afe0f33bf5",
            },
          };
          const loaded = {
            active_version: 7,
            revision: { version: 7, status: 2, policy_hash: policyHash, policy: {} },
            loaded_policy_observation: {
              registered_exchange_public_key: key,
              source_policy_hash: policyHash,
              effective_policy: {},
              enforcement: {
                sandbox_id: sandboxId,
                instance_id: instanceId,
                policy_version: 7,
                policy_hash: policyHash,
                config_revision: "1",
                provider_env_revision: "1",
                enforced_capabilities: capabilities,
              },
            },
          };
          let logReads = 0;
          let policyReads = 0;
          let reconnectAt;
          const line = (session: string, epoch: string, at: string) =>
            `${at} ${at}  INFO openshell_server::supervisor_session: supervisor session: accepted sandbox_id=${sandboxId} session_id=${session} instance_id=${instanceId} connection_epoch=${epoch}`;
          const f = {
            resource: async (_kind: string, name: string) => {
              const found = pods.find((value) => value.metadata.name === name);
              assert.ok(found);
              return found;
            },
            kubectl: async () => {
              logReads++;
              const baseline = line(first, "9007199254740992", "2026-01-01T00:00:00.000Z");
              if (logReads === 1) {
                return baseline;
              }
              reconnectAt ??= new Date().toISOString();
              return `${baseline}\n${line(second, "9007199254740993", reconnectAt)}`;
            },
            waitFor: async <T>(_label: string, read: () => Promise<T | undefined>) => {
              // Scripted observations exercise pending enrollment as well as the loaded branch.
              for (let attempt = 0; attempt < 3; attempt++) {
                await delay(5);
                const result = await read();
                if (result) {
                  return result;
                }
              }
              assert.fail("scripted observations never satisfied the observer");
            },
          };
          const setup = {
            input: { images, supplierCommit: "c".repeat(40), openShellGatewayNamespace: placement },
            controller: {},
            f,
          };
          const stack = {
            pool: {},
            placement,
            namespace,
            namespacePath: "/private-namespace",
            installation: { id: "private-installation-id" },
            supplierPods: [supplier],
            gatewayClient: {
              getSandboxPolicyStatus: async () =>
                ++policyReads === 2 ? { ...loaded, loaded_policy_observation: undefined } : loaded,
            },
          };
          const deploymentPath = "/private-deployment";
          const diagnostics: string[] = [];
          const progress: { stage?: string } = {};
          const evidence = await createRunEvidence(
            { signal: t.signal, diagnostic: (line: string) => diagnostics.push(line) },
            setup,
            progress,
          );
          // Replace only the external state input. Real observer, assertions, checkpoint,
          // atomic ledger writes and terminal projection run unchanged.
          const fixtureView = {
            credentialSources: { findRevisionEgressInstallation: () => committed },
          };
          const stateRead = t.mock.method(
            PostgresPlatformState.prototype,
            "read",
            async <T>(read: (view: typeof fixtureView) => Promise<T>) => read(fixtureView),
          );
          let failure: unknown;
          try {
            await requireSupervisorReconnect(
              setup,
              stack,
              {
                ...evidence,
                api: async (_method: string, path: string) =>
                  path === deploymentPath
                    ? {
                        deploymentId: revision.id,
                        namespaceId: namespace.id,
                        agentId: agent.id,
                        status: failFinalReadiness ? "private-unexpected-status" : "succeeded",
                        error: null,
                        cleanup: null,
                      }
                    : { activeRevisionId: revision.id },
              },
              { agent, revision, sandboxId, deploymentPath },
              { supervisor, harness, sandboxName: "private-sandbox-name" },
            );
          } catch (error) {
            failure = error;
          } finally {
            stateRead.mock.restore();
          }
          try {
            if (failFinalReadiness) {
              assert.ok(failure instanceof assert.AssertionError);
              assert.equal(failure.code, "ERR_ASSERTION");
              const terminal = await safeConnectedFailure(
                failure,
                progress.stage,
                evidence.recordFailure,
              );
              diagnostics.push(terminal.message);
              assert.match(terminal.message, /reconnect-before-turn/);
            } else {
              assert.equal(failure, undefined);
            }
            const phases = await readPrivatePhases(evidence.directory);
            const phase = <Name extends PrivateCheckpoint["phase"]>(name: Name) =>
              requirePhase(phases, name);
            assert.equal(
              phase("reconnect-wait-start").supervisor.containerId,
              supervisor.status.containerStatuses[0].containerID,
            );
            assert.equal(phase("reconnect-wait-start").harness.image, images.agent);
            assert.equal(
              phase("reconnect-wait-start").supplierProcesses[0]?.podUid,
              supplier.metadata.uid,
            );
            assert.equal(phase("reconnect-wait-start").sandboxId, sandboxId);
            assert.equal(phase("reconnect-before-policy").instanceId, instanceId);
            assert.equal(phase("reconnect-baseline").sessions[0]?.sessionId, first);
            assert.equal(phase("reconnect-accepted").reconnect.sessionId, second);
            assert.equal(phase("reconnect-accepted").reconnect.epoch, "9007199254740993");
            assert.equal(phase("reconnect-before-turn").deploymentId, revision.id);
            assert.equal(phase("reconnect-before-turn").deploymentReady, !failFinalReadiness);
            assert.ok(
              phases.some(
                (entry) => entry.phase === "reconnect-after-policy" && entry.loaded === false,
              ),
            );
            const printed = diagnostics.join("\n");
            const privateValues = [
              sandboxId,
              instanceId,
              first,
              second,
              agent.id,
              revision.id,
              "c".repeat(40),
              "9007199254740992",
              "9007199254740993",
              "private-unexpected-status",
              ...Object.values(images),
              ...pods.flatMap((value) => [
                value.metadata.name,
                value.metadata.uid,
                value.status.containerStatuses[0].containerID,
                value.status.containerStatuses[0].imageID,
                value.status.containerStatuses[0].name,
              ]),
              phase("reconnect-baseline").baselineAt,
              phase("reconnect-accepted").logThrough,
            ];
            // Generic names can be phase labels, so check their private identity fields instead.
            for (const value of privateValues.filter(
              (value) => !["supervisor", "harness", "supplier"].includes(value),
            )) {
              assert.equal(
                printed.includes(value),
                false,
                `private reconnect metadata reached reporter: ${value}`,
              );
            }
            const report = diagnostics
              .filter((line) => line.startsWith("egress-connected reconnect-"))
              .map((line) => ({
                phase: line.split(" ")[1],
                details: readDiagnostic(line),
              }));
            assert.equal(
              report.find((entry) => entry.phase === "reconnect-accepted")?.details.sessionCount,
              2,
            );
            const equalities = report.find((entry) => entry.phase === "reconnect-before-policy")
              ?.details.equalities;
            assert.ok(typeof equalities === "object" && equalities !== null);
            assert.ok("enforcementMatches" in equalities);
            assert.equal(equalities.enforcementMatches, true);
            assert.equal(
              report.find((entry) => entry.phase === "reconnect-before-turn")?.details
                .deploymentReady,
              !failFinalReadiness,
            );
            const forbidden = [
              "supplierCommit",
              "supervisor",
              "harness",
              "supplierProcesses",
              "sandboxId",
              "agentId",
              "revisionId",
              "logSince",
              "instanceId",
              "policyVersion",
              "baselineAt",
              "sessions",
              "reconnect",
              "logThrough",
              "deploymentId",
              "status",
            ];
            for (const { details } of report) {
              for (const field of forbidden) {
                assert.equal(Object.hasOwn(details, field), false, `${field} must remain private`);
              }
            }
          } finally {
            await rm(evidence.directory, { recursive: true, force: true });
          }
        },
      );
    }
  },
);

type UpgradeLedger = {
  resources: { kind: string; id: string }[];
  pendingCreate?: { kind: string; name: string };
  pendingDeploy?: { agentId: string; path: string };
};

type ProviderTraffic = "tcp" | "http";
type UpgradeWindow = "ready" | "replacement" | 0 | 1 | 2 | 3;

type RetirementFault = {
  readError?: boolean;
  created?: { id?: string };
  readback?: { id?: string; namespaceId?: string; name?: string };
};

type UpgradeFault = RetirementFault & {
  recording?: Pick<Awaited<ReturnType<typeof createRunEvidence>>, "runId" | "checkpoint"> & {
    ledger: UpgradeLedger;
  };
  traffic?: ProviderTraffic;
  window?: UpgradeWindow;
};

// These protocol peers exercise the real upgrade helper's ownership decisions;
// they do not establish Kubernetes, PostgreSQL, or installed-runtime acceptance.
async function controllerUpgradePeers(t: TestContext, fault: UpgradeFault = {}) {
  const namespaceId = "ns_11111111-1111-4111-8111-111111111111";
  const existingId = "cs_11111111-1111-4111-8111-111111111111";
  const createdId = "cs_22222222-2222-4222-8222-222222222222";
  const runId = fault.recording?.runId ?? randomUUID();
  const observations: object[] = [];
  const provider = { observations, tcpConnections: 0 };
  const origin = createServer((_request, response) => {
    provider.observations.push({});
    response.end("ok");
  });
  origin.on("connection", () => provider.tcpConnections++);
  const port = await listen(t, origin);
  async function reachOrigin() {
    if (fault.traffic === "http") {
      await fetch(`http://127.0.0.1:${port}`).then((response) => response.text());
      return;
    }
    // Wait for acceptance by the origin, not merely the client's connect event.
    const accepted = once(origin, "connection");
    const socket = connect({ host: "127.0.0.1", port });
    const [serverSocket]: unknown[] = await accepted;
    socket.destroy();
    assert.ok(serverSocket instanceof Socket);
    serverSocket.destroy();
  }
  function controllerPod(component: "api" | "worker", generation: "before" | "after") {
    const image = generation === "before" ? "controller:before" : "controller:after";
    return {
      metadata: {
        name: `${component}-${generation}`,
        uid: `${component}-${generation}`,
        namespace: "controller",
        labels: { "app.kubernetes.io/component": component },
      },
      spec: {
        containers: [
          {
            name: component,
            image,
            args: [`apps/controller/src/${component === "api" ? "server" : "worker"}.mjs`],
            env: [
              { name: "OCC_CONFIG_PATH", value: "/etc/openclaw/installation/installation.yaml" },
            ],
            volumeMounts: [
              { name: "installation", mountPath: "/etc/openclaw/installation", readOnly: true },
            ],
          },
        ],
        volumes: [{ name: "installation", secret: { items: [{ path: "installation.yaml" }] } }],
      },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [
          {
            name: component,
            containerID: `${component}-${generation}`,
            imageID: image,
            restartCount: 0,
            state: { running: { startedAt: "2026-01-01T00:00:00Z" } },
          },
        ],
      },
    };
  }
  let upgraded = false;
  let injected = false;
  const setup = {
    input: {
      controllerNamespace: "controller",
      controllerSelector: "controller",
      openShellGatewayNamespace: "supplier",
      openShellGatewaySelector: "supplier",
      oceCommit: "b".repeat(40),
      images: { controller: "controller:after" },
      controllerUpgrade: {
        fromCommit: "c".repeat(40),
        fromImage: "controller:before",
        timeoutMs: 10_000,
      },
    },
    controller: { providerOrigin: "https://provider.example" },
    f: {
      async kubectl(...args: string[]) {
        if (args[0] === "exec") {
          return "a".repeat(64);
        }
        if (args.includes("pod")) {
          return "";
        }
        if (args.includes("supplier")) {
          return JSON.stringify({ items: [] });
        }
        if (upgraded && fault.window === "replacement" && !injected) {
          injected = true;
          await reachOrigin();
        }
        return JSON.stringify({
          items: (["api", "worker"] as const).map((component) =>
            controllerPod(component, upgraded ? "after" : "before"),
          ),
        });
      },
    },
  };
  const state = {
    sources: [{ id: existingId }],
    revisions: [{ id: "revision" }],
    installations: [{}],
    work: [
      {
        idempotency_key: "agent_revision:revision:reconcile",
        agent_id: "agent",
        revision_id: "revision",
        agent_target: null,
        state: "succeeded",
        reason_code: "REVISION_ACTIVATED",
      },
    ],
  };
  const stack = {
    namespace: { id: namespaceId },
    namespacePath: `/namespaces/${namespaceId}`,
    installation: { id: "installation" },
    supplierPods: [],
    pool: {
      async query(sql: string) {
        return { rows: sql.includes("count(*)") ? [{ pending: 0 }] : [{ state }] };
      },
    },
  };
  const ledger: UpgradeLedger = fault.recording?.ledger ?? { resources: [] };
  const sourceReads: string[] = [];
  let requests = 0;
  const evidence = {
    runId,
    credentials: { initial: "synthetic" },
    ledger,
    async checkpoint(phase: string, details?: object, privateDetails?: object) {
      await fault.recording?.checkpoint(phase, details, privateDetails);
      // The operator can act as soon as readiness is published, before observe starts.
      if (phase === "controller-upgrade-ready" && fault.window === "ready") {
        await reachOrigin();
      }
    },
    async api(method: string, path: string) {
      if (method === "PATCH") {
        return { id: existingId, state: "ready", egress: { adoption: "live", retention: "none" } };
      }
      if (path === "/installation") {
        return stack.installation;
      }
      if (path.endsWith("/iam/access-bindings")) {
        return [];
      }
      sourceReads.push(path);
      if (fault.readError) {
        throw new Error("readback unavailable");
      }
      return { id: createdId, namespaceId, name: `egress-refused-${runId}`, ...fault.readback };
    },
    async request() {
      const index = requests++;
      if (fault.window === index) {
        await reachOrigin();
      }
      const meta = { requestId: `request-${index}` };
      return fault.created !== undefined && index === 0
        ? { status: 201, body: { data: fault.created, meta } }
        : {
            status: 409,
            body: {
              meta,
              error: {
                code: "RESOURCE_CONFLICT",
                message:
                  "The selected Driver has retired new uses of this protected static credential provider. Ask an Installation administrator to configure a supported model access path.",
              },
            },
          };
    },
  };
  const owned = {
    provider,
    async create(kind: string) {
      return kind === "secrets" ? { ref: "replacement-secret" } : { id: existingId };
    },
  };
  const deployment = {
    agent: { id: "agent" },
    revision: { id: "revision" },
    secret: { ref: "secret" },
  };
  const retained = await prepareControllerUpgrade(setup, stack, evidence, owned, deployment, {
    gatewayPods: [],
  });
  upgraded = true;
  return {
    ledger,
    provider,
    sourceReads,
    existingId,
    createdId,
    run: () => observeControllerUpgrade(setup, stack, evidence, owned, deployment, retained),
  };
}

test("unexpected retirement creates require new, read-back run ownership before cleanup", async (t) => {
  const createdId = "cs_22222222-2222-4222-8222-222222222222";
  const existingId = "cs_11111111-1111-4111-8111-111111111111";
  const cases: (RetirementFault & {
    name: string;
    error: RegExp;
    reads?: number;
    owned?: boolean;
  })[] = [
    {
      name: "pre-existing",
      created: { id: existingId },
      error: /pre-upgrade baseline/,
      reads: 0,
    },
    { name: "missing", created: {}, error: /valid source ID/, reads: 0 },
    { name: "malformed", created: { id: "invalid" }, error: /valid source ID/, reads: 0 },
    { name: "wrong ID", readback: { id: existingId }, error: /returned source ID/ },
    { name: "wrong Namespace", readback: { namespaceId: "other" }, error: /this Namespace/ },
    { name: "wrong name", readback: { name: "unrelated" }, error: /run-specific name/ },
    { name: "failed read", readError: true, error: /readback unavailable/ },
    { name: "confirmed new source", owned: true, error: /HTTP 201/ },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const peer = await controllerUpgradePeers(t, { created: { id: createdId }, ...scenario });
      await assert.rejects(peer.run(), scenario.error);
      assert.deepEqual(
        peer.ledger.resources,
        scenario.owned ? [{ kind: "credential-sources", id: createdId }] : [],
      );
      assert.equal(peer.ledger.pendingCreate !== undefined, !scenario.owned);
      assert.equal(peer.sourceReads.length, scenario.reads ?? 1);
    });
  }
});

test("upgrade and retirement quiet windows reject TCP arrivals without HTTP", async (t) => {
  await t.test("quiet success", async (t) => {
    const peer = await controllerUpgradePeers(t);
    await peer.run();
    assert.equal(peer.ledger.pendingCreate, undefined);
    assert.equal(peer.ledger.pendingDeploy, undefined);
  });
  for (const window of ["ready", "replacement", 0, 1, 2, 3] as const) {
    for (const traffic of ["tcp", "http"] as const) {
      await t.test(`${window}: ${traffic}`, async (t) => {
        const peer = await controllerUpgradePeers(t, { window, traffic });
        await assert.rejects(
          peer.run(),
          traffic === "tcp" ? /provider connections/ : /provider traffic|provider I\/O/,
        );
        assert.equal(peer.provider.tcpConnections > 0, true);
        assert.equal(peer.provider.observations.length, traffic === "tcp" ? 0 : 1);
      });
    }
  }
});

test("controller upgrade checkpoints keep process identity in the private ledger", async (t) => {
  const diagnostics: string[] = [];
  const recording = await createRunEvidence(
    { signal: t.signal, diagnostic: (line: string) => diagnostics.push(line) },
    { input: { images: {} }, controller: {} },
    {},
  );
  t.after(() => rm(recording.directory, { recursive: true, force: true }));
  // Protocol peers supply identity observations; the actual checkpoint writer
  // decides what reaches public diagnostics and the private on-disk ledger.
  const peer = await controllerUpgradePeers(t, { recording });
  await peer.run();
  const phases = await readPrivatePhases(recording.directory);
  for (const [phase, generation] of [
    ["controller-upgrade-ready", "before"],
    ["controller-upgrade-observed", "after"],
  ] as const) {
    const retained = requirePhase(phases, phase);
    const line = diagnostics.find((entry) => entry.startsWith(`egress-connected ${phase} `));
    assert.ok(line, "public progress remains observable");
    const visible = readDiagnostic(line);
    assert.equal(
      Object.hasOwn(visible, "controllers"),
      false,
      "process identities must stay private",
    );
    assert.equal(visible.componentCount, 2);
    assert.equal(retained.controllers.length, 2);
    for (const process of retained.controllers) {
      assert.ok(process.name.endsWith(generation));
      for (const field of [
        "name",
        "uid",
        "containerID",
        "imageID",
        "startedAt",
        "configurationSha256",
        "installationSha256",
      ] as const) {
        assert.equal(typeof process[field], "string", `retained ${field}`);
        assert.equal(line.includes(process[field]), false, `${field} must stay private`);
      }
    }
    if (retained.phase === "controller-upgrade-ready") {
      for (const field of [
        "fromCommit",
        "toCommit",
        "fromImage",
        "toImage",
        "retainedStateSha256",
      ] as const) {
        assert.equal(typeof retained[field], "string", `retained ${field}`);
        assert.equal(line.includes(retained[field]), false, `${field} must stay private`);
      }
      assert.deepEqual(visible.providerBaseline, { httpRequests: 0, tcpConnections: 0 });
    } else {
      assert.equal(visible.retainedStateUnchanged, true);
      assert.equal(visible.providerSends, 0);
    }
  }
});
