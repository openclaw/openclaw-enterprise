import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";

const imageRoles = ["gateway", "sandbox", "supervisor"] as const;
type ImageRole = (typeof imageRoles)[number];
type OpenShellImages = Record<ImageRole, string>;
type CandidateEnvironment = Readonly<Record<string, string | undefined>>;
type ExecuteFile = (command: string, args: string[]) => Promise<{ stdout: string }>;

interface OpenShellCandidate {
  sourceRevision: string;
  gatewayChart: string;
  workspaceChart: string;
  images: OpenShellImages;
}

interface CandidateCommands {
  execFile: ExecuteFile;
  docker: string;
  helm: string;
  snapshotParent?: string;
}

type GitMode = "040000" | "100644" | "100755";
type GitTreeMatch = RegExpMatchArray & [string, GitMode, "tree" | "blob", string, string];

interface GitTreeEntry {
  mode: GitMode;
  oid: string;
}
const prefix = "OCC_TEST_OPENSHELL_";
const digest = (image: string | undefined): string | undefined =>
  image?.match(/@sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
const nonempty = (value: string | undefined): value is string =>
  typeof value === "string" && value.length > 0;

export function selectOpenShellCandidate(
  env: CandidateEnvironment,
  releasedImages: Readonly<OpenShellImages>,
): OpenShellCandidate | null {
  const sourceRevision = env[`${prefix}SOURCE_REVISION`];
  const gatewayChart = env[`${prefix}HELM_CHART`];
  const workspaceChart = env[`${prefix}WORKSPACE_HELM_CHART`];
  const images = Object.fromEntries(
    imageRoles.map((role) => [role, env[`${prefix}${role.toUpperCase()}_IMAGE`]]),
  ) as Record<ImageRole, string | undefined>;
  const selected =
    [sourceRevision, gatewayChart, workspaceChart].some(nonempty) ||
    imageRoles.some(
      (role) => nonempty(images[role]) && digest(images[role]) !== digest(releasedImages[role]),
    );
  if (!selected) {
    return null;
  }
  if (![sourceRevision, gatewayChart, workspaceChart, ...Object.values(images)].every(nonempty)) {
    throw new Error(
      "OpenShell candidate selection requires a source revision, all three images, and both Helm charts.",
    );
  }
  // Every field above, including the three fixed image roles, is now a nonempty string.
  const candidate = { sourceRevision, gatewayChart, workspaceChart, images } as OpenShellCandidate;
  if (!/^[a-f0-9]{40}$/.test(candidate.sourceRevision)) {
    throw new Error("OpenShell candidate source revision must be a full lowercase Git commit.");
  }
  for (const chart of [candidate.gatewayChart, candidate.workspaceChart]) {
    if (!isAbsolute(chart) || resolve(chart) !== chart) {
      throw new Error(
        "OpenShell candidate Helm charts must use absolute canonical directory paths.",
      );
    }
  }
  return candidate;
}

async function readCommand(
  execFile: ExecuteFile,
  command: string,
  args: string[],
  message: string,
): Promise<string> {
  try {
    const { stdout } = await execFile(command, args);
    return stdout;
  } catch {
    // Command errors can carry arbitrary output from the selected checkout or image.
    throw new Error(message);
  }
}

async function verifyChart(
  execFile: ExecuteFile,
  root: string,
  revision: string,
  chartPath: string,
  relativePath: string,
  snapshotPath: string,
): Promise<void> {
  const output = await readCommand(
    execFile,
    "git",
    [
      "--no-replace-objects",
      "-C",
      root,
      "ls-tree",
      "-r",
      "-t",
      "-z",
      `${revision}:${relativePath}`,
    ],
    "OpenShell candidate chart tree could not be read from the selected commit.",
  );
  const expected = new Map<string, GitTreeEntry>();
  if (!output.endsWith("\0")) {
    throw new Error("OpenShell candidate chart is absent from the selected commit.");
  }
  for (const record of output.slice(0, -1).split("\0")) {
    const entry = record.match(
      /^(040000|100644|100755) (tree|blob) ([a-f0-9]{40})\t([\s\S]+)$/,
    ) as GitTreeMatch | null;
    if (
      !entry ||
      (entry[1] === "040000") !== (entry[2] === "tree") ||
      posix.normalize(entry[4]) !== entry[4] ||
      entry[4].startsWith("../") ||
      posix.isAbsolute(entry[4]) ||
      expected.has(entry[4])
    ) {
      throw new Error("OpenShell candidate chart contains an unsupported Git tree entry.");
    }
    expected.set(entry[4], { mode: entry[1], oid: entry[3] });
  }
  const chartMode = expected.get("Chart.yaml")?.mode;
  if (chartMode !== "100644" && chartMode !== "100755") {
    throw new Error("OpenShell candidate chart must contain a committed Chart.yaml.");
  }

  // Compare physical files, including ignored extras and executable bits. Git status
  // alone can omit files that Helm reads or tracked files marked assume-unchanged.
  await mkdir(snapshotPath, { mode: 0o700 });
  const visit = async (directory: string, relative: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const key = relative ? `${relative}/${name}` : name;
      const entry = expected.get(key);
      if (!entry) {
        throw new Error("OpenShell candidate chart contains files outside the selected commit.");
      }
      expected.delete(key);
      const destination = join(snapshotPath, key);
      if (entry.mode === "040000") {
        if (!(await lstat(path)).isDirectory()) {
          throw new Error("OpenShell candidate chart contains a symlink or unsupported file type.");
        }
        await mkdir(destination, { mode: 0o700 });
        await visit(path, key);
        continue;
      }

      // Check the opened file and hash that same handle. Do not follow a symlink
      // or block on a special file substituted for the committed regular file.
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile()) {
          throw new Error("OpenShell candidate chart contains an unsupported file type.");
        }
        const content = await file.readFile();
        const oid = createHash("sha1")
          .update(`blob ${content.length}\0`)
          .update(content)
          .digest("hex");
        if (oid !== entry.oid || ((info.mode & 0o100) !== 0) !== (entry.mode === "100755")) {
          throw new Error("OpenShell candidate chart files differ from the selected commit.");
        }
        // Publish the checked buffer into the private snapshot without reopening the source.
        const mode = entry.mode === "100755" ? 0o700 : 0o600;
        await writeFile(destination, content, { flag: "wx", mode });
        await chmod(destination, mode);
      } finally {
        await file.close();
      }
    }
  };
  await visit(chartPath, "");
  if (expected.size !== 0) {
    throw new Error("OpenShell candidate chart is missing files from the selected commit.");
  }
}

export async function verifyOpenShellCandidate(
  candidate: OpenShellCandidate,
  { execFile, docker, helm, snapshotParent }: CandidateCommands,
): Promise<(OpenShellCandidate & { gatewayAppVersion: string }) | null> {
  const { sourceRevision, gatewayChart, workspaceChart, images } = candidate;
  const root = dirname(dirname(dirname(gatewayChart)));
  try {
    for (const [path, name] of [
      [gatewayChart, "openshell"],
      [workspaceChart, "openshell-workspace"],
    ] as const) {
      if (
        path !== join(root, "deploy", "helm", name) ||
        (await realpath(path)) !== path ||
        !(await lstat(path)).isDirectory()
      ) {
        throw new Error("invalid chart directory");
      }
    }
  } catch {
    throw new Error(
      "OpenShell candidate charts must be physical deploy/helm directories in the same checkout.",
    );
  }
  const gitRoot = await readCommand(
    execFile,
    "git",
    ["--no-replace-objects", "-C", root, "rev-parse", "--show-toplevel"],
    "OpenShell candidate chart checkout could not be read.",
  );
  const head = await readCommand(
    execFile,
    "git",
    ["--no-replace-objects", "-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
    "OpenShell candidate chart revision could not be read.",
  );
  if (gitRoot.trim() !== root || head.trim() !== sourceRevision) {
    throw new Error(
      "OpenShell candidate chart checkout does not match the selected source revision.",
    );
  }
  const snapshot = await mkdtemp(join(snapshotParent ?? tmpdir(), "openshell-candidate-charts-"));
  const preparedGateway = join(snapshot, "openshell");
  const preparedWorkspace = join(snapshot, "openshell-workspace");
  let retainSnapshot = false;
  try {
    for (const [path, name, preparedPath] of [
      [gatewayChart, "openshell", preparedGateway],
      [workspaceChart, "openshell-workspace", preparedWorkspace],
    ] as const) {
      try {
        await verifyChart(
          execFile,
          root,
          sourceRevision,
          path,
          `deploy/helm/${name}`,
          preparedPath,
        );
      } catch {
        throw new Error(
          "OpenShell candidate chart contents do not match the selected source revision.",
        );
      }
    }
    // OCI labels establish consistency with the selected source, not independent
    // build provenance. Candidate images must already exist in the local engine.
    for (const role of imageRoles) {
      const revision = await readCommand(
        execFile,
        docker,
        [
          "image",
          "inspect",
          "--format",
          '{{ index .Config.Labels "org.opencontainers.image.revision" }}',
          images[role],
        ],
        "OpenShell candidate images must exist locally and expose their source revision.",
      );
      if (revision.trim() !== sourceRevision) {
        throw new Error(
          "OpenShell candidate image revision does not match the selected source revision.",
        );
      }
    }
    const metadata = await readCommand(
      execFile,
      helm,
      ["show", "chart", preparedGateway],
      "OpenShell candidate gateway chart metadata could not be read.",
    );
    // Helm reads the chart's YAML and prints normalized metadata. The gateway
    // chart uses appVersion as a Kubernetes label, so require a usable label value.
    const gatewayAppVersion = metadata.match(
      /^appVersion: (["']?)([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?)\1$/mu,
    )?.[2];
    if (!gatewayAppVersion) {
      throw new Error("OpenShell candidate gateway chart must set a label-safe appVersion.");
    }
    // The pre-state caller validates the inputs without keeping any prepared files.
    if (snapshotParent === undefined) {
      return null;
    }
    retainSnapshot = true;
    return {
      ...candidate,
      gatewayChart: preparedGateway,
      workspaceChart: preparedWorkspace,
      gatewayAppVersion,
    };
  } finally {
    if (!retainSnapshot) {
      await rm(snapshot, { recursive: true, force: true });
    }
  }
}
