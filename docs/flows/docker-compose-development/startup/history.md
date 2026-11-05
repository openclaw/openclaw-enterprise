---
published: false
---

# Compose development startup documentation history

This record preserves the dated changes to the Compose development startup page. See the [parent page](../startup.md) for its context.

## Changelog

- 2026-11-04 20:46: Overlap selected-image setup; preserve readiness and rollback. (authoring-run/4dc828f0-0acc-4001-b6e2-3f57824db925 - 7951de4edf7abadc02725484771bcd6207ed9b9d)

- 2026-10-29 18:57: Resolved the manifest-list platform child before saving images. (authoring-run/88c984db-3b18-420c-acfc-7e329a46af89 - 5a61a08eec78fbae99e21b858af5c8dd5911ba03)

- 2026-10-28 09:41: Normalize attached Podman file options for startup and cleanup, retaining file validation. (authoring-run/fc103f5f-f130-4239-a879-78ed1d7e6602 - 8eea685f0303ad004e222fc4399a019a9486dcb3)

- 2026-10-24 17:53: Preserve attached Compose file selection before environment defaults. (authoring-run/bf58bf91-3fb2-4b62-9afe-c5cf1ce830dd - fd5723d94aebbd96d93e85649eec908adbc6d58a)

- 2026-10-15 01:49: Build enabled browser proxy before startup. (authoring-run/c11897e0-33a6-4276-b620-aaec6d57ab00 - c7468f5965686a75474d81ba0fd11b9a16ccff75)

- 2026-10-13 13:57: Reconciled Control UI startup with upstream cancellation, cleanup, and Keycloak paths. (authoring-run/503e74ea-e82a-4d1a-8081-fcf4fc4e6868 - 96272fa0a5e4f359ed354abb1918e44986c19e76)

- 2026-10-09 22:35: Bind bootstrap authorization to startup cancellation (authoring-run/c12130ba-3173-4831-86e9-5a209d16d630 - 7f358117e68076912a6062411d363e920a0e6adb)

- 2026-10-08 15:23: Reconciled current Docker preflight behavior with failed exclusive-output cleanup and clarified tool and image ownership. (authoring-run/0da79016-d6a4-4217-a420-1e8b0b314e14 - 3cffa93e76aedec4b2f35d14f9824b4531640449)

- 2026-10-08 09:30: Trimmed repeated startup detail after integration. (authoring-run/de31a6a4-b02f-464c-8652-662a7b152fe2 - 9506de602a55f57bf19fa02ba0c7b844aa5a6649)

- 2026-10-07 23:31: Documented optional Keycloak startup, identity attachment and cleanup. (authoring-run/aaa97aa0-d766-4366-af99-089d183c088a - c14b315969527a4e1f3fc3bd525e54d2ed5ec030)

- 2026-10-06 17:46: Remove newly created exclusive outputs after file-write failures. (authoring-run/e789ef10-ca82-4ee2-b31d-8d11100d9744 - 6508695f267e1441bf5a797b9710965f9b10990a)

- 2026-10-06 16:19: Traced exact local browser Host and Origin admission through the trusted Compose bridge before console Namespace reads. (authoring-run/cd977e92-eec5-445d-b9ab-bfd6bbfa4c18 - 99641a7ab00ad8fdd987e27e9ee838814e5f535a)

- 2026-10-06 12:00: Added the Compose/OpenShell loopback HTTPS endpoint, native-admin routing enablement, certificate ownership, and readiness proof. (authoring-run/0e6b1c8a-1723-4b20-ae51-08fa9457204a - 99641a7ab)

- 2026-10-05 16:01: Rejected interrupted Docker response streams in the request owner. (authoring-run/91705365-6496-4de8-943f-15c1ba105410 - 9b5a60467022d815d1259ff30d3ed64657657247)

- 2026-10-05 14:02: Matched the API and initializer localhost auth origin acceptance. (authoring-run/cb5a7445-804a-48ad-8c35-118ae9f417b1 - 91e316e7a559f5a09884262755f8fe2a9b655d72)

- 2026-10-05 08:52: Documented bridge-route cancellation and node-inventory context. (authoring-run/cfd0ce95-b6e3-4088-a97b-d6d4c9ff400c - fa8c90b5b6eb3464fcf3af42a7297b5de7d65454)

- 2026-10-04 01:12: Pointed the API startup step at the existing composition function. (authoring-run/286855f7-c7cb-43b6-ba19-419a20192f76 - 7a8a64046ac8ef3e7b5a4ed46b1d4cef9f1573f3)

- 2026-10-02 11:01: Polled CRD status instead of `kubectl wait`. (authoring-run/20771b6e-d59b-4737-8a63-cb33c420218e - 67302dd99e03d28053dbb72ba2569418f6aca1d0)

- 2026-10-02: Treated an absent initial CRD condition as pending.

- 2026-09-30 00:26: Tightened startup prose without changing its behavior. (authoring-run/6c4c7a4c-4674-456a-b1c4-69cec0c52c70 - 282ab1031ff2dd86af00c0c3ff304c9ad442fec1)

- 2026-09-30 00:10: Matched qualified Docker Hub references to recorded familiar names. (authoring-run/b1f9b6de-7c4e-4931-af56-d7be91056814 - 9ec7ad6944f6cad953e4b1e8284bc3e3faf28378)

- 2026-09-30 00:00: Matched implicit image tags and rejected ambiguous names. (authoring-run/bbaa0733-5942-49d5-8bff-1b5354c10117 - 421e85b24aa3a29c5748dde951224082b2c39d71)

- 2026-09-29 20:40: Bound k3d startup timeouts and preflight Node for Compose sandbox preparation. (89a4ccd7-3974-43c6-b08a-be02269a8d01 - cc96e34f33868555d4a89cb44bc022859d76c815)

- 2026-09-28 00:34: Restored Compose defaults and explicit Kubernetes-only startup. (01a0e441-02f9-70b2-ad45-0a1a5049954a - 201f31d511464133f06e0526bb5545ed1cb27e25)

- 2026-09-27 21:52: Waited for k3s Gateway API CRD creation and establishment before Envoy setup and preserved add-on diagnostics on failure. (01a0e441-02f9-70b2-ad45-0a1a5049954a - 181b0472f9a5a9d422035edf5121d3a15c200cb5)

- 2026-09-27 20:39: Added node-local legacy firewall selection, optional DNS configuration, and startup network-policy enforcement probes. (01a0e441-02f9-70b2-ad45-0a1a5049954a - 181b0472f9a5a9d422035edf5121d3a15c200cb5)

- 2026-09-25 12:23: Added the selectable Compose-backed OpenShell topology and brought the existing startup trace into the current flow-document structure. (authoring-run/a81f3e71-1c8e-4692-8e2e-d462ddacc10b - 64ab72aed5c4926e4a2080ade91d785e531801a2)
