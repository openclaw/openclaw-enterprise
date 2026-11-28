import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename, posix } from "node:path";
import { parseArgs } from "node:util";
import type { V1PersistentVolumeClaim, V1Pod } from "@kubernetes/client-node";

const workspace = "/home/node/workspace";
const editableFiles = new Set(["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]);
const preserveGateway = "Keep the original Gateway running and leave workspace writes paused.";
const hashWorkspace = `
set -eu
export LC_ALL=C
workspace=${workspace}
[[ $(realpath -e -- "$workspace") == "$workspace" ]]

# A mount table can still list a PVC hidden by a mount over its parent.
# Match the directory and the files we actually open to that mount ID.
mount=
while read -r id parent device root mountpoint rest; do
  case "$mountpoint" in
    "$workspace")
      [[ -z "$mount" && "$id" =~ ^[0-9]+$ && " $rest" == *" - "* ]]
      read -r fs source options <<< "\${rest#*- }"
      [[ -n "$options" && "$fs" != tmpfs && "$fs" != ramfs ]]
      mount=$id
      ;;
    "$workspace/"*) exit 1 ;;
  esac
done < /proc/self/mountinfo
[[ -n "$mount" ]]

on_workspace_mount() {
  local key value
  while read -r key value; do
    if [[ "$key" == mnt_id: ]]; then
      [[ "$value" == "$mount" ]] || return 1
      return 0
    fi
  done < "/proc/self/fdinfo/$1"
  return 1
}

cd -- "$workspace"
exec {directory}<.
on_workspace_mount "$directory"
for name in "$@"; do
  case "$name" in AGENTS.md|SOUL.md|IDENTITY.md|USER.md) ;; *) exit 1 ;; esac
  [[ ! -L "$name" && -f "$name" ]]
  exec {file}<"$name"
  on_workspace_mount "$file"
  hash=$(sha256sum <&"$file")
  exec {file}<&-
  printf '%s\\n' "\${hash%% *}"
done
`;

// Only errors constructed with fixed messages can reach the operator.
class ComparisonUnavailable extends Error {}

function localHash(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    // One workspace PUT accepts at most 16 KiB of UTF-8.
    if (!before.isFile() || before.size > 16_384n) {
      throw new Error("Invalid submitted file");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let read = 0;
    while (read < buffer.length) {
      const length = readSync(fd, buffer, read, buffer.length - read, null);
      if (length === 0) {
        break;
      }
      read += length;
    }
    if (BigInt(read) !== before.size) {
      throw new Error("Unexpected local file size");
    }
    hash.update(buffer.subarray(0, read));
    const after = fstatSync(fd, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Local file changed during the read");
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function compare(argv: string[]): boolean {
  const separator = argv.indexOf("--");
  if (separator < 0) {
    throw new Error("Expected file arguments after --");
  }
  const { values, tokens } = parseArgs({
    args: argv.slice(0, separator),
    options: {
      kubeconfig: { type: "string" },
      context: { type: "string" },
      namespace: { type: "string" },
      agent: { type: "string" },
      revision: { type: "string" },
      pod: { type: "string" },
      "claim-uid": { type: "string" },
    },
    tokens: true,
  });
  const { kubeconfig, context, namespace, agent, revision, pod, "claim-uid": claimUid } = values;
  const resourceName = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
  if (
    tokens.length !== 7 ||
    !kubeconfig ||
    !context ||
    !namespace ||
    !agent ||
    !revision ||
    !pod ||
    !claimUid ||
    kubeconfig.startsWith("-") ||
    context.startsWith("-") ||
    !resourceName.test(namespace) ||
    !resourceName.test(pod)
  ) {
    throw new Error("Expected an explicit target");
  }
  const paths = argv.slice(separator + 1);
  const names = paths.map((path) => basename(path));
  if (
    names.length === 0 ||
    new Set(names).size !== names.length ||
    names.some((name) => !editableFiles.has(name))
  ) {
    throw new Error("Expected distinct editable filenames");
  }

  const expected = paths.map(localHash);
  const target = ["--kubeconfig", kubeconfig, "--context", context, "--namespace", namespace];
  const podRead = ["get", "pod", pod, "-o", "json"];
  function kubectl(...args: string[]): string {
    const result = spawnSync("kubectl", [...target, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL",
      env: { ...process.env, KUBERC: "off", KUBECTL_KUBERC: "false" },
    });
    if (result.error || result.status !== 0) {
      throw new ComparisonUnavailable(
        args[0] === "exec"
          ? "Check workspace file readability and Pod exec access."
          : "Check the selected Kubernetes target and read access.",
      );
    }
    return result.stdout;
  }

  function readPod() {
    const object = JSON.parse(kubectl(...podRead)) as V1Pod;
    const metadata = object.metadata;
    const container = object.spec?.containers?.find(({ name }) => name === "agent");
    const mounts = container?.volumeMounts ?? [];
    const mount = mounts.find(({ mountPath }) => mountPath === workspace);
    const conflictingMount = mounts.some(({ mountPath }) => {
      const resolved = posix.resolve(mountPath);
      return (
        mountPath !== workspace && (resolved === workspace || resolved.startsWith(`${workspace}/`))
      );
    });
    const volume = object.spec?.volumes?.find(({ name }) => name === mount?.name);
    const status = object.status?.containerStatuses?.find(({ name }) => name === "agent");
    const claim = volume?.persistentVolumeClaim?.claimName;
    if (
      object.kind !== "Pod" ||
      !metadata ||
      metadata.name !== pod ||
      metadata.namespace !== namespace ||
      !metadata.uid ||
      metadata.deletionTimestamp != null ||
      metadata.labels?.["openclaw.dev/agent"] !== agent ||
      metadata.labels?.["openclaw.dev/revision"] !== revision ||
      metadata.labels?.["openclaw.dev/workload-role"] !== "agent" ||
      object.status?.phase !== "Running" ||
      !object.status.conditions?.some(
        ({ type, status }) => type === "Ready" && status === "True",
      ) ||
      status?.ready !== true ||
      !status.containerID ||
      !Number.isSafeInteger(status.restartCount) ||
      status.restartCount < 0 ||
      mount?.subPath !== "workspace" ||
      mount.subPathExpr !== undefined ||
      conflictingMount ||
      !claim ||
      !resourceName.test(claim)
    ) {
      throw new ComparisonUnavailable(
        "The Pod does not match the required identity or workspace mount.",
      );
    }
    return {
      uid: metadata.uid,
      containerId: status.containerID,
      restartCount: status.restartCount,
      volume: mount.name,
      claim,
    };
  }

  function readClaim(name: string) {
    const object = JSON.parse(kubectl("get", "pvc", name, "-o", "json")) as V1PersistentVolumeClaim;
    const metadata = object.metadata;
    const volume = object.spec?.volumeName;
    if (
      object.kind !== "PersistentVolumeClaim" ||
      metadata?.name !== name ||
      metadata.namespace !== namespace ||
      metadata.uid !== claimUid ||
      metadata.deletionTimestamp != null ||
      object.status?.phase !== "Bound" ||
      !volume
    ) {
      throw new ComparisonUnavailable("The claim does not match the required bound claim.");
    }
    return volume;
  }

  const before = readPod();
  const volume = readClaim(before.claim);
  const hashes = kubectl(
    "exec",
    pod,
    "--container",
    "agent",
    "--",
    "bash",
    "-p",
    "-c",
    hashWorkspace,
    "verify-upgrade-workspace",
    ...names,
  ).split("\n");
  const afterVolume = readClaim(before.claim);
  const after = readPod();
  if (afterVolume !== volume || JSON.stringify(after) !== JSON.stringify(before)) {
    throw new ComparisonUnavailable("The Pod or claim binding changed during the read.");
  }
  if (
    hashes.pop() !== "" ||
    hashes.length !== expected.length ||
    hashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))
  ) {
    throw new ComparisonUnavailable("The workspace read returned incomplete results.");
  }
  return expected.every((hash, index) => hash === hashes[index]);
}

const help = `Compare submitted edits before replacing a dedicated Codex Gateway.

Pause all workspace writers. Keep independent copies of the latest submissions
in a trusted directory, preserving their original names and exact contents.
Use the reviewed Agent inventory to identify the active Agent revision and
its exact ready Harness Pod. Match its workspace claim to the namespace, name
and UID in the pre-upgrade PVC inventory (pvcs.txt). Stop if unsure.

From the repository root, use the supported Node.js version. This example
checks two files. Supply all edited files among AGENTS.md, SOUL.md, IDENTITY.md
and USER.md. Protect other edits separately before replacing the Gateway.

  set +x
  copies="/secure/occ/submissions/$AGENT_ID"
  node scripts/verify-upgrade-workspace.ts \\
    --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \\
    --namespace "$TENANT_NAMESPACE" --agent "$AGENT_ID" \\
    --revision "$AGENT_REVISION" --pod "$HARNESS_POD" \\
    --claim-uid "$WORKSPACE_CLAIM_UID" \\
    -- "$copies/AGENTS.md" "$copies/SOUL.md"

Use a trusted kubeconfig, client and Harness. The command needs existing
permission to get the Pod and its persistent volume claim and to execute
commands in the Pod. It runs Bash with realpath, sha256sum and Linux /proc.
Only the selected filenames go to the Pod alongside the fixed command.
It compares the returned hashes locally.

Exit 0 means the supplied files match. Exit 1 means different contents.
Exit 2 means the comparison could not be verified. On any failure, missing
copy or missing Pod, stop the upgrade. Keep writes paused and preserve the
original Gateway if present until an authorized operator reconciles the edits.
The upgrade does not run this check automatically.`;

try {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(help);
  } else if (compare(process.argv.slice(2))) {
    console.log("The selected workspace files match the supplied copies.");
  } else {
    console.error(`Workspace files differ. ${preserveGateway}`);
    process.exitCode = 1;
  }
} catch (error) {
  const reason =
    error instanceof ComparisonUnavailable
      ? error.message
      : "Check the arguments and local copies.";
  console.error(`Unable to compare workspace files. ${reason} ${preserveGateway}`);
  process.exitCode = 2;
}
