import { migrationEntry } from "../../scripts/lib/selected-image-migration.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  V1ContainerStatus,
  V1EndpointSliceList,
  V1Job,
  V1Node,
  V1Pod,
  V1PodList,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import { protectedJSON } from "./production-rehearsal-custody.ts";
import { assertRunningController, type rehearsePopulatedReturn } from "./staging-upgrade-return.ts";

type Inputs = Pick<
  Parameters<typeof rehearsePopulatedReturn>[0],
  | "controllers"
  | "namespace"
  | "release"
  | "directory"
  | "run"
  | "kubectl"
  | "externalRequest"
  | "custody"
  | "localCluster"
  | "waitFor"
  | "record"
>;

const database = "openclaw_enterprise";
const service = "openclaw-enterprise-api";
// The installed migrator's database-local two-key lock. A different lock must
// fail the waiter assertion instead of yielding an unqualified overlap pass.
const lock = "1868785005, 1835624306";
const locks = `FROM pg_catalog.pg_locks AS l JOIN pg_catalog.pg_stat_activity AS a USING (pid)
  WHERE l.locktype = 'advisory' AND l.classid = 1868785005 AND l.objid = 1835624306
  AND l.objsubid = 2 AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`;

export async function rehearseOnlineMigration({
  controllers: { previous, candidate },
  namespace,
  release,
  directory,
  run,
  kubectl,
  externalRequest,
  custody,
  localCluster,
  waitFor,
  record,
}: Inputs) {
  const kube = (...args: string[]) => kubectl("--namespace", namespace, ...args);
  const get = async <T>(...args: string[]) =>
    protectedJSON<T>(await kube("get", ...args, "-o", "json"));
  const sql = async (...statements: string[]) =>
    (
      await custody.postgres(
        "psql",
        "-XAtq",
        "-v",
        "ON_ERROR_STOP=1",
        `--dbname=${database}`,
        ...statements.flatMap((statement) => ["-c", statement]),
      )
    ).trim();
  const ledger = async () =>
    protectedJSON<[number, string, number][]>(
      await sql(
        "SELECT COALESCE(json_agg(json_build_array(id,hash,created_at) ORDER BY id), '[]') FROM drizzle.__drizzle_migrations",
      ),
    );
  const catalog = async (checkout: string) => {
    const { entries } = protectedJSON<{ entries: { sha256: string; when: number }[] }>(
      await readFile(join(checkout, "migrations/meta/_canonical-history.json"), "utf8"),
    );
    return entries.map(({ sha256, when }) => {
      assert.ok(
        typeof sha256 === "string" && sha256.length > 0 && Number.isSafeInteger(when),
        "canonical migration is missing its hash or timestamp",
      );
      return [sha256, when] as const;
    });
  };
  const assertLedger = (
    rows: Awaited<ReturnType<typeof ledger>>,
    expected: Awaited<ReturnType<typeof catalog>>,
  ) => {
    assert.ok(
      rows.every(([id], index) => Number.isSafeInteger(id) && id > (rows[index - 1]?.[0] ?? 0)),
    );
    assert.deepEqual(
      rows.map(([, hash, time]) => [hash, time]),
      expected,
    );
  };
  const request = async () => {
    const result = await externalRequest("GET", "/installation", undefined, {
      authenticated: true,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(result.status, 200, "incumbent Installation read failed");
    const id = (result.body as { data?: { id?: unknown } } | null)?.data?.id;
    assert.ok(typeof id === "string" && id.length > 0, "Installation read has no identity");
    return id;
  };
  const node = await get<V1Node>(`node/${localCluster.node}`);
  assert.ok(node.metadata?.uid);
  assert.equal(node.metadata.uid, localCluster.nodeUID);
  const nodeInfo = node.status?.nodeInfo;
  assert.ok(nodeInfo);
  const platform = `${nodeInfo.operatingSystem}/${nodeInfo.architecture}`;
  const verifyImage = async (image: typeof previous, pod: V1Pod, status: V1ContainerStatus) => {
    assert.equal(pod.spec?.nodeName, localCluster.node);
    assert.equal(status.restartCount, 0);
    return assertRunningController(image, platform, status.imageID, () => {
      assert.ok(status.containerID && pod.metadata?.uid);
      return localCluster.runningConfigDigest(status.containerID, pod.metadata.uid);
    });
  };
  const incumbent = async () => {
    const identity = async (role: "api" | "worker") => {
      const { items: pods } = await get<V1PodList>(
        "pods",
        "-l",
        `app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/instance=${release},app.kubernetes.io/component=${role}`,
      );
      assert.equal(pods.length, 1, `expected exactly one incumbent ${role}`);
      const [pod] = pods;
      assert.ok(pod?.metadata?.uid && !pod.metadata.deletionTimestamp);
      assert.equal(
        pod.spec?.containers.find(({ name }) => name === role)?.image,
        previous.reference,
      );
      const status = pod.status?.containerStatuses?.find(({ name }) => name === role);
      assert.ok(status?.ready);
      return { uid: pod.metadata.uid, image: await verifyImage(previous, pod, status) };
    };
    const identities = await Promise.all([identity("api"), identity("worker")]);
    const { items: slices } = await get<V1EndpointSliceList>(
      "endpointslices",
      "-l",
      `kubernetes.io/service-name=${service}`,
    );
    const ready = slices
      .flatMap((slice) => {
        assert.ok(slice.endpoints, "EndpointSlice is missing its endpoints");
        return slice.endpoints;
      })
      .filter((endpoint) => endpoint.conditions?.ready === true);
    assert.deepEqual(
      ready.map((endpoint) => endpoint.targetRef?.uid),
      [identities[0].uid],
    );
    return identities;
  };

  await localCluster.assertCluster();
  const databaseIdentity = await custody.assertPostgres();
  const [previousCatalog, candidateCatalog] = await Promise.all([
    catalog(previous.checkout),
    catalog(candidate.checkout),
  ]);
  assert.ok(
    candidateCatalog.length > previousCatalog.length,
    "the online rehearsal needs a schema-changing pair",
  );
  assert.deepEqual(
    candidateCatalog.slice(0, previousCatalog.length),
    previousCatalog,
    "the candidate must append to the incumbent canonical catalog",
  );
  const before = await ledger();
  assertLedger(before, previousCatalog);
  const baseline = await incumbent();
  const installation = await request();

  const rendered = await run(
    "helm",
    [
      "template",
      release,
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      namespace,
      "--is-upgrade",
      "--show-only",
      "templates/jobs.yaml",
      "-f",
      join(directory, "values.json"),
      "--set-string",
      `images.controller=${candidate.reference}`,
    ],
    { cwd: candidate.checkout },
  );
  const initializer = protectedJSON<V1Job>(
    await run("yq", ["-o=json", ".", "-"], { input: rendered }),
  );
  assert.equal(initializer.kind, "Job");
  const template = initializer.spec?.template;
  const spec = template?.spec;
  assert.ok(spec);
  const migration = spec.initContainers?.find(({ name }) => name === "migration");
  assert.ok(migration);
  assert.equal(migration.image, candidate.reference);
  // Both generations of chart must request an apply with no migration mode flags.
  assert.ok(
    migration.args && isDeepStrictEqual(migrationEntry(migration.args), migration.args),
    "the candidate chart did not render its migration apply command",
  );
  const mounts = new Set(migration.volumeMounts?.map(({ name }) => name));
  const job = "online-migration";
  const appName = `lock-${namespace}`;
  assert.match(appName, /^[a-z0-9-]{1,63}$/u);
  const holder = `${locks} AND l.granted AND a.application_name = '${appName}' AND a.usename = 'postgres' AND a.wait_event = 'PgSleep'`;
  const holderPids = () => sql(`SELECT a.pid ${holder}`);
  const held = sql(
    `SET application_name = '${appName}'`,
    `DO $$ BEGIN PERFORM pg_advisory_lock(${lock});
     BEGIN PERFORM pg_sleep(90); EXCEPTION WHEN query_canceled THEN NULL; END; END $$`,
    `SELECT pg_advisory_unlock(${lock})`,
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const releaseLock = async () => {
    assert.equal(
      await sql(`SELECT pg_cancel_backend(a.pid) ${holder}`),
      "t",
      "owned migration test lock was not released",
    );
    const result = await held;
    if ("error" in result) {
      throw result.error;
    }
    assert.equal(result.value, "t");
    assert.equal(await holderPids(), "");
  };

  try {
    const holderPID = await waitFor(
      "owned PostgreSQL migration lock",
      async () => {
        const pid = await holderPids();
        return /^\d+$/u.test(pid) ? pid : false;
      },
      15_000,
    );
    const jobSpec = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: custody.metadata(job),
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 120,
        template: {
          metadata: {
            labels: {
              ...template?.metadata?.labels,
              ...custody.metadata(job).labels,
            },
          },
          spec: {
            ...spec,
            containers: [migration],
            initContainers: [],
            volumes: (spec.volumes ?? []).filter(({ name }) => mounts.has(name)),
          },
        },
      },
    };
    const jobUID = await custody.create(jobSpec);
    const jobPod = async () => {
      const { items } = await get<V1PodList>(
        "pods",
        "-l",
        `batch.kubernetes.io/controller-uid=${jobUID}`,
      );
      assert.ok(items.length <= 1, "candidate migration Job created multiple Pods");
      const [pod] = items;
      if (!pod?.status?.podIP) {
        return false;
      }
      assert.ok(
        pod.metadata?.uid &&
          pod.metadata.ownerReferences?.some(({ uid, controller }) => uid === jobUID && controller),
      );
      assert.equal(pod.spec?.containers[0]?.image, candidate.reference);
      return pod;
    };
    const pod = await waitFor("candidate migration Pod identity", jobPod, 35_000);
    const podIP = pod.status?.podIP;
    assert.ok(podIP && isIP(podIP), "migration Pod has no valid IP address");
    const waiter = () =>
      sql(
        `SELECT a.pid ${locks} AND NOT l.granted AND a.usename = 'occ_migrator' AND a.client_addr = '${podIP}'::inet AND ${holderPID} = ANY(pg_blocking_pids(a.pid))`,
      );
    const waiterPID = await waitFor(
      "candidate migration blocked by the owned PostgreSQL lock",
      async () => {
        const pid = await waiter();
        return /^\d+$/u.test(pid) ? pid : false;
      },
      35_000,
    );
    const readStartedAt = new Date().toISOString();
    assert.equal(await request(), installation);
    const readFinishedAt = new Date().toISOString();
    assert.equal(
      await waiter(),
      waiterPID,
      "the candidate must still be waiting after the incumbent request",
    );
    assert.deepEqual(await incumbent(), baseline);
    assert.deepEqual(await ledger(), before);
    await record(
      "Incumbent served an authenticated HTTPS read while the candidate waited for the migration lock",
      { jobUID, readStartedAt, readFinishedAt },
    );

    await releaseLock();
    await waitFor(
      "candidate migration Job completion",
      async () => {
        const current = await get<V1Job>(`job/${job}`);
        assert.equal(current.metadata?.uid, jobUID);
        assert.ok(!current.status?.failed, "candidate migration Job failed");
        return current.status?.conditions?.some(
          ({ type, status }) => type === "Complete" && status === "True",
        );
      },
      75_000,
    );
    const completed = await jobPod();
    assert.ok(completed && pod.metadata?.uid);
    assert.equal(completed.metadata?.uid, pod.metadata.uid);
    const status = completed.status?.containerStatuses?.find(({ name }) => name === "migration");
    assert.equal(status?.state?.terminated?.exitCode, 0);
    assert.ok(status);
    const image = await verifyImage(candidate, completed, status);
    const after = await ledger();
    assertLedger(after, candidateCatalog);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(await request(), installation);
    assert.deepEqual(await incumbent(), baseline);
    assert.deepEqual(await custody.assertPostgres(), databaseIdentity);
    await custody.assertRelease();
    await record(
      "Candidate migration committed and the original Helm API and worker stayed ready",
      {
        jobUID,
        podUID: pod.metadata.uid,
        image,
        previousReceipts: before.length,
        candidateReceipts: after.length,
      },
    );
  } catch (error) {
    try {
      if (await holderPids()) {
        await releaseLock();
      } else {
        await held;
      }
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Online migration rehearsal and lock cleanup failed",
        { cause: cleanup },
      );
    }
    throw error;
  }
}
