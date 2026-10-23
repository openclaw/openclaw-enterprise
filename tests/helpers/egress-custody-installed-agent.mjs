import { execFileSync } from "node:child_process";
import { sha256Hex } from "../../packages/utils/src/hashing.ts";
import assert from "node:assert/strict";
import { selectLiveControllerPods } from "./egress-installed-stack.mjs";
import { observeInstalledProtection } from "./egress-installed-agent.mjs";
import { protectedConfigurationBody, sourceAccessBindingBody } from "./egress-connected-inputs.mjs";
import {
  credentialFreeRepository,
  repositoryPath,
} from "../fixtures/egress-custody-repository-origin.mjs";

export async function admitRepositoryAgent(
  setup,
  stack,
  evidence,
  owned,
  name = "custody-" + evidence.runId,
) {
  const { create, provider } = owned;
  // Prove the actual API and worker select this synthetic issuer before enrolling its App key.
  // Inspect only nonsecret Installation routing. Missing selection must never fall back to GitHub.
  const { controllerNamespace } = setup.input;
  const inspectOrigin = [
    'import { readFileSync } from "node:fs";',
    'import { createRequire } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    // The installed Node process runs from /app; the controller owns this dependency.
    'const require = createRequire(new URL("./apps/controller/package.json", import.meta.url));',
    'const { loadYaml } = await import(pathToFileURL(require.resolve("@kubernetes/client-node")));',
    'const startup = loadYaml(readFileSync(process.env.OCC_CONFIG_PATH, "utf8"));',
    "const p = startup.drivers.credential_proxy.configuration.preparedGitHub;",
    "if (!p.apiOrigin || !p.issuerCaPath || !p.custodyKeyPath) process.exit(1);",
    "process.stdout.write(p.apiOrigin);",
  ].join("\n");
  // The prepared-stack observation predates any deliberate API restart. Inspect the live pair.
  const controllerPods = await selectLiveControllerPods(setup);
  for (const pod of controllerPods) {
    const origin = await setup.f.kubectl(
      "exec",
      "-n",
      controllerNamespace,
      pod.metadata.name,
      "--",
      "node",
      "--input-type=module",
      "-e",
      inspectOrigin,
    );
    assert.equal(
      origin.trim(),
      provider.businessOrigin,
      "both control-plane Pods must select this private issuer",
    );
  }
  const configuration = await create(
    "configurations",
    protectedConfigurationBody(setup.controller.model),
  );
  // Bind an actual Agent ID into this newly consented, whole-execution source.
  // The Agent has no repository transport binding, executable pin, or model Secret.
  const agent = await create("agents", {
    name,
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: { method: "runtime" },
  });
  const issuer = await create("secrets", { name, value: provider.privateKey });
  const source = await create("credential-sources", {
    name,
    type: "github-app-metadata",
    config: { ...provider.identity, agent_id: agent.id, authority: "execution" },
    secrets: { private_key: issuer.ref },
  });
  assert.equal(source.egress?.adoption, "prepared", "must use protected warm-only GitHub source");
  const route = stack.namespacePath + "/agents/" + agent.id;
  const api = evidence.api;
  await api("PATCH", route, {
    configurationId: configuration.id,
    harnessAuth: { method: "runtime" },
    credentialSources: [{ sourceId: source.id }],
  });
  // Preparation belongs to the worker. Do not race a deliberately cold Compute gate.
  await setup.f.waitFor(
    "proactive prepared repository credential",
    async () => {
      const status = await api("GET", stack.namespacePath + "/credential-sources/" + source.id);
      return provider.issues > 0 && status.status.state === "ready";
    },
    120_000,
  );
  const role = await create("iam/roles", {
    name,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const binding = await create("iam/access-bindings", sourceAccessBindingBody(agent, role, source));
  const bindings = await api("GET", stack.namespacePath + "/iam/access-bindings");
  assert.deepEqual(
    bindings.filter(({ subjectId }) => subjectId === agent.servicePrincipalId).map(({ id }) => id),
    [binding.id],
  );
  const transport = await api("POST", route + "/runtime-credentials", {});
  assert.equal(transport.transportConfigured, true);
  return { agent, source, role, binding, route };
}

export async function activateRepositoryAgent(setup, stack, evidence, owned, admitted) {
  const { agent, source, route } = admitted;
  await evidence.checkpoint("deploy-request", { agentId: agent.id });
  const since = new Date().toISOString();
  const revision = await evidence.api("POST", route + "/deploy", undefined, 202);
  await evidence.checkpoint("deploy-revision-returned", {}, { revisionId: revision.id });
  await setup.f.waitFor(
    "actual worker-released protected repository Agent",
    async () => {
      const state = await evidence.api("GET", route + "/deployments/" + revision.id);
      if (state.status === "failed") {
        // Read once, before cleanup. Neither an observation nor its failure changes acceptance.
        const target = { id: revision.id, agentId: agent.id, namespaceId: stack.namespace.id };
        const unavailable = () => "unavailable";
        const workerEvents = await failedWorkerEvents(setup, stack, since, target).catch(
          unavailable,
        );
        await evidence
          .checkpoint("failed-deployment-observation", { workerEvents }, { revisionId: target.id })
          .catch(unavailable);
      }
      assert.notEqual(state.status, "failed", "protected deployment failed; no runtime acceptance");
      return (await evidence.api("GET", route)).activeRevisionId === revision.id || undefined;
    },
    12 * 60_000,
  );
  const sandbox = await setup.f.waitForSandbox(stack.placement, revision);
  const sandboxId = await owned.recordSandbox(sandbox);
  const noMaterial = source.egress?.adoption === "credential_free";
  const repository = noMaterial
    ? credentialFreeRepository.full_name
    : owned.provider.identity.repository;
  const installed = await observeInstalledProtection(
    setup,
    stack,
    evidence,
    { agent, source, revision, sandbox, sandboxId },
    ({ grant }) =>
      grant.kind ===
        (noMaterial ? "credential_free_repository_metadata" : "github_repository_metadata") &&
      grant.repository === repository &&
      grant.isolationId === agent.id &&
      grant.profile === "metadata-read",
  );
  await owned.recordPods(installed.harness, installed.supervisor, ...installed.gatewayPods);
  verifyWorkloadCannotObtainComputeSigner(setup, installed.harness, agent.id, revision.id);
  const [exactRoute, ...others] = installed.installation.plan.routes;
  assert.equal(others.length, 0);
  assert.equal(exactRoute.method, "GET");
  assert.equal(exactRoute.path, noMaterial ? "/repos/" + repository : repositoryPath);
  assert.equal(
    exactRoute.origin,
    owned.provider.businessOrigin,
    "must address selected synthetic GitHub",
  );
  assert.equal(exactRoute.binding.execution.revisionId, revision.id);
  if (!noMaterial) {
    assert.ok(
      owned.provider.issues > 0,
      "provider must observe proactive scoped token issue before first workload read",
    );
  }
  return { ...installed, revision };
}

// From Kubernetes preparationFailureDiagnostic. Export only reviewed literals, never log text.
const preparationCauses = new Map([
  [
    "The AgentRevision workload Pods did not terminate before the deadline.",
    "workload-not-terminated",
  ],
  ["Harness transport credential is unavailable.", "harness-transport-unavailable"],
  [
    "Compute release requires the exact current committed installation.",
    "exact-installation-required",
  ],
]);
const known = (value, literals) =>
  value === undefined ? undefined : literals.split(" ").includes(value) ? value : "other";

async function failedWorkerEvents(setup, stack, since, { id, namespaceId, agentId }) {
  const { controllerNamespace, images } = setup.input;
  function identity(pods) {
    const [pod, extra] = pods.filter(
      (p) => p.metadata.labels["app.kubernetes.io/component"] === "worker",
    );
    assert.ok(pod && !extra);
    const worker = (c) => c.name === "worker";
    assert.equal(pod.spec.containers.find(worker).image, images.controller);
    const { name, uid } = pod.metadata;
    const { containerID, restartCount, state } = pod.status.containerStatuses.find(worker);
    assert.ok(uid && containerID && state.running);
    assert.ok(Number.isSafeInteger(restartCount) && restartCount >= 0);
    return { name, uid, containerID, restartCount };
  }
  const worker = identity(stack.controllerPods);
  const timeout = "--request-timeout=8s";
  const checkWorker = async () =>
    assert.deepEqual(identity(await selectLiveControllerPods(setup, timeout)), worker);
  await checkWorker();
  const flags = ["--since-time=" + since, "--limit-bytes=1048576", timeout];
  const source = [worker.name, "-n", controllerNamespace, "-c", "worker"];
  const log = await setup.f.kubectl("logs", ...source, ...flags);
  await checkWorker();

  const events = [];
  for (const line of log.split("\n")) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    } // kubectl may start at a partial line
    if (
      e?.namespaceId !== namespaceId ||
      e.agentId !== agentId ||
      e.revisionId !== id ||
      e.operation !== "agent_revision.reconcile" ||
      e.workId !== "agent_revision:" + id + ":reconcile" ||
      !Number.isSafeInteger(e.attempt) ||
      e.attempt < 1
    ) {
      continue;
    }
    // attempt is a retry budget, not a pass ID. Keep source order; never pair or fill in events.
    const budgetAttempt = e.attempt;
    if (e.event === "worker.compute-prepare-failed") {
      events.push({
        event: "preparation",
        budgetAttempt,
        step: known(
          e.step,
          "prepare_revision sandbox_provision workspace_setup gateway_deployment",
        ),
        errorClass: known(
          e.errorClass,
          "DependencyUnavailableError OwnershipFailure KubernetesApiError KubernetesRequestTimeout",
        ),
        status:
          Number.isSafeInteger(e.status) && e.status >= 100 && e.status <= 599
            ? e.status
            : undefined,
        cause: e.message === undefined ? undefined : (preparationCauses.get(e.message) ?? "other"),
      });
    } else if (e.event === "worker.completed") {
      events.push({
        event: "completion",
        budgetAttempt,
        outcome: known(e.outcome, "pending retry permanent success"),
        code: known(e.code, "DEPENDENCY_UNAVAILABLE KUBERNETES_API_UNAVAILABLE"),
        cause: known(e.cause, "unavailable DependencyUnavailableError OwnershipFailure"),
        deployPasses:
          Number.isSafeInteger(e.deployPasses) && e.deployPasses > 0 ? e.deployPasses : undefined,
      });
    }
  }
  // Only the latest observed events, possibly a partial history at either end.
  return events.length ? events.slice(-32) : "unavailable";
}

// Exercise the real authorizer without getting, listing or projecting a Secret.
function verifyWorkloadCannotObtainComputeSigner(setup, harness, agentId, revisionId) {
  const namespace = harness.metadata.namespace;
  const name = "compute-release-" + sha256Hex(agentId, 12) + "-rev-" + sha256Hex(revisionId, 12);
  assert.ok(
    !JSON.stringify(harness.spec).includes(name),
    "Compute signer cannot be in the workload",
  );
  const account = harness.spec.serviceAccountName || "default";
  const user = "system:serviceaccount:" + namespace + ":" + account;
  const groups = [
    "system:serviceaccounts",
    "system:serviceaccounts:" + namespace,
    "system:authenticated",
  ];
  const { kubeconfigPath, kubernetesContext } = setup.input;
  for (const resourceAttributes of [
    { namespace, resource: "secrets", verb: "get", name },
    { namespace, resource: "secrets", verb: "list" },
    { namespace, resource: "secrets", verb: "watch" },
    { namespace, resource: "pods", verb: "create" },
    { namespace, resource: "deployments", group: "apps", verb: "create" },
    { namespace, resource: "deployments", group: "apps", verb: "patch" },
  ]) {
    const review = {
      apiVersion: "authorization.k8s.io/v1",
      kind: "SubjectAccessReview",
      spec: { user, groups, resourceAttributes },
    };
    const raw = execFileSync(
      "kubectl",
      [
        "--kubeconfig",
        kubeconfigPath,
        "--context",
        kubernetesContext,
        "create",
        "-f",
        "-",
        "-o",
        "json",
      ],
      { input: JSON.stringify(review), encoding: "utf8", timeout: 20_000 },
    );
    const { status } = JSON.parse(raw);
    assert.equal(status.evaluationError, undefined, "authorizer must evaluate workload access");
    assert.equal(
      status.allowed,
      false,
      "workload must lack " + resourceAttributes.verb + " " + resourceAttributes.resource,
    );
  }
}

// Only a freshly prepared, expressly disposable single API Pod may be restarted.
export async function restartDedicatedAuthority(setup) {
  const { kubectl, waitFor } = setup.f;
  const { controllerNamespace, controllerSelector } = setup.input;
  const api = async () =>
    JSON.parse(
      await kubectl(
        "get",
        "pods",
        "-n",
        controllerNamespace,
        "-l",
        controllerSelector,
        "-o",
        "json",
      ),
    ).items.filter(
      (p) =>
        p.metadata.labels["app.kubernetes.io/component"] === "api" && !p.metadata.deletionTimestamp,
    );
  const [old, ...others] = await api();
  assert.equal(others.length, 0);
  assert.equal(
    old.metadata.annotations["openclaw.dev/egress-custody-qualification-restart"],
    "permitted",
    "operator must dedicate this authority to the installed restart qualification",
  );
  assert.ok(old.spec.containers.some(({ image }) => image === setup.input.images.controller));
  await kubectl("delete", "pod", old.metadata.name, "-n", controllerNamespace, "--wait=false");
  const fresh = await waitFor(
    "fresh installed authority after lost dispatch acknowledgement",
    async () => {
      const [pod, ...other] = await api();
      if (!pod || other.length || pod.metadata.uid === old.metadata.uid) {
        return;
      }
      if (
        !pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True")
      ) {
        return;
      }
      assert.ok(pod.spec.containers.some(({ image }) => image === setup.input.images.controller));
      return pod;
    },
    180_000,
  );
  return { retiredAuthorityUid: old.metadata.uid, replacementAuthorityUid: fresh.metadata.uid };
}
