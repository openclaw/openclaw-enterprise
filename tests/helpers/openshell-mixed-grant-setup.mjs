import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { modelRequestProviderName } from "../../apps/controller/src/drivers/sandbox/openshell-model-request-policy.ts";
import {
  selectOpenShellCandidate,
  verifyOpenShellCandidate,
} from "../../scripts/ci/openshell-candidate.ts";
import { run } from "../fixtures/repository-credentials/process.mjs";
import { startOpenShellModelOrigin } from "../fixtures/openshell-model-origin.ts";
import { startInstalledGrantGitHubOrigin } from "./installed-grant-github-origin.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Mixed grant proof selects an explicit supplier; the finite suite keeps its stock pins. */
export async function mixedGrantSupplier(directory, signal) {
  const names = [
    "GATEWAY_IMAGE",
    "SANDBOX_IMAGE",
    "SUPERVISOR_IMAGE",
    "SOURCE_REVISION",
    "HELM_CHART",
    "WORKSPACE_HELM_CHART",
  ];
  const environment = Object.fromEntries(
    names.map((name) => [`OCC_TEST_OPENSHELL_${name}`, process.env[`OCC_TEST_OPENSHELL_${name}`]]),
  );
  const selected = selectOpenShellCandidate(environment, {});
  assert.ok(selected, "Mixed grant proof requires an explicit OpenShell supplier selection");
  for (const image of Object.values(selected.images)) {
    assert.match(image, /^[^\s@]+@sha256:[a-f0-9]{64}$/, "Select immutable OpenShell images");
  }
  const env = Object.fromEntries(
    ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "XDG_CONFIG_HOME", "TMPDIR"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  const verified = await verifyOpenShellCandidate(selected, {
    execFile: (executable, args) => run(executable, args, { env, signal, timeout: 30_000 }),
    docker: "docker",
    helm: "helm",
    snapshotParent: directory,
  });
  assert.ok(verified);
  return verified;
}

export async function mixedGrantOrigins({ host, tls, cleanup }) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const gitScope = {
    repository: "fixture-org/mixed-grant",
    repositoryRef: "mixed-grant-repository",
    repositoryId: "4101",
    permissions: { contents: "read", metadata: "read" },
  };
  const origin = await startInstalledGrantGitHubOrigin({
    host,
    port: 0,
    ...gitScope,
    appPublicKey: publicKey,
    tls: { ...tls.origin, ca: tls.ca },
  });
  cleanup.push(() => origin.close());
  const modelBearer = `fixture-model-${randomBytes(32).toString("hex")}`;
  const turns = {
    before: {
      harness: "codex",
      id: "before-git-withdrawal",
      marker: `OCE-MODEL-first-${randomBytes(12).toString("hex")}`,
      answer: `OCE-MODEL-remember-${randomBytes(12).toString("hex")}`,
    },
    after: {
      harness: "codex",
      id: "after-git-withdrawal",
      marker: `OCE-MODEL-next-${randomBytes(12).toString("hex")}`,
      answer: `OCE-MODEL-retained-${randomBytes(12).toString("hex")}`,
      priorTurnId: "before-git-withdrawal",
    },
  };
  const observations = [];
  const model = "gpt-5.4";
  const modelOrigin = await startOpenShellModelOrigin({
    host,
    port: 0,
    model,
    bearerDigests: { codex: sha256(modelBearer), openclaw: sha256(randomBytes(32)) },
    turns: Object.values(turns),
    tls: tls.model,
    onObservation: (event) => observations.push(event),
  });
  cleanup.push(() => modelOrigin.close());
  return {
    origin,
    privateKey,
    gitScope,
    model,
    modelBearer,
    modelTurns: turns,
    modelOrigin: {
      ...modelOrigin,
      snapshot: () => structuredClone(observations),
      readOriginTurn: async (id) =>
        structuredClone(
          observations.findLast((event) => event.kind === "turn" && event.turnId === id),
        ),
      readOriginToolTurn: async (id) =>
        structuredClone(
          observations.findLast((event) => event.kind === "tool" && event.turnId === id),
        ),
    },
  };
}

export function gatewayGrantBundle(publicKey, keyId) {
  const jwk = createPublicKey(publicKey).export({ format: "jwk" });
  assert.equal(jwk.crv, "Ed25519");
  return JSON.stringify({ keys: [{ ...jwk, kid: keyId, alg: "EdDSA", use: "sig" }] });
}

/** Registration must precede readiness: the provider assertion is needed during startup. */
export async function registerMixedGrantProviders({
  request,
  namespace,
  agent,
  revision,
  workspace,
  gatewayClient,
  kube,
  gatewayValues,
  modelEndpoint,
  gitEndpoint,
  upgradeGateway,
  signal,
}) {
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`;
  const modelName = modelRequestProviderName(revision.id);
  const deadline = Date.now() + 300_000;
  let selected;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const deployment = await request("GET", path);
    assert.equal(deployment.namespaceId, namespace.id);
    assert.equal(deployment.agentId, agent.id);
    assert.equal(deployment.deploymentId, revision.id);
    if (deployment.status === "failed") {
      // API error messages and supplier logs can contain private data. The status
      // is sufficient here; retries remain running and continue this observation.
      const code = /^[A-Z][A-Z0-9_]{0,95}$/.test(deployment.error?.code ?? "")
        ? deployment.error.code
        : "UNKNOWN_DEPLOYMENT_FAILURE";
      throw new Error(
        `MIXED_GRANT_DEPLOYMENT_FAILED: ${code}; selected revision failed before provider registration`,
      );
    }
    const pods = JSON.parse(
      await kube([
        "get",
        "pods",
        "-n",
        workspace,
        "-l",
        `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=agent`,
        "-o",
        "json",
      ]),
    ).items;
    assert.ok(pods.length < 2, "Expected one selected Harness Pod");
    const owner = pods[0]?.metadata.ownerReferences?.find(({ kind }) => kind === "Sandbox");
    if (owner) {
      const sandbox = await gatewayClient.getSandbox({ workspace, name: owner.name }, signal);
      if (sandbox?.id) {
        assert.equal(sandbox.annotations["openclaw.dev/agent-id"], agent.id);
        assert.equal(sandbox.annotations["openclaw.dev/revision-id"], revision.id);
        const names = sandbox.spec?.providers ?? [];
        const gitNames = names.filter((name) =>
          /^oce-(?:git|github-installation)-[a-f0-9]{32}$/.test(name),
        );
        assert.ok(gitNames.length < 2);
        if (names.includes(modelName) && gitNames[0]) {
          const [modelProvider, gitProvider] = await Promise.all([
            gatewayClient.getProvider(workspace, modelName, signal),
            gatewayClient.getProvider(workspace, gitNames[0], signal),
          ]);
          if (modelProvider?.id && gitProvider?.id) {
            for (const provider of [modelProvider, gitProvider]) {
              assert.equal(provider.workspace, workspace);
              assert.equal(provider.profileWorkspace, workspace);
              assert.match(provider.id, /^[A-Za-z0-9_.-]{1,200}$/);
            }
            assert.equal(modelProvider.labels["openclaw.dev/namespace-id"], namespace.id);
            assert.equal(modelProvider.labels["openclaw.dev/agent-id"], agent.id);
            assert.equal(modelProvider.labels["openclaw.dev/revision-id"], revision.id);
            const gitOwner = gitProvider.labels["openclaw.dev/prepared-git-binding"];
            assert.match(gitOwner ?? "", /^[a-f0-9]{48}$/);
            assert.ok(
              [
                `oce-git-${gitOwner.slice(0, 32)}`,
                `oce-github-installation-${gitOwner.slice(0, 32)}`,
              ].includes(gitProvider.name),
            );
            assert.notEqual(modelProvider.id, gitProvider.id);
            selected = { modelProvider, gitProvider };
            break;
          }
        }
      }
    }
    await delay(1000, undefined, { signal });
  }
  assert.ok(selected, "Selected revision did not attach its model and Git providers");
  const rows = [
    {
      provider_id: selected.modelProvider.id,
      credential_key: "access_token",
      token_endpoint: modelEndpoint,
    },
    {
      provider_id: selected.gitProvider.id,
      credential_key: "installation_token",
      token_endpoint: gitEndpoint,
    },
  ];
  assert.equal(gatewayValues.gatewayConfig["openshell.gateway.provider_assertions"], undefined);
  gatewayValues.gatewayConfig["openshell.gateway.provider_assertions"] = rows;
  await upgradeGateway(gatewayValues);
  for (const provider of Object.values(selected)) {
    provider.profile = await gatewayClient.getProviderProfile(workspace, provider.type, signal);
    assert.ok(provider.profile);
  }
  return selected;
}
