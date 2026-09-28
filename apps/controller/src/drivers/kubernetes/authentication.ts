import { isAbsolute } from "node:path";
import type { JSONSchema } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

export type KubernetesAuthentication =
  | { readonly mode: "inCluster" }
  | { readonly mode: "kubeconfig"; readonly kubeconfigPath: string; readonly context: string };

/** Each Driver keeps its own schema graph; only its root is frozen. */
export function createKubernetesAuthenticationOptionsSchema(): JSONSchema {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["authentication"],
    properties: {
      authentication: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["mode"],
            properties: { mode: { const: "inCluster" } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["mode", "kubeconfigPath", "context"],
            properties: {
              mode: { const: "kubeconfig" },
              kubeconfigPath: { type: "string", minLength: 1 },
              context: { type: "string", minLength: 1 },
            },
          },
        ],
      },
    },
  });
}

export function validateKubernetesAuthentication(
  value: unknown,
  validationFailure: (message: string) => Error,
): void {
  const authentication = asRecord(value);
  if (authentication === undefined) {
    throw validationFailure("Explicit Kubernetes authentication is required.");
  }
  if (authentication.mode === "inCluster") {
    if (Object.keys(authentication).some((key) => key !== "mode")) {
      throw validationFailure("In-cluster authentication does not accept additional options.");
    }
    return;
  }
  if (authentication.mode !== "kubeconfig") {
    throw validationFailure("An explicit Kubernetes authentication mode is required.");
  }
  if (
    Object.keys(authentication).some(
      (key) => key !== "mode" && key !== "kubeconfigPath" && key !== "context",
    )
  ) {
    throw validationFailure("Unknown kubeconfig authentication options are forbidden.");
  }
  const path = authentication.kubeconfigPath;
  if (!isNonEmptyString(path)) {
    throw validationFailure("Dedicated kubeconfig path must be a nonempty string.");
  }
  if (!isAbsolute(path)) {
    throw validationFailure("Dedicated kubeconfig path must be absolute.");
  }
  if (!isNonEmptyString(authentication.context)) {
    throw validationFailure("Explicit Kubernetes context must be a nonempty string.");
  }
}
