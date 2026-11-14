import assert from "node:assert/strict";
import type {
  OpenShellSandboxLogLine,
  OpenShellSandboxLogsRequest,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  createOpenShellGitDenial,
  openShellGitDenialFailureStage,
} from "../helpers/openshell-git-denial.mjs";

// The numeric destination case exercises the receipt reader's validation.
type FixtureLogLine = Omit<OpenShellSandboxLogLine, "fields"> & {
  readonly fields: Readonly<Record<string, string | number>>;
};

// The installed test may retain only this owner-assigned stage, never raw errors.
export function refusalAt(stage: string, message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, message);
    assert.equal(openShellGitDenialFailureStage(error), stage);
    return true;
  };
}

export const executable = "/usr/lib/git-core/git-remote-http";
export const startedAt = Date.parse("2026-11-05T12:00:00.000Z");
export const endedAt = startedAt + 2;
const markerHost = "git-retention-11111111-1111-4111-8111-111111111111.invalid";
const markerEndedAt = endedAt + 2;
export const interval = { startedAt, endedAt, markerHost, markerEndedAt };
export const denial = {
  sandboxId: "sandbox-one",
  source: "sandbox",
  level: "OCSF",
  target: "ocsf",
  time: "2026-11-05T12:00:00.002999999Z",
  message: `NET:OPEN [MED] DENIED ${executable}(0) -> github.com:443 [reason:transparent_tcp_policy_denied]`,
  fields: {},
} satisfies OpenShellSandboxLogLine;
export const warning = {
  ...denial,
  level: "WARN",
  target: "openshell_supervisor_network::proxy",
  time: "2026-11-05T12:00:00.001000000Z",
  message: "Denied staged transparent connection",
  fields: {
    reason: "endpoint github.com:443 is not allowed by any policy",
    destination: "198.18.0.1:443",
  },
} satisfies OpenShellSandboxLogLine;
export const marker = {
  ...denial,
  time: "2026-11-05T12:00:00.003000000Z",
  message: `NET:REFUSE [MED] DENIED ${markerHost} [reason:policy_dns_ineligible]`,
} satisfies OpenShellSandboxLogLine;
export const line = (index: number | string) => ({
  ...denial,
  message: `unrelated event ${index}`,
});

// This transport supplies log records to the evidence reader. It tests receipt
// attribution and refusal only; it does not simulate or prove network enforcement.
export function fixture(initial: readonly FixtureLogLine[], signal = new AbortController().signal) {
  const supervisor = {
    sandboxId: "sandbox-one",
    supervisorPodUid: "supervisor-one",
    containerId: "container-one",
  };
  let identity = supervisor;
  let current = initial;
  let total: number | undefined;
  let afterRead: () => void = () => {};
  const observer = createOpenShellGitDenial({
    gatewayClient: {
      async getSandboxLogs(request: OpenShellSandboxLogsRequest) {
        assert.deepEqual(request, {
          workspace: "workspace-one",
          sandbox: "sandbox-name",
          lines: 2000,
        });
        afterRead();
        return { lines: current, bufferTotal: total ?? current.length };
      },
    },
    workspace: "workspace-one",
    sandbox: "sandbox-name",
    sandboxId: "sandbox-one",
    supervisor,
    readSupervisor: async () => identity,
    executable,
    signal,
  });
  return {
    observer,
    set(lines: readonly FixtureLogLine[], bufferTotal?: number) {
      current = lines;
      total = bufferTotal;
    },
    replaceSupervisor() {
      identity = { ...supervisor, containerId: "replacement" };
    },
    afterRead(callback: () => void) {
      afterRead = callback;
    },
  };
}
