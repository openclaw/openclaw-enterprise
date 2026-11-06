import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const digest = (text) => createHash("sha256").update(text).digest("hex");

/** Both revision admission and the worker read this same fixture release. */
export function keycloakAccountMcpPackage(source, issuer, serverUrl) {
  const url = new URL(serverUrl);
  const packageName = "test-keycloak-reports";
  const slotId = "reports";
  const catalog = new URL(
    "../../apps/controller/plugins/" + source.packageName + "/",
    import.meta.url,
  );
  const definition = JSON.parse(readFileSync(new URL("mcp.json", catalog), "utf8"));
  definition.mcpServers[source.server].url = url.href;
  const manifest = JSON.stringify(definition);
  const upstream = JSON.parse(
    readFileSync(new URL("ai.openclaw.oce/release.json", catalog), "utf8"),
  );
  const credentials = {
    [slotId]: {
      ...source.credentials[source.slotId],
      label: "Reports account",
      issuer,
      mcp: { ...source.credentials[source.slotId].mcp, resource: url.origin },
    },
  };
  const release = JSON.stringify({
    ...upstream,
    release: "keycloak-reports-v1",
    mcpServersSha256: digest(manifest),
    credentials,
  });
  return {
    install: {
      ...source,
      url: url.href,
      endpoint: { host: url.hostname, port: Number(url.port), path: url.pathname },
      id: packageName,
      packageName,
      credentials,
      slotId,
      releaseSha256: digest(release),
    },
    files: { manifest, release },
  };
}
