import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { createQaAgent, createQaInstallation } from "./qa-installation.mjs";

type Fixture = Awaited<ReturnType<typeof createQaInstallation>>;
type Agent = Awaited<ReturnType<typeof createQaAgent>>;
type NativeJob = {
  id: string;
  declarationKey: string | null;
  enabled: boolean;
  scheduleKind: string;
  payloadKind: string;
  configRevision: string;
  agentId: string | null;
  effectiveAgentId: string | null;
  nextRunAtMs: number | null;
  runningAtMs: number | null;
};
type Response = { status: number; data?: unknown; errorCode?: string | undefined };
type PendingReservation = { id: string; configRevision: string };

export type QaCodexReadinessCallbacks = {
  nativeJobs: () => Promise<NativeJob[]>;
  setStockEnabled: (job: NativeJob, enabled: boolean) => Promise<string>;
  managedJobs: () => Promise<number>;
  peerCalls: () => Promise<number>;
  pendingReservations: () => Promise<PendingReservation[]>;
  cancelPending: (reservation: PendingReservation) => Promise<void>;
  createPaused: () => Promise<Response>;
  readRequirements: () => Promise<unknown>;
};

type Identity = {
  namespace: string;
  name: string;
  uid: string;
  revisionId: string;
  imageId: string;
  containerId: string;
  statusPort: number;
};

const processProgram = String.raw`
const fs=require("node:fs"),path=require("node:path");
const {action,controlPath}=input;
function identity(pid){
 const owner=fs.statSync("/proc/"+pid).uid;
 if(owner!==process.getuid())return;
 const stat=fs.readFileSync("/proc/"+pid+"/stat","utf8"),end=stat.lastIndexOf(")");
 if(end<0)throw Error("invalid process state");
 const fields=stat.slice(end+2).split(" "),args=fs.readFileSync("/proc/"+pid+"/cmdline").toString().split("\0").filter(Boolean);
 const argv0=path.basename(args[0]||""),listen=args.indexOf("--listen"),auth=args.indexOf("--ws-auth");
 if(argv0!=="codex"||!args.includes("app-server")||listen<0||args[listen+1]!=="ws://0.0.0.0:"+process.env.APP_SERVER_PORT||auth<0||args[auth+1]!=="capability-token")return;
 if(!/^[0-9]+$/.test(fields[19]||""))throw Error("invalid process start");
 return {pid:Number(pid),startTicks:fields[19],state:fields[0],uid:owner};
}
try{
 if(!/^\/tmp\/oce-qa-codex-readiness-[0-9a-f-]{36}\.json$/.test(controlPath))throw Error("invalid control path");
 if(action==="stop"){
  const matches=[];
  for(const entry of fs.readdirSync("/proc"))if(/^[0-9]+$/.test(entry)&&Number(entry)>1){try{const value=identity(entry);if(value)matches.push(value)}catch{}}
  if(matches.length!==1)throw Error("native process is not unique");
  if(input.maxStoppedMs!==180000)throw Error("invalid control deadline");
  const selected=matches[0],continueBeforeTicks=process.hrtime.bigint()+BigInt(input.maxStoppedMs)*1000000n,fd=fs.openSync(controlPath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,JSON.stringify({pid:selected.pid,startTicks:selected.startTicks,uid:selected.uid,continueBeforeTicks:String(continueBeforeTicks)}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  const again=identity(selected.pid);
  if(!again||again.startTicks!==selected.startTicks||again.uid!==selected.uid||process.hrtime.bigint()>=continueBeforeTicks)throw Error("native process changed");
  process.kill(selected.pid,"SIGSTOP");
  process.stdout.write(JSON.stringify({stopped:true,deadlineEnforced:true}));
 }else if(action==="continue"){
  let fd;try{fd=fs.openSync(controlPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)}catch(error){if(error.code==="ENOENT"){process.stdout.write(JSON.stringify({absent:true}));process.exit(0)}throw error}
  let expected;try{const info=fs.fstatSync(fd);if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o777)!==0o600||info.size<1||info.size>1024)throw Error("invalid control binding");expected=JSON.parse(fs.readFileSync(fd,"utf8"))}finally{fs.closeSync(fd)}
  if(!Number.isSafeInteger(expected?.pid)||expected.pid<=1||!/^[0-9]+$/.test(expected?.startTicks||"")||expected.uid!==process.getuid()||!/^[0-9]+$/.test(expected?.continueBeforeTicks||""))throw Error("invalid process binding");
  const current=identity(expected.pid);
  if(!current||current.startTicks!==expected.startTicks||current.uid!==expected.uid)throw Error("native process binding changed");
  const stopped=["T","t"].includes(current.state);
  if(stopped){if(process.hrtime.bigint()>=BigInt(expected.continueBeforeTicks))throw Error("control deadline expired");process.kill(expected.pid,"SIGCONT")}
  fs.unlinkSync(controlPath);
  process.stdout.write(JSON.stringify({continued:stopped,alreadyRunning:!stopped,deadlineEnforced:true}));
 }else throw Error("invalid control action");
}catch{process.stderr.write("Native readiness control unavailable.");process.exitCode=1}
`;

const statusProgram = String.raw`
const port=Number(input.port);
if(!Number.isSafeInteger(port)||port<1||port>65535)process.exit(1);
fetch("http://127.0.0.1:"+port+"/readyz",{signal:AbortSignal.timeout(7000)})
 .then(response=>process.stdout.write(JSON.stringify({status:response.status})))
 .catch(()=>{process.stderr.write("Resident readiness observation unavailable.");process.exitCode=1});
`;

function requiredString(value: unknown, reason: string): string {
  assert.ok(typeof value === "string" && value.length > 0, reason);
  return value;
}

function podIdentity(value: unknown, agent: Agent): Identity {
  const pod = asRecord(value);
  const metadata = asRecord(pod?.metadata);
  const labels = asRecord(metadata?.labels);
  const spec = asRecord(pod?.spec);
  const status = asRecord(pod?.status);
  const containers = Array.isArray(spec?.containers) ? spec.containers.map(asRecord) : [];
  const selected = containers.filter((container) => container?.name === "agent");
  const statuses = Array.isArray(status?.containerStatuses)
    ? status.containerStatuses.map(asRecord).filter((container) => container?.name === "agent")
    : [];
  assert.equal(selected.length, 1, "one exact Agent container is required");
  assert.equal(statuses.length, 1, "one exact Agent container status is required");
  const probe = asRecord(selected[0]?.readinessProbe);
  const http = asRecord(probe?.httpGet);
  assert.equal(
    probe?.timeoutSeconds,
    3,
    "qualified native readiness must allow its bounded RPC to finish",
  );
  assert.equal(http?.path, "/readyz", "the real resident readiness path is required");
  assert.equal(http?.port, "plugin-status", "the real resident readiness port is required");
  const ports = Array.isArray(selected[0]?.ports)
    ? selected[0].ports.map(asRecord).filter((port) => port?.name === "plugin-status")
    : [];
  assert.equal(ports.length, 1, "one resident readiness port is required");
  const statusPort = ports[0]?.containerPort;
  assert.ok(
    Number.isSafeInteger(statusPort) && Number(statusPort) > 0 && Number(statusPort) <= 65535,
  );
  assert.equal(labels?.["openclaw.dev/agent"], agent.id);
  assert.equal(labels?.["openclaw.dev/revision"], agent.revision.id);
  assert.equal(labels?.["openclaw.dev/workload-role"], "agent");
  assert.equal(status?.phase, "Running");
  assert.equal(metadata?.deletionTimestamp, undefined);
  return {
    namespace: requiredString(metadata?.namespace, "Agent Pod namespace is required"),
    name: requiredString(metadata?.name, "Agent Pod name is required"),
    uid: requiredString(metadata?.uid, "Agent Pod UID is required"),
    revisionId: agent.revision.id,
    imageId: requiredString(statuses[0]?.imageID, "Agent image identity is required"),
    containerId: requiredString(statuses[0]?.containerID, "Agent container identity is required"),
    statusPort: Number(statusPort),
  };
}

function readinessState(value: unknown): "ready" | "unready" | "transition" {
  const pod = asRecord(value);
  const status = asRecord(pod?.status);
  const conditions = Array.isArray(status?.conditions)
    ? status.conditions.map(asRecord).filter((condition) => condition?.type === "Ready")
    : [];
  const containers = Array.isArray(status?.containerStatuses)
    ? status.containerStatuses.map(asRecord).filter((container) => container?.name === "agent")
    : [];
  assert.equal(conditions.length, 1, "one Pod Ready condition is required");
  assert.equal(containers.length, 1, "one Agent readiness status is required");
  assert.ok(["True", "False"].includes(String(conditions[0]?.status)));
  assert.equal(typeof containers[0]?.ready, "boolean");
  if (conditions[0]?.status === "True" && containers[0]?.ready === true) {
    return "ready";
  }
  if (conditions[0]?.status === "False" && containers[0]?.ready === false) {
    return "unready";
  }
  return "transition";
}

function sameIdentity(expected: Identity, current: Identity) {
  assert.deepEqual(
    current,
    expected,
    "the exact Agent Pod, revision, image and container must remain",
  );
}

async function getPod(f: Fixture, agent: Agent, identity: Identity) {
  const pod = JSON.parse(
    await f.kubectl("-n", identity.namespace, "get", "pod", identity.name, "-o", "json"),
  );
  sameIdentity(identity, podIdentity(pod, agent));
  return pod;
}

async function exec(f: Fixture, identity: Identity, script: string, input: object) {
  const stdout = await f.kubectl(
    "-n",
    identity.namespace,
    "exec",
    identity.name,
    "-c",
    "agent",
    "--",
    "node",
    "-e",
    ...nodeProgramArguments("const input=" + JSON.stringify(input) + ";" + script),
  );
  const result = asRecord(JSON.parse(stdout));
  assert.ok(result, "the Agent-local readiness control must return fixed evidence");
  return result;
}

const stockMemoryDeclaration = "memory-core:memory-dreaming-promotion";
const stockJobSafetyMs = 180_000;
const restoredStockSafetyMs = 7_200_000;

function assertStockJob(jobs: NativeJob[], enabled: boolean): void {
  assert.ok(jobs.length === 1, "only the stock memory task may precede readiness refusal");
  const job = jobs[0]!;
  assert.ok(job.declarationKey === stockMemoryDeclaration, "the stock memory task is required");
  assert.ok(
    job.enabled === enabled && job.scheduleKind === "cron" && job.payloadKind === "agentTurn",
  );
  assert.ok(job.effectiveAgentId === "main", "the stock task must resolve to the dedicated main");
  assert.ok(job.runningAtMs === null, "the stock memory task must not be running");
  if (enabled) {
    assert.ok(
      job.nextRunAtMs !== null &&
        Number.isSafeInteger(job.nextRunAtMs) &&
        job.nextRunAtMs > Date.now() + stockJobSafetyMs,
      "the stock memory task must not become due during setup or restoration",
    );
  } else {
    assert.ok(job.nextRunAtMs === null, "the paused stock task must have no next run");
  }
}

function assertSameNativeJobs(actual: NativeJob[], expected: NativeJob[], reason: string): void {
  assert.ok(isDeepStrictEqual(actual, expected), reason);
}

async function observeUncertainStock(
  callbacks: QaCodexReadinessCallbacks,
  original: NativeJob,
): Promise<boolean> {
  try {
    const jobs = await callbacks.nativeJobs();
    return (
      jobs.length === 1 &&
      jobs[0]!.id === original.id &&
      jobs[0]!.declarationKey === stockMemoryDeclaration
    );
  } catch {
    return false;
  }
}

async function stockBaseline(
  f: Fixture,
  callbacks: QaCodexReadinessCallbacks,
): Promise<NativeJob[]> {
  let previous: NativeJob[] | undefined;
  return f.waitFor(
    "stable stock memory task",
    async () => {
      const jobs = await callbacks.nativeJobs();
      if (jobs.length === 0) {
        previous = undefined;
        return false;
      }
      assertStockJob(jobs, true);
      if (previous && isDeepStrictEqual(jobs, previous)) {
        return jobs;
      }
      previous = jobs;
      return false;
    },
    30_000,
  );
}

/** Exercise real resident readiness failure before an OCC automation exists. */
export async function verifyQaCodexAutomationReadinessRefusal(
  f: Fixture,
  agent: Agent,
  callbacks: QaCodexReadinessCallbacks,
): Promise<void> {
  assert.equal(agent.preset, "Codex");
  const initialPod = await f.pod(agent, "agent");
  const identity = podIdentity(initialPod, agent);
  assert.equal(readinessState(initialPod), "ready");
  const originalJobs = await stockBaseline(f, callbacks);
  const baselinePeerCalls = await callbacks.peerCalls();
  const baselinePending = await callbacks.pendingReservations();
  const baselineManagedJobs = await callbacks.managedJobs();
  assert.ok(baselineManagedJobs === 0, "readiness refusal must precede every OCC binding");
  assert.equal(baselinePending.length, 0, "readiness refusal must precede every reservation");
  const failures: unknown[] = [];
  const controlPath = "/tmp/oce-qa-codex-readiness-" + randomUUID() + ".json";
  let pauseAttempted = false;
  let stockPaused = false;
  let stockRestored = false;
  let restoreAttempted = false;
  let stockJobSafeAfterRestore = false;
  let pauseOutcomeObserved = false;
  let restoreOutcomeObserved = false;
  let managedJobsUnchanged = false;
  let baselineJobs: NativeJob[] = [];
  let stopAttempted = false;
  let stopped = false;
  let resident503 = false;
  let podUnready = false;
  let denied = false;
  let recovered = false;
  let nativeInventoryUnchanged = false;
  let peerCallsUnchanged = false;
  let pendingUnchanged = false;
  let unexpectedResponse = false;
  let postAttempted = false;
  let quarantined = false;
  let stockPausedBeforeContinuation = false;
  let continuationDeadlineEnforced = false;
  try {
    // Pause the exact native system task once. Native disable cancels queued
    // work and fences final dispatch. An uncertain update is never replayed.
    pauseAttempted = true;
    const pausedRevision = await callbacks.setStockEnabled(originalJobs[0]!, false);
    const pausedJobs = await callbacks.nativeJobs();
    assertStockJob(pausedJobs, false);
    assert.ok(pausedJobs[0]!.id === originalJobs[0]!.id, "the stock task identity changed");
    assert.ok(
      pausedJobs[0]!.configRevision === pausedRevision &&
        pausedRevision !== originalJobs[0]!.configRevision,
      "the paused stock task revision is required",
    );
    assert.ok(
      pausedJobs[0]!.agentId === originalJobs[0]!.agentId &&
        pausedJobs[0]!.effectiveAgentId === originalJobs[0]!.effectiveAgentId,
      "the stock task execution identity changed",
    );
    baselineJobs = pausedJobs;
    stockPaused = true;
    assert.ok(
      isDeepStrictEqual(await callbacks.pendingReservations(), baselinePending),
      "native isolation changed OCC reservations",
    );
    assert.ok(
      (await callbacks.peerCalls()) === baselinePeerCalls,
      "native isolation changed MCP effects",
    );
    // Suspend only the native child. The resident status server and the real
    // Kubernetes readiness probe remain active, so this models transport loss.
    const jobsBeforeStop = await callbacks.nativeJobs();
    assertSameNativeJobs(jobsBeforeStop, baselineJobs, "native jobs changed before suspension");
    assertStockJob(jobsBeforeStop, false);
    stopAttempted = true;
    const control = await exec(f, identity, processProgram, {
      action: "stop",
      controlPath,
      maxStoppedMs: 180_000,
    });
    assert.ok(control.stopped === true && control.deadlineEnforced === true);
    stopped = true;
    await f.waitFor(
      "resident Codex readiness failure",
      async () => {
        await getPod(f, agent, identity);
        const observation = await exec(f, identity, statusProgram, { port: identity.statusPort });
        assert.ok(
          observation.status === 200 || observation.status === 503,
          "unexpected resident readiness status",
        );
        resident503 = observation.status === 503;
        return resident503;
      },
      30_000,
    );
    await f.waitFor(
      "exact Codex Agent Pod unready",
      async () => {
        podUnready = readinessState(await getPod(f, agent, identity)) === "unready";
        return podUnready;
      },
      30_000,
    );
    // This is one real API mutation attempt. An uncertain response is never replayed.
    let response: Response;
    try {
      postAttempted = true;
      response = await callbacks.createPaused();
    } catch {
      throw new Error("Automation creation outcome is unknown; do not replay the request.");
    }
    unexpectedResponse = response.status === 201;
    denied = response.status === 503 && response.errorCode === "DEPENDENCY_UNAVAILABLE";
    assert.equal(denied, true, "unready dedicated execution must refuse automation admission");
    assert.ok(
      isDeepStrictEqual(await callbacks.pendingReservations(), baselinePending),
      "refusal must not write an OCC reservation",
    );
  } catch (error) {
    if (pauseAttempted && !stockPaused) {
      pauseOutcomeObserved = await observeUncertainStock(callbacks, originalJobs[0]!);
      quarantined = true;
    }
    failures.push(error);
  } finally {
    if (stopAttempted) {
      // A failed admission must not be allowed to dispatch when the native
      // process resumes. Reconcile only an exact pending reservation while the
      // independent Gateway confirms no native job was created.
      let nativeSafe = false;
      try {
        assertSameNativeJobs(
          await callbacks.nativeJobs(),
          baselineJobs,
          "native jobs changed before reconciliation",
        );
        nativeSafe = true;
      } catch {
        failures.push(new Error("Native job inventory is unsafe or unavailable before recovery."));
      }
      try {
        const pending = await callbacks.pendingReservations();
        const added = pending.filter(
          (row) => !baselinePending.some((prior) => prior.id === row.id),
        );
        if (added.length > 0 && nativeSafe) {
          assert.equal(added.length, 1, "only one uncertain reservation may be cancelled");
          try {
            await callbacks.cancelPending(added[0]!);
          } catch {
            failures.push(
              new Error("Pending reservation cancellation outcome is unknown; do not replay it."),
            );
          }
        }
      } catch {
        failures.push(new Error("Pending reservation inventory could not be safely reconciled."));
      }
      try {
        assertSameNativeJobs(
          await callbacks.nativeJobs(),
          baselineJobs,
          "native jobs changed before recovery",
        );
        nativeInventoryUnchanged = true;
      } catch {
        failures.push(new Error("Native job inventory changed before recovery."));
      }
      try {
        assert.ok(
          isDeepStrictEqual(await callbacks.pendingReservations(), baselinePending),
          "pending reservations changed before recovery",
        );
        pendingUnchanged = true;
      } catch {
        failures.push(new Error("Pending reservation inventory changed before recovery."));
      }
      try {
        assert.equal(await callbacks.peerCalls(), baselinePeerCalls);
        peerCallsUnchanged = true;
      } catch {
        failures.push(new Error("MCP peer effects changed before recovery."));
      }
      if (
        unexpectedResponse ||
        !nativeInventoryUnchanged ||
        !pendingUnchanged ||
        !peerCallsUnchanged
      ) {
        // Do not resume into an unknown or possibly active job. The disposable
        // fixture must destroy this task Pod, which also kills the stopped child.
        quarantined = true;
        failures.push(
          new Error("Codex execution remains quarantined for disposable fixture teardown."),
        );
      } else {
        try {
          await getPod(f, agent, identity);
          const jobsBeforeContinue = await callbacks.nativeJobs();
          assertSameNativeJobs(
            jobsBeforeContinue,
            baselineJobs,
            "native jobs changed before continuation",
          );
          assertStockJob(jobsBeforeContinue, false);
          stockPausedBeforeContinuation = true;
          const continued = await exec(f, identity, processProgram, {
            action: "continue",
            controlPath,
          });
          assert.ok(continued.deadlineEnforced === true, "the Pod-local deadline is required");
          continuationDeadlineEnforced = true;
          if (continued.continued === true) {
            await f.waitFor(
              "same Codex Agent Pod recovered",
              async () => readinessState(await getPod(f, agent, identity)) === "ready",
              60_000,
            );
            recovered = true;
          } else {
            assert.ok(!stopped && (continued.absent === true || continued.alreadyRunning === true));
          }
        } catch {
          quarantined = true;
          failures.push(
            new Error(
              "The disposable Codex fixture is quarantined because safe recovery was not proved.",
            ),
          );
        }
      }
    }
  }
  if (recovered) {
    try {
      await callbacks.readRequirements();
    } catch {
      failures.push(new Error("Recovered native automation requirements could not be verified."));
    }
  }
  if (postAttempted && recovered) {
    try {
      assertSameNativeJobs(
        await callbacks.nativeJobs(),
        baselineJobs,
        "readiness refusal changed native jobs",
      );
      nativeInventoryUnchanged = true;
    } catch {
      nativeInventoryUnchanged = false;
      failures.push(new Error("Readiness refusal left a changed native inventory."));
    }
    try {
      assert.ok(
        isDeepStrictEqual(await callbacks.pendingReservations(), baselinePending),
        "readiness refusal changed pending reservations",
      );
      pendingUnchanged = true;
    } catch {
      pendingUnchanged = false;
      failures.push(new Error("Readiness refusal left a changed pending reservation inventory."));
    }
    try {
      assert.equal(await callbacks.peerCalls(), baselinePeerCalls);
      peerCallsUnchanged = true;
    } catch {
      peerCallsUnchanged = false;
      failures.push(new Error("Readiness refusal changed the MCP peer effects."));
    }
    try {
      assert.ok((await callbacks.managedJobs()) === baselineManagedJobs);
      managedJobsUnchanged = true;
    } catch {
      failures.push(new Error("Readiness refusal changed OCC bindings."));
    }
  }
  if (
    recovered &&
    failures.length === 0 &&
    nativeInventoryUnchanged &&
    pendingUnchanged &&
    peerCallsUnchanged &&
    managedJobsUnchanged
  ) {
    try {
      assert.ok(
        originalJobs[0]!.nextRunAtMs !== null &&
          originalJobs[0]!.nextRunAtMs > Date.now() + restoredStockSafetyMs,
        "the original stock slot is too near to restore safely",
      );
      // Restore the exact original definition once with the paused CAS token.
      // The native token covers the complete stored definition and authority.
      restoreAttempted = true;
      const restoredRevision = await callbacks.setStockEnabled(baselineJobs[0]!, true);
      const restoredJobs = await callbacks.nativeJobs();
      assertStockJob(restoredJobs, true);
      assert.ok(
        restoredJobs[0]!.nextRunAtMs !== null &&
          restoredJobs[0]!.nextRunAtMs > Date.now() + restoredStockSafetyMs,
        "the restored stock task must remain idle for the matrix horizon",
      );
      stockJobSafeAfterRestore = true;
      assert.ok(
        restoredJobs[0]!.id === originalJobs[0]!.id,
        "the restored stock task identity changed",
      );
      assert.ok(
        restoredRevision === originalJobs[0]!.configRevision &&
          restoredJobs[0]!.configRevision === restoredRevision,
        "the original stock task definition was not restored",
      );
      assert.ok(
        restoredJobs[0]!.agentId === originalJobs[0]!.agentId &&
          restoredJobs[0]!.effectiveAgentId === originalJobs[0]!.effectiveAgentId,
        "the restored stock task execution identity changed",
      );
      stockRestored = true;
      assert.ok(
        (await callbacks.peerCalls()) === baselinePeerCalls,
        "stock restoration changed MCP effects",
      );
      assert.ok(
        isDeepStrictEqual(await callbacks.pendingReservations(), baselinePending),
        "stock restoration changed OCC reservations",
      );
      assert.ok(
        (await callbacks.managedJobs()) === baselineManagedJobs,
        "stock restoration changed OCC bindings",
      );
    } catch {
      if (restoreAttempted && !stockRestored) {
        restoreOutcomeObserved = await observeUncertainStock(callbacks, originalJobs[0]!);
        failures.push(new Error("Native stock task restoration is uncertain; do not replay it."));
      } else if (stockRestored) {
        failures.push(new Error("Post-restoration ownership or effect verification failed."));
      } else {
        failures.push(
          new Error("The stock task cannot be restored within the safe matrix horizon."),
        );
      }
      quarantined = true;
    }
  }
  if (pauseAttempted && !stockRestored && !quarantined) {
    quarantined = true;
    failures.push(
      new Error("The disposable Codex fixture requires teardown without native restoration."),
    );
  }
  const receipt = {
    revisionId: identity.revisionId,
    podUidHash: createHash("sha256").update(identity.uid).digest("hex"),
    imageIdHash: createHash("sha256").update(identity.imageId).digest("hex"),
    exactPodAndProcess: stopped && recovered,
    resident503,
    podUnready,
    denied,
    recovered,
    quarantined,
    stockMemoryBaseline: true,
    stockPaused,
    stockPausedBeforeContinuation,
    continuationDeadlineEnforced,
    restoreAttempted,
    stockRestored,
    stockJobSafeAfterRestore,
    pauseOutcomeObserved,
    restoreOutcomeObserved,
    managedJobsUnchanged,
    nativeInventoryUnchanged,
    pendingUnchanged,
    peerCallsUnchanged,
    proofValid:
      failures.length === 0 &&
      resident503 &&
      podUnready &&
      denied &&
      recovered &&
      !quarantined &&
      stockPaused &&
      stockPausedBeforeContinuation &&
      continuationDeadlineEnforced &&
      stockRestored &&
      stockJobSafeAfterRestore &&
      managedJobsUnchanged &&
      nativeInventoryUnchanged &&
      pendingUnchanged &&
      peerCallsUnchanged,
  };
  try {
    await f.record("automations-" + agent.id + "-readiness-refusal", receipt);
  } catch {
    failures.push(new Error("Readiness refusal evidence could not be recorded."));
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Codex readiness refusal or recovery failed.");
  }
}
