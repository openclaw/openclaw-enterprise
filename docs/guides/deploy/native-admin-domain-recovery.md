# Recover a retained overlong Agent domain

A native Agent domain must contain at most 214 ASCII characters. The generated
`agent-<32 hex>.` prefix adds 39 characters: a 214-character suffix produces a
253-character hostname; a 215-character suffix produces an unusable 254-character
hostname. Profile rendering and Helm reject enabling native access above this limit.

If an existing installation retains an overlong suffix, the controller continues
to serve Console and ordinary authorized Agent API reads. After Agent authorization,
native availability returns `unavailable` without a target. Native launch and
explicit native opt-in are refused; opt-in does not save Configuration or queue deployment.

Keep the retained domain while restoring ordinary access. Shared-cookie authentication
still derives its cookie scope from the Console and Agent domains, including when
native access is disabled. Do not remove the domain to disable native access.
Set `agentNativeAdmin.enabled: false` for a Helm recovery deployment and preserve
the Console ingress, DNS, TLS certificate, and authentication settings.

To restore native access, choose a suffix of at most 214 characters under the
trusted shared cookie parent. Prepare its wildcard DNS, TLS certificate and ingress
to the OCC API Service before changing the suffix. Update the profile and Helm
values together, then enable native access. Sign in again if cookie scope changes.
Regenerate each affected Agent's allowed origin through the supported browser-access
setup and deploy it. Verify Console sign-in, an ordinary authorized Agent read,
and native availability and launch before removing the old wildcard ingress.
