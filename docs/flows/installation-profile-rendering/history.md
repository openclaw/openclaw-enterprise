---
published: false
---

# Installation Profile Rendering documentation history

This record preserves the dated changes to the Installation Profile rendering flow. See the [parent page](../installation-profile-rendering.md) for its context.

## Changelog

- 2026-10-09 23:58: Reject database CA mount collisions with the active mounts selected by installation profiles. (authoring-run/19832129-1f67-41f2-8961-d10c648012fd - e6d0571907da6bc6d40eed3e1f8125f7dd332e99)

- 2026-10-09: Check DNS, API client and metrics scraper selectors with Compute's peer label rule, allowing empty values.

- 2026-10-09: Apply the chart's sign-in Secret, runtime node selector, claim name and Backend ID rules, and escape characters Helm's YAML parser changes.

- 2026-10-09 21:03: Validate controller image references before emitting profile files. (authoring-run/9a3fd823-79af-431c-b422-44c0ba255013 - b62cf404ed354079e1c51b64a1e664b3c66c0262)

- 2026-10-09 20:06: Validate transport Secret prefixes before rendering Installation configuration. (authoring-run/8b675a82-44c5-4fc1-a404-dad5edd03858 - cd468c23101b201b3969fa1a4077a18042d3396b)

- 2026-10-09 19:54: Reject external sign-in credential-key collisions during profile preflight. (authoring-run/d628d0ae-29d8-405c-b812-0534f00d5821 - 60a837dfd798e8fac90b53c47436c4bc7a36e8e4)

- 2026-10-09 19:42: Validate control-plane placement labels before writing profile output. (authoring-run/2e2ce65b-ab3e-4466-8f24-602241488e52 - 3a1e29fb461d2ad61a9276ae4af432bcf2d04c88)

- 2026-10-09: Check API client and DNS peer namespaces as DNS labels of at most 63 characters.

- 2026-10-09: Check gateway and Envoy namespaces as DNS labels of at most 63 characters.

- 2026-10-09: Accept empty control-plane placement label values, as Kubernetes does.

- 2026-10-09: Refuse Google hosted domains the chart and API refuse.

- 2026-10-09: Refuse a repository broker Service name the chart's DNS-1035 check refuses.

- 2026-10-09: Refuse gateway and Envoy namespaces the Compute driver refuses.

- 2026-10-09: Refuse Codex seccomp paths the Compute driver refuses.

- 2026-10-08: Refuse database CA keys the chart refuses.

- 2026-10-08: Refuse installation names the chart and the bootstrap Job refuse.

- 2026-10-08 18:17: Resolve hosted Codex discovery destinations when the existing CIDR input is omitted, preserving explicit lists and external policy management. (authoring-run/80c1ae0f-fe2f-4d78-bc5c-ebfacffd1194 - 946e3a5dee61c34ac8d87b715eda1e2cc059d26a)

- 2026-10-07 12:07: Unify imported and managed PAT authentication while preserving source ownership and existing OAuth behavior. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - be5006e62)

- 2026-10-07: Refuse a public-suffix shared cookie domain in preflight.

- 2026-10-06 15:26: Reject invalid Helm release names before emitting deployment files. (authoring-run/2ae5d308-21b1-4e0c-b693-55c25dd9f879 - 4a314f5b5ac48937acf976fc3e69c385d1883c35)

- 2026-10-06 13:20: Reject noncanonical SHA-256 image digests before emitting deployment files. (authoring-run/feaed473-dcbe-4c10-93fc-39e937f1e798 - f2fb8cbe952d7c27b2690f86134c89e6912cb883)

- 2026-09-29 20:30: Stop defaulting the repository broker Service name so the chart upgrade guard applies.

- 2026-09-29 18:00: Carry external sign-in, the recovery user ID, and trusted proxies through profile rerenders.

- 2026-09-28 22:45: Preserve original Slack public HTTPS egress and repository provider ranges in both profiles. (authoring-run/9c2c8f31-7cb0-4359-a7d7-a6f5c3be882a - 1365d9b33eec2de2452bd3142f57a1729cccd559)

- 2026-09-28 21:04: Added optional Preset file inputs to the renderer and paired startup output. (authoring-run/9c2c8f31-7cb0-4359-a7d7-a6f5c3be882a - 1365d9b33eec2de2452bd3142f57a1729cccd559)

- 2026-09-28 19:57: Match Helm Gateway names and invalidate prior generated files before rerendering. (authoring-run/c35ba3ae-a801-46fc-af68-f8f7a27d56ed - 15bab9571fa12a2192a4d5dbff70f3e263468ee7)

- 2026-09-28 15:36: Documented installation profile rendering flow. (authoring-run/6f2a325a-cf1c-4277-9ce3-7623626f68c6 - 6c56149f1f2b7290d8526d87c3624c9b7db09fbf)

- 2026-09-28 16:43: Updated the output step after removing the runtime YAML-loader dependency. (authoring-run/6f2a325a-cf1c-4277-9ce3-7623626f68c6 - 6c56149f1f2b7290d8526d87c3624c9b7db09fbf)

- 2026-09-28 17:04: Clarified that Codex defaults to existing `codex_pat` token credentials and renders managed ServiceAccount wiring only when explicitly supplied. (authoring-run/6f2a325a-cf1c-4277-9ce3-7623626f68c6 - 6c56149f1f2b7290d8526d87c3624c9b7db09fbf)

- 2026-09-28 17:31: Documented stricter profile preflight checks for IPv4 CIDRs, native-admin DNS domains, and paired metrics selectors. (authoring-run/6f2a325a-cf1c-4277-9ce3-7623626f68c6 - 6c56149f1f2b7290d8526d87c3624c9b7db09fbf)

- 2026-09-28 18:02: Documented rendered Installation checksum injection into Helm values and the Secret-before-Helm apply order. (authoring-run/6f2a325a-cf1c-4277-9ce3-7623626f68c6 - 6c56149f1f2b7290d8526d87c3624c9b7db09fbf)
