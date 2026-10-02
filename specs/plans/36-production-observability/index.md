---
rfc: ../../rfcs/36-production-observability.md
---

# Default production observability implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` for inline execution,
> or `superpowers:subagent-driven-development` if the user selects delegation.
> Complete each task's implementation, proof, and documentation together.

**Goal:** Enable production telemetry defaults and prove data collection and the
optional demonstration stack against a local Helm installation on k3d and in CI.

**Architecture:** Extend the existing chart and Collector policy. Keep demo
backends in a separate release. Share infrastructure preparation and test files
between local acceptance and CI; use the real chart, HTTP API, worker,
PostgreSQL, Prometheus, Collector, and Loki.

**Tech stack:** Helm, Kubernetes/k3d, Node.js 24+, pinned pnpm, PostgreSQL,
OpenTelemetry Collector, Prometheus, Grafana, and Loki.

**Spec:** [Default production observability](../../rfcs/36-production-observability.md).
Status: Earlier local acceptance passed on its recorded source. The expanded
Helm-installed model and revision-cutover coverage is deferred; the existing
protected model lane is retained. Model-turn qualification on the current cut
and hosted checks remain outstanding. See the
[qualification report](qualification.md)
for historical evidence and delivery adjustments.

## Global constraints

- Preserve IAM, runtime credential placement, native OTLP restrictions, filtering,
  aggregate metric labels, and default-deny networking. NetworkPolicies are additive.
- Preserve unrelated clusters, default kubeconfig/context, databases, images,
  worktrees, `.env`, and installed dependencies. Cleanup uses recorded ownership.
- Create disposable `openclaw_k8s_*` databases with the administrator, migrate
  with the migrator, and run OCC with its limited role. Bootstrap uses fresh state.
- Import digest-pinned images into every selected k3d node and verify resolution.
  Missing infrastructure, failed network enforcement, skipped selected tests,
  absent results, or cleanup errors fail acceptance.
- Keep credential-free fixture proof distinct from real runtime proof. Never
  replace gateway/Codex emissions with generated records and claim source coverage.
- Do not run runtime tests for this plan-only change. During implementation, use
  test-audit for changed tests and local-dev for source-backed flow documentation.

## Review focus

| Failure condition                                            | Owning proof                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Empty or partial selectors accidentally allow traffic        | Task 1: render rejection and actual Pod-to-Pod allow/deny                 |
| Ready processes expose stale or undiscoverable telemetry     | Task 2: event deltas, freshness, Pod replacement                          |
| Collector overlap or outage hides lost/duplicated data       | Task 2: ownership handoff, unavailable destination, recovery              |
| Healthy Grafana has broken data sources or dashboard queries | Task 3: query both sources through Grafana                                |
| CI is green because required cases never ran                 | Task 4: exact case accounting, required aggregation, protected-job status |

## Task 0: Establish the unchanged local baseline

Required by the user before any implementation code changes. Documentation may
record this gate and its results; do not repair product code during the baseline.

- [x] Record the checkout revision and existing diff. Verify the installed
      container engine, Node/Corepack, Helm, kubectl, and k3d prerequisites.
- [x] Prepare an owned disposable local k3d cluster using the existing
      `k3d-fixture-configuration` lane. Run all three existing fixture cases with
      the real database and enforcing NetworkPolicies; require zero skips.
- [x] Build the unchanged production controller image and install the current
      Helm chart. Verify bootstrap, denied unauthenticated access, authenticated
      API operations, persisted Namespace/Agent draft state, worker provisioning,
      and local operational logs without making model calls.
- [x] Open the installed console in a browser, sign in, inspect the resulting
      resources, and capture sanitized visual evidence. Record current metrics
      and Collector defaults; do not turn proposed behavior into baseline claims.
- [x] Record actual results, environment adjustments and limitations. Preserve
      unrelated workloads and default kubeconfig/context; clean up only owned
      resources. Proceed to Task 1 only after a functional baseline is observed.
      If blocked, identify the blocker before proposing implementation changes.

## Task 1: Enable secure production defaults

**Files:** Modify `deploy/helm/openclaw-enterprise/values.yaml`,
`templates/metrics.yaml`, `templates/collector.yaml`, and
`templates/deployments.yaml` within that chart;
`deploy/examples/production/values.yaml`; extend
`tests/integration/production-kubernetes-packaging.test.mjs` and
`tests/integration/logging-packaging.test.mjs`.

**Interfaces:** Keep `metrics.enabled`, `metrics.port`,
`metrics.scraperNamespaceLabels`, and `metrics.scraperPodLabels`.
Add `logging.collector.metrics` with `enabled: true` and the same paired scraper
selector names, serving the existing port 8888. Add
`logging.collector.exporter.namespaceLabels` and `podLabels`, both defaulting
to `{}`, as the exclusive alternative to `exporter.cidr`.

- [x] Extend rendered-manifest cases for default listeners, explicit disable,
      empty/partial/exact selectors, invalid/colliding ports, and mutually
      exclusive exporter destinations. Assert effective manifests, not template text.
- [x] Run those two exact test files; confirm failures concern the changed contract.
- [x] Change the default to `metrics.enabled: true`. Permit both scraper maps
      empty without rendering an ingress grant; reject exactly one empty map.
      Preserve port validation independently of selector configuration.
- [x] Add narrowly selected Collector metrics ingress and exporter egress.
      Retain dedicated Secrets, image validation, bounded state and filtering.
      Check overlapping policies rather than treating a single policy as exclusive.
- [x] Rerun packaging cases. Update metrics/production settings and affected
      configuration cheat sheets. Task 2 supplies the required live proof.

Expected production values without an external backend:

```yaml
metrics:
  enabled: true
  port: 9464
  scraperNamespaceLabels: {}
  scraperPodLabels: {}
logging:
  collector:
    enabled: false
```

## Task 2: Validate sources through an installed control plane

**Files:** Create `tests/integration/production-observability-k3d.test.mjs` and
`tests/helpers/production-observability-k3d.mjs`. Extend
`tests/helpers/production-helm-real.mjs`, `scripts/ci/prepare.mjs`,
`scripts/ci/cleanup.mjs`, and `scripts/ci/test-suites.json`; reuse `tests/helpers/kubernetes-real.mjs`,
`tests/helpers/logging-otel-observation.mjs`, and `scripts/ci/logging.mjs`.

**Interfaces:** Add lane `k3d-observability`, selected by
`OCC_TEST_PRODUCTION_OBSERVABILITY=1`, using existing explicit kubeconfig/context
and image variables. The shared helper owns only test setup, observation, and
cleanup. Extend the Helm helper's input with `logging` values; do not bypass
the chart or add test-only production instrumentation.

- [x] Register the source test file in `k3d-observability` with required case names
      and strict result accounting, then prepare an owned two-node k3d cluster with enforced NetworkPolicies,
      current controller image, PostgreSQL, and digest-pinned observation tools.
      Adapt existing preparation; do not copy another cluster lifecycle manager.
- [x] Install the production chart with required identity/database inputs but
      no metrics overrides and no telemetry backend. Verify API/worker startup,
      local structured logs, and private metrics listeners. A port-forward may
      inspect listener content; it does not prove NetworkPolicy enforcement.
- [x] Add real scraper Pods with permitted egress. Prove ingress denial with no
      grant, wrong namespace, and wrong Pod labels; prove access with both correct
      selectors. Repeat for Collector metrics and allowed/denied export destinations.
- [x] Discover every expected API/worker Pod in Prometheus. Make authenticated
      API requests and create/deploy/stop an Agent through supported HTTP routes
      using the existing deterministic Compute fixture. Assert request and worker
      counter deltas, operation histogram observations, and database-backed state
      gauges against observed lifecycle transitions. Do not assert exact timing.
- [x] Replace an API Pod and require discovery of its new instance and fresh
      samples. Bound all polling. Avoid inventing a general horizontal-scaling proof.
- [x] Enable the chart Collector and observe timestamped API and worker events
      at the real OTLP receiver, correlated with the exercised requests/work.
      Check service attribution and absence of unique content/credential sentinels
      supplied through supported requests. Preserve detailed filter tests already
      owned by `logging-collector.test.mjs`.
- [x] Run a separate existing-Collector configuration using the same shipped
      policy, with the chart Collector disabled. Verify receipt and one collection
      owner. Normal healthy delivery must not duplicate the unique test event;
      do not impose an exactly-once guarantee across retry/restart.
- [x] Interrupt the receiver, observe export failure/queue health, prove OCC
      requests continue, restore the receiver, and require a new event to arrive.
      Check bounded settings without claiming indefinite or lossless retention.
- [x] Upgrade with metrics disabled; require removed listeners and continued
      API health. Restore defaults, then clean up only recorded resources.

Use the existing lane runner for every execution, including initial expected
failures. It must fail on missing preparation or skipped selected cases:

```sh
node scripts/ci/prepare.mjs --lane k3d-observability --state "$OBS_STATE"
node scripts/ci/run-tests.mjs run k3d-observability \
  --state "$OBS_STATE" --results "$OBS_RESULTS"
node scripts/ci/cleanup.mjs --state "$OBS_STATE"
```

The local wrapper sets private absolute state/result paths and guarantees cleanup
on failure; users do not have to invent these variables. Update
`docs/flows/common-logging.md`, `docs/testing/kubernetes.md`, and
`docs/testing/metrics.md` with actual proof boundaries.

## Task 3: Package and smoke-test the demonstration stack

**Files:** Create `deploy/helm/openclaw-observability-demo/Chart.yaml`,
`values.yaml`, and `templates/{prometheus,loki,grafana,networkpolicies}.yaml`;
create `tests/integration/observability-demo-k3d.test.mjs`.
Reuse `deploy/metrics/development/dashboard.json` and provisioning assets through
a shared owning asset location under `deploy/metrics/` if relocation is needed;
update Compose mounts and existing monitoring tests together.

**Interfaces:** A separate release accepts the OCC namespace/release for Pod
discovery and an existing Grafana password Secret. Its private Loki Service
receives filtered Collector OTLP logs. No operator CRDs or cloud service required.

- [x] Build single-replica Prometheus, Loki, and Grafana manifests with immutable
      images, resource/storage limits, disposable data, private Services, and
      least-privilege discovery RBAC. Generate credentials outside Helm values.
- [x] Configure Loki structured metadata and set the Collector's full
      `logs_endpoint` to `http://<loki-service>:3100/otlp/v1/logs` in the
      protected demo exporter Secret. Use the paired exporter selectors from Task 1.
      Preserve the production Collector policy and one owner per log stream.
- [x] Provision Prometheus and Loki Grafana data sources, the existing metric
      dashboard, and a saved operational-log view. Label each as demonstration
      infrastructure; do not embed credentials in dashboards or evidence.
- [x] Register the smoke file once in `k3d-observability` with required case names
      and run it after Task 2, using an isolated
      release. Install with the documented commands, await readiness, then generate
      a real authenticated API request and Agent lifecycle work on the Helm install.
- [x] Require every expected scrape target up; query fresh metric deltas and the
      matching API/worker log records from the backends. Through Grafana's HTTP
      data-source APIs, require successful nonempty Prometheus and Loki responses.
      Execute dashboard queries with bounded time ranges; readiness alone fails.
- [x] Open the provisioned dashboard/log view in a browser and capture sanitized
      visual evidence. Uninstall the demo, restore or disable its exporter settings,
      and verify OCC, its database, and Agents remain usable.
- [x] Add `docs/guides/observability/demo.md` with prerequisites, launch, visible
      results, limits and cleanup; register it in `docs/docs.json`. Update layout
      guidance if shared assets move. Extend existing Compose smoke only as needed
      to protect moved assets; Kubernetes smoke is the required new proof.

## Task 4: Make local k3d and CI the standard acceptance path

The completed wrapper tasks below record the original implementation. The
wrapper and its package commands were later removed; use the current
[CI lane procedures](../../../docs/testing/metrics.md#kubernetes-observability-acceptance).

**Files:** Create `scripts/test-observability.mjs`; modify `package.json`,
`scripts/ci/test-suites.json`, `.github/workflows/ci.yml`,
`.github/workflows/full-integration.yml`, and
`.github/actions/run-ci-lane/action.yml`. Extend existing CI runner/launcher tests.

- [x] Audit ownership and required case names for both new files in
      `k3d-observability`. Register this lane in both
      `ci` and `full` groups and their workflow matrices/aggregates.
- [x] Add `pnpm test:observability` invoking the local wrapper. By default it
      prepares k3d and runs the credential-free source and demo tests, matching
      ordinary PR CI. It must succeed without `OPENAI_API_KEY` and make no model
      calls. Add `pnpm test:observability:models` invoking the wrapper with
      `--model-turns` to select only the separate real runtime lane below.
- [x] Use the existing engine selection/owned cleanup conventions without changing
      `scripts/k3d`'s current model demo default. Preflight model credentials only
      for the explicit model-turn command, before provisioning. Never load or
      print secrets implicitly.
- [ ] Verify the configured credential-free lane on PRs, main pushes, merge
      groups, and manual CI. Runner selection uses `ubuntu-22.04`, and the
      composite action enables bridge netfilter; hosted results remain pending.
- [ ] Add expanded model coverage through a Helm-installed API/worker,
      including revision-cutover attribution, metrics, and credential exclusion
      across revisions. This coverage is deferred from the current cut. The retained
      `k3d-otel` cases use the existing production topology fixture and check one
      revision's gateway/Codex records and model turns.
- [x] Keep the existing cases owned by `k3d-otel`. Run that lane only through
      the documented local procedure or the protected CI dispatch using
      `integration-otel`. Preserve reviewers and immutable source checkout;
      do not add automatic model execution to ordinary PR or main CI.
- [x] Test wrapper failure propagation and owned cleanup with real preparation
      failure/success paths; extend existing runner accounting tests for missing
      cases/results. Upload sanitized source/image identities, counts, query
      outcomes and cleanup results. Query success is represented by the named acceptance
      case outcome; raw query results are excluded. Never upload Secrets or model output.
- [x] Run suite audit and actionlint. Record actual local results and hosted
      run/job/commit identities separately for credential-free and model-turn
      coverage. A pending protected job leaves model-turn proof unverified;
      it does not prevent the default checks from completing.

## Task 5: Document and qualify the final implementation

- [x] Update production installation/handoff, observability overview and metrics
      guide with exact discovery, endpoint, permission, Secret and failure details.
      Distinguish local output, configured export, and verified backend receipt.
- [x] Update `docs/testing/{README,kubernetes,metrics,ci}.md`, affected flows,
      environment-variable cheat sheet, navigation and layout. Keep test-only
      variables in testing docs. Preserve historical specs and Manual Notes.
- [x] Run formatting, `pnpm lint`, `pnpm typecheck`, `pnpm check:workspace`,
      `pnpm docs:check`, `pnpm docs:check-length`, and `git diff --check` as applicable
      with matching installed dependencies. Do not install dependencies as verification.
- [ ] Run the credential-free lanes locally using the current
      [CI lane procedures](../../../docs/testing/metrics.md#kubernetes-observability-acceptance),
      then obtain passing required CI for the final revision. Qualify model
      turns separately using the retained model lane and protected CI;
      report missing runtime evidence without presenting default checks as runtime proof.
      Run the existing three k3d fixture cases when shared preparation changes;
      all selected cases must pass without skips.
- [ ] Record delivery status, exact proof and limitations in the spec and review.
      Commit cohesive tasks through the repository workflow; publishing or merging
      is outside this planning request.

This plan stays together because the chart defaults, installed-source checks,
demo and CI entrypoints form one acceptance workflow. Completion requires both
real data-source proof and the demo query smoke test, not only manifests/builds.
