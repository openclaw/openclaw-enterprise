import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Clock, RequestHead } from "../../credentials/backend-contracts.ts";
import type { ExchangeSender } from "../../credentials/internal-contracts.ts";
import type { ServiceConfig, ShutdownSummary } from "../../credentials/service-contracts.ts";
import type { ProviderQueue } from "../../credentials/provider-queue.ts";
import { createCredentialService } from "../../credentials/service.ts";
import { createGitHubDriverFactory } from "./factory.ts";
import type { GitHubKeyOwner } from "./types.ts";
import type { GitHubRepositoryRegistration, GitHubRepositoryRegistry } from "./registry.ts";

interface DescriptionOptions {
  readonly registry: GitHubRepositoryRegistry;
  readonly privateKeyFile: string;
  readonly key: GitHubKeyOwner;
  readonly config: ServiceConfig;
  readonly clock: Clock;
  readonly providerQueue: ProviderQueue;
  readonly trustedEndpoints?: Readonly<{ apiOrigin: string; gitOrigin: string; ca?: Uint8Array }>;
}

type Entry = { state: "pending" | "done"; expiresAt: number; description?: string };
type Service = ReturnType<typeof createCredentialService>;
const successTtlMs = 5 * 60_000;
const failureTtlMs = 60_000;
const cleanupRetryDelayMs = 1000;
const maxConcurrent = 1;
const maxQueued = 20;
const startsPerMinute = 15;
const maxRequested = 20;
const responseLimit = 64 * 1024;

/** Descriptions are optional display data; all token ownership remains in the credential service. */
export function createGitHubRepositoryDescriptions(options: DescriptionOptions) {
  const { registry, config, clock } = options;
  const cache = new Map<string, Entry>();
  const queue: GitHubRepositoryRegistration[] = [];
  const running = new Set<Service>();
  const aborts = new Set<AbortController>();
  let stopped = false;
  let blocked = false;
  let cancelDrain: (() => void) | undefined;
  let wakeCleanupRetry: (() => void) | undefined;
  const starts: number[] = [];
  const apiOrigin = options.trustedEndpoints?.apiOrigin ?? "https://api.github.com";

  function waitForCleanupRetry(): Promise<void> {
    return new Promise((resolve) => {
      let waiting = true;
      const finish = () => {
        if (!waiting) {
          return;
        }
        waiting = false;
        cancel();
        wakeCleanupRetry = undefined;
        resolve();
      };
      const cancel = clock.schedule(cleanupRetryDelayMs, finish);
      wakeCleanupRetry = finish;
      if (stopped) {
        finish();
      }
    });
  }

  function sender(
    repository: GitHubRepositoryRegistration,
    onDescription: (text: string) => void,
  ): ExchangeSender {
    return async (privateRequest, context) => {
      const { plan, headers } = privateRequest;
      if (
        plan.origin !== apiOrigin ||
        plan.method !== "GET" ||
        plan.target !== `/repos/${repository.repository}`
      ) {
        return { kind: "not-dispatched", code: "invalid-metadata-request" };
      }
      const origin = new URL(apiOrigin);
      let outgoing: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let dispatched = false;
      let finishSocket = () => {};
      let stopConnect = () => {};
      let stopHeaders = () => {};
      let stopStall = () => {};
      const socketClosed = new Promise<void>((resolve) => {
        finishSocket = resolve;
      });
      const cancel = () => {
        outgoing?.destroy();
        incoming?.destroy();
      };
      context.signal.addEventListener("abort", cancel, { once: true });
      try {
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          try {
            outgoing = context.gate.dispatch(cancel, () => {
              dispatched = true;
              return httpsRequest(
                {
                  protocol: "https:",
                  hostname: origin.hostname.replace(/^\[|\]$/g, ""),
                  port: origin.port || 443,
                  method: "GET",
                  path: plan.target,
                  headers,
                  agent: false,
                  rejectUnauthorized: true,
                  maxHeaderSize: config.limits.headerBytes,
                  ...(options.trustedEndpoints?.ca
                    ? { ca: Buffer.from(options.trustedEndpoints.ca) }
                    : {}),
                },
                resolve,
              );
            });
            outgoing.once("close", finishSocket);
            outgoing.once("error", reject);
            outgoing.once("socket", (socket) => {
              socket.once("secureConnect", () => stopConnect());
            });
            stopConnect = clock.schedule(plan.limits.connectMs, cancel);
            stopHeaders = clock.schedule(plan.limits.firstHeaderMs, cancel);
            outgoing.end();
          } catch (error) {
            finishSocket();
            reject(error);
          }
        });
        context.gate.track(socketClosed);
        incoming = response;
        stopConnect();
        stopHeaders();
        const resetStall = () => {
          stopStall();
          stopStall = clock.schedule(plan.limits.stallMs, cancel);
        };
        resetStall();
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of response) {
          resetStall();
          size += chunk.length;
          if (size > Math.min(responseLimit, plan.limits.responseBytes)) {
            throw new Error("response-too-large");
          }
          chunks.push(Buffer.from(chunk));
        }
        if (response.statusCode !== 200) {
          throw new Error("metadata-unavailable");
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("invalid-metadata");
        }
        const record = value as Record<string, unknown>;
        if (record.id !== Number(repository.repositoryId)) {
          throw new Error("repository-id-mismatch");
        }
        if (typeof record.description === "string") {
          const description = Array.from(record.description, (character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || code === 0x7f ? " " : character;
          })
            .join("")
            .trim()
            .slice(0, 512);
          if (description) {
            onDescription(description);
          }
        }
        return { kind: "completed", status: 200 };
      } catch {
        cancel();
        return {
          kind: dispatched ? "possibly-dispatched" : "not-dispatched",
          code: "metadata-unavailable",
        };
      } finally {
        stopConnect();
        stopHeaders();
        stopStall();
        context.signal.removeEventListener("abort", cancel);
        if (!outgoing) {
          finishSocket();
        }
        await socketClosed;
      }
    };
  }

  async function lookup(repository: GitHubRepositoryRegistration): Promise<void> {
    const entry = cache.get(repository.repositoryRef)!;
    const abort = new AbortController();
    const factory = createGitHubDriverFactory({
      authority: options.key,
      metadataOnly: true,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      clock,
      ...(options.trustedEndpoints === undefined
        ? {}
        : { trustedEndpoints: options.trustedEndpoints }),
      configuration: {
        kind: "github-app",
        providerInstanceId: registry.providerInstanceId,
        configVersion: "metadata",
        appId: registry.appId,
        installationId: registry.githubInstallationId,
        repositoryId: repository.repositoryId,
        repository: repository.repository,
        privateKeyFile: options.privateKeyFile,
      },
    });
    const service = createCredentialService({
      config: {
        ...config,
        sessionPolicy: {
          ...config.sessionPolicy,
          defaultProfile: "metadata-read",
          allowedProfiles: ["metadata-read"],
        },
      },
      factory,
      clock,
      providerQueue: options.providerQueue,
    });
    running.add(service);
    aborts.add(abort);
    let sessionId: string | undefined;
    let description: string | undefined;
    let success = false;
    try {
      const opened = service.open({
        durationSeconds: Math.min(30, config.sessionPolicy.maximumDurationSeconds),
        profile: "metadata-read",
      });
      sessionId = opened.session.sessionId;
      const head: RequestHead = {
        method: "GET",
        rawTarget: `/repos/${repository.repository}`,
        headers: {},
        receivedMonoMs: clock.monotonicNow(),
        contentEncoding: "identity",
        framing: { kind: "none", bytes: undefined },
      };
      const exchange = service.reserve(opened.bearer, head, abort.signal);
      if (!("kind" in exchange)) {
        const result = await service.execute(
          exchange,
          sender(repository, (value) => {
            description = value;
          }),
        );
        success = result.kind === "completed" && result.status === 200;
      }
    } catch {
      // GitHub metadata must never make approved repositories unavailable.
    } finally {
      if (sessionId) {
        service.close(sessionId);
      }
      aborts.delete(abort);
      entry.state = "done";
      entry.expiresAt = clock.monotonicNow() + (success ? successTtlMs : failureTtlMs);
      if (success && description) {
        entry.description = description;
      }
      // A timed-out or ambiguous issuance keeps this service and its custody alive.
      // It cannot create further tokens while shutdown is pending.
      let result = await service.shutdown(config.limits.shutdownGraceMs);
      if (result.graceExpired && !stopped) {
        blocked = true;
        for (const waiting of queue.splice(0)) {
          const pending = cache.get(waiting.repositoryRef);
          if (pending) {
            pending.state = "done";
            pending.expiresAt = clock.monotonicNow() + failureTtlMs;
            delete pending.description;
          }
        }
      }
      while (result.graceExpired && !stopped) {
        await waitForCleanupRetry();
        if (!stopped) {
          result = await service.shutdown(config.limits.shutdownGraceMs);
        }
      }
      if (!result.graceExpired) {
        running.delete(service);
        blocked = false;
      }
    }
  }

  function drain(): void {
    while (!stopped && running.size < maxConcurrent && queue.length) {
      const now = clock.monotonicNow();
      while (starts.length && starts[0]! <= now - 60_000) {
        starts.shift();
      }
      if (starts.length >= startsPerMinute) {
        cancelDrain ??= clock.schedule(Math.max(1, starts[0]! + 60_000 - now), () => {
          cancelDrain = undefined;
          drain();
        });
        return;
      }
      starts.push(now);
      const repository = queue.shift()!;
      void lookup(repository)
        .catch(() => {
          const entry = cache.get(repository.repositoryRef);
          if (entry) {
            entry.state = "done";
            entry.expiresAt = clock.monotonicNow() + failureTtlMs;
          }
        })
        .finally(drain);
    }
  }

  return {
    list(namespaceId: string, repositoryRefs: readonly string[]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namespaceId)) {
        throw new Error("INVALID_ADMISSION");
      }
      if (
        !Array.isArray(repositoryRefs) ||
        repositoryRefs.length > maxRequested ||
        repositoryRefs.some(
          (ref) => typeof ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref),
        ) ||
        new Set(repositoryRefs).size !== repositoryRefs.length
      ) {
        throw new Error("INVALID_ADMISSION");
      }
      const requested = new Set(repositoryRefs);
      const repositories = registry.repositories.filter(
        (repository) =>
          requested.has(repository.repositoryRef) &&
          repository.namespaces.some((policy) => policy.namespaceId === namespaceId),
      );
      const now = clock.monotonicNow();
      // A newly visible page takes priority over requests for pages no longer in view.
      const prior = queue.splice(0);
      queue.push(...prior.filter((entry) => requested.has(entry.repositoryRef)));
      for (const repository of repositories) {
        const previous = cache.get(repository.repositoryRef);
        if (!stopped && (!previous || (previous.state === "done" && previous.expiresAt <= now))) {
          if (blocked) {
            cache.set(repository.repositoryRef, { state: "done", expiresAt: now + failureTtlMs });
          } else {
            cache.set(repository.repositoryRef, { state: "pending", expiresAt: 0 });
            queue.push(repository);
          }
        }
      }
      for (const entry of prior.filter((item) => !requested.has(item.repositoryRef))) {
        if (queue.length < maxQueued) {
          queue.push(entry);
        } else {
          cache.delete(entry.repositoryRef);
        }
      }
      drain();
      return {
        providerInstanceId: registry.providerInstanceId,
        appId: registry.appId,
        githubInstallationId: registry.githubInstallationId,
        descriptions: repositories.flatMap((repository) => {
          const entry = cache.get(repository.repositoryRef);
          const description =
            entry && entry.state === "done" && entry.expiresAt > now
              ? entry.description
              : undefined;
          return description
            ? [
                {
                  repositoryRef: repository.repositoryRef,
                  repositoryId: repository.repositoryId,
                  description,
                },
              ]
            : [];
        }),
        pending: repositories.some((repository) => {
          const entry = cache.get(repository.repositoryRef);
          return !entry || entry.state === "pending" || entry.expiresAt <= now;
        }),
      };
    },
    async shutdown(graceMs: number): Promise<ShutdownSummary> {
      stopped = true;
      wakeCleanupRetry?.();
      cancelDrain?.();
      cancelDrain = undefined;
      queue.length = 0;
      for (const abort of aborts) {
        abort.abort();
      }
      const summaries = await Promise.all([...running].map((service) => service.shutdown(graceMs)));
      return {
        closedSessions: summaries.reduce((sum, summary) => sum + summary.closedSessions, 0),
        disposedSessions: summaries.reduce((sum, summary) => sum + summary.disposedSessions, 0),
        pendingActions: summaries.reduce((sum, summary) => sum + summary.pendingActions, 0),
        pendingCredentials: summaries.reduce((sum, summary) => sum + summary.pendingCredentials, 0),
        pendingAuxiliary: summaries.reduce((sum, summary) => sum + summary.pendingAuxiliary, 0),
        graceExpired: summaries.some((summary) => summary.graceExpired),
      };
    },
  };
}
