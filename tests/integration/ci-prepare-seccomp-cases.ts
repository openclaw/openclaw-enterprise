import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { prepareCodexSeccompProfile } from "../../scripts/lib/codex-seccomp-k3d.ts";
import { fixture, immutableImage } from "../helpers/ci-prepare-fixture.ts";
import { createKubernetesInstallationConfiguration } from "../helpers/kubernetes-real.ts";

type CommandError = Error & {
  stderr: string;
  stdout: string;
  exitCode: number;
  signal: null;
  timedOut: boolean;
};
type ExecFile = NonNullable<
  NonNullable<Parameters<typeof prepareCodexSeccompProfile>[0]>["execFile"]
>;

export function registerSeccompCases() {
  test("Kubernetes test helper passes an explicit Codex localhost seccomp profile into runtime config", () => {
    const profile = "openclaw/codex-bwrap.json";
    const configuration = createKubernetesInstallationConfiguration({
      authentication: { mode: "inCluster" },
      platformNamespace: "openclaw-platform",
      gatewayImage: immutableImage,
      codexImage: immutableImage,
      cluster: "k3d-openclaw-ci",
      codexSeccompProfile: profile,
    });

    assert.equal(configuration.drivers.compute.configuration.runtime.codexSeccompProfile, profile);
  });

  test("codex seccomp preparation fails closed for unverified Codex versions and foreign clusters", async () => {
    const execFile = async () => {
      throw new Error("execFile should not run before validation fails");
    };
    const cluster = {
      name: "openclaw-k8s-test",
      directory: "/tmp/openclaw-k8s-test-abcdef",
      kubeconfig: "/tmp/openclaw-k8s-test-abcdef/kubeconfig",
      context: "k3d-openclaw-k8s-test",
    };

    await assert.rejects(
      () =>
        prepareCodexSeccompProfile({
          cluster,
          image: immutableImage,
          execFile,
          codexVersion: "0.153.0",
        }),
      /reviewed Codex versions: 0\.152\.1, 0\.154\.0, 0\.156\.0, 0\.158\.0/,
    );
    await assert.rejects(
      () =>
        prepareCodexSeccompProfile({
          cluster: { ...cluster, name: "shared-cluster", context: "shared-cluster" },
          image: immutableImage,
          execFile,
        }),
      /run-owned openclaw-k8s k3d cluster/,
    );
    await assert.rejects(
      () =>
        prepareCodexSeccompProfile({
          cluster,
          image: immutableImage,
          profileName: "openclaw\\codex-bwrap.json",
          execFile,
        }),
      /POSIX path separators/,
    );
    await assert.rejects(
      () =>
        prepareCodexSeccompProfile({
          cluster: {
            ...cluster,
            directory: "relative-openclaw-k8s-test",
            kubeconfig: "/tmp/openclaw-k8s-test-abcdef/kubeconfig",
          },
          image: immutableImage,
          execFile,
        }),
      /cluster\.directory must be absolute/,
    );
  });

  test("codex seccomp preparation requires a namespace/seccomp RuntimeDefault denial before node writes", async (t) => {
    const root = await fixture(t);
    const clusterDirectory = join(root, "openclaw-k8s-test-owned");
    await mkdir(clusterDirectory);
    const cluster = {
      name: "openclaw-k8s-test",
      directory: clusterDirectory,
      kubeconfig: join(clusterDirectory, "kubeconfig"),
      context: "k3d-openclaw-k8s-test",
    };
    const dockerCalls: string[][] = [];
    const execFileForRuntimeDefaultFailure =
      (failure: (command: string, args: string[]) => CommandError): ExecFile =>
      async (command, args) => {
        if (command === "kubectl") {
          if (args.includes("create") && args.includes("namespace")) {
            return { stdout: "", stderr: "" };
          }
          if (args.includes("delete") && args.includes("namespace")) {
            return { stdout: "", stderr: "" };
          }
          if (args.includes("apply")) {
            return { stdout: "", stderr: "" };
          }
          if (args.includes("nodes")) {
            return {
              stdout: JSON.stringify({
                items: [{ metadata: { name: "k3d-openclaw-k8s-test-server-0" } }],
              }),
              stderr: "",
            };
          }
          if (args.includes("pod")) {
            return {
              stdout: JSON.stringify({
                metadata: { name: "runtime-default-probe" },
                status: {
                  containerStatuses: [
                    {
                      name: "probe",
                      ready: true,
                      containerID: "containerd://runtime-default-container",
                    },
                  ],
                },
              }),
              stderr: "",
            };
          }
          if (args.includes("exec")) {
            const nonce = args.at(-1);
            assert.ok(nonce);
            assert.match(nonce, /^[a-f0-9]{32}$/);
            const error = failure(command, args);
            const stage = error.exitCode === 64 ? "VERSION" : "SANDBOX";
            error.stderr = `OCE_SANDBOX_PROBE_V1:${nonce}:START\n${error.stderr}\nOCE_SANDBOX_PROBE_V1:${nonce}:END:${stage}:${error.exitCode}\n`;
            error.signal = null;
            throw error;
          }
        }
        if (command === "docker") {
          dockerCalls.push(args);
          throw new Error("docker should not be reached");
        }
        throw new Error(`Unexpected command: ${command}`);
      };

    await assert.rejects(
      () =>
        prepareCodexSeccompProfile({
          cluster,
          image: immutableImage,
          // The current runtime must still reject unrelated setup failures before node writes.
          codexVersion: "0.164.0",
          execFile: execFileForRuntimeDefaultFailure((command, args) => {
            const commandText = `${command} ${args.join(" ")}`;
            assert.match(commandText, /--namespace/);
            assert.match(commandText, /codex-seccomp-ok/);
            assert.match(commandText, /codex-seccomp-outside/);
            const error = Object.assign(
              new Error(`${commandText} failed: unrelated setup failure`),
              { stderr: "", stdout: "", exitCode: 0, signal: null, timedOut: false },
            );
            error.stderr = "unrelated setup failure";
            error.stdout = "";
            error.exitCode = 1;
            error.timedOut = false;
            return error;
          }),
        }),
      /unrelated setup failure/,
    );
    await assert.rejects(
      () =>
        prepareCodexSeccompProfile({
          cluster,
          image: immutableImage,
          execFile: execFileForRuntimeDefaultFailure((command, args) => {
            const error = Object.assign(
              new Error(`${command} ${args.join(" ")} timed out after 195000ms`),
              { stderr: "", stdout: "", exitCode: 0, signal: null, timedOut: false },
            );
            error.stderr = "operation not permitted";
            error.stdout = "";
            error.exitCode = 1;
            error.timedOut = true;
            return error;
          }),
        }),
      /timed out after 195000ms/,
    );
    await assert.rejects(
      () =>
        prepareCodexSeccompProfile({
          cluster,
          image: immutableImage,
          execFile: execFileForRuntimeDefaultFailure((command, args) => {
            const error = Object.assign(
              new Error(`${command} ${args.join(" ")} failed: version mismatch`),
              { stderr: "", stdout: "", exitCode: 0, signal: null, timedOut: false },
            );
            error.stderr = "Codex version mismatch: expected 0.158.0, got 0.152.1";
            error.stdout = "";
            error.exitCode = 64;
            error.timedOut = false;
            return error;
          }),
        }),
      /version mismatch/,
    );
    assert.deepEqual(dockerCalls, []);
  });

  test("codex seccomp preparation publishes a reviewed Docker profile for native smoke tests", async (t) => {
    const root = await fixture(t);
    const clusterDirectory = join(root, "openclaw-k8s-test-owned");
    await mkdir(clusterDirectory);
    const cluster = {
      name: "openclaw-k8s-test",
      directory: clusterDirectory,
      kubeconfig: join(clusterDirectory, "kubeconfig"),
      context: "k3d-openclaw-k8s-test",
    };
    const baseline = {
      defaultAction: "SCMP_ACT_ERRNO",
      architectures: ["SCMP_ARCH_X86_64"],
      syscalls: [{ names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 }],
    };
    let installedProfile: unknown;
    const applied = new Map();
    const execFile: ExecFile = async (command, args) => {
      if (command === "kubectl") {
        if (args.includes("create") && args.includes("namespace")) {
          return { stdout: "", stderr: "" };
        }
        if (args.includes("delete") && args.includes("namespace")) {
          return { stdout: "", stderr: "" };
        }
        if (args.includes("apply")) {
          const path = args.at(-1);
          assert.ok(path);
          const manifest = JSON.parse(await readFile(path, "utf8"));
          applied.set(manifest.metadata.name, manifest);
          return { stdout: "", stderr: "" };
        }
        if (args.includes("nodes")) {
          return {
            stdout: JSON.stringify({
              items: [{ metadata: { name: "k3d-openclaw-k8s-test-server-0" } }],
            }),
            stderr: "",
          };
        }
        if (args.includes("pod")) {
          const name = args[args.indexOf("pod") + 1];
          const manifest = applied.get(name);
          const localhostProfile =
            manifest?.spec?.containers?.[0]?.securityContext?.seccompProfile?.localhostProfile;
          if (localhostProfile?.includes("missing-")) {
            const missingProfilePath = `/var/lib/kubelet/seccomp/${localhostProfile}`;
            return {
              stdout: JSON.stringify({
                metadata: { name },
                status: {
                  containerStatuses: [
                    {
                      name: "probe",
                      state: {
                        waiting: {
                          reason: "CreateContainerError",
                          message: `failed to create containerd container: cannot load seccomp profile ${JSON.stringify(missingProfilePath)}: open ${missingProfilePath}: no such file or directory`,
                        },
                      },
                    },
                  ],
                },
              }),
              stderr: "",
            };
          }
          return {
            stdout: JSON.stringify({
              metadata: { name },
              status: {
                containerStatuses: [
                  {
                    name: "probe",
                    ready: true,
                    containerID: `containerd://${localhostProfile ? "installed" : "runtime-default"}`,
                  },
                ],
              },
            }),
            stderr: "",
          };
        }
        if (args.includes("exec")) {
          const podName = args[args.indexOf("exec") + 1];
          const manifest = applied.get(podName);
          const nonce = args.at(-1);
          assert.ok(nonce);
          assert.match(nonce, /^[a-f0-9]{32}$/);
          if (!manifest?.spec?.containers?.[0]?.securityContext?.seccompProfile?.localhostProfile) {
            const error = Object.assign(
              new Error("RuntimeDefault denied bwrap namespace creation"),
              { stderr: "", stdout: "", exitCode: 0, signal: null, timedOut: false },
            );
            error.stderr = `OCE_SANDBOX_PROBE_V1:${nonce}:START\noperation not permitted: bwrap clone namespace denied by seccomp\nOCE_SANDBOX_PROBE_V1:${nonce}:END:SANDBOX:1\n`;
            error.stdout = "";
            error.exitCode = 1;
            error.signal = null;
            error.timedOut = false;
            throw error;
          }
          return {
            stdout: "",
            stderr: `OCE_SANDBOX_PROBE_V1:${nonce}:START\nOCE_SANDBOX_PROBE_V1:${nonce}:ENTERED\nOCE_SANDBOX_PROBE_V1:${nonce}:END:DONE:0\n`,
            exitCode: 0,
            signal: null,
            timedOut: false,
          };
        }
      }
      if (command === "docker") {
        if (args[0] === "exec" && args[2] === "crictl" && args[3] === "inspect") {
          const seccomp = args[4] === "runtime-default" ? baseline : installedProfile;
          return {
            stdout: JSON.stringify({ info: { runtimeSpec: { linux: { seccomp } } } }),
            stderr: "",
          };
        }
        if (args[0] === "exec" && args[2] === "mkdir") {
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "cp") {
          const path = args[1];
          assert.ok(path);
          installedProfile = JSON.parse(await readFile(path, "utf8"));
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "exec" && args[2] === "chmod") {
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "exec" && args[2] === "sha256sum") {
          const data = `${JSON.stringify(installedProfile, null, 2)}\n`;
          const digest = createHash("sha256").update(data).digest("hex");
          return { stdout: `${digest}  ${args[4]}\n`, stderr: "" };
        }
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };

    const seccomp = await prepareCodexSeccompProfile({
      cluster,
      image: immutableImage,
      execFile,
    });

    assert.equal(seccomp.profileName, "openclaw/codex-bwrap.json");
    assert.ok(seccomp.profileSha256 && seccomp.dockerProfilePath);
    assert.match(seccomp.profileSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      seccomp.dockerProfilePath,
      join(clusterDirectory, "docker-seccomp", `codex-0.164.0-${seccomp.profileSha256}.json`),
    );
    const profileData = await readFile(seccomp.dockerProfilePath, "utf8");
    assert.deepEqual(JSON.parse(profileData), installedProfile);
    assert.equal((await stat(seccomp.dockerProfilePath)).mode & 0o777, 0o600);
  });
}
