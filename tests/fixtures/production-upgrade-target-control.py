"""Exercise native target binding through the real adapter and kubeconfig decoder.

The request recorder normally stops before transport. Kuberc controls use loopback
listeners that close before TLS or API effects. Synthetic receipts acknowledge a
Secret without simulating a completed Kubernetes upgrade.
"""
import base64
import hashlib
import json
import os
import platform
import shutil
import signal
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

MAX_DECODER_BYTES = 128 * 1024 * 1024


def private_directory(directory):
    directory = directory.resolve(strict=True)
    caller = os.geteuid()
    owner = directory.stat()
    if not stat.S_ISDIR(owner.st_mode) or owner.st_uid != caller or stat.S_IMODE(owner.st_mode) != 0o700:
        raise ValueError("decoder staging directory must be private")
    root_owner = directory.parents[-1].stat().st_uid
    for ancestor in directory.parents:
        info = ancestor.stat()
        if info.st_uid not in (caller, root_owner) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise ValueError("decoder staging directory has an unsafe ancestor")
    return directory


def copy_decoder(directory, expected, maximum):
    destination = private_directory(directory) / "kubectl"
    # Copy at most the observed regular-file size. The worker's parent owns
    # its deadline, so slow resolution, open, read, and hash all share one bound.
    for directory in os.get_exec_path():
        candidate = shutil.which("kubectl", path=directory)
        if candidate is None:
            continue
        created = False
        try:
            candidate = Path(candidate).resolve(strict=True)
            flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
            with os.fdopen(os.open(candidate, flags), "rb") as source:
                info = os.fstat(source.fileno())
                if (
                    not stat.S_ISREG(info.st_mode)
                    or not info.st_mode & 0o111
                    or not 0 < info.st_size <= maximum
                ):
                    continue
                with destination.open("x+b") as output:
                    created = True
                    remaining = info.st_size
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        output.write(chunk)
                    if remaining or source.read(1):
                        continue
                    output.seek(0)
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: output.read(1024 * 1024), b""):
                        digest.update(chunk)
                    if digest.hexdigest() != expected:
                        continue
                    os.fchmod(output.fileno(), 0o500)
            created = False
            return
        except (OSError, RuntimeError):
            continue
        finally:
            if created:
                destination.unlink()
    sys.exit("requires the pinned native kubectl executable on PATH")


def setup_decoder(directory):
    architecture = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    pins = json.loads(Path("scripts/ci/kubectl-pins.json").read_text())
    expected = pins.get(sys.platform, {}).get(architecture)
    if expected is None:
        sys.exit("requires an official pinned kubectl for a supported Linux or macOS build")
    tools = ("bash", "git", "jq", "node", "yq")
    missing = [tool for tool in tools if not shutil.which(tool)]
    if missing:
        sys.exit("requires local tools: " + ", ".join(missing))
    copy_decoder(directory, expected, MAX_DECODER_BYTES)


if sys.argv[1] == "--setup-decoder":
    setup_decoder(Path(sys.argv[2]))
    sys.exit(0)
if sys.argv[1] == "--copy-decoder":
    copy_decoder(Path(sys.argv[2]), sys.argv[3], min(MAX_DECODER_BYTES, int(sys.argv[4])))
    sys.exit(0)


def run_command(command, *, environment=None, timeout=20):
    process = subprocess.Popen(
        command, env=environment, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            process.stdout.close()
            process.stderr.close()
            raise RuntimeError("fixture command group did not settle after SIGKILL") from None
        raise
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def stop_fixture(signum, _frame):
    # Let an in-flight command reap its isolated group before fixture teardown.
    raise SystemExit(128 + signum)


def stage_decoder(directory, expected=None, *, environment=None, maximum=MAX_DECODER_BYTES, timeout=20):
    worker = [sys.executable, str(Path(__file__).resolve())]
    if expected is None:
        worker += ["--setup-decoder", str(directory)]
    else:
        worker += ["--copy-decoder", str(directory), expected, str(maximum)]
    result = run_command(worker, environment=environment, timeout=timeout)
    if result.returncode != 0:
        sys.exit(result.stderr.strip() or "could not stage the pinned decoder")
    return str(directory / "kubectl")


def prove_setup_deadline(proof):
    # Stall the worker's real prerequisite discovery through a local shim.
    # The empty PATH prevents this control from finding or copying a real pin.
    with tempfile.TemporaryDirectory(prefix="setup-control-", dir=proof) as scratch:
        control = Path(scratch)
        (control / "sitecustomize.py").write_text(
            'import shutil, time\n'
            'real_which = shutil.which\n'
            'def slow_which(tool, *args, **options):\n'
            '    if tool == "bash":\n'
            '        print("reached fixture PATH probe", flush=True)\n'
            '        time.sleep(6)\n'
            '    return real_which(tool, *args, **options)\n'
            'shutil.which = slow_which\n'
        )
        destination = control / "staged"
        destination.mkdir(mode=0o700)
        try:
            stage_decoder(
                destination,
                environment={"PATH": str(control), "PYTHONPATH": str(control)},
                timeout=2,
            )
        except subprocess.TimeoutExpired as error:
            assert error.timeout == 2 and b"reached fixture PATH probe" in (error.output or b"")
            assert not (destination / "kubectl").exists()
        else:
            raise AssertionError("deliberately stalled prerequisite discovery did not time out")


def prove_copy_isolation(proof):
    # Exercise the same staging and execution paths with a disposable donor.
    # The genuine binary on PATH is reserved for the integration controls.
    with tempfile.TemporaryDirectory(prefix="decoder-control-", dir=proof) as scratch:
        control = Path(scratch)
        fifo, huge, donor, staged = (control / entry for entry in ("fifo", "huge", "donor", "staged"))
        for path in (fifo, huge, donor, staged):
            path.mkdir(mode=0o700)
        os.mkfifo(fifo / "kubectl", 0o700)
        with (huge / "kubectl").open("xb") as source:
            source.truncate(MAX_DECODER_BYTES + 1)
            os.fchmod(source.fileno(), 0o700)
        original = b"#!/bin/sh\nprintf 'verified copy\\n'\n"
        tool = donor / "kubectl"
        tool.write_bytes(original)
        tool.chmod(0o700)
        environment = {**os.environ, "PATH": os.pathsep.join(map(str, (fifo, huge, donor)))}
        decoder = stage_decoder(staged, hashlib.sha256(original).hexdigest(), environment=environment)
        replacement = donor / "replacement"
        replacement.write_bytes(b"#!/bin/sh\nexit 99\n")
        replacement.chmod(0o700)
        replacement.replace(tool)
        result = run_command([decoder])
        assert result.returncode == 0 and result.stdout == "verified copy\n"

        # A matching hash must not override the size gate. Use a smaller bound
        # so the causal check need not hash an artifact-sized synthetic file.
        (huge / "kubectl").write_bytes(original)
        size_control = control / "size-control"
        size_control.mkdir(mode=0o700)
        try:
            stage_decoder(
                size_control, hashlib.sha256(original).hexdigest(),
                environment={**os.environ, "PATH": str(huge)}, maximum=len(original) - 1,
            )
        except SystemExit as error:
            assert str(error) == "requires the pinned native kubectl executable on PATH"
            assert not (size_control / "kubectl").exists()
        else:
            raise AssertionError("matching but oversized decoder was accepted")


proof = private_directory(Path(sys.argv[1]))
root = Path.cwd()
for number in (signal.SIGHUP, signal.SIGTERM):
    signal.signal(number, stop_fixture)

# The nested child holds the inherited stdout pipe. A leader-only kill would
# leave the pipe open beyond the cleanup timeout instead of settling the case.
probe = (
    "import subprocess, sys; "
    "subprocess.Popen([sys.executable, '-c', "
    "'import time; print(42, flush=True); time.sleep(6)']).wait()"
)
try:
    run_command([sys.executable, "-c", probe], timeout=1)
except subprocess.TimeoutExpired as error:
    assert error.timeout == 1 and b"42" in (error.output or b""), "timeout did not settle its child group"
else:
    raise AssertionError("deliberately blocked fixture failed to time out")

prove_setup_deadline(proof)
prove_copy_isolation(proof)
decoder_directory = tempfile.TemporaryDirectory(prefix="decoder-", dir=proof)
kubectl = stage_decoder(Path(decoder_directory.name))

adapter_cmd = ["python3", "scripts/upgrade-production"]
native_cmd = ["bash", "scripts/upgrade-production-images"]

binaries = proof / "bin"
binaries.mkdir(mode=0o700, exist_ok=True)
shim = binaries / "kubectl"
shim.write_text("""#!/usr/bin/env python3
import base64,json,os,pathlib,subprocess,sys
from pathlib import Path
args = sys.argv[1:]
if "CONTROL_CASE" not in os.environ:
    # The real profile decoder receives a reduced environment. Keep its
    # actual stdin and named context decoding without relying on test variables.
    decoder = next(Path(sys.argv[0]).resolve().parent.parent.glob("decoder-*/kubectl"))
    os.execv(decoder, [str(decoder), *args])
case = Path(os.environ["CONTROL_CASE"])
tool = Path(sys.argv[0]).name
decoder = os.environ["CONTROL_KUBECTL"]
path = Path(args[args.index("--kubeconfig") + 1])
record = {"tool": tool, "path": str(path)}
def swap_ca():
    ca = case/"material/server.pem"
    replacement = ca.with_name("replace.pem")
    replacement.write_bytes(b"replacement authority for fixture")
    replacement.replace(ca)

def install_late_policy():
    late = case / "late-kuberc"
    if late.exists():
        target = case / ".kube/kuberc"
        target.parent.mkdir(mode=0o700, exist_ok=True)
        target.write_bytes(late.read_bytes())

if (tool == "kubectl" and args[:1] == ["--kubeconfig"]
        and args[2:] == ["config", "view", "--merge=false", "--raw", "-o", "json"]):
    record["operation"] = "decode"
    install_late_policy()
    mutation = os.environ.get("CHANGE_BEFORE_PIN")
    if mutation == "swap":
        swap_ca()
    elif mutation == "delete":
        (case / "material/server.pem").unlink()
    with (case/"events.jsonl").open("a") as out:
        out.write(json.dumps(record)+"\\n")
    os.execv(decoder,[decoder,*args])
if "get" in args and "--raw=/readyz" in args:
    record["operation"] = "ready"
elif tool == "helm" and args[:2] == ["status","oce"]:
    record["operation"] = "helm-status"
elif "delete" in args and any(a.startswith("--raw=") for a in args):
    record["operation"] = "delete"
    delete_options = sys.stdin.read()
    record["uid"] = json.loads(delete_options)["preconditions"]["uid"]
else:
    record["operation"] = "other"
if (case / "loopback-client-control").exists() and record["operation"] in ("ready", "delete"):
    install_late_policy()
    # Use the genuine client, actual command, and workflow environment. The
    # listeners record a connection and close it before TLS or any API effect.
    request = subprocess.run([decoder, *args],
        input=delete_options if record["operation"] == "delete" else "",
        text=True, capture_output=True, timeout=6)
    record["request_failed"] = request.returncode != 0
if os.environ.get("SWAP_AT_BOUNDARY") == "yes":
    swap_ca()
# Decode the same source and flatten relative references locally using real
# client-go compatibility. Permit no non-config subcommand or network call.
view = subprocess.run(
    [decoder,"--kubeconfig",str(path),"--context","fixture","config","view",
     "--minify","--flatten","--raw","-o","json"],
    capture_output=True,text=True,
)
record["decoder_status"] = view.returncode
if view.returncode == 0:
    cluster = json.loads(view.stdout)["clusters"][0]["cluster"]
    authority = base64.b64decode(cluster.get("certificate-authority-data",""))
    record["approved_ca"] = authority == b"approved authority for fixture"
    record["replacement_ca"] = authority == b"replacement authority for fixture"
with (case/"events.jsonl").open("a") as out:
    out.write(json.dumps(record)+"\\n")
sys.exit(42)
""")
shim.chmod(0o700)
helm = binaries / "helm"
if not helm.exists():
    helm.symlink_to(shim)
revision = run_command(["git", "rev-parse", "HEAD"])
revision.check_returncode()
source = revision.stdout.strip()
authority = b"approved authority for fixture"
replacement = b"replacement authority for fixture"
full_image = "registry.example/fixture@sha256:" + "a" * 64

def put(path, data):
    path = Path(path)
    path.touch(mode=0o600)
    path.write_bytes(data)

def fixture(mode, image="runtime"):
    case = Path(tempfile.mkdtemp(prefix=mode+"-", dir=proof))
    (case/"operator").mkdir(mode=0o700)
    (case/"material").mkdir(mode=0o700)
    for label, data in [
        ("server.pem", authority), ("client.pem", b"client certificate stub"),
        ("client.key", b"client key stub"), ("token", b"rotating token stub"),
    ]:
        put(case/"material"/label, data)
    cluster = {"server": "https://fixture.invalid:65535"}
    if mode == "external":
        cluster["certificate-authority"] = "../material/server.pem"
    if mode == "inline":
        cluster["certificate-authority-data"] = base64.b64encode(authority).decode()
    original = case/"operator/kubeconfig"
    put(original, json.dumps({
        "apiVersion":"v1", "kind":"Config", "current-context":"different",
        "clusters":[{"name":"reviewed","cluster":cluster},{"name":"unselected","cluster":{"server":"https://unselected.invalid:65535"}}],
        "contexts":[{"name":"fixture","context":{"cluster":"reviewed","user":"credential"}},{"name":"different","context":{"cluster":"unselected","user":"credential"}}],
        "users":[{"name":"credential","user":{"client-certificate":"../material/client.pem","client-key":"../material/client.key","tokenFile":"../material/token"}}],
    }).encode())
    for label in ("values.yaml", "installation.yaml", "service-key.json"):
        put(case/label, b"{}\n")
    profile = {
        "kubeconfig": str(original), "context": "fixture", "namespace": "occ",
        "release": "oce", "installationDirectory": str(case), "sourceRevision": source,
        "images": {image: full_image}, "occ": "/bin/false",
    }
    put(case/"profile.json", json.dumps(profile).encode())
    return case

def run(case, command, *, swap=False, change_before_pin=""):
    events = case/"events.jsonl"
    events.unlink(missing_ok=True)
    environment = {
        "PATH": f"{binaries}{os.pathsep}{os.environ['PATH']}",
        "LANG": "C.UTF-8", "OCC_URL":"https://127.0.0.1:9",
        "OCC_SERVICE_KEY_FILE":str(case/"service-key.json"),
        "CONTROL_CASE": str(case), "CONTROL_KUBECTL": kubectl,
        "SWAP_AT_BOUNDARY": "yes" if swap else "no",
        "CHANGE_BEFORE_PIN": change_before_pin,
        "HOME": str(case), "KUBECTL_KUBERC": "true",
    }
    preferences = case / "kuberc-environment.json"
    if preferences.exists():
        environment.update(json.loads(preferences.read_text()))
    result = run_command(command, environment=environment)
    assert authority.decode() not in result.stdout+result.stderr
    assert replacement.decode() not in result.stdout+result.stderr
    actual = [json.loads(line) for line in events.read_text().splitlines()] if events.exists() else []
    return result, actual

def profiled(case, operation, *, swap=False, change_before_pin=""):
    args = ["--profile",str(case/"profile.json"),"--evidence-dir",str(case/"evidence")]
    if operation == "apply":
        args += ["--auto-approve"]
    return run(case,[*adapter_cmd,operation,*args,"--","--timeout-seconds","1"],
               swap=swap,change_before_pin=change_before_pin)

def raw(case, operation):
    arguments = [
        "--kubeconfig",str(case/"operator/kubeconfig"),"--context","fixture","--namespace","occ",
        "--release","oce","--evidence-dir",str(case/"evidence"),
    ]
    if operation in ("resume","preflight-only"):
        arguments += ["--values",str(case/"values.yaml"),"--installation",str(case/"installation.yaml"),
                      "--source-revision",source,"--runtime-image",full_image,"--occ","/bin/false",
                      "--timeout-seconds","1","--"+operation]
    else:
        arguments += ["--cleanup-preflight","--previous-process-settled","--evidence-unrestored"]
    return run(case,[*native_cmd,*arguments])

def profile_cleanup(case):
    return run(case,[*adapter_cmd,"cleanup-preflight","--profile",str(case/"profile.json"),
                     "--evidence-dir",str(case/"evidence"),"--",
                     "--previous-process-settled","--evidence-unrestored"])

def last_request(events):
    return [e for e in events if e["operation"] != "decode"]

def first_boundary(case, operation, expected, **kwargs):
    result, events = profiled(case,operation,**kwargs)
    requests = last_request(events)
    assert result.returncode == 42 and [e["operation"] for e in requests] == [expected], (result.stderr,events)
    assert requests[0]["decoder_status"] == 0, requests
    return requests[0]

# The mutable file is swapped at the first request boundary. Real kubectl
# must flatten the actual client input to the CA captured before that request.
for operation, image, expected in (
    ("preflight", "runtime", "ready"),
    ("migration-check", "controller", "helm-status"),
):
    case = fixture("external", image)
    request = first_boundary(case, operation, expected, swap=True)
    assert request["path"] != str(case / "operator/kubeconfig"), request
    assert request["approved_ca"] and not request["replacement_ca"], request
    assert json.loads((case / "evidence/parameters.json").read_text())["profiled"] is True
    for mutation in ("swap", "delete"):
        # The local decoder runs after the adapter has admitted the profile but
        # before the native script pins its copy of the approved external CA.
        case = fixture("external", image)
        result, events = profiled(case, operation, change_before_pin=mutation)
        assert result.returncode == 1, result.stderr
        assert "external server CA changed after approval" in result.stderr, result.stderr
        if mutation == "delete":
            assert "file is missing" in result.stderr, result.stderr
        assert [entry["operation"] for entry in events] == ["decode"], events

for mode in ("inline", "system", "external"):
    case = fixture(mode)
    first_boundary(case, "apply", "ready")
    result, events = raw(case, "resume")
    # A real profile receipt must pin the original target even if there is no
    # external CA. The fixture stops before writing the prepared marker.
    assert result.returncode == 1 and "evidence is not a prepared deployment" in result.stderr, result.stderr
    assert [entry["operation"] for entry in events] == ["decode"], events
    if mode == "inline":
        # Keep the real journal and its bound parameters checksum intact. A
        # rewrite of only the origin must never select the unpinned raw path.
        parameters = case / "evidence/parameters.json"
        original = json.loads(parameters.read_text())
        assert original["profiled"] is True
        put(parameters, json.dumps({**original, "profiled": False}).encode())
        result, events = raw(case, "resume")
        assert result.returncode == 1, result.stderr
        assert "resume evidence directory or private parameters changed" in result.stderr, result.stderr
        assert not events, events
    if mode == "system":
        # Model an older receipt with a valid journal but no recorded origin.
        evidence = case / "evidence"
        parameters = evidence / "parameters.json"
        original = json.loads(parameters.read_text())
        del original["profiled"]
        put(parameters, json.dumps(original).encode())
        (evidence / "preflight-journal.json").unlink()
        run_command(
            ["python3", "scripts/upgrade-preflight-state.py", "init", str(evidence)]
        ).check_returncode()
        result, events = raw(case, "resume")
        assert result.returncode != 0 and "no verifiable target origin" in result.stderr, result.stderr
        assert not events, events
    if mode == "external":
        put(case / "material/server.pem", replacement)
        result, events = raw(case, "resume")
        assert result.returncode == 1 and "external server CA changed" in result.stderr, result.stderr
        assert not last_request(events), events


def record_secret(case):
    evidence = case / "evidence"
    state = root / "scripts/upgrade-preflight-state.py"
    for command in (
        ["register", str(evidence), ".", "a1b2c3d4", "false"],
        ["started", str(evidence), ".", "secret"],
    ):
        run_command(["python3", str(state), *command]).check_returncode()
    plan = json.loads((evidence / "preflight-plan.json").read_text())
    put(evidence / "preflight-secret-identity.json", json.dumps({
        **plan["slots"]["secret"], "uid": "fixture-secret-uid",
    }).encode())


# A bound Secret UID alone must not authorize delete after a target change.
case = fixture("external")
first_boundary(case, "apply", "ready")
record_secret(case)
put(case / "material/server.pem", replacement)
result, events = raw(case, "cleanup")
assert result.returncode != 0 and "CA" in result.stderr, result.stderr
assert not last_request(events), events

for owner in ("profile", "raw"):
    case = fixture("external")
    if owner == "profile":
        first_boundary(case, "apply", "ready")
    else:
        result, events = raw(case, "preflight-only")
        assert result.returncode == 42 and [entry["operation"] for entry in events] == ["decode", "ready"], (result.stderr, events)
        assert json.loads((case / "evidence/parameters.json").read_text())["profiled"] is False
        assert events[-1]["path"] != str(case / "operator/kubeconfig")
    record_secret(case)
    result, events = raw(case, "cleanup")
    deletes = [entry for entry in events if entry["operation"] == "delete"]
    assert len(deletes) == 1 and deletes[0]["uid"] == "fixture-secret-uid", (result.stderr, events)
    assert deletes[0]["path"] != str(case / "operator/kubeconfig"), deletes
    assert deletes[0]["decoder_status"] == 0 and deletes[0]["approved_ca"], deletes
    if owner == "raw":
        result, events = profile_cleanup(case)
        deletes = [entry for entry in events if entry["operation"] == "delete"]
        assert len(deletes) == 1 and deletes[0]["uid"] == "fixture-secret-uid", (result.stderr, events)
        assert deletes[0]["path"] != str(case / "operator/kubeconfig"), deletes
        assert deletes[0]["decoder_status"] == 0 and deletes[0]["approved_ca"], deletes


# Verify actual kubectl transport selection for a fresh profiled request and
# the native recovery of its recorded Secret. The synthetic endpoints refuse
# every connection so even a regression cannot perform a Kubernetes operation.
targets = []


class ConnectRecorder(socketserver.BaseRequestHandler):
    def handle(self):
        targets.append(self.server.server_address[1])


with socketserver.TCPServer(("127.0.0.1", 0), ConnectRecorder) as approved, \
     socketserver.TCPServer(("127.0.0.1", 0), ConnectRecorder) as alternate:
    approved_port = approved.server_address[1]
    alternate_port = alternate.server_address[1]
    for listener in (approved, alternate):
        threading.Thread(target=listener.serve_forever, daemon=True).start()
    try:
        case = fixture("system")
        config = case / "operator/kubeconfig"
        selected = json.loads(config.read_bytes())
        selected["clusters"][0]["cluster"]["server"] = f"https://127.0.0.1:{approved_port}"
        selected["users"][0]["user"] = {"token": "synthetic-loopback-token"}
        put(config, json.dumps(selected).encode())
        (case / ".kube").mkdir(mode=0o700)
        options = [{"name": "server", "default": f"https://127.0.0.1:{alternate_port}"}]
        put(case / ".kube/kuberc", json.dumps({
            "apiVersion": "kubectl.config.k8s.io/v1beta1", "kind": "Preference",
            "defaults": [{"command": action, "options": options} for action in ("get", "delete")],
        }).encode())
        put(case / "loopback-client-control", b"")

        # Same named context, direct genuine client and enabled preferences:
        # the private kuberc is effective without the upgrade's protection.
        control = run_command([kubectl, "--kubeconfig", str(config), "--context", "fixture",
                               "get", "--raw=/readyz", "--request-timeout=1s"],
                              environment={"PATH": os.environ["PATH"], "HOME": str(case), "KUBECTL_KUBERC": "true"})
        assert control.returncode != 0 and set(targets) == {alternate_port}, (control.stderr, targets)
        targets.clear()

        result, events = profiled(case, "apply")
        assert result.returncode == 2 and "Active kubectl preferences" in result.stderr, result.stderr
        assert not targets and not events and not (case / "evidence").exists()
        result, events = raw(case, "preflight-only")
        assert result.returncode == 2 and "Active kubectl preferences" in result.stderr, result.stderr
        assert not targets and not events and not (case / "evidence").exists()

        # Hold the same refusal when the preferences come from a custom path, even
        # if their only action is to alter a replace into a forced or dry run.
        custom = case / "custom-preferences"
        (case / ".kube/kuberc").rename(custom)
        put(custom, json.dumps({
            "apiVersion": "kubectl.config.k8s.io/v1beta1", "kind": "Preference",
            "defaults": [{"command": "replace", "options": [
                {"name": "force", "default": "true"}, {"name": "dry-run", "default": "client"},
            ]}],
        }).encode())
        preference_env = case / "kuberc-environment.json"
        put(preference_env, json.dumps({"KUBERC": str(custom)}).encode())
        result, events = profiled(case, "apply")
        assert result.returncode == 2 and "Active kubectl preferences" in result.stderr, result.stderr
        assert str(custom) not in result.stderr and not targets and not events and not (case / "evidence").exists()

        # Configured credential policy is a refusal, never stripped to enable
        # an exec plugin. The synthetic plugin leaves a file if it starts.
        plugin = case / "exec-credential"
        marker = case / "plugin-started"
        put(plugin, f"#!/bin/sh\ntouch '{marker}'\nexit 75\n".encode())
        plugin.chmod(0o700)
        selected["users"][0]["user"] = {"exec": {
            "apiVersion": "client.authentication.k8s.io/v1", "command": str(plugin), "interactiveMode": "Never",
        }}
        put(config, json.dumps(selected).encode())
        for policy in ("DenyAll", "Allowlist"):
            put(custom, json.dumps({
                "apiVersion": "kubectl.config.k8s.io/v1beta1", "kind": "Preference",
                "credentialPluginPolicy": policy,
                **({"credentialPluginAllowlist": [{"name": "/bin/false"}]} if policy == "Allowlist" else {}),
            }).encode())
            denied = run_command([kubectl, "--kubeconfig", str(config), "--context", "fixture",
                                  "get", "--raw=/readyz", "--request-timeout=1s"],
                                 environment={"PATH": os.environ["PATH"], "HOME": str(case), "KUBERC": str(custom)})
            message = "not allowed" if policy == "DenyAll" else "not permitted by the credential plugin allowlist"
            assert denied.returncode != 0 and message in denied.stderr and not marker.exists(), denied.stderr
            result, events = profiled(case, "apply")
            assert result.returncode == 2 and "Active kubectl preferences" in result.stderr, result.stderr
            assert not marker.exists() and not events and not (case / "evidence").exists()

        # Install policy synchronously after the native preference check. The
        # request wrapper also installs it on the old raw path, which did not
        # decode the original kubeconfig before invoking the genuine client.
        for policy in ("DenyAll", "Allowlist"):
            policy_document = {
                "apiVersion": "kubectl.config.k8s.io/v1beta1", "kind": "Preference",
                "credentialPluginPolicy": policy,
                **({"credentialPluginAllowlist": [{"name": "/bin/false"}]} if policy == "Allowlist" else {}),
            }
            for owner in ("profile", "raw"):
                fresh = fixture("system")
                recovery = fixture("system")
                for trial in (fresh, recovery):
                    plugin = trial / "exec-credential"
                    put(plugin, f"#!/bin/sh\ntouch '{trial / 'plugin-started'}'\nexit 75\n".encode())
                    plugin.chmod(0o700)
                    candidate = json.loads(json.dumps(selected))
                    candidate["users"][0]["user"]["exec"]["command"] = str(plugin)
                    put(trial / "operator/kubeconfig", json.dumps(candidate).encode())

                # Generate genuine recovery parameters with an expressly
                # disabled preference environment and record a synthetic UID.
                recovery_env = recovery / "kuberc-environment.json"
                put(recovery_env, b'{"KUBERC":"off"}')
                if owner == "profile":
                    first_boundary(recovery, "apply", "ready")
                else:
                    original, events = raw(recovery, "preflight-only")
                    assert original.returncode == 42 and len(last_request(events)) == 1, (original.stderr, events)
                record_secret(recovery)
                recovery_env.unlink()

                for trial, operation in (
                    (fresh, lambda: profiled(fresh, "apply") if owner == "profile" else raw(fresh, "preflight-only")),
                    (recovery, lambda: profile_cleanup(recovery) if owner == "profile" else raw(recovery, "cleanup")),
                    (recovery, lambda: raw(recovery, "resume")),
                ):
                    (trial / ".kube/kuberc").unlink(missing_ok=True)
                    put(trial / "loopback-client-control", b"")
                    put(trial / "late-kuberc", json.dumps(policy_document).encode())
                    result, events = operation()
                    assert (trial / ".kube/kuberc").exists(), (result.stderr, events)
                    assert not (trial / "plugin-started").exists(), (owner, policy, result.stderr, events)
                    assert result.returncode == 1 and "exec credential plugin while kubectl preferences are enabled" in result.stderr, (result.stderr, events)
                    assert events and not last_request(events) and not targets, events

        # With preferences initially absent, a static credential can still
        # use the approved endpoint after a late command-default override.
        put(case / "late-kuberc", json.dumps({
            "apiVersion": "kubectl.config.k8s.io/v1beta1", "kind": "Preference",
            "defaults": [{"command": action, "options": options} for action in ("get", "delete")],
        }).encode())
        selected["users"].append({"name": "unselected-exec", "user": selected["users"][0]["user"]})
        selected["contexts"][1]["context"]["user"] = "unselected-exec"
        selected["users"][0]["user"] = {"token": "synthetic-loopback-token"}
        put(config, json.dumps(selected).encode())
        preference_env.unlink()
        request = first_boundary(case, "apply", "ready")
        assert request["request_failed"] and set(targets) == {approved_port}, targets
        assert not marker.exists()
        targets.clear()

        record_secret(case)
        put(preference_env, json.dumps({"KUBERC": str(custom)}).encode())
        for cleanup in (lambda: raw(case, "cleanup"), lambda: profile_cleanup(case)):
            result, events = cleanup()
            assert result.returncode == 2 and "Active kubectl preferences" in result.stderr, result.stderr
            assert not targets and not events

        preference_env.unlink()
        (case / ".kube/kuberc").unlink()
        result, events = raw(case, "cleanup")
        deletes = [entry for entry in events if entry["operation"] == "delete"]
        assert result.returncode == 1 and len(deletes) == 1, (result.stderr, events)
        assert deletes[0]["request_failed"] and deletes[0]["uid"] == "fixture-secret-uid", deletes
        assert set(targets) == {approved_port}, targets
        assert not marker.exists()
    finally:
        for listener in (approved, alternate):
            listener.shutdown()
