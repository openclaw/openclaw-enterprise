# Upgrade an installation to Credential Proxy

Credential Design 1.0 retires Credential Gateway and Credential Refresh. The cutover rejects their Installation and Backend settings and drops Gateway-owned Sources after its safety checks pass. It does not transfer stored credentials or remove external OpenShell Providers. Some qualified legacy protected-egress paths remain separate.

<a id="decide-what-can-move"></a>
<a id="check-compatibility-before-interrupting-access"></a>
<a id="keep-schema-histories-separate"></a>
<a id="stop-and-settle-before-upgrading"></a>
<a id="replace-bindings-and-verify-before-removing-owners"></a>
<a id="recover-from-a-partial-transition"></a>

1. Stop Agents using Gateway Sources and settle related work before applying the cutover. Complete or cancel pending Codex device logins, or wait until they expire. A fresh pending login blocks cutover even when no Agent uses a Gateway Source. See [credential status](../../reference/credential-sources.md#implementation-status).
2. Remove `credential_gateway` and `credential_refresh` from Installation selection and OpenShell Backend membership. Select TokenService and a compatible Credential Proxy and Sandbox. Install the matching cutover controller, chart, and migrated schema through the [upgrade procedure](production-upgrade.md). See [Driver selection](../../reference/drivers/selection.md#supported-selections).
3. Enroll each replacement credential through TokenService, grant the Agent access, and deploy a new revision. Follow [first Agent setup](deploy-first-agent.md), [GitHub App setup](../repository-credentials/openshell-git-push.md), or [Plugin setup](../topics/openclaw-plugins.md).
4. Verify the required request from the deployed Agent. Retire old external Provider copies and profiles separately. If a cutover safety check refuses the operation, settle the reported dependency and retry; do not assume the old Source was transferred.

For a release before Credential Design 1.0, use the [historical upgrade procedure](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/guides/deploy/credential-proxy-upgrade.md).
