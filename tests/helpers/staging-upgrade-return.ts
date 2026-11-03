import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const controllerRepository = "ghcr.io/openclaw/openclaw-enterprise-controller";
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;

type Run = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    protectedInput?: boolean;
    timeout?: number;
  },
) => Promise<string>;

type ControllerImage = {
  reference: string;
  configDigest: string;
  manifestDigest: string;
  checkout: string;
  revision: string;
};

type AgentIdentity = {
  id: string;
  namespaceId: string;
  name: string;
  configurationId: string;
};

function agentIdentity(value: unknown): AgentIdentity {
  const agent = value as Partial<AgentIdentity> | undefined;
  assert.ok(agent, "OCC did not return an Agent");
  const { id, namespaceId, name, configurationId } = agent;
  assert.ok(
    id && namespaceId && name && configurationId,
    "OCC returned an incomplete Agent identity",
  );
  for (const field of [id, namespaceId, name, configurationId]) {
    assert.equal(typeof field, "string", "Agent identity fields must be strings");
  }
  return { id, namespaceId, name, configurationId };
}

export function assertReturnedAgents(
  baseline: AgentIdentity,
  accepted: AgentIdentity,
  observed: readonly AgentIdentity[],
) {
  assert.notEqual(accepted.id, baseline.id, "the candidate must acknowledge a new Agent");
  assert.equal(
    accepted.namespaceId,
    baseline.namespaceId,
    "the write must use the original Namespace",
  );
  for (const [label, expected] of [
    ["preexisting", baseline],
    ["acknowledged", accepted],
  ] as const) {
    const matches = observed.filter((agent) => agent.id === expected.id);
    assert.deepEqual(matches, [expected], `missing or changed ${label} Agent ${expected.id}`);
  }
}

export function assertDistinctControllers(
  previous: Pick<ControllerImage, "reference" | "configDigest" | "revision">,
  candidate: Pick<ControllerImage, "reference" | "configDigest" | "revision">,
) {
  for (const image of [previous, candidate]) {
    const [repository, digest] = image.reference.split("@");
    assert.equal(repository, controllerRepository, "select a published OCC controller");
    assert.ok(
      digestPattern.test(digest ?? ""),
      "controller reference must use a lowercase SHA-256 digest",
    );
    assert.equal(image.reference, `${controllerRepository}@${digest}`);
    assert.match(image.configDigest, digestPattern);
    assert.match(image.revision, commitPattern);
  }
  assert.notEqual(
    previous.reference,
    candidate.reference,
    "controller manifest digests must differ",
  );
  assert.notEqual(
    previous.configDigest,
    candidate.configDigest,
    "controller image contents must differ",
  );
  assert.notEqual(previous.revision, candidate.revision, "controller source commits must differ");
}

export async function selectRehearsalControllers(run: Run, env: NodeJS.ProcessEnv) {
  assert.ok(
    !env.CI &&
      !env.GITHUB_ACTIONS &&
      !env.OPENAI_API_KEY &&
      !env.CODEX_ACCESS_TOKEN &&
      !env.GITHUB_TOKEN &&
      !env.GH_TOKEN &&
      env.OCC_TEST_PRODUCTION_TUI_REAL !== "1" &&
      !env.OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE,
    "run the controller rehearsal locally without model credentials or the live TUI/runtime upgrade",
  );
  const imageIdentity = fileURLToPath(
    new URL("../../scripts/upgrade-image-identity.py", import.meta.url),
  );
  const select = async (
    reference: string | undefined,
    checkout: string | undefined,
    label: string,
  ) => {
    assert.ok(
      reference && reference.startsWith(`${controllerRepository}@`),
      `select the published ${label} controller`,
    );
    assert.match(reference.slice(controllerRepository.length + 1), digestPattern);
    assert.ok(checkout && isAbsolute(checkout), `select an absolute ${label} source checkout`);
    const revision = (await run("git", ["rev-parse", "HEAD"], { cwd: checkout })).trim();
    assert.match(revision, commitPattern);
    assert.equal(
      (await run("git", ["status", "--porcelain"], { cwd: checkout })).trim(),
      "",
      `the ${label} release checkout must be clean`,
    );
    return { reference, checkout, revision };
  };
  const previousSource = await select(
    env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE,
    env.OCC_TEST_REHEARSAL_PREVIOUS_SOURCE,
    "previous",
  );
  const candidateSource = await select(
    env.OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE,
    env.OCC_TEST_REHEARSAL_CANDIDATE_SOURCE,
    "candidate",
  );
  assert.notEqual(
    previousSource.reference,
    candidateSource.reference,
    "controller manifest digests must differ",
  );
  assert.notEqual(
    previousSource.revision,
    candidateSource.revision,
    "controller source commits must differ",
  );
  await run(
    "git",
    ["merge-base", "--is-ancestor", previousSource.revision, candidateSource.revision],
    {
      cwd: candidateSource.checkout,
    },
  );
  const platform = (
    await run("docker", ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])
  ).trim();
  assert.match(platform, /^linux\/(amd64|arm64)$/u, "select a supported local Docker platform");
  const inspect = async (selection: typeof previousSource) => {
    const { reference, revision } = selection;
    const imageRevision = (
      await run("docker", [
        "image",
        "inspect",
        "--platform",
        platform,
        "--format",
        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
        reference,
      ])
    ).trim();
    assert.equal(imageRevision, revision, "the controller must match its source checkout");
    const identity = JSON.parse(
      await run("python3", [imageIdentity, reference, platform], { timeout: 180_000 }),
    );
    assert.equal(identity.image, reference);
    assert.equal(identity.platform, platform);
    assert.equal(identity.rootDigest, reference.split("@")[1]);
    assert.match(identity.manifestDigest, digestPattern);
    assert.match(identity.configDigest, digestPattern);
    return {
      ...selection,
      manifestDigest: identity.manifestDigest as string,
      configDigest: identity.configDigest as string,
    };
  };
  const previous = await inspect(previousSource);
  const candidate = await inspect(candidateSource);
  assertDistinctControllers(previous, candidate);
  return { previous, candidate };
}

type Controllers = Awaited<ReturnType<typeof selectRehearsalControllers>>;
type Api = (
  method: "GET" | "POST",
  path: string,
  body?: object,
  expected?: number,
) => Promise<unknown>;
type Kubectl = (...args: string[]) => Promise<string>;
type Rehearsal = {
  controllers: Controllers;
  kubeconfig: string;
  context: string;
  namespace: string;
  release: string;
  directory: string;
  occ: string;
  occEnv: NodeJS.ProcessEnv;
  namespaceId: string;
  tenant: string;
  runtime: string;
  run: Run;
  kubectl: Kubectl;
  api: Api;
  waitFor: <T>(
    description: string,
    check: () => Promise<T | false>,
    timeout?: number,
  ) => Promise<T>;
  record: (row: string, details?: object) => Promise<void>;
};

type ContainerStatus = {
  name: string;
  imageID: string;
  ready: boolean;
};

type Pod = {
  metadata: { name: string; uid: string; labels: Record<string, string> };
  spec: { serviceAccountName: string; containers: { name: string; image: string }[] };
  status: { phase: string; podIP: string; containerStatuses?: ContainerStatus[] };
};

function assertImageID(image: ControllerImage, imageID: string | undefined) {
  const observed = imageID?.match(/sha256:[a-f0-9]{64}$/u)?.[0];
  const manifestDigest = image.reference.split("@")[1];
  assert.ok(
    observed && [manifestDigest, image.manifestDigest, image.configDigest].includes(observed),
    "the running controller image ID differs from the selected platform image",
  );
}

const components = ["api", "worker"] as const;
const originalDatabase = "openclaw_enterprise";
const restoredDatabase = "occ_return";
const staleDatabase = "occ_stale";

export function returnedDatabaseConnections(active: readonly string[], podIPs: readonly string[]) {
  assert.equal(new Set(podIPs).size, 2, "expected distinct API and worker Pod addresses");
  assert.ok(
    active.every((client) => !client.startsWith(`${originalDatabase}:`)),
    "the retained candidate database still has an application connection",
  );
  return podIPs.every((ip) => active.includes(`${restoredDatabase}:${ip}`));
}

export async function rehearsePopulatedReturn({
  controllers,
  kubeconfig,
  context,
  namespace,
  release,
  directory,
  occ,
  occEnv,
  namespaceId,
  tenant,
  runtime,
  run,
  kubectl,
  api,
  waitFor,
  record,
}: Rehearsal) {
  const { previous, candidate } = controllers;
  const helmArgs = [
    `--kubeconfig=${kubeconfig}`,
    `--kube-context=${context}`,
    `--namespace=${namespace}`,
  ];
  const helm = (...args: string[]) => run("helm", [...args, ...helmArgs], { timeout: 330_000 });
  const kube = (...args: string[]) => kubectl("--namespace", namespace, ...args);
  const get = async (resource: string) => JSON.parse(await kube("get", resource, "-o", "json"));
  const kubeWrite = (verb: "create" | "replace", object: object, protectedInput = false) =>
    run(
      "kubectl",
      [
        `--kubeconfig=${kubeconfig}`,
        `--context=${context}`,
        `--namespace=${namespace}`,
        verb,
        "-f",
        "-",
      ],
      { input: JSON.stringify(object), protectedInput },
    );
  const installationPath = "/installation";
  const namespacePath = `/namespaces/${encodeURIComponent(namespaceId)}`;
  const agentPath = `${namespacePath}/agents`;
  const readAgent = async (id: string) =>
    agentIdentity(await api("GET", `${agentPath}/${encodeURIComponent(id)}`));
  const helmStatus = async () => JSON.parse(await helm("status", release, "-o", "json"));
  const phase = async <T>(name: string, action: () => Promise<T>) => {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    await writeFile(
      join(directory, "return-progress.json"),
      JSON.stringify({ phase: name, startedAt }) + "\n",
      { mode: 0o600 },
    );
    const result = await action();
    await record(name, {
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - start),
    });
    return result;
  };
  const postgres = (command: string, ...args: string[]) =>
    kube(
      "exec",
      "pod/postgres",
      "--",
      "sh",
      "-ec",
      'umask 077; export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"',
      "postgres-fixture",
      command,
      "--host=127.0.0.1",
      "--username=postgres",
      ...args,
    );
  const sql = async (database: string, query: string) =>
    (
      await postgres("psql", "-XAt", "-v", "ON_ERROR_STOP=1", `--dbname=${database}`, "-c", query)
    ).trim();
  const dump = (file: string) =>
    postgres("pg_dump", "--format=custom", `--file=${file}`, originalDatabase);
  const restore = async (database: string, file: string) => {
    await postgres("createdb", "--template=template0", database);
    await postgres(
      "pg_restore",
      "--exit-on-error",
      "--single-transaction",
      `--dbname=${database}`,
      file,
    );
    await sql(database, `GRANT CREATE ON DATABASE ${database} TO occ_migrator`);
  };
  const migrationReceipts = (database: string) =>
    sql(database, "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id");
  const databaseAgents = async (database: string) =>
    (
      JSON.parse(
        await sql(
          database,
          `SELECT COALESCE(json_agg(json_build_object(
      'id', id, 'namespaceId', namespace_id, 'name', name, 'configurationId', configuration_id
    )), '[]') FROM occ.agents`,
        ),
      ) as unknown[]
    ).map(agentIdentity);
  const pods = async () =>
    (
      JSON.parse(
        await kube(
          "get",
          "pods",
          "-l",
          `app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/instance=${release},app.kubernetes.io/component in (api,worker)`,
          "-o",
          "json",
        ),
      ) as { items: Pod[] }
    ).items;
  const claimIdentity = async () =>
    Promise.all(
      ["postgres-data", "bootstrap-password"].map(async (name) => {
        const { metadata, spec } = await get(`pvc/${name}`);
        assert.ok(metadata.uid && spec.volumeName, `unbound claim ${name}`);
        return { name, uid: metadata.uid, volume: spec.volumeName };
      }),
    );
  const controlPlane = async (image: ControllerImage, database: string) => {
    const currentPods = await pods();
    assert.equal(currentPods.length, components.length, "expected one API and one worker Pod");
    return Promise.all(
      components.map(async (component) => {
        const deployment = await get(`deployment/openclaw-enterprise-${component}`);
        assert.equal(deployment.metadata.labels["app.kubernetes.io/instance"], release);
        assert.equal(deployment.spec.replicas, 1);
        assert.ok(deployment.metadata.uid);
        assert.equal(
          deployment.spec.template.spec.containers.find(
            (container: { name: string }) => container.name === component,
          )?.image,
          image.reference,
        );
        const pod = currentPods.find(
          (item) => item.metadata.labels["app.kubernetes.io/component"] === component,
        );
        assert.ok(
          pod?.metadata.uid && pod.status.podIP && pod.status.phase === "Running",
          `${component} Pod did not start`,
        );
        assert.equal(
          pod.spec.containers.find((container) => container.name === component)?.image,
          image.reference,
        );
        const status = pod.status.containerStatuses?.find((item) => item.name === component);
        assert.ok(status?.ready, `${component} container is not ready`);
        assertImageID(image, status.imageID);
        assert.equal(pod.spec.serviceAccountName, `openclaw-enterprise-${component}`);
        const account = await get(`serviceaccount/${pod.spec.serviceAccountName}`);
        assert.ok(account.metadata.uid, `${component} ServiceAccount must have an identity`);
        const selectedDatabase = await kube(
          "exec",
          `pod/${pod.metadata.name}`,
          "-c",
          component,
          "--",
          "node",
          "-e",
          "console.log(new URL(process.env.OCC_DATABASE_URL).pathname.slice(1))",
        );
        assert.equal(selectedDatabase.trim(), database, `${component} uses the wrong database`);
        return {
          component,
          pod: pod.metadata.name,
          uid: pod.metadata.uid,
          deploymentUID: deployment.metadata.uid,
          serviceAccountUID: account.metadata.uid,
          ip: pod.status.podIP,
          imageID: status.imageID,
        };
      }),
    );
  };
  const candidateConnections = () =>
    sql(
      "postgres",
      `SELECT count(*) FROM pg_stat_activity
    WHERE datname = '${originalDatabase}' AND usename IN ('occ_app', 'occ_migrator')`,
    );
  const assertNoCandidateWriters = async () => {
    assert.deepEqual(await pods(), [], "API or worker Pods still exist");
    for (const component of components) {
      assert.equal((await get(`deployment/openclaw-enterprise-${component}`)).spec.replicas, 0);
    }
    assert.equal(await candidateConnections(), "0");
  };
  const baselineRelease = await helmStatus();
  assert.equal(baselineRelease.info.status, "deployed");
  assert.ok(Number.isSafeInteger(baselineRelease.version) && baselineRelease.version > 0);
  const namespaceUID = (await get(`namespace/${namespace}`)).metadata.uid;
  const tenantUID = (await get(`namespace/${tenant}`)).metadata.uid;
  const claims = await claimIdentity();
  const startupSecret = await get("secret/occ-installation-startup");
  const startup = JSON.parse(
    Buffer.from(startupSecret.data["installation.yaml"], "base64").toString("utf8"),
  );
  assert.equal(startup.drivers.compute.configuration.images.gateway, runtime);
  assert.equal(startup.drivers.compute.configuration.images.agent, runtime);
  const { id: installationId } = (await api("GET", installationPath)) as { id: string };
  assert.ok(installationId && namespaceUID && tenantUID && startupSecret.metadata.uid);
  assert.equal(startupSecret.metadata.annotations["openclaw.dev/installation-id"], installationId);
  const verifyInstallation = async () => {
    const installation = (await api("GET", installationPath)) as { id: string };
    assert.equal(installation.id, installationId);
    const saved = (await api("GET", namespacePath)) as { id: string; status: string };
    assert.equal(saved.id, namespaceId);
    assert.equal(saved.status, "ready");
  };
  const previousPods = await controlPlane(previous, originalDatabase);
  const writerIdentities = (observed: typeof previousPods) =>
    observed.map(({ deploymentUID, serviceAccountUID }) => ({ deploymentUID, serviceAccountUID }));
  const previousJob = (await get(`job/${release}-initialization`)).spec.template;
  const priorMigration = previousJob.spec.initContainers.find(
    (container: { name: string }) => container.name === "migration",
  );
  assert.equal(
    priorMigration?.image,
    previous.reference,
    "previous migration image differs from the serving release",
  );

  // Create drafts through the production API. They populate both PostgreSQL and the
  // tenant Configuration Driver, without starting a runtime or sending a model request.
  const { id: configurationId } = (await api(
    "POST",
    `${namespacePath}/configurations`,
    {
      kind: "agent",
      values: {},
    },
    201,
  )) as { id: string };
  assert.ok(configurationId);
  const createAgent = async (name: string) => {
    const agent = agentIdentity(
      await api("POST", agentPath, { name, configurationId, executionMode: "embedded" }, 201),
    );
    assert.deepEqual(agent, { id: agent.id, namespaceId, name, configurationId });
    return agent;
  };
  const baseline = await createAgent("before-upgrade");
  assert.deepEqual(await readAgent(baseline.id), baseline);
  await verifyInstallation();
  await record("Previous OCC serves the populated Installation", {
    installationId,
    namespaceId,
    namespaceUID,
    tenantUID,
    claims,
    baseline,
    previousPods,
    previous,
    candidate,
    runtime,
    helmRevision: baselineRelease.version,
  });

  const staleArchive = "/tmp/occ-before-upgrade.pgdump";
  const candidateArchive = "/tmp/occ-after-write.pgdump";
  await phase("Capture the pre-upgrade control archive", () => dump(staleArchive));

  const upgradeArgs = [
    "--kubeconfig",
    kubeconfig,
    "--context",
    context,
    "--namespace",
    namespace,
    "--release",
    release,
    "--values",
    join(directory, "values.json"),
    "--installation",
    join(directory, "installation.json"),
    "--controller-image",
    candidate.reference,
    "--source-revision",
    candidate.revision,
    "--occ",
    occ,
    "--timeout-seconds",
    "300",
  ];
  const upgrade = (args: string[]) =>
    run("bash", ["scripts/upgrade-production-images", ...upgradeArgs, ...args], {
      cwd: candidate.checkout,
      env: occEnv,
      timeout: 720_000,
    });
  await phase("Check the candidate without stopping writers", () =>
    upgrade(["--preflight-only", "--evidence-dir", join(directory, "preflight")]),
  );
  await phase("Upgrade the controller and confirm authenticated OCC recovery", async () => {
    await upgrade(["--evidence-dir", join(directory, "forward")]);
    await verifyInstallation();
  });
  const candidateRelease = await helmStatus();
  assert.equal(candidateRelease.info.status, "deployed");
  assert.ok(candidateRelease.version > baselineRelease.version);
  const candidatePods = await controlPlane(candidate, originalDatabase);
  assert.deepEqual(writerIdentities(candidatePods), writerIdentities(previousPods));
  assert.deepEqual(await readAgent(baseline.id), baseline);
  const accepted = await createAgent("acknowledged-after-upgrade");
  assertReturnedAgents(baseline, accepted, [
    await readAgent(baseline.id),
    await readAgent(accepted.id),
  ]);
  await record("Candidate OCC acknowledged the new Agent", {
    accepted,
    candidatePods,
    helmRevision: candidateRelease.version,
  });

  await phase("Stop both candidate writers", async () => {
    await kube(
      "scale",
      "deployment/openclaw-enterprise-api",
      "deployment/openclaw-enterprise-worker",
      "--current-replicas=1",
      "--replicas=0",
    );
    await waitFor(
      "candidate writer Pods and database connections to terminate",
      async () => (await pods()).length === 0 && (await candidateConnections()) === "0",
    );
    await assertNoCandidateWriters();
  });
  await phase("Restore the candidate archive and reject the stale archive", async () => {
    const receipts = await migrationReceipts(originalDatabase);
    assert.ok(receipts.length > 0, "no candidate migration receipts");
    await dump(candidateArchive);
    await restore(staleDatabase, staleArchive);
    const stale = await databaseAgents(staleDatabase);
    assert.deepEqual(stale, [baseline]);
    assert.throws(
      () => assertReturnedAgents(baseline, accepted, stale),
      /missing or changed acknowledged Agent/u,
    );
    await restore(restoredDatabase, candidateArchive);
    assert.equal(await migrationReceipts(restoredDatabase), receipts);
    assertReturnedAgents(baseline, accepted, await databaseAgents(restoredDatabase));
  });

  const databaseSecret = await get("secret/occ-database");
  assert.ok(databaseSecret.metadata.uid && databaseSecret.metadata.resourceVersion);
  const restoreCredentials = Object.fromEntries(
    ["application-url", "migration-url"].map((key) => {
      const url = new URL(Buffer.from(databaseSecret.data[key], "base64").toString("utf8"));
      assert.equal(url.pathname, `/${originalDatabase}`);
      assert.equal(url.hostname, `postgres.${namespace}.svc.cluster.local`);
      assert.equal(url.username, key === "application-url" ? "occ_app" : "occ_migrator");
      url.pathname = `/${restoredDatabase}`;
      return [key, Buffer.from(url.toString()).toString("base64")];
    }),
  );
  const probeName = "return-compatibility";
  await phase("Check the restored database with the previous controller", async () => {
    const probeSecret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: probeName },
      data: { "migration-url": restoreCredentials["migration-url"] },
    };
    const probe = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: probeName,
        // Copy the chart's network policy labels, not the Job's ownership labels.
        labels: {
          "app.kubernetes.io/name": "openclaw-enterprise",
          "app.kubernetes.io/instance": release,
          "app.kubernetes.io/component": "initialization",
        },
      },
      spec: {
        restartPolicy: "Never",
        activeDeadlineSeconds: 120,
        automountServiceAccountToken: false,
        securityContext: previousJob.spec.securityContext,
        containers: [
          {
            ...priorMigration,
            args: ["scripts/migrate-production.mjs", "--check"],
            env: [
              { name: "NODE_ENV", value: "production" },
              {
                name: "OCC_MIGRATION_DATABASE_URL",
                valueFrom: { secretKeyRef: { name: probeName, key: "migration-url" } },
              },
            ],
          },
        ],
      },
    };
    await kubeWrite("create", probeSecret, true);
    await kubeWrite("create", probe);
    const completed = await waitFor<Pod>("previous controller migration check", async () => {
      const pod: Pod = await get(`pod/${probeName}`);
      return ["Succeeded", "Failed"].includes(pod.status.phase) ? pod : false;
    });
    assertImageID(previous, completed.status.containerStatuses?.[0]?.imageID);
    const output = await kube("logs", `pod/${probeName}`, "-c", "migration");
    assert.equal(
      completed.status.phase,
      "Succeeded",
      "previous image cannot use the restored database",
    );
    const history = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; history?: string });
    assert.deepEqual(
      history.filter(
        (entry) => entry.event === "migration.checked" && Object.hasOwn(entry, "history"),
      ),
      [{ event: "migration.checked", history: "completed" }],
    );
  });

  await phase("Return to the previous Helm revision on the restored database", async () => {
    await assertNoCandidateWriters();
    delete databaseSecret.metadata.managedFields;
    // Keep the original connection settings available if the return stops
    // after changing the Secret. Never copy them into the proof.
    await writeFile(
      join(directory, "candidate-database-secret.json"),
      JSON.stringify(databaseSecret) + "\n",
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    databaseSecret.data = { ...databaseSecret.data, ...restoreCredentials };
    await kubeWrite("replace", databaseSecret, true);
    await helm("rollback", release, String(baselineRelease.version), "--wait", "--timeout=5m");
    await verifyInstallation();
  });
  const returned = await helmStatus();
  assert.equal(returned.info.status, "deployed");
  assert.ok(returned.version > candidateRelease.version);
  assert.deepEqual(await claimIdentity(), claims);
  assert.equal((await get(`namespace/${namespace}`)).metadata.uid, namespaceUID);
  assert.equal((await get(`namespace/${tenant}`)).metadata.uid, tenantUID);
  const returnedSecret = await get("secret/occ-installation-startup");
  assert.equal(returnedSecret.metadata.uid, startupSecret.metadata.uid);
  assert.equal(returnedSecret.data["installation.yaml"], startupSecret.data["installation.yaml"]);
  assert.equal(returnedSecret.metadata.annotations["openclaw.dev/installation-id"], installationId);
  assert.equal((await get("secret/occ-database")).metadata.uid, databaseSecret.metadata.uid);
  const returnedPods = await controlPlane(previous, restoredDatabase);
  assert.deepEqual(writerIdentities(returnedPods), writerIdentities(previousPods));
  for (const pod of returnedPods) {
    assert.ok(![...previousPods, ...candidatePods].some((earlier) => earlier.uid === pod.uid));
  }
  await phase("Read the acknowledged write through the returned OCC", async () => {
    // Bind the database readback to both serving controller Pods and check that
    // the retained candidate database has no application connections.
    await waitFor(
      "both returned controller connections on the restored database",
      async () => {
        assertReturnedAgents(baseline, accepted, [
          await readAgent(baseline.id),
          await readAgent(accepted.id),
        ]);
        const active = (
          await sql(
            "postgres",
            `SELECT datname || ':' || host(client_addr)
        FROM pg_stat_activity WHERE usename = 'occ_app'
          AND datname IN ('${originalDatabase}', '${restoredDatabase}')`,
          )
        ).split("\n");
        return returnedDatabaseConnections(
          active,
          returnedPods.map(({ ip }) => ip),
        );
      },
      30_000,
    );
    assertReturnedAgents(baseline, accepted, await databaseAgents(originalDatabase));
  });
  await record("Populated controller upgrade and compatible return", {
    installationId,
    namespaceId,
    baseline,
    accepted,
    returnedPods,
    restoredDatabase,
    returnedHelmRevision: returned.version,
    returnedToHelmRevision: baselineRelease.version,
  });
}
