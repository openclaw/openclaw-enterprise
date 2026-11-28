---
rfc: index.md
---

# Recheck the selected Secret reader before each storage read

**Proposed amendment to [RFC-0023](index.md).**

While the Kubernetes Secret Driver waits for namespace verification, OCC can replace the
credential provider selected for the exchange. A Secret GET would then read material for a
provider that OCC no longer selects. The same race can happen after a GET returns HTTP 503,
while the Driver waits to retry.

OCC decides who may read the Secret and pins the original provider, the Secret Driver instance
and its `readCredentialInput` method. We propose adding `selectionCurrent?: () => boolean` to
`CredentialInputRead`. OCC checks the selection, calls the pinned method on that
instance and passes the same synchronous check to the Driver. OCC checks again on return and
withholds the material if the selection no longer matches.

The bundled Kubernetes Driver waits for namespace verification, SDK authentication and middleware.
Its HTTP transport checks the selection immediately before each material GET, including retries.
After the GET completes, the Driver checks again before decoding the value. If the selection has
changed, it discards the result. It cannot undo a GET that Kubernetes has already received.

The callback stays inside the trusted process. Neither it nor the Secret is serialized into the
workload. A true result says only that the selection matches at that instant. It grants no
database access and cannot detect a registration that changed away and back between checks.
Writing the response to the supervisor is a separate, downstream operation.

| Change during an authorized read with the bundled Driver | Secret GETs | Result |
| --- | ---: | --- |
| Selection stays current and storage succeeds | 1 | Return material to OCC |
| Provider changes during namespace verification | 0 | Refuse the read |
| Read method changes after HTTP 503, before retry | 1 total | Refuse the retry |
| Provider changes while the GET is in flight | 1 total | Discard the result |

Older and third-party Drivers can ignore the field. OCC can still withhold material on return,
but those Drivers may have issued a storage GET after the selection changed. Should protected
use allow those Drivers, or should it require a Driver to advertise support for the check?

[Implementation proposal #3882](https://github.com/openclaw/openclaw-enterprise/pull/3882)
provides source and fixture coverage. Installed runtime behavior remains unverified.
