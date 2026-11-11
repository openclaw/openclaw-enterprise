import { environmentReferenceNames } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

// How OpenClaw applies a Configuration's own environment before it substitutes `${NAME}`
// references (`applyConfigEnvVars` in src/config/config-env-vars.ts, which takes its entries
// from `collectConfigRuntimeEnvVars` and `isConfigRuntimeEnvVarAllowed` in
// src/config/config-env-values.ts), at the commit below. The lists are
// src/infra/host-env-security-policy.json there, copied whole: OpenClaw drops a Configuration
// variable they block, so a name this module took as set while OpenClaw drops it would pass
// admission and stop the Gateway at every start (finding 3059). When the commit in
// deploy/runtime/openclaw-source.json changes, compare those files and src/infra/env.ts and
// src/infra/host-env-security.ts between the two commits, update this module, then the commit
// below; a conformance test fails until then.
export const OPENCLAW_CONFIG_ENVIRONMENT_COMMIT = "513c12703ad9a9161cc123e0b8ed4ecb811aa6b3";

// `normalizeEnvVarKey(key, { portable: true })` in src/infra/host-env-security.ts.
const PORTABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// isConfigRuntimeEnvVarAllowed's own names: deployment-owned startup, write and host execution
// policy.
const CONFIG_BLOCKED_KEYS: readonly string[] = [
  "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
  "OPENCLAW_INCLUDE_ROOTS",
  "OPENCLAW_CONFIG_READONLY",
  "OPENCLAW_CONFIG_READONLY_NOTICE",
  "OPENCLAW_DISABLE_GATEWAY_LOCAL_TERMINALS",
  "OPENCLAW_DISABLE_CRON_HOST_EXECUTION",
  "OPENCLAW_DEV_RELOAD_BUNDLED_PLUGINS",
];
// isDangerousHostEnvOverrideVarName's pattern beside the policy's lists.
const CARGO_TARGET_EXECUTABLE = /^CARGO_TARGET_[A-Z0-9_]+_(?:LINKER|RUNNER)$/;
// normalizeZaiEnv in src/infra/env.ts: a set Z_AI_API_KEY also sets ZAI_API_KEY.
const NORMALIZED_ALIASES: Readonly<Record<string, string>> = { Z_AI_API_KEY: "ZAI_API_KEY" };

const BLOCKED_EVERYWHERE_KEYS: readonly string[] = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REDIRECT_WARNINGS",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_REPL_HISTORY",
  "NODE_V8_COVERAGE",
  "PYTHONHOME",
  "PYTHONPATH",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYLIB",
  "RUBYOPT",
  "BASHOPTS",
  "BASH_ENV",
  "ENV",
  "KSH_ENV",
  "BROWSER",
  "GIT_ALLOW_PROTOCOL",
  "GIT_EDITOR",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_EXEC_PATH",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PROTOCOL_FROM_USER",
  "GIT_SEQUENCE_EDITOR",
  "GIT_TEMPLATE_DIR",
  "GIT_SSL_NO_VERIFY",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "CC",
  "CPP",
  "CXX",
  "CXXCPP",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTDOC",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTDOC",
  "CMAKE_C_COMPILER",
  "CMAKE_CXX_COMPILER",
  "SHELL",
  "SHELLOPTS",
  "PS4",
  "GCONV_PATH",
  "IFS",
  "SSLKEYLOGFILE",
  "JAVA_OPTS",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "PYTHONBREAKPOINT",
  "DOTNET_STARTUP_HOOKS",
  "DOTNET_ADDITIONAL_DEPS",
  "FPATH",
  "GLIBC_TUNABLES",
  "MAVEN_OPTS",
  "MAKE",
  "MAKEFLAGS",
  "MFLAGS",
  "SBT_OPTS",
  "GRADLE_OPTS",
  "ANT_OPTS",
  "HGRCPATH",
  "HGEDITOR",
  "HGMERGE",
  "EXINIT",
  "VIMINIT",
  "MYVIMRC",
  "GVIMINIT",
  "LUA_INIT",
  "LUA_INIT_5_1",
  "LUA_INIT_5_2",
  "LUA_INIT_5_3",
  "LUA_INIT_5_4",
  "EMACSLOADPATH",
  "RUBYSHELL",
  "GIT_HOOK_PATH",
  "SVN_EDITOR",
  "SVN_SSH",
  "BZR_EDITOR",
  "BZR_SSH",
  "BZR_PLUGIN_PATH",
  "SUDO_ASKPASS",
  "JULIA_EDITOR",
  "CONFIG_SITE",
  "CONFIG_SHELL",
  "CMAKE_TOOLCHAIN_FILE",
  "CATALINA_OPTS",
  "CORECLR_PROFILER",
  "HELM_PLUGINS",
  "PACKER_PLUGIN_PATH",
  "VAGRANT_VAGRANTFILE",
  "ERL_AFLAGS",
  "ERL_FLAGS",
  "ERL_ZFLAGS",
  "ELIXIR_ERL_OPTIONS",
  "R_ENVIRON",
  "R_PROFILE",
  "R_ENVIRON_USER",
  "R_PROFILE_USER",
  "TCLLIBPATH",
  "HOSTALIASES",
];

const BLOCKED_OVERRIDE_ONLY_KEYS: readonly string[] = [
  "HOME",
  "GRADLE_USER_HOME",
  "ZDOTDIR",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_PROXY_COMMAND",
  "GIT_ASKPASS",
  "GIT_SSL_NO_VERIFY",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "SSH_ASKPASS",
  "LESSOPEN",
  "LESSCLOSE",
  "PAGER",
  "MANPAGER",
  "GIT_PAGER",
  "EDITOR",
  "VISUAL",
  "FCEDIT",
  "SUDO_EDITOR",
  "PROMPT_COMMAND",
  "HISTFILE",
  "PERL5DB",
  "PERL5DBCMD",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "PYTHONSTARTUP",
  "WGETRC",
  "CURL_HOME",
  "CLASSPATH",
  "CFLAGS",
  "CGO_CFLAGS",
  "CGO_LDFLAGS",
  "GOFLAGS",
  "MAKEFLAGS",
  "MFLAGS",
  "CORECLR_PROFILER_PATH",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "DENO_DIR",
  "BUN_CONFIG_REGISTRY",
  "YARN_RC_FILENAME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "PIP_INDEX_URL",
  "PIP_PYPI_URL",
  "PIP_EXTRA_INDEX_URL",
  "PIP_CONFIG_FILE",
  "PIP_FIND_LINKS",
  "PIP_TRUSTED_HOST",
  "UV_INDEX",
  "UV_INDEX_URL",
  "UV_PYTHON",
  "UV_EXTRA_INDEX_URL",
  "UV_DEFAULT_INDEX",
  "DOCKER_CONTEXT",
  "LIBRARY_PATH",
  "LDFLAGS",
  "CPATH",
  "C_INCLUDE_PATH",
  "CPLUS_INCLUDE_PATH",
  "OBJC_INCLUDE_PATH",
  "GOPROXY",
  "GONOSUMCHECK",
  "GONOSUMDB",
  "GONOPROXY",
  "GOPRIVATE",
  "GOENV",
  "GOPATH",
  "HGRCPATH",
  "PYTHONUSERBASE",
  "RUSTC_WRAPPER",
  "RUSTFLAGS",
  "RUSTUP_DIST_ROOT",
  "RUSTUP_DIST_SERVER",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "RUSTUP_UPDATE_ROOT",
  "CARGO_HOME",
  "VIRTUAL_ENV",
  "LUA_PATH",
  "LUA_CPATH",
  "GEM_HOME",
  "GEM_PATH",
  "BUNDLE_GEMFILE",
  "COMPOSER_HOME",
  "CONDA_DEFAULT_ENV",
  "CONDA_PREFIX",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_CONFIG_HOME",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "AWS_CONFIG_FILE",
  "KUBECONFIG",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_AUTH_LOCATION",
  "HELM_HOME",
  "ANSIBLE_CONFIG",
  "ANSIBLE_LIBRARY",
  "ANSIBLE_CALLBACK_PLUGINS",
  "ANSIBLE_COLLECTIONS_PATH",
  "ANSIBLE_CONNECTION_PLUGINS",
  "ANSIBLE_FILTER_PLUGINS",
  "ANSIBLE_INVENTORY_PLUGINS",
  "ANSIBLE_LOOKUP_PLUGINS",
  "ANSIBLE_MODULE_UTILS",
  "ANSIBLE_REMOTE_TEMP",
  "ANSIBLE_ROLES_PATH",
  "ANSIBLE_STRATEGY_PLUGINS",
  "R_LIBS_USER",
  "TF_CLI_CONFIG_FILE",
  "TF_PLUGIN_CACHE_DIR",
  "AMQP_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "DATABASE_URL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "MONGODB_URI",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "REDIS_URL",
  "SSH_AUTH_SOCK",
  "SYSTEMROOT",
  "WINDIR",
];

const BLOCKED_PREFIXES: readonly string[] = ["DYLD_", "LD_", "BASH_FUNC_"];

const BLOCKED_OVERRIDE_PREFIXES: readonly string[] = [
  "GIT_CONFIG_",
  "NPM_CONFIG_",
  "CARGO_REGISTRIES_",
  "TF_VAR_",
];

const BLOCKED_KEYS = new Set([
  ...BLOCKED_EVERYWHERE_KEYS,
  ...BLOCKED_OVERRIDE_ONLY_KEYS,
  ...CONFIG_BLOCKED_KEYS,
]);

function appliesConfigVariable(name: string, value: string): boolean {
  const upper = name.toUpperCase();
  return (
    value.trim() !== "" &&
    !BLOCKED_KEYS.has(upper) &&
    ![...BLOCKED_PREFIXES, ...BLOCKED_OVERRIDE_PREFIXES].some((prefix) =>
      upper.startsWith(prefix),
    ) &&
    !CARGO_TARGET_EXECUTABLE.test(upper) &&
    // containsEnvVarReference: OpenClaw never applies a value that holds a reference.
    environmentReferenceNames(value).length === 0
  );
}

/**
 * The variables OpenClaw sets from the Configuration's own `env`: each string under `env.vars`
 * and each other string key of `env` (not `shellEnv`), named as trimmed, that OpenClaw applies
 * (`appliesConfigVariable`). It sets them before it substitutes `${NAME}`, unless its environment
 * already has a value, which then sets the name anyway.
 */
export function openClawConfigEnvironmentNames(configuration: unknown): ReadonlySet<string> {
  const env = asRecord(asRecord(configuration)?.env);
  const names = new Set<string>();
  if (env === undefined) {
    return names;
  }
  for (const [rawName, value] of [
    ...Object.entries(asRecord(env.vars) ?? {}),
    ...Object.entries(env).filter(([key]) => key !== "shellEnv" && key !== "vars"),
  ]) {
    const name = rawName.trim();
    if (
      typeof value === "string" &&
      PORTABLE_NAME.test(name) &&
      appliesConfigVariable(name, value)
    ) {
      names.add(name);
    }
  }
  for (const [alias, name] of Object.entries(NORMALIZED_ALIASES)) {
    if (names.has(alias)) {
      names.add(name);
    }
  }
  return names;
}
