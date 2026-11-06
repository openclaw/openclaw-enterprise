#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

class DiagnosticError extends Error {}
const namePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function requireName(value, field) {
  if (typeof value !== "string" || value.length > 253 || !namePattern.test(value)) {
    throw new DiagnosticError(`${field} must be a Kubernetes resource name`);
  }
}

function requireCidrs(value, field) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (cidr) => typeof cidr !== "string" || !cidr.endsWith("/32") || isIP(cidr.slice(0, -3)) !== 4,
    )
  ) {
    throw new DiagnosticError(`${field} must contain explicit IPv4 /32 CIDRs`);
  }
}

function validateConfig(config) {
  for (const field of ["kubeconfig", "context"]) {
    if (typeof config[field] !== "string" || config[field].length === 0) {
      throw new DiagnosticError(`${field} is required`);
    }
  }
  requireName(config.namespace, "namespace");
  requireName(config.gatewayClass?.name, "gatewayClass.name");
  if (
    typeof config.gatewayClass?.controllerName !== "string" ||
    !config.gatewayClass.controllerName.includes("/")
  ) {
    throw new DiagnosticError("gatewayClass.controllerName is required");
  }
  if (
    !Array.isArray(config.controllers) ||
    config.controllers.length === 0 ||
    config.controllers.length > 20
  ) {
    throw new DiagnosticError("controllers must select between one and twenty Deployments");
  }
  for (const controller of config.controllers) {
    requireName(controller.namespace, "controllers.namespace");
    requireName(controller.name, "controllers.name");
  }
  if (!Array.isArray(config.crds) || config.crds.length === 0 || config.crds.length > 20) {
    throw new DiagnosticError("crds must select between one and twenty required CRDs");
  }
  for (const crd of config.crds) {
    requireName(crd.name, "crds.name");
    requireName(crd.version, "crds.version");
  }
  requireCidrs(config.apiCidrs, "apiCidrs");
  if (config.peakAdditional !== undefined) {
    for (const field of ["jobs", "replicaSets"]) {
      const count = config.peakAdditional?.[field];
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new DiagnosticError(
          "peakAdditional must specify nonnegative integer jobs and replicaSets",
        );
      }
    }
  }
  if (config.eks !== undefined) {
    const arn =
      /^arn:(aws|aws-us-gov|aws-cn):eks:([a-z0-9-]+):(\d{12}):cluster\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})$/.exec(
        config.eks.clusterArn ?? "",
      );
    if (!arn) {
      throw new DiagnosticError("eks.clusterArn must identify the intended EKS cluster");
    }
    config.eks.region = arn[2];
    config.eks.account = arn[3];
    config.eks.cluster = arn[4];
    requireCidrs(config.eks.webhookCidrs, "eks.webhookCidrs");
  }
  return config;
}

// A credential plugin can inherit its parent's pipes. Bound both the wait and the
// captured bytes even when the CLI or a descendant never closes those pipes.
async function jsonCommand(command, args, deadline) {
  const timeout = Math.min(20_000, deadline - performance.now());
  if (timeout <= 0) {
    throw new DiagnosticError("The collection deadline expired.");
  }
  const grouped = process.platform !== "win32";
  const child = spawn(command, args, {
    detached: grouped,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, KUBECTL_KUBERC: "false", AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
  });
  const stdout = [];
  const stderr = [];
  let size = 0;
  const result = await new Promise((resolve, reject) => {
    function stop(reason) {
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") {
            child.kill("SIGKILL");
          }
        }
      } else {
        child.kill("SIGKILL");
      }
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new DiagnosticError(reason));
    }
    const timer = setTimeout(() => stop("The selected command exceeded its deadline."), timeout);
    for (const [stream, output] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ]) {
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          stop("The read exceeded the output limit.");
        } else {
          output.push(chunk);
        }
      });
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new DiagnosticError(
          error.code === "ENOENT"
            ? "A required command is not installed."
            : "The command could not start.",
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (result !== 0) {
    const text = Buffer.concat(stderr).toString();
    let reason = "The read failed or returned incomplete data.";
    if (/Forbidden|forbidden|AccessDenied|UnauthorizedOperation/.test(text)) {
      reason = "The selected identity is not authorized to read this resource.";
    } else if (/Unauthorized|must be logged in|ExpiredToken|InvalidClientTokenId/.test(text)) {
      reason = "The selected credentials could not authenticate.";
    } else if (/x509:|certificate|TLS handshake error/.test(text)) {
      reason = "The selected endpoint's TLS connection could not be verified.";
    } else if (
      /connection refused|no route to host|timeout|context deadline exceeded|no such host|Unable to connect to the server/i.test(
        text,
      )
    ) {
      reason = "The selected endpoint could not be reached.";
    }
    throw new DiagnosticError(reason);
  }
  const output = Buffer.concat(stdout).toString().trim();
  return output ? JSON.parse(output) : null;
}

function quantity(value) {
  if (typeof value !== "string" || value.length > 100) {
    return undefined;
  }
  const match = /^(\d+)(?:\.(\d+))?(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei|[eE][+-]?\d+)?$/.exec(
    value ?? "",
  );
  if (!match) {
    return undefined;
  }
  const decimal = { n: -9, u: -6, m: -3, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18 };
  const binary = { Ki: 10, Mi: 20, Gi: 30, Ti: 40, Pi: 50, Ei: 60 };
  const suffix = match[3] ?? "";
  let exponent = 0;
  if (suffix in decimal) {
    exponent = decimal[suffix];
  } else if (/^[eE]/.test(suffix) && suffix !== "E") {
    exponent = Number(suffix.slice(1));
  }
  if (Math.abs(exponent) > 100) {
    return undefined;
  }
  const digits = match[2] ?? "";
  return {
    numerator:
      BigInt(match[1] + digits) *
      (suffix in binary ? 2n ** BigInt(binary[suffix]) : 10n ** BigInt(Math.max(0, exponent))),
    denominator: 10n ** BigInt(digits.length + Math.max(0, -exponent)),
  };
}

async function diagnose(config, directory) {
  const deadline = performance.now() + 120_000;
  let transport = [];
  const checks = [];
  let kubeUnavailable;
  const kube = (...args) => {
    if (kubeUnavailable) {
      throw new DiagnosticError(kubeUnavailable);
    }
    return jsonCommand(
      "kubectl",
      [
        "--kubeconfig",
        config.kubeconfig,
        "--context",
        config.context,
        "--request-timeout=15s",
        ...transport,
        ...args,
      ],
      deadline,
    );
  };
  const aws = (...args) =>
    jsonCommand(
      "aws",
      [
        ...args,
        "--region",
        config.eks.region,
        "--output",
        "json",
        "--no-cli-pager",
        "--cli-connect-timeout",
        "5",
        "--cli-read-timeout",
        "15",
      ],
      deadline,
    );
  async function check(id, action, inspect) {
    let result;
    try {
      result = await inspect();
    } catch (error) {
      // Provider errors can contain credential-plugin output or private endpoints.
      result = {
        status: "unknown",
        summary:
          error instanceof DiagnosticError
            ? error.message
            : "The read failed or returned incomplete data.",
      };
    }
    checks.push({ id, ...result, ...(result.status === "passed" ? {} : { action }) });
    return result;
  }
  function comparison(expected, actual) {
    const observed = new Set(actual);
    const configured = new Set(expected);
    const missing = [...observed].filter((cidr) => !configured.has(cidr)).sort();
    const stale = [...configured].filter((cidr) => !observed.has(cidr)).sort();
    return {
      status: missing.length || stale.length ? "failed" : "passed",
      summary:
        missing.length || stale.length
          ? "Configured addresses differ from the current inventory."
          : "Configured addresses match the current inventory.",
      missing,
      stale,
    };
  }

  if (config.eks) {
    let cluster;
    const identity = await check(
      "eks-cluster-identity",
      "Verify the named EKS cluster and selected kubeconfig endpoint or tunnel TLS server name; never combine inventories from different clusters.",
      async () => {
        const identity = await aws("sts", "get-caller-identity");
        if (!/^\d{12}$/.test(identity?.Account ?? "")) {
          throw new Error("incomplete AWS identity");
        }
        if (identity.Account !== config.eks.account) {
          return {
            status: "failed",
            summary: "The authenticated AWS account does not match the intended cluster ARN.",
          };
        }
        ({ cluster } = await aws("eks", "describe-cluster", "--name", config.eks.cluster));
        const selected = await kube(
          "config",
          "view",
          "--minify",
          "--flatten",
          "--raw",
          "-o",
          "jsonpath-as-json={.clusters[*].cluster}",
        );
        const connection = selected[0];
        const expected = new URL(cluster.endpoint);
        const endpoint = new URL(connection.server);
        const tunnel =
          ["127.0.0.1", "[::1]"].includes(endpoint.hostname) &&
          endpoint.port !== "" &&
          endpoint.href === endpoint.origin + "/" &&
          connection["tls-server-name"] === expected.hostname;
        const actualHost = connection["tls-server-name"] ?? endpoint.hostname;
        const matches =
          cluster.arn === config.eks.clusterArn &&
          cluster.name === config.eks.cluster &&
          typeof cluster.certificateAuthority?.data === "string" &&
          cluster.certificateAuthority.data.length > 0 &&
          connection["certificate-authority-data"] === cluster.certificateAuthority.data &&
          expected.protocol === "https:" &&
          expected.href === expected.origin + "/" &&
          (endpoint.href === expected.href || tunnel) &&
          endpoint.protocol === "https:" &&
          !connection["insecure-skip-tls-verify"] &&
          actualHost === expected.hostname;
        if (matches) {
          // Later kubectl calls reload the context. Pin the verified transport on
          // every read so a changed kubeconfig cannot redirect the observations.
          const ca = join(directory, "eks-ca.pem");
          await writeFile(ca, Buffer.from(cluster.certificateAuthority.data, "base64"), {
            flag: "wx",
            mode: 0o600,
          });
          transport = [
            `--server=${endpoint.href}`,
            `--tls-server-name=${expected.hostname}`,
            `--certificate-authority=${ca}`,
          ];
        }
        return {
          status: matches ? "passed" : "failed",
          summary: matches
            ? "The AWS account, cluster ARN, TLS endpoint and CA identify the intended EKS cluster."
            : "The cluster ARN, Kubernetes TLS endpoint or CA does not identify the intended EKS cluster.",
        };
      },
    );
    if (identity?.status === "passed") {
      await check(
        "webhook-addresses",
        "Refresh the named EKS control-plane interface inventory; reconcile infrastructure-owned webhook ingress /32s without widening them.",
        async () => {
          const { vpcId, clusterSecurityGroupId } = cluster.resourcesVpcConfig;
          if (!/^vpc-[a-f0-9]+$/.test(vpcId) || !/^sg-[a-f0-9]+$/.test(clusterSecurityGroupId)) {
            throw new Error("incomplete EKS VPC inventory");
          }
          const result = await aws(
            "ec2",
            "describe-network-interfaces",
            "--filters",
            `Name=vpc-id,Values=${vpcId}`,
            `Name=group-id,Values=${clusterSecurityGroupId}`,
            `Name=description,Values=Amazon EKS ${config.eks.cluster}`,
          );
          if (result.NextToken) {
            throw new Error("incomplete EC2 page");
          }
          const addresses = result.NetworkInterfaces.flatMap((item) => {
            if (!item.PrivateIpAddresses.length) {
              throw new Error("empty interface address inventory");
            }
            return item.PrivateIpAddresses.map((address) => address.PrivateIpAddress);
          });
          if (addresses.length === 0 || addresses.some((address) => isIP(address) !== 4)) {
            throw new Error("incomplete webhook inventory");
          }
          return comparison(
            config.eks.webhookCidrs,
            addresses.map((address) => `${address}/32`),
          );
        },
      );
    } else {
      kubeUnavailable =
        "The selected Kubernetes target could not be bound to the intended EKS cluster.";
      checks.push({
        id: "webhook-addresses",
        status: "unknown",
        summary: "The EKS cluster identity was not verified.",
        action: "Resolve eks-cluster-identity before comparing webhook addresses.",
      });
    }
  }

  let service;
  let verifiedContext = false;
  const api = await check(
    "kubernetes-api",
    "Verify the selected kubeconfig, credentials, TLS trust and private API route; retry this read from the intended operator network.",
    async () => {
      // This local view redacts credential values. Reject a context that would
      // send anonymous requests or skip server verification, even if GET is public.
      const view = await kube("config", "view", "--minify", "-o", "json");
      const cluster = view.clusters?.[0]?.cluster;
      const user = view.users?.[0]?.user;
      if (
        new URL(cluster.server).protocol !== "https:" ||
        cluster["insecure-skip-tls-verify"] ||
        !(
          user?.token ||
          user?.tokenFile ||
          user?.exec?.command ||
          user?.["auth-provider"] ||
          ((user?.["client-certificate"] || user?.["client-certificate-data"]) &&
            (user?.["client-key"] || user?.["client-key-data"])) ||
          (user?.username && user?.password)
        )
      ) {
        kubeUnavailable =
          "The selected context requires verified HTTPS and configured credentials.";
        return { status: "failed", summary: kubeUnavailable };
      }
      verifiedContext = true;
      service = await kube("-n", "default", "get", "service", "kubernetes", "-o", "json");
      if (
        !service?.metadata?.uid ||
        service.metadata.namespace !== "default" ||
        service.metadata.name !== "kubernetes"
      ) {
        throw new Error("incomplete API Service");
      }
      return {
        status: "passed",
        summary: "The selected identity can read the Kubernetes API Service.",
      };
    },
  );

  if (
    !verifiedContext ||
    (api.status === "unknown" && /endpoint|target|deadline/.test(api.summary))
  ) {
    kubeUnavailable = api.summary;
  }

  for (const crd of config.crds) {
    await check(
      `crd:${crd.name}`,
      "Verify that the prerequisite installer established this CRD and serves the required API version.",
      async () => {
        const item = await kube(
          "get",
          "customresourcedefinitions.apiextensions.k8s.io",
          crd.name,
          "--ignore-not-found",
          "-o",
          "json",
        );
        if (item === null) {
          return { status: "failed", summary: "The required CRD does not exist." };
        }
        const established =
          !item.metadata?.deletionTimestamp &&
          ["Established", "NamesAccepted"].every((type) =>
            item.status?.conditions?.some(
              (condition) => condition.type === type && condition.status === "True",
            ),
          );
        const served = item.spec?.versions?.some(
          (version) => version.name === crd.version && version.served,
        );
        return {
          status: established && served ? "passed" : "failed",
          summary:
            established && served
              ? "The established CRD serves the required API version."
              : "The required CRD is not established or does not serve the selected version.",
        };
      },
    );
  }

  await check(
    "gateway-class",
    "Inspect the selected GatewayClass owner and its controller; require a current Accepted condition before installing OCE.",
    async () => {
      const item = await kube(
        "get",
        "gatewayclasses.gateway.networking.k8s.io",
        config.gatewayClass.name,
        "--ignore-not-found",
        "-o",
        "json",
      );
      if (item === null) {
        return { status: "failed", summary: "The selected GatewayClass does not exist." };
      }
      if (!item.metadata?.generation || typeof item.spec?.controllerName !== "string") {
        throw new Error("incomplete GatewayClass");
      }
      const accepted = item.status?.conditions?.find((condition) => condition.type === "Accepted");
      const owner =
        !item.metadata.deletionTimestamp &&
        item.spec.controllerName === config.gatewayClass.controllerName;
      const fresh = accepted?.observedGeneration === item.metadata.generation;
      return {
        status: owner && fresh && accepted.status === "True" ? "passed" : "failed",
        summary:
          owner && fresh && accepted.status === "True"
            ? "The selected controller accepted this GatewayClass generation."
            : "The GatewayClass owner or current Accepted condition does not match.",
        resource: `${config.gatewayClass.name}@${item.metadata.uid}`,
      };
    },
  );

  for (const controller of config.controllers) {
    await check(
      `controller:${controller.namespace}/${controller.name}`,
      "Inspect this Deployment's rollout, Pods and events; restore its intended replicas before installing OCE.",
      async () => {
        const item = await kube(
          "-n",
          controller.namespace,
          "get",
          "deployments.apps",
          controller.name,
          "--ignore-not-found",
          "-o",
          "json",
        );
        if (item === null) {
          return {
            status: "failed",
            summary: "The selected controller Deployment does not exist.",
          };
        }
        const desired = item.spec?.replicas ?? 1;
        const current =
          !item.metadata?.deletionTimestamp &&
          Number.isInteger(item.metadata?.generation) &&
          item.status?.observedGeneration === item.metadata?.generation;
        const available = item.status?.conditions?.some(
          (condition) => condition.type === "Available" && condition.status === "True",
        );
        const ready =
          current &&
          available &&
          desired > 0 &&
          item.status?.updatedReplicas === desired &&
          item.status?.availableReplicas === desired &&
          item.status?.replicas === desired;
        return {
          status: ready ? "passed" : "failed",
          summary: ready
            ? "All intended controller replicas are updated and available."
            : "The controller has not completed its current rollout.",
          resource: `${controller.namespace}/${controller.name}@${item.metadata?.uid}`,
        };
      },
    );
  }

  await check(
    "api-addresses",
    "Refresh the selected API Service and EndpointSlice inventory; reconcile the expected /32s and infrastructure-owned policies before installation.",
    async () => {
      if (api?.status !== "passed") {
        throw new DiagnosticError(api.summary);
      }
      const slices = await kube(
        "-n",
        "default",
        "get",
        "endpointslices.discovery.k8s.io",
        "-l",
        "kubernetes.io/service-name=kubernetes",
        "-o",
        "json",
      );
      if (slices.metadata?.continue) {
        throw new Error("incomplete EndpointSlice list");
      }
      const serviceIPs = (service.spec.clusterIPs ?? [service.spec.clusterIP]).filter(
        (ip) => isIP(ip) === 4,
      );
      const endpoints = slices.items
        .filter((slice) => slice.addressType === "IPv4")
        .flatMap((slice) => slice.endpoints.flatMap((endpoint) => endpoint.addresses));
      if (!serviceIPs.length || !endpoints.length || endpoints.some((ip) => isIP(ip) !== 4)) {
        throw new Error("incomplete IPv4 API inventory");
      }
      const addresses = [...serviceIPs, ...endpoints];
      return comparison(
        config.apiCidrs,
        addresses.map((address) => `${address}/32`),
      );
    },
  );

  await check(
    "resource-quotas",
    "Inspect ResourceQuota status and planned chart requests in this namespace; ask its owner to resolve exhausted or unreported quotas.",
    async () => {
      const namespace = await kube(
        "get",
        "namespace",
        config.namespace,
        "--ignore-not-found",
        "-o",
        "json",
      );
      if (namespace === null) {
        return {
          status: "unknown",
          summary: "The target namespace does not exist; its admission quotas cannot be inspected.",
        };
      }
      const list = await kube("-n", config.namespace, "get", "resourcequotas", "-o", "json");
      if (
        !Array.isArray(list.items) ||
        list.metadata?.continue ||
        namespace.metadata?.deletionTimestamp
      ) {
        throw new Error("incomplete quota inventory");
      }
      const limits = [];
      for (const quota of list.items) {
        for (const [resource, field] of [
          ["count/jobs.batch", "jobs"],
          ["count/replicasets.apps", "replicaSets"],
        ]) {
          if (!(resource in quota.spec.hard) && !(resource in (quota.status?.hard ?? {}))) {
            continue;
          }
          const additional = config.peakAdditional?.[field];
          const hardValue = quota.status?.hard?.[resource];
          const usedValue = quota.status?.used?.[resource];
          const limit = { quota: quota.metadata.name, resource, additional, status: "unknown" };
          limits.push(limit);
          const hard = quantity(hardValue);
          const configured = quantity(quota.spec.hard[resource]);
          const used = quantity(usedValue);
          if (
            !hard ||
            !configured ||
            !used ||
            additional === undefined ||
            hard.numerator * configured.denominator !== configured.numerator * hard.denominator ||
            quota.spec.scopes?.length ||
            quota.spec.scopeSelector?.matchExpressions?.length
          ) {
            continue;
          }
          const needed = used.numerator + BigInt(additional) * used.denominator;
          Object.assign(limit, {
            used: usedValue,
            hard: hardValue,
            status:
              needed * hard.denominator > hard.numerator * used.denominator ? "failed" : "passed",
          });
        }
      }
      if (limits.some((limit) => limit.status === "failed")) {
        return {
          status: "failed",
          summary: "At least one object quota cannot fit the planned peak.",
          limits,
        };
      }
      if (limits.some((limit) => limit.status === "unknown")) {
        return {
          status: "unknown",
          summary: "An object quota lacks a comparable limit, usage, scope or planned peak.",
          limits,
        };
      }
      return {
        status: "passed",
        summary: limits.length
          ? "Observed object quotas can fit the planned peak."
          : "No Job or ReplicaSet object quota is configured in this namespace.",
        limits,
      };
    },
  );

  return {
    ...(config.eks ? { expectedClusterArn: config.eks.clusterArn } : {}),
    context: config.context,
    namespace: config.namespace,
    checkedAt: new Date().toISOString(),
    checks,
    limits: [
      "Observations are not atomic and may change immediately.",
      "Address inventory does not verify NetworkPolicy enforcement, webhook admission or Pod connectivity.",
      "Quota observations do not predict chart admission, node capacity or storage availability.",
    ],
  };
}

try {
  const { values } = parseArgs({
    options: { config: { type: "string" }, json: { type: "boolean", default: false } },
  });
  if (!values.config) {
    throw new DiagnosticError(
      "Usage: node scripts/diagnose-kubernetes-prerequisites.mjs --config FILE [--json]",
    );
  }
  const config = validateConfig(JSON.parse(await readFile(values.config, "utf8")));
  const directory = config.eks ? await mkdtemp(join(tmpdir(), "oce-prerequisites-")) : undefined;
  let report;
  try {
    report = await diagnose(config, directory);
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Context ${JSON.stringify(report.context)}, namespace ${report.namespace}\n`,
    );
    if (report.expectedClusterArn) {
      process.stdout.write(`Expected EKS cluster ${report.expectedClusterArn}\n`);
    }
    for (const check of report.checks) {
      process.stdout.write(`${check.status.toUpperCase()} ${check.id}: ${check.summary}\n`);
      if (check.action) {
        process.stdout.write(`  Next: ${check.action}\n`);
      }
      for (const field of ["missing", "stale", "limits"]) {
        if (check[field]?.length) {
          process.stdout.write(`  ${field}: ${JSON.stringify(check[field])}\n`);
        }
      }
    }
    process.stdout.write(`${report.limits.join("\n")}\n`);
  }
  if (report.checks.some((check) => check.status === "failed")) {
    process.exitCode = 1;
  } else if (report.checks.some((check) => check.status === "unknown")) {
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(
    `Prerequisite diagnosis could not start: ${error instanceof DiagnosticError ? error.message : "check command options and the readable JSON plan"}\n`,
  );
  process.exitCode = 2;
}
