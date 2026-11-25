import { createPrivateKey } from "node:crypto";

import type { GitHubAppInstallationScope } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";

import type { Clock } from "../repo/access/backend-contracts.ts";
import { createSystemClock } from "../repo/access/clock.ts";
import {
  parseInstallationTokenResponse,
  validateInstallationTokenResponse,
} from "../repo/github/access/installation-token-response.ts";
import { createGitHubKeyOwner } from "../repo/github/access/material.ts";
import { githubProviderOrigin } from "../repo/github/access/origin.ts";
import { prepareGitHubAppProviderScope } from "../repo/github/access/provider-transport/request-options.ts";
import { createProviderTransport } from "../repo/github/access/provider-transport.ts";
import { sendProviderRequest } from "../repo/github/access/provider-transport/request.ts";
import {
  createRepositorySlugPattern,
  parseGitHubNumericId,
  type GitHubAppRepositorySelection,
} from "../repo/github/access/repository-grant.ts";
import { isGitHubWireCredential } from "../repo/github/access/wire-credential.ts";

const providerTimeoutMs = 10_000;
const rejectedTokenCleanupTimeoutMs = 3_000;
const minimumValidityMs = 60_000;

function providerAttempt(clock: Clock, signal: AbortSignal, timeoutMs: number) {
  const assertAdmitted = () => signal.throwIfAborted();
  return {
    signal,
    deadlineMonoMs: clock.monotonicNow() + timeoutMs,
    assertAdmitted,
    observeDispatch: assertAdmitted,
  };
}

function signingKey(privateKey: string, appId: string, clock: Clock) {
  try {
    return createGitHubKeyOwner({ privateKey: createPrivateKey(privateKey), appId, clock });
  } catch {
    throw new Error("The provisioned GitHub App signing key is invalid.");
  }
}

export interface GitHubAppIssuerOptions {
  readonly apiOrigin?: string;
  readonly ca?: Uint8Array;
  readonly clock?: Clock;
}

/** The issuer alone selects the trusted origin and uses App signing material. */
export function createGitHubAppSourceIssuer(options: GitHubAppIssuerOptions = {}) {
  const origin = githubProviderOrigin(options.apiOrigin ?? "https://api.github.com");
  const ca = options.ca && Buffer.from(options.ca);
  const clock = options.clock ?? createSystemClock();

  return {
    /** Verify key ownership without creating an installation token. */
    async verifySigningKey(appId: string, privateKey: string, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      const expectedId = parseGitHubNumericId(appId);
      if (expectedId === undefined) {
        throw new Error("The GitHub App identity could not be verified.");
      }
      let key: ReturnType<typeof createGitHubKeyOwner> | undefined;
      let verified = false;
      try {
        key = signingKey(privateKey, appId, clock);
        const attempt = providerAttempt(clock, signal, providerTimeoutMs);
        await key.withJwt((authorization, assertMaterialCurrent) =>
          sendProviderRequest({
            endpoint: origin,
            operation: "verify-app",
            ca,
            clock,
            authorization,
            attempt,
            assertMaterialCurrent,
            consumeResponse: ({ status, body }) => {
              if (status !== 200) {
                return;
              }
              const response: unknown = JSON.parse(body.toString("utf8"));
              verified =
                typeof response === "object" &&
                response !== null &&
                !Array.isArray(response) &&
                "id" in response &&
                Number.isSafeInteger(response.id) &&
                response.id === expectedId;
            },
          }),
        );
        signal.throwIfAborted();
      } catch {
        signal.throwIfAborted();
      } finally {
        key?.close();
      }
      if (!verified) {
        throw new Error("The GitHub App identity could not be verified.");
      }
    },
    async mintInstallationToken(
      scope: GitHubAppRepositorySelection,
      privateKey: string,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      const key = signingKey(privateKey, scope.appId, clock);
      const attempt = providerAttempt(clock, signal, providerTimeoutMs);
      let exchange: ReturnType<typeof createProviderTransport> | undefined;
      let candidate: string | undefined;
      let issued:
        | {
            readonly credential: string;
            readonly expiresAt: string;
            readonly providerExpiresAt: string;
            readonly repositories: GitHubAppInstallationScope["repositories"];
          }
        | undefined;
      try {
        await key.withJwt(async (jwt, assertCurrent) => {
          let selection = scope;
          if (scope.repositories.some(({ repositoryId }) => repositoryId === undefined)) {
            const installationId = parseGitHubNumericId(scope.installationId);
            const appId = parseGitHubNumericId(scope.appId);
            if (installationId === undefined || appId === undefined) {
              throw new Error("The GitHub App installation identity is invalid.");
            }
            let owner: string | undefined;
            await sendProviderRequest({
              endpoint: origin,
              operation: "verify-installation",
              installationId,
              ca,
              clock,
              authorization: jwt,
              attempt,
              assertMaterialCurrent: assertCurrent,
              consumeResponse: ({ status, body }) => {
                if (status !== 200) {
                  return;
                }
                const response = asRecord(JSON.parse(body.toString("utf8")));
                const login = asRecord(response?.account)?.login;
                if (
                  response?.id === installationId &&
                  response.app_id === appId &&
                  typeof login === "string" &&
                  createRepositorySlugPattern().test(`${login}/repository`)
                ) {
                  owner = login.toLowerCase();
                }
              },
            });
            if (!owner) {
              throw new Error("The GitHub App installation could not be verified.");
            }
            selection = {
              ...scope,
              repositories: scope.repositories.map(({ repository, repositoryId }) => ({
                ...(repositoryId === undefined ? {} : { repositoryId }),
                repository: repository.includes("/") ? repository : `${owner}/${repository}`,
              })),
            };
            if (
              selection.repositories.some(({ repository }) => !repository.startsWith(owner + "/"))
            ) {
              throw new Error("The repository owner differs from the GitHub App installation.");
            }
          }
          const providerScope = prepareGitHubAppProviderScope(origin, selection);
          exchange = createProviderTransport(ca, clock, providerScope);
          await exchange.issue(jwt, attempt, assertCurrent, ({ status, body }) => {
            const { packet, token } = parseInstallationTokenResponse(body);
            candidate = token;
            const result = validateInstallationTokenResponse(
              status,
              packet,
              candidate,
              clock.wallNow(),
              providerScope,
              minimumValidityMs,
            );
            if (result.kind === "validated" && result.repositories) {
              issued = {
                credential: result.credential,
                expiresAt: new Date(result.usableUntil).toISOString(),
                providerExpiresAt: new Date(result.providerExpiresAt).toISOString(),
                repositories: result.repositories,
              };
            }
          });
        });
        signal.throwIfAborted();
        if (issued !== undefined) {
          return issued;
        }
      } catch {
        // Provider and transport errors never leave the issuer with response details.
      } finally {
        key.close();
      }

      if (exchange && isGitHubWireCredential(candidate)) {
        // A rejected response can still identify a live token. Use a separate short
        // budget to revoke the exact candidate even if the issuance caller has left.
        const cleanup = providerAttempt(
          clock,
          AbortSignal.timeout(rejectedTokenCleanupTimeoutMs),
          rejectedTokenCleanupTimeoutMs,
        );
        await exchange.revoke(candidate, cleanup).catch(() => false);
      }
      throw new Error("GitHub did not issue a usable installation token.");
    },
    async revoke(scope: GitHubAppInstallationScope, credential: string, signal: AbortSignal) {
      signal.throwIfAborted();
      const providerScope = prepareGitHubAppProviderScope(origin, scope);
      const exchange = createProviderTransport(ca, clock, providerScope);
      return exchange.revoke(credential, providerAttempt(clock, signal, providerTimeoutMs));
    },
  };
}

export type GitHubAppSourceIssuer = ReturnType<typeof createGitHubAppSourceIssuer>;
