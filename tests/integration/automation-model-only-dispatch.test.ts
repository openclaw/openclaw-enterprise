import assert from "node:assert/strict";
import test from "node:test";
import { runEmbeddedAutomationDispatchProbe } from "../fixtures/automation-model-only-dispatch-host.ts";
import { runKubernetesAutomationDispatchProbe } from "../fixtures/automation-model-only-dispatch-kubernetes.ts";

// Synthetic provider output forces calls even when the request advertises no tools.
// Only the genuine Harness returns tool outcomes; host reads verify actual effects.
// This supplements genuine-provider QA and does not qualify other tool families.
const image = process.env.OCC_TEST_RUNTIME_IMAGE;
const selected = image !== undefined;
const skip = selected ? false : "Set OCC_TEST_RUNTIME_IMAGE and the prepared k3d runtime inputs.";

function preparedKubernetes() {
  const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
  const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
  const gatewayImage = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE;
  const agentImage = process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE;
  const seccompProfile = process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE;
  assert.ok(
    kubeconfigPath && kubernetesContext && gatewayImage && agentImage && seccompProfile,
    "the existing runtime CI lane must prepare k3d, imported images and qualified Codex seccomp",
  );
  return {
    selection: { kubeconfigPath, kubernetesContext },
    gatewayImage,
    agentImage,
    seccompProfile,
  };
}

test(
  "model-only openclaw: supplemental real dispatch rejects a synthetic provider tool call",
  { skip, timeout: 270_000 },
  async (t) => {
    assert.ok(image);
    await runEmbeddedAutomationDispatchProbe(t, image);
  },
);

test(
  "model-only codex: supplemental real dispatch rejects a synthetic provider tool call",
  { skip, timeout: 720_000 },
  async (t) => {
    for (const probe of ["exec_command", "exec"] as const) {
      await runKubernetesAutomationDispatchProbe(t, {
        ...preparedKubernetes(),
        probe,
      });
    }
  },
);

test(
  "model-only openclaw: supplemental delegation blocks child creation",
  { skip, timeout: 360_000 },
  async (t) => {
    assert.ok(image);
    await runEmbeddedAutomationDispatchProbe(t, image, "delegation");
  },
);

test(
  "model-only codex: supplemental delegation blocks child creation",
  { skip, timeout: 480_000 },
  async (t) => {
    await runKubernetesAutomationDispatchProbe(t, { ...preparedKubernetes(), probe: "delegation" });
  },
);

test(
  "model-only openclaw: supplemental messaging blocks a local Slack sink",
  { skip, timeout: 360_000 },
  async (t) => {
    assert.ok(image);
    await runEmbeddedAutomationDispatchProbe(t, image, "messaging");
  },
);

test(
  "model-only codex: supplemental messaging blocks a local Slack sink",
  { skip, timeout: 480_000 },
  async (t) => {
    await runKubernetesAutomationDispatchProbe(t, { ...preparedKubernetes(), probe: "messaging" });
  },
);
