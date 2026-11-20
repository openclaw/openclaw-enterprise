import fs from "node:fs";
import path from "node:path";
import {
  createDocsMarkdown,
  parseDocsDocument,
  parseFrontmatter,
  resolveDocsFragment,
} from "./docs-site/vendor/docs-markdown.mjs";
import { createGithubAnchorReader } from "./docs-site/github-anchors.ts";

const root = process.cwd();
const specs = path.join(root, "specs");
const rfcs = path.join(specs, "rfcs");
const md = createDocsMarkdown();
const githubAnchors = createGithubAnchorReader(md);
const statuses = new Set(["Proposed", "Accepted", "Rejected", "Superseded", "Unspecified"]);
const implementationStatuses = new Set(["Not implemented", "Partially implemented", "Implemented"]);
const errors = [];
let links = 0;
let historicalLinks = 0;

// These three external artifacts belong to the preserved September 2026 audit.
// They are not repository files and cannot be verified from a checkout.
const historicalArtifacts = new Set([
  "/private/tmp/enterprise-audit-a1hg863_/docker-token-retry-diagnostic.mjs",
  "/private/tmp/enterprise-audit-a1hg863_/docker-token-retry-result.json",
  "/private/tmp/enterprise-audit-a1hg863_/docker-token-retry-stdout.log",
]);

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === ".archive" ? [] : markdownFiles(file);
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [file] : [];
  });
}

const rfcEntries = new Set(
  fs.readdirSync(rfcs, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return [path.join(rfcs, entry.name, "index.md")];
    }
    return entry.name.endsWith(".md") ? [path.join(rfcs, entry.name)] : [];
  }),
);
// Published numeric names remain stable. New RFCs use a date and title.
const historicalRfcNames = new Set([
  "0001-oidc-sign-in",
  "0002-agent-workload-tags",
  "0003-gateway-harness-storage-split",
  "0004-occ-prometheus-metrics",
  "0005-harness-auth-binding",
  "0006-basic-rbac",
  "0007-human-federated-sign-in",
  "0008-repository-credentials",
  "0009-native-plugin-tool-policy",
  "0010-agent-access",
  "0011-coordinated-image-upgrade",
  "0012-production-observability",
  "0013-platform-audit",
  "0014-plugin-policy-enforcement",
  "0015-repository-credential-recovery",
  "0016-sandbox-credential-injection",
  "0017-agent-egress-0x",
  "0018-installation-profiles-design",
  "0019-keycloak-oidc-verification",
  "0020-anonymous-public-github-reads",
  "0021-managed-runtime-mode",
  "0022-driver-configuration-contributions",
  "0023-egress-proxy-credential-lifecycle",
  "0024-sandbox-harness-mode-support",
  "0025-installation-driver-values",
  "0026-codex-standalone-web-search",
  "0027-agent-oauth-connections",
  "0028-shared-model-provider",
  "0029-multiple-plugin-drivers",
  "0030-agent-harness-overrides",
  "0031-oidc-agent-chat",
  "0032-oidc-account-enrollment",
  "0033-repository-worker-restart-preflight",
  "0034-reusable-model-providers",
  "0035-namespace-driver-lifecycle",
  "0036-bounded-planned-replacement",
  "0037-oidc-enrollment-claims",
  "0038-operator-scratch-volumes",
  "0039-event-contract-ownership",
  "0040-agent-chat-completions",
  "0041-runtimeclass-agnostic-deployment",
  "0042-redeployment-continuation",
  "0043-native-restart-recovery",
]);
const rfcNames = new Set();
for (const file of rfcEntries) {
  const name =
    path.basename(file) === "index.md"
      ? path.basename(path.dirname(file))
      : path.basename(file, ".md");
  if (!historicalRfcNames.has(name)) {
    const date = name.match(/^(\d{4})(\d{2})(\d{2})-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    const isoDate = date ? `${date[1]}-${date[2]}-${date[3]}` : "";
    const timestamp = Date.parse(`${isoDate}T00:00:00Z`);
    if (
      !date ||
      date[1] === "0000" ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== isoDate
    ) {
      errors.push(
        `${path.relative(root, file)}: RFC requires yyyymmdd-title with a valid calendar date and lowercase kebab-case title`,
      );
    }
  }
  if (rfcNames.has(name)) {
    errors.push(`${path.relative(root, file)}: duplicate RFC name ${name}`);
  }
  rfcNames.add(name);
  if (!fs.existsSync(file)) {
    errors.push(`${path.relative(root, file)}: missing RFC entry point`);
  }
}

function localTarget(file, href) {
  const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]);
  const target = pathname
    ? path.resolve(
        pathname.startsWith("/") ? root : path.dirname(file),
        pathname.replace(/^\//, ""),
      )
    : file;
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`link escapes repository: ${href}`);
  }
  if (!fs.existsSync(target)) {
    throw new Error(`missing local link target: ${href}`);
  }
  return target;
}

const files = markdownFiles(specs);
for (const file of files) {
  const source = path.relative(root, file);
  try {
    const text = fs.readFileSync(file, "utf8");
    const { data, content } = parseFrontmatter(text);
    if (/^---\s*\n/.test(text) && content === text) {
      throw new Error("unclosed YAML frontmatter");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("frontmatter must be a YAML mapping");
    }
    if (rfcEntries.has(file)) {
      if (
        typeof data.author !== "string" ||
        !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(data.author) ||
        data.author.includes("--") ||
        data.author === "github-login"
      ) {
        throw new Error("RFC requires an author GitHub login in frontmatter (without @)");
      }
      if (!implementationStatuses.has(data.implementation_status)) {
        throw new Error("RFC requires a valid implementation_status in frontmatter");
      }
      if (!statuses.has(data.status)) {
        throw new Error("RFC requires a valid status in frontmatter");
      }
      if (
        data.status === "Unspecified" &&
        !(typeof data.status_note === "string" && data.status_note.trim())
      ) {
        throw new Error("Unspecified status requires a status_note");
      }
    } else if (file.startsWith(rfcs + path.sep) && data.rfc === undefined) {
      throw new Error("RFC companion requires an rfc frontmatter link");
    }
    if (data.rfc !== undefined) {
      if (
        typeof data.rfc !== "string" ||
        !data.rfc.trim() ||
        /^(?:[a-z][a-z0-9+.-]*:|\/)|[?#]/i.test(data.rfc)
      ) {
        throw new Error("rfc must be a relative path to an RFC entry point");
      }
      if (!rfcEntries.has(localTarget(file, data.rfc))) {
        throw new Error(`rfc does not target an RFC entry point: ${data.rfc}`);
      }
    }
    const parsed = parseDocsDocument(text, md, { sourceFile: file, root: specs });
    for (const href of parsed.links) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
        continue;
      }
      if (
        source === "specs/plans/2026-09-01-architecture-security-audit/index.md" &&
        historicalArtifacts.has(href)
      ) {
        historicalLinks++;
        continue;
      }
      const target = localTarget(file, href);
      const hash = href.match(/#.*/)?.[0];
      if (hash && target.endsWith(".md") && !resolveDocsFragment(hash, githubAnchors(target))) {
        throw new Error(`missing heading in ${href}`);
      }
      links++;
    }
  } catch (error) {
    errors.push(`${source}: ${error.message}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${files.length} spec documents, ${rfcEntries.size} RFC names, statuses and authors, and ${links} local link targets.`,
  );
}
if (historicalLinks) {
  console.log(`Preserved ${historicalLinks} historical external artifact links (not verified).`);
}
