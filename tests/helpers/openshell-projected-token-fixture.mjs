import assert from "node:assert/strict";
import { randomUUID, sign, verify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:https";
import { buffer } from "node:stream/consumers";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenShellJointGitIssuer } from "../../apps/controller/src/drivers/credential-gateway/openshell-joint-git-issuer.ts";
import { freePort, redeem } from "./openshell-git-token-grant.mjs";
import {
  createTlsMaterial,
  listen,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

export async function exerciseProjectedTokenGrant(t) {
  const tls = await createTlsMaterial(t);
  const dir = await temporaryDirectory(t);
  const audience = "https://127.0.0.1:" + (await freePort()) + "/token/git";
  const signer = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const placement = { namespace: "workspace-one", sandboxName: "sb-001", sandboxId: "sandbox-one" };
  const clusterIssuer = "https://kubernetes.example.test";
  const username = "system:serviceaccount:workspace-one:sandbox-sa";
  const policy = {
    assertionSource: "kubernetes-projected-token",
    clusterIssuer,
    namespace: placement.namespace,
    gatewayId: "gateway-one",
    supervisorServiceAccountName: "sandbox-sa",
    supervisorImageDigest: "sha256:" + "a".repeat(64),
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      namespace: placement.namespace,
      name: "os-supervisor-sandbox-one",
      uid: randomUUID(),
      resourceVersion: "41",
      labels: {
        "openshell.ai/sandbox-id": "sandbox-one",
        "openshell.ai/gateway-id": "gateway-one",
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/boundary-pair": "sandbox-one",
        "openshell.ai/boundary-role": "supervisor",
        "openshell.ai/component": "supervisor",
      },
      annotations: { "openshell.ai/sandbox-id": "sandbox-one" },
      ownerReferences: [
        {
          apiVersion: "agents.x-k8s.io/v1beta1",
          kind: "Sandbox",
          name: "sb-001",
          uid: randomUUID(),
        },
      ],
    },
    spec: {
      serviceAccountName: "sandbox-sa",
      containers: [
        {
          name: "supervisor",
          image: "fixture@" + policy.supervisorImageDigest,
          env: [{ name: "OPENSHELL_PROVIDER_PROJECTED_TOKEN_ENDPOINT", value: audience }],
          volumeMounts: [
            {
              name: "openshell-provider-assertion",
              mountPath: "/var/run/openshell/provider-assertion",
              readOnly: true,
            },
          ],
        },
      ],
      volumes: [
        {
          name: "openshell-provider-assertion",
          projected: {
            defaultMode: 0o440,
            sources: [{ serviceAccountToken: { path: "token", expirationSeconds: 600, audience } }],
          },
        },
      ],
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        { name: "supervisor", ready: true, restartCount: 0, state: { running: {} } },
      ],
    },
  };
  const assertion = (overrides = {}, key = signer.privateKey, raw) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: clusterIssuer,
      sub: username,
      aud: [audience],
      iat: now,
      nbf: now,
      exp: now + 600,
      "kubernetes.io": { pod: { name: pod.metadata.name, uid: pod.metadata.uid } },
      ...overrides,
    };
    const content =
      Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url") +
      "." +
      Buffer.from(raw ?? JSON.stringify(claims)).toString("base64url");
    return content + "." + sign("sha256", Buffer.from(content), key).toString("base64url");
  };
  const api = createServer(tls, async (q, res) => {
    const reply = (v, code = 200) =>
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (q.headers.authorization !== "Bearer synthetic-worker-identity") {
      return reply({}, 403);
    }
    if (
      q.method === "GET" &&
      q.url === "/api/v1/namespaces/workspace-one/pods/os-supervisor-sandbox-one"
    ) {
      return reply(pod);
    }
    if (q.method !== "POST" || q.url !== "/apis/authentication.k8s.io/v1/tokenreviews") {
      return reply({}, 403);
    }
    const body = JSON.parse(await buffer(q));
    const parts = body.spec.token.split(".");
    const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
    const authenticated = verify(
      "sha256",
      Buffer.from(parts.slice(0, 2).join(".")),
      signer.publicKey,
      Buffer.from(parts[2], "base64url"),
    );
    reply({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      status: {
        authenticated,
        audiences: body.spec.audiences,
        user: {
          username: claims.sub,
          extra: {
            "authentication.kubernetes.io/pod-name": [claims["kubernetes.io"].pod.name],
            "authentication.kubernetes.io/pod-uid": [claims["kubernetes.io"].pod.uid],
          },
        },
      },
    });
  });
  const origin = await listen(t, api);
  const kubeconfigPath = join(dir, "kubeconfig");
  await writeFile(
    kubeconfigPath,
    JSON.stringify({
      clusters: [
        {
          name: "test",
          cluster: { server: origin, "certificate-authority-data": tls.ca.toString("base64") },
        },
      ],
      users: [{ name: "worker", user: { token: "synthetic-worker-identity" } }],
      contexts: [{ name: "test", context: { cluster: "test", user: "worker" } }],
    }),
    { mode: 0o600 },
  );
  const issuer = new OpenShellJointGitIssuer(audience, {
    ...policy,
    authentication: { mode: "kubeconfig", context: "test", kubeconfigPath },
  });
  const server = await issuer.listen("127.0.0.1", tls);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const token = assertion();
  const podUid = pod.metadata.uid;
  const host = "api.github.com";
  let reads = 0;
  const permit = (act, current = async () => true) => {
    const requestId = randomUUID();
    assert.ok(
      issuer.permit({
        ...placement,
        podUid,
        host,
        requestId,
        until: Date.now() + 3000,
        lifetime: t.signal,
        current,
        read: async () => {
          reads++;
          await act?.();
          return {
            value: "synthetic-test-response",
            expiresAt: new Date(Date.now() + 12000).toISOString(),
          };
        },
      }),
    );
    return requestId;
  };
  const id = permit();
  const wrong = assertion({
    "kubernetes.io": { pod: { name: pod.metadata.name, uid: randomUUID() } },
  });
  assert.equal((await redeem(audience, tls, id, host, wrong)).status, 403);
  assert.equal(reads, 0);
  assert.equal((await redeem(audience, tls, id, host, token)).status, 200);
  assert.equal((await redeem(audience, tls, id, host, token)).status, 403);
  assert.equal(reads, 1);
  // B sees a different Pod while A waits for its last receipt check. A's positive
  // snapshots must not authorize a send after B has observed replacement.
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let checks = 0;
  const paused = permit(undefined, async () => {
    if (++checks === 2) {
      entered.resolve();
      await release.promise;
    }
    return true;
  });
  const pending = redeem(audience, tls, paused, host, token);
  await entered.promise;
  pod.metadata.uid = randomUUID();
  try {
    assert.equal((await redeem(audience, tls, permit(), host, token)).status, 403);
  } finally {
    release.resolve();
  }
  assert.equal((await pending).status, 403);
  pod.metadata.uid = podUid;
  const later = permit(() => {
    pod.metadata.uid = randomUUID();
  });
  assert.equal((await redeem(audience, tls, later, host, token)).status, 403);
  assert.equal(reads, 3);
  const after = permit();
  assert.equal((await redeem(audience, tls, after, host, token)).status, 403);
  assert.equal(reads, 3);
}
