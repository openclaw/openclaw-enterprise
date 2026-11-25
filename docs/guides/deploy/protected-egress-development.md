# Develop protected egress

<a id="develop-and-withdraw-the-protected-egress-schema"></a>

Use [Credential Proxy setup](../credential-proxy.md) for configuration and operator
verification. This page retains links from earlier development instructions.

## Upgrade an existing development installation

The earlier protected-egress release recognized 59- and 62-receipt histories
and upgraded them to 63; its 71-receipt preview required its matching release.
Use the [historical upgrade procedure](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/guides/deploy/credential-proxy-upgrade.md#keep-schema-histories-separate)
for that release. Current controller upgrades follow the [standard procedure](production-upgrade.md).

## Select fresh whole-execution protection

Follow [setup](../credential-proxy.md#prepare-enforcement-trust-and-custody) and the
[protected inference reference](../../reference/credential-sources/protected-inference.md).

### Helm packaging

Use the [setup TLS and Helm inputs](../credential-proxy.md#prepare-enforcement-trust-and-custody)
and [local image profile](local-openshell-images.md#select-the-protected-profile).
