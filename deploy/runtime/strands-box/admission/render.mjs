// Kubernetes 1.35, dedicated lab only. Bind this policy before installing
// runtime-class.yaml and granting a PSA runtimeClasses exemption. Revoke the
// exemption first during teardown. Fail covers evaluation errors, not removal
// of these objects. Only cluster operators may administer any of them.
// Tenant workload writers, Pod exec users and node operators must be trusted.
// Pin the tenant's rendered image and use the actual ReplicaSet controller SA.
// Render operator-owned Kubernetes admission objects for one approved tenant.
const [namespace, image, creator] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace) ||
  !/^[a-z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(image) ||
  !/^system:serviceaccount:[a-z0-9-]+:[a-z0-9.-]+$/.test(creator)
) {
  throw new Error("Expected tenant namespace, digest-pinned image and Pod creator ServiceAccount");
}

const apiVersion = "admissionregistration.k8s.io/v1";
const name = "oce-strands-box";
const policy = {
  apiVersion,
  kind: "ValidatingAdmissionPolicy",
  metadata: { name },
  spec: {
    failurePolicy: "Fail",
    matchConstraints: {
      resourceRules: [
        {
          apiGroups: [""],
          apiVersions: ["v1"],
          resources: ["pods", "pods/ephemeralcontainers", "pods/resize"],
          operations: ["CREATE", "UPDATE"],
        },
      ],
    },
    matchConditions: [
      {
        name: "uses-approved-class",
        expression: `object.spec.?runtimeClassName.orValue('') == '${name}'`,
      },
    ],
    variables: [
      { name: "pod", expression: "object.spec" },
      { name: "security", expression: "object.spec.securityContext" },
      {
        name: "allContainers",
        expression: "object.spec.containers + object.spec.?initContainers.orValue([])",
      },
      { name: "box", expression: "object.spec.containers.filter(c, c.name == 'box-workload')[0]" },
    ],
    validations: [],
  },
};
function requireRule(message, expression) {
  policy.spec.validations.push({ message, expression });
}

requireRule(
  "Box requires private namespaces and no ephemeral containers",
  `
  variables.pod.hostUsers == false &&
  !variables.pod.?hostPID.orValue(false) &&
  !variables.pod.?hostIPC.orValue(false) &&
  !variables.pod.?hostNetwork.orValue(false) &&
  !variables.pod.?shareProcessNamespace.orValue(false) &&
  !has(variables.pod.ephemeralContainers) &&
  variables.pod.automountServiceAccountToken == false &&
  !has(variables.pod.os) &&
  !has(variables.security.sysctls) &&
  !has(variables.security.windowsOptions) &&
  !has(variables.security.seLinuxOptions) &&
  !has(variables.security.appArmorProfile) &&
  object.metadata.?annotations.orValue({}).all(k,
    !k.startsWith('container.apparmor.security.beta.kubernetes.io/') &&
    !k.startsWith('seccomp.security.alpha.kubernetes.io/') &&
    !k.startsWith('container.seccomp.security.alpha.kubernetes.io/'))
`,
);

requireRule(
  "Box requires unprivileged containers",
  `
  variables.allContainers.all(c,
    !c.securityContext.?privileged.orValue(false) &&
    !c.securityContext.allowPrivilegeEscalation &&
    c.securityContext.capabilities.drop == ['ALL'] &&
    !has(c.securityContext.capabilities.add) &&
    !has(c.securityContext.seLinuxOptions) &&
    !has(c.securityContext.windowsOptions) &&
    !has(c.lifecycle) && !has(c.ports) && !has(c.volumeDevices) &&
    !has(c.livenessProbe) && (!has(c.startupProbe) || (c.name == 'workspace-node' && has(c.startupProbe.exec))) &&
    (!has(c.readinessProbe) || (c.name == 'agent' && has(c.readinessProbe.exec))))
`,
);

requireRule(
  "Only the approved Box workload may unmask procfs",
  `
  variables.box.securityContext.procMount == 'Unmasked' &&
  variables.box.securityContext.appArmorProfile.type == 'Localhost' &&
  variables.box.securityContext.appArmorProfile.localhostProfile == 'oce-strands-box-v0.3.1' &&
  variables.box.securityContext.seccompProfile.type == 'Localhost' &&
  variables.box.securityContext.seccompProfile.localhostProfile == 'oce-strands-box-v0.3.1.json' &&
  variables.allContainers.all(c, c.name == 'box-workload' ||
    (!has(c.securityContext.appArmorProfile) && !has(c.securityContext.seccompProfile) &&
     c.securityContext.?procMount.orValue('Default') == 'Default'))
`,
);

requireRule(
  "Box requires the approved tenant, Pod creator and image",
  `
  request.namespace == '${namespace}' &&
  namespaceObject.metadata.labels["pod-security.kubernetes.io/enforce"] == "restricted" &&

  (request.operation != 'CREATE' || request.userInfo.username == '${creator}') &&
  variables.pod.containers.map(c, c.name) == ['agent', 'box-workload'] &&
  variables.pod.initContainers.all(c, c.name in
    ['initialize-listener', 'initialize-workspace-directories', 'initialize-workspace', 'workspace-node']) &&
  variables.allContainers.all(c, c.image == '${image}')
`,
);

requireRule(
  "Box siblings must retain Restricted defaults",
  `
  variables.security.runAsNonRoot &&
  variables.security.runAsUser == 1000 &&
  variables.security.runAsGroup == 1000 &&
  variables.security.seccompProfile.type == 'RuntimeDefault' &&
  variables.allContainers.all(c,
    !has(c.securityContext.runAsNonRoot) &&
    !has(c.securityContext.runAsUser) &&
    !has(c.securityContext.runAsGroup) &&
    c.securityContext.readOnlyRootFilesystem &&
    c.terminationMessagePath == '/dev/termination-log' &&
    c.?volumeMounts.orValue([]).all(m, !has(m.mountPropagation))) &&
  variables.pod.volumes.all(v,
    has(v.emptyDir) || has(v.secret) || has(v.configMap) ||
    has(v.projected) || has(v.persistentVolumeClaim))
`,
);

requireRule(
  "Box requires the stock launcher with a single Secret reference",
  `
  !variables.pod.enableServiceLinks &&
  variables.box.command == ['/usr/local/bin/node', '--jitless', '/opt/oce/strands-box/stock-launch.mjs'] &&
  !has(variables.box.args) && !has(variables.box.workingDir) &&
  !has(variables.box.envFrom) &&
  size(variables.box.env) == 1 &&
  variables.box.env[0].name == 'OCE_STRANDS_OPENAI_KEY' &&
  has(variables.box.env[0].valueFrom.secretKeyRef) &&
  !variables.box.env[0].valueFrom.secretKeyRef.?optional.orValue(false)
`,
);

requireRule(
  "Volumes must leave the Box executable and system files intact",
  `
  variables.pod.volumes.all(v, !(v.name in ['private-home','temporary','box-state','stock-control']) || has(v.emptyDir)) &&
  variables.box.volumeMounts.all(m,
    !has(m.subPathExpr) && !m.mountPath.contains('/../') && !m.mountPath.endsWith('/..') &&
    ((m.name == 'private-home' && m.mountPath == '/home/node') ||
     (m.name == 'temporary' && m.mountPath == '/tmp') ||
     (m.name == 'box-state' && m.mountPath == '/run/strands-box') ||
     (m.name == 'stock-control' && m.mountPath == '/run/strands-stock' && m.readOnly) ||
     (m.name == 'inputs' && m.readOnly &&
       (m.mountPath in ['/etc/strands-box/box.toml', '/etc/strands-box/policy.dw', '/etc/strands-box/workload.json'] ||
        m.mountPath.startsWith('/run/strands-files/'))) ||
     (m.name.startsWith('workspace-') && m.mountPath.startsWith('/home/node/'))))
`,
);

const binding = {
  apiVersion,
  kind: "ValidatingAdmissionPolicyBinding",
  metadata: { name },
  spec: { policyName: name, validationActions: ["Deny"] },
};
console.log(JSON.stringify({ apiVersion: "v1", kind: "List", items: [policy, binding] }, null, 2));
