import { ErrorDetail as ErrorDetailSchema } from "@openclaw-enterprise/contracts";
import { SERVICE_KEY_NAME_MAX_LENGTH } from "../auth/index.ts";
import type { RequestOperation } from "./types.ts";

interface AuthOperation extends RequestOperation {
  readonly path: string;
  readonly summary: string;
}

export function installationAuthOperation(
  operation: Omit<AuthOperation, "iamAction" | "resourceKind" | "authorizationTarget">,
): AuthOperation {
  return {
    ...operation,
    iamAction: "administer",
    resourceKind: "installation",
    authorizationTarget: "installation",
  };
}

function installationAdminMetadata(
  operation: AuthOperation,
  description: string,
  credentials: "session" | "session_or_service_key" = "session",
) {
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description,
    tags: ["Authentication"],
    security:
      credentials === "session_or_service_key"
        ? [{ sessionCookie: [] }, { serviceApiKey: [] }]
        : [{ sessionCookie: [] }],
    "x-openclaw-permissions": [
      { action: "administer", resourceKind: "installation", scope: "requested" },
    ],
  };
}

function closedObject<Properties extends Record<string, unknown>>(
  required: readonly (keyof Properties & string)[],
  properties: Properties,
) {
  return { type: "object", additionalProperties: false, required, properties };
}

function boundedIdentifier() {
  return { type: "string", minLength: 1, maxLength: 200 };
}

function accountVersion() {
  return { type: "integer", minimum: 1 };
}

function expectedVersion() {
  return { ...accountVersion(), maximum: 2147483647 };
}

export function createAuthRouteSchemas() {
  const meta = closedObject(["requestId"], { requestId: { type: "string" } });
  const envelope = (data: Record<string, unknown>) =>
    closedObject(["data", "meta"], { data, meta });
  const error = closedObject(["error", "meta"], {
    error: closedObject(["code", "message"], {
      code: { type: "string" },
      message: { type: "string" },
      // Schema 400s point at the rejected field; without this the serializer drops it.
      details: { type: "array", maxItems: 32, items: ErrorDetailSchema },
    }),
    meta,
  });
  const responses = (success: Record<string, unknown>, status = 200) => ({
    [status]: { description: status === 201 ? "Created" : "OK", ...envelope(success) },
    401: { description: "Unauthorized", ...error },
    503: { description: "Service Unavailable", ...error },
  });
  const resourceErrors = () => ({
    400: { description: "Bad Request", ...error },
    403: { description: "Forbidden", ...error },
    404: { description: "Not Found", ...error },
    409: { description: "Conflict", ...error },
  });
  // Every route that reads a body answers an oversized one 413 and a non-JSON one 415.
  const bodyErrors = {
    413: { description: "Payload Too Large", ...error },
    415: { description: "Unsupported Media Type", ...error },
  };
  const passwordBody = closedObject(["email", "password"], {
    email: { type: "string", minLength: 3, maxLength: 320 },
    password: { type: "string", minLength: 12, maxLength: 128 },
  });
  const accountBody = closedObject(passwordBody.required, {
    ...passwordBody.properties,
    name: { type: "string", minLength: 1, maxLength: 200 },
    roleId: boundedIdentifier(),
  });
  const account = {
    type: "object",
    additionalProperties: true,
    required: ["id", "email", "name", "principalId"],
    properties: {
      id: { type: "string" },
      email: { type: "string", format: "email" },
      name: { type: "string" },
      principalId: { type: "string" },
    },
  };

  const accountParams = closedObject(["userId"], { userId: boundedIdentifier() });
  const methodParams = closedObject(["userId", "methodId"], {
    userId: boundedIdentifier(),
    methodId: boundedIdentifier(),
  });
  const recoveryResponse = closedObject(["userId", "principalId", "methodId"], {
    userId: { type: "string" },
    principalId: { type: "string" },
    methodId: { type: "string" },
  });

  function serviceKey(operation: AuthOperation, namespaceIdPattern: string) {
    const creating = operation.method === "POST";
    const issuedKey = closedObject(["id", "servicePrincipalId", "name", "expiresAt", "key"], {
      id: { type: "string" },
      servicePrincipalId: { type: "string" },
      namespaceId: { type: "string" },
      name: { type: "string" },
      expiresAt: { type: "string", format: "date-time" },
      key: { type: "string" },
    });
    return {
      ...installationAdminMetadata(
        operation,
        creating
          ? "Requires a session or Installation-scoped service key with administer on the Installation. Issues a Better Auth key for an existing non-Agent ServicePrincipal in its exact scope when the caller already holds every IAM grant of that ServicePrincipal at the same or a broader scope; creates no identity or IAM grant. The plaintext key is returned only here."
          : "Requires a session or Installation-scoped service key with administer on the Installation, plus every IAM grant of the key's ServicePrincipal, as for issuance. Deletes the stored Better Auth key; subsequent requests cannot authenticate with it.",
        "session_or_service_key",
      ),
      ...(creating
        ? {
            body: closedObject(["servicePrincipalId", "name"], {
              servicePrincipalId: boundedIdentifier(),
              namespaceId: { type: "string", pattern: namespaceIdPattern },
              name: {
                type: "string",
                minLength: 1,
                maxLength: SERVICE_KEY_NAME_MAX_LENGTH,
                pattern: "\\S",
              },
              expiresIn: {
                type: "integer",
                minimum: 86400,
                maximum: 31536000,
                description: "Lifetime in seconds; defaults to 30 days.",
              },
            }),
          }
        : {
            params: closedObject(["keyId"], { keyId: boundedIdentifier() }),
          }),
      response: {
        ...responses(
          creating
            ? issuedKey
            : closedObject(["id", "revoked"], {
                id: { type: "string" },
                revoked: { type: "boolean", const: true },
              }),
          creating ? 201 : 200,
        ),
        ...resourceErrors(),
        ...(creating ? bodyErrors : {}),
      },
    };
  }

  function readAccount(operation: AuthOperation) {
    return {
      ...installationAdminMetadata(
        operation,
        "Requires a current human Native IAM Installation administrator and either the configured Origin or a same-origin browser fetch to the configured Console host. Returns guarded present state.",
      ),
      params: accountParams,
      response: {
        ...responses(
          closedObject(["userId", "principalId", "version", "disabled", "methods"], {
            userId: { type: "string" },
            principalId: { type: "string" },
            version: accountVersion(),
            disabled: { type: "boolean" },
            methods: {
              type: "array",
              items: closedObject(["methodId", "providerId", "subject"], {
                methodId: { type: "string" },
                providerId: { type: "string" },
                subject: { type: "string" },
              }),
            },
          }),
        ),
        ...resourceErrors(),
      },
    };
  }

  function changeAccount(
    operation: AuthOperation,
    operationName: "google" | "oidc" | "disable" | "enable" | "revoke" | "detach",
  ) {
    const attachesIdentity = operationName === "google" || operationName === "oidc";
    return {
      ...installationAdminMetadata(
        operation,
        "Requires a current human Native IAM Installation administrator who holds every grant of the target account's Principal, trusted Origin and expectedVersion from a guarded account read. Commits state and audit together. An unknown outcome must be inspected without automatic retry; present state does not attribute the earlier request.",
      ),
      params: operationName === "detach" ? methodParams : accountParams,
      body: closedObject(attachesIdentity ? ["subject", "expectedVersion"] : ["expectedVersion"], {
        expectedVersion: expectedVersion(),
        ...(attachesIdentity
          ? { subject: { type: "string", pattern: "^[\\x21-\\x7E]{1,255}$" } }
          : {}),
      }),
      response: {
        ...responses(closedObject(["userId"], { userId: { type: "string" } })),
        ...resourceErrors(),
        ...bodyErrors,
      },
    };
  }

  function readRecovery(operation: AuthOperation) {
    return {
      ...installationAdminMetadata(
        operation,
        "Requires a current human Native IAM Installation administrator and either the configured Origin or a same-origin browser fetch to the configured Console host. Returns the present designation.",
      ),
      response: {
        ...responses(recoveryResponse),
        403: { description: "Forbidden", ...error },
        404: { description: "Not Found", ...error },
        409: { description: "Conflict", ...error },
      },
    };
  }

  function replaceRecovery(operation: AuthOperation) {
    return {
      ...installationAdminMetadata(
        operation,
        "Requires a current human Native IAM Installation administrator and trusted Origin who holds every IAM grant of the current holder's Principal (else 403). The target must be an enrolled, enabled account with one password whose Principal administers the Installation. expectedCurrentUserId comes from the recovery read and expectedVersion from the target's account read. Commits state and audit together; an unknown outcome must be inspected without automatic retry.",
      ),
      body: closedObject(["userId", "expectedCurrentUserId", "expectedVersion"], {
        userId: boundedIdentifier(),
        expectedCurrentUserId: boundedIdentifier(),
        expectedVersion: expectedVersion(),
      }),
      response: {
        ...responses({
          ...recoveryResponse,
          required: [...recoveryResponse.required, "changed"],
          properties: { ...recoveryResponse.properties, changed: { type: "boolean" } },
        }),
        ...resourceErrors(),
        ...bodyErrors,
      },
    };
  }

  function enrolAccount(operation: AuthOperation) {
    return {
      ...installationAdminMetadata(
        operation,
        "Requires a current human Native IAM Installation administrator and trusted Origin. The account must already have its IAM Principal and exactly one password. Idempotent; enrolment grants no access beyond the account's existing IAM bindings.",
      ),
      params: accountParams,
      response: {
        ...responses(
          closedObject(["userId", "principalId", "version", "created"], {
            userId: { type: "string" },
            principalId: { type: "string" },
            version: accountVersion(),
            created: { type: "boolean" },
          }),
        ),
        ...resourceErrors(),
      },
    };
  }

  function createAccount(operation: AuthOperation) {
    return {
      body: accountBody,
      ...installationAdminMetadata(
        operation,
        "Requires administer permission on the Installation. Creates a Better Auth account and an explicit IAM Principal in one transaction. Supplying roleId also creates a binding to that existing IAM Role; omitting roleId creates no grants. Public signup remains disabled.",
      ),
      response: {
        ...responses(account, 201),
        400: { description: "Bad Request", ...error },
        403: { description: "Forbidden", ...error },
        409: { description: "Conflict", ...error },
        429: {
          description: "Too many account creation requests; wait for Retry-After",
          ...error,
        },
        ...bodyErrors,
      },
    };
  }

  return {
    serviceKey,
    createAccount,
    readAccount,
    changeAccount,
    readRecovery,
    replaceRecovery,
    enrolAccount,
    passwordBody,
    bodyErrors,
    envelope,
    error,
    responses,
  };
}
