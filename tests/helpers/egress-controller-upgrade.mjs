import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Check } from "typebox/value";
import { CredentialSourceId } from "../../packages/contracts/src/index.ts";
import { assertConnectedResponse, protectedSourceBody } from "./egress-connected-inputs.mjs";
import { selectLiveControllerPods } from "./egress-installed-stack.mjs";
import { waitFor } from "./wait-for.mjs";

const retirement = {
  code: "RESOURCE_CONFLICT",
  message:
    "The selected Driver has retired new uses of this protected static credential provider. Ask an Installation administrator to configure a supported model access path.",
};

function runningIdentity(pod, name) {
  const status = [
    ...(pod.status?.containerStatuses ?? []),
    ...(pod.status?.initContainerStatuses ?? []),
  ].find((entry) => entry.name === name);
  assert.ok(
    status?.containerID && status.imageID && status.state?.running?.startedAt,
    "a real running container identity is required",
  );
  return {
    containerID: status.containerID,
    imageID: status.imageID,
    startedAt: status.state.running.startedAt,
    restartCount: status.restartCount,
  };
}

function configurationHash(pod, container) {
  const volumes = pod.spec.volumes ?? [];
  const tokenVolumes = new Set(
    volumes
      .filter(
        (volume) =>
          /^kube-api-access-[a-z0-9]+$/.test(volume.name) &&
          volume.projected?.sources?.some((source) => source.serviceAccountToken),
      )
      .map(({ name }) => name),
  );
  const normalize = (entry) => ({
    ...entry,
    ...(tokenVolumes.has(entry.name) && { name: "kube-api-access" }),
  });
  // Only normalize the API server's random projected-volume name. Keep the
  // token projection, mounts and every configured input in the comparison.
  const configuration = {
    args: container.args,
    command: container.command,
    env: container.env,
    envFrom: container.envFrom,
    volumeMounts: container.volumeMounts?.map(normalize),
    volumes: volumes.map(normalize),
    serviceAccountName: pod.spec.serviceAccountName,
  };
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

function controllerIdentities(pods, expectedImage) {
  assert.equal(pods.length, 2, "the disposable upgrade requires one API and one Worker Pod");
  return ["api", "worker"].map((component) => {
    const matches = pods.filter(
      (pod) => pod.metadata.labels?.["app.kubernetes.io/component"] === component,
    );
    assert.equal(matches.length, 1);
    const pod = matches[0];
    const containers = [...(pod.spec.containers ?? []), ...(pod.spec.initContainers ?? [])];
    const container = containers.find(({ name }) => name === component);
    assert.equal(
      container?.image,
      expectedImage,
      "the application container must use the selected image",
    );
    const entry = component === "api" ? "server" : "worker";
    assert.ok(
      container.args?.includes(`apps/controller/src/${entry}.mjs`),
      "select the actual controller entrypoint",
    );
    assert.ok(pod.metadata.uid);
    return {
      component,
      name: pod.metadata.name,
      uid: pod.metadata.uid,
      ...runningIdentity(pod, component),
      // A controller-only replacement must preserve its installed configuration.
      configurationSha256: configurationHash(pod, container),
    };
  });
}

async function observeControllerIdentities(setup, pods, expectedImage) {
  const identities = controllerIdentities(pods, expectedImage);
  const observed = [];
  for (const identity of identities) {
    const pod = pods.find(({ metadata }) => metadata.uid === identity.uid);
    const container = [...pod.spec.containers, ...(pod.spec.initContainers ?? [])].find(
      ({ name }) => name === identity.component,
    );
    assert.equal(
      container.env?.find(({ name }) => name === "OCC_CONFIG_PATH")?.value,
      "/etc/openclaw/installation/installation.yaml",
      "hash the selected production Installation file",
    );
    const mount = container.volumeMounts.find(
      ({ mountPath }) => mountPath === "/etc/openclaw/installation",
    );
    const volume = pod.spec.volumes.find(({ name }) => name === mount?.name);
    assert.ok(
      mount?.readOnly && volume?.secret?.items?.some(({ path }) => path === "installation.yaml"),
      "select the production controller's mounted Installation input",
    );
    // Hash only the mounted Installation file, inside its owning container. Never
    // return its bytes or read unrelated Secrets and rotating identity projections.
    const digest = await setup.f.kubectl(
      "exec",
      identity.name,
      "--namespace",
      setup.input.controllerNamespace,
      "--container",
      identity.component,
      "--",
      "node",
      "-e",
      'const fs = require("node:fs"); const crypto = require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync("/etc/openclaw/installation/installation.yaml")).digest("hex"));',
    );
    assert.match(digest, /^[a-f0-9]{64}$/);
    observed.push({ ...identity, installationSha256: digest });
  }
  assert.equal(observed[0].installationSha256, observed[1].installationSha256);
  return observed;
}

function supplierIdentities(pods) {
  return pods
    .map((pod) => ({
      name: pod.metadata.name,
      uid: pod.metadata.uid,
      containers: pod.spec.containers.map(({ name, image }) => ({
        name,
        image,
        ...runningIdentity(pod, name),
      })),
    }))
    .sort((a, b) => a.uid.localeCompare(b.uid));
}

async function retainedState(stack, deployment) {
  const { pool, namespace } = stack;
  const { agent } = deployment;
  // Read metadata only: Secret values remain in their owning Driver. These real
  // database rows expose generation and owner changes that API projections omit.
  const observed = await pool.query(
    `SELECT jsonb_build_object(
    'sources', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM occ.credential_sources s WHERE namespace_id = $1),
    'secretRefs', (SELECT jsonb_agg(to_jsonb(s) ORDER BY credential_source_id, field) FROM occ.credential_source_secrets s WHERE namespace_id = $1),
    'revisions', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM occ.agent_revisions r WHERE namespace_id = $1 AND agent_id = $2),
    'installations', (SELECT jsonb_agg(to_jsonb(i) ORDER BY sender_id, sandbox_id) FROM occ.egress_installations i WHERE namespace_id = $1 AND agent_id = $2),
    'work', (SELECT jsonb_agg(to_jsonb(w) ORDER BY idempotency_key) FROM occ.controller_work w WHERE namespace_id = $1)
    ) AS state`,
    [namespace.id, agent.id],
  );
  return observed.rows[0].state;
}

export async function prepareControllerUpgrade(
  setup,
  stack,
  evidence,
  owned,
  deployment,
  installed,
) {
  const { input, controller } = setup;
  const { api, runId, credentials, checkpoint } = evidence;
  const { namespacePath, pool, namespace } = stack;
  const replacement = await owned.create("secrets", {
    name: `egress-upgrade-${runId}`,
    value: credentials.initial,
  });
  const created = await owned.create(
    "credential-sources",
    protectedSourceBody(
      `egress-unbound-${runId}`,
      deployment.secret.ref,
      controller.providerOrigin,
    ),
  );
  const unbound = await api("PATCH", `${namespacePath}/credential-sources/${created.id}`, {
    adoption: "live",
    authorityScope: "execution",
  });
  assert.equal(unbound.state, "ready");
  assert.deepEqual(unbound.egress, { adoption: "live", retention: "none" });
  // Do not stop a Worker with an in-flight operation or manufacture an unfinished
  // deployment. Completed work is retained; withdrawal later exercises B's Worker.
  await waitFor(
    "settled baseline controller work",
    async () => {
      const pending = await pool.query(
        "SELECT count(*)::int AS pending FROM occ.controller_work WHERE namespace_id = $1 AND state IN ('queued', 'claimed')",
        [namespace.id],
      );
      return pending.rows[0].pending === 0 ? true : undefined;
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  );
  const initialSetup = {
    ...setup,
    input: { ...input, images: { ...input.images, controller: input.controllerUpgrade.fromImage } },
  };
  const controllers = await observeControllerIdentities(
    setup,
    await selectLiveControllerPods(initialSetup),
    input.controllerUpgrade.fromImage,
  );
  const suppliers = supplierIdentities(stack.supplierPods);
  const gateways = supplierIdentities(installed.gatewayPods);
  const state = await retainedState(stack, deployment);
  assert.equal(state.revisions.length, 1);
  assert.equal(state.revisions[0].id, deployment.revision.id);
  assert.equal(state.installations.length, 1);
  const deploymentWork = state.work.filter(
    (work) => work.idempotency_key === `agent_revision:${deployment.revision.id}:reconcile`,
  );
  assert.equal(deploymentWork.length, 1, "retain the original deployment work row");
  assert.equal(deploymentWork[0].agent_id, deployment.agent.id);
  assert.equal(deploymentWork[0].revision_id, deployment.revision.id);
  assert.equal(deploymentWork[0].agent_target, null);
  assert.equal(deploymentWork[0].state, "succeeded");
  assert.ok(
    ["REVISION_ACTIVATED", "REVISION_ALREADY_ACTIVE"].includes(deploymentWork[0].reason_code),
  );
  const grants = await api("GET", `${namespacePath}/iam/access-bindings`);
  // Start the quiet window before readiness lets the operator begin replacement.
  const providerBaseline = {
    httpRequests: owned.provider.observations.length,
    tcpConnections: owned.provider.tcpConnections,
  };
  await checkpoint(
    "controller-upgrade-ready",
    {
      componentCount: controllers.length,
      timeoutMs: input.controllerUpgrade.timeoutMs,
      providerBaseline,
    },
    {
      fromCommit: input.controllerUpgrade.fromCommit,
      toCommit: input.oceCommit,
      fromImage: input.controllerUpgrade.fromImage,
      toImage: input.images.controller,
      controllers,
      retainedStateSha256: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    },
  );
  return {
    replacement,
    unbound,
    controllers,
    suppliers,
    gateways,
    state,
    grants,
    providerBaseline,
  };
}

export async function observeControllerUpgrade(
  setup,
  stack,
  evidence,
  owned,
  deployment,
  retained,
) {
  const { input, f } = setup;
  const { api, checkpoint } = evidence;
  const { namespacePath } = stack;
  const beforeIngress = retained.providerBaseline.httpRequests;
  const beforeConnections = retained.providerBaseline.tcpConnections;
  const deadline = Date.now() + input.controllerUpgrade.timeoutMs;
  const withinDeadline = () =>
    assert.ok(Date.now() < deadline, "controller upgrade checkpoint expired");
  // This is an operator checkpoint, not an arbitrary shell hook. Only Kubernetes
  // observations run while the operator replaces both application components.
  // Old and new processes may overlap during rollout; no model/API test call does.
  const pods = await waitFor(
    "both replacement controller components",
    async () => {
      withinDeadline();
      const result = JSON.parse(
        await f.kubectl(
          `--request-timeout=${Math.max(1, deadline - Date.now())}ms`,
          "get",
          "pods",
          "--namespace",
          input.controllerNamespace,
          "--selector",
          input.controllerSelector,
          "-o",
          "json",
        ),
      ).items;
      withinDeadline();
      if (
        result.length !== 2 ||
        result.some(
          (pod) =>
            pod.metadata.deletionTimestamp ||
            retained.controllers.some(({ uid }) => uid === pod.metadata.uid) ||
            !pod.status?.conditions?.some(
              ({ type, status }) => type === "Ready" && status === "True",
            ),
        )
      ) {
        return undefined;
      }
      const components = ["api", "worker"];
      if (
        components.some(
          (component) =>
            result.filter(
              (pod) =>
                pod.metadata.labels?.["app.kubernetes.io/component"] === component &&
                [...(pod.spec.containers ?? []), ...(pod.spec.initContainers ?? [])].some(
                  ({ name, image }) => name === component && image === input.images.controller,
                ),
            ).length !== 1,
        )
      ) {
        return undefined;
      }
      return result;
    },
    { timeoutMs: input.controllerUpgrade.timeoutMs, intervalMs: 1000 },
  );
  const controllers = await observeControllerIdentities(setup, pods, input.images.controller);
  for (const current of controllers) {
    const prior = retained.controllers.find(({ component }) => component === current.component);
    assert.notEqual(current.containerID, prior.containerID);
    assert.equal(
      current.installationSha256,
      prior.installationSha256,
      "keep the actual mounted Installation contents unchanged",
    );
    assert.equal(
      current.configurationSha256,
      prior.configurationSha256,
      "keep the controller's installation inputs unchanged",
    );
  }
  await selectLiveControllerPods(setup);
  for (const prior of retained.controllers) {
    const raw = await f.kubectl(
      "get",
      "pod",
      prior.name,
      "--namespace",
      input.controllerNamespace,
      "--ignore-not-found",
      "-o",
      "json",
    );
    assert.ok(
      !raw.trim() || JSON.parse(raw).metadata.uid !== prior.uid,
      "the original controller Pod must be gone, not merely absent from the selector",
    );
  }
  const suppliers = JSON.parse(
    await f.kubectl(
      "get",
      "pods",
      "--namespace",
      input.openShellGatewayNamespace,
      "--selector",
      input.openShellGatewaySelector,
      "-o",
      "json",
    ),
  ).items;
  assert.deepEqual(
    supplierIdentities(suppliers),
    retained.suppliers,
    "retain the supplier processes",
  );
  const gateways = await Promise.all(
    retained.gateways.map(({ name }) => f.resource("pod", name, stack.placement)),
  );
  assert.deepEqual(
    supplierIdentities(gateways),
    retained.gateways,
    "retain the Agent Gateway processes as well as its Harness",
  );
  assert.equal((await api("GET", "/installation")).id, stack.installation.id);
  assert.deepEqual(await api("GET", `${namespacePath}/iam/access-bindings`), retained.grants);
  assert.deepEqual(
    await retainedState(stack, deployment),
    retained.state,
    "retain the original source, revision, installation and settled work",
  );
  assert.equal(
    owned.provider.observations.length,
    beforeIngress,
    "controller replacement must not send provider traffic",
  );
  assert.equal(
    owned.provider.tcpConnections,
    beforeConnections,
    "controller replacement must not open provider connections",
  );
  withinDeadline();
  await checkpoint(
    "controller-upgrade-observed",
    { componentCount: controllers.length, retainedStateUnchanged: true, providerSends: 0 },
    { controllers },
  );

  const requests = [
    {
      phase: "fresh-source",
      method: "POST",
      path: `${namespacePath}/credential-sources`,
      body: protectedSourceBody(
        `egress-refused-${evidence.runId}`,
        deployment.secret.ref,
        setup.controller.providerOrigin,
      ),
    },
    {
      phase: "unbound-adoption",
      method: "PATCH",
      path: `${namespacePath}/credential-sources/${retained.unbound.id}`,
      body: { adoption: "live", authorityScope: "execution" },
    },
    {
      phase: "unbound-secret-reference",
      method: "PATCH",
      path: `${namespacePath}/credential-sources/${retained.unbound.id}`,
      body: { secrets: { api_key: retained.replacement.ref } },
    },
    {
      phase: "new-deployment",
      method: "POST",
      path: `${namespacePath}/agents/${deployment.agent.id}/deploy`,
    },
  ];
  for (const request of requests) {
    await checkpoint("retirement-refusal-start", { operation: request.phase });
    const creation = request.phase === "fresh-source";
    if (creation) {
      evidence.ledger.pendingCreate = { kind: "credential-sources", name: request.body.name };
      await checkpoint("create-refusal-request", { kind: "credential-sources" });
    }
    const deploying = request.phase === "new-deployment";
    if (deploying) {
      evidence.ledger.pendingDeploy = { agentId: deployment.agent.id, path: request.path };
      await checkpoint("deploy-refusal-request", { agentId: deployment.agent.id });
    }
    const response = await evidence.request(request.method, request.path, request.body);
    if (creation) {
      // A regression may unexpectedly admit the source. Only adopt cleanup for
      // a new, read-back identity matching this run; ambiguous creates stay pending.
      if (response.status === 201) {
        const source = assertConnectedResponse(response, 201);
        assert.ok(Check(CredentialSourceId, source?.id), "cleanup requires a valid source ID");
        assert.ok(
          !(retained.state.sources ?? []).some(({ id }) => id === source.id),
          "cleanup must not adopt a source from the pre-upgrade baseline",
        );
        const observed = await api("GET", `${namespacePath}/credential-sources/${source.id}`);
        assert.equal(observed.id, source.id, "cleanup requires the returned source ID");
        assert.equal(observed.namespaceId, stack.namespace.id, "cleanup requires this Namespace");
        assert.equal(observed.name, request.body.name, "cleanup requires this run-specific name");
        evidence.ledger.resources.push({ kind: "credential-sources", id: source.id });
        delete evidence.ledger.pendingCreate;
      }
      await checkpoint("create-refusal-response", { status: response.status });
    }
    if (request.phase === "new-deployment" && response.status === 202) {
      const revision = assertConnectedResponse(response, 202);
      await checkpoint("deploy-request", {
        agentId: deployment.agent.id,
        unexpectedRevisionId: revision.id,
      });
    }
    const error = assertConnectedResponse(response, 409);
    assert.deepEqual(error, retirement);
    assert.deepEqual(
      await retainedState(stack, deployment),
      retained.state,
      "refusal must not mutate retained metadata or enqueue work",
    );
    assert.equal(
      owned.provider.observations.length,
      beforeIngress,
      "retirement must precede provider I/O",
    );
    assert.equal(
      owned.provider.tcpConnections,
      beforeConnections,
      "retirement must precede provider connections",
    );
    // A refusal is accounted for only after its persisted and external effects
    // are checked. Read failures and unexpected work must retain cleanup custody.
    if (creation) {
      delete evidence.ledger.pendingCreate;
    }
    if (deploying) {
      delete evidence.ledger.pendingDeploy;
    }
    await checkpoint("retirement-refused", {
      operation: request.phase,
      status: 409,
      providerSends: 0,
    });
  }
  stack.controllerPods = pods;
}
