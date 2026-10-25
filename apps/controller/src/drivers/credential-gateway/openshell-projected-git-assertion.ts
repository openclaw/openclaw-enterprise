import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { asRecord } from "@openclaw-enterprise/utils";
import {
  OpenShellGitPodObservations,
  type AdmittedGitPod,
} from "./openshell-git-pod-observations.ts";
import { parseUnambiguousJson } from "../repo/credentials/json-members.ts";
import type { V1TokenReview } from "@kubernetes/client-node";
import type {
  OpenShellGitSupervisorPod,
  OpenShellGitSupervisorPolicy,
} from "../kubernetes/openshell-git-supervisor.ts";

type Policy = OpenShellGitSupervisorPolicy & {
  readonly assertionSource: "kubernetes-projected-token";
  readonly tokenEndpoint: string;
  readonly clusterIssuer: string;
};
type TokenObservation = {
  valid: boolean;
  readonly token: string;
  readonly pod: string;
};
const denied = () => new Error("Projected Git assertion could not be verified.");

/** Installation-owned authority. Active observations retain negative knowledge only until
 * their bounded issuer operation ends; matching concurrent successes never invalidate one another. */
interface ProjectedTokenReader {
  reviewGitToken(token: string, audience: string, signal: AbortSignal): Promise<V1TokenReview>;
  readGitSupervisor(
    pod: AdmittedGitPod,
    policy: OpenShellGitSupervisorPolicy,
    signal: AbortSignal,
  ): Promise<OpenShellGitSupervisorPod>;
}
export class OpenShellProjectedGitAssertion {
  private readonly activeTokens = new Set<TokenObservation>();
  private readonly pods = new OpenShellGitPodObservations();
  private readonly policy: Policy;
  private readonly kubernetes: ProjectedTokenReader;
  constructor(policy: Policy, kubernetes: ProjectedTokenReader) {
    this.policy = structuredClone(policy);
    this.kubernetes = kubernetes;
  }

  async observe(
    assertion: string,
    admitted: AdmittedGitPod,
    lifetime: AbortSignal,
  ): Promise<() => boolean> {
    const podObservation = this.pods.observe(admitted, lifetime);
    const pod = podObservation.identity;
    const token = createHash("sha256").update(assertion).digest("hex");
    const observation = { valid: true, token, pod };
    this.activeTokens.add(observation);
    lifetime.addEventListener("abort", () => this.activeTokens.delete(observation), { once: true });
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(2000)]);
    let expires = 0;
    let rejectAbort!: () => void;
    try {
      await Promise.race([
        new Promise<never>((_resolve, reject) => {
          rejectAbort = () => reject(denied());
          signal.addEventListener("abort", rejectAbort, { once: true });
          if (signal.aborted) {
            rejectAbort();
          }
        }),
        (async () => {
          if (assertion.length > 16384) {
            throw denied();
          }
          const review = await this.kubernetes.reviewGitToken(
            assertion,
            this.policy.tokenEndpoint,
            signal,
          );
          signal.throwIfAborted();
          const status = review.status;
          const extra = status?.user?.extra;
          const username = `system:serviceaccount:${admitted.namespace}:${this.policy.supervisorServiceAccountName}`;
          if (
            status?.authenticated !== true ||
            status.error ||
            !isDeepStrictEqual(status.audiences, [this.policy.tokenEndpoint]) ||
            status.user?.username !== username ||
            !isDeepStrictEqual(extra?.["authentication.kubernetes.io/pod-name"], [
              `os-supervisor-${admitted.sandboxId.toLowerCase()}`,
            ]) ||
            !isDeepStrictEqual(extra?.["authentication.kubernetes.io/pod-uid"], [admitted.podUid])
          ) {
            throw denied();
          }
          // Only inspect claims after the configured API authenticated the signature. Never
          // select an issuer, URL, key or authority from unverified token content.
          const parts = assertion.split(".");
          if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
            throw denied();
          }
          const decode = (part: string) =>
            asRecord(
              parseUnambiguousJson(
                new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(part, "base64url")),
              ),
            );
          const header = decode(parts[0]!);
          const claims = decode(parts[1]!);
          const now = Date.now() / 1000;
          if (
            !header ||
            typeof header.alg !== "string" ||
            header.alg === "none" ||
            !claims ||
            claims.iss !== this.policy.clusterIssuer ||
            claims.sub !== username ||
            !isDeepStrictEqual(claims.aud, [this.policy.tokenEndpoint]) ||
            !Number.isSafeInteger(claims.iat) ||
            !Number.isSafeInteger(claims.nbf) ||
            !Number.isSafeInteger(claims.exp) ||
            Number(claims.iat) > now ||
            Number(claims.nbf) > now ||
            Number(claims.exp) <= now ||
            Number(claims.nbf) < Number(claims.iat) ||
            Number(claims.nbf) >= Number(claims.exp) ||
            Number(claims.exp) - Number(claims.iat) > 600 ||
            Number(claims.exp) <= Number(claims.iat)
          ) {
            throw denied();
          }
          expires = Number(claims.exp) * 1000;
        })(),
      ]);
    } catch {
      // Cancellation of an ended operation is not evidence against another exchange.
      // A read deadline while the lifetime is still live is a credential failure,
      // so check lifetime rather than the signal that includes that deadline.
      if (!lifetime.aborted) {
        for (const active of this.activeTokens) {
          if (active.pod === pod && active.token === token) {
            active.valid = false;
          }
        }
      }
      throw denied();
    } finally {
      signal.removeEventListener("abort", rejectAbort);
    }
    try {
      await podObservation.check(
        () => this.kubernetes.readGitSupervisor(admitted, this.policy, signal),
        signal,
      );
      if (!observation.valid) {
        throw denied();
      }
      return () => observation.valid && podObservation.isCurrent() && Date.now() < expires;
    } catch {
      throw denied();
    }
  }
}
