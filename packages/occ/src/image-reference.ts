// Kubernetes parses every container image with distribution/reference's ParseNormalizedNamed
// (v0.6.0) and the digest with go-digest (v1.0.0). A reference either refuses is an
// InvalidImageName at pull time, so profile preflight, Compute and the image tools check this
// port when the reference is written. The chart applies the same steps in
// deploy/helm/openclaw-enterprise/templates/_helpers.tpl ("openclaw.validateImageReference").

const alphanumeric = "[a-z0-9]+";
// One period, one or two underscores, or any number of hyphens.
const separator = "(?:[._]|__|[-]+)";
const pathComponent = `${alphanumeric}(?:${separator}${alphanumeric})*`;
const remoteName = `${pathComponent}(?:/${pathComponent})*`;
const domainNameComponent = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])";
// A DNS-like name or a bracketed IPv6 address without a zone ID, and an optional port.
const domainAndPort = `(?:${domainNameComponent}(?:\\.${domainNameComponent})*|\\[[a-fA-F0-9:]+\\])(?::[0-9]+)?`;
const tag = "[\\w][\\w.-]{0,127}";
const digest = "[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9A-Fa-f]{32,}";
const reference = new RegExp(
  `^((?:${domainAndPort}/)?${remoteName})(?::${tag})?(?:@(${digest}))?$`,
);
const leadingDomain = new RegExp(`^${domainAndPort}/`);
// go-digest accepts only the algorithms it links, each with its own lowercase hex length.
const supportedDigest = /^(?:sha256:[a-f0-9]{64}|sha384:[a-f0-9]{96}|sha512:[a-f0-9]{128})$/;
const maximumPathLength = 255;

/** Why Kubernetes refuses an image reference; `uppercase-repository` gets its own message. */
export type ImageReferenceProblem = "uppercase-repository" | "invalid";

/**
 * Returns why Kubernetes would refuse `image` as a container image reference, or undefined
 * when it accepts it. Callers add their own rules, such as requiring a SHA-256 digest.
 */
export function imageReferenceProblem(image: string): ImageReferenceProblem | undefined {
  if (/^[a-f0-9]{64}$/.test(image)) {
    return "invalid";
  }
  const { domain, remainder } = splitDockerDomain(image);
  const tagSeparator = remainder.indexOf(":");
  const remote = tagSeparator === -1 ? remainder : remainder.slice(0, tagSeparator);
  if (remote.toLowerCase() !== remote) {
    return "uppercase-repository";
  }
  const match = reference.exec(`${domain}/${remainder}`);
  if (match === null) {
    return "invalid";
  }
  const [, name = "", digestValue] = match;
  if (digestValue !== undefined && !supportedDigest.test(digestValue)) {
    return "invalid";
  }
  // The length limit applies to the repository path, without the registry host.
  if (name.replace(leadingDomain, "").length > maximumPathLength) {
    return "invalid";
  }
  return undefined;
}

// The first component names a registry only when it is localhost or contains a dot, a colon
// or an uppercase letter; otherwise the image is on Docker Hub, under library/ when it has
// one component.
function splitDockerDomain(image: string): { domain: string; remainder: string } {
  const slash = image.indexOf("/");
  if (slash === -1) {
    return { domain: "docker.io", remainder: `library/${image}` };
  }
  const first = image.slice(0, slash);
  let domain = "docker.io";
  let remainder = image;
  if (first === "localhost" || /[.:]/.test(first) || first.toLowerCase() !== first) {
    domain = first === "index.docker.io" ? "docker.io" : first;
    remainder = image.slice(slash + 1);
  }
  if (domain === "docker.io" && !remainder.includes("/")) {
    remainder = `library/${remainder}`;
  }
  return { domain, remainder };
}
