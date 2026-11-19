#!/usr/bin/env python3
"""Derive the OCE image pins in deploy/konflux/oce-runtime/build-args.conf.

The Konflux images build from this repository, and most of their pins follow
from it: the OpenClaw source selected by deploy/runtime/openclaw-source.json,
the Codex, matrix-sdk-crypto and gh releases selected by
deploy/runtime/Dockerfile, and the pnpm releases selected by package.json here
and by OpenClaw's package.json at the selected commit.

deploy/docker/Dockerfile.konflux.oce-runtime ports deploy/runtime/Dockerfile by
hand to the Hummingbird base images, so OCE_REVIEWED_COMMIT records the commit
whose Dockerfile it was last ported from. A change that goes beyond the pins
(new stages, new or renamed bridge patches) leaves OCE_REVIEWED_COMMIT behind,
and --check fails with the diff until someone ports the change and runs
--ported runtime. deploy/docker/Dockerfile.konflux.oce-controller ports the
root Dockerfile the same way, with its own OCE_REVIEWED_COMMIT in
deploy/konflux/oce-controller/build-args.conf. Stages the ports do not carry
(the Node.js compile, the controller's development stage) are left out of
that comparison. The runtime review also covers
deploy/runtime/additional-download-clients.json, which selects the developer
toolchains the runtime image installs.

OCE_PORT_SHA256 records the port itself when --ported last ran, so a port
cannot be acknowledged without an edit, and --check fails when the port
changes without --ported.

Run from the repository root with full git history (the review baseline is
read with git show). After an upstream sync:

    python3 deploy/konflux/oce_pins.py                       # update derived pins
    python3 deploy/konflux/oce_pins.py --check               # exit 1 if stale or unported
    python3 deploy/konflux/oce_pins.py --ported runtime      # after porting deploy/runtime/Dockerfile
    python3 deploy/konflux/oce_pins.py --ported controller   # after porting the root Dockerfile
"""

import difflib
import hashlib
import json
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

CONF = Path("deploy/konflux/oce-runtime/build-args.conf")
CONTAINERFILE = Path("deploy/docker/Dockerfile.konflux.oce-runtime")
OPENCLAW_REPOSITORY = "openclaw/openclaw"
RUNTIME_DOCKERFILE = "deploy/runtime/Dockerfile"
SOURCE_MANIFEST = "deploy/runtime/openclaw-source.json"
# The selection of developer toolchains for the runtime image. The port builds
# whatever it selects, so a change needs the same review as the Dockerfile.
DOWNLOAD_CLIENTS = "deploy/runtime/additional-download-clients.json"
CONTROLLER_CONF = Path("deploy/konflux/oce-controller/build-args.conf")
CONTROLLER_CONTAINERFILE = Path("deploy/docker/Dockerfile.konflux.oce-controller")
CONTROLLER_DOCKERFILE = "Dockerfile"
# Each image's conf and port, and the upstream recipe it ports.
IMAGES = {"runtime": (CONF, CONTAINERFILE), "controller": (CONTROLLER_CONF, CONTROLLER_CONTAINERFILE)}
UPSTREAM_RECIPES = {"runtime": (RUNTIME_DOCKERFILE, DOWNLOAD_CLIENTS), "controller": (CONTROLLER_DOCKERFILE,)}
# Pins the controller shares with the runtime.
SHARED_PINS = ("PNPM_OCE_VERSION", "PNPM_OCE_SHA512")
# The controller port uses Hummingbird instead of the Debian base that upstream
# bumps. Mask the release within the Node major and the digest, so a new major,
# suite or image still shows up.
CONTROLLER_BASE_PIN = re.compile(
    r"^(ARG NODE_RUNTIME_BASE_IMAGE=\S+:\d+)\.\d+\.\d+(\S*)@sha256:[0-9a-f]{64}$", re.MULTILINE
)
# Upstream stages the ports do not carry, so changes inside them need no port.
# The runtime keeps Hummingbird's Node.js instead of compiling the patched one,
# and the controller port has no development stage.
RUNTIME_SKIPPED_STAGES = {"node-source", "node-compiled"}
CONTROLLER_SKIPPED_STAGES = {"development"}
STAGE = re.compile(r"^FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+(\S+))?\s*$", re.IGNORECASE)
# The Hummingbird base references both ports pin, and the digests masked when
# fingerprinting a port.
BASE_IMAGE_ARGS = re.compile(r"^ARG (BASE_IMAGE|BUILDER_IMAGE)=(\S+)$", re.MULTILINE)
DIGEST = re.compile(r"@sha256:[0-9a-f]{64}")

# Values the Dockerfile pins inline: (conf key, pattern). Every match of a
# pattern must agree, and these values are masked when comparing Dockerfiles.
DOCKERFILE_PINS = [
    ("OPENAI_CODEX_VERSION", r"^ENV OPENAI_CODEX_VERSION=(\S+)$"),
    ("MATRIX_SDK_CRYPTO_VERSION", r"matrix-rust-sdk-crypto-nodejs/releases/download/v([0-9.]+)/"),
    ("MATRIX_SDK_CRYPTO_SHA256_AMD64", r"library=matrix-sdk-crypto\.linux-x64-gnu\.node; sha256=([0-9a-f]{64})"),
    ("MATRIX_SDK_CRYPTO_SHA256_ARM64", r"library=matrix-sdk-crypto\.linux-arm64-gnu\.node; sha256=([0-9a-f]{64})"),
    ("GH_VERSION", r"cli/cli/releases/download/v([0-9.]+)/"),
    ("GH_CHECKSUMS_SHA256", r"'([0-9a-f]{64})  gh_[0-9.]+_checksums\.txt'"),
]
# The OpenClaw source pins the manifest carries: (conf key, manifest field, shape).
# scripts/lib/openclaw-source.ts validates the same shape at build time.
MANIFEST_PINS = [
    ("OPENCLAW_COMMIT", "commit", r"[0-9a-f]{40}"),
    ("OPENCLAW_SOURCE_SHA256", "sourceArchiveSha256", r"[0-9a-f]{64}"),
    ("OPENCLAW_BUILD_TIMESTAMP", "buildTimestamp", r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"),
]
# Bridge patches and their checksums. The images apply the bridge patches from
# the build context, which already pins their content, so only the patch list
# is ported. Checksums of patches from anywhere else stay significant.
BRIDGE_PATCH = re.compile(r"deploy/runtime/([\w.-]+\.patch)")
PATCH_CHECKSUM = re.compile(r"'[0-9a-f]{64}(  /tmp/([\w.-]+\.patch))'")
# Parser directives look like comments but change how the Dockerfile is read.
DIRECTIVE = re.compile(r"^#[ \t]*(check|escape|syntax)[ \t]*=", re.IGNORECASE)
# Heredoc bodies are command input, not Dockerfile lines: comments and
# whitespace inside them are content, so they stay significant. A marker can
# quote its delimiter and put punctuation in it (<<-'EOF-SCRIPT'), share its
# line with a destination (COPY <<EOF /dest) or with further markers; a
# marker inside a larger word (a<<b, <<<x) is content, not an opener.
HEREDOC = re.compile(r"(?<![^\s\d])<<-?\s*(['\"]?)([^<\s'\"]+)\1(?![\"'])")
# The runtime image reads the bridge test selection from deploy/runtime/Dockerfile
# at build time (deploy/konflux/oce-bridge-tests.mjs): the test files of the first
# scripts/test-projects.mts call in the first RUN that makes one in the
# openclaw-bridge-tests stage, and its --ci-graphs-json list. Changing either
# needs no port, so both are masked.
BRIDGE_TESTS_STAGE = re.compile(r"FROM\s.*\sAS\s+openclaw-bridge-tests", re.IGNORECASE)
TEST_FILE = re.compile(r"[\w./-]+\.test\.tsx?")
CI_GRAPHS = re.compile(r"--ci-graphs-json '\[[^']*\]'")


class RecipeError(Exception):
    """The runtime recipe no longer matches what this script understands."""


def fetch(url, attempts=4):
    """Return the body of a URL, retrying transient failures."""
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=120) as resp:
                return resp.read()
        except OSError as error:
            if attempt == attempts:
                raise
            print(f"  retrying {url}: {error}")
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def sha256_of_url(url):
    print(f"  fetching {url}")
    return hashlib.sha256(fetch(url)).hexdigest()


def raw_file(repository, commit, path):
    return fetch(f"https://raw.githubusercontent.com/{repository}/{commit}/{path}").decode()


def git(*args):
    try:
        return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or error
        raise RecipeError(f"git {' '.join(args)} failed (a shallow clone lacks the review baseline): {detail}") from error


def repo_file(ref, path):
    """Return a file from the working tree, or as committed at ref."""
    return Path(path).read_text() if ref is None else git("show", f"{ref}:{path}")


def repo_file_or_empty(ref, path):
    """Return a file like repo_file, or "" when ref predates it."""
    if ref is not None and not git("ls-tree", "--name-only", ref, "--", path).strip():
        return ""
    return repo_file(ref, path)


def last_change(*paths):
    """Return the latest commit that changed any of paths, the baseline a port records."""
    commit = git("log", "-1", "--format=%H", "--", *paths).strip()
    if not commit:
        raise RecipeError(f"no commit changes {', '.join(paths)}")
    return commit


def get_value(content, key):
    m = re.search(rf"^{re.escape(key)}=(.+)$", content, re.MULTILINE)
    return m.group(1).strip() if m else None


def require(content, key):
    value = get_value(content, key)
    if value is None:
        raise RecipeError(f"{key} is missing from a build-args.conf")
    return value


def set_value(content, key, value):
    require(content, key)
    return re.sub(rf"^{re.escape(key)}=.+$", f"{key}={value}", content, flags=re.MULTILINE)


def dockerfile_pins(dockerfile):
    """Extract the inline pins from an OCE runtime Dockerfile."""
    pins = {}
    for key, pattern in DOCKERFILE_PINS:
        values = set(re.findall(pattern, dockerfile, re.MULTILINE))
        if len(values) != 1:
            raise RecipeError(
                f"{RUNTIME_DOCKERFILE}: expected one value for {key}, found {sorted(values)}; "
                f"the recipe changed, port it to {CONTAINERFILE} by hand"
            )
        pins[key] = values.pop()
    return pins


def manifest_pins(manifest_text):
    """Extract the OpenClaw source pins from deploy/runtime/openclaw-source.json."""
    try:
        manifest = json.loads(manifest_text)
    except json.JSONDecodeError as error:
        raise RecipeError(f"{SOURCE_MANIFEST}: invalid JSON: {error}") from error
    expected = {field for _, field, _ in MANIFEST_PINS}
    if not isinstance(manifest, dict) or set(manifest) != expected:
        found = sorted(manifest) if isinstance(manifest, dict) else manifest
        raise RecipeError(
            f"{SOURCE_MANIFEST}: expected keys {sorted(expected)}, found {found}; "
            f"the recipe changed, port it to {CONTAINERFILE} by hand"
        )
    pins = {}
    for key, field, shape in MANIFEST_PINS:
        value = manifest[field]
        if not isinstance(value, str) or not re.fullmatch(shape, value):
            raise RecipeError(f"{SOURCE_MANIFEST}: invalid {field}: {value!r}")
        pins[key] = value
    # The shape above allows impossible dates; scripts/lib/openclaw-source.mjs rejects them.
    try:
        datetime.strptime(pins["OPENCLAW_BUILD_TIMESTAMP"], "%Y-%m-%dT%H:%M:%S%z")
    except ValueError as error:
        raise RecipeError(
            f"{SOURCE_MANIFEST}: invalid buildTimestamp: {pins['OPENCLAW_BUILD_TIMESTAMP']!r}"
        ) from error
    return pins


def heredoc_delimiters(line):
    """Return the heredoc delimiters a line opens, in order. A marker inside
    a quoted string is content: the builder's lexer only opens heredocs
    outside quotes, so such markers are skipped."""
    quoted = []
    quote = None
    escaped = False
    for char in line:
        if escaped:
            escaped = False
        elif char == "\\" and quote != "'":
            escaped = True
        elif quote:
            if char == quote:
                quote = None
        elif char in "'\"":
            quote = char
        quoted.append(quote is not None)
    return [m.group(2) for m in HEREDOC.finditer(line) if not quoted[m.start()]]


def continues(line):
    """Whether a line ends in a continuation the builder joins to the next."""
    return line.endswith("\\") and not line.endswith("\\\\")


def build_lines(dockerfile):
    """Drop what the builder cannot see: comment lines (removed before the
    instructions run), blank lines and trailing whitespace. Heredoc bodies are
    command input rather than Dockerfile lines, so their lines stay verbatim;
    an unrecognized terminator only leaves more lines significant. Directives
    only count in the leading comment block (the builder ignores them after
    any plain comment, blank line or instruction) and may be indented. Markers
    are read off the joined instruction, since the builder joins continued
    lines before its lexer runs."""
    kept = []
    delimiters = []
    directives = True
    pending = None
    for raw in dockerfile.splitlines():
        if delimiters:
            kept.append(raw + "\n")
            if raw == delimiters[0]:
                delimiters.pop(0)
            continue
        line = raw.rstrip()
        if pending is not None:
            if line and not line.lstrip().startswith("#"):
                pending.append(line[:-1] if continues(line) else line)
                kept.append(line + "\n")
                if not continues(line):
                    delimiters = heredoc_delimiters("".join(pending))
                    pending = None
            continue
        if not line or line.lstrip().startswith("#"):
            if directives and DIRECTIVE.match(line.lstrip()):
                kept.append(line + "\n")
            else:
                directives = False
            continue
        directives = False
        kept.append(line + "\n")
        if continues(line):
            pending = [line[:-1]]
        else:
            delimiters = heredoc_delimiters(line)
    return "".join(kept)


def carried_stages(lines, skipped_stages):
    """Drop the named stages from build_lines output."""
    kept = []
    skipped = False
    for line in lines.splitlines(keepends=True):
        stage = STAGE.match(line)
        if stage:
            skipped = (stage.group(1) or "").lower() in skipped_stages
        if not skipped:
            kept.append(line)
    return "".join(kept)


def ends_call(word):
    """Whether a word ends the first test-projects call: a shell control
    token, or another call. deploy/konflux/oce-bridge-tests.mjs uses the same rule."""
    return word in ("&&", "||", ";", "|", "scripts/test-projects.mts") or word.endswith(";")


def mask_bridge_tests(lines):
    """Mask the bridge test selection in build_lines output, read the way
    deploy/konflux/oce-bridge-tests.mjs reads it."""
    kept = []
    instruction = []
    in_stage = False
    tests_masked = False
    for line in lines.splitlines(keepends=True):
        instruction.append(line)
        if continues(line.rstrip("\n")):
            continue
        text = "".join(instruction)
        instruction = []
        words = text.replace("\\\n", " ").split()
        if words and words[0].upper() == "FROM":
            in_stage = BRIDGE_TESTS_STAGE.fullmatch(" ".join(words)) is not None
        elif in_stage:
            text = CI_GRAPHS.sub("--ci-graphs-json '<CI_GRAPHS>'", text)
            if not tests_masked and words and words[0].upper() == "RUN" and "scripts/test-projects.mts" in words:
                tests_masked = True
                # Only the first call's files: later calls chained in the same RUN are ported.
                start = words.index("scripts/test-projects.mts") + 1
                end = next((n for n in range(start, len(words)) if ends_call(words[n])), len(words))
                call = [word for word in words[start:end] if not TEST_FILE.fullmatch(word)]
                text = " ".join([*words[:start], "<BRIDGE_TESTS>", *call, *words[end:]]) + "\n"
        kept.append(text)
    return "".join(kept) + "".join(instruction)


def masked(dockerfile):
    """Return the Dockerfile with pin values masked and cosmetic changes dropped."""
    pins = dockerfile_pins(dockerfile)
    bridge_patches = set(BRIDGE_PATCH.findall(dockerfile))
    # Mask the bridge patch checksums first: a pin value can appear in a patch name.
    dockerfile = PATCH_CHECKSUM.sub(
        lambda m: f"'<PATCH_SHA256>{m.group(1)}'" if m.group(2) in bridge_patches else m.group(0), dockerfile
    )
    for key, value in pins.items():
        dockerfile = dockerfile.replace(value, f"<{key}>")
    return mask_bridge_tests(carried_stages(build_lines(dockerfile), RUNTIME_SKIPPED_STAGES))


def package_manager(package_json):
    """Return (version, sha512) from a corepack packageManager field."""
    field = json.loads(package_json).get("packageManager", "")
    m = re.fullmatch(r"pnpm@([0-9][^+]*)\+sha512\.([0-9a-f]{128})", field)
    if not m:
        raise RecipeError(f"unexpected packageManager field: {field!r}")
    return m.group(1), m.group(2)


def derive(content):
    """Return every pin that follows from the working tree."""
    dockerfile = repo_file(None, RUNTIME_DOCKERFILE)
    pins = manifest_pins(repo_file(None, SOURCE_MANIFEST))
    pins.update(dockerfile_pins(dockerfile))

    # Check the gh release here so a checksums file that does not match the
    # recipe's pin, or lists no Linux archive, fails the cheap pins job instead
    # of the image build.
    gh = pins["GH_VERSION"]
    checksums = fetch(f"https://github.com/cli/cli/releases/download/v{gh}/gh_{gh}_checksums.txt")
    if hashlib.sha256(checksums).hexdigest() != pins["GH_CHECKSUMS_SHA256"]:
        raise RecipeError(f"gh {gh} checksums file does not match the recipe's pin")
    for arch in ("amd64", "arm64"):
        if not re.search(rf"^([0-9a-f]{{64}})  gh_{re.escape(gh)}_linux_{arch}\.tar\.gz$", checksums.decode(), re.MULTILINE):
            raise RecipeError(f"gh {gh} checksums list no linux_{arch} archive")

    pins["PNPM_OCE_VERSION"], pins["PNPM_OCE_SHA512"] = package_manager(repo_file(None, "package.json"))
    version, sha512 = package_manager(raw_file(OPENCLAW_REPOSITORY, pins["OPENCLAW_COMMIT"], "package.json"))
    pins["PNPM_OPENCLAW_VERSION"], pins["PNPM_OPENCLAW_SHA512"] = version, sha512
    # The native pnpm binaries have no corepack hash, and no upstream file
    # selects tini, so checksum the artifacts the build downloads.
    for arch, exe_arch in (("AMD64", "x64"), ("ARM64", "arm64")):
        pins[f"PNPM_OPENCLAW_EXE_SHA256_{arch}"] = sha256_of_url(
            f"https://registry.npmjs.org/@pnpm/exe.linux-{exe_arch}/-/exe.linux-{exe_arch}-{version}.tgz"
        )
    tini = require(content, "TINI_VERSION")
    pins["TINI_SOURCE_SHA256"] = sha256_of_url(f"https://github.com/krallin/tini/archive/refs/tags/v{tini}.tar.gz")
    return dockerfile, pins


def recipe_drift(content, dockerfile):
    """Return the reasons the Konflux port is behind deploy/runtime/Dockerfile."""
    problems = []
    upstream_patches = list(dict.fromkeys(BRIDGE_PATCH.findall(dockerfile)))
    ported_patches = list(dict.fromkeys(re.findall(r"/tmp/oce(?:-runtime)?/([\w.-]+\.patch)", CONTAINERFILE.read_text())))
    if upstream_patches != ported_patches:
        problems.append(f"bridge patches differ\n  upstream: {upstream_patches}\n  {CONTAINERFILE}: {ported_patches}")

    reviewed = require(content, "OCE_REVIEWED_COMMIT")
    before = masked(repo_file(reviewed, RUNTIME_DOCKERFILE))
    after = masked(dockerfile)
    if before != after:
        problems.append(
            f"{RUNTIME_DOCKERFILE} changed beyond its pins since OCE_REVIEWED_COMMIT; port it to "
            f"{CONTAINERFILE} and run --ported runtime\n"
            f"{dockerfile_diff(before, after, RUNTIME_DOCKERFILE, reviewed)}"
        )
    before, after = (repo_file_or_empty(ref, DOWNLOAD_CLIENTS) for ref in (reviewed, None))
    if before != after:
        problems.append(
            f"{DOWNLOAD_CLIENTS} changed since OCE_REVIEWED_COMMIT; review the developer toolchains "
            f"{CONTAINERFILE} now installs and run --ported runtime\n"
            f"{dockerfile_diff(before, after, DOWNLOAD_CLIENTS, reviewed)}"
        )
    return problems


def dockerfile_diff(before, after, path, reviewed):
    diff = difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        f"{path}@{reviewed[:7]}",
        path,
    )
    return "".join(diff)


def controller_recipe(ref):
    dockerfile = CONTROLLER_BASE_PIN.sub(r"\1.<MINOR>.<PATCH>\2@<DIGEST>", repo_file(ref, CONTROLLER_DOCKERFILE))
    return carried_stages(build_lines(dockerfile), CONTROLLER_SKIPPED_STAGES)


def controller_drift(content):
    """Return the reason the controller port is behind the root Dockerfile."""
    reviewed = require(content, "OCE_REVIEWED_COMMIT")
    before, after = (controller_recipe(ref) for ref in (reviewed, None))
    if before == after:
        return []
    diff = dockerfile_diff(before, after, CONTROLLER_DOCKERFILE, reviewed)
    message = (
        f"{CONTROLLER_DOCKERFILE} changed since {CONTROLLER_CONF} OCE_REVIEWED_COMMIT; port it to "
        f"{CONTROLLER_CONTAINERFILE} and run --ported controller\n{diff}"
    )
    return [message]


def port_digest(port):
    """Fingerprint a port's build lines, ignoring base digest bumps and comments."""
    return hashlib.sha256(build_lines(DIGEST.sub("@sha256:<DIGEST>", port.read_text())).encode()).hexdigest()


def port_problems():
    """Return the reasons the ports disagree with their recorded state."""
    problems = []
    bases = [dict(BASE_IMAGE_ARGS.findall(port.read_text())) for port in (CONTAINERFILE, CONTROLLER_CONTAINERFILE)]
    if bases[0] != bases[1] or set(bases[0]) != {"BASE_IMAGE", "BUILDER_IMAGE"}:
        problems.append(f"{CONTAINERFILE} and {CONTROLLER_CONTAINERFILE} must pin the same base images: {bases}")
    for image, (conf, port) in IMAGES.items():
        if require(conf.read_text(), "OCE_PORT_SHA256") != port_digest(port):
            problems.append(f"{port} changed without --ported; review it against its upstream recipe, then run --ported {image}")
    return problems


def sync_controller(runtime_content):
    """Rewrite the controller's shared pins to match the runtime's."""
    content = CONTROLLER_CONF.read_text()
    for key in SHARED_PINS:
        value = require(runtime_content, key)
        if get_value(content, key) != value:
            print(f"  {CONTROLLER_CONF}: {key} {get_value(content, key)} -> {value}")
            content = set_value(content, key, value)
    if not controller_drift(content):
        content = set_value(content, "OCE_REVIEWED_COMMIT", last_change(CONTROLLER_DOCKERFILE))
    else:
        print(f"  {CONTROLLER_DOCKERFILE} needs a manual port; run with --check for details")
    CONTROLLER_CONF.write_text(content)


def update():
    """Rewrite the derived pins from the working tree."""
    content = CONF.read_text()
    dockerfile, pins = derive(content)
    for key, value in pins.items():
        if get_value(content, key) != value:
            print(f"  {key} {get_value(content, key)} -> {value}")
            content = set_value(content, key, value)
    if not recipe_drift(content, dockerfile):
        content = set_value(content, "OCE_REVIEWED_COMMIT", last_change(*UPSTREAM_RECIPES["runtime"]))
    else:
        print(f"  {RUNTIME_DOCKERFILE} needs a manual port; run with --check for details")
    CONF.write_text(content)
    sync_controller(content)


def ported(image):
    """Record that a port is done: move OCE_REVIEWED_COMMIT to the latest change
    of its upstream recipe, and OCE_PORT_SHA256 to the port as it is now."""
    conf, port = IMAGES[image]
    content = conf.read_text()
    digest = port_digest(port)
    if require(content, "OCE_PORT_SHA256") == digest:
        raise RecipeError(
            f"{port} is unchanged since the last --ported; port the upstream change first. If it needs "
            f"no port, set OCE_REVIEWED_COMMIT in {conf} by hand and say why in the pull request"
        )
    commit = last_change(*UPSTREAM_RECIPES[image])
    content = set_value(content, "OCE_REVIEWED_COMMIT", commit)
    conf.write_text(set_value(content, "OCE_PORT_SHA256", digest))
    print(f"{conf}: OCE_REVIEWED_COMMIT={commit} OCE_PORT_SHA256={digest}")


def check():
    """Return True when every derived pin is current and the port is up to date."""
    content = CONF.read_text()
    dockerfile, pins = derive(content)
    ok = True
    for key, value in pins.items():
        if get_value(content, key) != value:
            print(f"ERROR: {key}={get_value(content, key)}, expected {value}")
            ok = False
    controller = CONTROLLER_CONF.read_text()
    for key in SHARED_PINS:
        if get_value(controller, key) != require(content, key):
            print(f"ERROR: {CONTROLLER_CONF}: {key}={get_value(controller, key)}, expected {require(content, key)}")
            ok = False
    for problem in recipe_drift(content, dockerfile) + controller_drift(controller) + port_problems():
        print(f"ERROR: {problem}")
        ok = False
    return ok


def main():
    try:
        if "--check" in sys.argv:
            if not check():
                sys.exit(1)
            print(f"{CONF} and {CONTROLLER_CONF}: pins match the build context")
        elif "--ported" in sys.argv:
            index = sys.argv.index("--ported") + 1
            if index == len(sys.argv) or sys.argv[index] not in ("runtime", "controller"):
                sys.exit("usage: oce_pins.py --ported runtime|controller")
            ported(sys.argv[index])
        else:
            update()
    except (RecipeError, OSError) as error:
        print(f"ERROR: {error}")
        sys.exit(1)


if __name__ == "__main__":
    main()
