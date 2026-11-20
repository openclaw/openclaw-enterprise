import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Deploy } from "../../deploy/examples/strands-box/ordinary-chat/warm-retry-deploy.ts";

const uuidPrefix = "00000000-0000-4000-8000-00000000000";
const namespaceId = `ns_${uuidPrefix}1`;
const agentId = `agt_${uuidPrefix}2`;
const configurationId = `cfg_${uuidPrefix}3`;
const previousRevisionId = `rev_${uuidPrefix}4`;
const nextRevisionId = `rev_${uuidPrefix}5`;
const otherRevisionId = `rev_${uuidPrefix}6`;
const configurationGeneration = 2;
const agentPath = `/namespaces/${namespaceId}/agents/${agentId}`;
const configPath = `/namespaces/${namespaceId}/configurations/${configurationId}`;
const chatPath = `/agents/${agentId}/chat`;
const serviceKey = "synthetic-loopback-header";
const responseCanary = "response-text-must-stay-private";

type Status = "queued" | "running" | "succeeded" | "failed";

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

function envelope(data: unknown, meta = {}) {
  return { data, meta: { requestId: "loopback-test", ...meta } };
}

function revision(id: string, number: number) {
  return {
    id,
    revision: number,
    namespaceId,
    agentId,
    configurationId,
    configurationGeneration,
    backendId: null,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function sum(id: string, number: number, status: Status) {
  return {
    ...revision(id, number),
    deploymentStatus: status,
    deploymentErrorCode: status === "failed" ? "CONVERGENCE_DEADLINE_EXCEEDED" : null,
  };
}

async function apiFixture(t: TestContext) {
  const state = {
    admitted: false,
    desiredRuntimeState: "stopped" as "stopped" | "running",
    activeRevisionId: undefined as string | undefined,
    newer: false,
    priorPending: false,
    predecessorStatus: "failed" as Status,
    successorStatus: "queued" as Status,
    generation: configurationGeneration,
    grants: { deploy: true, operate: true },
    refusePermissionRead: undefined as number | undefined,
    onPermissionRefusal: undefined as (() => void) | undefined,
    slowHistory: undefined as { limit: 1 | 100; occurrence: number; ms: number } | undefined,
    deployResponse: "accepted" as "accepted" | "lost" | "redirect" | "foreign" | "denied",
    chatResponse: "READY",
    loseChatResponse: false,
  };
  let permissionReads = 0;
  const historyReads = { 1: 0, 100: 0 };
  const requests: {
    url: string | undefined;
    method: string | undefined;
    key: string | string[] | undefined;
    type: string | undefined;
    body: string;
  }[] = [];
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.once("end", () => {
      const { method, url } = request;
      requests.push({
        url,
        method,
        key: request.headers["x-api-key"],
        type: request.headers["content-type"],
        body,
      });
      if (request.headers["x-api-key"] !== serviceKey) {
        json(response, 401, { error: { message: responseCanary } });
      } else if (method === "GET" && url === agentPath) {
        json(
          response,
          200,
          envelope({
            id: agentId,
            namespaceId,
            configurationId,
            status: "active",
            desiredRuntimeState: state.desiredRuntimeState,
            activeRevisionId: state.activeRevisionId,
          }),
        );
      } else if (method === "GET" && url === configPath) {
        json(
          response,
          200,
          envelope({ id: configurationId, namespaceId, generation: state.generation }),
        );
      } else if (method === "GET" && url === `${agentPath}/permissions`) {
        permissionReads += 1;
        const refused = permissionReads === state.refusePermissionRead;
        if (refused) {
          state.onPermissionRefusal?.();
        }
        json(response, 200, envelope(refused ? { ...state.grants, operate: false } : state.grants));
      } else if (method === "GET" && url === `${agentPath}/revisions/${previousRevisionId}`) {
        json(response, 200, envelope(revision(previousRevisionId, state.priorPending ? 2 : 1)));
      } else if (method === "GET" && url?.startsWith(`${agentPath}/revisions?limit=`)) {
        const previousNumber = state.priorPending ? 2 : 1;
        const limit = url.endsWith("limit=1") ? 1 : 100;
        historyReads[limit] += 1;
        const rows = [
          ...(state.newer ? [sum(otherRevisionId, previousNumber + 2, "running")] : []),
          ...(state.admitted
            ? [sum(nextRevisionId, previousNumber + 1, state.successorStatus)]
            : []),
          sum(previousRevisionId, previousNumber, state.predecessorStatus),
          ...(state.priorPending ? [sum(otherRevisionId, 1, "running")] : []),
        ];
        const payload = envelope(rows.slice(0, limit), {
          nextCursor: rows.length > limit ? `v1.${rows[limit - 1]?.revision}` : null,
        });
        if (
          state.slowHistory?.limit === limit &&
          state.slowHistory.occurrence === historyReads[limit]
        ) {
          const timer = setTimeout(() => json(response, 200, payload), state.slowHistory.ms);
          response.once("close", () => clearTimeout(timer));
        } else {
          json(response, 200, payload);
        }
      } else if (method === "GET" && url === `${agentPath}/deployments/${previousRevisionId}`) {
        json(
          response,
          200,
          envelope({
            agentId,
            namespaceId,
            deploymentId: previousRevisionId,
            status: state.predecessorStatus,
            cleanup: null,
          }),
        );
      } else if (
        method === "GET" &&
        url === `${agentPath}/deployments/${nextRevisionId}` &&
        state.admitted
      ) {
        json(
          response,
          200,
          envelope({
            agentId,
            namespaceId,
            deploymentId: nextRevisionId,
            status: state.successorStatus,
            cleanup: null,
          }),
        );
      } else if (method === "POST" && url === `${agentPath}/deploy`) {
        if (state.deployResponse === "denied") {
          json(response, 403, { error: { message: responseCanary } });
          return;
        }
        if (state.deployResponse === "redirect") {
          response.writeHead(307, { location: "/elsewhere" }).end();
          return;
        }
        state.admitted = true;
        state.desiredRuntimeState = "running";
        if (state.deployResponse === "lost") {
          response.destroy();
          return;
        }
        const admitted = revision(nextRevisionId, 2);
        json(
          response,
          202,
          envelope({
            ...admitted,
            ...(state.deployResponse === "foreign" ? { agentId: `agt_${uuidPrefix}7` } : {}),
          }),
        );
      } else if (method === "POST" && url === chatPath) {
        if (state.loseChatResponse) {
          response.destroy();
          return;
        }
        json(response, 200, {
          id: "chatcmpl-local",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: state.chatResponse },
              finish_reason: "stop",
            },
          ],
        });
      } else {
        json(response, 404, { error: { message: responseCanary } });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config = {
    baseUrl,
    serviceKey,
    namespaceId,
    agentId,
    configurationId,
    configurationGeneration,
    previousRevisionId,
  };
  return { state, requests, config };
}

test("the warm retry submits one bodyless saved deploy and requires the active successor before chat", async (t) => {
  const { config, state, requests } = await apiFixture(t);
  const deploy = new Deploy(config);
  await deploy.preflight();
  assert.equal(await deploy.submit(), nextRevisionId);
  await assert.rejects(deploy.submit(), { message: "OCC_DEPLOY_SEND_REFUSED" });
  assert.equal(await deploy.observe(nextRevisionId), "pending");
  state.successorStatus = "succeeded";
  // A terminal deployment response without a current active pointer cannot qualify the execution.
  await assert.rejects(deploy.observe(nextRevisionId), { message: "OCC_SUCCESSOR_NOT_CURRENT" });
  state.activeRevisionId = nextRevisionId;
  assert.equal(await deploy.observe(nextRevisionId), "succeeded");
  await deploy.chat();
  const writes = requests.filter(({ method }) => method === "POST");
  assert.deepEqual(writes, [
    { url: `${agentPath}/deploy`, method: "POST", key: serviceKey, type: undefined, body: "" },
    {
      url: chatPath,
      method: "POST",
      key: serviceKey,
      type: "application/json",
      body: '{"messages":[{"role":"user","content":"Return READY."}],"stream":false}',
    },
  ]);
  assert.ok(requests.every(({ key }) => key === serviceKey));
});

test("warm retry preflight stops before POST when scope, stop, generation, history, or IAM is unresolved", async (t) => {
  const { config, state, requests } = await apiFixture(t);
  await assert.rejects(new Deploy(config).submit(), { message: "OCC_DEPLOY_SEND_REFUSED" });
  state.generation += 1;
  await assert.rejects(new Deploy(config).preflight(), {
    message: "OCC_CONFIGURATION_PIN_MISMATCH",
  });
  state.generation -= 1;
  state.activeRevisionId = previousRevisionId;
  await assert.rejects(new Deploy(config).preflight(), { message: "OCC_AGENT_NOT_STOPPED" });
  state.activeRevisionId = undefined;
  state.grants.operate = false;
  await assert.rejects(new Deploy(config).preflight(), { message: "OCC_PERMISSIONS_UNCONFIRMED" });
  state.grants.operate = true;
  state.predecessorStatus = "running";
  await assert.rejects(new Deploy(config).preflight(), { message: "OCC_PREDECESSOR_NOT_TERMINAL" });
  state.predecessorStatus = "failed";
  state.priorPending = true;
  await assert.rejects(new Deploy(config).preflight(), { message: "OCC_HISTORY_UNCONFIRMED" });
  state.priorPending = false;
  state.admitted = true;
  await assert.rejects(new Deploy(config).preflight(), { message: "OCC_REVISION_PIN_MISMATCH" });
  assert.equal(requests.filter(({ method }) => method === "POST").length, 0);
});

test("transport loss after admission does not replay; exact external identity can be observed without submitting", async (t) => {
  const { config, state, requests } = await apiFixture(t);
  state.deployResponse = "lost";
  const deploy = new Deploy(config);
  await deploy.preflight();
  await assert.rejects(deploy.submit(), { message: "OCC_REQUEST_UNCONFIRMED" });
  await assert.rejects(deploy.submit(), { message: "OCC_DEPLOY_SEND_REFUSED" });
  const detached = new Deploy(config);
  await assert.rejects(detached.observe(previousRevisionId), {
    message: "OCC_SUCCESSOR_UNCONFIRMED",
  });
  assert.equal(await detached.observe(nextRevisionId), "pending");
  state.successorStatus = "failed";
  assert.equal(await detached.observe(nextRevisionId), "failed");
  state.newer = true;
  await assert.rejects(detached.observe(nextRevisionId), { message: "OCC_REVISION_PIN_MISMATCH" });
  assert.deepEqual(
    requests.filter(({ method }) => method === "POST").map(({ url }) => url),
    [`${agentPath}/deploy`],
  );
});

test("the deploy POST does not follow redirects and does not expose a refusal body", async (t) => {
  const { config, state, requests } = await apiFixture(t);
  for (const response of ["redirect", "denied", "foreign"] as const) {
    state.deployResponse = response;
    const deploy = new Deploy(config);
    await deploy.preflight();
    const message =
      response === "foreign" ? "OCC_REVISION_PIN_MISMATCH" : "OCC_REQUEST_UNCONFIRMED";
    await assert.rejects(deploy.submit(), { message });
  }
  assert.deepEqual(
    requests.filter(({ method }) => method === "POST").map(({ url }) => url),
    [`${agentPath}/deploy`, `${agentPath}/deploy`, `${agentPath}/deploy`],
  );
});

const cli = fileURLToPath(
  new URL("../../deploy/examples/strands-box/ordinary-chat/warm-retry.ts", import.meta.url),
);
const kubeContext = "warm-retry-fixture";
const namespace = "warm-retry";
const namespaceUid = uuidPrefix + "7";
const apiNamespace = "oce-system";
const apiPod = "warm-retry-api-fixture";
const apiPodUid = uuidPrefix + "a";
const release = "warm-retry-fixture";
const executionId = "exec-fixture";
const requirementsDigest = "a".repeat(64);
const generationSha256 = "b".repeat(64);
const driverId = "compute";
const implementation = "@openclaw-enterprise/warm-retry-fixture@0.0.1";

async function cliFixture(t: TestContext, timeoutSeconds = 8) {
  const api = await apiFixture(t);
  const local = mkdtempSync(join(realpathSync(tmpdir()), "oce-wr-"));
  const runtimeDir = join(local, "runtime");
  const exportDir = join(runtimeDir, "worker-control");
  const hostSocketPath = join(exportDir, "control.sock");
  const stateDir = join(local, "state");
  const bin = join(local, "bin");
  for (const dir of [runtimeDir, exportDir, stateDir, bin]) {
    mkdirSync(dir, { mode: 0o700 });
  }
  const host = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/v1/execution") {
      json(response, 405, { error: "fixture_method_refused" });
    } else if (api.state.activeRevisionId === undefined) {
      json(response, 404, { error: "execution_absent" });
    } else {
      json(response, 200, {
        owner: {
          namespaceName: namespace,
          namespaceId,
          agentId,
          revisionId: api.state.activeRevisionId,
          driverId,
          implementation,
        },
        state: "running",
        executionId,
        requirementsDigest,
        workspaceNodeMode: "file-only-v1",
        generationSha256,
      });
    }
  });
  host.listen(hostSocketPath);
  await once(host, "listening");
  t.after(async () => {
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    rmSync(local, { recursive: true, force: true });
  });
  chmodSync(hostSocketPath, 0o600);
  const uid = process.getuid?.();
  const hostUid = uid === 0 ? 65534 : uid;
  if (uid === 0) {
    for (const path of [runtimeDir, exportDir, hostSocketPath]) {
      chownSync(path, 65534, 65534);
    }
  }
  const workloadFile = join(local, "workloads.json");
  const namespaceFile = join(local, "namespace.json");
  const apiPodFile = join(local, "api-pod.json");
  const keyFile = join(local, "key.json");
  const configFile = join(local, "config.json");
  const saveJson = (path: string, value: unknown) => {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  };
  const writeWorkloads = (items: unknown[]) => {
    saveJson(workloadFile, { apiVersion: "v1", kind: "List", metadata: {}, items });
  };
  writeWorkloads([]);
  saveJson(namespaceFile, {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      uid: namespaceUid,
      labels: { "openclaw.dev/namespace": namespaceId },
      annotations: { "openclaw.dev/namespace-id": namespaceId },
    },
    status: { phase: "Active" },
  });
  const apiPodSnapshot = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: apiPod,
      namespace: apiNamespace,
      uid: apiPodUid,
      labels: {
        "app.kubernetes.io/instance": release,
        "app.kubernetes.io/component": "api",
        "app.kubernetes.io/name": "openclaw-enterprise",
      },
    },
    spec: { containers: [{ name: "api" }] },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "api", ready: true, state: { running: {} } }],
      podIP: "127.0.0.1",
    },
  };
  saveJson(apiPodFile, apiPodSnapshot);
  const replaceApiPod = () => {
    saveJson(apiPodFile, {
      ...apiPodSnapshot,
      metadata: { ...apiPodSnapshot.metadata, uid: uuidPrefix + "b" },
    });
  };
  saveJson(keyFile, { data: { key: serviceKey } });
  const { serviceKey: _fixtureKey, baseUrl, ...publicConfig } = api.config;
  saveJson(configFile, {
    ...publicConfig,
    kubeContext,
    namespace,
    namespaceUid,
    apiNamespace,
    apiPod,
    apiPodUid,
    release,
    driverId,
    implementation,
    hostUid,
    hostSocketPath,
    stateDir,
    timeoutSeconds,
  });
  writeFileSync(
    join(bin, "kubectl"),
    `#!/bin/sh
case "$*" in
  "--context ${kubeContext} --namespace ${namespace} --request-timeout=5s get namespace ${namespace} -o json")
    exec cat "$WARM_RETRY_FIXTURE_NAMESPACE" ;;
  "--context ${kubeContext} --namespace ${namespace} --request-timeout=5s get pods,deployments --selector openclaw.dev/agent=${agentId} -o json")
    exec cat "$WARM_RETRY_FIXTURE_WORKLOADS" ;;
  "--context ${kubeContext} --namespace ${apiNamespace} --request-timeout=5s get pod ${apiPod} -o json")
    exec cat "$WARM_RETRY_FIXTURE_API_POD" ;;
  "--context ${kubeContext} --namespace ${apiNamespace} --request-timeout=0 exec -i ${apiPod} -c api -- "*)
    shift 11
    test "$1" = node && test "$2" = --input-type=module-typescript && test "$3" = -e || exit 1
    export OCC_HOST="$WARM_RETRY_FIXTURE_API_HOST" OCC_PORT="$WARM_RETRY_FIXTURE_API_PORT"
    exec "$@" ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  let apiHost = "127.0.0.1";
  const useApiHost = (host: string) => {
    apiHost = host;
  };
  const run = (mode: "check" | "start" | "resume", recovered?: string) =>
    new Promise<{ code: number | undefined; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        [cli, mode, configFile, ...(recovered === undefined ? [] : [recovered])],
        {
          env: {
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            OCC_SERVICE_KEY_FILE: keyFile,
            WARM_RETRY_FIXTURE_NAMESPACE: namespaceFile,
            WARM_RETRY_FIXTURE_WORKLOADS: workloadFile,
            WARM_RETRY_FIXTURE_API_POD: apiPodFile,
            WARM_RETRY_FIXTURE_API_HOST: apiHost,
            WARM_RETRY_FIXTURE_API_PORT: new URL(baseUrl).port,
          },
          timeout: 12_000,
        },
        (error, stdout, stderr) => {
          if (error?.code !== undefined && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({ code: error ? error.code : 0, stdout, stderr });
        },
      );
    });
  const ready = () => {
    api.state.successorStatus = "succeeded";
    api.state.activeRevisionId = nextRevisionId;
    const pods = ["gateway", "agent"].map((role, index) => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        namespace,
        name: `${role}-fixture`,
        uid: uuidPrefix + (index === 0 ? "8" : "9"),
        labels: {
          "openclaw.dev/namespace": namespaceId,
          "openclaw.dev/agent": agentId,
          "openclaw.dev/revision": nextRevisionId,
          "openclaw.dev/workload-role": role,
          ...(role === "agent" ? { "box.openclaw.dev/component": "harness-relay" } : {}),
        },
        ...(role === "agent"
          ? {
              annotations: {
                "box.openclaw.dev/execution": executionId,
                "box.openclaw.dev/requirements-sha256": requirementsDigest,
              },
            }
          : {}),
      },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
    }));
    writeWorkloads(pods);
  };
  const receiptNames = () => readdirSync(stateDir).sort();
  const savedReceipt = (name: string): unknown =>
    JSON.parse(readFileSync(join(stateDir, `${name}.json`), "utf8"));
  return { ...api, run, ready, receiptNames, savedReceipt, useApiHost, replaceApiPod };
}

// Use the real operator entry point and durable files with loopback OCE and
// native socket transport fixtures. Kubernetes reads use a scoped executable fixture.
test("a restarted CLI requires explicit reconciliation of an admitted deploy with a lost response", async (t) => {
  const { state, requests, run, ready, receiptNames, savedReceipt, useApiHost } =
    await cliFixture(t);
  useApiHost("127.0.0.2");
  const wrongPod = await run("check");
  assert.equal(wrongPod.code, 1);
  assert.match(wrongPod.stderr, /OCC_POD_BINDING_INVALID/);
  assert.deepEqual(requests, []);
  useApiHost("127.0.0.1");
  const checked = await run("check");
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /"stage":"preflight-passed"/);
  assert.deepEqual(receiptNames(), []);
  state.grants.operate = false;
  const refused = await run("start");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /OCC_PERMISSIONS_UNCONFIRMED/);
  assert.ok(requests.every(({ method }) => method === "GET"));
  assert.deepEqual(receiptNames(), []);
  state.grants.operate = true;
  state.deployResponse = "lost";
  const started = await run("start");
  assert.equal(started.code, 1, started.stderr);
  assert.match(started.stdout, /"stage":"deploy-intent"/);
  assert.deepEqual(receiptNames(), ["deploy-intent.json"]);

  // The real CLI must leave intent unresolved even when the transport fixture
  // already reports a successful and active successor.
  ready();
  const priorCount = requests.length;
  const resumed = await run("resume");
  assert.equal(resumed.code, 1);
  assert.match(resumed.stderr, /WARM_RETRY_DEPLOY_UNKNOWN_RECONCILE_ORIGINAL/);
  assert.equal(requests.length, priorCount);
  assert.equal((await run("start")).code, 1);
  assert.equal((await run("resume", previousRevisionId)).code, 1);
  assert.equal((await run("resume", otherRevisionId)).code, 1);
  assert.deepEqual(receiptNames(), ["deploy-intent.json"]);

  const reconciled = await run("resume", nextRevisionId);
  assert.equal(reconciled.code, 0, reconciled.stderr);
  assert.match(reconciled.stdout, /"stage":"terminal-chat-verified"/);
  assert.deepEqual(receiptNames(), [
    "accepted.json",
    "chat-intent.json",
    "deploy-intent.json",
    "reply.json",
  ]);
  assert.partialDeepStrictEqual(savedReceipt("accepted"), {
    stage: "accepted",
    revisionId: nextRevisionId,
    externallyReconciled: true,
  });
  assert.partialDeepStrictEqual(savedReceipt("reply"), {
    revisionId: nextRevisionId,
    generationSha256,
    content: "READY",
  });
  const readback = await run("resume");
  assert.equal(readback.code, 0, readback.stderr);
  assert.match(readback.stdout, /"stage":"terminal-chat-verified"/);
  assert.deepEqual(
    requests.filter(({ method }) => method === "POST").map(({ url }) => url),
    [`${agentPath}/deploy`, chatPath],
  );
  assert.ok(
    ![started, resumed, reconciled, readback].some(({ stdout, stderr }) =>
      [stdout, stderr].some(
        (output) => output.includes(serviceKey) || output.includes(responseCanary),
      ),
    ),
  );
});

test("the CLI records a second preflight refusal as a deploy that was never sent", async (t) => {
  const { state, requests, run, receiptNames, savedReceipt } = await cliFixture(t);
  state.refusePermissionRead = 2;
  const refused = await run("start");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /OCC_PERMISSIONS_UNCONFIRMED/);
  assert.match(refused.stdout, /"stage":"deploy-not-sent"/);
  assert.deepEqual(receiptNames(), ["deploy-intent.json", "deploy-not-sent.json"]);
  assert.partialDeepStrictEqual(savedReceipt("deploy-not-sent"), {
    stage: "deploy-not-sent",
    reason: "OCC_PERMISSIONS_UNCONFIRMED",
  });
  for (const recovered of [undefined, nextRevisionId]) {
    const resumed = await run("resume", recovered);
    assert.equal(resumed.code, 1);
    assert.match(resumed.stderr, /WARM_RETRY_DEPLOY_NOT_SENT/);
  }
  assert.match((await run("start")).stderr, /WARM_RETRY_ALREADY_STARTED_USE_RESUME/);
  assert.deepEqual(
    requests.filter(({ method }) => method === "POST"),
    [],
  );
});

test("a changed API Pod invalidates its apparent pre-send disposition", async (t) => {
  const { state, requests, run, receiptNames, replaceApiPod } = await cliFixture(t);
  state.refusePermissionRead = 2;
  state.onPermissionRefusal = replaceApiPod;
  const stopped = await run("start");
  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /WARM_RETRY_API_POD_CHANGED/);
  assert.deepEqual(receiptNames(), ["deploy-intent.json"]);
  const resumed = await run("resume");
  assert.equal(resumed.code, 1);
  assert.match(resumed.stderr, /WARM_RETRY_DEPLOY_UNKNOWN_RECONCILE_ORIGINAL/);
  assert.deepEqual(
    requests.filter(({ method }) => method === "POST"),
    [],
  );
});

test("the CLI caps the second in-Pod deploy preflight and sends no POST after expiry", async (t) => {
  const { state, requests, run, savedReceipt } = await cliFixture(t, 3);
  // This is the history read inside submit, after the journaled deploy intent.
  state.slowHistory = { limit: 100, occurrence: 2, ms: 6000 };
  const stopped = await run("start");
  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /OCC_RETRY_DEADLINE_EXPIRED/);
  assert.equal(requests.filter(({ url }) => url === `${agentPath}/revisions?limit=100`).length, 2);
  assert.deepEqual(
    requests.filter(({ method }) => method === "POST"),
    [],
  );
  assert.partialDeepStrictEqual(savedReceipt("deploy-not-sent"), {
    reason: "OCC_RETRY_DEADLINE_EXPIRED",
  });
});

test("the CLI caps the in-Pod chat observation and sends no chat POST after expiry", async (t) => {
  const { state, requests, run, ready, savedReceipt } = await cliFixture(t, 3);
  state.deployResponse = "lost";
  assert.equal((await run("start")).code, 1);
  ready();
  // The first two reads reconcile the deploy and observe readiness in the host CLI.
  state.slowHistory = { limit: 1, occurrence: 3, ms: 6000 };
  const stopped = await run("resume", nextRevisionId);
  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /OCC_RETRY_DEADLINE_EXPIRED/);
  assert.equal(requests.filter(({ url }) => url === `${agentPath}/revisions?limit=1`).length, 3);
  assert.partialDeepStrictEqual(savedReceipt("chat-not-sent"), {
    revisionId: nextRevisionId,
    generationSha256,
    reason: "OCC_RETRY_DEADLINE_EXPIRED",
  });
  const resumed = await run("resume");
  assert.equal(resumed.code, 1);
  assert.match(resumed.stderr, /WARM_RETRY_CHAT_NOT_SENT/);
  assert.deepEqual(
    requests.filter(({ method }) => method === "POST").map(({ url }) => url),
    [`${agentPath}/deploy`],
  );
});

for (const lost of [false, true]) {
  test(`the CLI preserves ${lost ? "a lost chat response" : "a terminal non-READY chat"} without replay`, async (t) => {
    const { state, requests, run, ready, receiptNames, savedReceipt } = await cliFixture(t);
    state.deployResponse = "lost";
    assert.equal((await run("start")).code, 1);
    ready();
    state.chatResponse = responseCanary;
    state.loseChatResponse = lost;
    const chat = await run("resume", nextRevisionId);
    const resumed = await run("resume");
    assert.equal(chat.code, 1);
    assert.equal(resumed.code, 1);
    if (lost) {
      assert.match(chat.stderr, /OCC_REQUEST_UNCONFIRMED/);
      assert.match(resumed.stderr, /WARM_RETRY_CHAT_UNKNOWN_NO_REPLAY/);
      assert.deepEqual(receiptNames(), ["accepted.json", "chat-intent.json", "deploy-intent.json"]);
    } else {
      assert.match(chat.stderr, /WARM_RETRY_CHAT_NOT_READY/);
      assert.match(resumed.stderr, /WARM_RETRY_CHAT_NOT_READY/);
      const reply = savedReceipt("reply");
      assert.partialDeepStrictEqual(reply, {
        revisionId: nextRevisionId,
        generationSha256,
        disposition: "not-ready",
      });
      assert.ok(!JSON.stringify(reply).includes(responseCanary));
    }
    for (const { stdout, stderr } of [chat, resumed]) {
      assert.ok(!stdout.includes(responseCanary) && !stderr.includes(responseCanary));
    }
    assert.deepEqual(
      requests.filter(({ method }) => method === "POST").map(({ url }) => url),
      [`${agentPath}/deploy`, chatPath],
    );
  });
}
