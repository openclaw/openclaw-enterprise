import { NativeIAMDriver } from "@openclaw-enterprise/iam";
import type {
  AgentAuditState,
  PlatformUnitOfWork,
  PostgresPlatformState,
} from "@openclaw-enterprise/occ";

interface ChartRuntimeAudit {
  readonly namespace: string;
  readonly release: string;
  readonly port: number;
}

export const CHART_RUNTIME_AUDIT_CA_PATH = "/etc/openclaw/runtime-audit-ca/ca.crt";
export const CHART_RUNTIME_AUDIT_TLS_DIRECTORY = "/etc/openclaw/runtime-audit-tls";

/** The Helm chart supplies the listener and its exact Kubernetes peer. */
export function chartRuntimeAudit(value: string | undefined): ChartRuntimeAudit | undefined {
  if (value === undefined) {
    return undefined;
  }
  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Object.keys(parsed).length === 3 &&
      "namespace" in parsed &&
      typeof parsed.namespace === "string" &&
      dnsLabel.test(parsed.namespace) &&
      "release" in parsed &&
      typeof parsed.release === "string" &&
      dnsLabel.test(parsed.release) &&
      "port" in parsed &&
      typeof parsed.port === "number" &&
      Number.isInteger(parsed.port) &&
      parsed.port >= 1024 &&
      parsed.port <= 65535
    ) {
      return { namespace: parsed.namespace, release: parsed.release, port: parsed.port };
    }
  } catch {
    // Report neither parser details nor the chart's environment value.
  }
  throw new Error("OCC_CHART_RUNTIME_AUDIT must identify the chart's private audit endpoint.");
}

export function postgresAgentAuditState(
  state: PostgresPlatformState,
): AgentAuditState<PlatformUnitOfWork> {
  return {
    supportsAuthorization: (current, driver, authorize) =>
      current === state && NativeIAMDriver.usesStateForAuthorization(driver, authorize, state),
    transact: (installationId, work) =>
      state.transactWithNativeIAMAuthority(installationId, "read", async (unit) => {
        await state.boundAgentAuditTransaction(unit);
        return work(unit);
      }),
    holdResource: (unit, installationId, namespaceId, agentId) =>
      state.holdAgentAuditResource(unit, installationId, namespaceId, agentId),
    list: (unit, namespaceId, agentId, selection) =>
      state.listAgentAuditInTransaction(unit, namespaceId, agentId, selection),
    findLinkedTurn: (unit, namespaceId, agentId, auditEventId) =>
      state.findAgentAuditLinkedTurn(unit, namespaceId, agentId, auditEventId),
  };
}

export function controlPlaneAuditEnabled(
  mode: "development" | "production",
  value: string | undefined,
): boolean {
  if (value === undefined) {
    return mode === "development";
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  throw new Error("OCC_CONTROL_PLANE_AUDIT_ENABLED must be true or false.");
}

// A client deadline also covers a connection that stops responding.
export const controlPlaneAuditDatabaseOptions = {
  connectionTimeoutMillis: 15_000,
  query_timeout: 15_000,
} as const;

export const CONTROL_PLANE_AUDIT_WRITE_TIMEOUT_MS = 2_000;
