<a id="deprecated-protected-repository-metadata"></a>

# Retired protected repository metadata

The legacy credential-egress Driver and its `credential-free-repository-metadata`
Source are retired. The Credential Sources API no longer accepts this type.

For public GitHub metadata, grant the requesting executable access to
`api.github.com:443` through [Sandbox network policy](../sandbox-policies.md#authority-and-admission).
The Agent receives the upstream response without credential injection or field
filtering. A Git Repository grant
covers Git operations only. See the [credential delivery guide](../../guides/credential-proxy.md#choose-the-path-before-changing-an-installation).

<a id="register-a-source"></a>
<a id="read-and-list-sources"></a>
<a id="bind-a-source-to-an-agent"></a>
<a id="update-a-source"></a>
<a id="withdraw-a-source-from-an-agent"></a>
<a id="delete-a-source"></a>
<a id="errors"></a>
<a id="related"></a>

## Earlier releases

The legacy sender checked the requested repository identity and returned only
`id` and `full_name`. See the
[previous API reference](https://github.com/openclaw/openclaw-enterprise/blob/67865414220f9d67820f165fe932fe23df025322/docs/reference/credential-sources/protected-repository-metadata.md),
[request flow](../../flows/credential-source-egress.md#follow-the-metadata-get), and
[threat model](../security/credential-proxy.md) for the earlier exchange.
