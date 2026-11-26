import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { ChatGPTBackendDefinition } from "../../packages/contracts/src/index.ts";
import { createAuthPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  PostgresPlatformState,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryClient,
} from "../../packages/occ/src/index.ts";
import { createDevelopmentIAMState } from "./development-iam-state.ts";
import { stopProcess } from "./stop-process.mjs";
import { waitFor } from "./wait-for.ts";
import { ensureDevelopmentBootstrap } from "./bootstrap-installation.mjs";
import { reservedPortArgs, type reservePort } from "./available-port.ts";
import { databaseUrl } from "./postgres-database.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const controllerEntrypoint = fileURLToPath(
  new URL("../../apps/controller/src/server.mjs", import.meta.url),
);
export const backendId = "openai";
export const serviceAccountDriverId = "chatgpt-service-accounts";
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const alternateWorkspaceId = "22222222-2222-4222-8222-222222222222";
export const apiKeyPath = "/etc/openclaw/chatgpt/admin-key";
export function backendDefinition(
  options: {
    workspaceId?: string;
    apiKeyPath?: string;
    credentialTtlSeconds?: number;
    serviceAccountDriverId?: string;
  } = {},
): ChatGPTBackendDefinition {
  return {
    id: backendId,
    type: "chatgpt",
    configuration: {
      workspaceId: options.workspaceId ?? workspaceId,
      apiKeyPath: options.apiKeyPath ?? apiKeyPath,
      ...(options.credentialTtlSeconds === undefined
        ? {}
        : { credentialTtlSeconds: options.credentialTtlSeconds }),
    },
    drivers: { service_account: options.serviceAccountDriverId ?? serviceAccountDriverId },
  };
}

export async function ensureInstallation(state: PostgresPlatformState, label: string) {
  const existing = await state.loadInstallation();
  if (existing !== undefined) {
    return existing;
  }

  const installation = {
    id: `ins_${randomUUID()}`,
    name: `${label} PostgreSQL integration`,
    createdAt: new Date().toISOString(),
  };
  state.setBootstrapNativeIAM(
    createDevelopmentIAMState(
      createAuthPrincipalSeed(
        installation.id,
        label,
        {
          id: `account-${label}-${randomUUID()}`,
        },
        { grant: "administrator" },
      ),
    ),
  );
  await state.transact((unit) => unit.installations.createInstallation(installation));
  return installation;
}
async function inTransaction(
  pool: Pick<PostgresPool, "connect">,
  operation: (client: PostgresClient) => Promise<void>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupNamespaces(
  pool: Pick<PostgresPool, "connect">,
  namespaceIds: readonly string[],
) {
  if (namespaceIds.length === 0) {
    return;
  }
  await inTransaction(pool, async (client) => {
    await client.query(
      `UPDATE occ.controller_work
       SET state = 'failed_permanent',
           completed_at = clock_timestamp(),
           reason_code = 'TEST_FIXTURE_CLEANUP',
           claim_token = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
       WHERE namespace_id = ANY($1::text[]) AND state IN ('queued', 'claimed')`,
      [namespaceIds],
    );
    await client.query(
      `UPDATE occ.agents
       SET backend_id = NULL,
           harness_auth = NULL,
           active_revision_id = NULL
       WHERE namespace_id = ANY($1::text[])`,
      [namespaceIds],
    );
    await client.query("DELETE FROM occ.service_accounts WHERE namespace_id = ANY($1::text[])", [
      namespaceIds,
    ]);
  });
}

export function trackNamespaces(
  context: Pick<TestContext, "after">,
  pool: PostgresPool,
  close?: () => Promise<void>,
) {
  const namespaceIds = new Set<string>();
  context.after(async () => {
    if (close !== undefined) {
      await close();
    }
    await cleanupNamespaces(pool, [...namespaceIds]);
    await pool.end();
  });
  return {
    track<T extends { id: string }>(namespace: T): T {
      namespaceIds.add(namespace.id);
      return namespace;
    },
    async cleanup(...namespaces: ({ id: string } | null | undefined)[]) {
      const ids = namespaces
        .filter((namespace): namespace is { id: string } => Boolean(namespace))
        .map(({ id }) => id);
      await cleanupNamespaces(pool, ids);
      for (const id of ids) {
        namespaceIds.delete(id);
      }
    },
  };
}

export async function seedBackendBinding(
  pool: PostgresQueryClient,
  account: { id: string; namespaceId: string },
  options: {
    backendId?: string;
    driverId?: string;
    credentialIssued?: boolean;
    workspaceId?: string;
  } = {},
) {
  await pool.query(
    `INSERT INTO occ.service_account_driver_bindings
       (service_account_id, namespace_id, backend_id, driver_id, external_account_id,
        external_credential_id, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      account.id,
      account.namespaceId,
      options.backendId ?? backendId,
      options.driverId ?? serviceAccountDriverId,
      `external-account-${randomUUID()}`,
      options.credentialIssued === false ? null : `external-credential-${randomUUID()}`,
      options.workspaceId ?? workspaceId,
    ],
  );
}

export async function createBootstrappedBackendState(
  context: TestContext,
  options: {
    email: string;
    password: string;
    authSecret: string;
    authBaseURL: string;
    installationName: string;
  },
) {
  await ensureDevelopmentBootstrap(context, {
    databaseUrl,
    email: options.email,
    password: options.password,
    authSecret: options.authSecret,
    authBaseURL: options.authBaseURL,
    agentDomain: "agents.oce.localhost",
    installationName: options.installationName,
    environment: { PATH: process.env.PATH },
  });

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const state = new PostgresPlatformState(pool);
  const namespaces = trackNamespaces(context, pool);
  const configurationRoot = await temporaryDirectory(context, "openclaw-backend-repair-config-");
  return { pool, state, configurationRoot, ...namespaces };
}

type QueryPool = PostgresPool & PostgresQueryClient;

export function poolWithOneBackendBindingReadFault(pool: QueryPool): QueryPool {
  let remainingFailures = 1;
  const shouldFault = (text: string) =>
    remainingFailures > 0 &&
    typeof text === "string" &&
    text.includes("FROM occ.service_account_driver_bindings AS b") &&
    text.includes("WHERE b.namespace_id = $1 AND b.service_account_id = $2");
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          if (shouldFault(text)) {
            remainingFailures -= 1;
            throw new Error("simulated transient Backend binding metadata read failure");
          }
          return client.query(text, values);
        },
        release: () => client.release(),
      };
    },
    query: (text, values) => pool.query(text, values),
    end: () => pool.end(),
  };
}

export async function startBackendlessDevelopmentServer(
  context: TestContext,
  options: {
    configurationRoot?: string;
    reservation: Awaited<ReturnType<typeof reservePort>>;
    authBaseURL: string;
    authSecret: string;
  },
) {
  const configurationRoot =
    options.configurationRoot ?? (await mkdtemp(join(tmpdir(), "openclaw-backend-repair-config-")));
  if (options.configurationRoot === undefined) {
    context.after(() => rm(configurationRoot, { recursive: true, force: true }));
  }

  // `options.reservation` (from reservePort) holds the API port. This releases it once the
  // child logs that it is listening; if the child never does, the caller's after-hook must.
  const child = spawn(
    process.execPath,
    [...reservedPortArgs(options.reservation), controllerEntrypoint],
    {
      cwd: repository,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "development",
        OCC_HOST: "127.0.0.1",
        OCC_PORT: String(options.reservation.port),
        OCC_DATABASE_URL: databaseUrl,
        OCC_AUTH_BASE_URL: options.authBaseURL,
        OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.localhost",
        OCC_AUTH_SECRET: options.authSecret,
        OCC_DEVELOPMENT_CONFIGURATION_ROOT: configurationRoot,
        OCC_DOCKER_RUNTIME_IMAGE: "openclaw-enterprise-runtime:not-used-by-backend-repair",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  context.after(() => stopProcess(child));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));

  await waitFor(
    "backendless development API to start despite stale Backend references",
    async () => {
      assert.equal(child.exitCode, null, `The OCC subprocess exited early:\n${output}`);
      return /"event"\s*:\s*"listening"/.test(output) || undefined;
    },
    15_000,
  );
  await options.reservation.release();
  return { child };
}
