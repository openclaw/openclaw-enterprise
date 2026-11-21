# Develop protected egress

<a id="develop-and-withdraw-the-protected-egress-schema"></a>

Use [Credential Proxy setup](../credential-proxy.md) for configuration and operator
verification. This page retains links from earlier development instructions.

## Upgrade an existing development installation

Follow the [upgrade procedure](credential-proxy-upgrade.md): the published product
upgrades the recognized 59- and 62-receipt histories to 63. Historical 71-receipt
preview state needs its matching release. Check replacement support before
interrupting access.

## Select fresh whole-execution protection

Follow [setup](../credential-proxy.md#prepare-enforcement-trust-and-custody) and the
[protected inference reference](../../reference/credential-sources/protected-inference.md).

### Helm packaging

Use the [setup TLS and Helm inputs](../credential-proxy.md#prepare-enforcement-trust-and-custody)
and [local image profile](local-openshell-images.md#select-the-protected-profile).
