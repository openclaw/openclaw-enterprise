# Develop a Driver

Use this guide to add an implementation of an existing OpenClaw Control Plane
(OCC) Driver contract. The Installation selects Drivers; an individual Agent or
tenant cannot install or switch them. Start with the contract for the capability
you are changing.

## 1. Choose the contract

The shared TypeScript contracts define the methods and data each Driver exchanges
with OCC. The [base Driver types](../../packages/contracts/src/driver.ts) are
separate from each capability's interface file. Each reference links its
interface file, explains who calls those methods, what each implementation must
enforce, and which failures must stop the operation:

- [Compute](../reference/drivers/compute.md), [Configuration](../reference/drivers/configuration.md), and [IAM](../reference/drivers/iam.md)
- [Sandbox](../reference/drivers/sandbox.md), [Credential Proxy](../reference/drivers/credential-proxy.md), and [Secret](../reference/drivers/secret.md)
- [Plugin](../reference/drivers/plugin.md) and [ServiceAccount](../reference/drivers/service-account.md)

Installed npm packages can implement **Compute, Configuration, IAM, or Sandbox**.
A Sandbox package can also provide Credential Proxy through one registration;
follow the [Credential Proxy walkthrough](credential-proxy-driver.md) for that
paired capability and its profile limits. Secret, Plugin, and ServiceAccount
have bundled selections only. If you need one of those capabilities, change the
existing platform implementation; adding an npm package alone will not make it
selectable. Use the [supported selections](../reference/drivers/selection.md#supported-selections)
and [repository layout](../layout.md#source-ownership) to find its owner. Bundled
infrastructure implementations live under `apps/controller/src/drivers/`; native
IAM lives in `packages/iam/`. Composition lives in `apps/controller/src/composition/`.

## 2. Implement and register it

For an installed implementation, export a closed `configurationSchema`,
`validateConfiguration`, and `createDriver` from a precompiled JavaScript ESM
entry point. The platform validates structure before calling the semantic validator,
which returns a readonly field-error list (empty on success), as described in
[configuration definitions](../reference/drivers/selection.md#configuration-definitions-and-discovery);
factories consume the original validated input. Callbacks receive an isolated,
frozen copy and cannot replace configuration values. Declare runtime contributions only when a
resource-owner binding supplies their authorization and lifecycle. A Sandbox
advertising `networkPolicy` must contribute `(agent, sandbox-network-policy)`.
Return the selected `id` and `implementation`, the expected
`capability`, and its required methods on each capability object. For paired
capabilities, return one `DriverRegistration` with shared lifecycle hooks
instead of independent instances. The controller must declare the package
as a direct production dependency at an exact version; update the lockfile with
it. For a bundled implementation, follow the existing capability directory and
wire it into controller composition. Consult the [package and factory contract](../reference/drivers/selection.md#package-identity-and-factory-exports)
for the complete loader rules.

Implement the failure paths as carefully as the successful ones. OCC owns
platform authorization and resources; an execution Driver acts on the admitted
scope it receives. Check backend ownership before changing a resource, make
retried operations safe where the contract requires it, and fail rather than
silently switching backends or broadening access. An installed package runs with
control-plane authority, so its publisher and code need review. Startup validation
can reject the wrong shape; it cannot establish that the code protects tenant
boundaries.

## 3. Verify and document the change

Run the following from the repository root with dependencies installed:

```sh
pnpm typecheck
pnpm test:files -- tests/integration/driver-plugin-installation.test.mjs
```

The second command exercises package installation and controller admission for
fixture Drivers. It does not verify your backend. Extend the relevant
[conformance and integration coverage](../testing/README.md) and exercise your
implementation through its normal API or worker caller, with the real backend
needed to prove the behavior. Cover consequential failures such as an unavailable
backend, access outside the admitted scope, or cancellation where supported.

Update the capability reference or implementation guide and the owning
[runtime flow](runtime-flows.md) when behavior changes. Use the contributor
[documentation guide](documentation.md) for placement and writing conventions.
