import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import type {
  EgressInstallation,
  PreparedGitHubRepositoryUseRequest,
  ProtectedGitHubRepositoryMaterial,
  RepositoryGitInstallationFence,
  RepositoryGitMaterialVersion,
} from "@openclaw-enterprise/contracts";
import {
  configurationSchema as repositorySchema,
  createDriver as createRepositoryDriver,
  validateConfiguration as validateRepositoryConfiguration,
} from "./repository-git.ts";

export const configurationSchema = {
  ...repositorySchema,
  properties: {
    ...repositorySchema.properties,
    mutationWitness: { type: ["object", "null"] },
  },
};
type RepositoryDriverOptions = Parameters<typeof createRepositoryDriver>[0];
type Configuration = RepositoryDriverOptions["configuration"] & { mutationWitness?: object | null };
export function validateConfiguration({
  mutationWitness: _witness,
  ...configuration
}: Configuration) {
  return validateRepositoryConfiguration(configuration);
}

const evaluationMarker = process.env.OCC_TEST_REPOSITORY_DRIVER_EVALUATION_MARKER;
if (evaluationMarker) {
  writeFileSync(evaluationMarker, "evaluated");
  throw new Error("The issuer must not evaluate the selected Driver module.");
}

export type RecipientSend = Readonly<{
  method: "GET" | "POST";
  path: string;
  contentType?: string;
  body?: string;
}>;

export type RecipientCommand =
  | { kind: "observe"; installation: EgressInstallation }
  | { kind: "prepare" }
  | { kind: "read" }
  | {
      kind: "use";
      request: PreparedGitHubRepositoryUseRequest;
      outbound: RecipientSend;
      wrongVersion?: string;
    };

export function recipientSendDigest(origin: string, outbound: RecipientSend): string {
  const { method, path, contentType, body } = outbound;
  return createHash("sha256")
    .update(JSON.stringify([method, origin, path, contentType ?? null, body ?? null]))
    .digest("hex");
}

export function createDriver(
  options: Omit<RepositoryDriverOptions, "configuration"> & {
    configuration: Configuration;
  },
) {
  const { mutationWitness, ...configuration } = options.configuration;
  const original = createRepositoryDriver({ ...options, configuration });
  // Change a valid startup value to exercise registration refusal and owner cleanup.
  const { releaseKey } = options.configuration;
  const missingTransport = releaseKey.startsWith("missing-transport:");
  const marker =
    releaseKey.startsWith("mutate:") || missingTransport
      ? releaseKey.slice(releaseKey.indexOf(":") + 1)
      : undefined;
  if (marker !== undefined) {
    appendFileSync(marker, "created\n");
    const capabilities = { ...original.capabilities };
    if (missingTransport) {
      const { repositoryAccess: _repositoryAccess, ...sandbox } = capabilities.sandbox!;
      capabilities.sandbox = sandbox;
    } else if (mutationWitness === undefined) {
      options.configuration.releaseKey = "changed";
    } else {
      options.configuration.mutationWitness = new Date(0);
    }
    return {
      ...original,
      capabilities,
      async close() {
        await original.close?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        appendFileSync(marker, "closed\n");
        if (options.configuration.policyReduction) {
          throw new Error("Controlled close failure.");
        }
      },
    };
  }
  const proxy = original.capabilities.credential_proxy!;
  const ca = readFileSync(options.configuration.certFile);
  const origin = new URL(options.configuration.origin);
  assert.equal(origin.hostname, "127.0.0.1");
  return {
    ...original,
    capabilities: {
      ...original.capabilities,
      credential_proxy: {
        ...proxy,
        bindRepositoryGit(authority: Parameters<NonNullable<typeof proxy.bindRepositoryGit>>[0]) {
          const repository = authority.online.githubRepository!;
          let route: RepositoryGitInstallationFence | undefined;
          let installed: ProtectedGitHubRepositoryMaterial | undefined;
          // Only the installed Driver receives the Worker's authority and token material.
          async function command(input: RecipientCommand) {
            if (input.kind === "observe") {
              route = await authority.recipients.observe(input.installation);
              return route !== undefined;
            }
            assert.ok(route);
            const signal = AbortSignal.timeout(5000);
            if (input.kind === "prepare" || input.kind === "read") {
              const material = await repository.readMaterial(route, signal);
              if (!material || !("value" in material)) {
                return material?.absent ?? "missing";
              }
              const version: RepositoryGitMaterialVersion = {
                preparationAttemptId: material.preparationAttemptId,
                materialVersion: material.materialVersion,
              };
              if (input.kind === "prepare") {
                const pending = await authority.recipients.beginInstall(route, version);
                assert.ok(pending);
                installed = material;
                route = await authority.recipients.confirmInstall({
                  ...pending,
                  preparationAttemptId: installed.preparationAttemptId,
                  materialVersion: installed.materialVersion,
                });
                assert.ok(route);
              }
              return version;
            }
            assert.ok(installed);
            const decision = await repository.authorize(
              input.request,
              {
                route,
                preparationAttemptId: installed.preparationAttemptId,
                materialVersion: input.wrongVersion ?? installed.materialVersion,
              },
              signal,
            );
            if (decision.kind !== "allow") {
              return { decision };
            }
            const { request } = input;
            assert.equal(decision.exchangeId, request.exchangeId);
            assert.equal(decision.requestDigestSha256, request.requestDigestSha256);
            assert.equal(decision.preparationAttemptId, installed.preparationAttemptId);
            assert.equal(decision.materialVersion, installed.materialVersion);
            assert.ok(Date.parse(decision.replyBy) > Date.now());
            const { method, path, body, contentType } = input.outbound;
            const api = request.operation === "github-rest";
            const target = new URL(path, api ? installed.apiOrigin : origin);
            assert.equal(target.hostname, "127.0.0.1");
            assert.equal(target.protocol, "https:");
            assert.equal(
              request.requestDigestSha256,
              recipientSendDigest(target.origin, input.outbound),
            );
            const authorization = api
              ? "Bearer " + installed.value
              : "Basic " + Buffer.from("x-access-token:" + installed.value).toString("base64");
            const bytes = body === undefined ? undefined : Buffer.from(body, "base64");
            const response = await new Promise<{
              status: number;
              contentType: string;
              responseBody: string;
            }>((resolve, reject) => {
              const req = httpsRequest(
                target,
                {
                  method,
                  agent: false,
                  ca,
                  signal,
                  headers: {
                    authorization,
                    ...(contentType === undefined ? {} : { "content-type": contentType }),
                    ...(bytes === undefined ? {} : { "content-length": bytes.length }),
                  },
                },
                (res) => {
                  void text(res)
                    .then((responseBody) => {
                      assert.ok(res.statusCode && res.headers["content-type"]);
                      resolve({
                        status: res.statusCode,
                        contentType: res.headers["content-type"],
                        responseBody,
                      });
                    }, reject)
                    .catch(reject);
                },
              );
              req.on("error", reject);
              req.end(bytes);
            });
            return { decision, ...response };
          }
          const handle = (input: RecipientCommand) => {
            void command(input).then(
              (result) => process.send?.({ result }),
              () => process.send?.({ error: "RECIPIENT_COMMAND_FAILED" }),
            );
          };
          process.on("message", handle);
          return {
            async close() {
              process.off("message", handle);
              if (process.connected) {
                process.disconnect?.();
              }
            },
          };
        },
      },
    },
  };
}
