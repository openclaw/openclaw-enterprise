<a id="legacy-credential-egress-driver"></a>

# Develop a Credential Proxy Driver

For changes to native credential delivery, start with the
[CredentialProxyDriver contract](../reference/drivers/credential-proxy.md#interface).
When OCC selects TokenService with the bundled OpenShell Sandbox, both Sandbox
and `credential_proxy` come from one registration. TokenService owns the
credential lifecycle, and Sandbox enforces network policy.

<a id="1-choose-the-enforcement-boundary"></a>
<a id="2-return-one-registration"></a>
<a id="3-implement-preparation-and-release"></a>
<a id="4-bind-the-selected-transport"></a>
<a id="5-exercise-the-normal-agent-path"></a>
<a id="6-qualify-the-backend"></a>

Exercise [the Agent deployment lifecycle](../reference/drivers/credential-proxy.md#lifecycle)
through the selected Sandbox. Check that the Proxy refuses a mismatched target
before resolving a credential, reports readiness for the expected bindings, and
removes the bindings for the specified target. Follow the
[Driver verification guide](driver-development.md#3-verify-and-document-the-change).

The `LegacyEgressProxyDriver` and its protected exchanges were removed. The
[former implementation walkthrough](https://github.com/openclaw/openclaw-enterprise/blob/691409b2130052b4403d396dd91c7f20b468cd47/docs/contributing/credential-proxy-driver.md)
applies to that earlier source revision.
