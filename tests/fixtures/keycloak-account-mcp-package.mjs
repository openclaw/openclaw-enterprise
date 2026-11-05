import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const digest = (text) => createHash("sha256").update(text).digest("hex");

/** Both revision admission and the worker read this same fixture release. */
export function keycloakAccountMcpPackage(source, issuer) {
  const packageName = "test-keycloak-reports";
  const slotId = "reports";
  const catalog = new URL(
    "../../apps/controller/plugins/" + source.packageName + "/",
    import.meta.url,
  );
  const manifest = readFileSync(new URL("mcp.json", catalog), "utf8");
  const upstream = JSON.parse(
    readFileSync(new URL("ai.openclaw.oce/release.json", catalog), "utf8"),
  );
  const credentials = {
    [slotId]: { ...source.credentials[source.slotId], label: "Reports account", issuer },
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
      id: packageName,
      packageName,
      credentials,
      slotId,
      releaseSha256: digest(release),
    },
    files: { manifest, release },
  };
}
