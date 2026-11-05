import { createHash } from "node:crypto";
import { posix } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { extract } from "tar-stream";
import { parseDocument } from "yaml";
import {
  PluginPackageInspectionError,
  canonicalPluginPackageContent,
  isAllowedSecretBindingDestination,
  type ImportedMcpServer,
  type ImportedPluginSkill,
  type InspectedPluginPackage,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { exactDnsName } from "../credential-source-endpoint.ts";

const MiB = 1024 * 1024;
const inflate = promisify(gunzip);
const schema = "https://agent-plugins.org/schemas/1.0.0/";
const packageName = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/u;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const skillName = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const paths = ["commands", "agents", "skills", "hooks", "outputStyles", "themes"] as const;
type Fields = Record<string, unknown>;
type Files = Map<string, { bytes: Buffer; executable: boolean }>;
type Omission = InspectedPluginPackage["unsupported"][number];

function invalid(reason: string): never {
  throw new PluginPackageInspectionError(reason);
}

function safePath(value: string): string {
  const path = value.replace(/^(?:\.\/)+/u, "").replace(/\/$/u, "");
  if (
    !path ||
    path.length > 512 ||
    /[\\:\p{Cc}\uFFFD]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    invalid("Package contains an unsafe relative path.");
  }
  return path;
}

async function readArchive(archive: Uint8Array): Promise<Files> {
  if (!archive.length || archive.length > 16 * MiB) {
    invalid("Upload a tar or tar.gz package of at most 16 MiB.");
  }
  const data =
    archive[0] === 0x1f && archive[1] === 0x8b
      ? await inflate(archive, { maxOutputLength: 32 * MiB })
      : archive;
  const tar = extract();
  const entries = tar[Symbol.asyncIterator]();
  tar.end(data);
  const files: Files = new Map();
  const directories = new Set<string>();
  let count = 0;
  try {
    for (let item = await entries.next(); !item.done; item = await entries.next()) {
      const stream = item.value;
      const { name, size, type, mode } = stream.header;
      if (++count > 4096 || !Number.isSafeInteger(size) || size < 0 || size > 16 * MiB) {
        invalid("Package exceeds the archive entry or file size limit.");
      }
      if (type === "directory" && /^(?:\.\/?)+$/u.test(name)) {
        stream.resume();
        continue;
      }
      const path = safePath(name);
      if (files.has(path) || (type !== "directory" && directories.has(path))) {
        invalid("Package contains duplicate or conflicting paths.");
      }
      for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) {
        if (files.has(dir)) {
          invalid("A file in the package is also used as a directory.");
        }
        directories.add(dir);
      }
      if (type === "directory") {
        directories.add(path);
        stream.resume();
        continue;
      }
      if (type !== "file") {
        invalid("Package contains a link or a special file.");
      }
      const parts: Buffer[] = [];
      for await (const part of stream) {
        if (!(part instanceof Uint8Array)) {
          invalid("Invalid archive file data.");
        }
        parts.push(Buffer.from(part));
      }
      files.set(path, { bytes: Buffer.concat(parts), executable: (mode & 0o111) !== 0 });
    }
  } finally {
    await entries.return?.();
  }
  return files;
}

function json(files: Files, path: string): Fields {
  const file = files.get(path);
  if (!file || file.bytes.length > MiB) {
    invalid("A declared JSON file is missing or exceeds 1 MiB.");
  }
  const value = asRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)));
  return value ?? invalid("A package manifest or MCP descriptor must be a JSON object.");
}

function schemaRoot(files: Files): string {
  const roots = new Set([...files.keys()].map((path) => path.split("/")[0]!));
  if (roots.size !== 1) {
    return "";
  }
  const [only] = roots;
  if (
    only &&
    ![".claude-plugin", "skills", "package.json", "plugin.json", ".mcp.json"].includes(only) &&
    !files.has(only)
  ) {
    return only + "/";
  }
  return "";
}

function selectedEntry(files: Files, root: string, selected?: string) {
  const claude = files.has(root + ".claude-plugin/marketplace.json");
  if (!selected) {
    if (claude || files.has(root + "marketplace.json")) {
      invalid("Choose one entry from this marketplace.");
    }
    return { root, entry: undefined };
  }
  if (!packageName.test(selected)) {
    invalid("Invalid marketplace entry name.");
  }
  const index = json(
    files,
    root + (claude ? ".claude-plugin/marketplace.json" : "marketplace.json"),
  );
  const matches = Array.isArray(index.plugins)
    ? index.plugins.map(asRecord).filter((entry) => entry?.name === selected)
    : [];
  if (matches.length !== 1) {
    invalid("The selected marketplace entry is missing or ambiguous.");
  }
  const entry = matches[0]!;
  if (entry.source === "./" || entry.source === ".") {
    return { root, entry };
  }
  if (typeof entry.source !== "string" || !entry.source.startsWith("./")) {
    invalid(
      "This marketplace entry requires a separate package. Upload the resolved package to inspect it.",
    );
  }
  return { root: root + safePath(entry.source) + "/", entry };
}

function list(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function skillDirs(files: Files, root: string, roots: string[], portable: boolean): string[] {
  const result = new Set<string>();
  for (const source of roots) {
    const prefix = source ? root + source + "/" : root;
    if (!portable && files.has(prefix + "SKILL.md")) {
      result.add(prefix);
      continue;
    }
    for (const path of files.keys()) {
      if (path.startsWith(prefix) && /^[^/]+\/SKILL\.md$/u.test(path.slice(prefix.length))) {
        result.add(path.slice(0, -"SKILL.md".length));
      }
    }
  }
  return [...result].sort();
}

function readSkill(
  files: Files,
  dir: string,
  portable: boolean,
  fallbackName = posix.basename(dir),
): ImportedPluginSkill {
  const children = [...files].filter(([path]) => path.startsWith(dir));
  if (
    children.length > 256 ||
    children.some(([, file]) => file.bytes.length > MiB) ||
    children.reduce((n, [, file]) => n + file.bytes.length, 0) > 8 * MiB
  ) {
    invalid(
      "A skill exceeds the dedicated worker limit of 256 files, 1 MiB per file or 8 MiB in total.",
    );
  }
  const instructions = new TextDecoder("utf-8", { fatal: true }).decode(
    files.get(dir + "SKILL.md")!.bytes,
  );
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(instructions);
  let fields: Fields = {};
  if (header) {
    const doc = parseDocument(header[1]!, { schema: "core", strict: true });
    if (doc.errors.length || doc.warnings.length) {
      invalid("Invalid skill frontmatter.");
    }
    fields = asRecord(doc.toJS({ maxAliasCount: 0 })) ?? invalid("Invalid skill frontmatter.");
  }
  const basename = posix.basename(dir);
  const name = fields.name ?? fallbackName;
  if (
    typeof name !== "string" ||
    !skillName.test(name) ||
    name.includes("--") ||
    (portable &&
      (fields.name !== basename ||
        typeof fields.description !== "string" ||
        !fields.description.trim()))
  ) {
    invalid("The skill needs valid metadata and a portable name.");
  }
  const seen = new Set<string>();
  const skillFiles = children.map(([path, file]) => {
    const relative = path.slice(dir.length);
    const parts = relative.split("/");
    if (
      parts.length > 16 ||
      parts.some(
        (part) =>
          part !== part.normalize("NFC") ||
          /[<>|"*?]|[ .]$/u.test(part) ||
          /^(?:\.git|node_modules|\.openclaw)$/iu.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)|^(?:conin|conout)\$$/iu.test(part),
      )
    ) {
      invalid("A skill contains a path the dedicated worker cannot materialize.");
    }
    const key = relative.toLowerCase();
    if (seen.has(key)) {
      invalid("The skill contains colliding file paths.");
    }
    seen.add(key);
    return {
      path: relative,
      contentBase64: file.bytes.toString("base64"),
      executable: file.executable,
    };
  });
  skillFiles.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { name, files: skillFiles };
}

function hostedServer(name: string, value: unknown, portable: boolean): ImportedMcpServer | string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(name)) {
    return "The dedicated worker needs an MCP server name of at most 64 letters, digits, underscores or hyphens, starting with a letter.";
  }
  const server = asRecord(value);
  if (
    !server ||
    server.type !== (portable ? "streamable-http" : "http") ||
    typeof server.url !== "string"
  ) {
    return "Only hosted Streamable HTTP MCP servers are supported.";
  }
  if (Object.keys(server).some((key) => !["type", "url", "headers"].includes(key))) {
    return "Server uses settings the dedicated worker cannot enforce.";
  }
  const url = URL.parse(server.url);
  if (
    !url ||
    !/^https:\/\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?(?:\/[a-zA-Z0-9/._~-]{0,255})?$/u.test(
      server.url,
    ) ||
    !exactDnsName(url.hostname) ||
    !url.hostname.includes(".") ||
    /(?:^|\.)(?:localhost|localdomain)$/u.test(url.hostname) ||
    (server.url !== url.href && server.url + "/" !== url.href)
  ) {
    return "A fixed HTTPS endpoint without credentials, variables, query or fragment is required.";
  }
  if (server.headers === undefined) {
    return { name, url: url.href };
  }
  const headers = asRecord(server.headers);
  if (!headers) {
    return "Invalid HTTP headers.";
  }
  const keys = Object.keys(headers);
  if (!keys.length) {
    return { name, url: url.href };
  }
  const key = keys[0]!;
  const valueHeader = headers[key];
  const match =
    typeof valueHeader === "string"
      ? /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]{0,252})\}$/iu.exec(valueHeader)
      : null;
  if (
    keys.length !== 1 ||
    key.toLowerCase() !== "authorization" ||
    !match ||
    !isAllowedSecretBindingDestination(match[1]!)
  ) {
    return "Only an Authorization bearer placeholder bound through OCE is supported.";
  }
  return { name, url: url.href, bearerEnv: match[1]! };
}

function inspectContents(files: Files, marketplaceEntry?: string) {
  const base = schemaRoot(files);
  const { root, entry } = selectedEntry(files, base, marketplaceEntry);
  const portable = files.has(root + "plugin.json");
  const claude = files.has(root + ".claude-plugin/plugin.json");
  if (portable && claude) {
    invalid("Package has both portable and Claude manifests. Supply one unambiguous package.");
  }
  const manifest = portable
    ? json(files, root + "plugin.json")
    : claude
      ? json(files, root + ".claude-plugin/plugin.json")
      : (entry ?? {});
  if (portable && manifest.$schema !== schema + "plugin.schema.json") {
    invalid("Unsupported Agent Plugins manifest schema.");
  }
  if (claude && entry?.strict === false && paths.some((field) => field in entry)) {
    invalid(
      "The Claude marketplace entry conflicts with the package manifest under strict: false.",
    );
  }
  const name = manifest.name ?? entry?.name ?? posix.basename(root);
  if (
    typeof name !== "string" ||
    !packageName.test(name) ||
    name.includes("--") ||
    name.includes("..")
  ) {
    invalid("Invalid or missing plugin name.");
  }
  const version = manifest.version ?? entry?.version;
  const description = manifest.description ?? entry?.description;
  if (
    (version !== undefined && (typeof version !== "string" || version.length > 256)) ||
    (description !== undefined && (typeof description !== "string" || description.length > 4096))
  ) {
    invalid("Invalid plugin version or description.");
  }
  const omissions = new Map<string, Omission>();
  const omit = (
    component: string,
    reason = "This component does not run on the dedicated OpenClaw worker.",
  ) => {
    omissions.set(component, { component, reason });
  };
  const declaredRoots = portable
    ? []
    : [...list(manifest.skills), ...(claude ? list(entry?.skills) : [])];
  const rootIsSelection = entry && root === base && list(entry.skills).length > 0 && !portable;
  const roots = rootIsSelection ? [] : ["skills"];
  let rootSkill =
    !portable &&
    !rootIsSelection &&
    !declaredRoots.length &&
    ![...files.keys()].some((path) => path.startsWith(root + "skills/")) &&
    files.has(root + "SKILL.md");
  for (const value of declaredRoots) {
    if (value === "." || value === "./") {
      if (files.has(root + "SKILL.md")) {
        rootSkill = true;
      } else {
        roots.push("");
      }
      continue;
    }
    if (typeof value !== "string" || !value.startsWith("./")) {
      invalid("Claude skill roots must be package-relative directories.");
    }
    const dir = safePath(value);
    if (![...files.keys()].some((path) => path.startsWith(root + dir + "/"))) {
      invalid("A declared skill directory is unavailable in this package.");
    }
    roots.push(dir);
  }
  const skills: ImportedPluginSkill[] = [];
  if (rootSkill) {
    // A root skill can carry arbitrary supporting files, but sibling plugin components have separate semantics.
    const components = new Set([
      ".claude-plugin",
      ".mcp.json",
      ".lsp.json",
      "skills",
      "hooks",
      "commands",
      "agents",
      "bin",
      "themes",
      "output-styles",
      "monitors",
      "channels",
      "workflows",
      "settings.json",
      "openclaw.plugin.json",
      "package.json",
      "marketplace.json",
    ]);
    const skillFiles = new Map(
      [...files].filter(
        ([path]) =>
          path.startsWith(root) && !components.has(path.slice(root.length).split("/")[0]!),
      ),
    );
    skills.push(readSkill(skillFiles, root, false, name));
  }
  for (const dir of skillDirs(files, root, roots, portable)) {
    const skill = readSkill(files, dir, portable);
    if (skills.some((item) => item.name === skill.name)) {
      invalid("Package includes two skills with the same effective name.");
    }
    skills.push(skill);
  }
  const servers = new Map<string, unknown>();
  function addDescriptor(descriptor: unknown) {
    const map = asRecord(descriptor);
    if (!map) {
      invalid("An MCP declaration must be a map of server names.");
    }
    for (const [key, value] of Object.entries(map)) {
      if (!identifier.test(key)) {
        invalid("Invalid MCP server name.");
      }
      servers.set(key, value);
    }
  }
  if (portable && files.has(root + "mcp.json")) {
    const mcp = json(files, root + "mcp.json");
    if (
      mcp.$schema !== schema + "mcp.schema.json" ||
      !asRecord(mcp.mcpServers) ||
      Object.keys(mcp).some((k) => !["$schema", "mcpServers"].includes(k))
    ) {
      omit("mcp.json", "Unsupported Agent Plugins MCP descriptor.");
    } else {
      addDescriptor(mcp.mcpServers);
    }
  }
  if (!portable) {
    const defaults = files.has(root + ".mcp.json") ? ["./.mcp.json"] : [];
    for (const source of [...defaults, ...list(manifest.mcpServers)]) {
      if (typeof source !== "string") {
        addDescriptor(source);
      } else if (source.startsWith("./") && source.endsWith(".json")) {
        const descriptor = json(files, root + safePath(source));
        addDescriptor(descriptor.mcpServers ?? descriptor);
      } else {
        omit(
          "mcpServers",
          "Only in-package JSON descriptors and inline server maps are supported.",
        );
      }
    }
  }
  const mcpServers: ImportedMcpServer[] = [];
  for (const [key, value] of [...servers].sort(([a], [b]) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    const hosted = hostedServer(key, value, portable);
    if (typeof hosted === "string") {
      omit("mcp:" + key, hosted);
    } else {
      mcpServers.push(hosted);
    }
  }
  const defaults: Record<string, string> = {
    executables: "bin/",
    commands: "commands/",
    agents: "agents/",
    hooks: "hooks/hooks.json",
    lspServers: ".lsp.json",
    outputStyles: "output-styles/",
    themes: "themes/",
    settings: "settings.json",
    workflows: "workflows/",
    monitors: "monitors/",
    channels: "channels/",
    nativeExtension: "openclaw.plugin.json",
  };
  for (const [field, location] of Object.entries(defaults)) {
    if (
      Object.hasOwn(manifest, field) ||
      (entry && paths.some((p) => p === field && p in entry)) ||
      [...files.keys()].some((path) =>
        location.endsWith("/") ? path.startsWith(root + location) : path === root + location,
      )
    ) {
      omit(field);
    }
  }
  for (const key of ["experimental", "userConfig", "dependencies", "extensions"]) {
    if (Object.hasOwn(manifest, key)) {
      omit(key);
    }
  }
  if (files.has(root + "package.json") && asRecord(json(files, root + "package.json").scripts)) {
    omit("package scripts", "Package scripts are never run during import.");
  }
  const result: Omit<InspectedPluginPackage, "archiveSha256" | "digest"> = {
    format: portable ? "agent-plugins" : "claude",
    name,
    ...(typeof version === "string" ? { version } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(marketplaceEntry ? { marketplaceEntry } : {}),
    skills,
    mcpServers,
    unsupported: [...omissions.values()],
  };
  return result;
}

export async function inspectPluginPackage(
  archive: Uint8Array,
  marketplaceEntry?: string,
): Promise<InspectedPluginPackage> {
  try {
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    const result = inspectContents(await readArchive(archive), marketplaceEntry);
    return {
      ...result,
      archiveSha256,
      digest: createHash("sha256").update(canonicalPluginPackageContent(result)).digest("hex"),
    };
  } catch (error) {
    if (error instanceof PluginPackageInspectionError) {
      throw error;
    }
    throw new PluginPackageInspectionError(
      "Could not read the tar package, its UTF-8 metadata or its bounded skill resources.",
    );
  }
}
