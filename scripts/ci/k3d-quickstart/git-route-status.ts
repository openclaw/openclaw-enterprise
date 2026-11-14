// The runner streams this command to the worker over stdin during Git recovery and diagnostics.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { PoolClient } from "pg";
import type { OpenShellBackendConfiguration } from "@openclaw-enterprise/contracts";

import { createPostgresPool } from "/app/packages/occ/src/index.ts";
import { asRecord } from "/app/packages/utils/src/index.ts";

interface RouteRow {
  readonly blocked: string | null;
  readonly write_pending: "bootstrap" | "rotate" | null;
  readonly workspace: string | null;
  readonly sandbox: string | null;
}

interface FamilyRow {
  readonly read_only: boolean | null;
  readonly retired: boolean;
}

type RevisionIdentity = [
  namespace: string | undefined,
  agent: string | undefined,
  revision: string | undefined,
];

const diagnosticReasons = new Set([
  "bootstrap_failed",
  "execution_replaced",
  "gateway_unauthorized",
  "grant_changed",
  "material_mismatch",
  "preview_install_unverified",
  "preview_release_unconfirmed",
  "provider_missing",
  "provider_overlap",
  "repository_expired",
  "sandbox_mismatch",
  "supervisor_replaced",
  "withdrawn",
  "worker_replaced",
  "write_refused",
  "write_unknown",
]);

const [namespace, agent, revision, mode, originalReason, tenant, sandbox] = process.argv.slice(2);
const identity: RevisionIdentity = [namespace, agent, revision];
// Without a connection string, pg uses its environment defaults.
const pool = await createPostgresPool(process.env.OCC_DATABASE_URL ?? "", { max: 1 });
const client = await pool.connect();
try {
  const { rows } = await client.query<RouteRow, RevisionIdentity>(
    `SELECT blocked, write_pending, target->>'workspace' AS workspace, target->>'sandbox' AS sandbox
     FROM occ.credential_deliveries
     WHERE namespace_id=$1 AND agent_id=$2 AND revision_id=$3
       AND settlement='snapshot' AND target->>'transport'='openshell-repository-git/v1'`,
    identity,
  );
  if (mode === "recovery-target") {
    if (!printRecoveryTarget(rows)) {
      process.exitCode = 1;
    }
  } else if (mode === "retired") {
    if (!(await retirementComplete(client, identity, rows, originalReason))) {
      process.exitCode = 1;
    }
  } else if (mode === "sandbox-deleted") {
    assert.equal(originalReason, "supervisor_replaced");
    assert.ok(tenant && sandbox);
    assert.ok(rows.every((route) => route.workspace === tenant && route.sandbox === sandbox));
    await verifySandboxDeleted(tenant, sandbox);
  } else {
    for (const { blocked } of rows) {
      if (blocked !== null && diagnosticReasons.has(blocked)) {
        console.log("Git route:", blocked);
      }
    }
  }
} finally {
  client.release();
  await pool.end();
}

function printRecoveryTarget(rows: readonly RouteRow[]): boolean {
  // A pending provider write needs independent investigation, even on a closed route.
  const [route] = rows;
  if (rows.length !== 1 || route === undefined || route.write_pending !== null) {
    return false;
  }
  const { blocked: reason, workspace, sandbox } = route;
  if (
    reason !== "bootstrap_failed" &&
    reason !== "worker_replaced" &&
    reason !== "supervisor_replaced"
  ) {
    return false;
  }
  // Store the target on the private runner before retirement can delete its row.
  assert.ok(workspace && sandbox);
  console.log(JSON.stringify({ reason, workspace, sandbox }));
  return true;
}

async function retirementComplete(
  client: PoolClient,
  identity: RevisionIdentity,
  routes: readonly RouteRow[],
  originalReason: string | undefined,
): Promise<boolean> {
  // Check the immutable admitted grant and every attempt. A quarantined
  // attempt is disqualifying even if custody now reads not_issued.
  const { rows: families } = await client.query<FamilyRow, RevisionIdentity>(
    `SELECT
      f.source #> '{grant,permissions}' = '{"metadata":"read","contents":"read"}'::jsonb
      AND f.source #> '{grant,repositories}' = '[{"repositoryId":"1412618387","repository":"oce-test/oce-app-test"}]'::jsonb AS read_only,
      NOT EXISTS (SELECT 1 FROM occ.prepared_github_attempts a WHERE a.source_id=f.source_id
        AND (a.state<>'committed' OR a.custody NOT IN ('revoked','expired') OR a.sealed IS NOT NULL)) AS retired
     FROM occ.prepared_github_families f WHERE f.source #>> '{session,namespaceId}'=$1
     AND f.source #>> '{session,agentId}'=$2 AND f.source #>> '{session,revisionId}'=$3`,
    identity,
  );
  return (
    routes.every(
      ({ write_pending, blocked }) =>
        write_pending === null && (blocked === "withdrawn" || blocked === originalReason),
    ) && families.every((family) => family.read_only === true && family.retired === true)
  );
}

function hasYamlLoader(value: unknown): value is { loadYaml(text: string): unknown } {
  return typeof asRecord(value)?.loadYaml === "function";
}

function gatewayConfiguration(): OpenShellBackendConfiguration {
  const requireController: (id: string) => unknown = createRequire(
    "/app/apps/controller/package.json",
  );
  const yaml = requireController("@kubernetes/client-node");
  assert.ok(hasYamlLoader(yaml));
  const configPath = process.env.OCC_CONFIG_PATH;
  assert.ok(configPath !== undefined, "OCC_CONFIG_PATH is required");
  const installation = asRecord(yaml.loadYaml(readFileSync(configPath, "utf8")));
  const sandboxDriver = asRecord(asRecord(installation?.drivers)?.sandbox)?.id;
  const backends = installation?.backend;
  assert.ok(typeof sandboxDriver === "string" && Array.isArray(backends));
  const candidates: readonly unknown[] = backends;
  const owners = candidates.flatMap((candidate) => {
    assert.ok(candidate != null);
    const backend = asRecord(candidate);
    return backend?.type === "openshell" && asRecord(backend.drivers)?.sandbox === sandboxDriver
      ? [backend]
      : [];
  });
  assert.equal(owners.length, 1);
  const config = asRecord(owners[0]?.configuration);
  const auth = asRecord(config?.auth);
  assert.ok(config && auth && (auth.mode === "mtls" || auth.mode === "mutualTls"));
  const { certificatePath, privateKeyPath } = auth;
  const { endpoint, requestTimeoutMs, rootCertificatePath } = config;
  assert.ok(typeof certificatePath === "string" && typeof privateKeyPath === "string");
  assert.ok(typeof rootCertificatePath === "string" && rootCertificatePath.length > 0);
  assert.ok(requestTimeoutMs == null || typeof requestTimeoutMs === "number");
  const tls = {
    auth: { mode: "mtls" as const, certificatePath, privateKeyPath },
    rootCertificatePath,
    ...(requestTimeoutMs == null ? {} : { requestTimeoutMs }),
  };
  if (endpoint != null) {
    assert.ok(typeof endpoint === "string");
    return { ...tls, endpoint };
  }

  const { serviceName, scheme, port } = config;
  assert.ok(typeof serviceName === "string");
  assert.ok(scheme == null || typeof scheme === "string");
  const serviceScheme = scheme?.toLowerCase();
  assert.ok(serviceScheme === undefined || serviceScheme === "http" || serviceScheme === "https");
  assert.ok(
    port == null || typeof port === "number" || (typeof port === "string" && /^[0-9]*$/.test(port)),
  );
  // A quoted port was previously interpolated by the gateway into its service URL.
  const servicePort = port === "" ? 443 : port == null ? undefined : Number(port);
  return {
    ...tls,
    serviceName,
    ...(serviceScheme === undefined ? {} : { scheme: serviceScheme }),
    ...(servicePort === undefined ? {} : { port: servicePort }),
  };
}

// OpenShell can hide an existing Sandbox with NOT_FOUND. Prove Workspace membership
// and repeat the authenticated read before confirming that the Sandbox is gone.
async function verifySandboxDeleted(tenant: string, sandbox: string): Promise<void> {
  const { OpenShellGateway } = await import("/app/apps/controller/src/backends/openshell.ts");
  const gateway = new OpenShellGateway(gatewayConfiguration());
  try {
    const client = gateway.clientForNamespace(tenant);
    const signal = AbortSignal.timeout(15_000);
    const read = () => client.getSandbox({ workspace: tenant, name: sandbox }, signal);
    const { confirmSandboxAbsent } =
      await import("/app/apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts");
    const old =
      (await read()) ??
      (await confirmSandboxAbsent(
        client,
        tenant,
        signal,
        (call) => call(),
        () => new Error("Previous Workspace cannot be verified"),
        read,
      ));
    // Do not include a returned Sandbox object in an assertion failure.
    assert.ok(old === undefined, "Previous Sandbox still present");
  } finally {
    gateway.close();
  }
}
