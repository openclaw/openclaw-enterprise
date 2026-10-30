import { GitHubRepositoryPolicy } from "../policy.ts";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { UnixRepositoryCredentialControlClient } from "../../../../backends/repository-credentials/control-client.ts";
import { GitHubNativeRepositorySender } from "../driver.ts";

// This command is for an isolated broker and an explicitly controlled receipt
// fixture. The caller must verify the fixture's correlated recover/reserve request.
async function main() {
  const [socket, mode, admissionId, ...extra] = process.argv.slice(2);
  if (
    extra.length !== 0 ||
    !socket ||
    !mode ||
    !admissionId ||
    !["recover", "reserve"].includes(mode) ||
    !/^[0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      admissionId ?? "",
    )
  ) {
    throw new Error("invalid-probe-input");
  }
  const namespaceId = "compatibility-probe";
  const backendId = "compatibility-probe";
  const registry = {
    version: 1,
    backendId,
    providerInstanceId: "compatibility-probe",
    appId: "1",
    githubInstallationId: "1",
    maximumDurationSeconds: 60,
    repositories: [
      {
        repositoryRef: "compatibility-probe",
        repositoryId: "1",
        repository: "fixture/repository",
        namespaces: [
          {
            namespaceId,
            profiles: ["git-write"],
            transport: "git-only",
            pushRefAllowlist: ["refs/heads/compatibility-probe"],
          },
        ],
      },
    ],
  } as const;
  const client = new UnixRepositoryCredentialControlClient({ controlSocket: socket });
  const backend = { id: backendId, drivers: { repo: "compatibility-probe" } };
  const driver = new GitHubNativeRepositorySender({ ...backend, client }, {});
  const policy = new GitHubRepositoryPolicy(backend, registry, { sessionDurationSeconds: 60 });
  const binding = policy.resolve({
    namespaceId,
    bindings: [{ repositoryRef: "compatibility-probe", profile: "git-write" }],
  }).bindings[0]!;
  const deadlineWallMs = Date.now() + 60_000;
  const input = {
    namespaceId,
    repositoryRef: binding.repositoryRef,
    expectedBinding: binding.grant,
    profile: binding.profile,
    durationSeconds: 60,
    deadlineWallMs,
    preparedOnly: true as const,
  };
  const signal = AbortSignal.timeout(2000);
  await driver.checkAdmissionReady(signal);
  const request = {
    namespaceId,
    binding,
    durationSeconds: 60,
    deadlineWallMs,
    admissionId,
    preparedOnly: true as const,
    ...(mode === "recover" ? { recoverOnly: true as const } : {}),
  };
  let outcome;
  if (mode === "recover") {
    const result = await driver.open(request, signal);
    if (result.kind !== "missing") {
      throw new Error("unexpected-probe-result");
    }
    outcome = "missing";
  } else {
    try {
      await driver.open(request, signal);
    } catch (error) {
      if (!(error instanceof DependencyUnavailableError)) {
        throw error;
      }
      outcome = "unavailable";
    }
    if (outcome !== "unavailable") {
      throw new Error("unexpected-probe-result");
    }
  }
  process.stdout.write(`${JSON.stringify({ version: 1, mode, admissionId, outcome, input })}\n`);
}

try {
  await main();
} catch {
  process.stderr.write("Repository credential compatibility probe failed.\n");
  process.exitCode = 1;
}
