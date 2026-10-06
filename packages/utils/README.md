# Shared utilities

`@openclaw-enterprise/utils` owns small mechanisms used across active packages
and Drivers. It uses only JavaScript and Node.js built-ins; it does not depend
on platform contracts or third-party packages.

Import shared functions from `@openclaw-enterprise/utils`. Keep implementations
grouped by purpose under `src/`; `src/index.ts` exports the public surface.

| Module          | Exports                                     | Boundary                                                                                                                                             |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `objects.ts`    | `asRecord`, `deepFreeze`, `immutableCopy`   | Object checks, in-place freezing, and detached immutable copies. `asRecord` rejects null and arrays but does not validate JSON or object prototypes. |
| `models.ts`     | `splitModelRef`                             | Splits a native model ref at its first slash into provider and model ID; the ID may contain slashes. It does not validate either part.               |
| `validation.ts` | `isNonEmptyString`, `isPositiveSafeInteger` | Predicates only. Callers keep their error classes, messages, and stricter domain validation. String checks do not trim or normalize values.          |
| `hashing.ts`    | `sha256Hex`                                 | SHA-256 hex with an optional slice length. Resource owners choose prefix lengths and naming rules.                                                   |
| `errors.ts`     | `numericErrorStatus`                        | Reads numeric `code`, `statusCode`, `response.statusCode`, then `response.status`. Callers decide whether the result is retryable or permanent.      |
| `http.ts`       | `cookieHeaderFromSetCookie`                 | Converts separate Set-Cookie fields to a Cookie header, stripping attributes without splitting Expires commas. It does not authenticate requests.    |
| `text.ts`       | `hasControlCharacter`                       | Detects C0 controls and DEL only. C1 controls, U+2028/U+2029 and other Unicode pass; callers add stricter rules.                                     |

Add a utility when multiple modules need the same behavior. Keep authorization,
resource ownership, schema validation, credential handling, Driver lifecycle
rules, and database error translation with their domain owner. Do not merge
helpers that differ in normalization, accepted inputs, retry behavior, or error
types merely because their names match. Self-contained runtime entrypoint
scripts cannot import this package from tenant images.

Verify the shared behavior with:

```sh
node --test tests/conformance/utils.test.mjs
```

Also run the affected consumers' conformance or integration tests. Fixed digest
vectors in the utility tests protect resource-name compatibility independently
of consumers that use the same hash helper for resource lookup.
