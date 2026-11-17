import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { createQaAgent, createQaInstallation } from "./qa-installation.mjs";

type Fixture = Awaited<ReturnType<typeof createQaInstallation>>;
type Agent = Awaited<ReturnType<typeof createQaAgent>>;

/** Installed route isolation and NetworkPolicy proof; no model response is substituted. */
export async function verifyQaHttpChatIsolation(f: Fixture, agent: Agent): Promise<void> {
  const gateway = await f.pod(agent, "gateway");
  const image = gateway.spec.containers.find((container) => container.name === "gateway").image;
  assert.match(image, /@sha256:[a-f0-9]{64}$/, "the installed runtime must use an immutable image");
  const routing = f.configuration.drivers.compute.configuration.gatewayRouting;
  const authority = routing.endpointPort
    ? `${routing.hostname}:${routing.endpointPort}`
    : routing.hostname;
  const path = `/http-chat/namespaces/${agent.namespaceId}/agents/${agent.id}/revisions/${agent.revision.id}/v1/chat/completions`;
  // Run as OCC's existing private proxy client. Only status codes leave the process;
  // the transport key stays in its existing mounted file and never appears in arguments.
  const probe = `
    const fs = require('node:fs');
    const key = fs.readFileSync(process.env.OCC_GATEWAY_API_KEY_PATH, 'utf8').trim();
    const url = process.argv[1];
    (async () => {
      const results = [];
      for (const [method, target] of [
        ['GET', url], ['HEAD', url],
        ['GET', url.replace('/chat/completions', '/models')],
        ['POST', url.replace('/chat/completions', '/embeddings')],
        ['POST', url.replace('/chat/completions', '/responses')],
      ]) {
        const response = await fetch(target, { method, headers: { 'x-api-key': key, 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: '{}' } : {}), redirect: 'manual', signal: AbortSignal.timeout(10000) });
        results.push(response.status);
        await response.body?.cancel();
      }
      console.log(JSON.stringify(results));
    })().catch(() => { console.error('Private route probe failed'); process.exitCode = 1; });
  `;
  const args = ["node", "-e", probe, `https://${authority}${path}`];
  const output =
    f.controlPlane === "compose"
      ? await f.compose("exec", "-T", "controller", ...args)
      : await f.kubectl(
          "-n",
          f.state.platformNamespace,
          "exec",
          "deployment/openclaw-enterprise-api",
          "--",
          ...args,
        );
  assert.deepEqual(JSON.parse(output), [404, 404, 404, 404, 404]);

  const name = `http-chat-probe-${randomUUID().slice(0, 8)}`;
  const port = gateway.spec.containers
    .find((container) => container.name === "gateway")
    .ports.find((port) => port.name === "http").containerPort;
  const missingAuthority = await f.execRole(agent, "gateway", [
    "node",
    "-e",
    `
    (async () => {
      const results = [];
      for (const headers of [{}, {'x-occ-identity':'occ-workspace-files'}, {'x-openclaw-scopes':'operator.sessions.write'}]) {
        const response = await fetch('http://127.0.0.1:'+process.argv[1]+'/v1/chat/completions', {
          method:'POST', headers:{'content-type':'application/json',...headers},
          body:JSON.stringify({messages:[{role:'user',content:'Reply briefly.'}]}), signal:AbortSignal.timeout(10000),
        });
        results.push(response.status); await response.body?.cancel();
      }
      console.log(JSON.stringify(results));
    })().catch(() => { console.error('Direct Gateway probe failed'); process.exitCode=1; });
  `,
    String(port),
  ]);
  assert.ok(
    JSON.parse(missingAuthority.stdout).every((status: number) => status === 401 || status === 403),
  );
  try {
    // This Pod has no Agent identity or permitted peer labels. A reachable HTTP denial
    // would fail the test: the default-deny network policy must stop the connection.
    await f.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, namespace: gateway.metadata.namespace },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "probe",
            image,
            command: [
              "node",
              "-e",
              `fetch(process.argv[1], {signal: AbortSignal.timeout(5000)}).then(() => {console.log('REACHABLE');process.exitCode=1}, (error) => {if(error.name==='TimeoutError'||['ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','ETIMEDOUT'].includes(error.cause?.code)){console.log('BLOCKED')}else{console.log('UNEXPECTED');process.exitCode=1}})`,
              `http://${gateway.status.podIP}:${port}/healthz`,
            ],
            resources: {
              requests: { cpu: "10m", memory: "64Mi" },
              limits: { cpu: "100m", memory: "128Mi" },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
          },
        ],
      },
    });
    const completed = await f.waitFor(
      "HTTP chat network probe",
      async () => {
        const pod = await f.resource("pod", name, gateway.metadata.namespace);
        return ["Succeeded", "Failed"].includes(pod.status?.phase) ? pod : undefined;
      },
      90_000,
    );
    assert.equal(completed.status.phase, "Succeeded");
    assert.equal(
      (await f.kubectl("-n", gateway.metadata.namespace, "logs", name)).trim(),
      "BLOCKED",
    );
  } finally {
    await f.kubectl(
      "-n",
      gateway.metadata.namespace,
      "delete",
      "pod",
      name,
      "--ignore-not-found",
      "--wait=true",
      "--timeout=60s",
    );
  }
}
