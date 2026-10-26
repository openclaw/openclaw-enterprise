import type { PermissionAction, ResourceKind, ResourceRef } from "@openclaw-enterprise/contracts";

// A caller's own denial with no grant to name, such as an unprovisioned identity. Clients that
// still match it exactly keep working (finding 2534).
export const GENERIC_DENIAL = "The exact platform operation was not authorized.";
// Every denial that names the caller's missing grant starts with this prefix, so clients can tell
// it from the generic text and from refusals that name another principal.
export const NAMED_DENIAL_PREFIX = "Not authorized:";

// Resource kinds in the permissions cheat sheet's words.
const KIND_LABELS: Readonly<Record<ResourceKind, string>> = Object.freeze({
  installation: "Installation",
  namespace: "Namespace",
  configuration: "Configuration",
  preset: "Preset",
  service_account: "ServiceAccount",
  secret: "Secret",
  agent: "Agent",
  agent_revision: "AgentRevision",
  credential_source: "credential source",
  sandbox_policy: "SandboxPolicy",
});

const pluralKind = (kind: string) => (kind.endsWith("y") ? `${kind.slice(0, -1)}ies` : `${kind}s`);

// A resource ID shows only in this plain shape; any other reads as "a <Kind> this request uses".
const SHOWN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const ASK = "Ask an Installation administrator to grant it.";

// A native admin request the caller may not make. The Agent comes from the host name, not from
// the caller, so the text names no Agent, and an unknown host gets it too.
export const NATIVE_ADMIN_DENIAL = `${NAMED_DENIAL_PREFIX} opening this Agent's native admin UI needs Agent administer on it. ${ASK}`;

/**
 * The text for the caller's own denial of `action` on `resource` (finding 2534). It names the
 * grant the request checked and who grants it. The disclosure rules:
 * - It names a resource ID only when `requested` accepts it: the request itself carried it, or the
 *   caller may already read it (finding 2594). It never names any other ID read from stored state,
 *   such as a Secret an Agent binds.
 * - It never names a binding, Role, Restriction or another principal, and it reads the same
 *   whether a Restriction denied the request or no grant allowed it.
 * - It depends only on the request and the checked grant, never on whether the resource exists,
 *   so an unknown ID and one the caller cannot read get the same answer.
 */
export function callerDenialMessage(
  authorization: { readonly action: PermissionAction; readonly resource: ResourceRef },
  requested: (value: string) => boolean = () => false,
): string {
  const { action, resource } = authorization;
  const kind = KIND_LABELS[resource.kind] ?? resource.kind;
  const named = (id: string | undefined) =>
    id !== undefined && SHOWN_ID.test(id) && requested(id) ? id : undefined;
  if (resource.kind === "installation") {
    return action === "administer"
      ? `${NAMED_DENIAL_PREFIX} this needs Installation administer. Ask an Installation administrator to do it for you or to grant it.`
      : `${NAMED_DENIAL_PREFIX} this needs Installation ${action}. ${ASK}`;
  }
  if (action === "create") {
    // A collection create targets its parent: the Installation for a Namespace, otherwise the
    // Namespace. No Role can hold a create permission, so no grant helps: only an Installation
    // administrator creates one, as the console's AGENT_CREATE_DENIED says (finding 2581).
    const kinds = pluralKind(kind);
    if (resource.kind === "namespace") {
      return `${NAMED_DENIAL_PREFIX} this needs Namespace create. Only an Installation administrator can create ${kinds}: ask one to create it.`;
    }
    const namespaceId = named(resource.namespaceId);
    const where = namespaceId === undefined ? " in this Namespace" : ` in Namespace ${namespaceId}`;
    return `${NAMED_DENIAL_PREFIX} this needs ${kind} create${where}. Only an Installation administrator can create ${kinds}: ask one to create it.`;
  }
  const id = named(resource.id);
  const article = /^[AEIOU]/.test(kind) ? "an" : "a";
  const target = id === undefined ? `${article} ${kind} this request uses` : `${kind} ${id}`;
  // Log text also accepts administer. The console and the CLI name the grant in the same words
  // (finding 2599); the text never tells whether a Restriction applied.
  const grant =
    action === "read_logs" ? "Agent read_logs (or Agent administer)" : `${kind} ${action}`;
  return `${NAMED_DENIAL_PREFIX} this needs ${grant} on ${target}. ${ASK}`;
}

/** What a denial's text may use from the request that was denied. */
export interface DeniedRequest {
  /** Whether the request carried a value (`requestedValues`). */
  readonly requested: (value: string) => boolean;
  /** The acting principal: a denial decided for another principal names no grant. */
  readonly actorId?: string;
}

// A body or query field that names a resource: `id`, or a name ending in `Id` (one ID) or `Ids`
// (a list). Free text, such as a search `q`, never counts as naming one (finding 2585).
const REFERENCE_FIELD = /^(?:id|.*Id|.*Ids)$/;

/**
 * The resource IDs a request named, for `callerDenialMessage`: every path parameter (and the
 * SandboxPolicy ID derived from a path Agent ID), and the values of reference fields
 * (`REFERENCE_FIELD`) at any depth of the query and body. The walk is bounded: a value past the
 * bounds is simply not named.
 */
export function requestedValues(request: {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
}): (value: string) => boolean {
  const found = new Set<string>();
  let budget = 4096;
  const reference = (value: unknown) => {
    if (typeof value === "string") {
      found.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 256)) {
        if (typeof item === "string") {
          found.add(item);
        }
      }
    }
  };
  const visit = (value: unknown, depth: number) => {
    if (budget <= 0 || depth > 24 || value === null || typeof value !== "object") {
      return;
    }
    budget -= 1;
    for (const [key, item] of Array.isArray(value)
      ? value.map((entry) => ["", entry] as const)
      : Object.entries(value)) {
      if (key !== "" && REFERENCE_FIELD.test(key)) {
        reference(item);
      }
      visit(item, depth + 1);
    }
  };
  if (request.params !== null && typeof request.params === "object") {
    for (const [key, value] of Object.entries(request.params)) {
      reference(value);
      // An Agent's SandboxPolicy ID is derived from the Agent's (`sbp_` plus its UUID), so a path
      // that carries the Agent ID carries its policy's too (finding 2594).
      if (key === "agentId" && typeof value === "string" && value.startsWith("agt_")) {
        found.add(`sbp_${value.slice(4)}`);
      }
    }
  }
  visit(request.query, 0);
  visit(request.body, 0);
  return (value) => found.has(value);
}

/**
 * The text when an Agent's own service principal, not the caller, lacks a grant that deployment
 * needs (finding 2592). The caller cannot fix it, so it asks an Installation administrator to give
 * the Agent access. The resource comes from the Agent's stored bindings: the text names it only when
 * the request carried its ID or the caller may read it, and names the Agent only when the request
 * carried its ID. It never names the principal, which the audit event records.
 */
export function agentPrincipalDenialMessage(
  denial: {
    readonly agentId?: string;
    readonly callerMayReadResource: boolean;
    readonly authorization: { readonly action: PermissionAction; readonly resource: ResourceRef };
  },
  requested: (value: string) => boolean = () => false,
): string {
  const { action, resource } = denial.authorization;
  const kind = KIND_LABELS[resource.kind] ?? resource.kind;
  const shown = (id: string | undefined, readable: boolean) =>
    id !== undefined && SHOWN_ID.test(id) && (readable || requested(id)) ? id : undefined;
  const agentId = shown(denial.agentId, false);
  const resourceId = shown(resource.id, denial.callerMayReadResource);
  const agent = agentId === undefined ? "This Agent" : `Agent ${agentId}`;
  const target =
    resourceId === undefined ? `one of its bound ${pluralKind(kind)}` : `${kind} ${resourceId}`;
  return `${agent} cannot use ${target}: the Agent itself needs ${kind} ${action} on it. Ask an Installation administrator to give the Agent access, then deploy again.`;
}
