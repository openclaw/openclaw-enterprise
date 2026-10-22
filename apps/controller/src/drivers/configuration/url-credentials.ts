import { environmentReference, urlHoldsUserinfo } from "@openclaw-enterprise/occ";

type SettingPath = readonly (string | number)[];

const SCHEME_WITH_DOUBLE_SLASH = /^[\0- ]*[A-Za-z][A-Za-z0-9+.-]*:\/\//;

const urlCredentialMessage = (path: string): string =>
  `Configuration field ${path} carries a user name or password in the URL. Remove it, or make the whole URL a \${NAME} reference.`;

// `https:///v1` and `https:/v1` both parse as `https://v1/`. Model baseUrl already refuses
// that spelling; the other URL fields checked here do not.
const urlAuthorityMessage = (path: string): string =>
  `Configuration field ${path} has an empty authority or a missing //, which parses as a different host. Write an absolute http:// or https:// URL with the host you mean, and save again.`;

const urlCostMessage = (path: string): string =>
  `Configuration field ${path}, with the URLs and environment values before it, holds too many URLs or \${NAME} references to check for a user name or password. Shorten these values, or make each whole value a \${NAME} reference.`;

// The most work `environmentUrls` and the userinfo checks may do on one document's URL fields and
// environment values, in characters read (each rendering of each URL counts): about 0.1 s for
// each check of a document.
const URL_CHECK_BUDGET = 1 << 22;

// The work `urlHoldsUserinfo` does on `literals`: it renders the text three times plus once per
// `${VAR:-fallback}` reference, and reads it whole each time (finding 1265). Each unfilled Preset
// variable between literals costs about as much as a dozen characters in every rendering.
function userinfoWork(literals: readonly string[]): number {
  const text = literals.join("\0");
  let fallbacks = 0;
  for (const [, escaped, fallback] of text.matchAll(environmentReference)) {
    fallbacks += escaped === undefined && fallback !== undefined ? 1 : 0;
  }
  return (text.length + 12 * literals.length) * (3 + fallbacks);
}

/** Create the URL credential checks for one validation of one document. */
export function createUrlCredentialChecks(
  unresolved: (path: SettingPath) => readonly string[] | undefined,
  refuse: (path: SettingPath, reason: (path: string) => string) => never,
) {
  // The work the userinfo checks have done on this document: each URL field and environment value
  // is charged before it is checked, and one past the budget is refused as too costly to check.
  let spent = 0;
  // Each URL `value` may hold, from its scheme to the end of its authority, where `\0` marks an
  // unfilled Preset variable; `undefined` when checking them would exceed the budget. URL parsers
  // (WHATWG's, Python's) drop tabs and newlines, and read userinfo after a special scheme with one
  // slash or none (`https:u:pw@host`). A candidate is a colon with two slashes after it, or one
  // after a scheme that ends in `http(s)`, `ws(s)` or `ftp` or holds a variable or `${VAR}`
  // reference (each also between the colon and the slashes), with no space after it. References
  // are read as the runtime reads them (`environmentReference`; `$${VAR}` is literal text). A
  // candidate inside the authority of one already returned is part of it, unless it sits in a
  // reference whose fallback could end that authority. A backslash does not end an authority here:
  // WHATWG parsers read it as a slash after a special scheme, but Python and curl read it as part
  // of the userinfo, so each URL is also checked with it percent-encoded.
  function environmentUrls(value: string): string[] | undefined {
    const text = value.replaceAll(/[\t\n\r]/g, "");
    // Each reference, by its start and by its end; `inside` marks the start of the one at each
    // index, and `count` how many start before it.
    const after = new Map<number, number>();
    const before = new Map<number, number>();
    const inside = new Int32Array(text.length + 1).fill(-1);
    const count = new Int32Array(text.length + 2);
    for (const { index, 0: reference, 1: escaped } of text.matchAll(environmentReference)) {
      if (escaped === undefined) {
        after.set(index, index + reference.length);
        before.set(index + reference.length, index);
        inside.fill(index, index + 1, index + reference.length);
        count[index + 1] = 1;
      }
    }
    for (let index = 1; index < count.length; index += 1) {
      count[index] = (count[index] ?? 0) + (count[index - 1] ?? 0);
    }
    let work = spent + text.length;
    const skip = (from: number): [number, number] => {
      let index = from;
      let slashes = 0;
      for (;;) {
        const end = after.get(index);
        if (end !== undefined) {
          index = end;
        } else if (text[index] === "\0") {
          index += 1;
        } else if (text[index] === "/" || text[index] === "\\") {
          index += 1;
          slashes += 1;
        } else {
          return [index, slashes];
        }
      }
    };
    // Whether a reference's text holds a character in `ends`, read once per reference and pattern.
    const endsIn = new Map<string, boolean>();
    const holdsEnd = (reference: number, ends: RegExp): boolean => {
      const key = `${ends.source}${reference}`;
      const known = endsIn.get(key);
      if (known !== undefined) {
        return known;
      }
      const found = ends.test(text.slice(reference, after.get(reference)));
      endsIn.set(key, found);
      return found;
    };
    const spans: [number, number][] = [];
    let covered = { from: 0, to: 0, ends: /["/?#]/ };
    for (const { index: colon } of text.matchAll(/:/g)) {
      let start = colon;
      for (;;) {
        const reference = before.get(start);
        if (reference !== undefined) {
          start = reference;
        } else if (start > 0 && /[\w+.\-\0]/.test(text[start - 1] ?? "")) {
          start -= 1;
        } else {
          break;
        }
      }
      const scheme = text.slice(start, colon);
      const variable = /\0/.test(scheme) || count[colon] !== count[start];
      const special = /(?:^|[^A-Za-z0-9+.])(?:https?|wss?|ftp)$/i.test(scheme);
      const [authority, slashes] = skip(colon + 1);
      work += authority - start;
      if (slashes < 2 && (!(variable || special) || text[colon + 1] === " ")) {
        continue;
      }
      const reference = inside[colon] ?? -1;
      if (
        colon >= covered.from &&
        authority < covered.to &&
        (reference === -1 || !holdsEnd(reference, covered.ends))
      ) {
        continue;
      }
      // A double quote ends a URL inside JSON text. A `file` URL, checked only as written (it sends
      // no credentials, and Windows paths fill it with backslashes), also ends at a backslash.
      const ends = /^file$/i.test(scheme) ? /["/?#\\]/ : /["/?#]/;
      let end = authority;
      while (end < text.length) {
        const skipped = after.get(end);
        if (skipped !== undefined) {
          end = skipped;
        } else if (ends.test(text[end] ?? "")) {
          break;
        } else {
          end += 1;
        }
      }
      end = Math.min(end + 1, text.length);
      // Each of the two checks renders every fallback in the URL, so its cost grows with each
      // reference.
      work += 2 * (end - start) * (3 + (count[end] ?? 0) - (count[start] ?? 0));
      if (work > URL_CHECK_BUDGET) {
        return undefined;
      }
      covered = { from: authority, to: end - 1, ends };
      spans.push([start, end]);
    }
    spent = work;
    return spans.map(([start, end]) => text.slice(start, end));
  }
  // The refusal names the field, never its value. A Preset save passes `unresolved`, the text
  // around each unfilled variable at that path.
  const refuseUrlUserinfo = (path: SettingPath, value: unknown, schemeless = false): void => {
    if (typeof value !== "string") {
      return;
    }
    const [head = "", ...tail] = unresolved(path) ?? [value];
    const withScheme =
      schemeless && !SCHEME_WITH_DOUBLE_SLASH.test(head) ? [`http://${head}`, ...tail] : undefined;
    spent += userinfoWork([head, ...tail]) + (withScheme ? userinfoWork(withScheme) : 0);
    if (spent > URL_CHECK_BUDGET) {
      refuse(path, urlCostMessage);
    }
    if (
      urlHoldsUserinfo(value, [head, ...tail]) ||
      (withScheme !== undefined && urlHoldsUserinfo(value, withScheme))
    ) {
      refuse(path, urlCredentialMessage);
    }
    // baseUrl keeps the model-provider message. These fields stored the rewritten host.
    if (path.at(-1) !== "baseUrl") {
      const written = head.replaceAll(/[\t\n\r]/g, "");
      // `https:{{ vars.endpoint }}` and `https:/{{ vars.rest }}` are not finished URLs: the
      // variable can supply `//host` or `/host`. The filled Configuration is checked again.
      // A literal `https:///` already has an empty authority.
      const schemeAwaitingVariable = tail.length > 0 && /^[\0- ]*https?:[/\\]?$/i.test(written);
      if (
        !schemeAwaitingVariable &&
        (/^[\0- ]*https?:[/\\]{3,}/i.test(written) || /^[\0- ]*https?:(?![/\\]{2})/i.test(written))
      ) {
        refuse(path, urlAuthorityMessage);
      }
    }
  };
  // A proxy URL in part of an environment value, `text`, where `\0` stands for each unfilled
  // variable, read without a scheme as http.
  const refuseProxyUserinfo = (path: SettingPath, value: string, text: string): void => {
    const literals = (SCHEME_WITH_DOUBLE_SLASH.test(text) ? text : `http://${text}`).split("\0");
    spent += userinfoWork(literals);
    if (spent > URL_CHECK_BUDGET) {
      refuse(path, urlCostMessage);
    }
    if (urlHoldsUserinfo(value, literals)) {
      refuse(path, urlCredentialMessage);
    }
  };
  // Every URL an environment value holds is checked, whatever the variable's name (finding
  // 1262): pip, npm, git and Go send the userinfo in `PIP_INDEX_URL`, `npm_config_registry`,
  // `GIT_CONFIG_VALUE_0` or `GOPROXY` as Basic auth, and a list such as `GOPROXY` holds several.
  // A proxy variable is also read from its start, without a scheme as http.
  const refuseEnvironmentUserinfo = (path: SettingPath, value: unknown, proxy: boolean): void => {
    if (typeof value !== "string") {
      return;
    }
    // `\0` stands for each unfilled variable: a process environment cannot hold one. A proxy
    // without a scheme is read as http.
    const text = (unresolved(path) ?? [value]).join("\0");
    const urls = environmentUrls(
      proxy && !SCHEME_WITH_DOUBLE_SLASH.test(text) ? `http://${text}` : text,
    );
    if (urls === undefined) {
      refuse(path, urlCostMessage);
    }
    if (proxy) {
      refuseUrlUserinfo(path, value, true);
    }
    for (const url of urls) {
      if (
        urlHoldsUserinfo(value, url.split("\0")) ||
        (!/^file:/i.test(url) && urlHoldsUserinfo(value, url.replaceAll("\\", "%5C").split("\0")))
      ) {
        refuse(path, urlCredentialMessage);
      }
    }
  };

  return { refuseUrlUserinfo, refuseEnvironmentUserinfo, refuseProxyUserinfo };
}
