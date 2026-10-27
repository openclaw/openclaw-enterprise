// The closed vocabulary of runtime failure evidence and runtime diagnostic checks: the one
// list the runtime entrypoints publish from (the Kubernetes runtime scripts get it injected
// when they are rendered) and OCC records and reads back. A provider-owned Harness serves this
// evidence from inside its Sandbox, where Agent code can answer in its place, so OCC records a
// value outside it as UNRECOGNIZED rather than as served (findings 1660, 1673, 1674).

/** What OCC records, and returns, in place of a value outside this vocabulary. */
export const UNRECOGNIZED_RUNTIME_VALUE = "UNRECOGNIZED";

/** The runtime containers Compute names as a check's component. */
export const RUNTIME_COMPONENTS = Object.freeze(["agent", "gateway"]);

/** Codes a runtime entrypoint holds a startup failure with, or reports on a diagnostic check. */
export const RUNTIME_DIAGNOSTIC_CODES = Object.freeze([
  "LOGIN_FAILED",
  "MODEL_PROBE_FAILED",
  "MODEL_PROBE_TIMEOUT",
  "MODEL_PROBE_CPU_STARVED",
  "UNAVAILABLE",
  "NOT_CONFIGURED",
  "AUTHENTICATION_FAILED",
  "DISCONNECTED",
  "INCOMPATIBLE_RESPONSE",
  "PROBE_FAILED",
  // Compute's own evidence: the revision's prepared Git route is closed for good (finding 2136).
  "REPOSITORY_ROUTE_BLOCKED",
]);

/** The startup steps a runtime entrypoint holds a failure under. */
export const RUNTIME_FAILURE_CHECKS = Object.freeze([
  "gateway-tool-policy",
  "login",
  "model-probe",
  "peer-bridge-record",
  "plugin-approvers",
  "state-migration",
  // A protected execution's Harness could not enroll with its egress proxy (finding 2054).
  "egress-enrollment",
  // The worker's prepared Git route for an OpenShell Sandbox is blocked (finding 2136).
  "repository-git-route",
]);

/**
 * The evidence Kubernetes Compute builds itself, from Pod status, for a failed
 * initialize-workspace init container (finding 1675). The kubelet restarts a failed init
 * container, so a failure it can retry is WORKSPACE_SETUP_FAILED, and a refusal no retry can
 * change (the setup runner's exit status 2) is WORKSPACE_SETUP_REFUSED (finding 1677).
 */
export const WORKSPACE_SETUP_CHECK = "workspace-setup";
export const WORKSPACE_SETUP_FAILED = "WORKSPACE_SETUP_FAILED";
export const WORKSPACE_SETUP_REFUSED = "WORKSPACE_SETUP_REFUSED";

/**
 * The checks a runtime diagnostics read reports besides a held startup failure: the Gateway's
 * Slack channel checks, and Compute's own check for a runtime status it could not read. OCC's
 * own Sandbox check is not here: OCC adds it after it masks what Compute returned.
 */
export const RUNTIME_DIAGNOSTIC_CHECKS = Object.freeze([
  "configuration",
  "authentication",
  "connectivity",
  "runtime-status",
]);

/** The signals a `PROCESS_EXIT` cause may name, as `signal-<name>` (Linux, as Node names them). */
export const PROCESS_EXIT_SIGNALS = Object.freeze([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGIOT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGCHLD",
  "SIGSTKFLT",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGPOLL",
  "SIGPWR",
  "SIGSYS",
]);

/**
 * The system error codes a `PROCESS_EXIT` cause may name, as `error-<code>`: the Linux errno
 * names and libuv's own error names, as Node reports them.
 */
export const PROCESS_EXIT_ERROR_CODES = Object.freeze([
  "E2BIG",
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EAGAIN",
  "EALREADY",
  "EBADF",
  "EBADMSG",
  "EBUSY",
  "ECANCELED",
  "ECHARSET",
  "ECHILD",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDEADLK",
  "EDESTADDRREQ",
  "EDOM",
  "EDQUOT",
  "EEXIST",
  "EFAULT",
  "EFBIG",
  "EFTYPE",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "EIDRM",
  "EILSEQ",
  "EINPROGRESS",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISCONN",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "EMLINK",
  "EMSGSIZE",
  "EMULTIHOP",
  "ENAMETOOLONG",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENFILE",
  "ENOBUFS",
  "ENODATA",
  "ENODEV",
  "ENOENT",
  "ENOEXEC",
  "ENOLCK",
  "ENOLINK",
  "ENOMEM",
  "ENOMSG",
  "ENONET",
  "ENOPROTOOPT",
  "ENOSPC",
  "ENOSR",
  "ENOSTR",
  "ENOSYS",
  "ENOTCONN",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTSOCK",
  "ENOTSUP",
  "ENOTTY",
  "ENXIO",
  "EOF",
  "EOPNOTSUPP",
  "EOVERFLOW",
  "EPERM",
  "EPIPE",
  "EPROTO",
  "EPROTONOSUPPORT",
  "EPROTOTYPE",
  "ERANGE",
  "EREMOTEIO",
  "EROFS",
  "ESHUTDOWN",
  "ESOCKTNOSUPPORT",
  "ESPIPE",
  "ESRCH",
  "ESTALE",
  "ETIME",
  "ETIMEDOUT",
  "ETXTBSY",
  "EUNATCH",
  "EWOULDBLOCK",
  "EXDEV",
]);

/** The highest process exit status a `PROCESS_EXIT` cause may name, as `exit-<status>`. */
export const PROCESS_EXIT_MAX_STATUS = 255;

/**
 * The classes of a failed Codex login's or startup model check's error output (finding 2017):
 * its stderr and, for the model check, the messages of its `error` and `turn.failed` events
 * (finding 2043), whichever names the more specific class:
 * `network` (DNS, connect, reset or a transport timeout), `tls`, `http_401_403`, `http_5xx`,
 * `http_other` (another 4xx), `timeout` (the wrapper's own process timeout, when the output
 * names none of those), `empty` and `unknown`. The runtime wrapper logs only the class,
 * never the output.
 */
export const CODEX_FAILURE_OUTPUT_CLASSES = Object.freeze([
  "network",
  "tls",
  "http_401_403",
  "http_5xx",
  "http_other",
  "timeout",
  "empty",
  "unknown",
]);
