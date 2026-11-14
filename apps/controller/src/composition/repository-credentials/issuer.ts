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
  const { repositoryOwner, registry, repositoryGitCustody } = await loadPreparedGitIssuerSelection(
    environment,
    packageRoot,
  );
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
  const pool = await createPostgresPool(databaseUrl, {
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  let owner: Awaited<ReturnType<typeof startPreparedGitHubGitOwner>> | undefined;
  try {
    owner = await startPreparedGitHubGitOwner({
      ...repositoryOwner,
      repositoryGitCustody,
      ...options,
      ...(ca === undefined ? {} : { ca }),
      registry,
      pool,
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
            await pool.end();
          }
        }
      },
    };
  } catch (error) {
    try {
      await owner?.close();
    } finally {
      await pool.end();
    }
    throw error;
  } finally {
    tls.key.fill(0);
  }
}
