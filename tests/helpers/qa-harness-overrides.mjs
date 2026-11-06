import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { renderPresetTemplate } from "../../packages/contracts/src/index.ts";
import { normalizeOpenAiBaseUrl } from "../../apps/controller/src/drivers/openai-endpoint.ts";
import {
  createQaInstallation,
  deployQaAgentAndWait,
  prepareQaPluginCatalogs,
} from "./qa-installation.mjs";
import { protectedText } from "./qa-secrets.mjs";
import { assertGatewayModelTurn } from "./kubernetes-real.mjs";
import { waitFor } from "./qa-utils.mjs";

/** Real installed Agent workflows. No model server, Compute or credential-delivery substitutes. */
export async function verifyQaHarnessOverrides(context, artifacts, presets) {
  const endpoints = ["A", "B"].map((suffix) => {
    const written = process.env[`OCC_TEST_QA_HARNESS_ENDPOINT_${suffix}`];
    assert.ok(written, `OCC_TEST_QA_HARNESS_ENDPOINT_${suffix} is required`);
    const baseUrl = normalizeOpenAiBaseUrl(written);
    assert.ok(baseUrl, "Select authorized HTTPS /v1 endpoints");
    assert.equal(new URL(baseUrl).port, "", "Native OpenClaw retains the HTTPS port 443 limit");
    return baseUrl;
  });
  assert.notEqual(endpoints[0], endpoints[1], "Two distinct authorized destinations are required");
  const keys = await Promise.all(
    ["A", "B"].map((suffix) =>
      protectedText(
        process.env[`OCC_TEST_QA_HARNESS_KEY_FILE_${suffix}`],
        `model credential ${suffix}`,
      ),
    ),
  );
  const model = process.env.OCC_TEST_QA_HARNESS_MODEL;
  assert.ok(model?.trim(), "Select a model authorized at both destinations");
  const f = await createQaInstallation(context, "kubernetes", artifacts, {
    repositoryInputs: false,
    sandboxDriver: "openshell",
  });
  await prepareQaPluginCatalogs(f);
  const runtime = f.configuration.drivers.compute.configuration.runtime;
  const provider = (baseUrl) => ({
    protocol: "openai-responses",
    baseUrl,
    supportsStandaloneWebSearch: false,
  });
  runtime.modelProvider = provider(endpoints[0]);
  await f.saveInstallation(f.configuration);
  const root = `/namespaces/${f.namespace.id}`;
  const sources = await Promise.all(
    keys.map(async (value, index) => {
      const secret = await f.api("POST", `${root}/secrets`, {
        name: `destination-${index}`,
        value,
      });
      return f.api("POST", `${root}/credential-sources`, {
        name: `destination-${index}`,
        type: "openai",
        config: { authorized_base_url: endpoints[index] },
        secrets: { api_key: secret.ref },
      });
    }),
  );
  const role = await f.api("POST", `${root}/iam/roles`, {
    name: "harness-destination-use",
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const grant = (agent, source) =>
    f.api("POST", `${root}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: role.id,
      resourceKind: "credential_source",
      resourceId: source.id,
    });
  const turn = async (agent) => {
    const gateway = await f.gatewayUrl(agent);
    try {
      await assertGatewayModelTurn({
        gatewayUrl: gateway.url,
        gatewayPassword: gateway.gatewayPassword,
        nonce: `OVERRIDE_${randomUUID()}`,
        secrets: keys,
      });
    } finally {
      await gateway.close();
    }
  };
  for (const preset of presets) {
    const template = JSON.parse(
      await readFile(
        new URL(`../../deploy/presets/standard-${preset.toLowerCase()}.json`, import.meta.url),
        "utf8",
      ),
    );
    const agents = [];
    for (const [name, sourceIndex, explicit] of [
      ["standard", 0, true],
      ["evaluation", 1, true],
      ["inherited", 0, false],
    ]) {
      const rendered = renderPresetTemplate(template.template, {
        name: `qa-${f.suffix}-${preset}-${name}`,
        model,
        modelSecret: "provided-through-secret-api",
      });
      const values = rendered.configuration.values;
      values.agents.defaults.skipBootstrap = true;
      values.gateway.http = { endpoints: { chatCompletions: { enabled: true } } };
      const configuration = await f.api("POST", `${root}/configurations`, {
        kind: "agent",
        values,
      });
      const source = sources[sourceIndex];
      const agent = await f.api("POST", `${root}/agents`, {
        name: rendered.agent.name,
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: source.id },
        credentialSources: [{ sourceId: source.id }],
      });
      f.agents.push(agent);
      await grant(agent, source);
      await f.api("POST", `${root}/agents/${agent.id}/runtime-credentials`, {});
      agents.push({ agent, sourceIndex, explicit });
    }
    // Three real runtimes coexist; each uses its own source and saved destination.
    await Promise.all(
      agents.map(async ({ agent, sourceIndex, explicit }) => {
        await deployQaAgentAndWait(f, agent, {
          harnessOverrides: explicit ? { modelProvider: provider(endpoints[sourceIndex]) } : {},
        });
        assert.equal(
          agent.revision.harness.configuration.modelProvider.baseUrl,
          endpoints[sourceIndex],
        );
        await turn(agent);
      }),
    );
    // Restart both controllers with a different default, then remove it. Existing revisions
    // still serve at their saved destinations; a new omitted override must re-resolve.
    for (const next of [provider(endpoints[1]), undefined]) {
      if (next) {
        runtime.modelProvider = next;
      } else {
        delete runtime.modelProvider;
      }
      await f.saveInstallation(f.configuration);
      await Promise.all(
        agents.map(async ({ agent }) => {
          const saved = await f.api(
            "GET",
            `${root}/agents/${agent.id}/revisions/${agent.revision.id}`,
          );
          assert.deepEqual(saved.harness, agent.revision.harness);
          await turn(agent);
        }),
      );
      const inherited = agents[2].agent;
      const count = (await f.api("GET", `${root}/agents/${inherited.id}/revisions`)).length;
      if ((next?.baseUrl ?? "https://api.openai.com/v1") !== endpoints[0]) {
        await assert.rejects(f.api("POST", `${root}/agents/${inherited.id}/deploy`, {}), {
          message: /HTTP 409/,
        });
        assert.equal(
          (await f.api("GET", `${root}/agents/${inherited.id}/revisions`)).length,
          count,
        );
      } else {
        await deployQaAgentAndWait(f, inherited, { harnessOverrides: {} });
        assert.equal(inherited.revision.harness.configuration.modelProvider.baseUrl, endpoints[0]);
        await turn(inherited);
      }
    }
    runtime.modelProvider = provider(endpoints[0]);
    await f.saveInstallation(f.configuration);
    // Withdraw one exact source binding. Other Agents must keep serving.
    const withdrawn = agents[0].agent;
    await f.api(
      "POST",
      `${root}/agents/${withdrawn.id}/credential-sources/${sources[0].id}/withdraw`,
    );
    await waitFor("Harness source withdrawal", async () => {
      const result = await f.api(
        "GET",
        `${root}/agents/${withdrawn.id}/credential-sources/${sources[0].id}/withdrawal`,
      );
      return result.state === "revoked";
    });
    await assert.rejects(turn(withdrawn), { name: "AssertionError" });
    await Promise.all(agents.slice(1).map(({ agent }) => turn(agent)));
    await f.record(`harness-overrides-${preset}`, {
      destinations: endpoints,
      revisions: agents.map(({ agent }) => ({
        agentId: agent.id,
        revisionId: agent.revision.id,
        harness: agent.revision.harness,
      })),
      evidence:
        "real model turns before and after controller restart/default changes; exact-source withdrawal isolation",
      limit: "No independent upstream access log was collected.",
    });
  }
}
