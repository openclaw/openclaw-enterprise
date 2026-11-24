# Verify Git token renewal

For Source-backed Git, TokenService renews the GitHub installation token independently of the Agent revision's saved Repository grant. A request still needs a valid Source credential and must match that grant. Token expiry does not withdraw the grant.

Use [Source-backed Git enrollment](openshell-enrollment.md) and the operator shell
from [first Agent setup](../deploy/deploy-first-agent.md), which defines `request`
and `base`. List the active revision's Source IDs:

```bash
revision=$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)
request GET "$base/agents/$agent/revisions/$revision" |
  jq -r '.data.credentialSources[].sourceId'
```

Read each Source with `GET $base/credential-sources/<id>` and set `gitSource`
to the `github-app-installation` Source for the expected Client and repository
scope. Before renewal, run an allowed Git read from the active Agent and confirm
a read of an unselected repository is denied. Record those results. An operator
with `credential_source:update` can then request renewal explicitly:

```bash
request POST "$base/credential-sources/${gitSource:?}/rotate"
```

Repeat both reads from the same active Agent after renewal. Confirm the allowed
result at GitHub and that the unselected repository remains denied. This manual request does not prove scheduled renewal. To check
the schedule, repeat the observation when maintenance renews a due Source
without the manual request. A successful mint alone does not establish that the
running Agent received the replacement token. Reads made while the original
token is still valid could use that token. To prove replacement delivery,
confirm a corresponding Source/Provider version advance through qualified
evidence, or repeat the allowed read after the original token expires. Source
GET does not expose the material version.

The earlier Worker/prepared-session SQL exercise is a [historical verification procedure](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/guides/repository-credentials/openshell-git-renewal.md) for pre-cutover releases.
