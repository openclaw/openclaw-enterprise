import { createPublicKey, sign, type KeyObject } from "node:crypto";
import { validRepositoryGitRecipient } from "@openclaw-enterprise/contracts";
import type {
  EgressExecution,
  EgressInstallation,
  ProxyPlan,
  EgressRef,
} from "@openclaw-enterprise/contracts";

export const HARNESS_EGRESS_ENROLLMENT_PATH = "/openclaw/runtime/egress-enrollment";

export interface HarnessEgressEnrollment {
  readonly routeCount: number;
  readonly inference: boolean | "credential_source";
  readonly plan: EgressRef;
  readonly execution: EgressExecution;
}

export function harnessEgressEnrollment(plan: ProxyPlan): HarnessEgressEnrollment {
  // Project keys in wire order: PostgreSQL JSONB does not preserve insertion order.
  const { installationId, namespaceId, agentId, servicePrincipalId, revisionId, executionId } =
    plan.execution;
  return {
    routeCount: plan.routes.length + (plan.repositoryGit ? 1 : 0),
    inference: plan.harnessCredentialSource
      ? "credential_source"
      : plan.routes.some((route) => route.binding.grant.kind === "inference"),
    plan: { id: plan.id, generation: plan.generation },
    execution: {
      installationId,
      namespaceId,
      agentId,
      servicePrincipalId,
      revisionId,
      executionId,
    },
  };
}

export const COMPUTE_RELEASE_PROFILE = "oce-compute-execution-release-v1";
export const COMPUTE_RELEASE_PUBLIC_KEY = "OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY";

export function computeReleasePublicKey(key: KeyObject): string {
  return createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url");
}

/** Called only by Compute after committed association and a fresh verification of that installation. */
export function signComputeExecutionRelease(
  privateKey: KeyObject,
  startupId: string,
  { plan, enforcement, sandboxId }: EgressInstallation,
) {
  const installation = {
    sandboxId,
    instanceId: enforcement.instanceId,
    configurationId: enforcement.configurationId,
    peerKeyId: enforcement.peerKeyId,
  };
  if (
    !Object.values(installation).every((value) => typeof value === "string" && value.length > 0)
  ) {
    throw new Error("Protected execution release requires the exact enrolled installation.");
  }
  if (plan.repositoryGit && !validRepositoryGitRecipient(enforcement.repositoryGitRecipient)) {
    throw new Error("Repository Git release requires the verified recipient of this installation.");
  }
  const released = plan.repositoryGit
    ? { ...installation, repositoryGitRecipient: enforcement.repositoryGitRecipient }
    : installation;
  const challenge = {
    profile: COMPUTE_RELEASE_PROFILE,
    ...harnessEgressEnrollment(plan),
    startupId,
  };
  const expiresAt = Date.now() + 30_000;
  const transcript = JSON.stringify([challenge, released, expiresAt]);
  return {
    challenge,
    installation: released,
    expiresAt,
    signature: sign(null, Buffer.from(transcript), privateKey).toString("base64url"),
  };
}

// This runs in the generated Harness, before Codex, login or its first model probe. The transport
// bearer may read this challenge; only Compute can sign its release.
export const HARNESS_EGRESS_ENROLLMENT_HELPER = String.raw`
function waitForHarnessEgressEnrollment(enrollment) {
  const { createHash, createPublicKey, randomUUID, timingSafeEqual, verify } = require("node:crypto");
  const { isDeepStrictEqual } = require("node:util");
  const { createServer } = require("node:http");
  const verifier = process.env.APP_TOKEN_SHA;
  const port = Number(process.env.APP_SERVER_PORT);
  const executionKeys = ["installationId", "namespaceId", "agentId", "servicePrincipalId", "revisionId", "executionId"];
  if (typeof verifier !== "string" || !/^[a-f0-9]{64}$/.test(verifier) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      !isPlainObject(enrollment) || Object.keys(enrollment).length !== 4 ||
      (typeof enrollment.inference !== "boolean" && enrollment.inference !== "credential_source") ||
      !Number.isSafeInteger(enrollment.routeCount) || enrollment.routeCount < 0 ||
      !isPlainObject(enrollment.plan) || Object.keys(enrollment.plan).length !== 2 ||
      typeof enrollment.plan.id !== "string" || !enrollment.plan.id || enrollment.plan.id.length > 256 ||
      !Number.isSafeInteger(enrollment.plan.generation) || enrollment.plan.generation < 1 ||
      !isPlainObject(enrollment.execution) || Object.keys(enrollment.execution).length !== executionKeys.length ||
      executionKeys.some((key) => typeof enrollment.execution[key] !== "string" ||
        !enrollment.execution[key] || enrollment.execution[key].length > 256) ||
      enrollment.execution.revisionId !== process.env.OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID) {
    return Promise.reject(new Error("Protected Harness enrollment configuration is invalid."));
  }
  const encodedKey = process.env.OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY;
  if (typeof encodedKey !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(encodedKey)) {
    return Promise.reject(new Error("Protected Harness Compute release verification key is missing."));
  }
  const key = createPublicKey({key: Buffer.from(encodedKey, "base64url"), type: "spki", format: "der"});
  if (key.asymmetricKeyType !== "ed25519") {
    return Promise.reject(new Error("Protected Harness Compute release verification key is invalid."));
  }
  const expected = Buffer.from(verifier, "hex");
  const challenge = { profile: "oce-compute-execution-release-v1", ...enrollment, startupId: randomUUID() };
  const deadline = performance.now() + 180000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let released = false;
    const finish = (enrolled) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Close the temporary listener before Codex or the held-failure server binds.
      server.close(() => {
        if (enrolled) {
          resolve();
        } else {
          reject(new Error("Protected Harness enrollment failed."));
        }
      });
      server.closeAllConnections();
    };
    const server = createServer(async (request, response) => {
      const answer = (status, body) => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        response.end(JSON.stringify(body));
      };
      const authorization = typeof request.headers.authorization === "string"
        ? /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(request.headers.authorization) : null;
      if (authorization === null || !timingSafeEqual(createHash("sha256").update(authorization[1]).digest(), expected)) {
        answer(401, { error: "unauthorized" });
        return;
      }
      if (settled || released || performance.now() >= deadline) {
        answer(410, { error: "expired" });
        return;
      }
      if (request.url !== ${JSON.stringify(HARNESS_EGRESS_ENROLLMENT_PATH)}) {
        answer(404, { error: "not_found" });
        return;
      }
      if (request.method === "GET") {
        answer(200, challenge);
        return;
      }
      if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
        answer(400, { error: "invalid_request" });
        return;
      }
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 4096) {
            answer(413, { error: "invalid_request" });
            return;
          }
          chunks.push(chunk);
        }
        const release = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const { installation, expiresAt, signature } = release ?? {};
        const now = Date.now();
        if (settled || released || performance.now() >= deadline ||
            !isDeepStrictEqual(release.challenge, challenge) || !isPlainObject(installation) ||
            !["sandboxId", "instanceId", "configurationId", "peerKeyId"].every((k) =>
              typeof installation[k] === "string" && installation[k].length > 0) ||
            !Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + 60000 ||
            typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
            !verify(null, Buffer.from(JSON.stringify([challenge, installation, expiresAt])), key,
              Buffer.from(signature, "base64url"))) {
          answer(409, { error: "stale_enrollment" });
          return;
        }
        // A release is only startup coordination. Both per-request authority
        // checks still run before any material access or business send.
        released = true;
        response.on("finish", () => finish(true));
        answer(200, { enrolled: true, startupId: challenge.startupId });
      } catch {
        if (!response.destroyed) {
          answer(400, { error: "invalid_request" });
        }
      }
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.maxConnections = 16;
    const timer = setTimeout(() => finish(false), 180000);
    server.on("error", () => finish(false));
    server.listen(port, "0.0.0.0");
  });
}
`;
