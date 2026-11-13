import test from "node:test";
import {
  publishesFileDeliveredCa,
  rebuildsLinkedHookPaths,
  removesPreviousHookCredentials,
} from "./workspace-node-supervisor-hook-cases.ts";
import {
  preservesNativeCas,
  preservesNaturalNativeExitCode,
  refusesInvalidPrivatePort,
  retiresNativeWorkerWithLatestEnvelope,
  stopsPendingNativeRenewal,
} from "./workspace-node-supervisor-native-cases.ts";
import {
  preservesSavedIdentityOnProviderReadFailure,
  restartsAndReapsIndependently,
  retiresNodeGroupWithLatestProjection,
  retriesSavedIdentityProbe,
  startsBeforeSetupAndReconnects,
  stopsBetweenRestarts,
} from "./workspace-node-supervisor-cases.ts";
import {
  acceptsLargeSetupOutput,
  servesHeldStatus,
  waitsForSetupBeforeStopping,
} from "./workspace-node-supervisor-setup-cases.ts";

test(
  "native worker refuses an invalid configured private port",
  { timeout: 10_000 },
  refusesInvalidPrivatePort,
);

test(
  "workspace node and Codex restart independently and retire their process groups",
  {
    timeout: 15_000,
    // These are Linux container entrypoints. Darwin can report EPERM when a
    // process group contains only zombies, unlike the production kernel.
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  restartsAndReapsIndependently,
);

test(
  "provider read failures preserve a running saved-identity node",
  {
    timeout: 20_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  preservesSavedIdentityOnProviderReadFailure,
);

test(
  "setup renewal preserves a rolled-back file projection while retiring its node group",
  {
    timeout: 20_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  retiresNodeGroupWithLatestProjection,
);

test(
  "Codex hooks trust a file-delivered Gateway CA from the Harness HOME",
  {
    timeout: 15_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  publishesFileDeliveredCa,
);

test(
  "each Codex start rebuilds the hook directory without following a planted link",
  {
    timeout: 15_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  rebuildsLinkedHookPaths,
);

test(
  "the first Codex start removes credentials left by an earlier Harness lifetime",
  {
    timeout: 15_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  removesPreviousHookCredentials,
);

for (const topology of ["Compute-owned", "provider-owned"] as const) {
  test(
    `native worker preserves model-proxy and Gateway CAs when ${topology}`,
    { timeout: 15_000 },
    (t) => preservesNativeCas(t, topology),
  );
}

test(
  "native provider renewal preserves a rolled-back envelope while retiring its node group",
  { timeout: 25_000, skip: process.platform !== "linux" && "Linux process groups are required." },
  retiresNativeWorkerWithLatestEnvelope,
);

test(
  "operator stop cancels a pending native provider renewal",
  { timeout: 18_000, skip: process.platform !== "linux" && "Linux process groups are required." },
  stopsPendingNativeRenewal,
);

test(
  "native provider wrapper preserves a natural child exit code",
  { timeout: 10_000 },
  preservesNaturalNativeExitCode,
);

test(
  "Codex starts before the node setup file and the node reconnects after the code is removed",
  {
    timeout: 40_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  startsBeforeSetupAndReconnects,
);

test(
  "a failed saved-identity probe is retried and the node starts without a code",
  {
    timeout: 20_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  retriesSavedIdentityProbe,
);

test(
  "a stop with no running child exits at once",
  {
    timeout: 15_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  stopsBetweenRestarts,
);

test(
  "Harness starts its children after a native setup whose result outgrows a pipe buffer",
  { timeout: 15_000 },
  acceptsLargeSetupOutput,
);

test(
  "Harness holds a failed native setup and serves the held check on the Compute status port",
  { timeout: 15_000 },
  servesHeldStatus,
);

test(
  "a Harness stopped during native setup lets setup finish before it exits",
  {
    timeout: 15_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  waitsForSetupBeforeStopping,
);
