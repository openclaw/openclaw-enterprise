import { createPostgresPool } from "@openclaw-enterprise/occ";
import { isIP } from "node:net";
import { loadPreparedGitIssuerSelection } from "./issuer-selection.ts";
import { closed, nonempty, object } from "../installation-fields.ts";
import { loadPublicCa } from "./public-ca.ts";
import { startPreparedGitHubGitOwner } from "../../backends/repository-credentials/prepared-git-owner.ts";
import {
  preparedGitTlsIdentity,
  serveRemotePreparedGit,
} from "../../backends/repository-credentials/remote-prepared-git.ts";
import { preparedGitFilePath } from "../../backends/repository-credentials/remote-prepared-git-config.ts";
import { readProtectedFile } from "./protected-file.ts";

const label = "preparedGitIssuer";
const unavailable = () => new Error("PREPARED_GIT_ISSUER_CONFIGURATION_INVALID");

function listenAddress(host: string): string {
  switch (isIP(host)) {
    case 4:
      if (host !== "0.0.0.0") {
        return host;
      }
      break;
    case 6:
      // URL canonicalization collapses zero blocks and dotted IPv4 suffixes.
      // Reject zone identifiers before parsing to avoid scoped wildcard binds.
      if (!host.includes("%")) {
        const canonical = new URL(`https://[${host}]`).hostname.slice(1, -1);
        if (canonical !== "::" && canonical !== "::ffff:0:0") {
          return canonical;
        }
      }
      break;
  }
  throw unavailable();
}

async function configuration(path: string) {
  const file = await readProtectedFile(preparedGitFilePath(path, "issuer configuration"), 32768);
  if (!file.ok) {
    throw unavailable();
  }
  try {
    const input = object(JSON.parse(file.bytes.toString("utf8")), label);
    closed(
      input,
      [
        "listenHost",
        "listenPort",
        "serverCertificatePath",
        "serverPrivateKeyPath",
        "workerCaPath",
        "workerFingerprintSha256",
        "workerInstanceId",
        "installationId",
        "namespaceId",
        "agentId",
        "servicePrincipalId",
        "privateKeyPath",
        "custodyKeyPath",
        "apiOrigin",
        "issuerCaPath",
      ],
      label,
    );
    const string = (field: string) => nonempty(input[field], label + "." + field);
    const filePath = (field: string) => preparedGitFilePath(input[field], label + "." + field);
    const host = listenAddress(string("listenHost"));
    const port = input.listenPort;
    const instanceId = string("workerInstanceId");
    const workerFingerprintSha256 = string("workerFingerprintSha256");
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^[0-9a-f]{64}$/.test(workerFingerprintSha256) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(instanceId)
    ) {
      throw unavailable();
    }
    return {
      endpoint: { host, port, workerFingerprintSha256 },
      serverCertificatePath: filePath("serverCertificatePath"),
      serverPrivateKeyPath: filePath("serverPrivateKeyPath"),
      workerCaPath: filePath("workerCaPath"),
      enrolledWorker: {
        instanceId,
        installationId: string("installationId"),
        namespaceId: string("namespaceId"),
        agentId: string("agentId"),
        servicePrincipalId: string("servicePrincipalId"),
      },
      privateKeyPath: filePath("privateKeyPath"),
      custodyKeyPath: filePath("custodyKeyPath"),
      ...(input.apiOrigin === undefined ? {} : { apiOrigin: string("apiOrigin") }),
      ...(input.issuerCaPath === undefined ? {} : { issuerCaPath: filePath("issuerCaPath") }),
    };
  } finally {
    file.bytes.fill(0);
  }
}

export async function startPreparedGitIssuer(
  path: string,
  databaseUrl: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  packageRoot?: string,
) {
  if (!["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)) {
    throw unavailable();
  }
  const settings = await configuration(path);
  const { repositoryOwner, registry, repositoryGitCustody, enrollment } =
    await loadPreparedGitIssuerSelection(environment, packageRoot);
  if (
    settings.enrolledWorker.namespaceId !== enrollment.namespaceId ||
    settings.enrolledWorker.agentId !== enrollment.agentId ||
    settings.enrolledWorker.servicePrincipalId !== enrollment.servicePrincipalId
  ) {
    throw unavailable();
  }
  const {
    serverCertificatePath,
    serverPrivateKeyPath,
    workerCaPath,
    issuerCaPath,
    endpoint,
    ...options
  } = settings;
  const ca = issuerCaPath === undefined ? undefined : await loadPublicCa(issuerCaPath);
  const tls = await preparedGitTlsIdentity(
    serverCertificatePath,
    serverPrivateKeyPath,
    workerCaPath,
  );
  let pool: Awaited<ReturnType<typeof createPostgresPool>> | undefined;
  let owner: Awaited<ReturnType<typeof startPreparedGitHubGitOwner>> | undefined;
  try {
    const database = await createPostgresPool(databaseUrl, {
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 4000,
      query_timeout: 5000,
    });
    pool = database;
    // Check effective grants for issuance, retirement and recipient custody on the actual
    // application connection. Table grants and column grants both satisfy a column check.
    const ready = await database.query(
      `SELECT FROM occ.installation i
       JOIN occ.agents a ON (a.namespace_id,a.id,a.service_principal_id)=($2,$3,$4)
       WHERE i.id=$1
         AND current_setting('transaction_read_only') = 'off'
         AND NOT EXISTS (
           SELECT FROM (VALUES
             ('installation', 'SELECT', 'id'),
             ('agents', 'SELECT', 'namespace_id,id,service_principal_id,active_revision_id,status,desired_runtime_state,execution_mode,repository_bindings'),
             ('namespaces', 'SELECT', 'id,status,deleted_at'),
             ('agent_revisions', 'SELECT', 'namespace_id,agent_id,id,admitted_spec'),
             ('repository_session_attempts', 'SELECT', 'namespace_id,agent_id,revision_id,live_revision_id,admission_id,session_id,repository_ref,cleanup_context,deadline_wall_ms,broker_protocol,phase,predecessor_admission_id'),
             ('egress_installations', 'SELECT', 'namespace_id,agent_id,revision_id,installation,sandbox_id'),
             ('repository_standing_approvals', 'SELECT', 'id,namespace_id,agent_id,revoked_at,generation,scope_fingerprint,binding'),
             ('repository_standing_executions', 'SELECT', 'namespace_id,agent_id,revision_id,closed,approval_id,approval_generation'),
             ('egress_rejected_material', 'SELECT', 'namespace_id,secret_driver_id,material_id,material_version'),
             ('credential_deliveries', 'SELECT', 'revision_id,live_revision_id,binding_id,namespace_id,agent_id,target,fence,worker_instance,settlement,write_pending,blocked,operation_fence,target_preparation_attempt_id,target_material_version,preparation_attempt_id,material_version'),
             ('credential_deliveries', 'INSERT', 'revision_id,live_revision_id,binding_id,namespace_id,agent_id,target,worker_instance,settlement'),
             ('credential_deliveries', 'UPDATE', 'write_pending,fence,operation_fence,target_preparation_attempt_id,target_material_version,updated_at,preparation_attempt_id,material_version'),
             ('prepared_github_families', 'SELECT', 'source_id,source,admission,enabled,next_check_at'),
             ('prepared_github_families', 'INSERT', 'source_id,source,issuer,admission'),
             ('prepared_github_families', 'UPDATE', 'enabled,admission,next_check_at'),
             ('prepared_github_attempts', 'SELECT', 'source_id,id,admission,state,custody,material_version,provider_expires_at,usable_until,started_at,sealed'),
             ('prepared_github_attempts', 'INSERT', 'id,source_id,admission,state'),
             ('prepared_github_attempts', 'UPDATE', 'state,custody,sealed,material_version,provider_expires_at,usable_until'),
             ('prepared_repository_git_uses', 'INSERT', 'exchange_id,admission_id,attempt_id,material_version,operation,request_digest_sha256,authorization_reply_by,recipient_fence')
           ) AS required(relation, privilege, columns)
           CROSS JOIN LATERAL unnest(string_to_array(required.columns, ',')) AS col(name)
           WHERE has_column_privilege('occ.' || required.relation, col.name, required.privilege) IS NOT TRUE
         )
         -- PostgreSQL also requires UPDATE on at least one column for a row lock.
         AND NOT EXISTS (
           SELECT FROM unnest(ARRAY['agents', 'namespaces', 'repository_session_attempts',
                                    'egress_installations', 'repository_standing_approvals']) AS locked(relation)
           WHERE has_any_column_privilege('occ.' || locked.relation, 'UPDATE') IS NOT TRUE
         )
         AND has_function_privilege('occ.repository_standing_approval_is_current(jsonb,text,text)', 'EXECUTE')
         AND has_function_privilege('occ.repository_standing_execution_is_current(jsonb,text,text,text)', 'EXECUTE')
         -- Earlier versions of the same family table cannot store selected repository material.
         AND EXISTS (
           SELECT FROM pg_catalog.pg_constraint
           WHERE conrelid = 'occ.prepared_github_families'::regclass
             AND conname = 'prepared_github_families_check' AND contype = 'c' AND convalidated
             AND strpos(pg_get_constraintdef(oid), 'credential_proxy_github_repository') > 0
         )`,
      [
        settings.enrolledWorker.installationId,
        enrollment.namespaceId,
        enrollment.agentId,
        enrollment.servicePrincipalId,
      ],
    );
    if (ready.rowCount !== 1) {
      throw unavailable();
    }
    owner = await startPreparedGitHubGitOwner({
      ...repositoryOwner,
      repositoryGitCustody,
      ...options,
      ...(ca === undefined ? {} : { ca }),
      registry,
      pool: database,
      report: (code, context) => process.stderr.write(JSON.stringify({ code, ...context }) + "\n"),
    });
    if (!owner.protectedGit) {
      throw unavailable();
    }
    const listener = await serveRemotePreparedGit(owner.protectedGit, tls, endpoint);
    return {
      async close() {
        try {
          await listener.close();
        } finally {
          try {
            await owner?.close();
          } finally {
            await database.end();
          }
        }
      },
    };
  } catch (error) {
    const failures: unknown[] = [];
    try {
      await owner?.close();
    } catch (failure) {
      failures.push(failure);
    }
    try {
      await pool?.end();
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        "Prepared Git issuer startup and cleanup failed.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    tls.key.fill(0);
  }
}
