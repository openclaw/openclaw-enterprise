import { QualificationFailure, type FailureClass } from "./failure.ts";

export interface Reply {
  status: number;
  data?: unknown;
  location?: string | undefined;
  sessionCookieIssued: boolean;
  sessionCookieClasses: ("host" | "secure")[];
}
export function requireHostSessionCookie(reply: Reply): void {
  if (
    !reply.sessionCookieIssued ||
    reply.sessionCookieClasses.length !== 1 ||
    reply.sessionCookieClasses[0] !== "host"
  ) {
    throw new Error("External callback must issue only a Host-prefixed session cookie");
  }
}

export interface Browser {
  request(method: string, path: string, body?: unknown): Promise<Reply>;
  pinSession(key: string): void;
  freeze(): Browser;
}

const sessionCookies = new Set([
  "__Host-openclaw_occ.session_token",
  "__Secure-openclaw_occ.session_token",
]);
type Cookie = { value: string; path: string };
// A deliberately narrow host-only Console client. Native fetch retains TLS verification
// and uses the process's approved CONNECT routing; this code changes no destinations.
export function createBrowser(baseURL: string): Browser {
  const origin = new URL(baseURL);
  let stopped = false;
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("HTTPS Console origin required");
  }
  function client(
    initial = new Map<string, Cookie>(),
    frozen = false,
    initialKey?: string,
  ): Browser {
    let pinnedKey = initialKey;
    const jar = new Map(initial);
    return {
      freeze: () => client(jar, true, pinnedKey),
      pinSession(key: string) {
        if (frozen || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
          throw new Error("Invalid session pin");
        }
        pinnedKey = key;
      },
      async request(method: string, path: string, body?: unknown): Promise<Reply> {
        if (stopped) {
          throw new Error("Browser admission stopped");
        }
        let failureClass: FailureClass = "assertion";
        let httpStatus: number | undefined;
        const deadline = AbortSignal.timeout(15_000);
        try {
          const url = new URL(path, origin);
          if (!path.startsWith("/") || path.startsWith("//") || url.origin !== origin.origin) {
            throw new Error("Foreign Console request refused");
          }
          const headers: Record<string, string> = {
            origin: origin.origin,
            accept: "application/json",
          };
          if (pinnedKey) {
            headers["x-occ-session-key"] = pinnedKey;
          }
          const cookies = [...jar].filter(([, c]) => url.pathname.startsWith(c.path));
          if (cookies.length) {
            headers.cookie = cookies.map(([n, c]) => `${n}=${c.value}`).join("; ");
          }
          if (body !== undefined) {
            headers["content-type"] = "application/json";
          }
          failureClass = "unknown-reply";
          const response = await fetch(url, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: "manual",
            signal: deadline,
          });
          httpStatus = response.status;
          failureClass = "malformed-response";
          let issued = false;
          const observed = new Set<"host" | "secure">();
          for (const line of response.headers.getSetCookie()) {
            const [pair, ...attributes] = line.split(";");
            const split = pair!.indexOf("=");
            if (split < 1) {
              throw new Error("Malformed cookie");
            }
            const name = pair!.slice(0, split).trim();
            const value = pair!.slice(split + 1);
            const attrs = new Map(
              attributes.map((a) => {
                const i = a.indexOf("=");
                return i < 0
                  ? [a.trim().toLowerCase(), ""]
                  : [a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim()];
              }),
            );
            if (attrs.has("domain") || !attrs.has("secure")) {
              throw new Error("Non-host-only secure cookie refused");
            }
            const cookiePath = attrs.get("path") ?? "/";
            const deleted =
              !value ||
              (attrs.has("max-age") && Number(attrs.get("max-age")) <= 0) ||
              (attrs.has("expires") && Date.parse(attrs.get("expires")!) <= Date.now());
            if (sessionCookies.has(name) && !deleted) {
              if (cookiePath !== "/" || !attrs.has("httponly")) {
                throw new Error("Invalid session-cookie attributes");
              }
              issued = true;
              observed.add(name.startsWith("__Host-") ? "host" : "secure");
            }
            if (!frozen) {
              if (deleted) {
                jar.delete(name);
              } else {
                jar.set(name, { value, path: cookiePath });
              }
            }
          }
          const bytes: Uint8Array[] = [];
          let length = 0;
          failureClass = "unknown-reply";
          if (response.body) {
            for await (const chunk of response.body) {
              length += chunk.length;
              if (length > 1024 * 1024) {
                failureClass = "malformed-response";
                throw new Error("Oversized Console response");
              }
              bytes.push(chunk);
            }
          }
          failureClass = "malformed-response";
          const text = Buffer.concat(bytes).toString("utf8");
          const parsed =
            text && response.headers.get("content-type")?.includes("application/json")
              ? JSON.parse(text)
              : undefined;
          if (response.status >= 200 && response.status < 300 && response.status !== 204) {
            if (
              !parsed ||
              typeof parsed !== "object" ||
              !("data" in parsed) ||
              "error" in parsed ||
              typeof parsed.meta?.requestId !== "string"
            ) {
              throw new Error("Invalid successful Console envelope");
            }
          } else if (response.status >= 400) {
            if (
              !parsed ||
              typeof parsed.error?.code !== "string" ||
              typeof parsed.error?.message !== "string" ||
              typeof parsed.meta?.requestId !== "string"
            ) {
              throw new Error("Invalid Console rejection envelope");
            }
          } else if (response.status === 204 && text !== "") {
            throw new Error("Unexpected no-content response body");
          }
          return {
            status: response.status,
            data: parsed?.data,
            location: response.headers.get("location") ?? undefined,
            sessionCookieIssued: issued,
            sessionCookieClasses: [...observed].sort(),
          };
        } catch {
          stopped = true;
          throw new QualificationFailure(
            deadline.aborted ? "timeout" : failureClass,
            httpStatus === undefined ? {} : { httpStatus },
          );
        }
      },
    };
  }
  return client();
}
