import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  copyFile,
  chmod,
  readFile,
  writeFile,
  stat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeAdminTarget } from "../../apps/controller/src/gateway/native-admin.ts";
import { renderPresetTemplate } from "../../packages/contracts/src/index.ts";
import { availablePort } from "./available-port.mjs";
import { createNativePluginAssertions } from "./plugin-driver-real.mjs";
import { prepareHybridInstallation } from "./qa-hybrid.mjs";
import { grantQaRepositoryBranch } from "./qa-repository.mjs";
import { loadYaml, dumpYaml, waitFor } from "./qa-utils.mjs";
import {
  protectedText,
  protectedModelApiKey,
  registerQaSecret,
  grantQaSecret,
  grantQaCredentialSource,
  qaCommandFailureDetail,
  redactedQaTail,
} from "./qa-secrets.mjs";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { maskPrivateKeyLines } from "../../scripts/ci/failure-redaction.mjs";

function execute(command, args, options) {
  const { input, allowExitCodes = [0], timeout = 0, ...rest } = options;
  assert.ok(Number.isInteger(timeout) && timeout >= 0, "command timeout must be non-negative");
  const started = performance.now();
  return new Promise((accept, reject) => {
    let timedOut = false;
    let timer;
    const fail = (error, stdout = "", stderr = "") =>
      reject(
        Object.assign(error, {
          stdout,
          stderr,
          timedOut,
          elapsedMs: Math.round(performance.now() - started),
          timeoutMs: timeout,
        }),
      );
    const child = execFile(command, args, rest, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (timedOut) {
        fail(
          error ??
            Object.assign(new Error("command deadline exceeded"), {
              code: child.exitCode,
              signal: child.signalCode,
            }),
          stdout,
          stderr,
        );
      } else if (error && !allowExitCodes.includes(error.code)) {
        fail(error, stdout, stderr);
      } else {
        accept({ stdout, stderr });
      }
    });
    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        // Match execFile's timeout teardown, but retain the deadline as the primary
        // cause even if writing to a closed pipe ends the child with SIGPIPE.
        child.stdout?.destroy();
        child.stderr?.destroy();
        try {
          child.kill(rest.killSignal ?? "SIGTERM");
        } catch (error) {
          fail(error);
        }
      }, timeout);
    }
    child.stdin.end(input);
  });
}
const repository = resolve(import.meta.dirname, "../..");
export function launcherEnvironment() {
  // Runtime credentials are delivered later through the Secret API. Never pass
  // the matrix's model, sender, or GitHub observer credentials to the launcher.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:OCC_|OPENAI_|CODEX_|SLACK_|GH_|GITHUB_TOKEN|OPENCLAW_DEV_)/.test(name),
    ),
  );
  for (const name of [
    "OCC_DEVELOPMENT_K3S_IMAGE",
    "OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR",
    "OCC_DEVELOPMENT_K3D_DNS_RESOLVER",
    "OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT",
    "NODE_BASE_IMAGE",
    "OCC_DEVELOPMENT_OPENSHELL_GATEWAY_IMAGE",
    "OCC_DEVELOPMENT_OPENSHELL_SANDBOX_IMAGE",
    "OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_IMAGE",
    "OCC_DEVELOPMENT_OPENSHELL_SOURCE_REVISION",
  ]) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }
  return env;
}

// The output of the image build step that failed, from a docker (BuildKit) or podman build's
// stderr, at most `lines` lines; undefined when stderr shows no failed image build. A failed
// build's own error keeps only its last lines, which name the step but not why it failed (an
// upstream test run inside the runtime image build, finding 2020). BuildKit prefixes every line
// of a step's output with "#<step> " and interleaves steps, so the failed step is the one whose
// "#<step> ERROR:" line comes last; without one (podman), the last lines of stderr. One dev-up can
// run several builds, each numbering its steps from #0, so only the last build is read: a build
// stops dev-up at its first failure.
export function imageBuildFailureOutput(stderr, { lines = 200 } = {}) {
  const text = String(stderr ?? "").trimEnd();
  // Newer buildx says "ERROR: failed to build: failed to solve: ...".
  if (!/^ERROR: (?:failed to build: )?failed to solve: |^Error: building at STEP /m.test(text)) {
    return undefined;
  }
  const all = text.split("\n");
  const first = Math.max(
    0,
    all.findLastIndex((line) =>
      /^#0 building with |^#1 \[internal\] load build definition/.test(line),
    ),
  );
  const build = all.slice(first);
  // Private keys are masked over all of stderr before the step and its last lines are cut out: a
  // key whose BEGIN line falls outside the cut would otherwise keep its body (finding 2026). As in
  // redactedQaTail, an unterminated BEGIN ... PRIVATE KEY line anywhere earlier masks everything
  // after it, the failed step included: the safe direction, so the evidence is then all markers.
  const masked = maskPrivateKeyLines(all).slice(first);
  const step = build.findLast((line) => /^#\d+ ERROR: /.test(line))?.match(/^#\d+ /)[0];
  return (step ? masked.filter((_, index) => build[index].startsWith(step)) : masked).slice(-lines);
}

// Records a failed image build step's output, redacted like any QA command output, as a QA
// evidence file (the cell uploads its *.json evidence; the private state directory is not
// uploaded). Returns the file's name, or undefined when stderr shows no failed image build.
export async function recordImageBuildFailure(record, stderr, env) {
  const output = imageBuildFailureOutput(stderr);
  if (output === undefined) {
    return undefined;
  }
  return record(`image-build-failure-${Date.now()}`, {
    lines: redactedQaTail(output.join("\n"), env, { lines: output.length, lineChars: 800 }),
  });
}

function startupCommandTimings(stdout) {
  // Only the fixed records emitted by internal/occdev/timing.go are public.
  // Do not retain free-form stdout, including unknown or malformed stage records.
  const pattern =
    /(?:^|\n)\[occ-dev-timing\] stage=(runtime-build|controller-build|compose-build-and-start|compose-build|image-pull|image-export|image-import|node-image-pull|cluster-create|k3d-image-import|kubernetes-readiness|helm-install) elapsed_ms=(0|[1-9][0-9]{0,15}) failed=(true|false)(?=\n|$)/g;
  const records = [];
  let omittedRecords = 0;
  for (const match of String(stdout ?? "").matchAll(pattern)) {
    if (!Number.isSafeInteger(Number(match[2]))) {
      continue;
    }
    records.push({ stage: match[1], elapsedMs: Number(match[2]), failed: match[3] === "true" });
    if (records.length > 64) {
      records.shift();
      omittedRecords++;
    }
  }
  return { records, omittedRecords };
}

// Runs one command of a QA installation `f` (its env, private directories, and evidence
// `record`). A failure writes the command's output to the private directory and throws with
// redacted stderr; failed image builds and selected startup timings become bounded evidence.
export async function runQaCommand(f, command, args, options = {}) {
  const {
    privateFailureOutput = false,
    captureStartupTimings = false,
    ...executeOptions
  } = options;
  try {
    const result = await execute(command, args, {
      cwd: repository,
      env: f.env,
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
      ...executeOptions,
    });
    return result.stdout;
  } catch (error) {
    await writeFile(
      join(f.directory, `command-failure-${Date.now()}.log`),
      privateFailureOutput
        ? "protected subprocess output withheld\n"
        : `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
      { mode: 0o600 },
    );
    if (f.credentials?.password) {
      registerQaSecret(f.credentials.password);
    }
    const detail = privateFailureOutput
      ? ""
      : qaCommandFailureDetail(error.stderr, executeOptions.env ?? f.env);
    const buildOutput = privateFailureOutput
      ? undefined
      : await recordImageBuildFailure(f.record, error.stderr, executeOptions.env ?? f.env).catch(
          (recordError) => `not recorded (${recordError?.message ?? recordError})`,
        );
    let startupTimings;
    if (captureStartupTimings && !privateFailureOutput) {
      const timings = startupCommandTimings(error.stdout);
      if (timings.records.length > 0) {
        try {
          startupTimings = await f.record(`startup-timings-${Date.now()}`, timings);
        } catch {
          // A failed artifact write must not replace the command failure or expose its path.
          startupTimings = "unavailable";
        }
      }
    }
    // execFile errors embed argv and output, potentially containing tokens.
    // Keep arguments and raw stdout private; include redacted stderr and evidence filenames.
    const timing = Number.isInteger(error.elapsedMs)
      ? ` after ${error.elapsedMs} ms (limit ${error.timeoutMs} ms)`
      : "";
    error.message = `${command.split("/").at(-1)} ${error.timedOut ? "timed out" : "failed"}${timing} (exit ${error.code ?? "unknown"}, signal ${error.signal ?? "none"}); private state: ${f.stateDirectory}${buildOutput ? `; failed image build step output: ${buildOutput}` : ""}${startupTimings ? `; startup timings: ${startupTimings}` : ""}${detail ? `; stderr: ${detail}` : ""}`;
    delete error.cmd;
    delete error.stdout;
    delete error.stderr;
    delete error.stack;
    throw error;
  }
}

// Error bodies stay in the private fixture directory. Cancel bounded reads and
// stop waiting after 3s, including a failed or stalled diagnostic write. The
// original API assertion is the only failure exposed to the matrix reporter.
async function captureQaApiRefusal(f, response) {
  let reader;
  let expired = false;
  let timer;
  const cancel = () => {
    try {
      reader?.cancel().catch(() => {});
    } catch {
      // A closed/failed body cannot change the original HTTP refusal.
    }
  };
  const capture = async () => {
    reader = response.body?.getReader();
    const chunks = [];
    let remaining = 64 * 1024;
    let truncated = false;
    if (reader) {
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done || expired) {
          break;
        }
        const chunk = value.subarray(0, remaining);
        chunks.push(chunk);
        remaining -= chunk.byteLength;
        if (remaining === 0) {
          truncated = true;
          cancel();
        }
      }
    }
    if (expired) {
      return;
    }
    let text = Buffer.concat(chunks).toString("utf8");
    let code = "unknown";
    if (!truncated) {
      try {
        // Separate envelope fields before line redaction so a credential on
        // one compact JSON line cannot hide an unrelated refusal code/path.
        const envelope = JSON.parse(text);
        const candidate = envelope.error?.code;
        if (typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)) {
          code = redactedQaTail(candidate, f.env, { lines: 1, lineChars: 80 }).join("");
        }
        text = JSON.stringify(envelope, null, 2);
      } catch {
        // Plain text and malformed JSON still receive the same redaction.
      }
      const formatted = Buffer.from(text);
      if (formatted.byteLength > 64 * 1024) {
        text = formatted.subarray(0, 64 * 1024).toString("utf8");
        truncated = true;
      }
    }
    if (truncated) {
      // Do not retain a partial final line: the cap might split a credential
      // that registered-value redaction could otherwise no longer recognize.
      text = text.slice(0, text.lastIndexOf("\n") + 1);
    }
    const redacted = redactedQaTail(text, f.env, { lines: 65_536, lineChars: 65_536 }).join("\n");
    if (!expired) {
      await f.write(
        `api-refusal-${randomUUID()}.log`,
        `HTTP ${response.status}\n${truncated ? "[response truncated at 64 KiB]\n" : ""}${redacted}\n`,
      );
    }
    return code;
  };
  try {
    return await Promise.race([
      capture().catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          cancel();
          resolve();
        }, 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    cancel();
  }
}

export async function requestQaApi(f, method, path, body) {
  const response = await fetch(f.apiUrl + path, {
    method,
    headers: {
      "x-api-key": f.serviceKey,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const code = (await captureQaApiRefusal(f, response).catch(() => {})) ?? "unknown";
    assert.ok(response.ok, `OCC ${method} ${path}: HTTP ${response.status} (${code})`);
  }
  const text = await response.text();
  return text ? JSON.parse(text).data : undefined;
}

// An initial supported Compose input, before dev-up renders its saved snapshot.
// Podman may reallocate dynamic addresses even when restarting the same container.
export function qaComposePeerNetwork(subnet) {
  assert.match(
    subnet,
    /^172\.(?:2[0-9]|3[01])\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])\.0\/24$/,
  );
  const prefix = subnet.slice(0, -4);
  return {
    services: Object.fromEntries(
      ["controller", "worker-kubernetes"].map((service, index) => [
        service,
        {
          networks: { development: { ipv4_address: `${prefix}${250 + index}` } },
        },
      ]),
    ),
  };
}

async function verifyQaComposePeers(f) {
  const definition = JSON.parse(await f.compose("config", "--format", "json"));
  for (const [service, expected] of Object.entries(f.composePeerNetwork.services)) {
    const address = expected.networks.development.ipv4_address;
    assert.equal(
      definition.services?.[service]?.networks?.development?.ipv4_address,
      address,
      "saved Compose input must retain the initial fixed QA client address",
    );
    const id = (await f.compose("ps", "-q", service)).trim();
    assert.ok(id, "fixed QA Compose client must be running");
    const [container] = JSON.parse(await f.run("docker", ["inspect", id]));
    assert.ok(
      Object.values(container.NetworkSettings.Networks).some(
        (network) => network.IPAddress === address,
      ),
      "running QA Compose client must retain its initial fixed peer address",
    );
  }
}

// TCP only: this neither sends credentials nor replaces TLS, enrollment or
// actual Agent readiness. It bounds a broken test front door before Agent work.
async function preflightQaComposeRoute(f) {
  const route = f.configuration.drivers.compute.configuration.gatewayRouting;
  if (!route) {
    return;
  }
  const port = route.endpointPort ?? 443;
  assert.ok(
    typeof route.hostname === "string" &&
      route.hostname.length > 0 &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535,
    "QA Gateway front door configuration is invalid.",
  );
  const script = `const net=require('node:net');const socket=net.connect({host:process.argv[1],port:Number(process.argv[2])});let done=false;function finish(code){if(done)return;done=true;socket.destroy();console.log(JSON.stringify({code}))}socket.setTimeout(3000);socket.once('connect',()=>finish('CONNECTED'));socket.once('timeout',()=>finish('TIMEOUT'));socket.once('error',e=>finish(['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EAI_AGAIN','ETIMEDOUT'].includes(e.code)?e.code:'UNAVAILABLE'));`;
  for (const service of ["controller", "worker-kubernetes"]) {
    let code = "EXEC_FAILED";
    try {
      const id = (await f.compose("ps", "-q", service)).trim();
      const result = JSON.parse(
        await f.run("docker", ["exec", id, "node", "-e", script, route.hostname, String(port)], {
          timeout: 10_000,
          maxBuffer: 4096,
          privateFailureOutput: true,
        }),
      );
      if (
        [
          "CONNECTED",
          "TIMEOUT",
          "ECONNREFUSED",
          "ECONNRESET",
          "EHOSTUNREACH",
          "ENETUNREACH",
          "ENOTFOUND",
          "EAI_AGAIN",
          "ETIMEDOUT",
          "UNAVAILABLE",
        ].includes(result.code)
      ) {
        code = result.code;
      }
    } catch {
      // Only a fixed diagnostic class may leave the private command owner.
    }
    assert.equal(code, "CONNECTED", `QA Gateway front door unavailable from ${service} (${code}).`);
  }
}

// The same mounted startup-file/recreation owner used by regular QA saves.
export async function saveQaComposeInstallation(f, configuration) {
  if (f.composePeerNetwork) {
    await verifyQaComposePeers(f);
    await preflightQaComposeRoute(f);
  }
  await writeFile(join(f.stateDirectory, "installation.yaml"), dumpYaml(configuration), {
    mode: 0o600,
  });
  f.configuration = configuration;
  await recreateQaComposeServices(f);
  if (f.composePeerNetwork) {
    await verifyQaComposePeers(f);
    await preflightQaComposeRoute(f);
  }
}

// Preserve the exited services' bounded logs before the installation scope tears
// them down. Diagnostics are redacted private files; they never replace the
// original health/startup failure or become uploaded QA evidence.
export async function recreateQaComposeServices(f) {
  try {
    await f.compose("up", "-d", "--no-deps", "--force-recreate", "controller", "worker-kubernetes");
  } catch (error) {
    for (const service of ["controller", "worker-kubernetes"]) {
      try {
        const output = await f.run(
          "docker",
          [
            "compose",
            "-p",
            f.cluster,
            "-f",
            join(f.stateDirectory, "compose.yaml"),
            ...(f.consoleThemeComposeFile === undefined ? [] : ["-f", f.consoleThemeComposeFile]),
            "logs",
            "--no-color",
            "--tail",
            "120",
            service,
          ],
          { timeout: 15_000, maxBuffer: 256 * 1024, privateFailureOutput: true },
        );
        await f.write(
          `compose-startup-${service}-${randomUUID()}.log`,
          redactedQaTail(output, f.env, { lines: 120, lineChars: 1000 }).join("\n") + "\n",
        );
      } catch {
        // A missing service, log timeout or failed private write must not hide
        // the owning Compose failure; continue collecting the other service.
      }
    }
    throw error;
  }
}

// Deploys a QA Agent's current configuration and waits for the deployment to succeed.
export async function deployQaAgentAndWait(
  f,
  agent,
  { timeout = 600_000, interval = 1000, now = () => Date.now() } = {},
) {
  const base = `/namespaces/${agent.namespaceId}/agents/${agent.id}`;
  agent.stopped = false;
  agent.revision = await f.api("POST", base + "/deploy");
  // A timeout names the deployment's last status and attempt, and how long it had that status
  // (finding 2106: six cells timed out at 600 s with no status).
  let last;
  let statusSince = now();
  const observeStatus = (value) => {
    if (value?.status !== last?.status) {
      statusSince = now();
    }
    last = value;
  };
  const status = await waitFor(
    "Agent deployment",
    async () => {
      const value = await f.api("GET", base + `/deployments/${agent.revision.id}`);
      observeStatus(value);
      if (value.error?.code === "RUNTIME_AUTHENTICATION_FAILED" && agent.preset === "OpenClaw") {
        // A failed deployment holds its Pod for diagnosis. Check delivery and
        // provider rejection there without exporting the Pod's credential.
        try {
          const data = JSON.parse(
            await f.kubectl(
              "get",
              "pods",
              "-A",
              "-l",
              `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${agent.revision.id},openclaw.dev/workload-role=gateway`,
              "-o",
              "json",
            ),
          );
          const pods = data.items.filter((pod) => !pod.metadata.deletionTimestamp);
          assert.equal(pods.length, 1);
          const [pod] = pods;
          const expected = createHash("sha256")
            .update(
              await protectedText(process.env.OCC_TEST_QA_OPENAI_KEY_FILE, "model credential"),
            )
            .digest("hex");
          const script = `
            const crypto = require('node:crypto');
            const key = process.env[process.env.OPENCLAW_HARNESS_CREDENTIAL_ENV] ?? '';
            const matchesInput = crypto.createHash('sha256').update(key).digest('hex') === process.argv[1];
            const allowed = new Set(['invalid_api_key', 'insufficient_quota', 'model_not_found', 'unsupported_country_region_territory', 'account_deactivated', 'permission_denied', 'missing_required_parameter', 'invalid_organization', 'project_not_found']);
            fetch('https://api.openai.com/v1/responses', {
              method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
              body: '{}', signal: AbortSignal.timeout(15000),
            }).then(async (response) => {
              const body = await response.json().catch(() => ({}));
              const code = body.error?.code;
              console.log(JSON.stringify({ credentialPresent: key.length > 0, matchesInput, httpStatus: response.status, code: allowed.has(code) ? code : 'other' }));
            }, () => console.log(JSON.stringify({ credentialPresent: key.length > 0, matchesInput, networkFailure: true })));
          `;
          const diagnostic = JSON.parse(
            await f.kubectl(
              "-n",
              pod.metadata.namespace,
              "exec",
              pod.metadata.name,
              "-c",
              "gateway",
              "--",
              "node",
              "-e",
              script,
              expected,
            ),
          );
          await f.record(`${agent.id}-${agent.revision.id}-authentication`, diagnostic);
        } catch {
          await f.record(`${agent.id}-${agent.revision.id}-authentication`, {
            unavailable: true,
          });
        }
      }
      // A failed startup model check names the provider's HTTP status and known
      // error code in its sanitized probe log record; CI shows them with the error.
      let probe = "";
      const component = value.error?.data?.runtimeFailure?.component;
      if (value.error?.code === "RUNTIME_MODEL_PROBE_FAILED" && component) {
        try {
          const logs = await f.api(
            "GET",
            base +
              `/deployments/${agent.revision.id}/runtime/logs?source=${component}&minLevel=error`,
          );
          const record = logs.records.findLast(({ message }) => message?.endsWith(".model_probe"));
          probe = record ? ` probe log: ${JSON.stringify(record.fields ?? {})}` : "";
        } catch {
          probe = " probe log: unavailable";
        }
      }
      assert.ok(
        !["failed", "cancelled"].includes(value.status),
        `Agent deployment ${value.status}: ${JSON.stringify(value.error)}${probe}`,
      );
      return value.status === "succeeded" && value;
    },
    timeout,
    {
      describe: () => describeDeploymentObservation(last, now() - statusSince),
      interval,
      now,
    },
  ).catch(async (error) => {
    // The deployment's Pods, when it has any, show whether it waited on scheduling, an image
    // or a container that does not start.
    if (/^Timed out: /.test(error.message)) {
      try {
        const runtime = await f.api("GET", base + `/deployments/${agent.revision.id}/runtime`);
        error.message += `; runtime: ${describeDeploymentRuntime(runtime)}`;
      } catch (runtimeError) {
        error.message += `; runtime unavailable (${runtimeError?.message ?? runtimeError})`;
      }
    }
    throw error;
  });
  await f.record(`${agent.preset}-${agent.id}-${agent.revision.id}-deployment`, {
    agentId: agent.id,
    revisionId: agent.revision.id,
    status,
  });
  return { revision: agent.revision, status };
}

// The last deployment observation, without native text: the API returns allowlisted codes and
// messages only.
export function describeDeploymentObservation(value, statusForMs) {
  if (!value) {
    return "none";
  }
  return JSON.stringify({
    status: value.status,
    statusForMs,
    lastAttempt: value.progress?.lastAttempt ?? null,
    nextAttemptAt: value.progress?.nextAttemptAt ?? null,
    error: value.error?.code ?? null,
  });
}

// Runtime text reaches the API as Kubernetes sent it, and OCC may shorten it there. QA
// redaction replaces whole registered values, so a shortened string could keep part of one.
// The timeout therefore names only familiar Kubernetes words and says "other" for the rest;
// event messages are left out.
const familiarPodPhases = new Set(["Pending", "Running", "Succeeded", "Failed", "Unknown"]);
const familiarContainerReasons = new Set([
  "ContainerCreating",
  "PodInitializing",
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "ErrImageNeverPull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "PreStartHookError",
  "PostStartHookError",
  "StartError",
  "ContainerCannotRun",
  "ContainerStatusUnknown",
  "Completed",
  "Error",
  "OOMKilled",
  "DeadlineExceeded",
]);
const familiarEventReasons = new Set([
  "FailedScheduling",
  "FailedMount",
  "FailedAttachVolume",
  "FailedCreatePodSandBox",
  "FailedKillPod",
  "FailedPreStopHook",
  "FailedPostStartHook",
  "FailedSync",
  "FailedCreate",
  "Failed",
  "BackOff",
  "Unhealthy",
  "ProbeWarning",
  "InspectFailed",
  "ErrImageNeverPull",
  "NetworkNotReady",
  "Evicted",
  "NodeNotReady",
  "OutOfmemory",
  "OutOfcpu",
]);

function familiar(words, value) {
  return value === null || value === undefined || words.has(value) ? value : "other";
}

export function describeDeploymentRuntime(runtime) {
  const pods = (runtime?.pods ?? []).slice(0, 4).map((pod) => ({
    role: pod.role,
    phase: familiar(familiarPodPhases, pod.phase),
    ready: pod.ready,
    containers: (pod.containers ?? []).map(({ name, state, reason, restartCount }) => ({
      name,
      state,
      reason: familiar(familiarContainerReasons, reason),
      restartCount,
    })),
    // The API lists events newest first.
    warnings: (pod.events ?? [])
      .filter(({ type }) => type === "Warning")
      .slice(0, 3)
      .map(({ reason, count }) => ({ reason: familiar(familiarEventReasons, reason), count })),
  }));
  return JSON.stringify({
    pods,
    ...(runtime?.harness ? { harness: runtime.harness } : {}),
  });
}

export async function createQaInstallation(
  context,
  controlPlane,
  artifacts,
  {
    repositoryInputs = true,
    sandboxDriver = "none",
    sandboxNetworkPolicyFile = undefined,
    stableComposePeers = false,
  } = {},
) {
  assert.ok(["compose", "kubernetes"].includes(controlPlane));
  assert.ok(["none", "openshell"].includes(sandboxDriver));
  const suffix = randomUUID().slice(0, 8);
  const cluster = `occ-dev-qa-${controlPlane === "compose" ? "c" : "k"}-${suffix}`;
  const directory = await mkdtemp(join(await realpath(tmpdir()), `${cluster}-`));
  const stateDirectory = join(directory, "state");
  const ports = new Set();
  while (ports.size < 4) {
    ports.add(await availablePort());
  }
  const [apiPort, kubePort, browserPort, postgresPort] = [...ports];
  const env = {
    ...launcherEnvironment(),
    OPENCLAW_DEV_PORT: String(apiPort),
    OCC_POSTGRES_PORT: String(postgresPort),
    OCC_DEVELOPMENT_BROWSER_PORT: String(browserPort),
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    OCC_DEVELOPMENT_CONTROL_PLANE: controlPlane,
    OCC_DEVELOPMENT_SANDBOX_DRIVER: sandboxDriver,
    OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
    OCC_DEVELOPMENT_COMPOSE_PROJECT: cluster,
    OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
    OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
    OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubePort),
    OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "900",
  };
  for (const [key, input] of [
    ["OCC_DEVELOPMENT_CONTROLLER_IMAGE", "OCC_TEST_QA_CONTROLLER_IMAGE"],
    ["OCC_KUBERNETES_RUNTIME_IMAGE", "OCC_TEST_QA_RUNTIME_IMAGE"],
    ["OCC_DEVELOPMENT_REPOSITORY_IMAGE", "OCC_TEST_QA_REPOSITORY_IMAGE"],
  ]) {
    if (process.env[input]) {
      env[key] = process.env[input];
    }
  }
  let repositoryInput;
  const sourceInput = repositoryInputs
    ? process.env.OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY
    : undefined;
  if (sourceInput) {
    repositoryInput = join(directory, "repository-input");
    await mkdir(repositoryInput, { mode: 0o700 });
    const registry = JSON.parse(
      await protectedText(join(sourceInput, "registry.json"), "repository registry"),
    );
    grantQaRepositoryBranch(registry, suffix);
    await writeFile(join(repositoryInput, "registry.json"), JSON.stringify(registry), {
      mode: 0o600,
    });
    for (const name of ["private-key.pem", "upstream-cidrs.json"]) {
      await copyFile(join(sourceInput, name), join(repositoryInput, name));
      await chmod(join(repositoryInput, name), 0o600);
    }
    if (controlPlane === "kubernetes") {
      env.OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY = repositoryInput;
    }
  }
  assert.ok(!stableComposePeers || controlPlane === "compose", "fixed QA peers require Compose");
  const f = {
    controlPlane,
    directory,
    stateDirectory,
    repositoryInput,
    suffix,
    cluster,
    env,
    apiPort,
    browserPort,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    agents: [],
    forwards: [],
    retained: false,
    pendingRepositories: new Set(),
    resources: createResourceScope({ cleanupTimeoutMs: 600_000 }),
    async record(name, value) {
      // API results are evidence only: a fixed JSON suffix, a confined basename,
      // and exclusive creation prevent replacing files or following symlinks.
      const file = `${controlPlane}-${name.replaceAll(/[^a-zA-Z0-9-]/g, "-")}.json`;
      await writeFile(join(artifacts, file), JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      return file;
    },
    async run(command, args, options = {}) {
      return runQaCommand(f, command, args, options);
    },
    async write(name, value) {
      const path = join(directory, name);
      await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), {
        mode: 0o600,
      });
      return path;
    },
    async kubectl(...args) {
      return f.run("kubectl", [
        "--kubeconfig",
        join(stateDirectory, "kubeconfig"),
        "--context",
        `k3d-${cluster}`,
        ...args,
      ]);
    },
    async get(kind, name, namespace) {
      return f.resource(kind, name, namespace);
    },
    waitFor,
    async resource(kind, name, namespace) {
      return JSON.parse(
        await f.kubectl(...(namespace ? ["-n", namespace] : []), "get", kind, name, "-o", "json"),
      );
    },
    async apply(object) {
      const path = await f.write(`apply-${randomUUID()}.json`, object);
      await f.kubectl("apply", "-f", path);
    },
    async api(method, path, body) {
      return requestQaApi(f, method, path, body);
    },
    async compose(...args) {
      return f.run("docker", [
        "compose",
        "-p",
        cluster,
        "-f",
        join(stateDirectory, "compose.yaml"),
        ...(f.consoleThemeComposeFile === undefined ? [] : ["-f", f.consoleThemeComposeFile]),
        ...args,
      ]);
    },
    async saveInstallation(configuration) {
      if (controlPlane === "compose") {
        await saveQaComposeInstallation(f, configuration);
      } else {
        await writeFile(join(stateDirectory, "installation.yaml"), dumpYaml(configuration), {
          mode: 0o600,
        });
        f.configuration = configuration;
        await f.apply({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: "occ-installation-startup", namespace: f.state.platformNamespace },
          stringData: { "installation.yaml": dumpYaml(configuration) },
        });
        for (const name of ["openclaw-enterprise-api", "openclaw-enterprise-worker"]) {
          await f.kubectl(
            "-n",
            f.state.platformNamespace,
            "rollout",
            "restart",
            `deployment/${name}`,
          );
          await f.kubectl(
            "-n",
            f.state.platformNamespace,
            "rollout",
            "status",
            `deployment/${name}`,
            "--timeout=300s",
          );
        }
      }
      await f.afterSaveInstallation?.();
      await waitFor("OCC after configuration", async () => {
        try {
          return await f.api("GET", "/installation");
        } catch {
          return undefined;
        }
      });
    },
    async pods(agent, role) {
      const data = JSON.parse(
        await f.kubectl(
          "get",
          "pods",
          "-A",
          "-l",
          `openclaw.dev/agent=${agent.id},openclaw.dev/workload-role=${role}`,
          "-o",
          "json",
        ),
      );
      return data.items.filter(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          pod.metadata.labels["openclaw.dev/revision"] === agent.revision.id &&
          pod.status.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
      );
    },
    async pod(agent, role) {
      const pods = await f.pods(agent, role);
      assert.equal(pods.length, 1, `one Ready ${role} Pod must belong to the exact Agent revision`);
      return pods[0];
    },
    async execRole(agent, role, args) {
      const pod = await f.pod(agent, role);
      return {
        stdout: await f.kubectl(
          "-n",
          pod.metadata.namespace,
          "exec",
          pod.metadata.name,
          "-c",
          role,
          "--",
          ...args,
        ),
        label: pod.metadata.uid,
      };
    },
    async gatewayUrl(agent) {
      const pod = await f.pod(agent, "gateway");
      const port = await availablePort();
      const child = spawn(
        "kubectl",
        [
          "--kubeconfig",
          join(stateDirectory, "kubeconfig"),
          "--context",
          `k3d-${cluster}`,
          "-n",
          pod.metadata.namespace,
          "port-forward",
          "--address",
          "127.0.0.1",
          `pod/${pod.metadata.name}`,
          `${port}:http`,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      f.forwards.push(child);
      await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error("gateway forward timed out")), 30_000);
        child.once("error", reject);
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("gateway forward exited"));
        });
        child.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("Forwarding from")) {
            clearTimeout(timer);
            accept();
          }
        });
      });
      const secretName = pod.spec.containers
        .find((c) => c.name === "gateway")
        .env.find((item) => item.name === "OPENCLAW_GATEWAY_PASSWORD").valueFrom.secretKeyRef;
      const secret = await f.resource("secret", secretName.name, pod.metadata.namespace);
      const gatewayPassword = Buffer.from(secret.data[secretName.key], "base64").toString();
      registerQaSecret(gatewayPassword);
      return {
        url: `http://127.0.0.1:${port}`,
        gatewayPassword,
        pod,
        close: async () => {
          child.kill("SIGTERM");
        },
      };
    },
    async deployAndWait(agent) {
      return deployQaAgentAndWait(f, agent);
    },
  };
  // One resource scope attempts every cleanup, even when the installation
  // must be retained. Later-acquired browsers, trust entries, and relays close first.
  context.after(() => f.resources.close());
  f.resources.after(async () => {
    for (const child of f.forwards) {
      child.kill("SIGTERM");
    }
    for (const agent of f.agents) {
      if (agent.stopped) {
        continue;
      }
      try {
        await f.api("POST", `/namespaces/${agent.namespaceId}/agents/${agent.id}/stop`);
        await waitFor(
          "Agent stop",
          async () =>
            !(await f.api("GET", `/namespaces/${agent.namespaceId}/agents/${agent.id}`))
              .activeRevisionId,
        );
      } catch {
        f.retained = true;
      }
    }
    // Every in-flight repository Agent owns a cleanup obligation. One successful
    // worker must never clear another worker's uncertain session.
    if (f.retained || f.pendingRepositories.size > 0) {
      throw new Error(
        `QA cleanup requires recovery; retained owned installation at ${stateDirectory}`,
      );
    }
    try {
      await stat(join(stateDirectory, "state.json"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    await f.run(join(repository, "scripts/dev-down"), [], { timeout: 300_000 });
    await f.cleanupRepositoryInputs?.();
  });
  await f.record("ownership", {
    cluster,
    stateDirectory,
    controlPlane,
    base: process.env.OCC_TEST_QA_SOURCE_SHA ?? "working-tree",
  });
  if (controlPlane === "compose") {
    const ids = (await f.run("docker", ["network", "ls", "-q"]))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const networks = ids.length
      ? JSON.parse(await f.run("docker", ["network", "inspect", ...ids]))
      : [];
    const occupied = networks
      .flatMap((network) => network.IPAM?.Config ?? [])
      .map((config) => config.Subnet)
      .filter((cidr) => cidr?.includes("."));
    const range = (cidr) => {
      const [address, bits] = cidr.split("/");
      const number = address.split(".").reduce((value, octet) => (value << 8n) + BigInt(octet), 0n);
      const size = 1n << (32n - BigInt(bits));
      return [(number / size) * size, (number / size) * size + size - 1n];
    };
    const free = (cidr) => {
      const [start, end] = range(cidr);
      return occupied.every((value) => {
        const [a, b] = range(value);
        return end < a || start > b;
      });
    };
    let subnet;
    for (let second = 20; second <= 31 && !subnet; second += 1) {
      for (let third = 1; third < 255 && !subnet; third += 1) {
        const candidate = `172.${second}.${third}.0/24`;
        if (free(candidate)) {
          subnet = candidate;
        }
      }
    }
    assert.ok(subnet, "no unused private Compose subnet available");
    env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR = subnet;
    await f.record("compose-network", { subnet });
    if (stableComposePeers) {
      f.composePeerNetwork = qaComposePeerNetwork(subnet);
      f.composePeerInput = await f.write(
        "compose-fixed-peers.yaml",
        dumpYaml(f.composePeerNetwork),
      );
    }
  }
  const launchArgs = sandboxNetworkPolicyFile
    ? ["--sandbox-network-policy-file", sandboxNetworkPolicyFile]
    : [];
  if (f.composePeerInput) {
    launchArgs.push("--", "-f", f.composePeerInput);
  }
  const started = await f.run(join(repository, "scripts/dev-up"), launchArgs, {
    timeout: 1_100_000,
    captureStartupTimings: true,
  });
  assert.match(
    started,
    controlPlane === "compose" ? /Control plane: Compose/ : /Deployment: Kubernetes only/,
  );
  f.state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
  assert.equal(f.state.cluster, cluster);
  assert.equal(f.state.sandboxDriver, sandboxDriver);
  // Continue against the exact endpoint chosen and recorded by dev-up.
  env.DOCKER_HOST = f.state.dockerHost;
  if (f.state.containerEngine === "podman") {
    env.CONTAINER_HOST = f.state.dockerHost;
    delete env.CONTAINER_CONNECTION;
  }
  f.serviceKey = JSON.parse(
    await protectedText(join(stateDirectory, "initial-admin-service-key.json"), "bootstrap key"),
  ).data.key;
  registerQaSecret(f.serviceKey);
  f.installation = await f.api("GET", "/installation");
  f.defaultNamespace = await waitFor("default Namespace ready after shipped startup", async () => {
    const namespace = (await f.api("GET", "/namespaces")).find((ns) => ns.name === "default");
    return namespace?.status === "ready" && namespace;
  });
  f.presets = await f.api("GET", `/namespaces/${f.defaultNamespace.id}/presets`);
  if (sandboxDriver === "none") {
    assert.deepEqual(f.presets.map((p) => p.name).sort(), [
      "Standard Codex",
      "Standard OpenClaw",
      "default-codex",
    ]);
  }
  f.configuration = loadYaml(await readFile(join(stateDirectory, "installation.yaml"), "utf8"));
  // dev-up folds ordered initial -f inputs into this one saved snapshot. All
  // later config/recreation/cleanup operations consume that same snapshot.
  if (f.composePeerNetwork) {
    await verifyQaComposePeers(f);
  }
  f.namespace = f.defaultNamespace;
  if (controlPlane === "compose") {
    await prepareHybridInstallation(f);
  } else {
    f.consoleUrl = `https://console.${cluster}.oce.localhost:${browserPort}`;
    f.browserCA = join(stateDirectory, "browser-ca.crt");
    f.credentials = {
      email: "admin@development.openclaw.invalid",
      password: await protectedText(
        join(stateDirectory, "initial-admin-password"),
        "bootstrap password",
      ),
    };
  }
  registerQaSecret(f.credentials.password);
  await f.record("startup", {
    installationId: f.installation.id,
    defaultNamespaceId: f.defaultNamespace.id,
    namespaceId: f.namespace.id,
    presets: f.presets.map(({ id, name }) => ({ id, name })),
    sandboxDriver,
  });
  return f;
}

export async function prepareQaConsoleTheme(f) {
  const themeDirectory = join(f.directory, "console-theme");
  await mkdir(themeDirectory);
  for (const name of ["theme.json", "logo.png"]) {
    await copyFile(
      join(repository, "deploy/examples/console-theme", name),
      join(themeDirectory, name),
    );
  }
  if (f.controlPlane === "compose") {
    f.consoleThemeComposeFile = await f.write("console-theme.compose.json", {
      services: {
        controller: {
          environment: { OCC_CONSOLE_THEME_DIR: "/etc/openclaw/console-theme" },
          volumes: [
            {
              type: "bind",
              source: themeDirectory,
              target: "/etc/openclaw/console-theme",
              read_only: true,
            },
          ],
        },
      },
    });
    await f.compose("up", "-d", "--no-deps", "--force-recreate", "controller");
  } else {
    const namespace = f.state.platformNamespace;
    await f.apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "qa-console-theme", namespace },
      data: { "theme.json": await readFile(join(themeDirectory, "theme.json"), "utf8") },
      binaryData: {
        "logo.png": (await readFile(join(themeDirectory, "logo.png"))).toString("base64"),
      },
    });
    await f.run("helm", [
      "upgrade",
      "openclaw-enterprise",
      join(repository, "deploy/helm/openclaw-enterprise"),
      "--kubeconfig",
      join(f.stateDirectory, "kubeconfig"),
      "--kube-context",
      `k3d-${f.cluster}`,
      "--namespace",
      namespace,
      "--reuse-values",
      "--set",
      "api.consoleTheme.configMapName=qa-console-theme",
      "--set-string",
      "api.consoleTheme.checksum=qa-first",
    ]);
    await f.kubectl(
      "-n",
      namespace,
      "rollout",
      "status",
      "deployment/openclaw-enterprise-api",
      "--timeout=300s",
    );
  }
  await waitFor("mounted console theme after API restart", async () => {
    try {
      const response = await fetch(f.apiUrl + "/console/login");
      return response.ok && (await response.text()).includes("<title>Example Agents</title>");
    } catch {
      return false;
    }
  });
}

export async function prepareQaPluginCatalogs(f, { includeDefaults = false } = {}) {
  assert.ok(
    !f.retained && f.pendingRepositories.size === 0,
    "blocked by unresolved repository cleanup",
  );
  assert.ok(
    f.agents.every((agent) => agent.stopped),
    "stop the prior Agent before changing the installation runtime configuration",
  );
  f.configuration.drivers.plugin = [
    { id: "occ-plugin", configuration: {} },
    { id: "codex-plugin", configuration: { catalogSource: "openai-curated" } },
  ];
  if (includeDefaults) {
    f.configuration.presets = { ...f.configuration.presets, includeDefaults: true };
  }
  await f.saveInstallation(f.configuration);
  if (includeDefaults) {
    // Startup seeds the selected Namespace; use its actual post-save catalog.
    f.presets = await f.api("GET", `/namespaces/${f.namespace.id}/presets`);
  }
  const { capabilities } = await f.api("GET", "/installation");
  const catalogs = Object.fromEntries(
    capabilities.pluginCatalogs.map(({ harnessId, pluginPolicies }) => [
      harnessId,
      pluginPolicies.driver.id,
    ]),
  );
  assert.deepEqual(catalogs, { openclaw: "occ-plugin", codex: "codex-plugin" });
  for (const [harnessId, q, expectedId] of [
    ["openclaw", "Google Workspace", "occ-plugin:google@1.0.0"],
    ["codex", "Linear", "codex-plugin:linear@openai-curated-remote"],
  ]) {
    const { plugins } = await f.api("POST", `/namespaces/${f.namespace.id}/agents/plugins`, {
      harnessId,
      q,
    });
    assert.ok(
      plugins.some(({ id }) => id === expectedId),
      `missing ${expectedId} in the ${harnessId} catalog`,
    );
  }
  await f.record("plugin-catalogs", catalogs);
}

export async function createQaAgent(
  f,
  presetName,
  browserOrigin,
  nameSuffix = "",
  { apiKeyAuth = false, configureValues = undefined } = {},
) {
  assert.ok(!f.retained, "unresolved repository cleanup prevents new Agent work");
  // The Preset list returns summaries; the exact Preset carries the template.
  const selected = f.presets.find((value) => value.name === `Standard ${presetName}`);
  assert.ok(selected, `Standard ${presetName} Preset must be available`);
  assert.equal(selected.namespaceId, f.namespace.id, "Preset must belong to the QA Namespace");
  const preset = await f.api("GET", `/namespaces/${selected.namespaceId}/presets/${selected.id}`);
  const codex = presetName === "Codex";
  const codexAccountLogin = codex && !apiKeyAuth;
  const credential = apiKeyAuth
    ? await protectedModelApiKey()
    : await protectedText(
        process.env[
          codexAccountLogin ? "OCC_TEST_QA_CODEX_TOKEN_FILE" : "OCC_TEST_QA_OPENAI_KEY_FILE"
        ],
        "model credential",
      );
  const model =
    process.env[codex ? "OCC_TEST_QA_CODEX_MODEL" : "OCC_TEST_QA_OPENAI_MODEL"] || "gpt-6-luna";
  const rendered = renderPresetTemplate(preset.template, {
    name: `qa-${f.suffix}-${presetName}${nameSuffix}`,
    model,
    modelSecret: "provided-through-secret-api",
  });
  const values = rendered.configuration.values;
  const pluginDriverId = codex ? "codex-plugin" : "occ-plugin";
  assert.ok(
    f.configuration.drivers.plugin?.some(({ id }) => id === pluginDriverId),
    "prepare the preset before starting parallel Agent scenarios",
  );
  values.gateway.http = { endpoints: { chatCompletions: { enabled: true } } };
  values.gateway.controlUi = {
    ...values.gateway.controlUi,
    ...(browserOrigin ? { allowedOrigins: [browserOrigin] } : {}),
  };
  values.agents.defaults.skipBootstrap = true;
  configureValues?.(values);
  const secret = await f.api("POST", `/namespaces/${f.namespace.id}/secrets`, {
    name: `${rendered.agent.name}-model`,
    value: credential,
  });
  let credentialSource;
  if (f.configuration.drivers.credential_gateway !== undefined) {
    const modelProvider = f.configuration.drivers.compute?.configuration?.runtime?.modelProvider;
    credentialSource = await f.api("POST", `/namespaces/${f.namespace.id}/credential-sources`, {
      name: `${rendered.agent.name}-model`,
      type: codexAccountLogin ? "codex-pat" : "openai",
      config:
        !codexAccountLogin && modelProvider?.baseUrl !== undefined
          ? { authorized_base_url: modelProvider.baseUrl }
          : {},
      secrets: { [codexAccountLogin ? "access_token" : "api_key"]: secret.ref },
    });
    assert.equal(credentialSource.state, "ready", "model credential source must be ready");
    assert.equal(credentialSource.ownerCapability, "credential_gateway");
  }
  const auth = credentialSource
    ? { method: "credential_source", sourceId: credentialSource.id }
    : {
        method: codexAccountLogin ? "codex_pat" : "api_key",
        source: { kind: "secret", namespaceId: f.namespace.id, id: secret.id },
      };
  const configuration = await f.api("POST", `/namespaces/${f.namespace.id}/configurations`, {
    ...rendered.configuration,
    kind: "agent",
  });
  const agent = await f.api("POST", `/namespaces/${f.namespace.id}/agents`, {
    ...rendered.agent,
    configurationId: configuration.id,
    harnessAuth: auth,
    ...(credentialSource
      ? {
          credentialSources: [
            ...(rendered.agent.credentialSources ?? []),
            { sourceId: credentialSource.id },
          ],
        }
      : {}),
  });
  f.agents.push(agent);

  agent.preset = presetName;
  agent.qaScenario = nameSuffix;
  agent.configuration = configuration;
  agent.harnessAuth = auth;
  if (f.controlPlane === "kubernetes") {
    const target = nativeAdminTarget({
      publicOrigin: f.consoleUrl,
      installationId: f.installation.id,
      agent,
      domain: `agents.${f.cluster}.oce.localhost`,
    });
    values.gateway.controlUi = {
      ...values.gateway.controlUi,
      enabled: true,
      allowedOrigins: [target.origin],
    };
    // Apply the supported native-admin opt-in from the deployment guide. The
    // compute Driver's runtime defaults do not change the admitted revision.
    values.gateway.auth = {
      ...values.gateway.auth,
      mode: "trusted-proxy",
      identityScopes: { "occ-workspace-files": ["operator.admin"] },
      trustedProxy: {
        ...values.gateway.auth.trustedProxy,
        userHeader: "x-occ-identity",
        allowUsers: ["occ-workspace-files"],
        deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
      },
    };
    // Later provider changes must start from the admitted native-admin configuration.
    agent.configuration = await f.api(
      "PATCH",
      `/namespaces/${f.namespace.id}/configurations/${configuration.id}`,
      { values },
    );
  }
  if (credentialSource) {
    await grantQaCredentialSource(f, agent, credentialSource.id, `${agent.name}-model`);
  } else {
    await grantQaSecret(f, agent, secret.id, `${agent.name}-model`);
  }
  await f.api("POST", `/namespaces/${f.namespace.id}/agents/${agent.id}/runtime-credentials`, {});
  await f.deployAndWait(agent);

  agent.native = createNativePluginAssertions({
    gatewayUrl: (a) => f.gatewayUrl(a),
    execGateway: (a, args) => f.execRole(a, "gateway", args),
    execCodex: (a, args) => f.execRole(a, "agent", args),
    waitFor,
    proofMode: codex ? "codex" : "openclaw",
    readRuntimeLogs: ({ namespaceId, agentId, revisionId, source }) =>
      f.api(
        "GET",
        `/namespaces/${namespaceId}/agents/${agentId}/deployments/${revisionId}/runtime/logs?source=${source}&tailLines=100`,
      ),
    recordRuntimeLogs: (record) =>
      f.record(`${record.agentId}-${record.revisionId}-turn-failure-logs-${randomUUID()}`, record),
  });
  return agent;
}

export { repository };
