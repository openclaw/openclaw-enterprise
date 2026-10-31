import type { DriverRegistrationRef } from "../../packages/contracts/src/index.ts";
import { openShellGitRecipientEvidence } from "../../apps/controller/src/drivers/repo/credentials/protected-repository-git-installation.ts";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { Pool } from "pg";
import { startPreparedGitHubGitOwner } from "../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import type { Clock } from "../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import {
  startGitHubFixture,
  fixtureRepository,
  fixtureRepositoryId,
  fixtureAppId,
  fixtureInstallationId,
} from "../fixtures/repository-credentials/github.mjs";

/**
 * The system clock with its wall time `behindMs` early: a worker host whose clock runs behind
 * GitHub's and PostgreSQL's. Monotonic time and timers stay the system's.
 */
export function clockBehind(behindMs: number): Clock {
  const system = createSystemClock();
  return Object.freeze({ ...system, wallNow: () => system.wallNow() - behindMs });
}

export interface SelectedRepositories {
  selectedRepositoryIds: readonly string[];
  entries: readonly { repositoryRef: string; repositoryId: string; repository: string }[];
  permissions: Readonly<Record<string, "read" | "write">>;
}

export async function standingGitOrigin(
  t: TestContext,
  namespaceId: string,
  tokenLifetimeMs = 135_000,
  beforeIssue?: () => Promise<void>,
  installationAccess = false,
  selection?: SelectedRepositories,
  draftPull = false,
) {
  const clock = createSystemClock();
  // Keep the prepared owner's real 60 s clock margin and 60 s minimum validity.
  const github: (t: TestContext, options: object) => ReturnType<typeof startGitHubFixture> =
    startGitHubFixture;
  const gh = await github(t, {
    clock,
    tokenLifetimeMs,
    beforeIssue,
    installationAccess,
    ...(draftPull && {
      additionalPermissions: [{ metadata: "read", contents: "write", pull_requests: "write" }],
    }),
    ...(selection && {
      expectedRepositoryIds: selection.selectedRepositoryIds.map(Number),
      additionalRepositories: selection.entries.slice(1),
      additionalPermissions: [selection.permissions],
    }),
  });
  const tls = gh.tls;
  const pushRef = "refs/heads/review";
  const backendId = "prepared-standing";
  const registrationName = "oce-prepared-git";
  const registry = validateGitHubRepositoryRegistry({
    version: 1,
    backendId,
    providerInstanceId: "fixture-provider",
    appId: fixtureAppId,
    githubInstallationId: fixtureInstallationId,
    maximumDurationSeconds: selection || draftPull ? 600 : 180,
    allowStandingApprovals: true,
    ...(installationAccess && {
      installationAccess: {
        repositoryRef: "team-installation",
        namespaces: [{ namespaceId, accessMode: "installation", allowStandingApproval: true }],
      },
    }),
    repositories: selection
      ? selection.entries.map((entry) => ({
          ...entry,
          namespaces: [
            { namespaceId, profiles: ["github-repository"], permissions: selection.permissions },
          ],
        }))
      : [
          {
            repositoryRef: "source",
            repository: fixtureRepository,
            repositoryId: fixtureRepositoryId,
            namespaces: [
              {
                namespaceId,
                profiles: ["git-write"],
                transport: draftPull ? "git-and-draft-pr" : "git-only",
                ...(draftPull && { pullRequestBase: "main" }),
                allowStandingApproval: true,
                pushRefAllowlist: [pushRef],
              },
            ],
          },
        ],
  });
  const directory = await temporaryDirectory(t, "standing-peer-");
  const controlSocket = join(directory, "control.sock");
  const privateKeyPath = join(directory, "app.pem");
  const custodyKeyPath = join(directory, "custody");
  await writeFile(privateKeyPath, gh.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await writeFile(custodyKeyPath, randomBytes(32), { mode: 0o600 });

  const gitOrigin: (
    t: TestContext,
    options: object,
  ) => ReturnType<typeof startGitSmartHttpFixture> = startGitSmartHttpFixture;
  const origin = await gitOrigin(t, {
    repository: fixtureRepository,
    tls,
    authorize: gh.authorize,
  });
  return {
    registry,
    backendId,
    gh,
    tls,
    origin,
    privateKeyPath,
    custodyKeyPath,
    registrationName,
    directory,
    controlSocket,
  };
}

export async function preparedStandingGitPeer(
  t: TestContext,
  pool: Pool,
  namespaceId: string,
  options: {
    beforeIssue?: () => Promise<void>;
    driver?: DriverRegistrationRef;
    installationAccess?: boolean;
    selection?: SelectedRepositories;
    draftPull?: boolean;
    /** GitHub's token lifetime, by the system clock. */
    tokenLifetimeMs?: number;
    /** Only the prepared owner's clock. GitHub, PostgreSQL and the runtime keep real time. */
    ownerClock?: Clock;
  } = {},
) {
  const {
    registry,
    backendId,
    gh,
    tls,
    origin,
    privateKeyPath,
    custodyKeyPath,
    registrationName,
    directory,
    controlSocket,
  } = await standingGitOrigin(
    t,
    namespaceId,
    options.tokenLifetimeMs,
    options.beforeIssue,
    options.installationAccess,
    options.selection,
    options.draftPull,
  );
  // Public OpenShell requires the GitHub.com authority, not an arbitrary API origin.
  // Replace only the issuer's network destination, before DNS; keep fixture TLS verification,
  // the actual issuance and retirement requests, and the production admission and scope checks.
  const issue = new URL(gh.origin);
  assert.equal(issue.hostname, "127.0.0.1");
  const request = https.request;
  const transport = t.mock.method(https, "request", (...args: Parameters<typeof https.request>) => {
    const input = args[0] as string | URL | https.RequestOptions;
    if (
      typeof input === "object" &&
      !(input instanceof URL) &&
      input.hostname === "api.github.com"
    ) {
      return request({ ...input, hostname: issue.hostname, port: issue.port }, args[1] as never);
    }
    const host =
      input instanceof URL
        ? input.hostname
        : typeof input === "string"
          ? new URL(input).hostname
          : input.hostname;
    assert.equal(host, "127.0.0.1", "the controlled peer cannot contact a live provider");
    return request(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    transport.mock.restore();
    syncBuiltinESMExports();
  });
  const prepared = await startPreparedGitHubGitOwner(
    {
      registry,
      pool,
      driverId: backendId,
      implementation: "github",
      backendId,
      privateKeyPath,
      custodyKeyPath,
      ca: tls.ca,
      startWorker: false,
      ...(options.driver && {
        protectedGitDriver: options.driver,
        protectedGitEvidence: openShellGitRecipientEvidence,
      }),
    },
    options.ownerClock,
  );
  // The directory is private to this case. No receipt service, broker, session bearer, or
  // prepared-use socket exists before, during, or after either Git transfer.
  const noBroker = async () => {
    for (const name of ["control.sock", "receipt.sock", "prepared-git-use.sock"]) {
      await assert.rejects(access(join(directory, name)), { code: "ENOENT" });
    }
    assert.equal(
      (
        await pool.query(
          `SELECT count(*) n FROM occ.repository_broker_receipts b
         JOIN occ.repository_session_attempts s USING (admission_id)
         WHERE s.namespace_id=$1`,
          [namespaceId],
        )
      ).rows[0].n,
      "0",
    );
  };
  await noBroker();
  t.after(() => prepared.close());
  let oid = await origin.ref("main");
  const base = "/" + fixtureRepository + ".git/";
  const packet = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
  const body = () => Buffer.from(packet("want " + oid + "\n") + "0000" + packet("done\n"));
  // The controlled sender below owns both the decision and the single send opportunity. No
  // redirect, ambient credential, GitHub connection, replay, or alternate object source.
  const send = (value: string | undefined, upload: boolean) =>
    new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
      const path = base + (upload ? "git-upload-pack" : "info/refs?service=git-upload-pack");
      const url = new URL(path, origin.origin);
      assert.equal(url.hostname, "127.0.0.1");
      const auth = value
        ? { authorization: "Basic " + Buffer.from("x-access-token:" + value).toString("base64") }
        : {};
      const headers = {
        ...auth,
        ...(upload && {
          "content-type": "application/x-git-upload-pack-request",
          "content-length": body().length,
        }),
      };
      const req = request(
        url,
        { method: upload ? "POST" : "GET", headers, ca: tls.ca, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res
            .on("data", (data) => chunks.push(data))
            .on("error", reject)
            .on("end", () => resolve({ status: res.statusCode!, bytes: Buffer.concat(chunks) }));
        },
      ).on("error", reject);
      req.end(upload ? body() : undefined);
    });
  const input = (bindingId: string, sandboxId: string, upload: boolean, workspace: string) => ({
    phase: 1,
    middleware_name: registrationName,
    context: { request_id: randomUUID(), sandbox_id: sandboxId, workspace },
    config: { fields: { binding_id: { stringValue: bindingId } } },
    target: {
      scheme: "https",
      host: "github.com",
      port: 443,
      method: upload ? "POST" : "GET",
      path: base + (upload ? "git-upload-pack" : "info/refs"),
      ...(upload ? {} : { query: "service=git-upload-pack" }),
    },
    ...(upload && {
      body: body(),
      headers: [{ name: "content-type", value: "application/x-git-upload-pack-request" }],
    }),
  });
  return {
    registry,
    prepared,
    origin,
    originCalls: () => origin.traffic().requests,
    installationTransport: {
      httpsRequest: request,
      apiOrigin: gh.origin,
      tls,
      authorize: gh.authorize,
    },

    gh,
    controlSocket,
    oid,
    noBroker,
    nextObject: async () => (oid = await origin.addCommit()),
    send,
    async exchange(
      evaluate: () => Promise<{ decision: number; reason_code?: string }>,
      value: string,
      upload: boolean,
    ) {
      const decision = await evaluate();
      return decision.decision === 1 ? send(value, upload) : decision;
    },
    input,
    registrationName,
    backendId,
  };
}
