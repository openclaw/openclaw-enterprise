import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { runDeployedCapability } from "./deployed-repository-capability.ts";
import { bashString, type CommandRequest } from "./fixture-command-server.ts";
import {
  continuityAgent,
  continuityNamespace,
  continuityRevision,
} from "./production-upgrade-continuity-fixture.ts";
import {
  renderedDocuments,
  runPreflight,
  standInChart,
  testCertificate,
  yamlFile,
  yqRaw,
} from "./production-upgrade-recovery-render.ts";
import {
  type CapabilityProbe,
  type PreflightIdentity,
  field,
  isList,
  journalInteger,
  list,
  optionalField,
  properties,
  record,
} from "./production-upgrade-recovery-state.ts";
import {
  readyCapability,
  runtime,
  spawnResult,
  type RecoveryTools,
} from "./production-upgrade-recovery-tools.ts";
import { createDoctorPodFixture } from "./upgrade-doctor-observations.ts";

const doctorPod = createDoctorPodFixture<unknown>(runtime);

function containerName(spec: unknown): unknown {
  return optionalField(optionalField(optionalField(spec, "containers"), 0), "name");
}

function requiredContainerName(spec: unknown): unknown {
  return field(field(field(spec, "containers"), 0), "name");
}

function hasOwner(resource: unknown, uid: unknown): boolean {
  const owners = optionalResourceField(resource, "ownerReferences");
  return (
    typeof uid === "string" &&
    isList(owners) &&
    owners.some((owner) => optionalField(owner, "uid") === uid)
  );
}

type PreflightDatabase = Parameters<typeof runPreflight>[4];

const collections = {
  pod: "pods",
  "job.batch": "jobs",
  secret: "secrets",
  "networkpolicy.networking.k8s.io": "networkpolicies",
} as const;
const rawResources = {
  pods: { api: "api/v1", kind: "pod" },
  jobs: { api: "apis/batch/v1", kind: "job.batch" },
  secrets: { api: "api/v1", kind: "secret" },
  networkpolicies: {
    api: "apis/networking.k8s.io/v1",
    kind: "networkpolicy.networking.k8s.io",
  },
} as const;
type ServingContainer = {
  name: string;
  image: unknown;
  env?: { name: string; value: string }[];
  volumeMounts?: { name: string; mountPath: unknown; readOnly: boolean }[];
};
type ServingPodSpec = {
  containers: ServingContainer[];
  initContainers?: (ServingContainer & { restartPolicy?: "Always" })[];
  nodeName?: string;
  volumes?: {
    name: string;
    secret: { secretName: unknown; items: { key: unknown; path: string }[] };
  }[];
};

function installationValue(values: unknown, key: string): unknown {
  return optionalField(optionalField(values, "installation"), key);
}

function optionalResourceField(resource: unknown, key: string): unknown {
  return resource == null ? undefined : field(field(resource, "metadata"), key);
}

function preflightPodStatus(pod: unknown) {
  return { ...properties(pod), status: field(pod, "status") ?? { phase: field(pod, "phase") } };
}

function resourceAddress(address: string): { kind: keyof typeof collections; name: string } {
  const [kind, name] = address.split("/");
  assert.ok(
    kind === "pod" ||
      kind === "job.batch" ||
      kind === "secret" ||
      kind === "networkpolicy.networking.k8s.io",
    `unknown preflight resource ${address}`,
  );
  assert.ok(name !== undefined, `missing name in ${address}`);
  return { kind, name };
}

function servingComponent(args: readonly string[]) {
  const component = args
    .find((arg) => arg.startsWith("deployment/"))
    ?.split("-")
    .at(-1);
  assert.ok(component === "api" || component === "worker", "expected an API or worker Deployment");
  return component;
}

// The fixture supplies command responses, and the upgrade script still starts each
// command as a real process. The helm, kubectl and occ shims (plus node in pair
// cases) on its PATH use Bash and the shared command server. Each request reads
// state.json anew. Cases can edit it between runs, and an accepted mutation can
// persist before the command reports failure.
export function createRecoveryCommandHandler(tools: RecoveryTools) {
  return async function handleCommand(
    root: string,
    { command: tool, args, cwd, io }: CommandRequest,
    afterDeploy?: () => void | Promise<void>,
    database?: PreflightDatabase,
  ): Promise<void> {
    const stateFile = join(root, "state.json");
    const persisted: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    const state = record(persisted, "upgrade recovery fixture state.json");
    const save = () => writeFileSync(stateFile, JSON.stringify(state));
    const log = (value: string) => appendFileSync(join(root, "events"), value + "\n");
    const take = (name: string) => {
      const path = join(root, name);
      if (!existsSync(path)) {
        return false;
      }
      unlinkSync(path);
      return true;
    };
    const out = (value: unknown) =>
      io.stdout(typeof value === "string" ? value : JSON.stringify(value));
    const fail = (code: number, message?: string) => {
      if (message !== undefined) {
        io.stderr(message + "\n");
      }
      io.exit(code);
    };
    const fileArg = (name: string) => args[args.indexOf(name) + 1];
    const requiredArg = (name: string) => {
      const value = fileArg(name);
      assert.ok(value !== undefined, `expected a value for ${name}`);
      return value;
    };
    // The replacement revision's ready gateway Pod; an OOM kill shows in its restart history.
    const gatewayPod = () =>
      doctorPod({
        restartCount: state.gatewayRestarts ?? 0,
        lastTerminationReason: state.gatewayRestarts
          ? (state.gatewayLastReason ?? "OOMKilled")
          : undefined,
      });
    if (tool === "node") {
      // Pair cases exercise upgrade orchestration after a successful qualification. The
      // separately selected real-image test verifies compatibility itself.
      if (args[0] === "scripts/upgrade-repository-image-probe.ts") {
        const identity = (image: string) => ({
          image,
          platform: args[3],
          rootDigest: image.split("@").at(-1),
          manifestDigest: image.split("@").at(-1),
          configDigest: image.split("@").at(-1),
        });
        const [, controllerImage, brokerImage] = args;
        assert.ok(controllerImage !== undefined && brokerImage !== undefined);
        out(
          JSON.stringify({ controller: identity(controllerImage), broker: identity(brokerImage) }) +
            "\n",
        );
      } else {
        // Every other script runs in this Node, on the command's own pipes.
        io.script(`exec ${bashString(process.execPath)} "$@"`);
        return;
      }
    } else if (tool === "helm") {
      if (args[0] === "status") {
        if (
          state.api === 0 &&
          state.worker === 0 &&
          existsSync(join(root, "fail-before-helm-intent")) &&
          installationValue(await yamlFile(join(root, "values.json")), "upgradeAttemptId") !==
            installationValue(await yamlFile(join(root, "live-values")), "upgradeAttemptId") &&
          take("fail-before-helm-intent")
        ) {
          return fail(9);
        }
        out(
          args.includes("json")
            ? {
                name: state.release,
                namespace: "system",
                config: await yamlFile(join(root, "live-values")),
                ...(state.recoveryHooks && !state.recoveryRelease
                  ? {
                      manifest:
                        renderedDocuments(
                          await standInChart(tools, join(root, "live-values"), false),
                        )
                          .filter(
                            (object) =>
                              !optionalField(
                                optionalField(field(object, "metadata"), "annotations"),
                                "helm.sh/hook",
                              ),
                          )
                          .map((object) => "---\n" + JSON.stringify(object) + "\n")
                          .join("") +
                        list(state.recoveryBaselineResources ?? [], "baseline manifest documents")
                          .map((item) => "---\n" + JSON.stringify(item) + "\n")
                          .join(""),
                    }
                  : {}),
                ...properties(state.installationRelease),
                ...properties(state.recoveryRelease),
                version: state.version,
                info: {
                  ...properties(optionalField(state.recoveryRelease, "info")),
                  status: state.helmStatus,
                },
              }
            : state.helmStatus,
        );
      } else if (args[0] === "get") {
        out(readFileSync(join(root, "live-values"), "utf8"));
      } else if (args[0] === "template" && state.realChart) {
        // Like the real binary, a failed render shows helm's own stderr and status.
        const rendered = await spawnResult(tools.realHelm, args, { cwd });
        io.stderr(rendered.stderr);
        if (rendered.status !== 0) {
          return fail(rendered.status ?? 1);
        }
        out(rendered.stdout);
      } else if (args[0] === "template") {
        out(
          await standInChart(
            tools,
            requiredArg("--values"),
            Boolean(state.preflightPolicy),
            state.initializationResources,
            state.recoveryCandidateResources,
            Boolean(state.installationSuccessor),
          ),
        );
      } else if (args[0] === "rollback") {
        assert.ok(!args.includes("--no-hooks"));
        assert.equal(Number(args[2]), state.version);
        log("rollback");
        assert.ok(state.recoveryRelease);
        const info = asRecord(field(state.recoveryRelease, "info"));
        assert.ok(info, "expected the release info for a simulated Helm rollback");
        info.description = `Rollback to ${state.version}`;
        state.version = journalInteger(state.version, "Helm revision", 1) + 1;
        state.helmStatus = "deployed";
        state.api = 1;
        state.worker = 1;
        state.rollbackSubmissions =
          journalInteger(state.rollbackSubmissions ?? 0, "Helm rollback submissions") + 1;
        save();
        if (take("lost-rollback-response")) {
          return fail(9);
        }
      } else if (
        args[0] === "upgrade" &&
        args.includes("--dry-run=server") &&
        take("fail-server-dry-run")
      ) {
        return fail(9, "synthetic server dry-run diagnostic");
      } else if (args[0] === "upgrade" && !args.includes("--dry-run=server")) {
        if (state.api !== 0 || state.worker !== 0) {
          return fail(2, "old writers were not stopped");
        }
        state.helmSubmissions = journalInteger(state.helmSubmissions ?? 0, "Helm submissions") + 1;
        save();
        if (take("reject-helm-submission")) {
          return fail(9);
        }
        log("migration");
        state.version = journalInteger(state.version, "Helm revision", 1) + 1;
        copyFileSync(requiredArg("--values"), join(root, "live-values"));
        if (take("fail-migration")) {
          state.helmStatus = "failed";
          save();
          return fail(9);
        }
        state.helmStatus = "deployed";
        const values = await yamlFile(requiredArg("--values"));
        state.controller = yqRaw(optionalField(optionalField(values, "images"), "controller"));
        state.checksum = yqRaw(
          optionalField(optionalField(values, "controlPlane"), "installationChecksum"),
        );
        if (state.installationSuccessor) {
          // The accepted Helm submission creates the selected initializer and its
          // completed child; later reads can diverge independently of the manifest.
          const rendered = await standInChart(
            tools,
            requiredArg("--values"),
            Boolean(state.preflightPolicy),
            state.initializationResources,
            state.recoveryCandidateResources,
            true,
          );
          const documents = renderedDocuments(rendered);
          const desiredJob = documents.find((resource) => field(resource, "kind") === "Job");
          // Store the accepted release separately from live objects so a later
          // same-values Helm record can be checked independently of running Pods.
          state.installationRelease = {
            manifest: documents
              .filter((object) => object !== desiredJob)
              .map((object) => JSON.stringify(object))
              .join("\n---\n"),
            hooks: [
              {
                name: field(field(desiredJob, "metadata"), "name"),
                manifest: JSON.stringify(desiredJob),
                events: ["pre-install", "pre-upgrade"],
                last_run: { phase: "Succeeded" },
              },
            ],
          };
          const job = {
            ...properties(structuredClone(desiredJob)),
            metadata: {
              ...record(field(desiredJob, "metadata"), "initializer Job metadata"),
              namespace: "system",
              uid: "initializer-job",
            },
            status: { conditions: [{ type: "Complete", status: "True" }], succeeded: 1 },
          };
          const jobTemplate = field(field(desiredJob, "spec"), "template");
          const templateSpec = field(jobTemplate, "spec");
          state.installationInitializer = {
            job,
            pod: {
              apiVersion: "v1",
              kind: "Pod",
              metadata: {
                ...properties(structuredClone(field(jobTemplate, "metadata"))),
                namespace: "system",
                name: "initializer-pod",
                uid: "initializer-pod-uid",
                ownerReferences: [
                  {
                    apiVersion: "batch/v1",
                    kind: "Job",
                    name: field(job.metadata, "name"),
                    uid: job.metadata.uid,
                    controller: true,
                  },
                ],
              },
              spec: structuredClone(templateSpec),
              status: {
                phase: "Succeeded",
                initContainerStatuses: list(
                  field(templateSpec, "initContainers"),
                  "initializer init containers",
                ).map((container) => ({
                  name: field(container, "name"),
                  state: { terminated: { exitCode: 0 } },
                })),
                containerStatuses: [{ name: "bootstrap", state: { terminated: { exitCode: 0 } } }],
              },
            },
          };
        }
        state.api = 1;
        state.worker = 1;
        save();
        if (take("lost-helm-response")) {
          return fail(9);
        }
      }
    } else if (tool === "kubectl") {
      if (args.includes("apply") && args.includes("--dry-run=server")) {
        assert.ok(args.includes("--server-side"));
        assert.ok(args.includes("--force-conflicts"));
        assert.ok(args.includes("--field-manager=occ-upgrade-preflight"));
        assert.equal(fileArg("--namespace"), "system");
        const submitted: unknown = JSON.parse(readFileSync(requiredArg("--filename"), "utf8"));
        assert.equal(field(submitted, "apiVersion"), "v1");
        assert.equal(field(submitted, "kind"), "List");
        const items = field(submitted, "items");
        assert.ok(Number(field(items, "length")) > 0);
        assert.equal(state.api, 1);
        assert.equal(state.worker, 1);
        if (state.realChart) {
          for (const item of list(items, "admission List items")) {
            assert.equal(field(item, "apiVersion"), "cert-manager.io/v1");
            assert.equal(field(item, "kind"), "Certificate");
          }
        } else {
          assert.deepEqual(items, [testCertificate]);
          log("certificate-admission");
        }
        if (take("refuse-certificate-admission")) {
          return fail(1, "certificate webhook refused dry-run");
        }
        return io.exit(0);
      }
      if (args.includes("create") && args.includes("--raw")) {
        assert.equal(fileArg("--raw"), "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews");
        const review: unknown = JSON.parse(await io.readInput());
        const attributes = field(field(review, "spec"), "resourceAttributes");
        if (field(attributes, "resource") === "deployments") {
          assert.equal(field(review, "apiVersion"), "authorization.k8s.io/v1");
          assert.equal(field(review, "kind"), "SelfSubjectAccessReview");
          assert.deepEqual(attributes, {
            namespace: "system",
            verb: "patch",
            group: "apps",
            version: "v1",
            resource: "deployments",
            name: "openclaw-enterprise-worker",
          });
          if (state.reviewUnavailable) {
            return fail(1, "private self-review diagnostic");
          }
          if (state.wrongWorkerReview) {
            record(attributes, "worker review attributes").name = "openclaw-enterprise-api";
          }
          out({ ...properties(review), status: { allowed: !state.denyWorkerPatch } });
          return io.exit(0);
        }
        const expectedReview: unknown = {
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: {
            resourceAttributes: {
              namespace: "system",
              verb: "update",
              group: "",
              version: "v1",
              resource: "secrets",
              name: field(field(state.secret, "metadata"), "name"),
            },
          },
        };
        assert.deepEqual(review, expectedReview);
        state.installationUpdateReviews =
          journalInteger(state.installationUpdateReviews ?? 0, "Installation update reviews") + 1;
        save();
        if (state.reviewUnavailable) {
          return fail(1, "private self-review diagnostic");
        }
        delete record(attributes, "Secret review attributes").group; // Kubernetes omits the empty core API group.
        out({
          ...properties(review),
          status: { allowed: !state.denyInstallationUpdate, reason: "private self-review reason" },
        });
        return io.exit(0);
      }
      if (
        !state.recoveryResources &&
        state.installationInitializer &&
        args.includes("get") &&
        args.includes("--filename")
      ) {
        const requested: unknown = JSON.parse(await io.readInput());
        assert.equal(field(requested, "kind"), "Job");
        assert.equal(
          field(field(requested, "metadata"), "name"),
          field(field(field(state.installationInitializer, "job"), "metadata"), "name"),
        );
        out({
          apiVersion: "v1",
          kind: "List",
          items: [field(state.installationInitializer, "job")],
        });
        return io.exit(0);
      }
      if (
        !state.recoveryPod &&
        state.installationInitializer &&
        args.includes("get") &&
        args.includes("--selector") &&
        fileArg("--selector") ===
          `batch.kubernetes.io/controller-uid=${field(field(field(state.installationInitializer, "job"), "metadata"), "uid")}`
      ) {
        out({ items: [field(state.installationInitializer, "pod")] });
        return io.exit(0);
      }
      if (state.recoveryResources && args.includes("get") && args.includes("--filename")) {
        const requested: unknown = JSON.parse(await io.readInput());
        const kind = field(requested, "kind");
        const name = field(field(requested, "metadata"), "name");
        const key = `${kind}/${name}`;
        if (args.includes("--ignore-not-found")) {
          const recreation = state.retiredResourceRecreation;
          if (
            optionalField(recreation, "key") === key &&
            (field(recreation, "stage") === "before dispatch"
              ? existsSync(join(root, "evidence", "helm-recovery", "intent.json"))
              : Number(state.rollbackSubmissions ?? 0) > 0)
          ) {
            record(state.recoveryResources, "recovery resource inventory")[key] = field(
              recreation,
              "resource",
            );
            delete state.retiredResourceRecreation;
            save();
          }
          if (state.retiredResourceReadError) {
            return fail(1, "Forbidden: cannot read selected retired resource");
          }
          assert.equal(fileArg("--output"), "name");
          out(field(state.recoveryResources, key) ? `${key}\n` : "");
          return io.exit(0);
        }
        const actual =
          kind === "Secret"
            ? [state.secret, state.installationSuccessor].find(
                (secret) => optionalResourceField(secret, "name") === name,
              )
            : field(state.recoveryResources, key);
        assert.ok(actual, `known recovery resource ${key}`);
        out({ apiVersion: "v1", kind: "List", items: [actual] });
        return io.exit(0);
      }
      if (
        state.recoveryPod &&
        args.includes("get") &&
        args.includes("--selector") &&
        fileArg("--selector") ===
          `batch.kubernetes.io/controller-uid=${optionalResourceField(optionalField(state.recoveryResources, `Job/${state.release}-initialization`), "uid")}`
      ) {
        out({ items: [state.recoveryPod] });
        return io.exit(0);
      }
      const preflight = (state.preflight ??= {
        secrets: {},
        pods: {},
        jobs: {},
        networkpolicies: {},
        deleted: [],
      });
      const resource = args.find((a) =>
        /^(pod|job\.batch|secret|networkpolicy\.networking\.k8s\.io)\//.test(a),
      );
      if (args.includes("create") && args.includes("--filename")) {
        const source = requiredArg("--filename");
        const manifest = source === "-" ? await io.readInput() : readFileSync(source, "utf8");
        const requested: unknown = JSON.parse(manifest);
        if (state.installationSuccessor) {
          list((record(preflight, "preflight state").requested ??= []), "preflight requests").push(
            structuredClone(requested),
          );
        }
        const requestedKind = field(requested, "kind");
        assert.ok(
          requestedKind === "Secret" ||
            requestedKind === "NetworkPolicy" ||
            requestedKind === "Job",
          "supported preflight resource kind",
        );
        const kinds = {
          Secret: "secret",
          NetworkPolicy: "networkpolicy.networking.k8s.io",
          Job: "job.batch",
        } as const;
        const kind = kinds[requestedKind];
        const metadata = field(requested, "metadata");
        const name = field(metadata, "name");
        const resourceName = `${kind}/${name}`;
        const template =
          requestedKind === "Job" ? field(field(requested, "spec"), "template") : undefined;
        const target =
          requestedKind === "Job" ? requiredContainerName(field(template, "spec")) : kind;
        assert.ok(typeof target === "string", "expected a preflight resource target");
        const faultTarget = optionalField(state.preflightFault, "target");
        const fault = faultTarget === target ? optionalField(state.preflightFault, "mode") : null;
        // Stock kubectl quotes a manifest it cannot decode in its error, before any request.
        if (fault === "decode") {
          return fail(
            1,
            `error: unable to decode "STDIN": Object 'Kind' is missing in '${manifest}'`,
          );
        }
        assert.ok(typeof name === "string", "a created preflight resource must have a name");
        const inventory = record(field(preflight, collections[kind]), collections[kind]);
        // A competing creator wins the name before this request reaches the API.
        if (fault === "conflict") {
          inventory[name] = {
            metadata: { name, uid: randomUUID() },
            foreign: true,
          };
        }
        const previous = inventory[name];
        if (previous) {
          save();
          // Even stdout from a failed create must not establish ownership.
          out(field(field(previous, "metadata"), "uid"));
          return fail(
            1,
            `Error from server (AlreadyExists): ${collections[kind]} "${name}" already exists`,
          );
        }
        if (optionalField(state.preflightFault, "mode") === "interrupt") {
          record(metadata, "preflight resource metadata").annotations = {
            "fixture/manifest": "private-manifest-sentinel",
          };
          if (kind === "secret") {
            const data = asRecord(field(requested, "data"));
            assert.ok(data, "expected preflight Secret data");
            data.fixture = Buffer.from("private-secret-sentinel").toString("base64");
          }
        }
        const uid =
          (faultTarget === target && optionalField(state.preflightFault, "uid")) || randomUUID();
        assert.ok(typeof uid === "string", "expected a preflight resource UID");
        const object = record(requested, "preflight resource");
        const createdMetadata = record(metadata, "preflight resource metadata");
        createdMetadata.uid = uid;
        if (fault === "delayed-delete" || fault === "retained-dependency") {
          createdMetadata.finalizers = ["fixture.openclaw.invalid/cleanup"];
        }
        const created = { kind, name, uid } satisfies PreflightIdentity;
        list((record(preflight, "preflight state").created ??= []), "preflight creations").push(
          created,
        );
        if (fault === "evidence-file" || fault === "evidence-symlink") {
          const destination = join(root, "evidence", "preflight-secret-identity.json");
          if (fault === "evidence-symlink") {
            const target = join(root, "unrelated");
            writeFileSync(target, "unrelated sentinel");
            symlinkSync(target, destination);
          } else {
            writeFileSync(destination, "unrelated sentinel");
          }
        }
        inventory[name] = object;
        if (requestedKind === "Job" && fault !== "no-child") {
          const templateMetadata = field(template, "metadata");
          // Model the Job controller's API objects, not its scheduling or garbage collector.
          // The upgrade command must establish ownership from this owner reference.
          const child = {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              ...properties(templateMetadata),
              name: `${name}-child`,
              namespace: createdMetadata.namespace,
              uid: randomUUID(),
              labels: {
                ...properties(field(templateMetadata, "labels")),
                "batch.kubernetes.io/controller-uid": uid,
              },
              ownerReferences: [
                {
                  apiVersion: "batch/v1",
                  kind: "Job",
                  name,
                  uid: fault === "foreign-child" ? randomUUID() : uid,
                  controller: true,
                },
              ],
            },
            spec: field(template, "spec"),
          };
          const result = await runPreflight(root, cwd, state, child, database);
          record(field(preflight, "pods"), "preflight Pods")[child.metadata.name] = {
            ...child,
            ...properties(result),
          };
          const phase = optionalField(field(result, "status"), "phase") ?? field(result, "phase");
          if (phase === "Succeeded") {
            object.status = { conditions: [{ type: "Complete", status: "True" }] };
          } else if (phase === "Failed") {
            object.status = {
              conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }],
            };
          }
          if (fault === "job-deadline") {
            object.status = {
              conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }],
            };
          }
          const identity = {
            kind: "pod",
            name: child.metadata.name,
            uid: child.metadata.uid,
          } satisfies PreflightIdentity;
          list((record(preflight, "preflight state").children ??= []), "preflight children").push(
            identity,
          );
        }
        save();
        if (fault === "lost") {
          out(uid);
          return fail(9, "create acknowledgement lost: private-response-marker");
        }
        if (fault === "empty") {
          out("");
        } else if (fault === "newline") {
          out(uid + "\n");
        } else if (fileArg("-o") === "jsonpath={.metadata.uid}") {
          // Stock kubectl's jsonpath output has no terminator.
          out(uid);
        } else {
          out(`${resourceName} created`);
        }
      } else if (args.includes("delete")) {
        const raw = args.find((arg) => arg.startsWith("--raw="));
        let named = resource;
        let uid: unknown;
        if (raw) {
          const match =
            /^--raw=\/(api\/v1|apis\/networking\.k8s\.io\/v1|apis\/batch\/v1)\/namespaces\/system\/(pods|secrets|networkpolicies|jobs)\/([a-z0-9.-]+)$/.exec(
              raw,
            );
          assert.ok(match, "DELETE addresses a named Kubernetes API resource");
          const [, api, plural, name] = match;
          assert.ok(
            plural === "pods" ||
              plural === "secrets" ||
              plural === "jobs" ||
              plural === "networkpolicies",
          );
          const resourceType = rawResources[plural];
          assert.equal(api, resourceType.api);
          assert.equal(fileArg("-f"), "-");
          // An empty raw body is a real unguarded DELETE, not a fixture rejection.
          const body = await io.readInput();
          const options: unknown = body ? JSON.parse(body) : {};
          uid = optionalField(field(options, "preconditions"), "uid");
          if (uid) {
            assert.equal(field(options, "apiVersion"), "v1");
            assert.equal(field(options, "kind"), "DeleteOptions");
            assert.equal(
              field(options, "propagationPolicy"),
              plural === "jobs" ? "Foreground" : "Background",
            );
          }
          named = `${resourceType.kind}/${name}`;
        }
        assert.ok(named, "delete must identify a preflight resource");
        const { kind, name } = resourceAddress(named);
        const inventory = record(field(preflight, collections[kind]), collections[kind]);
        const target =
          kind === "job.batch"
            ? containerName(
                optionalField(
                  optionalField(optionalField(inventory[name], "spec"), "template"),
                  "spec",
                ),
              )
            : kind;
        const fault =
          optionalField(state.preflightFault, "target") === target
            ? optionalField(state.preflightFault, "mode")
            : null;
        if (fault === "already-absent" || fault === "absent-job-retained-child") {
          // An independently completed deletion wins before this API request.
          const originalUid = optionalResourceField(inventory[name], "uid");
          delete inventory[name];
          if (fault !== "absent-job-retained-child") {
            const pods = record(field(preflight, "pods"), "preflight Pods");
            for (const [childName, child] of Object.entries(pods)) {
              if (hasOwner(child, originalUid)) {
                delete pods[childName];
              }
            }
          }
          save();
        }
        // Replacement occurs at DELETE, after all client reads, to model the race.
        const replacement = () => {
          const marker = `replacement-secret-${randomUUID()}`;
          const original = structuredClone(inventory[name]);
          assert.ok(original, "replacement requires an original resource");
          return {
            ...properties(original),
            metadata: {
              ...properties(field(original, "metadata")),
              uid: randomUUID(),
              annotations: {
                ...properties(field(field(original, "metadata"), "annotations")),
                fixture: marker,
              },
            },
            ...(kind === "secret"
              ? { data: { credential: Buffer.from(marker).toString("base64") } }
              : {}),
            foreign: true,
          };
        };
        if (fault === "replacement") {
          inventory[name] = replacement();
        }
        const current = inventory[name];
        if (!current) {
          return raw ? fail(1, "NotFound: private-response-marker") : undefined;
        }
        if (uid && field(field(current, "metadata"), "uid") !== uid) {
          save();
          // The API server's wording for a failed UID precondition (HTTP 409).
          return fail(
            1,
            `Error from server (Conflict): Operation cannot be fulfilled on ${collections[kind]} "${name}": Precondition failed: UID in precondition: ${uid}, UID in object meta: ${field(field(current, "metadata"), "uid")}\nprivate-response-marker`,
          );
        }
        if (
          optionalField(state.preflightFault, "mode") === "delete-refused" &&
          field(state.preflightFault, "target") === kind
        ) {
          return fail(
            1,
            `Error from server (Forbidden): ${collections[kind]} "${name}" is forbidden: private-response-marker`,
          );
        }
        // Keep unsafe name-only deletion functional: baseline failures must show
        // the foreign object actually removed, not an unsupported-command error.
        if (kind === "job.batch") {
          // This accepted response removes only real children. A retained child models
          // asynchronous deletion so the caller cannot equate DELETE success with cleanup.
          const pods = record(field(preflight, "pods"), "preflight Pods");
          for (const [childName, child] of Object.entries(pods)) {
            if (hasOwner(child, field(field(current, "metadata"), "uid"))) {
              if (fault === "child-replacement-after-delete") {
                // The original child is gone; another Job now owns a Pod at
                // that name. Its absent discovery label leaves only the saved
                // child identity able to detect the replacement during cleanup.
                pods[childName] = {
                  ...properties(child),
                  metadata: {
                    ...properties(field(child, "metadata")),
                    uid: randomUUID(),
                    labels: {},
                    annotations: { fixture: `replacement-child-${randomUUID()}` },
                    ownerReferences: [
                      {
                        apiVersion: "batch/v1",
                        kind: "Job",
                        name: "another-preflight-job",
                        uid: randomUUID(),
                        controller: true,
                      },
                    ],
                  },
                };
              } else if (
                optionalField(state.preflightFault, "mode") !== "retained-child" ||
                field(state.preflightFault, "target") !==
                  requiredContainerName(field(child, "spec"))
              ) {
                delete pods[childName];
              }
            }
          }
        }
        if (fault === "replacement-after-delete") {
          inventory[name] = replacement();
        } else if (fault === "delayed-delete" || fault === "retained-dependency") {
          record(field(current, "metadata"), "deleting resource metadata").deletionTimestamp =
            "2026-11-11T00:00:00Z";
        } else {
          delete inventory[name];
        }
        list(field(preflight, "deleted"), "preflight deletions").push(named);
        save();
        out({
          apiVersion: "v1",
          kind: "Status",
          status: "Success",
          message: "private-delete-response-marker",
        });
      } else if (
        resource?.startsWith("pod/") &&
        args.includes("get") &&
        state.revisionPods &&
        !list(optionalField(preflight, "children") ?? [], "preflight children").some(
          (child) => resource === `pod/${field(child, "name")}`,
        ) &&
        !(resource.slice("pod/".length) in record(field(preflight, "pods"), "preflight Pods"))
      ) {
        // The revision's Pods, as scripted (a dedicated Agent's two) or after an eviction or
        // replacement: a read by name finds a Pod that still exists, ended or not, as the
        // Kubernetes API does. The startup preflight's Pods are read below.
        const pod = list(state.revisionPods, "revision Pods").find(
          (item) => `pod/${field(field(item, "metadata"), "name")}` === resource,
        );
        if (!pod) {
          return fail(1, `Error from server (NotFound): pods "${resource.slice(4)}" not found`);
        }
        out(pod);
      } else if (resource === "pod/gateway" && args.includes("get")) {
        out(state.gatewayAfter ?? gatewayPod());
      } else if (resource && (args.includes("get") || args.includes("logs"))) {
        const { kind, name } = resourceAddress(resource);
        const inventory = field(preflight, collections[kind]);
        const object = field(inventory, name);
        if (
          optionalResourceField(object, "deletionTimestamp") &&
          optionalField(state.preflightFault, "mode") === "delayed-delete"
        ) {
          const reads = record(
            (record(preflight, "preflight state").deletionReads ??= {}),
            "deletion reads",
          );
          reads[resource] = journalInteger(reads[resource] ?? 0, "resource deletion reads") + 1;
          if (reads[resource] === 3) {
            delete record(inventory, collections[kind])[name];
            save();
            return io.exit(0);
          }
          save();
        }
        if (!object) {
          if (args.includes("--ignore-not-found")) {
            return io.exit(0);
          }
          return fail(1, `Error from server (NotFound): ${resource} not found`);
        }
        if (args.includes("logs")) {
          const component = requiredContainerName(field(object, "spec"));
          assert.ok(typeof component === "string", "logs require a preflight container");
          list(
            (record(preflight, "preflight state").logRequests ??= []),
            "preflight log requests",
          ).push(component);
          if (state.replaceInstallationDuringPreflight) {
            // A separately accepted Secret replacement happens while the temporary
            // startup Job runs, after the upgrade captured both immutable identities.
            const source = state.replaceInstallationDuringPreflight;
            assert.ok(
              source === "secret" || source === "installationSuccessor",
              "expected the scripted replacement Secret slot",
            );
            const secret = state[source];
            assert.ok(secret, "expected the Secret selected for replacement");
            const metadata = record(field(secret, "metadata"), "replacement Secret metadata");
            const uid = metadata.uid;
            assert.ok(typeof uid === "string", "the replacement requires an existing Secret UID");
            metadata.uid = uid + "-replacement";
            delete state.replaceInstallationDuringPreflight;
          }
          if (
            optionalField(state.preflightFault, "target") === component &&
            optionalField(state.preflightFault, "mode") === "replace-during-logs"
          ) {
            // A name-based logs request races with replacement after its preceding GET.
            record(field(object, "metadata"), "replacement Pod metadata").uid = randomUUID();
            record(object, "replacement Pod").log =
              "installation-startup-ready\nunbound-log-sentinel\n";
          }
          save();
          const selected = fileArg("--container");
          if (selected !== component) {
            const initContainers = field(field(object, "spec"), "initContainers");
            if (
              initContainers == null ||
              !list(initContainers, "Pod init containers").some(
                (container) => field(container, "name") === selected,
              )
            ) {
              return fail(1, "unknown container");
            }
            out(optionalField(field(object, "initLogs"), String(selected)) ?? "");
            return io.exit(0);
          }
          const output = field(object, "log");
          if (output === undefined) {
            return fail(1, "container is waiting to start");
          }
          assert.ok(typeof output === "string", "expected preflight container log bytes");
          if (output.includes("\0")) {
            // The command server's ordinary Bash strings cannot hold NUL.
            const escaped = Buffer.from(output).toString("hex").replace(/../g, "\\x$&");
            return io.script(`printf '%b' ${bashString(escaped)}; exit 0`);
          }
          const warning = field(object, "logWarning");
          if (warning) {
            assert.ok(typeof warning === "string", "expected preflight log stderr");
            io.stderr(warning);
          }
          out(output);
          const exitCode = field(object, "logExitCode");
          if (exitCode) {
            assert.ok(typeof exitCode === "number", "expected a preflight log exit code");
            return io.exit(exitCode);
          }
        } else {
          out(kind === "pod" ? preflightPodStatus(object) : object);
        }
      } else if (
        args.includes("get") &&
        args.includes("pods") &&
        (args.some((arg) => arg.startsWith("batch.kubernetes.io/controller-uid=")) ||
          !args.includes("--selector"))
      ) {
        const selector = args.find((arg) => arg.startsWith("batch.kubernetes.io/controller-uid="));
        const ownerUid = selector?.slice("batch.kubernetes.io/controller-uid=".length);
        const pods = Object.values(record(field(preflight, "pods"), "preflight Pods")).filter(
          (pod) =>
            ownerUid === undefined ||
            optionalField(
              field(field(pod, "metadata"), "labels"),
              "batch.kubernetes.io/controller-uid",
            ) === ownerUid,
        );
        const changing = pods.find(
          (pod) =>
            optionalField(state.preflightFault, "mode") === "replace-after-observation" &&
            field(state.preflightFault, "target") === requiredContainerName(field(pod, "spec")),
        );
        if (changing) {
          const observations = record(preflight, "preflight observations");
          if (observations.childObserved && !observations.childReplaced) {
            // The previously observed running Pod disappeared; its name now selects a new UID.
            record(field(changing, "metadata"), "changing Pod metadata").uid = randomUUID();
            record(changing, "changing Pod").phase = "Succeeded";
            observations.childReplaced = true;
          }
          observations.childObserved = true;
          save();
        }
        out({ items: pods.map(preflightPodStatus) });
      } else if (args.includes("--raw=/readyz")) {
        out("ok");
      } else if (args.includes("rollout")) {
        const component = servingComponent(args);
        if (take("fail-rollout-" + component)) {
          return fail(9);
        }
      } else if (args.includes("scale") || args.includes("patch")) {
        const component = servingComponent(args);
        if (args.includes("patch") && component === "worker" && state.denyWorkerPatch) {
          return fail(1, "Forbidden: cannot patch the worker Deployment");
        }
        if (take("fail-scale-" + component)) {
          if (take("block-failure-receipt")) {
            mkdirSync(join(root, "evidence", "native-command-failures.tsv"));
          }
          return fail(9);
        }
        // Simulate another actor between the helper's GET and its mutation. Keep
        // scale support so the same scenario demonstrates the unguarded baseline.
        const identities = record((state.deploymentIdentities ??= {}), "Deployment identity table");
        const identity = record(
          (identities[component] ??= { uid: component + "-deployment-uid", resourceVersion: "1" }),
          "selected Deployment identity",
        );
        if (component === "worker" && take("replace-worker-before-scale")) {
          identity.uid = "replacement-worker-uid";
          identity.resourceVersion = "2";
          state.worker = 1;
        }
        if (component === "worker" && take("edit-worker-before-scale")) {
          identity.resourceVersion = "2";
        }
        save();
        if (args.includes("patch")) {
          assert.equal(fileArg("--type"), "json");
          const patch: unknown = JSON.parse(readFileSync(requiredArg("--patch-file"), "utf8"));
          const document = { metadata: { ...identity }, spec: { replicas: state[component] } };
          // Evaluate the patch in order on a staged document. Earlier test failures
          // take precedence over an unreadable later operation.
          for (const operation of list(patch, "Deployment JSON Patch")) {
            const path = field(operation, "path");
            assert.ok(typeof path === "string", "expected a JSON Patch path");
            const keys = path.slice(1).split("/");
            const parent = keys
              .slice(0, -1)
              .reduce<unknown>((value, key) => field(value, key), document);
            const key = String(keys.at(-1));
            const op = field(operation, "op");
            if (op === "test") {
              if (field(parent, key) !== field(operation, "value")) {
                return fail(1, "JSON Patch test failed");
              }
            } else {
              assert.equal(op, "replace");
              record(parent, `JSON Patch path ${path}`)[key] = field(operation, "value");
            }
          }
          const replicas = document.spec.replicas;
          assert.ok(
            typeof replicas === "number" && Number.isSafeInteger(replicas) && replicas >= 0,
            "expected a nonnegative replica count",
          );
          Object.assign(identity, document.metadata);
          state[component] = replicas;
        } else {
          state[component] = 0;
        }
        identity.resourceVersion = String(Number(identity.resourceVersion) + 1);
        save();
        log("scale-" + component);
      } else if (args.includes("replace")) {
        const secret: unknown = JSON.parse(await io.readInput());
        if (state.denyInstallationUpdate) {
          return fail(1, "fixture denied named Secret update");
        }
        const metadata = field(secret, "metadata");
        const liveMetadata = field(state.secret, "metadata");
        const version = field(metadata, "resourceVersion");
        if (
          typeof version !== "string" ||
          !version ||
          version !== field(liveMetadata, "resourceVersion")
        ) {
          return fail(11);
        }
        const name = field(metadata, "name");
        assert.ok(typeof name === "string" && name, "expected a named Installation Secret update");
        assert.equal(
          name,
          field(liveMetadata, "name"),
          "the update must address the live Installation Secret",
        );
        if (
          field(state.secret, "immutable") &&
          !isDeepStrictEqual(field(secret, "data"), field(state.secret, "data"))
        ) {
          return fail(1, "Secret data is immutable");
        }
        record(metadata, "Installation Secret metadata").resourceVersion = String(
          Number(version) + 1,
        );
        state.secret = secret;
        save();
        log("secret-replaced");
        if (take("lost-secret-response")) {
          return fail(9);
        }
      } else if (args.includes("get") && args.includes("secret")) {
        const name = args[args.indexOf("secret") + 1];
        if (name === optionalResourceField(state.installationSuccessor, "name")) {
          out(state.installationSuccessor);
        } else if (
          name !== field(field(state.secret, "metadata"), "name") &&
          name === state.collectorSecretName
        ) {
          if (!state.collectorSecret) {
            return fail(1, 'secrets "' + name + '" not found');
          }
          out(state.collectorSecret);
        } else if (name === field(field(state.secret, "metadata"), "name")) {
          out(state.secret);
        } else {
          return fail(1, 'secrets "' + name + '" not found');
        }
      } else if (args.includes("get") && args.includes("nodes")) {
        const architecture = process.arch === "x64" ? "amd64" : "arm64";
        if (existsSync(join(root, "change-node"))) {
          state.nodeReads = journalInteger(state.nodeReads ?? 0, "Node reads") + 1;
          save();
        }
        const uid = Number(state.nodeReads ?? 0) > 1 ? "replacement-node-uid" : "node-uid";
        out({
          items: [
            {
              metadata: {
                name: "node-a",
                uid,
                labels: { "kubernetes.io/os": "linux", "kubernetes.io/arch": architecture },
              },
              status: { nodeInfo: { operatingSystem: "linux", architecture } },
            },
          ],
        });
      } else if (
        args.includes("get") &&
        args.includes("deployment") &&
        args.includes("openclaw-enterprise-worker")
      ) {
        out({
          metadata: { labels: { "app.kubernetes.io/instance": state.release } },
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: "repository-credentials",
                    args: ["--public-origin", "https://git.system.svc.cluster.local"],
                  },
                ],
              },
            },
          },
        });
      } else if (args.some((a) => a.startsWith("deployment/")) && args.includes("get")) {
        const component = servingComponent(args);
        const image =
          component === "worker"
            ? (state.workerObservedImage ?? state.controller)
            : state.controller;
        const container: ServingContainer = { name: component, image };
        const podSpec: ServingPodSpec = { containers: [container] };
        if (state.installationSuccessor) {
          const values = await yamlFile(join(root, "live-values"));
          const installation = field(values, "installation");
          podSpec.volumes = [
            {
              name: "installation-startup",
              secret: {
                secretName: field(installation, "secretName"),
                items: [{ key: field(installation, "key"), path: "installation.yaml" }],
              },
            },
          ];
          container.env = [
            { name: "OCC_CONFIG_PATH", value: "/etc/openclaw/installation/installation.yaml" },
          ];
          container.volumeMounts = [
            {
              name: "installation-startup",
              mountPath: state.installationDeploymentMountPath ?? "/etc/openclaw/installation",
              readOnly: true,
            },
          ];
        }
        if (component === "worker" && state.workerPlacement !== "container") {
          podSpec.containers =
            state.workerPlacement === "ambiguous"
              ? [container]
              : [{ name: "repository-credentials", image: "broker" }];
          if (state.workerPlacement !== "missing") {
            podSpec.initContainers = [
              {
                ...container,
                ...(state.workerPlacement === "nonrestartable" ? {} : { restartPolicy: "Always" }),
              },
            ];
          }
        }
        if (args.some((a) => a.startsWith("jsonpath="))) {
          out(
            podSpec.containers
              .filter((item) => item.name === component)
              .map((item) => item.image)
              .join(" "),
          );
        } else {
          out({
            metadata: {
              name: "openclaw-enterprise-" + component,
              uid:
                optionalField(optionalField(state.deploymentIdentities, component), "uid") ??
                component + "-deployment-uid",
              resourceVersion:
                optionalField(
                  optionalField(state.deploymentIdentities, component),
                  "resourceVersion",
                ) ?? "1",
              generation: 1,
              labels: {
                "app.kubernetes.io/instance": state.release,
                "app.kubernetes.io/component": component,
              },
            },
            spec: {
              replicas: state[component],
              template: {
                metadata: { annotations: { "openclaw.dev/installation-checksum": state.checksum } },
                spec: podSpec,
              },
            },
            status: {
              observedGeneration: 1,
              replicas: 1,
              updatedReplicas: 1,
              availableReplicas: 1,
            },
          });
        }
      } else if (args.includes("get") && args.includes("jobs")) {
        out({ items: state.initJobActive ? [{ status: { active: 0, conditions: [] } }] : [] });
      } else if (args.includes("get") && args.includes("replicasets")) {
        const selector = requiredArg("--selector");
        const component = selector.endsWith("component=worker") ? "worker" : "api";
        out({
          items: [
            {
              metadata: {
                name: component + "-rs",
                uid: component + "-rs-uid",
                ownerReferences: [
                  {
                    kind: "Deployment",
                    name: "openclaw-enterprise-" + component,
                    uid: component + "-deployment-uid",
                    controller: true,
                  },
                ],
              },
            },
          ],
        });
      } else if (args.includes("get") && args.includes("pods")) {
        const initialization = args.some((a) => a.includes("component=initialization"));
        const revision = args.some((a) => a === `openclaw.dev/revision=${state.activeRevision}`);
        const pairComponent = args.some((a) => a.includes("app.kubernetes.io/component=worker"))
          ? "worker"
          : args.some((a) => a.includes("app.kubernetes.io/component=api"))
            ? "api"
            : null;
        if (pairComponent && state.installationSuccessor && !state.simulatePair) {
          const installation = field(await yamlFile(join(root, "live-values")), "installation");
          out({
            items: state[pairComponent]
              ? [
                  {
                    metadata: { name: `${pairComponent}-pod`, uid: `${pairComponent}-pod-uid` },
                    spec: {
                      containers: [
                        {
                          name: pairComponent,
                          image: state.controller,
                          env: [
                            {
                              name: "OCC_CONFIG_PATH",
                              value: "/etc/openclaw/installation/installation.yaml",
                            },
                          ],
                          volumeMounts: [
                            {
                              name: "installation-startup",
                              mountPath:
                                state.installationPodMountPath ?? "/etc/openclaw/installation",
                              readOnly: true,
                            },
                          ],
                        },
                      ],
                      volumes: [
                        {
                          name: "installation-startup",
                          secret: {
                            secretName:
                              state.installationPodSecretName ?? field(installation, "secretName"),
                            items: [{ key: field(installation, "key"), path: "installation.yaml" }],
                          },
                        },
                      ],
                    },
                    status: {
                      phase: "Running",
                      conditions: [{ type: "Ready", status: "True" }],
                    },
                  },
                ]
              : [],
          });
        } else if (pairComponent && state.simulatePair) {
          const proof: unknown = JSON.parse(
            readFileSync(join(root, "evidence", "pair-proof.json"), "utf8"),
          );
          const controller = field(proof, "controller");
          const status = (name: string, image: unknown) => ({
            name,
            imageID: `containerd://${field(image, "rootDigest")}`,
            containerID: "containerd://" + name,
            restartCount: 0,
            ready: true,
            state: { running: {} },
          });
          const worker = { name: pairComponent, image: field(controller, "image") };
          const restartable = pairComponent === "worker" && state.workerPlacement === "restartable";
          const podSpec: ServingPodSpec = {
            nodeName: "node-a",
            containers: restartable ? [] : [worker],
          };
          const podStatus: {
            phase: string;
            conditions: { type: string; status: string }[];
            containerStatuses: ReturnType<typeof status>[];
            initContainerStatuses?: ReturnType<typeof status>[];
          } = {
            phase: "Running",
            conditions: [{ type: "Ready", status: "True" }],
            containerStatuses: restartable ? [] : [status(pairComponent, controller)],
          };
          if (restartable) {
            podSpec.initContainers = [{ ...worker, restartPolicy: "Always" }];
            podStatus.initContainerStatuses = [status("worker", controller)];
          }
          if (pairComponent === "worker") {
            const broker = field(proof, "broker");
            podSpec.containers.push({
              name: "repository-credentials",
              image: field(broker, "image"),
            });
            const brokerStatus = status("repository-credentials", broker);
            if (existsSync(join(root, "wrong-broker-identity"))) {
              brokerStatus.imageID = "containerd://sha256:" + "0".repeat(64);
            }
            podStatus.containerStatuses.push(brokerStatus);
          }
          out({
            items: [
              {
                metadata: {
                  name: pairComponent + "-pod",
                  uid: pairComponent + "-pod-uid",
                  ownerReferences: [
                    {
                      kind: "ReplicaSet",
                      name: pairComponent + "-rs",
                      uid: pairComponent + "-rs-uid",
                      controller: true,
                    },
                  ],
                },
                spec: podSpec,
                status: podStatus,
              },
            ],
          });
        } else {
          out({
            items:
              initialization && state.initActive
                ? [{ status: { phase: "Running" } }]
                : revision
                  ? (state.revisionPods ?? [state.gatewayReady ?? gatewayPod()])
                  : [],
          });
        }
      } else if (args.includes("get")) {
        out({ items: [] });
      } else if (args.includes("exec") && args.includes("/sys/fs/cgroup/memory.max")) {
        // The gateway container's cgroup v2 files: a 3 GiB limit, with free memory taken
        // from the case's script (ample by default) and 100 MiB of reclaimable file cache.
        // "unlimited" is a container without a limit (memory.max reads "max"); "transient"
        // is a dropped kubelet connection, and "missing" a container without the files.
        // "slow:N" answers N after 8.5 s, past an 8 s upgrade timeout.
        const samples =
          state.gatewayFree == null ? undefined : list(state.gatewayFree, "gateway memory samples");
        let free = samples?.shift() ?? 2048;
        save();
        log(`gateway-memory ${free}`);
        if (String(free).startsWith("slow:")) {
          const sample = typeof free === "string" ? free : list(free, "slow gateway memory sample");
          free = Number(sample.slice("slow:".length));
          await new Promise((resolve) => setTimeout(resolve, 8500));
        }
        if (free === "transient") {
          return fail(
            1,
            "error: unable to upgrade connection: error dialing backend: dial tcp 10.0.0.5:10250: i/o timeout",
          );
        }
        if (free === "missing") {
          return fail(
            1,
            "cat: /sys/fs/cgroup/memory.max: No such file or directory\ncommand terminated with exit code 1",
          );
        }
        const limit = 3 * 1024 ** 3;
        const cache = 100 * 1024 ** 2;
        const used = free === "unlimited" ? 1024 ** 3 : limit - Number(free) * 1024 ** 2 + cache;
        out(`${free === "unlimited" ? "max" : limit}\n${used}\nanon 1\ninactive_file ${cache}\n`);
      } else if (args.includes("exec") && args.includes("doctor")) {
        log(`doctor ${args.slice(args.indexOf("--") + 1).join(" ")}`);
        // Kubernetes evicts, replaces or restarts the gateway while Doctor runs, as node memory
        // pressure did on a production-shaped cluster (finding 2736). Doctor then passes, or
        // fails as a fault below says.
        if (state.afterDoctor) {
          // Later commands read the whole observation, including the next gateway memory samples.
          const observation: object = Object(state.afterDoctor);
          Object.assign(state, observation);
          delete state.afterDoctor;
          save();
        }
        // The kubelet ended the gateway Pod while Doctor ran (an eviction): the exec stream
        // ends with the kill, and the container did not restart.
        if (take("doctor-evicted")) {
          return fail(137, "command terminated with exit code 137");
        }
        if (take("doctor-error")) {
          return fail(1, "command terminated with exit code 1");
        }
        // The container reached its memory limit while Doctor ran: Kubernetes killed both.
        // "doctor-killed" is another kill of both, such as a failed liveness probe.
        for (const [fault, reason] of [
          ["doctor-oom", "OOMKilled"],
          ["doctor-killed", "Error"],
        ] as const) {
          if (take(fault)) {
            const restarts = state.gatewayRestarts ?? 0;
            assert.ok(
              typeof restarts === "number" && Number.isInteger(restarts) && restarts >= 0,
              "expected a nonnegative gateway restart count",
            );
            state.gatewayRestarts = restarts + 1;
            state.gatewayLastReason = reason;
            save();
            return fail(137, "command terminated with exit code 137");
          }
        }
        // A slow Doctor: it reports whether the upgrade still held its evidence lock when it
        // ended, then fails with an error that quotes an earlier exit code 137.
        if (take("doctor-hold")) {
          await new Promise((resolve) => setTimeout(resolve, Number(state.doctorHoldMs)));
          const lock = existsSync(join(root, "evidence", ".upgrade-lock")) ? "held" : "released";
          log(`doctor-ended lock ${lock}`);
          return fail(
            1,
            "doctor found an error: gateway log: command terminated with exit code 137\ncommand terminated with exit code 1",
          );
        }
        // Doctor reached its own heap cap: V8 aborts it and the gateway keeps running.
        if (take("doctor-heap")) {
          return fail(
            134,
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\ncommand terminated with exit code 134",
          );
        }
        // Doctor runs for doctorSpanMs and logs its end, to show whether Doctors overlap.
        if (state.doctorSpanMs) {
          await new Promise((resolve) => setTimeout(resolve, Number(state.doctorSpanMs)));
          log("doctor-end");
        }
        out("{}");
      } else if (args.includes("exec")) {
        if (args.includes("worker") && state.simulatePair && take("fail-capability")) {
          return fail(9);
        }
        if (state.simulatePair) {
          const reply =
            list(state.capabilityReplies, "scripted capability replies").shift() ?? readyCapability;
          const result = await runDeployedCapability(args, cwd, reply);
          const requests = result.requests.map(({ method, path, body }) => ({
            ...(method === undefined ? {} : { method }),
            ...(path === undefined ? {} : { path }),
            body,
          }));
          const probe = {
            dispatches: journalInteger(state.dispatches, "dispatch count at capability probe"),
            requests,
          } satisfies CapabilityProbe;
          list(state.capabilityProbes, "capability probes").push(probe);
          save();
          out(result.stdout);
          io.stderr(result.stderr);
          return io.exit(result.status);
        }
        out("{}");
      }
    } else if (tool === "occ") {
      if (
        state.continuity &&
        args.includes("agent") &&
        (args.includes("get") || args.includes("runtime"))
      ) {
        const selected = field(state.continuity, Number(state.version) > 1 ? "after" : "before");
        const operation = args.includes("runtime") ? "runtime" : "agent";
        const verb = operation === "runtime" ? "runtime" : "get";
        if (
          fileArg("--namespace") !== continuityNamespace ||
          args[args.indexOf(verb) + 1] !== continuityAgent ||
          (operation === "runtime" && fileArg("--revision") !== continuityRevision)
        ) {
          return fail(1, "exact Agent and explicit original revision required");
        }
        log("continuity-" + operation);
        const error = field(selected, operation === "runtime" ? "runtimeError" : "agentError");
        if (error) {
          return fail(1, String(error));
        }
        if (operation === "runtime" && Number(state.version) > 1) {
          const revision = field(selected, "changeRevisionAfterRuntime");
          if (revision) {
            record(field(selected, "agent"), "scripted continuity Agent").activeRevisionId =
              revision;
            delete record(selected, "continuity observation").changeRevisionAfterRuntime;
            save();
          }
          if (field(selected, "changeHelmRevisionAfterRuntime")) {
            // An independent release finishes while runtime status is being read.
            state.version = journalInteger(state.version, "Helm revision", 1) + 1;
            delete record(selected, "continuity observation").changeHelmRevisionAfterRuntime;
            save();
          }
        }
        out(field(selected, operation));
      } else if (args.includes("deployment-inventory")) {
        const readCount = state.inventoryReadCount ?? 0;
        const response = optionalField(state.inventoryResponses, String(readCount));
        state.inventoryReadCount = journalInteger(readCount, "inventory reads") + 1;
        save();
        if (state.inventoryRequiresApi && state.api === 0) {
          return fail(1, "API unavailable");
        }
        if (response === "denied") {
          return fail(1, "permission denied");
        }
        if (response !== undefined) {
          out(response);
          return io.exit(0);
        }
        out({
          installationId: "ins_test",
          namespaces: state.inventoryNamespaces ?? [
            {
              id: "ns_test",
              status: "ready",
              agents: state.agent
                ? [
                    {
                      id: "agt_test",
                      status: "active",
                      desiredRuntimeState: "running",
                      executionMode: "embedded",
                      activeRevisionId: "rev_old",
                      deploymentInProgress: false,
                      repositoryWorkerRestart: "reverification-supported",
                    },
                  ]
                : [],
            },
          ],
        });
      } else if (
        state.names &&
        args.includes("get") &&
        (args.includes("agent") || args.includes("namespace"))
      ) {
        // Reads a scripted resource name; an unlisted ID stands for a denied read, and so does an
        // Agent read outside its own Namespace. Like a CLI that can take input, it drains stdin.
        await io.readInput();
        log("read " + args.at(-1));
        const id = args[args.length - 1];
        assert.ok(id !== undefined);
        const home = list(state.inventoryNamespaces ?? [], "inventory namespaces").find(
          (namespace) =>
            list(field(namespace, "agents"), "namespace agents").some(
              (agent) => field(agent, "id") === id,
            ),
        );
        const name =
          args.includes("agent") &&
          (!args.includes("--namespace") || fileArg("--namespace") !== optionalField(home, "id"))
            ? undefined
            : field(state.names, id);
        if (name === undefined) {
          return fail(1, "permission denied");
        }
        out({
          id: args.at(-1),
          name,
          ...(args.includes("agent")
            ? {
                configurationId: `cfg_${args.at(-1)}`,
                activeRevisionId: state.activeRevision ?? "rev_old",
              }
            : {}),
        });
      } else if (args.includes("agent") && args.includes("revision")) {
        log("revision-read " + args.at(-1));
        if (state.activeRevisionResponse === "denied") {
          return fail(1, "revision read denied");
        }
        out(
          state.activeRevisionResponse ?? {
            id: "rev_old",
            namespaceId: "ns_test",
            agentId: "agt_test",
            harness: {
              id: "codex",
              version: "1",
              mode: "dedicated",
              overrides: {},
              configuration: {},
            },
          },
        );
        if (take("revision-read-failure")) {
          return fail(1, "revision read failed after output");
        }
      } else if (args.includes("configuration") && args.includes("get")) {
        // The Agent's saved Configuration (its draft), as OCC returns it.
        const id = args[args.length - 1];
        out({
          id,
          kind: "agent",
          values: optionalField(state.configurationValues, String(id)) ?? {},
        });
      } else if (args.includes("deploy")) {
        state.dispatches = journalInteger(state.dispatches, "dispatch count") + 1;
        // A scripted failure for this Agent answers like the real occ: exit 1 and its error
        // on stderr. A refusal (4xx) commits no revision, so the selected revision stays.
        const agentId = requiredArg("deploy");
        const failure = optionalField(state.deployFailures, agentId);
        if (failure) {
          delete record(state.deployFailures, "scripted deployment failures")[agentId];
          save();
          log(`agent-deploy-failed ${agentId}`);
          return fail(1, String(failure));
        }
        // occ prints notices on stderr, for example when the revision has no Harness
        // overrides to retain; the helper must show them in its run output.
        const notice = optionalField(state.deployNotices, agentId);
        if (notice) {
          io.stderr(`${notice}\n`);
        }
        const deploymentReply = state.nextDeployment ?? { id: "rev_new", status: "succeeded" };
        const id = field(deploymentReply, "id");
        const status = field(deploymentReply, "status");
        delete state.nextDeployment;
        if (status === "succeeded") {
          state.activeRevision = id;
        }
        const deployment = [fileArg("--namespace"), agentId, id].join("/");
        if (state.deployments == null) {
          throw new TypeError(
            `Cannot set properties of ${state.deployments} (setting '${deployment}')`,
          );
        }
        record(state.deployments, "deployment statuses")[deployment] = status;
        save();
        log(`agent-deploy ${agentId}`);
        await afterDeploy?.();
        if (take("lost-agent-response")) {
          return fail(9);
        }
        out({ id });
      } else if (args.includes("agent") && args.includes("get")) {
        out({
          id: "agt_test",
          name: "Mail triage",
          configurationId: "cfg_agt_test",
          activeRevisionId: state.activeRevision ?? "rev_old",
        });
      } else if (args.includes("deployment-status")) {
        const namespaceId = fileArg("--namespace");
        const agentId = args.at(-2);
        const deploymentId = args[args.length - 1];
        const status = field(state.deployments, [namespaceId, agentId, deploymentId].join("/"));
        if (!status) {
          return fail(1, "deployment not found");
        }
        if (take("deployment-status-running")) {
          out({ namespaceId, agentId, deploymentId, status: "running" });
          return io.exit(0);
        }
        const response = optionalField(state.deploymentStatusResponses, String(deploymentId));
        if (response) {
          out(field(response, "stdout"));
          const exitCode = field(response, "exitCode") ?? 0;
          assert.ok(typeof exitCode === "number", "expected a deployment status exit code");
          return io.exit(exitCode);
        }
        out({ namespaceId, agentId, deploymentId, status });
        if (take("fail-deployment-status-after-output")) {
          return fail(9);
        }
      } else {
        out({ id: "ins_test", name: state.installationName });
      }
    }
    io.exit(0);
  };
}
