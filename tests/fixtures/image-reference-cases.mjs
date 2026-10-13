// Image references with Kubernetes' verdict: distribution/reference v0.6.0 ParseNormalizedNamed
// plus go-digest v1.0.0, which the kubelet applies before a pull (InvalidImageName). Rows are
// [label, image, problem]: problem is undefined when Kubernetes accepts the reference,
// "uppercase-repository" when it refuses an uppercase repository name, and "invalid" otherwise.
// Profile preflight, the chart, Compute and the image tools must all agree with it; fields that
// need an immutable image also require a lowercase SHA-256 digest (`immutableImageAccepted`).

const digest = `@sha256:${"a".repeat(64)}`;

export const imageReferenceCases = [
  ["registry host and path", `registry.example.invalid/openclaw-enterprise/controller${digest}`],
  ["IPv6 registry host", `[fd00::1]:5000/repo${digest}`],
  ["IPv6 loopback registry host", `[::1]:5000/img${digest}`],
  ["uppercase IPv6 registry host", `[FD00::1]:5000/repo${digest}`],
  ["IPv6 registry host without a port", `[fd00::1]/repo${digest}`],
  ["IPv4 registry host", `192.0.2.1:5000/repo${digest}`],
  ["localhost registry", `localhost/repo${digest}`],
  ["registry port", `registry.example:5000/repo${digest}`],
  ["uppercase registry host", `Registry.example:5000/repo${digest}`],
  ["uppercase tag", `registry.example:5000/repo:Tag${digest}`],
  ["localhost port and uppercase tag", `localhost:5000/repo:Tag${digest}`],
  ["Docker Hub image", `repo${digest}`],
  ["Docker Hub image with an uppercase tag", `repo:TAG${digest}`],
  ["uppercase first component names a registry host", `Myorg/repo${digest}`],
  ["legacy Docker Hub host", `index.docker.io/repo${digest}`],
  ["tag with uppercase letters", `registry.example/repo:V1.2.3-RC${digest}`],
  ["path double hyphen", `registry.example/re--po${digest}`],
  ["path double underscore", `registry.example/re__po${digest}`],
  // A first component with a dot names a registry; one Kubernetes cannot parse as a host is
  // read as a repository path instead, which these characters allow.
  ["underscore in a dotted first component", `my_reg.io/repo${digest}`],
  ["tag of 128 characters", `registry.example/repo:${"t".repeat(128)}${digest}`],
  // The 255-character limit covers the repository path, not the registry host.
  ["path of 255 characters", `registry.example/${"a".repeat(255)}${digest}`],
  ["Docker Hub path of 255 characters with library/", `${"a".repeat(247)}${digest}`],
  // A dotted first component that does not parse as a host counts toward the path.
  ["unparsable dotted host in a path of 255 characters", `my_reg.io/${"a".repeat(245)}${digest}`],
  ["explicit Docker Hub path of 255 characters", `docker.io/${"a".repeat(247)}${digest}`],
  ["SHA-512 digest", `registry.example/repo@sha512:${"a".repeat(128)}`],
  ["tag without a digest", "registry.example/repo:1.0"],
  ["IPv6 registry host without a digest", "[fd00::1]:5000/repo:1.0"],

  ["uppercase path with an IPv6 host", `[fd00::1]:5000/Repo${digest}`, "uppercase-repository"],
  ["uppercase path after a port", `registry.example:5000/Repo${digest}`, "uppercase-repository"],
  ["uppercase Docker Hub image", `Repo${digest}`, "uppercase-repository"],
  ["uppercase second component", `myorg/Repo${digest}`, "uppercase-repository"],
  ["uppercase deep component", `registry.example/ns/Sub:tag${digest}`, "uppercase-repository"],
  ["uppercase path without a digest", "registry.example/Repo:1.0", "uppercase-repository"],
  ["non-ASCII uppercase path", `registry.example/rÉpo${digest}`, "uppercase-repository"],
  ["Kelvin sign in the path", `registry.example/\u212aepo${digest}`, "uppercase-repository"],
  [
    "uppercase digest algorithm",
    `registry.example/repo@SHA256:${"a".repeat(64)}`,
    "uppercase-repository",
  ],

  ["IPv6 zone ID", `[fd00::1%25eth0]:5000/repo${digest}`, "invalid"],
  ["tag before a path component", `registry.example/ns:Tag/sub${digest}`, "invalid"],
  ["uppercase digest hex", `registry.example/repo@sha256:${"A".repeat(64)}`, "invalid"],
  ["short digest", `registry.example/repo@sha256:${"a".repeat(63)}`, "invalid"],
  ["two digests", `registry.example/repo${digest}${digest}`, "invalid"],
  ["unicode host", `régistry.example/repo${digest}`, "invalid"],
  ["unicode path", `registry.example/répo${digest}`, "invalid"],
  ["unicode tag", `registry.example/repo:tág${digest}`, "invalid"],
  ["zero-width space in the path", `registry.example/re\u200bpo${digest}`, "invalid"],
  ["full-width letter in the path", `registry.example/\uff52epo${digest}`, "invalid"],
  ["no-break space in the path", `registry.example/re\u00a0po${digest}`, "invalid"],
  ["trailing newline", `registry.example/repo${digest}\n`, "invalid"],
  ["leading space", ` registry.example/repo${digest}`, "invalid"],
  ["path double dot", `registry.example/re..po${digest}`, "invalid"],
  ["path leading hyphen", `registry.example/-repo${digest}`, "invalid"],
  ["path trailing underscore", `registry.example/repo_${digest}`, "invalid"],
  ["path triple underscore", `registry.example/re___po${digest}`, "invalid"],
  ["path plus sign", `registry.example/foo+bar${digest}`, "invalid"],
  ["path question mark", `registry.example/controller?tag${digest}`, "invalid"],
  ["IPv6 host after the first component", `registry.example/[fd00::1]/repo${digest}`, "invalid"],
  ["host trailing dot", `registry.example./repo${digest}`, "invalid"],
  ["host leading hyphen", `-registry.example/repo${digest}`, "invalid"],
  ["host leading underscore", `_registry.example/repo${digest}`, "invalid"],
  ["empty path component", `registry.example//repo${digest}`, "invalid"],
  ["tag of 129 characters", `registry.example/repo:${"t".repeat(129)}${digest}`, "invalid"],
  ["tag starting with a dot", `registry.example/repo:.tag${digest}`, "invalid"],
  ["path of 256 characters", `registry.example/${"a".repeat(256)}${digest}`, "invalid"],
  ["Docker Hub path of 256 characters with library/", `${"a".repeat(248)}${digest}`, "invalid"],
  [
    "unparsable dotted host in a path of 256 characters",
    `my_reg.io/${"a".repeat(246)}${digest}`,
    "invalid",
  ],
  [
    "explicit Docker Hub path of 256 characters",
    `docker.io/${"a".repeat(248)}${digest}`,
    "invalid",
  ],
  ["letter in the port", `registry.example:5000A/repo${digest}`, "invalid"],
  ["@ in the path", `registry.example/re@po${digest}`, "invalid"],
  ["second @ before the digest", `registry.example/repo@extra${digest}`, "invalid"],
  ["bare image ID", "a".repeat(64), "invalid"],
];

/** Whether a field that needs an immutable image takes the reference. */
export function immutableImageAccepted(image, problem) {
  return problem === undefined && /@sha256:[a-f0-9]{64}$/.test(image);
}
