---
published: false
---

# Common logging documentation history

This record preserves the dated changes to the common operational logging flow. See the [parent flow](../common-logging.md) for its context and overall sequence.

## Changelog

- 2026-10-09 23:11: Document renamed Loki exporter addresses and Collector refresh after demo upgrades. (authoring-run/8adc169e-fc08-40ad-823f-a80486252608 - 6668e2fc8477ca780b15e25a7320589a7612284f)

- 2026-10-09 21:42: Bound demo Service names and keep Grafana datasource URLs aligned. (authoring-run/8adc169e-fc08-40ad-823f-a80486252608 - 49d1562335120b125d3f149a5a6a64a5c51577a9)

- 2026-10-09 14:00: Export `http.dependency_unavailable`, the API warning that names the cause of a `503 DEPENDENCY_UNAVAILABLE` by request ID; the cause stays local. (fix-529-938)

- 2026-10-08 10:17: Document Collector quantity syntax checks in the accompanying chart change. (authoring-run/95ed7983-818c-4af2-8875-1330333f5e41 - 1fce0eef361dd584212cc3f2ac4d75ab92eb8ff7)

- 2026-10-06 13:30: Export `agent_provisioning.compute_refused`, the API warning that names a Compute provisioning refusal by request ID.

- 2026-10-06 06:30: Export the API shutdown, idle database connection, device login, cluster credential denial, native admin audit failure and authentication startup warnings that other pages tell operators to look for.

- 2026-10-05 05:30: Note that the Preset startup warnings come only from the API.

- 2026-10-05 03:30: Export `presets.bundled-default-shadowed` as WARN with only its event name.

- 2026-10-05 02:30: Export `presets.default-create-skipped` as WARN with only the Namespace ID.

- 2026-10-04 23:10: Export `presets.default-refresh-skipped` as WARN with only the Namespace and Preset IDs. (bh13-fu2-collector - e54a08048)

- 2026-10-01 16:37: Added the sanitized Compute preparation diagnostic boundary. (authoring-run/dda71266-f9f6-404c-aaba-b0c03f010ae2 - 987c8c2b4ace1e152262ef6920b6d0f9ff26a086)

- 2026-10-01 14:45: Export sign-in provider outage warnings with allowed provider, step, cause and status attributes. (collector-auth-warning - 769c8cd88)

- 2026-09-25 11:31: Documented query-time operational summaries and filtering in the accompanying demo dashboard change. (redacted - 1a458b227585c572ec0ac70fd10efc3834165075)

- 2026-09-25 09:56: Documented worker teardown correlation with the accompanying Collector allowlist repair. (redacted - 939ae63ac2be06d424cdbd5c626cfa675561d127)

- 2026-09-25 09:53: Documented preflight warning export and message exclusion with the accompanying Collector allowlist repair. (redacted - 939ae63ac2be06d424cdbd5c626cfa675561d127)

- 2026-09-23 17:40: Documented private Collector scraping and selected in-cluster export in the accompanying observability change. (redacted - faf0b0ae467a3bebfd5b5ed0a92f259248e5da74)

- 2026-09-04 21:04: Documented that native logging admission drops the retired redaction key while preserving JSON levels, disabled OTLP logs, runtime redaction ownership and read-only Kubernetes config mounting. (redacted - 87234e1766e5802b45424523246a52a4b2d45590)

- 2026-09-02 10:42: Added the source-backed common logging flow for startup policy, version admission, runtime rendering, and Collector export. (redacted - 1242406b6863c8953abe4827c601c2173129ee50)
- 2026-09-03 17:56: Simplified repeated settings and guide detail while preserving the logging lifecycle, admission, Collector filtering, and audit boundaries. (redacted - 61ef68bc61129c90130bb65b0fc48373f0c70866)
