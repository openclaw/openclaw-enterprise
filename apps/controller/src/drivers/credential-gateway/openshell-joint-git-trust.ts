import { readFile } from "node:fs/promises";
import { createKubernetesClientConfiguration } from "../kubernetes/client.ts";
import type { KubernetesAuthentication } from "../kubernetes/authentication.ts";
import { withComputeAbortSignal } from "../compute/operation-context.ts";
import {
  readOpenShellGitSupervisor,
  type OpenShellGitSupervisorPolicy,
  type OpenShellGitSupervisorPod,
} from "../kubernetes/openshell-git-supervisor.ts";
import { OpenShellSpiffeAssertionVerifier } from "./openshell-spiffe-assertion.ts";
import { OpenShellProjectedGitAssertion } from "./openshell-projected-git-assertion.ts";

export type JointGitIssuerTrust =
  | {
      readonly bundlePath: string;
      readonly subjectPrefix: string;
      readonly algorithm: "RS256" | "ES256" | "EdDSA";
    }
  | {
      readonly assertionSource: "kubernetes-projected-token";
      readonly clusterIssuer: string;
      readonly namespace: string;
      readonly gatewayId: string;
      readonly supervisorImageDigest: string;
      readonly supervisorServiceAccountName: string;
      readonly authentication: KubernetesAuthentication;
    };

export interface AssertedPod {
  readonly sandboxId: string;
  readonly podUid: string;
  readonly sandboxName?: string;
}

export async function jointGitTrust(endpoint: string, config: JointGitIssuerTrust) {
  if ("bundlePath" in config) {
    const prefix = new URL(config.subjectPrefix);
    const { algorithm, bundlePath } = config;
    if (
      prefix.protocol !== "spiffe:" ||
      !prefix.hostname ||
      prefix.port ||
      !prefix.pathname.endsWith("/") ||
      prefix.search ||
      prefix.hash ||
      prefix.username ||
      prefix.password
    ) {
      throw new Error("Invalid Git supervisor subject prefix.");
    }
    const active = new Set<(bundle: OpenShellSpiffeAssertionVerifier | undefined) => void>();
    async function refresh(signal: AbortSignal) {
      let bundle: OpenShellSpiffeAssertionVerifier | undefined;
      try {
        bundle = new OpenShellSpiffeAssertionVerifier({
          assertionAudience: endpoint,
          trustDomain: prefix.hostname,
          algorithm,
          bundle: await readFile(bundlePath, { encoding: "utf8", signal }),
        });
        signal.throwIfAborted();
        return bundle;
      } finally {
        if (!signal.aborted) {
          for (const update of active) {
            update(bundle);
          }
        }
      }
    }
    await refresh(AbortSignal.timeout(3000));
    return async (assertion: string, pod: AssertedPod, signal: AbortSignal) => {
      let bundle: OpenShellSpiffeAssertionVerifier | undefined;
      let valid = true;
      const update = (next: OpenShellSpiffeAssertionVerifier | undefined) => {
        if (!next) {
          valid = false;
        } else if (bundle) {
          bundle.retainKeysFrom(next);
        } else {
          bundle = next;
        }
      };
      active.add(update);
      signal.addEventListener("abort", () => active.delete(update), { once: true });
      await refresh(signal);
      const subject = config.subjectPrefix + pod.sandboxId + "/pod/" + pod.podUid;
      return () => valid && !signal.aborted && bundle?.verify(assertion) === subject;
    };
  }
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    config.authentication,
    (reason) => new Error(reason),
  );
  const review = new sdk.AuthenticationV1Api(clientConfiguration);
  const core = new sdk.CoreV1Api(clientConfiguration);
  const policy = { ...config, tokenEndpoint: endpoint };
  const reader = {
    readGitSupervisor: (
      pod: Pick<OpenShellGitSupervisorPod, "namespace" | "sandboxId" | "sandboxName">,
      trusted: OpenShellGitSupervisorPolicy,
      signal: AbortSignal,
    ) => readOpenShellGitSupervisor(core, pod, trusted, signal),
    reviewGitToken: (token: string, audience: string, signal: AbortSignal) =>
      withComputeAbortSignal(signal, () =>
        review.createTokenReview({
          body: {
            apiVersion: "authentication.k8s.io/v1",
            kind: "TokenReview",
            spec: { token, audiences: [audience] },
          },
        }),
      ),
  };
  const projected = new OpenShellProjectedGitAssertion(policy, reader);
  return async (assertion: string, pod: AssertedPod, signal: AbortSignal) => {
    if (!pod.sandboxName) {
      throw new Error("Missing admitted Sandbox name.");
    }
    const admitted = {
      namespace: config.namespace,
      sandboxId: pod.sandboxId,
      sandboxName: pod.sandboxName,
      podUid: pod.podUid,
    };
    return projected.observe(assertion, admitted, signal);
  };
}
