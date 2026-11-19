"""Exercise native target binding through the real adapter and kubeconfig decoder.

The recorder stops before network access. Receipt fixtures use synthetic evidence
for an acknowledged Secret and do not simulate a completed Kubernetes upgrade.
"""
import base64
import hashlib
import json
import os
import platform
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

proof = Path(sys.argv[1]).resolve()
root = Path.cwd()
tools = ("bash", "git", "jq", "node", "yq")
missing = [tool for tool in tools if not shutil.which(tool)]
if missing:
    sys.exit("requires local tools: " + ", ".join(missing))

def pinned_decoder():
    architecture = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())
    if sys.platform != "linux" or architecture is None:
        sys.exit("the upgrade target regression requires a supported Linux kubectl build")
    pins = json.loads((root / "scripts/ci/kubectl-pins.json").read_text())
    expected = pins["linux"][architecture]
    # Inspect PATH candidates without invoking them. Nonblocking open keeps
    # executable FIFOs from blocking discovery before the regular-file check.
    for directory in os.get_exec_path():
        candidate = shutil.which("kubectl", path=directory)
        if candidate is None:
            continue
        try:
            candidate = Path(candidate).resolve(strict=True)
            flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
            with os.fdopen(os.open(candidate, flags), "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111:
                    continue
                digest = hashlib.sha256()
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
                if digest.hexdigest() == expected:
                    return str(candidate), expected
        except OSError:
            continue
    sys.exit("requires the pinned native kubectl executable on PATH")

kubectl, kubectl_sha256 = pinned_decoder()


def run_command(command, *, environment=None, timeout=20):
    with subprocess.Popen(
        command, env=environment, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, start_new_session=True,
    ) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=2)
            raise
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


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

adapter_cmd = ["python3", "scripts/upgrade-production"]
native_cmd = ["bash", "scripts/upgrade-production-images"]

binaries = proof / "bin"
binaries.mkdir(mode=0o700, exist_ok=True)
shim = binaries / "kubectl"
shim.write_text("""#!/usr/bin/env python3
import base64,hashlib,json,os,pathlib,stat,subprocess,sys
from pathlib import Path
args = sys.argv[1:]
case = Path(os.environ["CONTROL_CASE"])
tool = Path(sys.argv[0]).name
def decoder():
    candidate = os.environ["CONTROL_KUBECTL"]
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
    with os.fdopen(os.open(candidate, flags), "rb") as source:
        info = os.fstat(source.fileno())
        assert stat.S_ISREG(info.st_mode) and info.st_mode & 0o111, "decoder is no longer an executable file"
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    assert digest.hexdigest() == os.environ["CONTROL_KUBECTL_SHA256"], "decoder changed before invocation"
    return candidate

path = Path(args[args.index("--kubeconfig") + 1])
record = {"tool": tool, "path": str(path)}
def swap_ca():
    ca = case/"material/server.pem"
    replacement = ca.with_name("replace.pem")
    replacement.write_bytes(b"replacement authority for fixture")
    replacement.replace(ca)
if (tool == "kubectl" and args[:1] == ["--kubeconfig"]
        and args[2:] == ["config", "view", "--merge=false", "--raw", "-o", "json"]):
    record["operation"] = "decode"
    mutation = os.environ.get("CHANGE_BEFORE_PIN")
    if mutation == "swap":
        swap_ca()
    elif mutation == "delete":
        (case / "material/server.pem").unlink()
    with (case/"events.jsonl").open("a") as out:
        out.write(json.dumps(record)+"\\n")
    real = decoder()
    os.execv(real,[real,*args])
if "get" in args and "--raw=/readyz" in args:
    record["operation"] = "ready"
elif tool == "helm" and args[:2] == ["status","oce"]:
    record["operation"] = "helm-status"
elif "delete" in args and any(a.startswith("--raw=") for a in args):
    record["operation"] = "delete"
    record["uid"] = json.load(sys.stdin)["preconditions"]["uid"]
else:
    record["operation"] = "other"
if os.environ.get("SWAP_AT_BOUNDARY") == "yes":
    swap_ca()
# Decode the same source and flatten relative references locally using real
# client-go compatibility. Permit no non-config subcommand or network call.
view = subprocess.run(
    [decoder(),"--kubeconfig",str(path),"--context","fixture","config","view",
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
source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
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
        "users":[{"name":"credential","user":{"client-certificate":"../material/client.pem","client-key":"../material/client.key","tokenFile":"../material/token","exec":{"apiVersion":"client.authentication.k8s.io/v1beta1","command":"../material/rotate-token"}}}],
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
        "CONTROL_KUBECTL_SHA256": kubectl_sha256,
        "SWAP_AT_BOUNDARY": "yes" if swap else "no",
        "CHANGE_BEFORE_PIN": change_before_pin,
    }
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
        assert result.returncode == 42 and [entry["operation"] for entry in events] == ["ready"], (result.stderr, events)
        assert json.loads((case / "evidence/parameters.json").read_text())["profiled"] is False
        assert events[0]["path"] == str(case / "operator/kubeconfig")
    record_secret(case)
    result, events = raw(case, "cleanup")
    deletes = [entry for entry in events if entry["operation"] == "delete"]
    assert len(deletes) == 1 and deletes[0]["uid"] == "fixture-secret-uid", (result.stderr, events)
    assert (deletes[0]["path"] != str(case / "operator/kubeconfig")) == (owner == "profile"), deletes
    assert deletes[0]["decoder_status"] == 0 and deletes[0]["approved_ca"], deletes
    if owner == "raw":
        result, events = profile_cleanup(case)
        deletes = [entry for entry in events if entry["operation"] == "delete"]
        assert len(deletes) == 1 and deletes[0]["uid"] == "fixture-secret-uid", (result.stderr, events)
        assert deletes[0]["path"] != str(case / "operator/kubeconfig"), deletes
        assert deletes[0]["decoder_status"] == 0 and deletes[0]["approved_ca"], deletes
