import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  field,
  list,
  optionalField,
  type RecoveryState,
} from "./production-upgrade-recovery-state.ts";
import { execute, spawnResult, type RecoveryTools } from "./production-upgrade-recovery-tools.ts";
import { loadYaml, yamlDocuments } from "./qa-utils.mjs";

// Helm status forwards the complete values document to the upgrade script.
export async function yamlFile(file: string): Promise<unknown> {
  return JSON.parse((await execute("yq", ["-p=yaml", "-o=json", ".", file])).stdout);
}

export function renderedDocuments(rendered: string): unknown[] {
  const documents: unknown = yamlDocuments(rendered);
  return list(documents, "rendered YAML documents").map((document): unknown => {
    assert.ok(typeof document === "string", "expected a rendered YAML document");
    return loadYaml(document);
  });
}

// `yq -r` prints a missing or null field as "null".
export const yqRaw = (value: unknown) =>
  value === undefined || value === null ? "null" : String(value).trim();

// yq's `//` replaces a missing, null or false value.
const yqOr = (value: unknown, alternative: unknown) =>
  value === undefined || value === null || value === false ? alternative : value;

export const testCertificate = {
  apiVersion: "cert-manager.io/v1",
  kind: "Certificate",
  metadata: { name: "gateway-certificate", namespace: "system" },
  spec: {
    secretName: "gateway-tls",
    dnsNames: ["gateway.example.test"],
    issuerRef: { name: "gateway-issuer", kind: "Issuer" },
  },
};

// Unless a case selects the real chart, a stand-in renders only what the startup
// preflight reads: controller images, Installation mounts, and initializer identity.
export async function standInChart(
  { repository }: Pick<RecoveryTools, "repository">,
  file: string,
  policy: boolean,
  initializationResources?: unknown,
  ordinary: unknown = [],
  installationCheck = false,
) {
  const values = await yamlFile(file);
  const installation = optionalField(values, "installation");
  const secretName = yqRaw(
    yqOr(optionalField(installation, "secretName"), "occ-installation-startup"),
  );
  const key = yqRaw(yqOr(optionalField(installation, "key"), "installation.yaml"));
  const image = yqRaw(optionalField(optionalField(values, "images"), "controller"));
  const channelDirectoryProxyUrl = optionalField(field(values, "api"), "channelDirectoryProxyUrl");
  const deployment = (component: "api" | "worker", placement: "containers" | "initContainers") => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "openclaw-enterprise-" + component },
    spec: {
      template: {
        spec: {
          serviceAccountName: "openclaw-enterprise-" + component,
          volumes: [
            {
              name: "installation-startup",
              secret: { secretName, items: [{ key, path: "installation.yaml" }] },
            },
          ],
          [placement]: [
            {
              name: component,
              image,
              args: [`apps/controller/src/${component === "api" ? "server" : "worker"}.mjs`],
              env: [
                {
                  name: "OCC_CONFIG_PATH",
                  value: "/etc/openclaw/installation/installation.yaml",
                },
                ...(component === "api" && channelDirectoryProxyUrl
                  ? [
                      {
                        name: "OCC_CHANNEL_DIRECTORY_PROXY_URL",
                        value: channelDirectoryProxyUrl,
                      },
                    ]
                  : []),
              ],
              volumeMounts: [
                {
                  name: "installation-startup",
                  mountPath: "/etc/openclaw/installation",
                  readOnly: true,
                },
              ],
            },
          ],
        },
      },
    },
  });
  const repositoryEnabled =
    yqRaw(yqOr(optionalField(optionalField(values, "repositoryCredentials"), "enabled"), false)) ===
    "true";
  return [
    deployment("api", "containers"),
    deployment("worker", repositoryEnabled ? "initContainers" : "containers"),
    ...list(ordinary, "ordinary chart documents"),
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: "oce-initialization",
        labels: {
          "app.kubernetes.io/instance": "oce",
          "app.kubernetes.io/component": "initialization",
        },
        annotations: {
          "helm.sh/hook": "pre-install,pre-upgrade",
          "openclaw.dev/upgrade-attempt": field(installation, "upgradeAttemptId"),
        },
      },
      spec: {
        backoffLimit: 0,
        template: {
          metadata: {
            labels: {
              "app.kubernetes.io/instance": "oce",
              "app.kubernetes.io/component": "initialization",
            },
            annotations: {
              "openclaw.dev/upgrade-attempt": field(installation, "upgradeAttemptId"),
            },
          },
          spec: {
            restartPolicy: "Never",
            serviceAccountName: "openclaw-enterprise-initialization",
            ...(installationCheck
              ? {
                  volumes: [
                    {
                      name: "installation-startup",
                      secret: { secretName, items: [{ key, path: "installation.yaml" }] },
                    },
                  ],
                }
              : {}),
            securityContext: {
              runAsUser: 1000,
              runAsGroup: 1000,
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "bootstrap",
                image,
                args: ["scripts/bootstrap-installation.mjs"],
                ...(initializationResources ? { resources: initializationResources } : {}),
                securityContext: { capabilities: { drop: ["ALL"] } },
              },
            ],
            initContainers: [
              ...(installationCheck
                ? [
                    {
                      name: "installation-check",
                      image,
                      env: [
                        {
                          name: "OCC_CONFIG_PATH",
                          value: "/etc/openclaw/installation/installation.yaml",
                        },
                      ],
                      volumeMounts: [
                        {
                          name: "installation-startup",
                          mountPath: "/etc/openclaw/installation",
                          readOnly: true,
                        },
                      ],
                      command: ["node"],
                      args: [
                        "--input-type=module",
                        "-e",
                        readFileSync(
                          join(
                            repository,
                            "deploy/helm/openclaw-enterprise/files/check-installation.mjs",
                          ),
                          "utf8",
                        ),
                      ],
                      securityContext: { capabilities: { drop: ["ALL"] } },
                    },
                  ]
                : []),
              {
                name: "migration",
                image,
                args: ["scripts/migrate-production.mjs"],
                ...(initializationResources ? { resources: initializationResources } : {}),
                securityContext: { capabilities: { drop: ["ALL"] } },
              },
            ],
          },
        },
      },
    },
    ...(policy
      ? [
          {
            apiVersion: "networking.k8s.io/v1",
            kind: "NetworkPolicy",
            metadata: { name: "openclaw-enterprise-dependency-egress" },
            spec: { egress: [] },
          },
        ]
      : []),
  ]
    .map((document) => "---\n" + JSON.stringify(document) + "\n")
    .join("");
}

type PreflightDatabase = { url: string; secretName: string; appUrlKey: string };

// Starts the preflight Pod's container once with its Secret/ConfigMap volumes and literal
// environment and fixture database Secret. Other cluster inputs (CA and token volumes) are
// not provided; chart cases point Compute at the test's Kubernetes API through an
// explicit kubeconfig instead of the Pod's service account. The container runs in
// OCC_TEST_PRODUCTION_IMAGE when set, otherwise as this checkout's source (the
// command's working directory) with /app mapped to it. Stand-in cases only record it.
export async function runPreflight(
  root: string,
  cwd: string,
  state: RecoveryState,
  pod: unknown,
  database?: PreflightDatabase | null,
  fixtureFiles: readonly string[] = [],
): Promise<unknown> {
  const spec = field(pod, "spec");
  const container = field(field(spec, "containers"), 0);
  const name = field(container, "name");
  const scripted = optionalField(state.preflightResults, String(name));
  if (scripted) {
    return scripted;
  }
  // This command fixture has no migrator database. Only the API and worker
  // execute source; the installed migration test owns real database proof.
  // providerCompleted is a supported earlier receipt lineage with migrations pending.
  if (name === "migration") {
    return {
      phase: "Succeeded",
      log: '{"event":"migration.checked","history":"providerCompleted"}\n',
    };
  }
  const variables = field(container, "env");
  if (!state.startupCheck) {
    const drafts =
      variables != null &&
      list(variables, "preflight environment").some(
        (variable) => field(variable, "name") === "OCC_UPGRADE_PREFLIGHT_AGENT_DRAFTS",
      );
    return {
      phase: "Succeeded",
      log: (drafts ? "agent-drafts-accepted\n" : "") + "installation-startup-ready\n",
    };
  }
  const work = mkdtempSync(join(root, "preflight-"));
  chmodSync(work, 0o755);
  const mounts: [source: string, target: string][] = fixtureFiles.map((file) => [file, file]);
  for (const mount of list(field(container, "volumeMounts") ?? [], "preflight volume mounts")) {
    const name = field(mount, "name");
    const volume = list(field(spec, "volumes"), "preflight volumes").find(
      (item) => field(item, "name") === name,
    );
    const secretRef = optionalField(volume, "secret");
    const configMapRef = optionalField(volume, "configMap");
    const secret =
      secretRef &&
      state.preflight != null &&
      field(field(state.preflight, "secrets"), String(field(secretRef, "secretName")));
    const configMap =
      configMapRef && field(state.themeConfigMaps, String(field(configMapRef, "name")));
    const data = optionalField(secret, "data") ?? optionalField(configMap, "data");
    if (!data) {
      continue;
    }
    assert.ok(typeof name === "string", "expected a preflight mount name");
    const directory = join(work, name);
    // The script runs under umask 077; the image's unprivileged user must still read the mount.
    mkdirSync(directory);
    chmodSync(directory, 0o755);
    const items =
      optionalField(secretRef, "items") ??
      optionalField(configMapRef, "items") ??
      Object.keys(data).map((key) => ({ key, path: key }));
    for (const item of list(items, "preflight volume items")) {
      const itemPath = field(item, "path");
      assert.ok(typeof itemPath === "string", "expected a preflight volume item path");
      const path = join(directory, itemPath);
      const key = field(item, "key");
      const contents = field(data, String(key));
      assert.ok(typeof contents === "string", `missing fixture data for volume item ${key}`);
      writeFileSync(path, secret ? Buffer.from(contents, "base64") : contents);
      chmodSync(path, 0o644);
    }
    const mountPath = field(mount, "mountPath");
    assert.ok(typeof mountPath === "string", "expected a preflight volume mount path");
    mounts.push([directory, mountPath]);
  }
  const image = process.env.OCC_TEST_PRODUCTION_IMAGE;
  if (state.unavailableDraftResolver) {
    // Preserve all other exports, including those used by ordinary startup imports.
    const resolver = "packages/occ/src/configured-harness.ts";
    const current = "configured-harness-current.ts";
    const overlay = join(work, "configured-harness.ts");
    writeFileSync(
      overlay,
      `export * from ${JSON.stringify(image ? `./${current}` : join(cwd, resolver))};\n` +
        "export const resolveConfiguredHarnessId = undefined;\n",
    );
    chmodSync(overlay, 0o644);
    // As with olderDraftRules, image mode mounts the selected checkout's source beside
    // the overlay. Source mode's existing local() mount mapping redirects the generated
    // import to the overlay; the generated API program itself is unchanged.
    if (image) {
      mounts.push([join(cwd, resolver), `/app/packages/occ/src/${current}`]);
    }
    mounts.push([overlay, `/app/${resolver}`]);
  }
  if (state.olderDraftRules) {
    // An image built before refuseUndeployableConfigurationValues existed: its
    // configuration-settings module has every other export but not that one. The stand-in
    // module re-exports the real one; its own export shadows the new rule.
    const settings = "packages/occ/src/configuration-settings.ts";
    const current = "configuration-settings-current.ts";
    const older = join(work, "configuration-settings.ts");
    writeFileSync(
      older,
      `export * from ${JSON.stringify(image ? `./${current}` : join(cwd, settings))};\n` +
        "export const refuseUndeployableConfigurationValues = undefined;\n",
    );
    chmodSync(older, 0o644);
    // In the image the stand-in replaces the module for every importer, so the real module
    // moves beside it.
    if (image) {
      mounts.push([join(cwd, settings), `/app/packages/occ/src/${current}`]);
    }
    mounts.push([older, `/app/${settings}`]);
  }
  // Kubernetes expands $(VAR) in literal values from earlier variables and turns $$ into $.
  const expanded = new Map<string, string>();
  const env: [name: string, value: string][] = [];
  for (const item of list(variables ?? [], "preflight environment")) {
    const ref = optionalField(field(item, "valueFrom"), "secretKeyRef");
    // Resolve only the fixture-owned application Secret through the rendered reference.
    // The generated program still connects through the production pool.
    const literal =
      database &&
      optionalField(ref, "name") === database.secretName &&
      field(ref, "key") === database.appUrlKey
        ? database.url
        : field(item, "value");
    if (typeof literal !== "string") {
      continue;
    }
    const value = literal.replace(/\$\$|\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (match, name: string) =>
      match === "$$" ? "$" : (expanded.get(name) ?? match),
    );
    const name = String(field(item, "name"));
    expanded.set(name, value);
    env.push([name, value]);
  }
  const local = (value: string) =>
    mounts
      .reduce((current, [source, target]) => current.split(target).join(source), value)
      .split("/app/apps/")
      .join(cwd + "/apps/")
      .split("/app/packages/")
      .join(cwd + "/packages/");
  let result: Awaited<ReturnType<typeof spawnResult>>;
  if (image) {
    const entrypoint = field(field(container, "command"), 0);
    assert.ok(
      typeof entrypoint === "string" && entrypoint,
      "the selected-image check needs a rendered entrypoint",
    );
    // Host networking reaches the test's loopback Kubernetes API only with rootful Docker.
    result = await spawnResult(
      "docker",
      [
        "run",
        "--rm",
        ...(state.kubeconfig
          ? [
              "--network",
              "host",
              "--mount",
              `type=bind,src=${state.kubeconfig},dst=${state.kubeconfig},readonly`,
            ]
          : ["--network", "none"]),
        ...mounts.flatMap(([source, target]) => [
          "--mount",
          `type=bind,src=${source},dst=${target},readonly`,
        ]),
        ...env.flatMap(([name, value]) => ["--env", `${name}=${value}`]),
        "--entrypoint",
        entrypoint,
        image,
        ...list(field(container, "args"), "preflight arguments").map(String),
      ],
      { cwd },
    );
  } else {
    result = await spawnResult(
      process.execPath,
      list(field(container, "args"), "preflight arguments").map((argument) => {
        assert.ok(typeof argument === "string", "expected a source preflight argument");
        return local(argument);
      }),
      {
        cwd,
        env: Object.fromEntries(env.map(([name, value]) => [name, local(value)])),
      },
    );
  }
  return {
    phase: result.status === 0 ? "Succeeded" : "Failed",
    log: result.stdout + result.stderr,
  };
}
