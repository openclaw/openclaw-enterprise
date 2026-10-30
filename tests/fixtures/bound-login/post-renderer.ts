#!/usr/bin/env -S node
/** Test-only API Pod wiring. Preserves chart CA assembly and rejects ambient proxies. */
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../apps/controller/package.json", import.meta.url));
const { loadAllYaml, dumpYaml } = require("@kubernetes/client-node");
try {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
  const docs = loadAllYaml(fs.readFileSync(0, "utf8"));
  let count = 0;
  let controlPlaneCount = 0;
  for (const doc of docs) {
    if (
      cfg.github &&
      doc?.kind === "NetworkPolicy" &&
      doc.metadata?.name === "openclaw-enterprise-api-github-login-egress"
    ) {
      doc.spec.egress = [];
      continue;
    }
    if (
      doc?.kind === "Deployment" &&
      ["openclaw-enterprise-api", "openclaw-enterprise-worker"].includes(doc.metadata?.name)
    ) {
      const pod = doc.spec.template.spec;
      const component = doc.metadata.name.endsWith("-api") ? "api" : "worker";
      assert.equal(pod.containers.length, 1);
      assert.equal(pod.containers[0].name, component);
      assert.equal(pod.containers[0].image, cfg.controllerImage);
      assert.ok(!(pod.volumes ?? []).some((v: { name: string }) => v.name === "bound-openshell"));
      (pod.volumes ??= []).push({
        name: "bound-openshell",
        secret: { secretName: "bound-openshell-client" },
      });
      (pod.containers[0].volumeMounts ??= []).push({
        name: "bound-openshell",
        mountPath: "/bound-openshell",
        readOnly: true,
      });
      controlPlaneCount++;
    }
    if (!cfg.github) {
      continue;
    }
    if (doc?.kind !== "Deployment" || doc.metadata?.name !== "openclaw-enterprise-api") {
      continue;
    }
    count++;
    assert.equal(doc.metadata.namespace ?? cfg.namespace, cfg.namespace);
    const p = doc.spec.template.spec;
    assert.ok(!p.hostNetwork && !p.hostPID && !p.hostIPC);
    assert.equal(p.containers.length, 1);
    const api = p.containers[0];
    assert.equal(api.name, "api");
    assert.equal(api.image, cfg.controllerImage);
    assert.match(cfg.peerImage, /@sha256:[0-9a-f]{64}$/);
    assert.equal((api.envFrom ?? []).length, 0, "Ambient environment sources are forbidden");
    const env = (api.env ??= []);
    assert.equal(
      new Set(env.map((e: { name: string; value?: string }) => e.name)).size,
      env.length,
    );
    const denied = new Set([
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
      "NODE_USE_ENV_PROXY",
      "NODE_OPTIONS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
    ]);
    assert.ok(!env.some((e: { name: string; value?: string }) => denied.has(e.name)));
    const prior = env.find(
      (e: { name: string; value?: string }) => e.name === "NODE_EXTRA_CA_CERTS",
    );
    assert.ok(
      !prior ||
        ["/etc/openclaw/api-extra-ca/ca.crt", "/etc/openclaw/gateway-ca/ca.crt"].includes(
          prior.value,
        ),
    );
    const mounts = (api.volumeMounts ??= []);
    const priorMounts = mounts.filter((m: { mountPath: string }) =>
      prior?.value.startsWith(m.mountPath + "/"),
    );
    assert.ok(!prior || priorMounts.length === 1);
    const volumes = (p.volumes ??= []);
    assert.ok(!volumes.some((v: { name: string }) => v.name.startsWith("bound-login-")));
    volumes.push(
      {
        name: "bound-login-scripts",
        configMap: { name: "bound-login-scripts" },
      },
      {
        name: "bound-login-private",
        secret: { secretName: "bound-login-peer" },
      },
      { name: "bound-login-ca", configMap: { name: "bound-login-ca" } },
      { name: "bound-login-combined", emptyDir: {} },
    );
    const mount = (name: string, path: string, readOnly = true) => ({
      name,
      mountPath: path,
      readOnly,
    });
    const scripts = mount("bound-login-scripts", "/bound-login-scripts");
    const secure = {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    };
    p.initContainers ??= [];
    p.initContainers.push({
      name: "bound-login-merge-ca",
      image: cfg.peerImage,
      command: ["node", "/bound-login-scripts/merge-ca.ts"],
      env: [{ name: "BOUND_LOGIN_ORIGINAL_CA", value: prior?.value ?? "" }],
      volumeMounts: [
        scripts,
        mount("bound-login-ca", "/bound-login-ca"),
        mount("bound-login-combined", "/bound-login-combined", false),
        ...priorMounts,
      ],
      securityContext: secure,
    });
    p.securityContext ??= {};
    p.securityContext.fsGroup ??= 1000;
    api.env = env
      .filter((e: { name: string; value?: string }) => e.name !== "NODE_EXTRA_CA_CERTS")
      .concat([
        { name: "NODE_EXTRA_CA_CERTS", value: "/bound-login-combined/ca.crt" },
        { name: "NODE_USE_ENV_PROXY", value: "1" },
        { name: "HTTPS_PROXY", value: "http://127.0.0.1:39082" },
        { name: "HTTP_PROXY", value: "http://127.0.0.1:39082" },
        {
          name: "NO_PROXY",
          value: "127.0.0.1,localhost,kubernetes.default.svc," + cfg.kubernetesServiceIP,
        },
      ]);
    mounts.push(mount("bound-login-combined", "/bound-login-combined"), scripts);
    p.containers.push({
      name: "bound-login-github-peer",
      image: cfg.peerImage,
      command: ["node", "/bound-login-scripts/peer.ts"],
      env: [],
      volumeMounts: [scripts, mount("bound-login-private", "/bound-login-private")],
      securityContext: secure,
      readinessProbe: {
        exec: { command: ["node", "/bound-login-scripts/peer-health.ts"] },
        periodSeconds: 2,
      },
      resources: {
        requests: { cpu: "10m", memory: "32Mi" },
        limits: { cpu: "250m", memory: "128Mi" },
      },
    });
  }
  assert.equal(controlPlaneCount, 2);
  assert.equal(count, cfg.github ? 1 : 0);
  process.stdout.write(docs.map((x: unknown) => dumpYaml(x)).join("\n---\n"));
} catch {
  process.stderr.write("Bound login post-renderer rejected input\n");
  process.exitCode = 1;
}
