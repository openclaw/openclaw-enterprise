import { repositoryApprovalFingerprint } from "@openclaw-enterprise/occ";
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type {
  PreparedGitHubUseRequest,
  PreparedGitHubPullResult,
} from "@openclaw-enterprise/contracts";
import type { PostgresPool } from "@openclaw-enterprise/occ";
import { createSystemClock } from "../../drivers/repo/credentials/clock.ts";
import { githubProviderOrigin } from "../../drivers/repo/github/credentials/factory.ts";
import { preparationIssuerAuthority } from "../../drivers/repo/github/credentials/grants.ts";
import { createGitHubKeyOwner } from "../../drivers/repo/github/credentials/material.ts";
import { createGitHubPreparationOwner } from "../../drivers/repo/github/credentials/prepared-owner.ts";
import { retirePreparedGitHubToken } from "../../drivers/repo/github/credentials/prepared-lifecycle.ts";
import { PreparedRepositoryGitStore } from "../../drivers/repo/github/credentials/prepared-repository-git.ts";
import {
  validateGitHubRepositoryRegistry,
  resolveGitHubRepositoryBinding,
  resolveGitHubStandingApprovalScope,
  type GitHubRepositoryRegistry,
} from "../../drivers/repo/github/credentials/registry.ts";
import { servePrivateRepositoryRequest } from "./private-request-server.ts";

export interface PreparedRepositoryGitConfiguration {
  readonly privateKeyPath: string;
  readonly custodyKeyPath: string;
  readonly apiOrigin?: string;
  /** Mounted in the worker, not required in the API's filesystem. */
  readonly issuerCaPath?: string;
}

interface Options extends Omit<PreparedRepositoryGitConfiguration, "issuerCaPath"> {
  ca?: Uint8Array;
  pool: PostgresPool;
  controlSocket: string;
  driverId: string;
  implementation: string;
  backendId: string;
  registry: GitHubRepositoryRegistry;
  /** `context` names the affected revision and repository binding, never a credential. */
  report?: (
    code:
      | "PREPARED_GITHUB_RECOVERY_REQUIRED"
      | "PREPARED_GITHUB_MAINTENANCE_FAILED"
      | "PREPARED_GITHUB_RETIRED_UNREVOKED",
    context?: Readonly<Record<string, string>>,
  ) => void;
  startWorker?: boolean;
}

function useRequest(input: unknown): PreparedGitHubUseRequest {
  const q = input as PreparedGitHubUseRequest;
  const fields = [
    "providerInstanceId",
    "grantId",
    "repositoryId",
    "sessionId",
    "exchangeId",
    "operation",
    "requestDigestSha256",
    "pushRef",
    "deadlineAt",
    ...(q?.operation === "create-draft-pull" ? ["pull"] : []),
  ];
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).length !== fields.length ||
    Object.entries(input).some(
      ([k, v]) =>
        !fields.includes(k) || (k !== "pull" && (typeof v !== "string" || !v || v.length > 1024)),
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(q.exchangeId) ||
    !/^[0-9a-f]{64}$/.test(q.requestDigestSha256) ||
    !q.pushRef.startsWith("refs/heads/") ||
    ![
      "advertise-upload-pack",
      "upload-pack",
      "advertise-receive-pack",
      "receive-pack",
      "create-draft-pull",
    ].includes(q.operation)
  ) {
    throw new Error("INVALID_PREPARED_GIT_USE");
  }
  return q;
}

// Kubernetes projects a private 0440 file through a symlink; only the worker mounts it.
async function privateInput(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const { mode, size } = await file.stat();
    if (
      (mode & constants.S_IFMT) !== constants.S_IFREG ||
      (mode & 0o027) !== 0 ||
      !size ||
      size > 32768
    ) {
      throw new Error("INVALID_PREPARED_GITHUB_KEY_MOUNT");
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

/** A single owner of App issuance, renewal, durable uncertainty and retirement.
 * No Git request can call maintain, and neither the broker nor API needs either key mount. */
export async function startPreparedGitHubGitOwner(options: Options) {
  const registry = validateGitHubRepositoryRegistry(options.registry, options.backendId);
  for (const repo of registry.repositories) {
    if (
      repo.namespaces.some(
        (p) =>
          !["git-only", "git-and-draft-pr"].includes(p.transport ?? "") ||
          p.pushRefAllowlist?.length !== 1,
      )
    ) {
      throw new Error("PREPARED_REPOSITORY_REQUIRES_ONE_EXPLICIT_REVIEW_REF");
    }
  }
  const clock = createSystemClock();
  const apiOrigin = githubProviderOrigin(options.apiOrigin ?? "https://api.github.com");
  const ca = options.ca;
  const authority = preparationIssuerAuthority(apiOrigin, ca);
  const custody = await privateInput(options.custodyKeyPath);
  if (custody.length !== 32) {
    custody.fill(0);
    throw new Error("INVALID_PREPARED_GITHUB_CUSTODY_KEY");
  }
  const store = new PreparedRepositoryGitStore(options.pool, custody, authority, (session) => {
    const { driver, binding, namespaceId } = session;
    const { repositoryRef, profile } = binding;
    const repo = registry.repositories.find((r) => r.repositoryRef === repositoryRef);
    const policy = repo?.namespaces.find((p) => p.namespaceId === namespaceId);
    const pushRef = policy?.pushRefAllowlist?.[0];
    const base = policy?.transport === "git-and-draft-pr" ? policy.pullRequestBase : undefined;
    if (
      !repo ||
      !pushRef ||
      profile !== "git-write" ||
      driver.id !== options.driverId ||
      driver.implementation !== options.implementation
    ) {
      return;
    }
    if (session.standingApprovalId !== undefined) {
      const scope = resolveGitHubStandingApprovalScope(registry, { namespaceId, binding });
      if (
        !scope ||
        session.standingApprovalScopeFingerprint !==
          repositoryApprovalFingerprint({ namespaceId, agentId: session.agentId, binding, scope })
      ) {
        return;
      }
    }
    const admitted = resolveGitHubRepositoryBinding(registry, {
      namespaceId,
      repositoryRef,
      profile,
    });
    if (!isDeepStrictEqual(binding, admitted)) {
      return;
    }
    return {
      key: { source: { id: "repository-git:" + session.admissionId } },
      adoption: "prepared_repository_git",
      session,
      grant: {
        id: admitted.grant.grantId,
        isolationId: session.revisionId,
        appId: registry.appId,
        installationId: registry.githubInstallationId,
        repositoryId: repo.repositoryId,
        repository: repo.repository,
        profile: base ? "git-ref-draft-pr" : "git-ref-write",
        ...(base ? { pullRequestBase: base } : {}),
        pushRef,
      },
      ...(base && policy?.draftPullLimit === "none" ? { draftPullLimit: "none" as const } : {}),
    };
  });
  const stop = new AbortController();
  const use = (input: unknown, signal = stop.signal) =>
    store.use(useRequest(input), AbortSignal.any([signal, stop.signal]));
  const server = await servePrivateRepositoryRequest(
    options.controlSocket,
    "prepared-git-use",
    (input, signal) =>
      input.operation === "record-draft-pull"
        ? store.finishPull(input.receiptId as string, input.outcome as PreparedGitHubPullResult)
        : use(input, signal),
  );
  async function maintain() {
    stop.signal.throwIfAborted();
    // A replaced version's token from an earlier issuer authority (another App origin or CA) is
    // retired, but revoking it would send it to this authority: it lives out its hour at the
    // provider instead, and the operator is told once (finding 2150).
    const sources = await store.discover(({ providerExpiresAt, ...context }) =>
      options.report?.("PREPARED_GITHUB_RETIRED_UNREVOKED", {
        reason: "issuer_authority_changed",
        ...context,
        providerExpiresAt,
      }),
    );
    await retirePreparedGitHubToken(store, null, stop.signal, apiOrigin, ca, clock);
    if (!sources.length) {
      return;
    }
    const bytes = await privateInput(options.privateKeyPath);
    const keyObject = (() => {
      try {
        return createPrivateKey(bytes);
      } finally {
        bytes.fill(0);
      }
    })();
    const version = createHash("sha256")
      .update(createPublicKey(keyObject).export({ type: "spki", format: "der" }))
      .digest("hex");
    const key = createGitHubKeyOwner({ privateKey: keyObject, appId: registry.appId, clock });
    try {
      for (const source of sources) {
        const admission = await store.claimGit(source, version);
        if (!admission) {
          continue;
        }
        const owner = createGitHubPreparationOwner({
          admission,
          store: store.store(source, null),
          clock,
          apiOrigin,
          getKey: async () => key,
          ...(ca ? { ca } : {}),
          renewBeforeMs: 600_000,
          minimumValidityMs: 60_000,
        });
        const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(25_000)]);
        const outcome = await owner.run(randomUUID(), {
          signal,
          deadlineMonoMs: clock.monotonicNow() + 25_000,
        });
        if (outcome === "quarantined" || outcome === "blocked") {
          // Say which binding needs recovery (finding 2135); the provider's answer stays out.
          options.report?.("PREPARED_GITHUB_RECOVERY_REQUIRED", {
            reason: outcome,
            namespaceId: source.session.namespaceId,
            revisionId: source.session.revisionId,
            repositoryRef: source.session.binding.repositoryRef,
          });
        }
      }
    } finally {
      key.close();
    }
  }
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    running = maintain()
      .catch(() => options.report?.("PREPARED_GITHUB_MAINTENANCE_FAILED"))
      .finally(() => {
        if (!stop.signal.aborted) {
          timer = setTimeout(tick, 5000);
        }
      });
  };
  if (options.startWorker !== false) {
    tick();
  }
  return {
    use,
    // Recovery-only observation for the worker, never part of its use socket.
    inspectTokenAttempt: (familyId: string, attemptId: string) =>
      store.inspectTokenAttempt(familyId, attemptId),
    // Worker-only custody transfer to the verified OpenShell provider; never a control RPC.
    readOpenShellMaterial(revisionId: string, signal: AbortSignal) {
      return store.readOpenShellMaterial(revisionId, AbortSignal.any([signal, stop.signal]));
    },
    // Internal authority callback only. Never expose it as a workload or token-disclosure RPC.
    authorizeOpenShellRequest(
      request: PreparedGitHubUseRequest,
      installed: { preparationAttemptId: string; materialVersion: string },
      signal: AbortSignal,
    ) {
      return store.authorizeOpenShellRequest(
        useRequest(request),
        installed,
        AbortSignal.any([signal, stop.signal]),
      );
    },
    maintain,
    async close() {
      stop.abort();
      clearTimeout(timer);
      try {
        await server.close();
      } finally {
        await running;
        custody.fill(0);
      }
    },
  };
}
