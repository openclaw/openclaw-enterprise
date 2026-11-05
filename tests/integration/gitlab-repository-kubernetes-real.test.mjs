import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { validateExplicitK3dLoopbackContext } from "../helpers/kubernetes-real.mjs";
import {
  createInstalledRepositoryFixture,
  readInstalledCredentialSession,
  readProtectedInput,
} from "../helpers/repository-credentials-installed.mjs";

const selected = process.env.OCC_TEST_GITLAB_REPOSITORY_KUBERNETES_REAL === "1";
const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function observeGitLab(token, path, method = "GET", body) {
  const response = await fetch(`https://gitlab.com/api/v4${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "private-token": token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => undefined) };
}

test(
  "installed GitLab development authority admits, delivers, refuses, and disposes Agent sessions",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_GITLAB_REPOSITORY_KUBERNETES_REAL=1 with an explicit disposable k3d cluster, authorized GitLab token, model key and immutable images.",
    timeout: 1_800_000,
  },
  async (context) => {
    await validateExplicitK3dLoopbackContext(selection);
    const project = process.env.GITLAB_TEST_PROJECT;
    const projectId = process.env.GITLAB_TEST_PROJECT_ID;
    const tokenFile = process.env.GITLAB_TEST_TOKEN_FILE;
    assert.match(project ?? "", /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.match(projectId ?? "", /^[1-9][0-9]{0,15}$/);
    assert.ok(tokenFile?.startsWith("/"), "GITLAB_TEST_TOKEN_FILE must be absolute");
    const images = Object.fromEntries(
      [
        ["controller", "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE"],
        ["runtime", "OCC_TEST_KUBERNETES_RUNTIME_IMAGE"],
        ["postgres", "OCC_TEST_PRODUCTION_POSTGRES_IMAGE"],
        ["node", "OCC_TEST_PRODUCTION_NODE_IMAGE"],
        ["credentials", "OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE"],
      ].map(([name, variable]) => {
        const value = process.env[variable];
        assert.match(value ?? "", /^\S+@sha256:[a-f0-9]{64}$/, `${variable} must be immutable`);
        return [name, value];
      }),
    );
    const upstreamCidrs = (process.env.OCC_TEST_GITLAB_UPSTREAM_CIDRS ?? "")
      .split(",")
      .filter(Boolean);
    assert.equal(new Set(upstreamCidrs).size, upstreamCidrs.length);
    assert.ok(
      upstreamCidrs.length > 0 &&
        upstreamCidrs.every((cidr) => /^\d+\.\d+\.\d+\.\d+\/32$/.test(cidr)),
      "explicit public GitLab IPv4 /32 egress is required",
    );
    const modelKey = process.env.OPENAI_API_KEY;
    const model = process.env.OCC_TEST_OPENAI_MODEL?.replace(/^(?:openai|codex)\//u, "");
    assert.ok(modelKey && model, "an authorized model credential and model are required");

    const f = await createInstalledRepositoryFixture(context, {
      selection,
      images,
      modelKey,
      executionMode: "embedded",
    });
    const token = await readProtectedInput(tokenFile, "GitLab token input");
    f.secrets.push(token);
    const observed = await observeGitLab(token, `/projects/${projectId}`);
    assert.equal(observed.status, 200);
    assert.equal(observed.data.path_with_namespace, project);

    const backendId = "gitlab-development";
    const driverId = "gitlab-development-repository";
    const repositoryValues = {
      enabled: true,
      authority: "gitlab-token-development",
      image: images.credentials,
      serviceName: "git",
      backendId,
      registryConfigMapName: "repository-registry-v1",
      registryKey: "registry.json",
      serviceConfigSecretName: "repository-service-config",
      serviceConfigKey: "config.json",
      tokenSecretName: "repository-gitlab-token",
      tokenKey: "token",
      tlsSecretName: "repository-tls",
      publicCaSecretName: "repository-public-ca",
      publicCaKey: "ca.crt",
      upstreamCidrs,
    };
    const renderedBroker = await f.renderRepositoryCredentials(repositoryValues);
    await f.apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: f.metadata("repository-registry-v1"),
      immutable: true,
      data: {
        "registry.json": JSON.stringify({
          version: 1,
          backendId,
          providerInstanceId: "gitlab-development",
          configVersion: "1",
          maximumDurationSeconds: 900,
          projects: [
            {
              projectId,
              path: project,
              namespaces: [
                {
                  namespaceId: f.namespace.id,
                  profiles: ["git-read"],
                  pushRefAllowlist: [],
                },
              ],
            },
          ],
        }),
      },
    });
    await f.run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-keyout",
      join(f.directory, "repository-tls.key"),
      "-out",
      join(f.directory, "repository-tls.crt"),
      "-subj",
      "/CN=repository-credentials",
      "-addext",
      `subjectAltName=DNS:${new URL(renderedBroker.origin).hostname}`,
    ]);
    const tlsKey = await readFile(join(f.directory, "repository-tls.key"), "utf8");
    const tlsCert = await readFile(join(f.directory, "repository-tls.crt"), "utf8");
    f.secrets.push(tlsKey);
    await f.createSecret("repository-gitlab-token", { token });
    await f.createSecret("repository-tls", { "tls.crt": tlsCert, "tls.key": tlsKey });
    await f.createSecret("repository-public-ca", { "ca.crt": tlsCert });
    await f.createSecret("repository-service-config", {
      "config.json": JSON.stringify({
        gateway: {
          listen: "0.0.0.0:8443",
          controlSocket: "/run/openclaw/repository-control/private/control.sock",
          tlsCertFile: "/etc/openclaw/repository-inputs/tls.crt",
          tlsKeyFile: "/etc/openclaw/repository-inputs/tls.key",
        },
        sessionPolicy: {
          maximumDurationSeconds: 900,
          defaultProfile: "git-read",
          allowedProfiles: ["git-read"],
        },
        limits: { gitPushInputBytes: 67108864 },
        backend: {
          kind: "gitlab-token",
          providerInstanceId: "gitlab-development",
          configVersion: "1",
          projectId,
          project,
          namespaceId: f.namespace.id,
          tokenFile: "/etc/openclaw/repository-inputs/token",
          developmentOnly: true,
          pushRefAllowlist: [],
          allowGraphql: false,
          leaseSeconds: 900,
        },
      }),
    });
    f.configuration.backend = [
      {
        id: backendId,
        type: "gitlab",
        configuration: { registryPath: "/etc/openclaw/repository-registry/registry.json" },
        drivers: { repo: driverId },
      },
    ];
    f.configuration.repository = {
      id: driverId,
      configuration: { sessionDurationSeconds: 900 },
      nativeSender: {
        controlSocket: "/run/openclaw/repository-control/private/control.sock",
        publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
      },
    };
    f.configuration.drivers.compute.configuration.network.repositoryCredentials = {
      namespace: f.system,
      podLabels: {
        "app.kubernetes.io/name": "openclaw-enterprise",
        "app.kubernetes.io/instance": f.release,
        "app.kubernetes.io/component": "worker",
      },
      port: 8443,
    };
    assert.deepEqual(await f.upgrade(repositoryValues), renderedBroker);

    const workerPod = await f.waitFor("worker and GitLab repository service Ready", async () => {
      const candidates = (await f.kubernetes.resources("pods", f.system)).filter(
        (pod) =>
          pod.metadata.labels?.["app.kubernetes.io/component"] === "worker" &&
          !pod.metadata.deletionTimestamp &&
          pod.status.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
      );
      assert.ok(candidates.length <= 1);
      return candidates[0] ?? false;
    });
    const broker = workerPod.spec.containers.find(
      (container) => container.name === "repository-credentials",
    );
    assert.equal(broker.image, images.credentials);
    assert.deepEqual(broker.args.slice(-2), ["--authority", "gitlab-token-development"]);
    const tokenMounters = [...(workerPod.spec.initContainers ?? []), ...workerPod.spec.containers]
      .filter((container) =>
        (container.volumeMounts ?? []).some(({ name }) => name === "repository-inputs"),
      )
      .map((container) => container.name);
    assert.deepEqual(tokenMounters, ["repository-credentials"]);
    const startupLog = await f.kubectl(
      "-n",
      f.system,
      "logs",
      workerPod.metadata.name,
      "-c",
      "repository-credentials",
    );
    assert.match(startupLog, /"authority":"gitlab-token-development"/);
    assert.match(startupLog, /"tokenClass":"personal"/);
    await f.record("GitLab repository service started from projected Kubernetes inputs", {
      workerPod: workerPod.metadata.name,
      brokerImageId: workerPod.status.containerStatuses.find(
        (status) => status.name === "repository-credentials",
      )?.imageID,
      authority: "gitlab-token-development",
      tokenClass: "personal",
      tokenMounters,
    });

    const native = createHarnessConfiguration("openclaw", model);
    native.agents.defaults.skipBootstrap = true;
    native.agents.defaults.workspace = "/home/node/.openclaw/workspace";
    native.agents.defaults.sandbox = { mode: "off" };
    native.tools = { allow: ["exec", "process"], exec: { host: "gateway", mode: "full" } };
    const foreign = await f.api("POST", "/namespaces", { name: `gitlab-denied-${f.suffix}` }, 201);
    try {
      const foreignNamespace = await f.waitFor("unauthorized backing namespace", async () => {
        const list = JSON.parse(
          await f.kubectl(
            "get",
            "namespaces",
            "-l",
            `openclaw.dev/namespace=${foreign.id}`,
            "-o",
            "json",
          ),
        );
        assert.ok(list.items.length <= 1);
        return list.items[0]?.metadata.name ?? false;
      });
      const grantNamespaceRole = async (bindingName, clusterRole, account) => {
        await f.apply({
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          metadata: f.metadata(bindingName, foreignNamespace),
          roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "ClusterRole",
            name: `${f.release}-${clusterRole}`,
          },
          subjects: [
            { kind: "ServiceAccount", name: `openclaw-enterprise-${account}`, namespace: f.system },
          ],
        });
      };
      await grantNamespaceRole("gitlab-tenant-worker", "openclaw-tenant-worker", "worker");
      await grantNamespaceRole(
        "gitlab-tenant-api-configuration",
        "openclaw-tenant-configuration",
        "api",
      );
      await grantNamespaceRole("gitlab-tenant-api-secrets", "openclaw-tenant-api", "api");
      await grantNamespaceRole(
        "gitlab-tenant-gateway-observer",
        "openclaw-gateway-observer",
        "api",
      );
      await f.waitFor(
        "unauthorized Namespace ready",
        async () => (await f.api("GET", `/namespaces/${foreign.id}`)).status === "ready",
      );
      const foreignSecret = await f.api(
        "POST",
        `/namespaces/${foreign.id}/secrets`,
        { name: "repository-model", value: modelKey },
        201,
      );
      const foreignConfiguration = await f.api(
        "POST",
        `/namespaces/${foreign.id}/configurations`,
        { kind: "agent", values: native },
        201,
      );
      const denied = await f.externalRequest("POST", `/namespaces/${foreign.id}/agents`, {
        name: `gitlab-denied-${f.suffix}`,
        configurationId: foreignConfiguration.id,
        executionMode: "embedded",
        harnessAuth: { method: "api_key", source: foreignSecret.ref },
        repositoryBindings: [{ repositoryRef: projectId, profile: "git-read" }],
      });
      assert.equal(denied.status, 400, "an unauthorized Namespace must not admit the binding");
      await f.record("Unauthorized Namespace repository binding refused", {
        namespaceId: foreign.id,
        status: denied.status,
      });
    } finally {
      await f.api("DELETE", `/namespaces/${foreign.id}`, undefined, 202).catch(() => undefined);
    }

    const secret = await f.api(
      "POST",
      `/namespaces/${f.namespace.id}/secrets`,
      { name: "repository-model", value: modelKey },
      201,
    );
    const agentConfiguration = await f.api(
      "POST",
      `/namespaces/${f.namespace.id}/configurations`,
      { kind: "agent", values: native },
      201,
    );
    const agent = await f.api(
      "POST",
      `/namespaces/${f.namespace.id}/agents`,
      {
        name: `gitlab-${f.suffix}`,
        configurationId: agentConfiguration.id,
        executionMode: "embedded",
        harnessAuth: { method: "api_key", source: secret.ref },
        repositoryBindings: [{ repositoryRef: projectId, profile: "git-read" }],
      },
      201,
    );
    const agentPath = `/namespaces/${f.namespace.id}/agents/${agent.id}`;
    const grant = await f.sql(
      `WITH principal AS (SELECT service_principal_id FROM occ.agents WHERE namespace_id=${sqlLiteral(f.namespace.id)} AND id=${sqlLiteral(agent.id)}), role AS (INSERT INTO occ.iam_roles (id,namespace_id,name,permissions) SELECT ${sqlLiteral(`role-${f.suffix}`)},${sqlLiteral(f.namespace.id)},'Harness Secret operate','[{"action":"operate","resourceKind":"secret"}]'::jsonb FROM principal RETURNING id), binding AS (INSERT INTO occ.iam_access_bindings (id,namespace_id,identity_subject_id,role_id,resource_kind,resource_id) SELECT ${sqlLiteral(`binding-${f.suffix}`)},${sqlLiteral(f.namespace.id)},principal.service_principal_id,role.id,'secret',${sqlLiteral(secret.id)} FROM principal CROSS JOIN role RETURNING id) SELECT count(*) FROM binding;`,
    );
    assert.equal(grant, "1");
    await f.api("POST", `${agentPath}/runtime-credentials`, {}, 200);
    const revision = await f.api("POST", `${agentPath}/deploy`, undefined, 202);
    assert.deepEqual(revision.repositoryCredentials.bindings, [
      { repositoryRef: projectId, profile: "git-read" },
    ]);
    await f.waitFor(
      "admitted GitLab Agent revision active",
      async () => (await f.api("GET", agentPath)).activeRevisionId === revision.id,
      300000,
    );
    const gateway = await f.waitFor("one Ready Pod serving the admitted GitLab Agent", async () => {
      const candidates = (
        await f.kubernetes.resources(
          "pods",
          f.tenant,
          "-l",
          `openclaw.dev/agent=${agent.id},openclaw.dev/workload-role=gateway`,
        )
      ).filter(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          pod.status.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
      );
      assert.ok(candidates.length <= 1);
      return candidates[0] ?? false;
    });
    const gatewayContainer = gateway.spec.containers.find(
      (container) => container.name === "gateway",
    );
    assert.ok(
      gatewayContainer.env
        .find((value) => value.name === "PATH")
        ?.value.startsWith("/opt/oce/repository-credentials/bin:"),
      "the Agent Pod must receive the repository client",
    );
    assert.ok(
      !gatewayContainer.env.some((value) =>
        ["GITLAB_TOKEN", "GITLAB_PRIVATE_TOKEN"].includes(value.name),
      ),
      "the Agent Pod must not receive the GitLab token directly",
    );
    const modelEnvironment = gatewayContainer.env.find((value) => value.name === "OPENAI_API_KEY");
    assert.ok(
      modelEnvironment?.valueFrom?.secretKeyRef && modelEnvironment.value === undefined,
      "the embedded Agent runtime must receive the model credential only as a Secret projection",
    );
    const ingressPolicy = await f.kubernetes.resource(
      "networkpolicy",
      "openclaw-enterprise-prepared-repository-ingress",
      f.system,
    );
    await f.record("Admitted revision repository ingress topology", {
      harness: revision.harness,
      servicePrincipalId: revision.servicePrincipalId,
      ingress: ingressPolicy.spec?.ingress,
    });
    const ingressPeer = ingressPolicy.spec?.ingress?.[0]?.from?.[0];
    const ingressLabels = ingressPeer?.podSelector?.matchLabels ?? {};
    assert.deepEqual(ingressPeer?.namespaceSelector?.matchLabels, {
      "kubernetes.io/metadata.name": f.tenant,
    });
    assert.equal(ingressLabels["openclaw.dev/namespace"], f.namespace.id);
    assert.equal(ingressLabels["openclaw.dev/revision"], revision.id);
    assert.equal(ingressLabels["openclaw.dev/agent"], agent.id);
    assert.equal(ingressLabels["openclaw.dev/service-principal"], `service-agent-${agent.id}`);
    assert.equal(ingressLabels["openclaw.dev/workload-role"], "gateway");
    assert.equal(ingressLabels["openclaw.dev/network-profile"], "broad-egress-v1");
    const execInGateway = (script, args = [], options = {}) =>
      f.run(
        "kubectl",
        [
          ...f.kubernetes.kubectlArguments([]),
          "-n",
          gateway.metadata.namespace,
          "exec",
          gateway.metadata.name,
          "-c",
          "gateway",
          "--",
          "env",
          "-u",
          "OPENAI_API_KEY",
          "sh",
          "-c",
          script,
          ...args,
        ],
        options,
      );
    const checkout = "/home/node/.openclaw/workspace/gitlab-proof";
    await f.record("Agent Pod received projected repository and model credentials", {
      gatewayPod: gateway.metadata.name,
    });
    await execInGateway(`git clone https://gitlab.com/${project}.git ${JSON.stringify(checkout)}`);
    await f.record("Authorized GitLab read succeeded from the Agent Pod", {
      gatewayPod: gateway.metadata.name,
    });
    await execInGateway(
      `cd ${JSON.stringify(checkout)} && printf '%s\\n' installed-gitlab-proof > proof.txt && git add proof.txt && git -c user.name='OpenClaw Proof' -c user.email='proof@example.invalid' commit -m 'installed GitLab proof'`,
    );
    await f.record("Authorized repository material supported an in-Pod commit", {
      gatewayPod: gateway.metadata.name,
    });
    const forbiddenBranch = `gitlab-forbidden-${f.suffix}`;
    const pushOutput = await execInGateway(
      `cd ${JSON.stringify(checkout)} && git push origin HEAD:refs/heads/${forbiddenBranch} 2>&1`,
      [],
      { allowExitCodes: [0, 1, 128], timeout: 60000 },
    );
    assert.match(
      pushOutput,
      /error: 400|pre-dispatch|request_refused|unsupported-request|push-ref/i,
    );
    await f.record("Forbidden GitLab push refused before dispatch", {
      gatewayPod: gateway.metadata.name,
    });
    const denialLog = await f.kubectl(
      "-n",
      f.system,
      "logs",
      workerPod.metadata.name,
      "-c",
      "repository-credentials",
    );
    assert.match(denialLog, /"reason":"request_refused"/);
    assert.match(denialLog, /"reasonCode":"unsupported-request"/);
    const forbiddenBranchObserver = await observeGitLab(
      token,
      `/projects/${projectId}/repository/branches/${forbiddenBranch}`,
    );
    assert.equal(forbiddenBranchObserver.status, 404);
    await f.record("GitLab Pod read allowed and forbidden push refused before dispatch", {
      agentId: agent.id,
      revisionId: revision.id,
      gatewayPod: gateway.metadata.name,
      allowedRead: observed.data.path_with_namespace,
      forbiddenBranchAbsent: true,
      denialReason: "request_refused",
      denialReasonCode: "unsupported-request",
    });

    const attempts = JSON.parse(
      await f.sql(
        `SELECT coalesce(json_agg(json_build_object('sessionId',session_id,'repositoryRef',repository_ref,'phase',phase)), '[]') FROM occ.repository_session_attempts WHERE namespace_id=${sqlLiteral(f.namespace.id)} AND agent_id=${sqlLiteral(agent.id)} AND revision_id=${sqlLiteral(revision.id)};`,
      ),
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].phase, "open");
    const executeWorker = (script, args, timeout) =>
      f.run(
        "kubectl",
        [
          ...f.kubernetes.kubectlArguments([]),
          "-n",
          f.system,
          "exec",
          workerPod.metadata.name,
          "-c",
          "worker",
          "--",
          "node",
          "-e",
          script,
          ...args,
        ],
        { timeout },
      );
    const readSession = (id) => readInstalledCredentialSession(executeWorker, id);
    const opened = await readSession(attempts[0].sessionId);
    assert.equal(opened.state, "OPEN");

    const fetchLoop = execInGateway(
      `cd ${JSON.stringify(checkout)}; for i in 1 2 3 4 5 6 7 8 9 10; do git fetch origin >/dev/null 2>&1; printf '%s:%s\\n' "$i" "$?"; sleep 1; done`,
      [],
      { timeout: 30000, allowExitCodes: [0, 1] },
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await f.api("POST", `${agentPath}/stop`, undefined, 202);
    const fetchResults = await fetchLoop.catch(() => "");
    await f.waitFor("GitLab Agent stop and session disposal", async () => {
      const current = await f.api("GET", agentPath);
      const pods = (
        await f.kubernetes.resources("pods", f.tenant, "-l", `openclaw.dev/agent=${agent.id}`)
      ).filter((pod) => !pod.metadata.deletionTimestamp);
      const pending = await f.sql(
        `SELECT count(*) FROM occ.repository_session_attempts WHERE namespace_id=${sqlLiteral(f.namespace.id)} AND agent_id=${sqlLiteral(agent.id)} AND phase IN ('opening','open','closing');`,
      );
      return (
        current.desiredRuntimeState === "stopped" &&
        !current.activeRevisionId &&
        pods.length === 0 &&
        pending === "0"
      );
    });
    const disposed = await readSession(attempts[0].sessionId);
    assert.equal(disposed.state, "DISPOSED");
    assert.equal(disposed.activeUses, 0);
    await f.record("GitLab Agent stop disposed the existing repository session", {
      sessionId: attempts[0].sessionId,
      state: disposed.state,
      fetchObservedAfterWithdrawal: fetchResults !== "",
    });
  },
);
