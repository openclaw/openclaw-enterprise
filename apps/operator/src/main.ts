import { KubeConfig } from "@kubernetes/client-node";
import { KubernetesAgentOperator } from "./operator.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required Operator setting is missing: ${name}`);
  }
  return value;
}

const configuration = new KubeConfig();
configuration.loadFromCluster();
const operator = new KubernetesAgentOperator({
  configuration,
  namespace: required("OCE_OPERATOR_NAMESPACE"),
  sourceClusterId: required("OCE_OPERATOR_CLUSTER_ID"),
  leaseName: process.env.OCE_OPERATOR_LEASE_NAME ?? "oce-agent-operator",
  ...(process.env.OCE_OPERATOR_IDENTITY === undefined
    ? {}
    : { identity: process.env.OCE_OPERATOR_IDENTITY }),
});
await operator.start();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void operator.stop();
  });
}
