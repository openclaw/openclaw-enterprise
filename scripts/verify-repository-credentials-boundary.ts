import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParserOptions } from "prettier";
import { parsers } from "prettier/plugins/typescript";

// Prettier's TypeScript parser accepts an omitted options argument. Keep its
// output opaque until the scanner reads the AST.
type SourceParser = {
  parse(text: string, options?: ParserOptions<unknown>): unknown;
};

type ReviewedMembers = Readonly<Partial<Record<string, readonly string[]>>>;
type ReviewedModules = Readonly<Partial<Record<string, ReviewedMembers>>>;
type AstRecord = Record<string, unknown>;
type AstNode = AstRecord & { type: string };
type EdgeKind = "import" | "export";

const sourceParser: SourceParser = parsers.typescript;
const sourceRoot = fileURLToPath(new URL("../apps/controller/src/", import.meta.url));
const credentialDirectories = [
  "composition/repository-credentials",
  "drivers/repo/access",
  "drivers/repo/github",
  "backends/repository-credentials",
  "backends/token-service",
];
const sharedConfigurationFields = "composition/installation-fields.ts";
const sharedJsonMembers = "drivers/json-members.ts";
const openShellEvidence = "drivers/egress-proxy/openshell-repository-git-evidence.ts";
const processEntrypoint = "repository-credentials.ts";
const requiredEntrypoints = [
  processEntrypoint,
  sharedConfigurationFields,
  sharedJsonMembers,
  openShellEvidence,
  "composition/repository-credentials/check-config.ts",
  "composition/repository-credentials/projected-inputs.ts",
  "composition/repository-credentials/probe.ts",
  "drivers/repo/github/access/client/launch.ts",
  "drivers/repo/github/access/client/operator.ts",
  "drivers/repo/github/access/client/git-helper.ts",
  "drivers/repo/github/access/client/native-git.ts",
  "drivers/repo/github/access/client/hook-dispatch.ts",
  "drivers/repo/github/access/client/router.ts",
  "drivers/repo/github/access/client/draft-pr.ts",
];
const clientDirectory = "drivers/repo/github/access/client/";
const clientContracts = "drivers/repo/access/client-contracts.ts";
const publicReadDirectory = "drivers/repo/github/public-read/";
const sourceExtensions = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]);

// Adding an I/O owner or member requires security review; see the owning test guide.
const reviewedImports: ReviewedModules = {
  // Pure recipient SQL only: no adapter, loader, material or I/O authority.
  [openShellEvidence]: {
    "@openclaw-enterprise/contracts": ["repositoryGitRecipientFields"],
    "../repo/access/protected-repository-git-installation.ts": [
      "admittedAuthorization",
      "recipientAuthorization",
      "peerKey",
      "recipient",
      "registeredGitSelection",
      "installationGitAdoption",
      "selectedGitAdoption",
      "protectedGitAdoption",
    ],
  },
  [sharedConfigurationFields]: {
    "@openclaw-enterprise/utils": ["asRecord", "isNonEmptyString"],
    "node:path": ["isAbsolute"],
  },
  "drivers/repo/github/access/prepared-configuration.ts": {
    "../../../../composition/installation-fields.ts": ["object", "closed", "nonempty"],
  },
  "drivers/repo/github/installation.ts": {
    "../../../composition/installation-fields.ts": ["object", "closed", "nonempty"],
  },
  "drivers/repo/github/access/material.ts": {
    "node:crypto": ["KeyObject", "constants", "sign"],
  },
  "drivers/repo/github/access/provider-transport/request.ts": {
    "node:https": ["request"],
  },
  // Separate tokenless listener and fixed-origin anonymous GET; this owner and
  // the credential owners cannot import one another, in either direction.
  "drivers/repo/github/public-read/server.ts": {
    "node:http": ["createServer"],
    "node:https": ["Agent", "get"],
  },
  // The image draft helper uses only its selected broker, session bearer and operator-projected public CA.
  "drivers/repo/github/access/client/draft-pr.ts": {
    "node:crypto": ["randomUUID"],
    "node:https": ["Agent", "request"],
    "node:util": ["parseArgs"],
  },
  "drivers/repo/github/access/client/commands.ts": { "node:child_process": ["spawnSync"] },
  // chmod restores 0700/0600 after umask. It does not read credential material.
  "drivers/repo/github/access/client/config.ts": {
    "node:fs/promises": ["chmod", "lstat", "mkdir", "mkdtemp", "open", "rename", "rm"],
  },
  "drivers/repo/github/access/client/launch.ts": {
    "node:child_process": ["spawn"],
  },
  // The image dispatcher inspects native Git configuration and executes the
  // repository's existing executable hook. It never opens credential material.
  "drivers/repo/github/access/client/hook-dispatch.ts": {
    "node:child_process": ["spawnSync"],
    "node:fs": ["constants"],
    "node:fs/promises": ["access"],
  },
  "drivers/repo/github/access/client/manifest.ts": {
    "node:crypto": ["createHash"],
    "node:fs/promises": ["lstat"],
  },
  "drivers/repo/github/access/client/native-git.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["open"],
  },
  "drivers/repo/github/access/client/targets.ts": {
    "node:child_process": ["spawnSync"],
  },
  "drivers/repo/github/access/client/operator.ts": {
    "node:crypto": ["randomUUID"],
    "node:fs/promises": ["readFile"],
    "node:http": ["request"],
  },
  "drivers/repo/github/access/client/private-files.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["lstat", "open"],
  },
  "composition/repository-credentials/config.ts": {
    "node:tls": ["createSecureContext"],
  },
  "composition/repository-credentials/platform.ts": {
    // Shared, synchronous JSON validation has no credential or I/O access.
    "@openclaw-enterprise/contracts": ["requireConfiguration"],
  },
  "composition/repository-credentials/protected-file.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["lstat", "open"],
  },
  // Bounded, descriptor-checked PEM from the Installation's read-only public CA projection.
  "composition/repository-credentials/public-ca.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["open"],
    "node:tls": ["createSecureContext"],
  },
  "composition/repository-credentials/public-file.ts": {
    "node:fs/promises": ["stat"],
  },
  "composition/repository-credentials/projected-inputs.ts": {
    "node:crypto": ["X509Certificate"],
    "node:fs": ["constants"],
    "node:fs/promises": ["lstat", "mkdir", "open", "readdir", "readlink", "realpath", "unlink"],
  },
  "composition/repository-credentials/probe.ts": { "node:http": ["request"] },
  "backends/repository-credentials/control-client.ts": { "node:http": ["request"] },
  "composition/repository-credentials/registry.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["open"],
  },
  "drivers/repo/github/access/registry.ts": {
    "node:crypto": ["createHash"],
    // Compare the complete resolved binding before proposing standing scope; no I/O.
    "node:util": ["isDeepStrictEqual"],
  },
  // The OAuth grant's private CAS record pins client, endpoint, and scope. Only the
  // refresh adapter can POST that grant. The Token Service receives no general HTTP capability.
  "backends/token-service/oauth-connection.ts": {
    "node:crypto": ["randomUUID"],
    "node:timers/promises": ["setTimeout"],
    "@openclaw-enterprise/contracts": ["isOAuthScopeToken"],
    "@openclaw-enterprise/occ": [
      "BrowserAuthorizationError",
      "ResourceStateConflictError",
      "refreshPinnedOAuthGrant",
    ],
    "@openclaw-enterprise/utils": ["asRecord", "isNonEmptyString"],
  },
  // Token Service compares complete admissions. Provider I/O remains in the existing adapter.
  "backends/token-service/custody.ts": { "node:util": ["isDeepStrictEqual"] },
  "backends/token-service/service.ts": {
    "node:crypto": ["randomUUID"],
    "node:util": ["isDeepStrictEqual"],
  },
  // The prepared owner reads only the Installation custody mount. The App issuer comes
  // through the admitted Secret Driver; grant hashing, comparison, claims and signing-key import stay here.
  "drivers/repo/github/access/prepared-lifecycle.ts": {
    // Wait for an existing issuance claim within this request’s deadline.
    "node:timers/promises": ["setTimeout"],
    "node:crypto": ["createHash", "createPrivateKey", "randomUUID"],
    "node:fs/promises": ["readFile"],
    "node:util": ["isDeepStrictEqual"],
    "@openclaw-enterprise/contracts": [
      "githubMetadataGrant",
      "preparedGitHubProviderRef",
      "preparedGitHubSourceFromRoute",
    ],
    // Bind the admitted source and its exact current version on the send transaction; the error
    // class only reports an unsettled withdrawal and carries no material or I/O authority.
    "@openclaw-enterprise/occ": ["CredentialTokenUnsettledError", "postgresPreparedGitHubProof"],
  },
  // AES-GCM binds encrypted material to family and attempt; readiness selects no sealed bytes.
  "drivers/repo/github/access/prepared-postgres.ts": {
    // Reuse the platform transaction's metadata predicates; no new material or I/O authority.
    "@openclaw-enterprise/occ": [
      "preparedGitHubLive",
      "readPreparedGitHubMetadata",
      "preparedGitHubRejectedMaterialMatch",
    ],
    "node:crypto": ["createCipheriv", "createDecipheriv", "randomBytes", "randomUUID"],
    "node:util": ["isDeepStrictEqual"],
  },
  // The prepared Git owner and route observation must compare the same recipient fields. No I/O.
  "drivers/repo/access/protected-repository-git-installation.ts": {
    "@openclaw-enterprise/contracts": ["repositoryGitRecipientFields"],
  },
  "drivers/repo/github/access/prepared-repository-git.ts": {
    // Existing stateful helper on the caller's transaction, not general OCC access.
    "@openclaw-enterprise/occ": ["CredentialDeliveries"],
    // Process-local identity for the existing recipient-delivery worker.
    "node:crypto": ["randomUUID"],
    "node:util": ["isDeepStrictEqual"],
  },
  // Worker only: the Installation's read-only App and custody mounts, public key
  // fingerprint, and preparation attempt ID. The broker has neither key mount.
  "backends/repository-credentials/prepared-git-owner.ts": {
    // Pure canonical scope hashing shared with admission; no new state or signing authority.
    "@openclaw-enterprise/occ": ["repositoryApprovalFingerprint"],
    "node:crypto": ["createHash", "createPrivateKey", "createPublicKey", "randomUUID"],
    "node:fs": ["constants"],
    "node:fs/promises": ["open"],
    "node:util": ["isDeepStrictEqual"],
  },
  // One use of committed material via the private Unix socket; no preparation operation.
  "drivers/repo/github/access/warm-use.ts": {
    "node:crypto": ["randomUUID"],
    "node:http": ["request"],
  },
  // Standalone grants hash only nonsecret configuration/profile policy, never key material.
  "drivers/repo/github/access/grants.ts": { "node:crypto": ["createHash"] },
  // Hash the canonical public CA bundle for issuer trust identity.
  "drivers/repo/github/access/origin.ts": { "node:crypto": ["createHash"] },
  "drivers/repo/github/policy.ts": {
    "@openclaw-enterprise/occ": ["ScopeViolationError"],
  },
  "drivers/repo/github/driver.ts": {
    "@openclaw-enterprise/contracts": ["isInstallationRepositoryProfile"],
    "@openclaw-enterprise/occ": ["DependencyUnavailableError", "ScopeViolationError"],
  },
  // The isolated image probe reports only a synthetic binding and failure kind.
  "drivers/repo/github/access/admission-probe.ts": {
    "@openclaw-enterprise/occ": ["DependencyUnavailableError"],
  },
  // The broker journal client writes only nonsecret receipts over a local Unix socket.
  "drivers/repo/access/control.ts": { "node:crypto": ["randomUUID"] },
  "drivers/repo/access/receipt-client.ts": { "node:http": ["request"] },
  // Worker-private receipt and prepared-use sockets; parent and socket identity are checked.
  "backends/repository-credentials/private-request-server.ts": {
    "node:http": ["createServer"],
    "node:fs/promises": ["chmod", "lstat", "mkdir", "realpath", "unlink"],
  },
  "backends/repository-credentials/control-socket.ts": {
    "node:net": ["connect"],
    "node:fs/promises": ["lstat", "unlink"],
  },
  "drivers/repo/access/lifecycle.ts": { "node:crypto": ["randomUUID"] },
  "drivers/repo/access/server.ts": {
    "node:fs/promises": ["chmod", "lstat", "realpath", "unlink"],
    "node:http": ["createServer"],
    "node:https": ["createServer"],
  },
  "drivers/repo/access/sessions.ts": {
    "node:crypto": ["createHash", "randomBytes", "randomUUID"],
  },
  // Hash the selected Git request, including the bounded body after decompression.
  "drivers/repo/access/transport/agent.ts": {
    "node:crypto": ["createHash"],
    "node:util": ["promisify"],
  },
  "drivers/repo/access/transport/request-headers.ts": {
    "node:http": ["validateHeaderName", "validateHeaderValue"],
  },
  "drivers/repo/access/transport/upstream.ts": { "node:https": ["request"] },
};
const ordinaryBuiltins = new Set([
  "node:os",
  "node:path",
  "node:perf_hooks",
  "node:stream",
  "node:stream/promises",
  "node:url",
  "node:zlib",
]);
// Restrict imports and re-exports inside scanned credential source. The worker
// entrypoint is outside that source; packaging and runtime tests cover that boundary.
const capabilityConsumers: ReviewedModules = {
  [openShellEvidence]: {
    "composition/repository-credentials/custody-selection.ts": [
      "openShellGitRecipientEvidence",
      "openShellPreviewEnded",
    ],
  },
  "backends/repository-credentials/control-socket.ts": {
    "backends/repository-credentials/private-request-server.ts": ["prepareControlSocket"],
    "drivers/repo/access/server.ts": ["prepareControlSocket"],
  },
  "composition/repository-credentials/public-ca.ts": {
    "composition/repository-credentials/config.ts": ["loadPublicCa"],
    "composition/repository-credentials/platform.ts": ["loadPublicCa"],
  },
  "composition/repository-credentials/public-file.ts": {
    "composition/repository-credentials/public-ca.ts": ["readPublicFile"],
    "composition/repository-credentials/registry.ts": ["readPublicFile"],
  },
  "backends/repository-credentials/private-request-server.ts": {
    "backends/repository-credentials/receipt-server.ts": ["servePrivateRepositoryRequest"],
    "backends/repository-credentials/prepared-git-owner.ts": ["servePrivateRepositoryRequest"],
  },
  // Selected directly by worker.mjs; no runtime import from credential source is authorized.
  "backends/repository-credentials/prepared-git-owner.ts": {},
  "drivers/repo/github/access/prepared-repository-git.ts": {
    "backends/repository-credentials/prepared-git-owner.ts": ["PreparedRepositoryGitStore"],
  },
  "drivers/repo/github/access/warm-use.ts": {
    "drivers/repo/github/access/warm-registry-factory.ts": ["authorizePreparedGitSend"],
  },
  "drivers/repo/access/transport/agent.ts": {
    "drivers/repo/access/server.ts": ["createAgentHandler"],
  },
  "drivers/repo/github/access/provider-transport/request.ts": {
    "drivers/repo/github/access/provider-transport.ts": ["sendProviderRequest"],
  },
  "drivers/repo/access/transport/upstream.ts": {
    "drivers/repo/access/transport/agent.ts": ["createUpstreamSender"],
  },
  "drivers/repo/access/receipt-client.ts": {
    "drivers/repo/access/control.ts": ["RepositoryReceiptClient"],
  },
  "backends/repository-credentials/control-client.ts": {
    "composition/repository-credentials/platform.ts": ["UnixRepositoryCredentialControlClient"],
    "drivers/repo/github/driver.ts": ["RepositoryCredentialControlError"],
    "drivers/repo/github/access/admission-probe.ts": ["UnixRepositoryCredentialControlClient"],
  },
};
const rawGlobals = new Set([
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "require",
  "eval",
  "Function",
  "global",
  "globalThis",
  "console",
  "module",
]);
const reviewedProcessMembers: ReviewedMembers = {
  "composition/repository-credentials/check-config.ts": ["argv", "exitCode", "stderr", "stdout"],
  "drivers/repo/github/access/client/environment.ts": ["env"],
  "drivers/repo/github/access/client/git-helper.ts": [
    "argv",
    "env",
    "exit",
    "exitCode",
    "stderr",
    "stdin",
    "stdout",
  ],
  "drivers/repo/github/access/client/launch.ts": ["argv", "env", "exitCode", "off", "on", "stderr"],
  "drivers/repo/github/access/client/manifest.ts": ["getuid"],
  "drivers/repo/github/access/client/hook-dispatch.ts": [
    "argv",
    "env",
    "exitCode",
    "stderr",
    "stdin",
  ],
  "drivers/repo/github/access/client/native-git.ts": ["argv", "execPath", "exitCode", "stderr"],
  "drivers/repo/github/access/client/draft-pr.ts": ["argv", "env", "exitCode", "stderr", "stdout"],
  "drivers/repo/github/access/client/router.ts": ["argv", "env", "exitCode", "stderr"],
  "drivers/repo/github/access/client/operator.ts": ["argv", "exitCode", "stderr", "stdout"],
  "drivers/repo/github/access/admission-probe.ts": ["argv", "exitCode", "stderr", "stdout"],
  "drivers/repo/github/access/client/private-files.ts": ["getuid"],
  "composition/repository-credentials/protected-file.ts": ["getuid"],
  "composition/repository-credentials/service.ts": ["exit", "once", "stderr", "stdout"],
  "composition/repository-credentials/projected-inputs.ts": [
    "argv",
    "exitCode",
    "getuid",
    "stderr",
    "stdout",
  ],
  "composition/repository-credentials/probe.ts": ["exitCode"],
  "repository-credentials.ts": ["argv", "exitCode", "stderr", "stdout"],
  "drivers/repo/access/server.ts": ["getuid"],
  "backends/repository-credentials/control-socket.ts": ["getuid"],
  "backends/repository-credentials/private-request-server.ts": ["getuid"],
};
const runtimeTypeScript = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSParameterProperty",
  "TSExportAssignment",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember",
]);

const emittedToSourceExtension: Readonly<Partial<Record<string, string>>> = {
  ".js": ".ts",
  ".mjs": ".mts",
  ".cjs": ".cts",
};

function slash(path: string): string {
  return path.split(sep).join("/");
}

async function sourceStat(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  });
}

async function collectSourceFiles(root: string, files: string[]): Promise<void> {
  if (!(await lstat(root)).isDirectory()) {
    throw new Error(`Credential source must be a directory: ${root}`);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Credential source must not be a symlink: ${path}`);
    }
    if (entry.isDirectory()) {
      await collectSourceFiles(path, files);
    } else if (sourceExtensions.has(extname(entry.name))) {
      if (!entry.isFile()) {
        throw new Error(`Credential source must be a regular file: ${path}`);
      }
      files.push(path);
    }
  }
}

function isRecord(value: unknown): value is AstRecord {
  return typeof value === "object" && value !== null;
}

function isNode(value: unknown): value is AstNode {
  return isRecord(value) && typeof value.type === "string";
}

function requireRecord(value: unknown): AstRecord {
  if (!isRecord(value)) {
    throw new TypeError("Expected a TypeScript parser AST record");
  }
  return value;
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function requireList(value: unknown): readonly unknown[] {
  if (!isList(value)) {
    throw new TypeError("Expected a TypeScript parser AST list");
  }
  return value;
}

function name(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return value.type === "Identifier" ? value.name : value.value;
}

function member(node: AstNode): unknown {
  const property = requireRecord(node.property);
  return !node.computed || property.type === "Literal" ? name(property) : undefined;
}

function isReference(parent: AstNode | undefined, key: string | undefined): boolean {
  if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) {
    return false;
  }
  if (parent && ["Property", "MethodDefinition", "PropertyDefinition"].includes(parent.type)) {
    if (key === "key" && !parent.computed) {
      return false;
    }
  }
  if (key === "id" || key === "label") {
    return false;
  }
  return true;
}

function unwrappedValue(node: unknown): unknown {
  while (isNode(node) && runtimeTypeScript.has(node.type) && node.expression) {
    node = node.expression;
  }
  return node;
}

function relativeSource(
  path: string,
  root: string,
  specifier: string,
  sources: ReadonlySet<string>,
): string {
  const target = slash(relative(root, resolve(dirname(path), specifier)));
  if (sources.has(target)) {
    return target;
  }
  const extension = extname(target);
  const sourceExtension = emittedToSourceExtension[extension];
  const sourceTarget = sourceExtension && target.slice(0, -extension.length) + sourceExtension;
  return sourceTarget && sources.has(sourceTarget) ? sourceTarget : target;
}

function valueSpecifiers(value: unknown, kind: "importKind" | "exportKind"): AstRecord[] {
  const specifiers: AstRecord[] = [];
  for (const item of requireList(value)) {
    const specifier = requireRecord(item);
    if (specifier[kind] !== "type") {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function allReviewed(names: readonly unknown[], members: readonly string[] | undefined): boolean {
  return names.every((binding) => typeof binding === "string" && members?.includes(binding));
}

function inspectSource(
  path: string,
  root: string,
  sources: ReadonlySet<string>,
  ast: unknown,
): string[] {
  const file = slash(relative(root, path));
  const failures: string[] = [];
  const rawBindings = new Set<string>();
  for (const value of requireList(requireRecord(ast).body)) {
    const node = requireRecord(value);
    if (node.type !== "ImportDeclaration" || node.importKind === "type") {
      continue;
    }
    const source = requireRecord(node.source).value;
    if (typeof source !== "string") {
      throw new TypeError("Expected a TypeScript import source string");
    }
    if (
      ordinaryBuiltins.has(source) &&
      file !== sharedConfigurationFields &&
      file !== openShellEvidence
    ) {
      continue;
    }
    if (
      source.startsWith(".") &&
      file !== sharedConfigurationFields &&
      file !== openShellEvidence
    ) {
      const target = relativeSource(path, root, source, sources);
      const restricted =
        target === sharedConfigurationFields ||
        capabilityConsumers[target] ||
        (!file.startsWith(clientDirectory) && target.startsWith(clientDirectory));
      if (!restricted) {
        continue;
      }
    }
    for (const specifier of valueSpecifiers(node.specifiers, "importKind")) {
      const localName = requireRecord(specifier.local).name;
      if (typeof localName === "string") {
        rawBindings.add(localName);
      }
    }
  }

  function isRawBinding(binding: unknown): boolean {
    return typeof binding === "string" && rawBindings.has(binding);
  }

  function deny(node: AstRecord, reason: string): void {
    const loc = node.loc;
    const start = isRecord(loc) ? loc.start : undefined;
    const line = isRecord(start) ? start.line : undefined;
    failures.push(`${file}:${line ?? 1}: ${reason}`);
  }

  function edge(
    node: AstNode,
    specifier: unknown,
    names: readonly unknown[],
    kind: EdgeKind,
  ): void {
    if (typeof specifier !== "string") {
      deny(node, "nonliteral module loading requires security review");
      return;
    }
    const reviewed = reviewedImports[file]?.[specifier];
    // Like the shared field owner, this pure module must not inherit general
    // relative-source or ordinary-builtin access (including credential material).
    if (file === openShellEvidence) {
      if (kind === "import" && allReviewed(names, reviewed)) {
        // Continue through the source and capability checks for relative imports.
        if (!specifier.startsWith(".")) {
          return;
        }
      } else {
        deny(node, `unreviewed OpenShell evidence ${kind} from ${specifier}`);
        return;
      }
    }
    // The pure owner and its consumers admit only exact module spellings and symbols.
    // Do not inherit ordinary builtin or relative-source permissions here.
    if (
      file === sharedConfigurationFields ||
      (specifier.startsWith(".") &&
        relativeSource(path, root, specifier, sources) === sharedConfigurationFields)
    ) {
      if (kind === "import" && allReviewed(names, reviewed)) {
        return;
      }
      deny(node, `unreviewed shared field validation ${kind} from ${specifier}`);
      return;
    }
    if (specifier.startsWith(".")) {
      const target = relativeSource(path, root, specifier, sources);
      if (
        target === ".." ||
        target.startsWith("../") ||
        target.includes("?") ||
        target.includes("#")
      ) {
        deny(node, `runtime import escapes credential source: ${specifier}`);
        return;
      }
      if (!sources.has(target)) {
        deny(node, `runtime import has no scanned credential source: ${specifier}`);
        return;
      }
      if (file.startsWith(publicReadDirectory) !== target.startsWith(publicReadDirectory)) {
        deny(
          node,
          "public GitHub reader and repository credential owners cannot load one another: " +
            target,
        );
        return;
      }
      if (
        file.startsWith(clientDirectory) &&
        !target.startsWith(clientDirectory) &&
        target !== clientContracts
      ) {
        deny(node, `client runtime cannot load service owner ${target}`);
      }
      const consumers = capabilityConsumers[target];
      if (consumers && (kind !== "import" || !allReviewed(names, consumers[file]))) {
        deny(node, `raw sender ${target} is not reviewed for ${file}`);
      }
      if (!file.startsWith(clientDirectory) && target.startsWith(clientDirectory)) {
        const rendersSessionFiles =
          file === "drivers/repo/github/driver.ts" &&
          target === `${clientDirectory}config.ts` &&
          kind === "import" &&
          names.length === 1 &&
          names[0] === "encodeRepositoryCredentialSessionFiles";
        if (!rendersSessionFiles) {
          deny(node, `service code cannot load client command owner ${target}`);
        }
      }
      return;
    }
    if (ordinaryBuiltins.has(specifier)) {
      return;
    }
    if (kind === "import" && allReviewed(names, reviewed)) {
      return;
    }
    deny(node, `unreviewed runtime ${kind} from ${specifier} (${names.join(", ")})`);
  }

  function visit(node: unknown, parent?: AstNode, key?: string): void {
    if (!isNode(node) || node.declare) {
      return;
    }
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type") {
        return;
      }
      const values = valueSpecifiers(node.specifiers, "importKind");
      // With verbatimModuleSyntax, inline type-only specifiers retain import {}.
      const names = values.length
        ? values.map((specifier) => name(specifier.imported) ?? "*")
        : ["<side-effect>"];
      edge(node, requireRecord(node.source).value, names, "import");
      return;
    }
    if (node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") {
      if (node.exportKind === "type") {
        return;
      }
      const values = valueSpecifiers(node.specifiers ?? [], "exportKind");
      if (node.source) {
        const names = values.map((specifier) => name(specifier.local));
        if (!names.length) {
          names.push(node.type === "ExportAllDeclaration" ? "*" : "<side-effect>");
        }
        edge(node, requireRecord(node.source).value, names, "export");
      } else {
        for (const specifier of values) {
          if (isRawBinding(name(specifier.local))) {
            deny(specifier, "raw I/O binding cannot be re-exported");
          }
        }
        const exported = node.declaration;
        if (isNode(exported) && exported.type === "VariableDeclaration") {
          for (const item of requireList(exported.declarations)) {
            const declaration = requireRecord(item);
            const value = unwrappedValue(declaration.init);
            if (isNode(value) && value.type === "Identifier" && isRawBinding(value.name)) {
              deny(declaration, "raw I/O binding cannot be re-exported");
            }
          }
        }
        visit(node.declaration, node, "declaration");
      }
      return;
    }
    if (node.type === "ExportDefaultDeclaration") {
      const value = unwrappedValue(node.declaration);
      if (isNode(value) && value.type === "Identifier" && isRawBinding(value.name)) {
        deny(node, "raw I/O binding cannot be re-exported");
      }
    }
    if (node.type === "TSImportEqualsDeclaration") {
      if (node.importKind !== "type") {
        const expression = requireRecord(node.moduleReference).expression;
        edge(node, isRecord(expression) ? expression.value : undefined, ["*"], "import");
      }
      return;
    }
    if (node.type === "ImportExpression") {
      const source = requireRecord(node.source);
      edge(node, source.type === "Literal" ? source.value : undefined, ["*"], "import");
      return;
    }
    if (node.type.startsWith("TS") && !runtimeTypeScript.has(node.type)) {
      return;
    }
    if (node.type === "Identifier" && isReference(parent, key)) {
      if (typeof node.name === "string" && rawGlobals.has(node.name)) {
        deny(node, `raw global ${node.name} requires security review`);
      }
      if (node.name === "process") {
        const property =
          parent?.type === "MemberExpression" && key === "object" ? member(parent) : undefined;
        if (
          typeof property !== "string" ||
          !property ||
          !reviewedProcessMembers[file]?.includes(property)
        ) {
          deny(node, `raw process capability ${property ?? "<value>"} requires security review`);
        }
      }
    }
    for (const childKey of Object.keys(node)) {
      if (["comments", "tokens", "loc", "range"].includes(childKey)) {
        continue;
      }
      const child = node[childKey];
      if (isList(child)) {
        for (const item of child) {
          visit(item, node, childKey);
        }
      } else {
        visit(child, node, childKey);
      }
    }
  }
  visit(ast);
  return failures;
}

export async function verifyRepositoryCredentialBoundary(
  root: string = sourceRoot,
): Promise<number> {
  const files: string[] = [];
  for (const directory of credentialDirectories) {
    const path = join(root, directory);
    const stat = await sourceStat(path);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Missing or invalid credential source root: ${directory}`);
    }
    const owned: string[] = [];
    await collectSourceFiles(path, owned);
    if (!owned.length) {
      throw new Error(`Empty credential source root: ${directory}`);
    }
    files.push(...owned.sort());
  }
  for (const entrypoint of [
    processEntrypoint,
    sharedConfigurationFields,
    sharedJsonMembers,
    openShellEvidence,
  ]) {
    const path = join(root, entrypoint);
    const stat = await sourceStat(path);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new Error(`Invalid credential entrypoint: ${entrypoint}`);
    }
    if (stat) {
      files.push(path);
    }
  }
  const sources = new Set(files.map((path) => slash(relative(root, path))));
  const failures: string[] = [];
  for (const entrypoint of requiredEntrypoints) {
    if (!sources.has(entrypoint)) {
      failures.push(`Missing credential entrypoint: ${entrypoint}`);
    }
  }
  for (const path of files) {
    const ast = await sourceParser.parse(await readFile(path, "utf8"));
    failures.push(...inspectSource(path, root, sources, ast));
  }
  if (failures.length) {
    throw new Error(
      `Repository credential boundary requires security review:\n${failures.join("\n")}`,
    );
  }
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = await verifyRepositoryCredentialBoundary();
  process.stdout.write(`Repository credential boundary verified: ${count} source files.\n`);
}
