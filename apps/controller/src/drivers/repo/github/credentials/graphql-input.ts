// GitHub mints a clone credential for Repository.tempCloneToken. GraphQL field
// names are plain ASCII names with no escape syntax, so an alias or fragment still
// spells the field. JSON escapes could hide it in the request body; decode every
// string literal (duplicate keys included) before searching.
const providerCredentialField = "tempCloneToken";
const jsonString = /"(?:[^"\\]|\\.)*"/g;

/** Refuse GraphQL request bodies that could select a provider clone credential. */
export function allowsGraphqlInput(body: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    JSON.parse(text);
  } catch {
    return false;
  }
  // In valid JSON every quote outside a string starts a string literal.
  for (const [literal] of text.matchAll(jsonString)) {
    if ((JSON.parse(literal) as string).includes(providerCredentialField)) {
      return false;
    }
  }
  return true;
}
