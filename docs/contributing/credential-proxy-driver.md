# Legacy credential-egress Driver

`LegacyEgressProxyDriver` is deprecated and pending removal. Qualified protected
metadata and repository exchanges still depend on it; remove it only after those
uses have another owner or are retired. Do not implement new credential delivery
on this interface. New integrations use the
[CredentialProxyDriver contract](../reference/drivers/credential-proxy.md#interface)
with TokenService and Sandbox.

<a id="1-choose-the-enforcement-boundary"></a>
<a id="2-return-one-registration"></a>
<a id="3-implement-preparation-and-release"></a>
<a id="4-bind-the-selected-transport"></a>
<a id="5-exercise-the-normal-agent-path"></a>
<a id="6-qualify-the-backend"></a>

For maintenance of an existing qualified Driver, see the
[historical implementation walkthrough](https://github.com/openclaw/openclaw-enterprise/blob/691409b2130052b4403d396dd91c7f20b468cd47/docs/contributing/credential-proxy-driver.md)
and the [legacy contract](../reference/drivers/credential-proxy.md#legacy-protected-egress).
