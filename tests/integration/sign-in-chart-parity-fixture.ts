import assert from "node:assert/strict";
import { execFile, type ExecFileException } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { startApi, startupFailureFields } from "../../apps/controller/src/api-startup.ts";
import { humanLoginConfiguration } from "../../apps/controller/src/auth/index.ts";
import {
  bootstrapConfiguration,
  bootstrapFailureCode,
} from "../../scripts/lib/bootstrap-configuration.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { settled } from "../helpers/child-processes.mjs";
import { jsonLines } from "../helpers/json-lines.mjs";
import type { ChartValues } from "../helpers/production-chart-network-fixture.ts";
import {
  chartRefusal,
  chartTooling,
  deploymentEnv,
  loginEgress,
  renderChart,
  repository,
  signInSettings,
  trustedProxyNoticeRenderer,
  type SignInSettings,
} from "../helpers/sign-in-chart.ts";

export const tooling = await chartTooling();
export const recoveryUserId = "Pq7rS2tU9vW4xY1z";
export const secrets = {
  "occ-auth/secret": "chart-parity-auth-secret-at-least-32-characters",
  "occ-google-login/client-id": "chart-parity-google-client-id.apps.googleusercontent.com",
  "occ-google-login/client-secret": "chart-parity-google-client-secret",
  "occ-oidc-login/client-id": "chart-parity-oidc-client-id",
  "occ-oidc-login/client-secret": "chart-parity-oidc-client-secret",
};
// What the API parses from the rendered Google sign-in settings.
export const googleParsed = {
  clientId: secrets["occ-google-login/client-id"],
  clientSecret: secrets["occ-google-login/client-secret"],
  allowedDomains: [],
  recoveryUserId,
};

const fixtureSecrets: Readonly<Record<string, string>> = secrets;

export function resolveSecrets(settings: SignInSettings): Record<string, string> {
  return Object.fromEntries(
    Object.entries(settings).map(([name, value]) => {
      if (typeof value === "string") {
        return [name, value];
      }
      const { name: secret, key } = value.secretKeyRef;
      const resolved = fixtureSecrets[`${secret}/${key}`];
      assert.ok(resolved !== undefined, `Missing fixture Secret ${secret}/${key}.`);
      return [name, resolved];
    }),
  );
}

export async function settle<const T extends readonly unknown[]>(promises: T) {
  // Drain all siblings on failure before the suite removes shared inputs.
  await settled(promises);
  return Promise.all(promises);
}

// At most one child process per CPU (and at least two) across the whole file; a render holds
// one slot for helm and then yq, and an entrypoint start holds one until it exits.
const slots = Math.max(2, availableParallelism());
const waiting: (() => void)[] = [];
let running = 0;
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running < slots) {
    running += 1;
  } else {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      running -= 1;
    }
  }
}
export const render = (values: ChartValues) => limited(() => renderChart(values));
export const refusal = (values: ChartValues) => limited(() => chartRefusal(values));

// One workspace for every API start: the Installation file, the gateway key the chart mounts,
// and the chart copy that renders the install notes.
const directory = await mkdtemp(join(tmpdir(), "occ-sign-in-chart-parity-"));
after(() => rm(directory, { recursive: true, force: true }));
await writeFile(
  join(directory, "installation.yaml"),
  JSON.stringify(createInstallationDriverConfiguration()),
);
await writeFile(join(directory, "gateway-key"), "occ_chart_parity_gateway_key", { mode: 0o600 });
const noticeRenderer = trustedProxyNoticeRenderer(directory);
export const notice = (values: ChartValues = {}) => limited(() => noticeRenderer(values));

const unreachableDatabase = "postgresql://127.0.0.1:1/occ";
export function definedOnly(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      defined[name] = value;
    }
  }
  return defined;
}

// The API Pod's environment with the rendered settings, in production with an unreachable
// database.
export function apiEnvironment(settings: NodeJS.ProcessEnv) {
  return definedOnly({
    NODE_ENV: "production",
    OCC_DATABASE_URL: unreachableDatabase,
    OCC_CONFIG_PATH: join(directory, "installation.yaml"),
    OCC_HOST: "192.0.2.10",
    OCC_PORT: "8080",
    ...settings,
    // The chart mounts the gateway key Secret here; the test supplies a private file.
    ...(settings.OCC_GATEWAY_API_KEY_PATH === undefined
      ? {}
      : { OCC_GATEWAY_API_KEY_PATH: join(directory, "gateway-key") }),
  });
}

// The bootstrap Job's environment, as the chart's Job runs it (NODE_ENV=production).
export function jobEnvironment(baseUrl: string) {
  return {
    NODE_ENV: "production",
    OCC_DATABASE_URL: unreachableDatabase,
    OCC_AUTH_SECRET: secrets["occ-auth/secret"],
    OCC_AUTH_BASE_URL: baseUrl,
    OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.example.internal",
    OCC_BOOTSTRAP_ADMIN_EMAIL: "admin@oce.example.internal",
  };
}

// Runs the API's startup in process: startApi, which server.mjs runs with process.env. Its
// database is unreachable, so accepted settings end at PERSISTENCE_UNAVAILABLE, after
// configuration parsing, Driver loading and composition checks; refused settings end earlier
// with another startup code.
export async function startupCode(settings: NodeJS.ProcessEnv) {
  try {
    await startApi(apiEnvironment(settings));
  } catch (error) {
    return startupFailureFields(error).code;
  }
  assert.fail("the API started without a database");
}

// The bootstrap Job's own check of its settings, in process: bootstrapConfiguration, which the
// Job runs before it opens the database. Undefined when the Job accepts `baseUrl`, else the
// code it fails with.
export function jobRefusal(baseUrl: string) {
  try {
    bootstrapConfiguration("production", jobEnvironment(baseUrl));
  } catch (error) {
    return bootstrapFailureCode(error);
  }
  return undefined;
}

// Runs a Node entrypoint with exactly `env`, requires it to exit with status 1, and returns the
// code of its structured `event` line. The deadline only stops a hung start: these few starts
// share the file's CPUs with its renders.
export async function entrypointCode(
  script: string,
  event: "startup-error" | "installation.bootstrap-failed",
  env: NodeJS.ProcessEnv,
  redactedMarker?: string,
): Promise<string> {
  const { error, stdout, stderr } = await limited(
    () =>
      new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            process.execPath,
            [script],
            {
              cwd: repository,
              env: { PATH: process.env.PATH, ...compileCacheEnvironment, ...env },
              timeout: 60_000,
            },
            (error, stdout, stderr) => resolve({ error, stdout, stderr }),
          );
        },
      ),
  );
  if (redactedMarker !== undefined) {
    assert.ok(
      !stdout.includes(redactedMarker) && !stderr.includes(redactedMarker),
      `${script} leaked the URL credential.`,
    );
  }
  assert.ok(!error?.killed, `${script} exceeded its time or output limit.`);
  assert.equal(error?.signal ?? null, null, `${script} exited on a signal.`);
  assert.equal(error?.code ?? 0, 1, `${script} must exit with status 1.`);
  let records: unknown;
  try {
    records = jsonLines(stderr);
  } catch (cause) {
    throw new Error(`${script} emitted malformed stderr JSON.`, { cause });
  }
  assert.ok(Array.isArray(records), `${script} stderr events must be an array.`);
  const entries: readonly unknown[] = records;
  if (redactedMarker !== undefined) {
    assert.ok(
      !JSON.stringify(entries).includes(redactedMarker),
      `${script} leaked the URL credential in a structured event.`,
    );
  }
  const diagnostic = entries.map(asRecord).find((entry) => entry?.event === event);
  assert.ok(diagnostic, `${script} must emit ${event}.`);
  const { code } = diagnostic;
  assert.ok(typeof code === "string", `${script} ${event} must include a string code.`);
  return code;
}

export async function startsUp(environment: NodeJS.ProcessEnv, label?: string) {
  assert.equal(
    await startupCode(environment),
    "PERSISTENCE_UNAVAILABLE",
    label ?? "The API must reach the database.",
  );
}

// Renders `values` and checks what the chart gives the API: exactly `settings`, a default
// login egress per listed provider (any address except link-local, on TCP 443 only), and no
// sign-in or trusted-proxy setting for the worker. Returns the API's env.
export async function renders(
  label: string,
  values: ChartValues,
  settings: SignInSettings,
  egress: readonly ("google" | "oidc")[],
) {
  const objects = await render(values);
  const rendered = signInSettings(deploymentEnv(objects, "api"));
  assert.deepEqual(rendered, settings, label);
  const policies = loginEgress(objects);
  assert.deepEqual(policies.map(({ provider }) => provider).sort(), egress, label);
  for (const { provider, rules } of policies) {
    assert.deepEqual(
      rules,
      [
        {
          to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16"] } }],
          ports: [{ protocol: "TCP", port: 443 }],
        },
      ],
      `${label}: ${provider}`,
    );
  }
  assert.ok(
    !deploymentEnv(objects, "worker").some(({ name }) =>
      /^OCC_AUTH_(GITHUB_|GOOGLE_|OIDC_|TRUSTED_PROXY_|CLIENT_IP_HEADER)/.test(name),
    ),
    label,
  );
  return resolveSecrets(rendered);
}

// Each accepted case renders as `settings`, parses as `parsed` and starts the API.
export type AcceptedSignInCase = {
  label: string;
  values: ChartValues;
  settings: SignInSettings;
  parsed: {
    google?: ReturnType<typeof humanLoginConfiguration>["google"];
    oidc?: Omit<
      NonNullable<ReturnType<typeof humanLoginConfiguration>["oidc"]>,
      "tokenUrl" | "jwksUrl"
    > & {
      tokenUrl: string;
      jwksUrl: string;
    };
    passwordSignIn?: "recovery-only";
  };
  egress: readonly ("google" | "oidc")[];
};

export function acceptsEach(cases: readonly AcceptedSignInCase[]) {
  return settle(
    cases.map(async ({ label, values, settings, parsed, egress }) => {
      const environment = await renders(label, values, settings, egress);
      assert.deepEqual(humanLoginConfiguration(environment), parsed, label);
      await startsUp(environment, label);
    }),
  );
}
