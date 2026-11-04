import type { PluginCatalogEntry, PluginCatalogPage } from "@openclaw-enterprise/contracts";

interface PluginDiscoveryFixture {
  pages: Readonly<Record<string, PluginCatalogPage>> & { initial: PluginCatalogPage };
  details: Readonly<Record<string, PluginCatalogEntry>>;
}

type DiscoveryError =
  "INVALID_REQUEST" | "PLUGIN_DISCOVERY_INVALID_RESPONSE" | "PLUGIN_DISCOVERY_UNAVAILABLE";

const pageSize = 20;

function ownValue<T>(records: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(records, key) ? records[key] : undefined;
}

export function servePluginDiscovery(
  fixture: PluginDiscoveryFixture,
  operation: "catalog" | "details",
  body: unknown,
  response: (data: PluginCatalogPage | PluginCatalogEntry) => Response,
  error: (status: number, code: DiscoveryError) => Response,
): Response {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return error(400, "INVALID_REQUEST");
  }
  if (operation === "details") {
    if (!("pluginId" in body) || typeof body.pluginId !== "string" || !body.pluginId) {
      return error(400, "INVALID_REQUEST");
    }
    const entry = ownValue(fixture.details, body.pluginId);
    return entry ? response(entry) : error(503, "PLUGIN_DISCOVERY_UNAVAILABLE");
  }

  const q = "q" in body ? body.q : undefined;
  const cursor = "cursor" in body ? body.cursor : undefined;
  if (
    (q !== undefined && typeof q !== "string") ||
    (cursor !== undefined && (typeof cursor !== "string" || !cursor))
  ) {
    return error(400, "INVALID_REQUEST");
  }
  const query = q?.trim().toLowerCase();
  if (!query) {
    const page = ownValue(fixture.pages, cursor ?? "initial");
    return page ? response(page) : error(400, "PLUGIN_DISCOVERY_INVALID_RESPONSE");
  }

  const matches = Object.values(fixture.pages)
    .flatMap((page) => page.plugins)
    .filter((entry) =>
      [entry.name, entry.id, entry.description ?? ""].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  let offset = 0;
  if (cursor !== undefined) {
    offset = Number(cursor.slice("search-".length));
    if (
      !/^search-[1-9]\d*$/.test(cursor) ||
      !Number.isSafeInteger(offset) ||
      offset % pageSize !== 0 ||
      offset >= matches.length
    ) {
      return error(400, "PLUGIN_DISCOVERY_INVALID_RESPONSE");
    }
  }
  const { setup } = fixture.pages.initial;
  return response({
    plugins: matches.slice(offset, offset + pageSize),
    nextCursor: offset + pageSize < matches.length ? `search-${offset + pageSize}` : null,
    ...(setup === undefined ? {} : { setup }),
  });
}
