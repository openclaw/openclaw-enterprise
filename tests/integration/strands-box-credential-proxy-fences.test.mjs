import assert from "node:assert/strict";
import test from "node:test";
import { exactStrandsPodAdmission } from "../../apps/controller/src/drivers/strands-box/admission.ts";
import { observePinnedStrandsContainer } from "../../apps/controller/src/drivers/strands-box/pinned-container.ts";
import {
  exactStrandsNetworkFence,
  strandsPolicySelectsPod,
} from "../../apps/controller/src/drivers/strands-box/network-policy.ts";

const key = "example.org/restricted";
const expression = (operator, values) => ({ matchExpressions: [{ key, operator, values }] });
const missingNotIn = expression("NotIn", [""]);

test("NetworkPolicy selector matches Kubernetes presence semantics for missing and empty-valued labels", () => {
  // Truth table from metav1.LabelSelectorAsSelector and labels.Requirement.Matches, not from this evaluator.
  const labels = [{}, { [key]: "" }, { [key]: "restricted" }];
  for (const [selector, expected] of [
    [expression("In", [""]), [false, true, false]],
    [missingNotIn, [true, false, true]],
    [expression("In", ["restricted"]), [false, false, true]],
    [expression("NotIn", ["restricted"]), [true, true, false]],
    [expression("Exists"), [false, true, true]],
    [expression("DoesNotExist"), [true, false, false]],
    [{ matchLabels: { [key]: "" } }, [false, true, false]],
    [{ matchLabels: { [key]: "restricted" } }, [false, false, true]],
    [{}, [true, true, true]],
  ]) {
    assert.deepEqual(
      labels.map((l) => strandsPolicySelectsPod(selector, l)),
      expected,
      JSON.stringify(selector),
    );
  }
  assert.throws(() => strandsPolicySelectsPod(expression("Unsupported", [""]), {}), /Unsupported/);
});

const executionId = "our-execution";
const policyHash = "our-policy";
for (const [role, dangerousDirection] of [
  ["workload", "egress"],
  ["sender", "ingress"],
  ["sender", "egress"],
]) {
  test(
    "installation refuses additive allow-all " +
      dangerousDirection +
      " selecting missing label on " +
      role,
    () => {
      const labels = { "openclaw.dev/strands-role": role };
      const rule = (selector, grants) => ({ podSelector: selector, [dangerousDirection]: grants });
      const expected = {
        podSelector: { matchLabels: labels },
        egress: [{ to: [{ podSelector: { matchLabels: { peer: "ours" } } }] }],
        ...(role === "sender"
          ? { ingress: [{ from: [{ podSelector: { matchLabels: { peer: "ours" } } }] }] }
          : {}),
      };
      const owned = {
        metadata: {
          name: "our-fence",
          uid: "fence-uid",
          labels: { "openclaw.dev/strands-execution": executionId },
          annotations: { "openclaw.dev/strands-policy-sha256": policyHash },
        },
        spec: expected,
      };
      const verify = (spec) =>
        exactStrandsNetworkFence(
          [owned, { metadata: { name: "additional" }, spec }],
          labels,
          expected,
          executionId,
          policyHash,
          [],
        );
      assert.equal(
        verify(rule(missingNotIn, [])),
        "fence-uid",
        "selected deny-only grants nothing",
      );
      assert.equal(
        verify(rule(expression("In", [""]), [{}])),
        "fence-uid",
        "In with missing key really does not select this Pod",
      );
      assert.equal(
        verify(rule(missingNotIn, [{}])),
        undefined,
        "Kubernetes adds grants from NotIn even when the label is missing",
      );
      assert.throws(
        () => verify(rule(expression("Unsupported", [""]), [{}])),
        /Unsupported/,
        "unrecognized selector cannot yield installation",
      );
    },
  );
}

test("admitted sender, workload and init must preserve probes, executable shape and exact resources including API defaults", () => {
  const image = "registry.example/strands@sha256:" + "a".repeat(64);
  const resources = {
    requests: { cpu: "0.1", memory: "256Mi" },
    limits: { cpu: "2000m", memory: "1Gi" },
  };
  const container = {
    name: "agent",
    image,
    resources,
    readinessProbe: { httpGet: { port: 18791, path: "/readyz" }, periodSeconds: 2 },
  };
  const desired = {
    restartPolicy: "OnFailure",
    enableServiceLinks: false,
    automountServiceAccountToken: false,
    containers: [container],
    initContainers: [{ name: "prepare-workspace", image, resources }],
    volumes: [],
  };
  const normalContainer = (c) => ({
    ...c,
    imagePullPolicy: "IfNotPresent",
    terminationMessagePolicy: "File",
    terminationMessagePath: "/dev/termination-log",
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "2", memory: "1024Mi" },
    },
  });
  // REST shapes deliberately spelled out, including the API's defaults on an existing HTTP probe.
  const defaulted = {
    ...desired,
    nodeName: "scheduled-node",
    serviceAccount: "default",
    serviceAccountName: "default",
    dnsPolicy: "ClusterFirst",
    terminationGracePeriodSeconds: 30,
    priority: 0,
    preemptionPolicy: "PreemptLowerPriority",
    schedulerName: "default-scheduler",
    tolerations: ["not-ready", "unreachable"].map((t) => ({
      key: "node.kubernetes.io/" + t,
      effect: "NoExecute",
      operator: "Exists",
      tolerationSeconds: 300,
    })),
    containers: [
      normalContainer({
        ...container,
        readinessProbe: {
          httpGet: { path: "/readyz", port: 18791, scheme: "HTTP" },
          periodSeconds: 2,
          timeoutSeconds: 1,
          successThreshold: 1,
          failureThreshold: 3,
        },
      }),
    ],
    initContainers: [normalContainer(desired.initContainers[0])],
  };
  const valid = structuredClone(defaulted);
  assert.equal(
    exactStrandsPodAdmission(desired, valid),
    true,
    "normal API defaults and equivalent fixed-point quantities",
  );
  for (const field of ["containers", "initContainers"]) {
    for (const [why, change] of Object.entries({
      "exec startup probe": (c) => {
        c.startupProbe = { exec: { command: ["unexpected-command"] } };
      },
      "liveness HTTP to another destination": (c) => {
        c.livenessProbe = { httpGet: { host: "unexpected", port: 1234 } };
      },
      "extended device resource": (c) => {
        c.resources.limits["vendor.example/device"] = "1";
      },
      "removed resource limits": (c) => {
        delete c.resources.limits;
      },
      "removed CPU request": (c) => {
        delete c.resources.requests.cpu;
      },
      "changed resource amount": (c) => {
        c.resources.limits.cpu = "3";
      },
      "new dynamic resource claim": (c) => {
        c.resources.claims = [{ name: "unexpected-device" }];
      },
      "lifecycle hook": (c) => {
        c.lifecycle = { postStart: { exec: { command: ["unexpected-command"] } } };
      },
      "new environment": (c) => {
        c.envFrom = [{ secretRef: { name: "sender" } }];
      },
      "new block device mount": (c) => {
        c.volumeDevices = [{ name: "host-device", devicePath: "/dev/unexpected" }];
      },
      "changed image": (c) => {
        c.image = "unadmitted-image";
      },
    })) {
      const live = structuredClone(defaulted);
      change(live[field][0]);
      assert.equal(exactStrandsPodAdmission(desired, live), false, field + " " + why);
    }
  }
  const differentProbe = structuredClone(defaulted);
  differentProbe.containers[0].readinessProbe.httpGet.path = "/other-action";
  assert.equal(
    exactStrandsPodAdmission(desired, differentProbe),
    false,
    "cannot discard changed callback while dropping defaults",
  );
  for (const additions of [
    { resourceClaims: [{ name: "unexpected-device" }] },
    { hostPID: true },
    { ephemeralContainers: [{ name: "unadmitted" }] },
    { overhead: { cpu: "1" } },
  ]) {
    assert.equal(
      exactStrandsPodAdmission(desired, { ...defaulted, ...additions }),
      false,
      "Pod " + Object.keys(additions)[0],
    );
  }
});

test("sender proof requires the actual admitted and running image, and cannot survive a Pod or container replacement", async () => {
  const image = "registry.example/sender@sha256:" + "a".repeat(64);
  const previous = "registry.example/sender@sha256:" + "b".repeat(64);
  const senderPod = () => ({
    metadata: { uid: "sender-pod" },
    spec: { containers: [{ name: "sender", image }] },
    status: {
      phase: "Running",
      podIP: "192.0.2.1",
      containerStatuses: [
        {
          name: "sender",
          ready: true,
          state: { running: {} },
          imageID: image,
          containerID: "container-A",
        },
      ],
    },
  });
  async function observe(initial, duringProof) {
    const pod = senderPod();
    initial?.(pod);
    let proofs = 0;
    const result = await observePinnedStrandsContainer(
      async () => structuredClone(pod),
      "sender",
      image,
      async () => {
        proofs++;
        duringProof?.(pod);
        return "valid-live-sender-proof";
      },
    );
    return { proof: result?.observation, proofs };
  }
  assert.deepEqual(await observe(), { proof: "valid-live-sender-proof", proofs: 1 });
  const statusImage = (pod) => {
    pod.status.containerStatuses[0].imageID = previous;
  };
  const admittedImage = (pod) => {
    pod.spec.containers[0].image = previous;
  };
  // Correct desired image cannot mask old running bytes, nor vice versa. Do not even start the proof.
  for (const mismatch of [statusImage, admittedImage]) {
    assert.deepEqual(await observe(mismatch), { proof: undefined, proofs: 0 });
  }
  const replacePod = (pod) => {
    pod.metadata.uid = "replacement-pod";
  };
  const replaceContainer = (pod) => {
    pod.status.containerStatuses[0].containerID = "container-B";
  };
  // These changes race a successful proof callback. Its result belongs only to the original sender.
  for (const replace of [replacePod, replaceContainer, statusImage]) {
    assert.deepEqual(await observe(undefined, replace), { proof: undefined, proofs: 1 });
  }
});
