import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import { isRecord } from "../../scripts/ci/reporter-diagnostics.ts";

type LookupMiss = { lookup: "unavailable" | "other" };
type ConditionStatus = "True" | "False" | "Unknown" | "other";

type RelayPodEvidence =
  | LookupMiss
  | {
      lookup: "found";
      phase: string;
      scheduled: ConditionStatus;
      scheduledReason?: string;
      schedulingFailures?: readonly string[];
      ready: ConditionStatus;
      containerState: "waiting" | "running" | "terminated" | "other";
      waitingReason: string;
      terminationReason: string;
      exitCode?: number;
      restartCount?: number;
      nodeAssigned?: boolean;
      imageIdPresent?: boolean;
      containerIdPresent?: boolean;
    };

type FilesystemCounters = {
  availableBytes?: number;
  capacityBytes?: number;
  inodesFree?: number;
  inodes?: number;
};

type RelayNodeEvidence =
  | LookupMiss
  | {
      lookup: "found";
      conditions: Record<
        "ready" | "diskPressure" | "memoryPressure" | "pidPressure" | "networkUnavailable",
        ConditionStatus
      >;
      unschedulable?: boolean;
      taints: readonly { category: string; effect: string }[];
      taintCount?: number;
      unrecognizedTaintCount?: number;
      filesystems?:
        LookupMiss | { lookup: "found"; nodeFs?: FilesystemCounters; imageFs?: FilesystemCounters };
    };

type RepositorySetupEvidence = { kind: "repository-platform-setup" } & (
  | { stage: "controller-startup" }
  | {
      stage: "credential-service-startup";
      credentialService?: "gateway-listener" | "child-exited" | "child-deadline" | "other";
    }
  | { stage: "relay-readiness"; relayPod?: RelayPodEvidence; relayNode?: RelayNodeEvidence }
);

type DiagnosticCase = {
  name: string;
  diagnostic: { kind: string; stage: unknown } & Record<string, unknown>;
  expected: RepositorySetupEvidence | undefined;
};

function relayDiagnostic(
  field: "relayPod" | "relayNode",
  value: unknown,
  stage: "relay-readiness" | "controller-startup" = "relay-readiness",
) {
  return { kind: "repository-platform-setup", stage, [field]: value };
}

export function repositorySetupDiagnosticCases(secret: string): readonly DiagnosticCase[] {
  // These expectations describe the parsed results file, where omitted fields have no own key.
  const relayReadiness = {
    kind: "repository-platform-setup",
    stage: "relay-readiness",
  } satisfies RepositorySetupEvidence;

  const platformCases = [
    {
      name: "allowlisted repository platform setup diagnostic",
      diagnostic: {
        kind: "repository-platform-setup",
        stage: "relay-readiness",
        args: [secret],
        configuration: { credential: secret },
      },
      expected: relayReadiness,
    },
    {
      name: "allowlisted credential service startup reason",
      diagnostic: {
        kind: "repository-platform-setup",
        stage: "credential-service-startup",
        credentialService: "gateway-listener",
      },
      expected: {
        kind: "repository-platform-setup",
        stage: "credential-service-startup",
        credentialService: "gateway-listener",
      },
    },
    {
      name: "rejects unsafe credential service startup reason",
      diagnostic: {
        kind: "repository-platform-setup",
        stage: "credential-service-startup",
        credentialService: `${secret}-reason`,
      },
      expected: { kind: "repository-platform-setup", stage: "credential-service-startup" },
    },
    {
      name: "rejects unsafe repository platform setup stage",
      diagnostic: { kind: "repository-platform-setup", stage: `${secret}-stage` },
      expected: undefined,
    },
    {
      name: "rejects nonstring repository platform setup stage",
      diagnostic: { kind: "repository-platform-setup", stage: { value: secret } },
      expected: undefined,
    },
    {
      name: "rejects unknown setup diagnostic kind",
      diagnostic: { kind: `${secret}-kind`, stage: "relay-readiness" },
      expected: undefined,
    },
  ] satisfies readonly DiagnosticCase[];

  const relayPodCases = [
    {
      name: "retains closed relay Pod status without payloads",
      diagnostic: relayDiagnostic("relayPod", {
        lookup: "found",
        phase: "Running",
        scheduled: "True",
        ready: "False",
        containerState: "waiting",
        waitingReason: "CrashLoopBackOff",
        terminationReason: "OOMKilled",
        exitCode: 137,
        restartCount: 3,
        nodeAssigned: true,
        imageIdPresent: true,
        containerIdPresent: false,
        message: secret,
        pod: { spec: { containers: [{ env: [{ value: secret }] }] } },
      }),
      expected: {
        ...relayReadiness,
        relayPod: {
          lookup: "found",
          phase: "Running",
          scheduled: "True",
          ready: "False",
          containerState: "waiting",
          waitingReason: "CrashLoopBackOff",
          terminationReason: "OOMKilled",
          exitCode: 137,
          restartCount: 3,
          nodeAssigned: true,
          imageIdPresent: true,
          containerIdPresent: false,
        },
      },
    },
    {
      name: "retains closed scheduling causes in canonical order",
      diagnostic: relayDiagnostic("relayPod", {
        lookup: "found",
        phase: "Pending",
        scheduled: "False",
        scheduledReason: "Unschedulable",
        schedulingFailures: [
          "insufficient-memory",
          "disk-pressure",
          "disk-pressure",
          secret,
          { message: secret },
        ],
        message: secret,
      }),
      expected: {
        ...relayReadiness,
        relayPod: {
          lookup: "found",
          phase: "Pending",
          scheduled: "False",
          scheduledReason: "Unschedulable",
          schedulingFailures: ["disk-pressure", "insufficient-memory", "other"],
          ready: "other",
          containerState: "other",
          waitingReason: "other",
          terminationReason: "other",
        },
      },
    },
    {
      name: "replaces unknown relay Pod fields and omits invalid scalars",
      diagnostic: relayDiagnostic("relayPod", {
        lookup: "found",
        phase: secret,
        scheduled: { value: secret },
        scheduledReason: secret,
        schedulingFailures: secret,
        ready: [secret],
        containerState: secret,
        waitingReason: secret,
        terminationReason: { message: secret },
        exitCode: 1.5,
        restartCount: -1,
        nodeAssigned: "true",
        imageIdPresent: 1,
        containerIdPresent: { value: secret },
      }),
      expected: {
        ...relayReadiness,
        relayPod: {
          lookup: "found",
          phase: "other",
          scheduled: "other",
          scheduledReason: "other",
          schedulingFailures: ["other"],
          ready: "other",
          containerState: "other",
          waitingReason: "other",
          terminationReason: "other",
        },
      },
    },
    {
      name: "rejects out-of-range relay Pod counters",
      diagnostic: relayDiagnostic("relayPod", {
        lookup: "found",
        exitCode: 256,
        restartCount: 2 ** 31,
        scheduledReason: "SchedulingGated",
        schedulingFailures: Array.from({ length: 14 }, () => "disk-pressure"),
      }),
      expected: {
        ...relayReadiness,
        relayPod: {
          lookup: "found",
          phase: "other",
          scheduled: "other",
          scheduledReason: "SchedulingGated",
          schedulingFailures: ["other"],
          ready: "other",
          containerState: "other",
          waitingReason: "other",
          terminationReason: "other",
        },
      },
    },
    {
      name: "retains unavailable relay Pod lookup without its error",
      diagnostic: relayDiagnostic("relayPod", {
        lookup: "unavailable",
        error: { message: secret },
        exitCode: 137,
      }),
      expected: { ...relayReadiness, relayPod: { lookup: "unavailable" } },
    },
    {
      name: "replaces unknown relay Pod lookup",
      diagnostic: relayDiagnostic("relayPod", { lookup: secret, phase: secret }),
      expected: { ...relayReadiness, relayPod: { lookup: "other" } },
    },
    ...[null, "invalid", []].map((relayPod, index) => ({
      name: `rejects malformed relay Pod diagnostic ${index}`,
      diagnostic: relayDiagnostic("relayPod", relayPod),
      expected: relayReadiness,
    })),
    {
      name: "discards relay Pod status outside relay readiness",
      diagnostic: relayDiagnostic(
        "relayPod",
        { lookup: "found", phase: "Running", message: secret },
        "controller-startup",
      ),
      expected: { kind: "repository-platform-setup", stage: "controller-startup" },
    },
  ] satisfies readonly DiagnosticCase[];

  const relayNodeCases = [
    {
      name: "retains closed node pressure evidence without node or workload identities",
      diagnostic: relayDiagnostic("relayNode", {
        lookup: "found",
        conditions: {
          ready: "True",
          diskPressure: "True",
          memoryPressure: "False",
          pidPressure: "False",
          networkUnavailable: "Unknown",
          message: secret,
        },
        unschedulable: false,
        taints: [
          { category: "disk-pressure", effect: "NoSchedule", key: secret, value: secret },
          { category: "disk-pressure", effect: "NoSchedule" },
          { category: secret, effect: secret, message: secret },
        ],
        taintCount: 3,
        unrecognizedTaintCount: 1,
        name: secret,
        providerID: secret,
        filesystems: {
          lookup: "found",
          nodeFs: {
            availableBytes: 0,
            capacityBytes: 1024,
            inodesFree: 2,
            inodes: 4096,
            mountpoint: secret,
          },
          imageFs: {
            availableBytes: 512,
            capacityBytes: 2048,
            inodesFree: 0,
            inodes: Number.MAX_SAFE_INTEGER,
          },
          pods: [{ name: secret, containers: [{ logs: secret }] }],
        },
      }),
      expected: {
        ...relayReadiness,
        relayNode: {
          lookup: "found",
          conditions: {
            ready: "True",
            diskPressure: "True",
            memoryPressure: "False",
            pidPressure: "False",
            networkUnavailable: "Unknown",
          },
          unschedulable: false,
          taints: [
            { category: "disk-pressure", effect: "NoSchedule" },
            { category: "other", effect: "other" },
          ],
          taintCount: 3,
          unrecognizedTaintCount: 1,
          filesystems: {
            lookup: "found",
            nodeFs: { availableBytes: 0, capacityBytes: 1024, inodesFree: 2, inodes: 4096 },
            imageFs: {
              availableBytes: 512,
              capacityBytes: 2048,
              inodesFree: 0,
              inodes: Number.MAX_SAFE_INTEGER,
            },
          },
        },
      },
    },
    {
      name: "rejects malformed node fields and unsafe filesystem counters",
      diagnostic: relayDiagnostic("relayNode", {
        lookup: "found",
        conditions: { ready: secret, diskPressure: [secret] },
        unschedulable: "true",
        taints: Array.from({ length: 65 }, () => ({
          category: "disk-pressure",
          effect: "NoSchedule",
        })),
        taintCount: -1,
        unrecognizedTaintCount: 2 ** 31,
        filesystems: {
          lookup: "found",
          nodeFs: {
            availableBytes: -1,
            capacityBytes: 1.5,
            inodesFree: "3",
            inodes: Number.MAX_SAFE_INTEGER + 1,
          },
          imageFs: [secret],
          message: secret,
        },
      }),
      expected: {
        ...relayReadiness,
        relayNode: {
          lookup: "found",
          conditions: {
            ready: "other",
            diskPressure: "other",
            memoryPressure: "other",
            pidPressure: "other",
            networkUnavailable: "other",
          },
          taints: [{ category: "other", effect: "other" }],
          filesystems: { lookup: "found", nodeFs: {} },
        },
      },
    },
    {
      name: "retains node lookup when optional filesystem lookup fails",
      diagnostic: relayDiagnostic("relayNode", {
        lookup: "found",
        conditions: null,
        taints: [],
        taintCount: 0,
        unrecognizedTaintCount: 0,
        filesystems: { lookup: "unavailable", error: secret },
      }),
      expected: {
        ...relayReadiness,
        relayNode: {
          lookup: "found",
          conditions: {
            ready: "other",
            diskPressure: "other",
            memoryPressure: "other",
            pidPressure: "other",
            networkUnavailable: "other",
          },
          taints: [],
          taintCount: 0,
          unrecognizedTaintCount: 0,
          filesystems: { lookup: "unavailable" },
        },
      },
    },
    {
      name: "replaces unknown node and filesystem categories",
      diagnostic: relayDiagnostic("relayNode", {
        lookup: "found",
        taints: secret,
        filesystems: { lookup: secret, nodeFs: { availableBytes: 3 }, message: secret },
      }),
      expected: {
        ...relayReadiness,
        relayNode: {
          lookup: "found",
          conditions: {
            ready: "other",
            diskPressure: "other",
            memoryPressure: "other",
            pidPressure: "other",
            networkUnavailable: "other",
          },
          taints: [{ category: "other", effect: "other" }],
          filesystems: { lookup: "other" },
        },
      },
    },
    {
      name: "retains unavailable node lookup without its error",
      diagnostic: relayDiagnostic("relayNode", {
        lookup: "unavailable",
        error: secret,
        name: secret,
      }),
      expected: { ...relayReadiness, relayNode: { lookup: "unavailable" } },
    },
    {
      name: "replaces unknown node lookup",
      diagnostic: relayDiagnostic("relayNode", { lookup: secret, conditions: secret }),
      expected: { ...relayReadiness, relayNode: { lookup: "other" } },
    },
    ...[null, secret, []].map((relayNode, index) => ({
      name: `rejects malformed relay node diagnostic ${index}`,
      diagnostic: relayDiagnostic("relayNode", relayNode),
      expected: relayReadiness,
    })),
    {
      name: "discards node evidence outside relay readiness",
      diagnostic: relayDiagnostic(
        "relayNode",
        { lookup: "found", name: secret },
        "controller-startup",
      ),
      expected: { kind: "repository-platform-setup", stage: "controller-startup" },
    },
  ] satisfies readonly DiagnosticCase[];

  return [...platformCases, ...relayPodCases, ...relayNodeCases];
}

export function assertRepositorySetupDiagnostics(
  summary: unknown,
  cases: readonly DiagnosticCase[],
): void {
  assert.ok(isRecord(summary) && Array.isArray(summary.files), "Expected runner result files");
  const files: readonly unknown[] = summary.files;
  assert.equal(files.length, 1, "Expected one generated diagnostic test file");
  const [file] = files;
  assert.ok(isRecord(file) && Array.isArray(file.tests), "Expected runner test results");
  const tests: readonly unknown[] = file.tests;
  const results = tests.filter(isRecord);

  for (const { name, expected } of cases) {
    const matches = results.filter((entry) => entry.name === name);
    assert.equal(matches.length, 1, `${name}: expected one result`);
    const [failure] = matches;
    assert.ok(
      failure?.status === "failed" && isRecord(failure.error),
      `${name}: expected a failure`,
    );
    assert.equal(
      Object.hasOwn(failure.error, "diagnostic"),
      expected !== undefined,
      `${name}: unexpected diagnostic presence`,
    );
    // A regression can expose the input being filtered. Report the case without its payload.
    assert.ok(
      isDeepStrictEqual(failure.error.diagnostic, expected),
      `${name}: unexpected retained diagnostic`,
    );
  }
}
