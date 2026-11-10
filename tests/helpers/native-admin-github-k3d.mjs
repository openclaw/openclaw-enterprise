import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { temporaryDirectory } from "./temporary-directory.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));

// Serialized into this test's API Pod. Only the external GitHub protocol is
// simulated; the installed authentication, session, IAM and browser exchange run normally.
function installGithubFixture({ subject, callbackUrl }) {
  const originalFetch = globalThis.fetch;
  const token = `ghu_fixture_${subject}`;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === "https://github.com/login/oauth/access_token") {
      const request = new Request(input, init);
      const body = new URLSearchParams(await request.text());
      if (
        request.method !== "POST" ||
        body.get("code") !== `subject-${subject}` ||
        body.get("redirect_uri") !== callbackUrl
      ) {
        return json({ error: "bad_verification_code" }, 400);
      }
      return json({ access_token: token, token_type: "bearer" });
    }
    if (url.href === "https://api.github.com/user") {
      const request = new Request(input, init);
      return request.method === "GET" && request.headers.get("authorization") === `Bearer ${token}`
        ? json({ id: Number(subject), login: `fixture-${subject}` })
        : json({}, 401);
    }
    return originalFetch(input, init);
  };
}

/** Upgrade only the caller's disposable dev-up release; its normal teardown owns all resources. */
export async function enableInstalledGithubNativeAdmin({
  t,
  cluster,
  stateDirectory,
  kubectl,
  environment,
  recoveryUserId,
  consoleOrigin,
  agentDomain,
}) {
  const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
  assert.equal(state.cluster, cluster);
  assert.equal(state.deploymentMode, "k3d");
  assert.equal(state.platformNamespace, "oce-system");
  assert.equal(state.browserOrigin, consoleOrigin);
  assert.deepEqual(kubectl, [
    "--kubeconfig",
    join(stateDirectory, "kubeconfig"),
    "--context",
    `k3d-${cluster}`,
  ]);
  assert.ok(recoveryUserId);
  const namespace = state.platformNamespace;
  const release = "openclaw-enterprise";
  const helmScope = [
    "--kubeconfig",
    join(stateDirectory, "kubeconfig"),
    "--kube-context",
    `k3d-${cluster}`,
    "--namespace",
    namespace,
  ];
  const run = (command, args) =>
    execute(command, args, {
      cwd: repository,
      env: environment,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  const helm = process.env.OCC_HELM_BIN ?? "helm";
  const values = async () =>
    JSON.parse(
      (await run(helm, ["get", "values", release, ...helmScope, "--all", "-o", "json"])).stdout,
    );
  const before = await values();
  assert.equal(before.auth.baseUrl, consoleOrigin);
  assert.equal(before.auth.github.enabled, false);
  assert.equal(before.auth.google.enabled, false);
  assert.equal(before.auth.oidc.enabled, false);
  assert.equal(before.agentNativeAdmin.enabled, true);
  assert.equal(before.agentNativeAdmin.domain, agentDomain);
  assert.equal(before.gatewayRouting.sandbox.enabled, false);

  const directory = await temporaryDirectory(t, "oce-native-github-");
  const subject = String(randomInt(10_000_000, 99_999_999));
  const clientId = `fixture-native-${randomUUID()}`;
  const secretName = `native-github-${randomUUID()}`;
  const callbackUrl = `${consoleOrigin}/api/auth/providers/github/callback`;
  const secret = join(directory, "github-secret.json");
  await writeFile(
    secret,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: secretName, namespace },
      type: "Opaque",
      stringData: { "client-id": clientId, "client-secret": `fixture-secret-${randomUUID()}` },
    }),
    { mode: 0o600 },
  );
  await run("kubectl", [...kubectl, "create", "-f", secret]);

  const expected = structuredClone(before);
  expected.auth.recoveryUserId = recoveryUserId;
  expected.auth.passwordSignIn = "recovery-only";
  Object.assign(expected.auth.github, {
    enabled: true,
    secretName,
    clientIdKey: "client-id",
    clientSecretKey: "client-secret",
    allowedOrgs: [],
    allowedTeams: [],
    // No provider network is needed. Do not widen this test's API Internet access.
    egressCidrs: ["192.0.2.1/32"],
  });
  expected.agentNativeAdmin.sessionMode = "host-only-exchange";
  const valuesFile = join(directory, "values.json");
  await writeFile(valuesFile, JSON.stringify(expected), { mode: 0o600 });

  const preload = `data:text/javascript,${encodeURIComponent(
    `(${installGithubFixture.toString()})(${JSON.stringify({ subject, callbackUrl })});`,
  )}`;
  const renderer = join(directory, "provider-renderer.mjs");
  await writeFile(
    renderer,
    `#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const rendered = execFileSync("yq", ["eval-all", "-o=json", "-I=0", ".", "-"], {
  input: readFileSync(0), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
});
const resources = rendered.trim().split("\\n").map(JSON.parse).filter(Boolean);
const apis = resources.filter(item => item.kind === "Deployment" &&
  item.metadata.name === "openclaw-enterprise-api" &&
  (item.metadata.namespace ?? ${JSON.stringify(namespace)}) === ${JSON.stringify(namespace)} &&
  item.metadata.labels["app.kubernetes.io/instance"] === "openclaw-enterprise");
assert.equal(apis.length, 1, "expected only the owned API Deployment");
const api = apis[0].spec.template.spec.containers.find(item => item.name === "api");
assert.ok(api.args.includes("apps/controller/src/server.mjs"));
api.args.unshift("--import", ${JSON.stringify(preload)});
process.stdout.write(resources.map(item => JSON.stringify(item)).join("\\n---\\n"));
`,
    { mode: 0o700 },
  );
  // Helm records both the normal chart configuration and the isolated provider
  // preload. This is not a launcher GitHub mode or a production injection setting.
  await run(helm, [
    "upgrade",
    release,
    "deploy/helm/openclaw-enterprise",
    ...helmScope,
    "--reuse-values",
    "--values",
    valuesFile,
    "--post-renderer",
    renderer,
    "--wait",
    "--timeout",
    "4m",
  ]);
  assert.ok(isDeepStrictEqual(await values(), expected), "Helm changed unrelated installed values");
  const deployment = JSON.parse(
    (
      await run("kubectl", [
        ...kubectl,
        "-n",
        namespace,
        "get",
        "deployment",
        `${release}-api`,
        "-o",
        "json",
      ])
    ).stdout,
  );
  const api = deployment.spec.template.spec.containers.find(({ name }) => name === "api");
  assert.equal(api.image, before.images.controller);
  assert.deepEqual(api.args.slice(0, 2), ["--import", preload]);
  const configured = Object.fromEntries(api.env.map((entry) => [entry.name, entry]));
  for (const [name, value] of Object.entries({
    OCC_AUTH_GITHUB_RECOVERY_USER_ID: recoveryUserId,
    OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only",
    OCC_AGENT_NATIVE_ADMIN_SESSION_MODE: "host-only-exchange",
  })) {
    assert.equal(configured[name]?.value, value, name);
  }
  assert.equal(configured.OCC_AUTH_COOKIE_DOMAIN, undefined);
  for (const [name, key] of [
    ["OCC_AUTH_GITHUB_CLIENT_ID", "client-id"],
    ["OCC_AUTH_GITHUB_CLIENT_SECRET", "client-secret"],
  ]) {
    assert.deepEqual(configured[name]?.valueFrom?.secretKeyRef, { name: secretName, key });
  }
  const status = JSON.parse(
    (await run(helm, ["status", release, ...helmScope, "-o", "json"])).stdout,
  );
  assert.equal(status.info.status, "deployed");
  return {
    subject,
    parentCookieName: "__Host-openclaw_occ.session_token",
    releaseRevision: status.version,
    controllerImage: api.image,
    async authorizeRoute(route) {
      const url = new URL(route.request().url());
      assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
      assert.equal(url.searchParams.get("client_id"), clientId);
      assert.equal(url.searchParams.get("redirect_uri"), callbackUrl);
      const state = url.searchParams.get("state");
      assert.ok(state);
      const callback = new URL(callbackUrl);
      callback.searchParams.set("state", state);
      callback.searchParams.set("code", `subject-${subject}`);
      await route.fulfill({ status: 302, headers: { location: callback.href }, body: "" });
    },
  };
}
