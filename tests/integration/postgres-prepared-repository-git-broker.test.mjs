import assert from "node:assert/strict";
import { join } from "node:path";
import { request, Agent } from "node:https";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import { connect, createServer as createTcpServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import {
  createAuthenticatedControllerRequest,
  createTestAuthPrincipal,
} from "../helpers/auth-session.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { fixture, prepare } from "../fixtures/prepared-repository-git.mjs";
import {
  cleanEnvironment,
  listen,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import { serviceConfigurationData } from "../fixtures/repository-credentials/builders.mjs";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import { startListeners } from "../../apps/controller/src/drivers/repo/credentials/server.ts";
import { createPreparedGitHubRegistryFactory } from "../../apps/controller/src/drivers/repo/github/credentials/warm-registry-factory.ts";

async function startBroker(
  t,
  { gh, registry, socketPath, namespaceId, binding, pushRef, deadlineWallMs, repository },
) {
  const tls = gh.tls;
  const observed = [];
  const origin = await startGitSmartHttpFixture(t, {
    tls,
    repository,
    authorize: gh.authorize,
    observeRequest: (method, url) => observed.push({ method, url }),
  });
  // Control the time of verified upstream TLS without trusting a substitute sender.
  let slow = false;
  const tcp = createTcpServer(async (socket) => {
    if (slow) {
      await delay(5250);
    }
    if (socket.destroyed) {
      return;
    }
    const upstream = connect(Number(new URL(origin.origin).port), "127.0.0.1");
    socket.once("close", () => upstream.destroy());
    upstream.once("error", () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  const gitOrigin = await listen(t, tcp);
  const clock = createSystemClock();
  const gatewayOrigin = "https://127.0.0.1";
  const config = validateServiceConfig(
    serviceConfigurationData({
      limits: { connectMs: 12000, stallMs: 12000, gitFetchStallMs: 12000 },
      gateway: {
        publicOrigin: gatewayOrigin,
        listen: "127.0.0.1:8443",
        controlSocket: join(socketPath, "..", "control.sock"),
      },
    }),
  );
  const factory = createPreparedGitHubRegistryFactory({
    registry,
    clock,
    socketPath,
    gitOrigin,
    apiOrigin: gh.origin,
    gatewayOrigin,
    limits: config.limits,
  });
  const service = createCredentialService({ config, factory, clock });
  t.after(() => service.shutdown(5000));
  const server = await startListeners({
    service,
    factory,
    clock,
    tls,
    config: { ...config, gateway: { ...config.gateway, listen: "127.0.0.1:0" } },
    upstreamCa: tls.ca,
    trustedUpstreamOrigins: factory.trustedUpstreamOrigins,
  });
  t.after(() => server.close());
  const address = gatewayOrigin + ":" + server.address.port;
  const openSession = () =>
    service.open({
      durationSeconds: 600,
      namespaceId,
      repositoryRef: binding.repositoryRef,
      profile: binding.profile,
      expectedBinding: binding.grant,
      deadlineWallMs,
      preparedOnly: true,
    });
  const opened = openSession();
  const authorization =
    "Basic " + Buffer.from("gateway-session:" + opened.bearer).toString("base64");
  const agent = new Agent({ ca: tls.ca, keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  function http(path, { method = "GET", headers, body, beforeBody } = {}) {
    return new Promise((resolve, reject) => {
      const req = request(
        address + path,
        { agent, method, headers: { authorization, host: "127.0.0.1", ...headers } },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.once("end", () =>
            resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.once("error", reject);
      if (beforeBody) {
        req.once("continue", () => {
          const socket = req.socket;
          void beforeBody()
            .then(() => {
              assert.equal(req.socket, socket);
              req.end(body);
            })
            .catch((error) => {
              req.destroy();
              reject(error);
            });
        });
        req.flushHeaders();
      } else {
        req.end(body);
      }
    });
  }
  const env = cleanEnvironment({
    GIT_SSL_CAINFO: tls.certFile,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_2: "http.extraHeader",
    GIT_CONFIG_VALUE_2: "Host: 127.0.0.1",
    GIT_CONFIG_KEY_1: "http.extraHeader",
    GIT_CONFIG_VALUE_1: "Authorization: " + authorization,
  });
  return {
    http,
    address,
    origin,
    observed,
    opened,
    openSession,
    env,
    pushRef,
    repository,
    slow(value) {
      slow = value;
    },
  };
}

// Exercise the normal authenticated HTTP withdrawal against the exact same State as
// the worker. This component test does not start Compute or a model/chat session.
async function withdrawRepositoryBinding(t, { state, agent }) {
  const installation = await state.read((unit) => unit.installations.getInstallation());
  const auth = await createTestAuthPrincipal({ installationId: installation.id });
  const iam = new NativeIAMDriver({
    async loadNativeIAMState() {
      return {
        identities: [auth.seed.principal],
        groups: [],
        memberships: [],
        roles: [...auth.seed.roles],
        bindings: [...auth.seed.bindings],
        restrictions: [],
      };
    },
  });
  const controller = new OpenClawController(installation, { state });
  controller.registerDriver(iam);
  controller.selectDriver(iam.capability, iam.id);
  const app = createFastifyApp({
    controller,
    iamDriver: iam,
    auditSink: new InMemoryAuditSink(),
    auth: auth.auth,
    development: { enabled: true, installationId: installation.id },
  });
  t.after(() => app.close());
  const api = await createAuthenticatedControllerRequest(app, auth);
  const result = await api("PATCH", "/namespaces/" + agent.namespaceId + "/agents/" + agent.id, {
    configurationId: agent.configurationId,
    repositoryBindings: [],
  });
  assert.equal(result.status, 200, JSON.stringify(result.error));
  assert.deepEqual(result.data.repositoryBindings ?? [], []);
}

test(
  "prepared broker uses committed Git material for native clone, exact-ref push and independent fetch; withdrawal denies a fetch already admitted on the same TLS connection",
  {
    ...requiresPostgres,
    timeout: 75000,
  },
  async (t) => {
    const f = await fixture(t, { openBroker: (input) => startBroker(t, input) });
    const b = f.broker;
    const repo = "/" + b.repository + ".git/";
    const discovery = repo + "info/refs?service=git-upload-pack";
    const useCount = async () =>
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM occ.prepared_repository_git_uses WHERE admission_id=$1",
          [f.admissionId],
        )
      ).rows[0].n;

    assert.equal((await b.http(discovery)).status, 503);
    assert.equal(f.gh.issuesOfTokens.length, 0);
    await prepare(f);
    assert.equal((await b.http(discovery)).status, 200);
    const before = await useCount();
    const beforeOrigin = b.observed.length;
    const packet = (text) => (text.length + 4).toString(16).padStart(4, "0") + text;
    const line = (ref) => packet("0".repeat(40) + " " + "1".repeat(40) + " " + ref + "\n");
    // The server receives a mixed-ref update directly, independent of any client hooks.
    const mixed = await b.http(repo + "git-receive-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request" },
      body: line(b.pushRef) + line("refs/heads/main") + "0000",
    });
    assert.equal(mixed.status, 400);
    for (const path of [
      discovery.replace(b.repository, "wrong/other"),
      "/repos/" + b.repository,
      "/graphql",
    ]) {
      assert.ok((await b.http(path)).status >= 400);
    }
    assert.equal(await useCount(), before);
    assert.equal(b.observed.length, beforeOrigin);

    // The owner commits a use, TLS completes, but no HTTP request crosses an expired send window.
    b.slow(true);
    assert.equal((await b.http(discovery)).status, 503);
    b.slow(false);
    assert.equal(await useCount(), before + 1);
    assert.equal(b.observed.length, beforeOrigin);

    // The deadline is to start sending, not a five-second limit on completing a large fetch.
    const hold = b.origin.holdNextFetch({ beforeHeaders: true });
    const started = b.http(repo + "git-upload-pack", {
      method: "POST",
      headers: {
        "git-protocol": "version=2",
        "content-encoding": "gzip",
        "content-type": "application/x-git-upload-pack-request",
      },
      body: gzipSync(packet("command=ls-refs\n") + "00010000"),
    });
    await hold.observed;
    await delay(5200);
    hold.release();
    assert.equal((await started).status, 200);

    const remote = b.opened.client.gitRemote.replace("https://127.0.0.1", b.address);
    const cwd = await temporaryDirectory(t, "warm-native-git-");
    const git = (args, allowFailure = false) => run("git", args, { cwd, env: b.env, allowFailure });
    await git(["clone", remote, "writer"]);
    await writeFile(join(cwd, "writer", "review.txt"), "Native Git wrote this review\n");
    const writer = (...args) => git(["-C", "writer", ...args]);
    await writer("add", "review.txt");
    const author = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"];
    await writer(...author, "commit", "-m", "Propose review");
    const head = (await writer("rev-parse", "HEAD")).stdout.trim();
    await writer("push", "origin", "HEAD:" + b.pushRef);
    assert.equal(await b.origin.ref(b.pushRef), head);
    await git(["clone", remote, "reader"]);
    await git(["-C", "reader", "pull", "--ff-only", "origin", b.pushRef]);
    assert.equal((await git(["-C", "reader", "rev-parse", "HEAD"])).stdout.trim(), head);
    assert.equal(
      await readFile(join(cwd, "reader", "review.txt"), "utf8"),
      "Native Git wrote this review\n",
    );

    // Lose a successful local receive-pack response. Reconcile by reading, never by replay.
    await writer(...author, "commit", "--allow-empty", "-m", "Inconclusive push");
    const next = (await writer("rev-parse", "HEAD")).stdout.trim();
    b.origin.disconnectAfterNextAcceptedPush();
    const pushes = () => b.observed.filter(({ url }) => url.endsWith("/git-receive-pack")).length;
    const count = pushes();
    const uncertain = await git(["-C", "writer", "push", "origin", "HEAD:" + b.pushRef], true);
    assert.notEqual(uncertain.code, 0);
    assert.equal(await b.origin.ref(b.pushRef), next);
    assert.equal(pushes(), count + 1);

    assert.equal((await b.http(discovery)).status, 200);
    const sent = b.observed.length;
    const used = await useCount();
    // The production listener deliberately serves only one request per TLS connection.
    // A 100 Continue proves the broker already admitted this exact request/session.
    // Withdraw before finishing its body: the subsequent owner read must deny this fetch.
    let withdrawn = false;
    const revoked = await b.http(repo + "git-upload-pack", {
      method: "POST",
      headers: {
        expect: "100-continue",
        "git-protocol": "version=2",
        "content-type": "application/x-git-upload-pack-request",
      },
      body: packet("command=ls-refs\n") + "00010000",
      async beforeBody() {
        await withdrawRepositoryBinding(t, f);
        withdrawn = true;
      },
    });
    assert.equal(withdrawn, true);
    assert.equal(revoked.status, 503);
    assert.equal((await b.http(discovery)).status, 503);
    assert.equal(b.observed.length, sent);
    assert.equal(await useCount(), used);
    assert.equal(f.gh.issuesOfTokens.length, 1);
  },
);

for (const mode of ["Git only", "created", "lost provider reply", "mismatched provider 201"]) {
  test("prepared draft pull: " + mode, { ...requiresPostgres, timeout: 45000 }, async (t) => {
    const draftPull = mode !== "Git only";
    const f = await fixture(t, {
      draftPull,
      draftResponse:
        mode === "mismatched provider 201" ? (body) => ({ ...body, base: body.head }) : undefined,
      openBroker: (input) => startBroker(t, input),
    });
    const b = f.broker;
    const path = "/repos/" + b.repository + "/pulls";
    const head = b.pushRef.slice("refs/heads/".length);
    const base = "main";
    const title = "Scoped review";
    const body = mode === "created" ? "Check: tests passed" : "";
    const operationId = randomUUID();
    const packet = { title, head, base, body, draft: true };
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer " + b.opened.bearer,
      "x-oce-operation-id": operationId,
    };
    const send = (input = {}) =>
      b.http(path, { method: "POST", headers, body: JSON.stringify(packet), ...input });
    const observed = () => f.gh.trace.filter((q) => q.method === "POST" && q.target === path);
    if (!draftPull) {
      await prepare(f);
      assert.equal((await send()).status, 400);
      assert.equal(observed().length, 0);
      return;
    }
    // A cold request cannot mint a token or leave a durable operation.
    assert.equal((await send()).status, 503);
    assert.equal(f.gh.issuesOfTokens.length, 0);
    await prepare(f);
    for (const input of [
      { body: JSON.stringify({ ...packet, head: "main" }) },
      { body: JSON.stringify({ ...packet, base: "other" }) },
      { body: JSON.stringify({ ...packet, draft: false }) },
      { body: JSON.stringify(packet).replace('"head":', '"he\\u0061d":"wrong","head":') },
      { headers: { ...headers, "x-github-api-version": "2022-01-01" } },
      { method: "GET", body: undefined },
    ]) {
      assert.equal((await send(input)).status, 400);
    }
    assert.equal(observed().length, 0);
    assert.equal(f.gh.issuesOfTokens.length, 1);

    if (mode === "created") {
      // Exercise the shipping client and real computed manifest through an obligatory CONNECT.
      // The TLS broker listens on a random port unreachable at the client's selected port 443.
      const { root } = await createNativeClientMaterial(
        t,
        [{ opened: b.opened, repositoryRef: "source" }],
        { ca: f.gh.tls.ca },
      );
      const proxy = createHttpServer();
      const tunnels = [];
      proxy.on("connect", (req, socket, early) => {
        tunnels.push(req.url);
        const upstream = connect(Number(new URL(b.address).port), "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(early);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      });
      const proxyAddress = (await listen(t, proxy)).replace(/^https:/, "http:");
      const client = new URL(
        "../../apps/controller/src/drivers/repo/github/credentials/client/draft-pr.ts",
        import.meta.url,
      ).href;
      const args = [
        "pr-create",
        "--operation-id",
        operationId,
        "--draft",
        "--head",
        head,
        "--base",
        base,
        "--title",
        title,
      ];
      const command =
        "import {createDraftPull} from " +
        JSON.stringify(client) +
        "; await createDraftPull(process.argv.slice(2),process.argv[1]);";
      const invoke = (extra) =>
        run(process.execPath, ["--input-type=module", "-e", command, root, ...args, ...extra], {
          env: { ...cleanEnvironment(), HTTPS_PROXY: proxyAddress },
          allowFailure: true,
        });
      const bodyFile = join(await temporaryDirectory(t), "body.txt");
      await writeFile(bodyFile, "file contents must stay local");
      const refused = await invoke(["--body-file", bodyFile]);
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /Unknown option '--body-file'/);
      assert.deepEqual(tunnels, [], "file input must be refused before contacting the broker");
      const output = await invoke(["--body", body]);
      assert.equal(output.code, 0, output.stderr);
      assert.deepEqual(tunnels, ["127.0.0.1:443"]);
      const receipt = JSON.parse(output.stdout);
      assert.equal(receipt.operationId, operationId);
      assert.equal(receipt.head.ref, head);
      assert.equal(receipt.base.ref, base);
      assert.equal(receipt.draft, true);
      assert.equal(receipt.url, "https://github.com/" + b.repository + "/pull/" + receipt.number);
      assert.ok(
        !output.stdout.includes("must-not-escape"),
        "upstream nested credentials must never be returned",
      );
      const repeat = await send();
      assert.equal(repeat.status, 201);
      assert.deepEqual(
        JSON.parse(repeat.text),
        receipt,
        "same operation returns the committed safe projection",
      );
    } else {
      // Provider creates the PR and drops its response. We can inspect that projection here;
      // the production broker must preserve uncertainty rather than claim that evidence or re-POST.
      if (mode === "lost provider reply") {
        f.gh.disconnectAfterMutation("POST", path);
      }
      for (let i = 0; i < 2; i++) {
        const response = await send();
        assert.equal(response.status, 409);
        const value = JSON.parse(response.text);
        assert.equal(value.operationId, operationId);
        assert.equal(value.error, "outcome_unknown");
      }
    }
    const other = await send({ headers: { ...headers, "x-oce-operation-id": randomUUID() } });
    assert.equal(other.status, 409);
    assert.equal(JSON.parse(other.text).error, "operation_conflict");
    const changed = await send({ body: JSON.stringify({ ...packet, title: "different" }) });
    assert.equal(JSON.parse(changed.text).error, "operation_conflict");
    // An independently authenticated observer reconciles by reading, never by trying another create.
    // Its observation cannot be presented as a delivered result to the Agent which lost the reply.
    const observer = randomUUID();
    f.gh.acceptStatic(observer);
    const query = new URLSearchParams({ base, head: b.repository.split("/")[0] + ":" + head });
    const visible = await new Promise((resolve, reject) => {
      request(
        f.gh.origin + path + "?" + query,
        { ca: f.gh.tls.ca, headers: { authorization: "Bearer " + observer } },
        async (res) => {
          assert.equal(res.statusCode, 200);
          const chunks = [];
          for await (const chunk of res) {
            chunks.push(chunk);
          }
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        },
      )
        .once("error", reject)
        .end();
    });
    assert.equal(visible.length, 1);
    const [created] = visible;
    assert.equal(created.body, body);
    assert.equal(created.head.ref, head);
    assert.equal(created.base.ref, base);
    assert.equal(created.maintainer_can_modify, false);
    assert.equal(f.gh.pulls.size, 1);
    if (mode !== "lost provider reply") {
      assert.equal(observed()[0].usedBearer, true);
      assert.equal(observed()[0].forwardedOperationId, false);
    }
    assert.equal(observed()[0].apiVersion, "2026-03-10");
    assert.equal(observed()[0].tokenIndex, 1);
    assert.equal(
      observed().length,
      1,
      "exactly one provider create attempt, including ambiguous response",
    );
    await f.withdraw();
    assert.equal((await send()).status, 503, "cannot replay even a receipt after withdrawal");
    assert.equal(observed().length, 1);
    // A legitimate replacement with the identical grant and old client operation cannot obtain
    // the prior admission's receipt, a second permit, or a fresh token by trying this endpoint.
    const replacement = b.openSession();
    await f.admitReplacement(replacement.session.sessionId);
    const next = await send({
      headers: { ...headers, authorization: "Bearer " + replacement.bearer },
    });
    assert.equal(next.status, 409);
    assert.deepEqual(JSON.parse(next.text), { error: "operation_conflict" });
    assert.equal(observed().length, 1);
    assert.equal(f.gh.issuesOfTokens.length, 1, "no request-time mint or permission escalation");
  });
}
