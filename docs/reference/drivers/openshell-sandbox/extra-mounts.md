# OpenShell Sandbox extra mounts

How the [OpenShell SandboxDriver](../openshell-sandbox.md) mounts more
subpaths of the data mount's PVC into a Sandbox, each with its own access.

## Configure extra mounts

Optional `kubernetes.sandboxExtraMounts` lists more subpaths of the PVC that
`kubernetes.sandboxDataMount` reuses. Each entry takes `subPath`, `mountPath`
and an explicit boolean `readOnly`; startup refuses any other key. The Driver
adds each entry to the Agent container as another mount of the same PVC volume,
so no new claim or lifecycle applies. In `drivers.sandbox.configuration`:

```yaml
kubernetes:
  sandboxDataMount:
    subPath: workspace
    mountPath: /sandbox/enterprise
    readOnly: false
  sandboxExtraMounts:
    - subPath: matter/originals
      mountPath: /sandbox/matter/originals
      readOnly: true
```

Kubelet enforces a read-only mount, and the Driver adds its path to the
OpenShell filesystem policy's read-only set; a writable one joins the
read-write set. Landlock grants accumulate down a tree, so a read-only path
beneath the writable data mount would stay writable to the policy. Each extra
mount therefore lives outside the data mount.

## Validation

Startup and Sandbox provisioning refuse an entry when:

- `subPath` is absolute, or has a `.`, `..` or empty segment.
- `subPath` equals or nests with the data mount subpath, another extra mount,
  an approved Harness workspace subpath on that PVC, or an
  `openshell-runtime-` runtime subpath.
- `mountPath` is not under `/sandbox/`, or has a `.`, `..` or empty segment.
- `mountPath` equals or nests with the data mount path, another extra mount, an
  approved Harness mount path, `/sandbox/.openclaw-runtime` or
  `/sandbox/.openclaw-mounts`.
- `readOnly` is missing or not a boolean.
- `readOnly` is `false` and every approved Harness mount of the PVC is
  read-only.

Startup also refuses a read-only extra mount listed in
`policy.filesystem.readWrite`.

## Directory preparation

For native OpenClaw, the permission preparer creates each extra subpath before
Sandbox creation. A writable one becomes a `0700` directory owned by the
Sandbox UID, like other writable mounts. A missing read-only one is created as
a `0700` directory owned by the Sandbox UID; an existing one, holding content
another writer placed, keeps its owner and mode. Dedicated Codex has no
preparer, so the kubelet creates a missing subpath as it does for the data
mount.
