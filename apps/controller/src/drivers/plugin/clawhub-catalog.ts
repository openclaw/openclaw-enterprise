import type { PluginCatalogEntry, PluginCatalogPage } from "@openclaw-enterprise/contracts";
import { PluginDiscoveryError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { readCatalogResponse } from "./catalog-response.ts";

const CATALOG_URL = "https://clawhub.ai/api/v1/";
const PAGE_SIZE = 20;
const NOT_ADMITTED =
  "This ClawHub plugin is not admitted for installation by this OCE Plugin Driver. Browse its published details on ClawHub.";

function invalid(): never {
  throw new PluginDiscoveryError("invalid_response");
}

function record(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? invalid();
}

function text(value: unknown, max = 8192): string {
  return isNonEmptyString(value) && value.length <= max ? value : invalid();
}

function array(value: unknown, max: number): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : invalid();
}

async function request(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const deadline = AbortSignal.timeout(15_000);
  try {
    // This public catalog must never receive an inference credential or local CLI authentication.
    return await readCatalogResponse(
      await fetch(`${CATALOG_URL}${path}`, {
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      }),
    );
  } catch (error) {
    throw error instanceof PluginDiscoveryError ? error : new PluginDiscoveryError("unavailable");
  }
}

function catalogEntry(value: unknown): PluginCatalogEntry {
  const pkg = record(value);
  if (pkg.family !== "code-plugin" && pkg.family !== "bundle-plugin") {
    invalid();
  }
  const name = text(pkg.name, 256);
  const scopedName = /^@([^/]+)\/([^/]+)$/.exec(name);
  const publisher =
    scopedName?.[1] ??
    (isNonEmptyString(pkg.ownerHandle) ? text(pkg.ownerHandle, 256).replace(/^@+/, "") : undefined);
  const slug = scopedName?.[2] ?? name;
  return {
    // Registry identities identify browse results only; they are never runtime selection IDs.
    id: `clawhub:${name}`,
    remoteId: name,
    name: text(pkg.displayName, 512),
    ...(isNonEmptyString(pkg.summary) ? { description: text(pkg.summary) } : {}),
    metadata: {
      ...(pkg.latestVersion == null ? {} : { version: text(pkg.latestVersion, 256) }),
      ...(isNonEmptyString(pkg.ownerHandle) ? { publisher: text(pkg.ownerHandle, 256) } : {}),
      url: publisher
        ? `https://clawhub.ai/${encodeURIComponent(publisher)}/plugins/${encodeURIComponent(slug)}`
        : `https://clawhub.ai/plugins/${encodeURIComponent(name)}`,
    },
    available: false,
    unavailableReason: NOT_ADMITTED,
    tools: null,
  };
}

export async function discoverClawHubPlugins(
  input: { readonly cursor?: string; readonly query?: string },
  signal?: AbortSignal,
): Promise<PluginCatalogPage> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (input.query !== undefined) {
    params.set("q", input.query);
    const response = await request(`plugins/search?${params}`, signal);
    return {
      plugins: array(response.results, PAGE_SIZE).map((entry) =>
        catalogEntry(record(entry).package),
      ),
      nextCursor: null,
    };
  }
  if (input.cursor !== undefined) {
    params.set("cursor", input.cursor);
  }
  const response = await request(`plugins?${params}`, signal);
  const nextCursor = response.nextCursor === null ? null : text(response.nextCursor);
  if (nextCursor !== null && nextCursor === input.cursor) {
    invalid();
  }
  return { plugins: array(response.items, PAGE_SIZE).map(catalogEntry), nextCursor };
}

export async function getClawHubPlugin(
  input: { readonly pluginId: string },
  signal?: AbortSignal,
): Promise<PluginCatalogEntry> {
  const response = await request(`packages/${encodeURIComponent(input.pluginId)}/detail`, signal);
  const entry = catalogEntry(response.package);
  if (entry.remoteId !== input.pluginId) {
    invalid();
  }
  const version = response.version == null ? undefined : record(response.version);
  const summary =
    version?.pluginManifestSummary == null ? undefined : record(version.pluginManifestSummary);
  const contracts = summary?.contracts == null ? undefined : record(summary.contracts);
  const declaredTools =
    contracts?.tools == null
      ? undefined
      : array(contracts.tools, 10_000).map((name) => text(name, 512));
  return {
    ...entry,
    metadata: {
      ...entry.metadata,
      ...(version == null ? {} : { version: text(version.version, 256) }),
      ...(declaredTools === undefined ? {} : { declaredTools }),
    },
    // Declared names have no admitted owner/policy identity; do not present them as editable tools.
    tools: [],
  };
}
