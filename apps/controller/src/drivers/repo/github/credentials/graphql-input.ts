// GitHub mints a clone credential for Repository.tempCloneToken. GraphQL field
// names are plain ASCII names with no escape syntax, so an alias or fragment still
// spells the field. JSON escapes could hide it in the request body; decode every
// string literal (duplicate keys included) before searching.
const providerCredentialField = "tempCloneToken";
const jsonString = /"(?:[^"\\]|\\.)*"/g;
// The `mutation` operation keyword is a GraphQL Name, so it cannot be escaped or
// split; refusing it wherever it appears as a whole Name also over-denies a field
// or string argument with that exact spelling, which is acceptable. The match is
// case-sensitive on purpose: keywords are, and no Name character can directly
// precede an operation keyword.
const mutationKeyword = /(?:^|[^_0-9A-Za-z])mutation(?:[^_0-9A-Za-z]|$)/;

const readOnlyKeys = new Set(["query", "variables", "operationName"]);

function decodedLiterals(body: Uint8Array, readOnly = false): string[] | undefined {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  // Read-only mode also requires one plain query document: no batches, persisted
  // queries, document IDs or extensions whose meaning upstream could change.
  if (
    readOnly &&
    (typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { query?: unknown }).query !== "string" ||
      Object.keys(parsed).some((key) => !readOnlyKeys.has(key)))
  ) {
    return;
  }
  // In valid JSON every quote outside a string starts a string literal.
  return [...text.matchAll(jsonString)].map(([literal]) => JSON.parse(literal) as string);
}

/** Refuse GraphQL request bodies that could select a provider clone credential. */
export function allowsGraphqlInput(body: Uint8Array): boolean {
  const literals = decodedLiterals(body);
  return literals !== undefined && !literals.some((text) => text.includes(providerCredentialField));
}

/**
 * Also refuse every mutation. A static token cannot be narrowed per session, and
 * mutations such as createRef or updateRef would write refs outside the push
 * allowlist the gateway enforces on receive-pack.
 */
export function allowsReadOnlyGraphqlInput(body: Uint8Array): boolean {
  const literals = decodedLiterals(body, true);
  return (
    literals !== undefined &&
    !literals.some((text) => text.includes(providerCredentialField) || mutationKeyword.test(text))
  );
}
