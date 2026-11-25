# Deprecated credential egress development

<a id="develop-protected-egress"></a>
<a id="develop-and-withdraw-the-protected-egress-schema"></a>

`LegacyEgressProxyDriver` is deprecated and pending removal. Use
[TokenService and native Credential Proxy](../credential-proxy.md) for new
credentialed workflows. Credential Design 1.0 retires the legacy protected
repository and metadata exchanges rather than migrating them. The code remains
until removal; this page applies only to an existing legacy installation.

## Upgrade an existing development installation

The earlier protected-egress release recognized 59- and 62-receipt histories
and upgraded them to 63; its 71-receipt preview required its matching release.
Use the [historical upgrade procedure](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/guides/deploy/credential-proxy-upgrade.md#keep-schema-histories-separate)
for that release. Current controller upgrades follow the [standard procedure](production-upgrade.md).

<a id="select-fresh-whole-execution-protection"></a>

## Existing protected exchanges

Keep the matching release and its qualified sender configuration for an existing
exchange. See the [legacy dependency and historical setup](../credential-proxy.md#prepare-enforcement-trust-and-custody).

### Helm packaging

Preserve the existing authority TLS and peer configuration for that release.
New local protected static-inference launches are [retired](local-openshell-images.md#select-the-protected-profile).
