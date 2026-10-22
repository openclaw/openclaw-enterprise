import type { AuthorityIdentity, ResolvedGrant } from "../../credentials/backend-contracts.ts";
import { createHash } from "node:crypto";
import { permissionsForProfile } from "./profiles.ts";
import type { GitHubTokenSource } from "./token-source.ts";
import type {
  GitHubTokenConfiguration,
  GitHubFactoryOptions,
  GitHubTokenProfile,
} from "./types.ts";
import { sameAuthority } from "./driver/state.ts";

type GrantDependencies = Readonly<{
  config: GitHubTokenConfiguration;
  gatewayOrigin: string;
  source: GitHubTokenSource;
  selectedBinding?: GitHubFactoryOptions["binding"];
}>;

/** Installation supplies the canonical HTTPS origin and a parsed public CA bundle.
 * Bind the trust policy, independent of PEM ordering, rather than a rotating leaf certificate. */
export function preparationIssuerAuthority(origin: string, ca?: Uint8Array): string {
  if (!ca) {
    return origin + "#default-https-trust";
  }
  const certificates = Buffer.from(ca)
    .toString()
    .split(/(?<=-----END CERTIFICATE-----)/)
    .map((cert) => cert.trim())
    .filter(Boolean);
  const bundle = [...new Set(certificates)].sort().join("\n");
  return origin + "#ca-sha256=" + createHash("sha256").update(bundle).digest("hex");
}

function grantIdentity(
  source: GitHubTokenSource,
  configVersion: string,
  profile: GitHubTokenProfile,
) {
  // A static token's permission map is a REST write-route allowlist, not provider-verified
  // permissions. The authority and push policy keep token grants disjoint from App grants.
  return {
    configVersion,
    profile,
    routePermissions: permissionsForProfile(profile),
    capabilityPolicy: source.capabilityPolicy(profile),
    pushRefAllowlist: source.pushRefAllowlist,
    authority: source.kind,
  };
}

export function createGrantResolver({
  config,
  gatewayOrigin,
  source,
  selectedBinding,
}: GrantDependencies) {
  const { pushRefAllowlist } = source;
  function resolve(profile: string): ResolvedGrant {
    if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full") {
      throw new Error("unsupported-profile");
    }
    if (selectedBinding && profile !== selectedBinding.profile) {
      throw new Error("unsupported-profile");
    }
    return Object.freeze({
      binding:
        selectedBinding?.identity ??
        Object.freeze({
          providerInstanceId: config.providerInstanceId,
          repositoryId: config.repositoryId,
          grantId: `sha256:${createHash("sha256")
            .update(JSON.stringify(grantIdentity(source, config.configVersion, profile)))
            .digest("hex")}`,
        }),
      client: Object.freeze({
        gatewayOrigin,
        gitRemote: `${gatewayOrigin}/${config.repository}.git`,
        gitUsername: "gateway-session",
        canonicalApiHost: "github.com",
        apiHost: new URL(gatewayOrigin).hostname,
        repository: config.repository,
        ...(pushRefAllowlist === undefined ? {} : { pushRefAllowlist }),
      }),
    });
  }
  function forAuthority(authority: AuthorityIdentity) {
    const profile = (
      selectedBinding ? [selectedBinding.profile] : (["git-read", "git-write", "git-full"] as const)
    ).find((value) =>
      sameAuthority({ ...resolve(value).binding, sessionId: authority.sessionId }, authority),
    );
    if (!profile || !authority.sessionId) {
      throw new Error("invalid-binding");
    }
    return { profile, grant: resolve(profile) };
  }
  return { resolve, forAuthority };
}
