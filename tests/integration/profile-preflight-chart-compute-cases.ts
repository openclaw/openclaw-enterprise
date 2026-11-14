import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createKubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import { immutableImageAccepted, imageReferenceCases } from "../fixtures/image-reference-cases.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";

export type TestInput = Record<string, unknown>;
export type VerdictCase<Value> = readonly [value: Value, accepted: boolean, chartError?: RegExp];

export interface ParityCase {
  label: string;
  controlPlane?: TestInput;
  values?: TestInput;
  accepted: boolean;
  chartError?: RegExp | undefined;
  rendererError?: RegExp;
  profile?: string;
  extraInput?: TestInput;
}

export interface FieldParityCases<Value> {
  cases: readonly VerdictCase<Value>[];
  label?: (value: Value) => string;
  controlPlane: (value: Value) => TestInput;
  extraInput?: (value: Value) => TestInput;
  values: (value: Value) => TestInput;
  chartError?: RegExp;
}

interface Verdict {
  ok: boolean;
  output: string;
}

export interface RenderedProfile {
  directory: string;
  renderer: Verdict;
}

interface ComputeCaseFixture {
  repository: string;
  helm: string;
  helmSkip: false | string;
  repositoryInput: TestInput;
  loadYaml: (text: string) => unknown;
  input: (controlPlane?: TestInput) => TestInput & { runtime: TestInput };
  each: <Row>(cases: readonly Row[], check: (row: Row) => unknown) => Promise<void>;
  run: (command: string, args: readonly string[]) => Promise<Verdict>;
  renderProfile: (profileInput: TestInput, profile?: string) => Promise<RenderedProfile>;
  withProfile: <Result>(
    profileInput: TestInput,
    check: (rendered: RenderedProfile) => Result | Promise<Result>,
    profile?: string,
  ) => Promise<Result>;
  baselineValues: () => Promise<string>;
  helmTemplate: (valueFiles: readonly string[]) => Promise<Verdict>;
  writeOverride: (directory: string, values: TestInput) => string;
  assertParity: (row: ParityCase) => Promise<string>;
  fieldParity: (name: string, cases: FieldParityCases<string>) => void;
  escape: (text: string) => string;
  short: (value: string, max?: number) => string;
}

type Selector = Record<string, string>;
type DnsPeer = KubernetesComputeDriverOptions["network"]["dns"];
type ImageValues = (image: string) => TestInput;
type ProfileImageField = [string, ImageValues] | [string, ImageValues, string, ImageValues];

interface InstallationManifest {
  drivers: {
    compute: { configuration: Pick<KubernetesComputeDriverOptions, "images" | "network"> };
  };
}

interface ChartValues {
  images: { controller: string };
  repositoryCredentials: { image: string };
  logging: { collector: { image?: string } };
}

interface NetworkPolicy {
  spec: {
    egress?: Array<{
      to?: Array<{
        namespaceSelector?: { matchLabels?: Selector };
        podSelector?: { matchLabels?: Selector };
      }>;
    }>;
  };
}

export function profileComputeCases({
  repository,
  helm,
  helmSkip,
  repositoryInput,
  loadYaml,
  input,
  each,
  run,
  renderProfile,
  withProfile,
  baselineValues,
  helmTemplate,
  writeOverride,
  assertParity,
  fieldParity,
  escape,
  short,
}: ComputeCaseFixture) {
  const namespaceRefusal = (field: string) =>
    new RegExp(
      `${escape(field)} must be a Kubernetes namespace name \\(a DNS label of at most 63 characters\\)`,
    );

  // Compute must admit or refuse the same value at Driver creation.
  const configured = conformanceKubernetesOptions({
    gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
    runtime: undefined,
  }) as KubernetesComputeDriverOptions;
  function assertCompute(
    overrides: Partial<KubernetesComputeDriverOptions>,
    accepted: boolean,
    refusal: RegExp | undefined,
    label: string,
    path?: string,
    code = "INVALID_FORMAT",
  ) {
    const create = () => createKubernetesComputeDriver({ ...configured, ...overrides });
    if (accepted) {
      assert.doesNotThrow(create, label);
    } else {
      assert.throws(
        create,
        (error) => {
          assert.ok(error instanceof ConfigurationValidationError);
          const detail = error.error.details?.[0];
          assert.ok(detail?.message);
          assert.ok(refusal);
          assert.equal(detail.path, path);
          assert.equal(detail.code, code);
          assert.match(detail.message, refusal);
          return true;
        },
        label,
      );
    }
  }

  // A Kubernetes Namespace name is a DNS label of at most 63 characters, with no dots.
  const namespaceCases: VerdictCase<string>[] = [
    ["envoy-gateway-system", true],
    ["a", true],
    ["1abc", true],
    ["a".repeat(63), true],
    ["a".repeat(64), false],
    ["a".repeat(253), false],
    ["gateway.example", false],
    ["a.b", false],
    ["Envoy", false],
    ["-system", false],
    ["system-", false],
    ["envoy/system", false],
    ["foo_bar", false],
  ];

  // The observability demo chart selects the same DNS peer; it has no renderer.
  async function renderDemoChart(values: TestInput) {
    const directory = mkdtempSync(join(tmpdir(), "oce-demo-parity-"));
    try {
      const path = join(directory, "values.json");
      writeFileSync(path, JSON.stringify(values));
      return await run(helm, [
        "template",
        "demo",
        "deploy/helm/openclaw-observability-demo",
        "--namespace",
        "oce-observability-demo",
        ...[
          "occ.namespace=openclaw-system",
          "occ.release=oce",
          "cluster.cidrs[0]=10.43.0.1/32",
          "grafana.adminSecretName=grafana-admin",
        ].flatMap((value) => ["--set", value]),
        "--values",
        path,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  function registerNamespaces() {
    test(
      "envoy namespaces get the same verdict from the preflight, the chart and Compute",
      { skip: helmSkip },
      () => {
        const { gatewayClients: _gatewayClients, ...network } = configured.network;
        const routing = {
          hostname: "agents.example.internal",
          gatewayName: "oce-agent-gateways",
          gatewayNamespace: "openclaw-system",
        };
        return each(namespaceCases, async ([envoyNamespace, accepted]) => {
          const label = short(envoyNamespace);
          await assertParity({
            label,
            controlPlane: { envoyNamespace },
            values: { gatewayRouting: { envoyNamespace } },
            accepted,
            chartError: namespaceRefusal("gatewayRouting.envoyNamespace"),
          });
          assertCompute(
            { network, gatewayRouting: { ...routing, envoyNamespace } },
            accepted,
            /Gateway routing Envoy namespace must be a Kubernetes namespace name/,
            `${label}: Compute`,
            "/gatewayRouting/envoyNamespace",
          );
        });
      },
    );

    test(
      "API client and DNS peer namespaces get the same verdict from the preflight, the charts and Compute",
      { skip: helmSkip },
      () => {
        const podLabels = { app: "occ-operator" };
        const dnsRefusal = namespaceRefusal("dns.namespace");
        return each(namespaceCases, async ([namespace, accepted]) => {
          const label = short(namespace);
          await assertParity({
            label: `apiClients ${label}`,
            controlPlane: { apiClients: [{ namespace, podLabels }] },
            values: { api: { clients: [{ namespace, podLabels }] } },
            accepted,
            chartError: namespaceRefusal("api.clients[0].namespace"),
          });
          const dns = { namespace, podLabels: { "k8s-app": "kube-dns" } };
          await assertParity({
            label: `dns ${label}`,
            controlPlane: { dns },
            values: { dns },
            accepted,
            chartError: dnsRefusal,
          });
          const demo = await renderDemoChart({ dns });
          assert.equal(demo.ok, accepted, `dns ${label}: demo chart\n${demo.output}`);
          if (!accepted) {
            assert.match(demo.output, dnsRefusal, label);
          }
          assertCompute(
            { network: { ...configured.network, dns } },
            accepted,
            /DNS peer namespace must be a Kubernetes namespace name/,
            `dns ${label}: Compute`,
            "/network/dns/namespace",
          );
        });
      },
    );
  }

  // NetworkPolicy peer selectors. Compute applies this rule to the DNS peer at startup, and
  // Kubernetes to every NetworkPolicy: empty values pass, and the key prefix is any DNS
  // subdomain of at most 253 characters (no per-label cap, unlike the chart's nodeSelector).
  const peerSelectorCases: Array<[Selector, boolean, RegExp?, string?]> = [
    [{ "k8s-app": "kube-dns" }, true],
    [{ app: "" }, true],
    [{ "example.com/Name": "v.1_A-2" }, true],
    [{ [`example.com/${"a".repeat(63)}`]: "b".repeat(63) }, true],
    [{ [`${"a".repeat(253)}/Name`]: "" }, true],
    [{ [`${"a".repeat(64)}.example/zone`]: "east" }, true],
    [{ 123: "0" }, true],
    [{ app: "kube/dns" }, false, /^Configuration does not satisfy pattern\.$/],
    [{ app: "a".repeat(64) }, false, /^Configuration does not satisfy maxLength\.$/, "TOO_LONG"],
    [{ app: "value\n" }, false, /^Configuration does not satisfy pattern\.$/],
    [{ app: "-dns" }, false, /^Configuration does not satisfy pattern\.$/],
    [{ app: "@platform" }, false, /^Configuration does not satisfy pattern\.$/],
    [{ "k8s.io/name/extra": "dns" }, false],
    [{ "example.com/": "dns" }, false],
    [{ "Example.com/Name": "dns" }, false],
    [{ ["a".repeat(64)]: "dns" }, false],
    [{ [`${"a".repeat(254)}/Name`]: "dns" }, false],
    [{ "example.com\n/Name": "dns" }, false],
    [{ "bad key": "dns" }, false],
  ];

  function registerSelectors() {
    test(
      "node selectors get the same verdict from preflight and the chart",
      { skip: helmSkip },
      () => {
        const selectors: VerdictCase<Selector>[] = [
          [{ "oce-role": "control" }, true],
          [{ "topology.kubernetes.io/zone": "east" }, true],
          [{ spot: "no", scale: "1e3", hex: "0x1f" }, true],
          [{ ["a".repeat(63)]: "b".repeat(63) }, true],
          // Kubernetes allows empty label values, a common node-role pattern.
          [{ "node-role.kubernetes.io/infra": "" }, true],
          [{ "node-role.kubernetes.io/infra": "", "oce-role": "control" }, true],
          [{ "oce-role": "a" }, true],
          [{ "oce-role": "A_b.c-9" }, true],
          [{ "oce-role": "-control" }, false],
          [{ "oce-role": "control-" }, false],
          [{ "oce-role": "_control" }, false],
          [{ "oce-role": "control." }, false],
          [{ "oce-role": " " }, false],
          [{ "oce-role": "not valid" }, false],
          [{ "oce-role": "control\n" }, false],
          [{ "zone\n": "east" }, false],
          [{ "example.com\n/zone": "east" }, false],
          [{ "oce-role": "@platform" }, false],
          [{ "oce-role": "a".repeat(64) }, false],
          [{ "bad key": "control" }, false],
          [{ ["a".repeat(64)]: "control" }, false],
          [{ "Example.com/zone": "east" }, false],
          [{ "example.com/": "east" }, false],
          [{ "example.com/a/b": "east" }, false],
          [{ [`${"a".repeat(64)}.example/zone`]: "east" }, true],
          [{ [`${"a".repeat(253)}/zone`]: "east" }, true],
          [{ [`${"a".repeat(254)}/zone`]: "east" }, false],
        ];
        return each(selectors, async ([nodeSelector, accepted]) => {
          const label = JSON.stringify(nodeSelector);
          await assertParity({
            label,
            controlPlane: { nodeSelector },
            values: { controlPlane: { nodeSelector } },
            accepted,
            chartError: /controlPlane\.nodeSelector (keys|values) must be/,
          });
          // The runtime selectors reach no chart: Compute copies them into each Gateway and
          // Agent Pod's nodeSelector, where Kubernetes applies the same label rule at Pod
          // creation. Preflight must give them the verdict the chart gives the control plane, and
          // name each refused field (it reports every refusal, as the peer selectors below show).
          const fields = ["nodeSelector", "gatewayNodeSelector"];
          const profile = input({});
          for (const field of fields) {
            profile.runtime[field] = nodeSelector;
          }
          await withProfile(profile, ({ renderer }) => {
            assert.equal(renderer.ok, accepted, `runtime selectors ${label}\n${renderer.output}`);
            for (const field of accepted ? [] : fields) {
              assert.match(
                renderer.output,
                new RegExp(`runtime\\.${field} (keys|values) must be`),
                `runtime.${field} ${label}`,
              );
            }
          });
        });
      },
    );

    test("peer Pod selectors get Compute's verdict in preflight, and the chart renders them", () => {
      const peers = [
        "controlPlane.dns.podLabels",
        "controlPlane.apiClients.0.podLabels",
        "controlPlane.metrics.scraperNamespaceLabels",
        "controlPlane.metrics.scraperPodLabels",
      ];
      const admitDns = (
        dns: DnsPeer,
        accepted: boolean,
        label: string,
        refusal?: RegExp,
        code?: string,
      ) =>
        assertCompute(
          { network: { ...configured.network, dns } },
          accepted,
          refusal ?? /DNS peer label keys must be Kubernetes/,
          label,
          "/network/dns/podLabels",
          code,
        );
      return each(peerSelectorCases, async ([podLabels, accepted, refusal, code]) => {
        const label = JSON.stringify(podLabels);
        admitDns({ namespace: "kube-system", podLabels }, accepted, label, refusal, code);
        const profile = input({
          dns: { namespace: "kube-system", podLabels },
          apiClients: [{ namespace: "operator-tools", podLabels }],
          metrics: { scraperNamespaceLabels: podLabels, scraperPodLabels: podLabels },
        });
        await withProfile(profile, async ({ directory, renderer }) => {
          assert.equal(renderer.ok, accepted, `${label}: renderer\n${renderer.output}`);
          if (!accepted) {
            for (const path of peers) {
              assert.match(
                renderer.output,
                new RegExp(`${escape(path)} (?:keys|values) must be`),
                label,
              );
            }
            return;
          }
          // Compute admits the DNS peer exactly as the renderer wrote it.
          const installation = loadYaml(
            readFileSync(join(directory, "installation.yaml"), "utf8"),
          ) as InstallationManifest;
          const dns = installation.drivers.compute.configuration.network.dns;
          assert.deepEqual(dns.podLabels, podLabels, label);
          admitDns(dns, true, label);
          // The chart checks only that the selector is nonempty; Kubernetes applies the rule.
          if (!helmSkip) {
            const chart = await helmTemplate([join(directory, "values.yaml")]);
            assert.equal(chart.ok, true, `${label}: helm template\n${chart.output}`);
          }
        });
      });
    });

    test(
      "a DNS Pod selector without the chart's default label selects only the labelled DNS Pods",
      { skip: helmSkip },
      () => {
        // OpenShift DNS Pods have no k8s-app label. Helm merges values over chart defaults, so the
        // rendered values must drop that default or the DNS egress rule matches no Pod.
        const podLabels = { "dns.operator.openshift.io/daemonset-dns": "default" };
        return withProfile(
          input({ dns: { namespace: "openshift-dns", podLabels } }),
          async ({ directory, renderer }) => {
            assert.equal(renderer.ok, true, renderer.output);
            const chart = await helmTemplate([join(directory, "values.yaml")]);
            assert.equal(chart.ok, true, chart.output);
            const peers = chart.output
              .split(/^---$/m)
              .filter((document) => document.includes("kind: NetworkPolicy"))
              .map((document) => loadYaml(document) as NetworkPolicy)
              .flatMap((policy) => policy.spec.egress ?? [])
              .flatMap((rule) => rule.to ?? [])
              .filter(
                (peer) =>
                  peer.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] ===
                  "openshift-dns",
              );
            assert.notEqual(peers.length, 0);
            for (const peer of peers) {
              assert.deepEqual(peer.podSelector?.matchLabels, podLabels);
            }
          },
        );
      },
    );
  }

  // The chart checks every control-plane image with one rule.
  const controlPlaneImageCases: VerdictCase<string>[] = [
    ["registry.example.invalid/controller", true],
    ["registry.example.invalid/foo_bar", true],
    ["registry.example.invalid:5000/team/controller:release_1", true],
    ["registry.example.invalid/foo+bar", false],
    ["registry.example.invalid/controller?tag", false],
    ["-registry.example.invalid/controller", false],
    ["_registry.example.invalid/controller", false],
    // An uppercase registry host or tag is allowed, and so is an IPv6 registry host. A second @
    // is refused, and so is a bracket after the first component.
    ["Registry.Example.invalid/team/controller", true],
    ["registry.example.invalid/team/controller:Release_1", true],
    ["[fd00::1]:5000/team/controller", true],
    ["registry.example.invalid/controller@extra", false],
    ["registry.example.invalid/[fd00::1]/controller", false],
  ];

  // Kubernetes refuses to pull a reference its parser refuses (InvalidImageName). Every image
  // field in preflight, Compute and the chart takes exactly the references Kubernetes accepts,
  // with a lowercase SHA-256 digest where the field requires one. tests/fixtures/image-reference-
  // cases.ts holds Kubernetes' verdicts.
  function imageRefusal(
    field: string,
    image: string,
    problem: Parameters<typeof immutableImageAccepted>[1],
  ) {
    return problem === "uppercase-repository" && /@sha256:[a-f0-9]{64}$/.test(image)
      ? new RegExp(`${escape(field)} repository path must be lowercase`)
      : new RegExp(
          `${escape(field)} must be an (immutable|approved immutable SHA-256) image reference`,
        );
  }

  function registerImages() {
    fieldParity("controller image references get the same verdict from preflight and the chart", {
      cases: controlPlaneImageCases,
      label: (name) => name,
      controlPlane: (name) => ({ controllerImage: `${name}@sha256:${"a".repeat(64)}` }),
      values: (name) => ({ images: { controller: `${name}@sha256:${"a".repeat(64)}` } }),
      chartError: /images\.controller must be an approved immutable SHA-256 image reference/,
    });

    // Kubernetes refuses to pull an image whose repository path has an uppercase letter
    // (InvalidImageName). Preflight refuses it in every image field, the chart in the images it
    // renders, and Compute in runtime.image, which becomes its images.gateway and images.agent.
    test(
      "images with an uppercase repository path fail preflight, the chart and Compute",
      { skip: helmSkip },
      () => {
        const refusal = (field: string) =>
          new RegExp(`${escape(field)} repository path must be lowercase`);
        const fields: ProfileImageField[] = [
          [
            "controlPlane.controllerImage",
            (image) => input({ controllerImage: image }),
            "images.controller",
            (image) => ({ images: { controller: image } }),
          ],
          [
            "runtime.image",
            (image) => ({ ...input({}), runtime: { ...input({}).runtime, image } }),
          ],
          [
            "repository.image",
            (image) => ({ ...input({}), repository: { ...repositoryInput, image } }),
            "repositoryCredentials.image",
            (image) => ({ repositoryCredentials: { ...repositoryInput, image } }),
          ],
        ];
        const names = [
          "registry.example.invalid/Team/controller",
          "registry.example.invalid:5000/team/Controller:release_1",
          "Registry.Example.invalid/team/Controller",
          // Without a registry host, the image is docker.io/library/Controller.
          "Controller",
        ];
        return each(
          fields.flatMap((field) => names.map((name) => [field, name] as const)),
          ([[field, profile, chartField, values], name]) => {
            const image = `${name}@sha256:${"a".repeat(64)}`;
            return withProfile(profile(image), async ({ directory, renderer }) => {
              assert.equal(renderer.ok, false, `${field} ${name}: renderer\n${renderer.output}`);
              assert.match(renderer.output, refusal(field), `${field} ${name}`);
              assert.equal(existsSync(join(directory, "values.yaml")), false);
              if (chartField === undefined) {
                assertCompute(
                  { images: { gateway: image, agent: image, requireImmutableDigest: true } },
                  false,
                  /Gateway image repository path must be lowercase/,
                  name,
                  "/images/gateway",
                );
                return;
              }
              assert.ok(values);
              const chart = await helmTemplate([
                await baselineValues(),
                writeOverride(directory, values(image)),
              ]);
              assert.equal(
                chart.ok,
                false,
                `${chartField} ${name}: helm template\n${chart.output}`,
              );
              assert.match(chart.output, refusal(chartField), `${chartField} ${name}`);
            });
          },
        );
      },
    );

    // Profiles take no Collector image: preflight refuses the field and writes none, so the chart
    // renders its default. An operator values file can still set logging.collector.image, and the
    // chart applies the images.* rule to it.
    test(
      "logging.collector.image follows the images.* repository path rule; profiles leave the chart default",
      { skip: helmSkip },
      async () => {
        const collector = { enabled: true, exporter: { cidr: "192.0.2.40/32" } };
        await withProfile(
          input({
            loggingCollector: { ...collector, image: `otel/collector@sha256:${"d".repeat(64)}` },
          }),
          ({ renderer }) => {
            assert.equal(renderer.ok, false, renderer.output);
            assert.match(
              renderer.output,
              /controlPlane\.loggingCollector\.image is not supported by installation profiles/,
            );
          },
        );
        return withProfile(
          input({ loggingCollector: collector }),
          async ({ directory, renderer }) => {
            assert.equal(renderer.ok, true, renderer.output);
            const values = join(directory, "values.yaml");
            assert.equal(
              (loadYaml(readFileSync(values, "utf8")) as ChartValues).logging.collector.image,
              undefined,
            );
            const chart = await helmTemplate([values]);
            assert.equal(chart.ok, true, chart.output);
            const chartDefault = (
              loadYaml(
                readFileSync(
                  join(repository, "deploy/helm/openclaw-enterprise/values.yaml"),
                  "utf8",
                ),
              ) as ChartValues
            ).logging.collector.image;
            assert.ok(chartDefault);
            assert.ok(
              chart.output.includes(`image: ${JSON.stringify(chartDefault)}`),
              chartDefault,
            );
            await each<VerdictCase<string>>(
              [
                ["registry.example.invalid/otel/collector", true],
                ["Registry.Example.invalid/otel/collector:Release_1", true],
                ["[fd00::1]:5000/otel/collector", true],
                ["[FD00::1]:5000/otel/collector", true],
                ["registry.example.invalid/Otel/collector", false],
                ["registry.example.invalid:5000/otel/Collector:release_1", false],
                ["Registry.Example.invalid/otel/Collector", false],
                ["[fd00::1]:5000/otel/Collector", false],
                // Without a registry host, the image is docker.io/library/Collector.
                ["Collector", false],
              ],
              async ([name, accepted]) => {
                const image = `${name}@sha256:${"d".repeat(64)}`;
                const chart = await helmTemplate([
                  values,
                  writeOverride(mkdtempSync(join(directory, "case-")), {
                    logging: { collector: { image } },
                  }),
                ]);
                assert.equal(chart.ok, accepted, `${name}: helm template\n${chart.output}`);
                if (accepted) {
                  assert.ok(chart.output.includes(`image: ${JSON.stringify(image)}`), name);
                } else {
                  assert.match(
                    chart.output,
                    /logging\.collector\.image repository path must be lowercase; Kubernetes refuses to pull an uppercase one/,
                    name,
                  );
                }
              },
            );
          },
        );
      },
    );

    // runtime.image never reaches the chart: it becomes Compute's images.gateway and
    // images.agent. Every reference preflight accepts, including an IPv6 registry host, must reach
    // Compute as written and start it. Both refuse whitespace and a second @, which no runtime
    // pulls.
    test("runtime image references get Compute's verdict in preflight", () =>
      each<VerdictCase<string>>(
        [
          ["registry.example.invalid/openclaw-enterprise/runtime", true],
          ["registry.example.invalid:5000/team/runtime:release_1", true],
          ["[fd00::1]:5000/openclaw-enterprise/runtime", true],
          ["[::1]:5000/runtime", true],
          ["Registry.Example.invalid/team/runtime:Release_1", true],
          ["registry.example.invalid/run time", false],
          ["registry.example.invalid/runtime\n", false],
          ["registry.example.invalid/runtime@extra", false],
        ],
        ([name, accepted]) => {
          const image = `${name}@sha256:${"b".repeat(64)}`;
          return withProfile(
            { ...input({}), runtime: { ...input({}).runtime, image } },
            ({ directory, renderer }) => {
              assert.equal(renderer.ok, accepted, `${name}: renderer\n${renderer.output}`);
              if (!accepted) {
                assert.match(
                  renderer.output,
                  /runtime\.image must be an immutable image reference with a SHA-256 digest/,
                );
                assert.equal(existsSync(join(directory, "installation.yaml")), false);
                return;
              }
              const installation = loadYaml(
                readFileSync(join(directory, "installation.yaml"), "utf8"),
              ) as InstallationManifest;
              const images = installation.drivers.compute.configuration.images;
              assert.deepEqual(images, {
                gateway: image,
                agent: image,
                requireImmutableDigest: true,
              });
              assertCompute({ images }, true, undefined, name);
            },
          );
        },
      ));

    test("image references get Kubernetes' verdict in preflight and Compute", () =>
      each(imageReferenceCases, ([label, image, problem]) => {
        // Compute without the immutable-image policy takes every reference Kubernetes accepts.
        assertCompute(
          { images: { gateway: image, agent: image, requireImmutableDigest: false } },
          problem === undefined,
          problem === "uppercase-repository"
            ? /Gateway image repository path must be lowercase/
            : /Gateway image must be a container image reference Kubernetes can pull/,
          label,
          "/images/gateway",
        );
        const accepted = immutableImageAccepted(image, problem);
        // One profile carries the reference in all three image fields; preflight refuses each.
        return withProfile(
          {
            ...input({ controllerImage: image }),
            runtime: { ...input({}).runtime, image },
            repository: { ...repositoryInput, image },
          },
          ({ directory, renderer }) => {
            assert.equal(renderer.ok, accepted, `${label}: renderer\n${renderer.output}`);
            if (!accepted) {
              for (const field of [
                "controlPlane.controllerImage",
                "runtime.image",
                "repository.image",
              ]) {
                assert.match(
                  renderer.output,
                  imageRefusal(field, image, problem),
                  `${label}: ${field}`,
                );
              }
              return;
            }
            const values = loadYaml(
              readFileSync(join(directory, "values.yaml"), "utf8"),
            ) as ChartValues;
            assert.equal(values.images.controller, image, label);
            assert.equal(values.repositoryCredentials.image, image, label);
            const installation = loadYaml(
              readFileSync(join(directory, "installation.yaml"), "utf8"),
            ) as InstallationManifest;
            const images = installation.drivers.compute.configuration.images;
            assert.deepEqual(images, {
              gateway: image,
              agent: image,
              requireImmutableDigest: true,
            });
            assertCompute({ images }, true, undefined, label);
          },
        );
      }));

    test(
      "image references get Kubernetes' verdict in every chart image field",
      { skip: helmSkip },
      async () => {
        // A profile with the Collector and repository credentials enabled, so every chart image
        // field renders.
        const baselineProfile = await renderProfile({
          ...input({ loggingCollector: { enabled: true, exporter: { cidr: "192.0.2.40/32" } } }),
          repository: repositoryInput,
        });
        try {
          assert.equal(baselineProfile.renderer.ok, true, baselineProfile.renderer.output);
          const baselineValuesFile = join(baselineProfile.directory, "values.yaml");
          const fields: Array<[string, ImageValues]> = [
            ["images.controller", (image) => ({ images: { controller: image } })],
            ["repositoryCredentials.image", (image) => ({ repositoryCredentials: { image } })],
            ["logging.collector.image", (image) => ({ logging: { collector: { image } } })],
          ];
          await each(imageReferenceCases, async ([label, image, problem]) => {
            const directory = mkdtempSync(join(baselineProfile.directory, "case-"));
            if (immutableImageAccepted(image, problem)) {
              const chart = await helmTemplate([
                baselineValuesFile,
                writeOverride(
                  directory,
                  Object.assign({}, ...fields.map(([, values]) => values(image))),
                ),
              ]);
              assert.equal(chart.ok, true, `${label}: helm template\n${chart.output}`);
              // The controller, its Jobs, the Slack proxy, the repository broker and the Collector.
              assert.ok(chart.output.includes(`image: ${JSON.stringify(image)}`), label);
              return;
            }
            for (const [field, values] of fields) {
              const chart = await helmTemplate([
                baselineValuesFile,
                writeOverride(mkdtempSync(join(directory, "field-")), values(image)),
              ]);
              assert.equal(chart.ok, false, `${label}: ${field}: helm template\n${chart.output}`);
              assert.match(chart.output, imageRefusal(field, image, problem), `${label}: ${field}`);
            }
          });
        } finally {
          rmSync(baselineProfile.directory, { recursive: true, force: true });
        }
      },
    );
  }

  function registerRepositoryImage() {
    fieldParity(
      "repository credential image references get the same verdict from preflight and the chart",
      {
        cases: controlPlaneImageCases,
        label: (name) => name,
        controlPlane: () => ({}),
        extraInput: (name) => ({
          repository: { ...repositoryInput, image: `${name}@sha256:${"c".repeat(64)}` },
        }),
        values: (name) => ({
          repositoryCredentials: { ...repositoryInput, image: `${name}@sha256:${"c".repeat(64)}` },
        }),
        chartError:
          /repositoryCredentials\.image must be an approved immutable SHA-256 image reference/,
      },
    );
  }

  return { registerNamespaces, registerSelectors, registerImages, registerRepositoryImage };
}
