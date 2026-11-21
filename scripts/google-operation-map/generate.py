"""Compile a Linux gog source graph against its pinned Go SDK Discovery documents."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit


# These APIs have no generated Go SDK. Use the JSON bodies and fields written by
# v0.46.0 internal/googleapi/photos{,_write,_picker}.go. Media transfers use
# separate binary upload bodies or provider-selected download URLs.
def photo_operations():
    string = {"type": "string"}
    integer = {"type": "integer"}

    def obj(**properties):
        return {"type": "object", "properties": properties}

    def array(item):
        return {"type": "array", "items": item}

    date = obj(year=integer, month=integer, day=integer)
    search_filters = obj(
        includeArchivedMedia={"type": "boolean"},
        mediaTypeFilter=obj(
            mediaTypes=array({"type": "string", "enum": ["PHOTO", "VIDEO"]})
        ),
        dateFilter=obj(ranges=array(obj(startDate=date, endDate=date))),
    )
    page = {"pageSize": integer, "pageToken": string}
    lib, picker = "photoslibrary:v1", "photospicker:v1"
    readonly = "photoslibrary.readonly.appcreateddata"
    append = "photoslibrary.appendonly"
    pick = "photospicker.mediaitems.readonly"
    rows = [
        (lib, "albums.list", "GET", "/albums", readonly, page, None),
        (
            lib,
            "albums.create",
            "POST",
            "/albums",
            append,
            {},
            obj(album=obj(title=string)),
        ),
        (lib, "mediaItems.get", "GET", "/mediaItems/{id}", readonly, {}, None),
        (lib, "mediaItems.list", "GET", "/mediaItems", readonly, page, None),
        (
            lib,
            "mediaItems.search",
            "POST",
            "/mediaItems:search",
            readonly,
            {},
            obj(albumId=string, orderBy=string, filters=search_filters, **page),
        ),
        (
            picker,
            "sessions.create",
            "POST",
            "/sessions",
            pick,
            {},
            obj(pickingConfig=obj(maxItemCount=string)),
        ),
        (picker, "sessions.get", "GET", "/sessions/{id}", pick, {}, None),
        (picker, "sessions.delete", "DELETE", "/sessions/{id}", pick, {}, None),
        (
            picker,
            "mediaItems.list",
            "GET",
            "/mediaItems",
            pick,
            {**page, "sessionId": {**string, "required": True}},
            None,
        ),
    ]
    ops, schemas = {}, {}
    for api, method, verb, path, scope, query, body in rows:
        product = api.split(":")[0]
        op_id = f"{api}/{product}.{method}"
        op = ops[op_id] = {
            "origin": f"https://{product}.googleapis.com",
            "method": verb,
            "path": "/v1" + path,
            "query": query,
            "scopes": ["https://www.googleapis.com/auth/" + scope],
        }
        if "{id}" in path:
            op["pathParameters"] = {"id": {**string, "required": True}}
        if body:
            schemas[op_id + "Request"] = body
            op["requestSchema"] = op_id + "Request"
    return ops, schemas


# These upstream commands use net/http directly rather than an SDK-generated method.
DIRECT = {
    "people raw": ["people:v1/people.people.get"],
    "contacts raw": ["people:v1/people.people.get"],
    "calendar raw": ["calendar:v3/calendar.events.get"],
    "tasks raw": ["tasks:v1/tasks.tasks.get"],
    "photos list": ["photoslibrary:v1/photoslibrary.mediaItems.list"],
    "photos get": ["photoslibrary:v1/photoslibrary.mediaItems.get"],
    "photos download": ["photoslibrary:v1/photoslibrary.mediaItems.get"],
    "photos search": ["photoslibrary:v1/photoslibrary.mediaItems.search"],
    "photos albums list": ["photoslibrary:v1/photoslibrary.albums.list"],
    "photos albums create": ["photoslibrary:v1/photoslibrary.albums.create"],
    "photos picker create": ["photospicker:v1/photospicker.sessions.create"],
    "photos picker get": ["photospicker:v1/photospicker.sessions.get"],
    "photos picker delete": ["photospicker:v1/photospicker.sessions.delete"],
    "photos picker wait": ["photospicker:v1/photospicker.sessions.get"],
    "photos picker list": ["photospicker:v1/photospicker.mediaItems.list"],
    "photos picker download": ["photospicker:v1/photospicker.mediaItems.list"],
    "gmail raw": ["gmail:v1/gmail.users.messages.get"],
    "docs raw": ["docs:v1/docs.documents.get"],
    "forms raw": ["forms:v1/forms.forms.get"],
    "drive raw": ["drive:v3/drive.files.get"],
    "slides raw": ["slides:v1/slides.presentations.get"],
    "sheets raw": ["sheets:v4/sheets.spreadsheets.get"],
    "chat messages search": ["chat:v1/chat.spaces.messages.search"],
    "sheets batch-request": ["sheets:v4/sheets.spreadsheets.batchUpdate"],
    "batch end": [
        "docs:v1/docs.documents.batchUpdate",
        "forms:v1/forms.forms.batchUpdate",
        "sheets:v4/sheets.spreadsheets.batchUpdate",
        "slides:v1/slides.presentations.batchUpdate",
    ],
}
EXCLUDED_QUERY = {
    "key",
    "access_token",
    "oauth_token",
    "upload_protocol",
    "uploadType",
    "callback",
    "$.xgafv",
    "quotaUser",
}
PARAM_KEYS = ("type", "enum", "required", "repeated", "pattern", "minimum", "maximum")


def parameter(p):
    return {k: p[k] for k in PARAM_KEYS if k in p}


def compile_catalog(graph, sdk):
    ops, reserved, schemas, by_symbol, raw_schemas = {}, [], {}, {}, {}

    def resources(obj):
        yield from obj.get("methods", {}).values()
        for child in obj.get("resources", {}).values():
            yield from resources(child)

    all_methods = {}
    for filename in sorted(sdk.glob("**/*-api.json")):
        pkg = str(filename.parent.relative_to(sdk))
        if pkg not in graph["packages"]:
            continue
        doc = json.loads(filename.read_text())
        api = doc["id"]
        raw_schemas.update(
            {
                api + "/" + name: schema
                for name, schema in doc.get("schemas", {}).items()
            }
        )
        base = urlsplit(doc["baseUrl"])
        for m in resources(doc):
            method = m["id"]
            name = api + "/" + method
            route = dict(
                method=m["httpMethod"],
                origin=base.scheme + "://" + base.netloc,
                path=base.path + m["path"],
            )
            all_methods[name] = (
                route,
                doc.get("parameters", {}),
                m.get("parameters", {}),
                m.get("scopes", []),
                m.get("request", {}).get("$ref"),
            )
            parts = method.split(".")
            sym = (pkg, "".join(parts[1:-1]).lower() + "service." + parts[-1].lower())
            if sym in by_symbol:
                raise ValueError(f"ambiguous generated client method {sym}")
            by_symbol[sym] = name

    def schema(s, api):
        o = {k: s[k] for k in ("type", "enum") if k in s}
        if "$ref" in s:
            ref = api + "/" + s["$ref"]
            if ref not in schemas:
                schemas[ref] = {}
                schemas[ref] = schema(raw_schemas[ref], api)
            return {"$ref": ref}
        if "properties" in s:
            o["properties"] = {
                k: schema(v, api) for k, v in sorted(s["properties"].items())
            }
        for k in ("items", "additionalProperties"):
            if k in s:
                o[k] = schema(s[k], api)
        if isinstance(s.get("required"), list):
            o["required"] = sorted(s["required"])
        return o

    commands = {}
    for cmd, traced in sorted(graph["commands"].items()):
        methods = set(DIRECT.get(cmd, ()))
        for ref in traced["methods"] or ():
            pkg, sym = ref.split(" ")
            if (pkg, sym.lower()) not in by_symbol:
                raise ValueError(f"unrecognized SDK operation {ref}")
            methods.add(by_symbol[(pkg, sym.lower())])
        additional = set(traced.get("additional", ()))
        if cmd in ("photos download", "photos picker download"):
            additional.add("provider_selected_media_url")
        if cmd in ("drive upload", "upload", "gmail import", "photos upload"):
            additional.add("binary_media_upload")
        if cmd == "gmail track setup":
            additional.add("cloudflare_worker_deployment")
        reason = ""
        if cmd.startswith("maps "):
            reason = "maps_api_key"
        elif cmd.startswith("zoom "):
            reason = "zoom_credential"
        elif cmd in ("gmail watch pull", "gmail settings watch pull"):
            reason = "pubsub_grpc"
        elif cmd in ("gmail watch serve", "gmail settings watch serve"):
            reason = "inbound_server"
        elif cmd in ("photos download", "photos picker download"):
            reason = "provider_selected_media_url"
        elif cmd in ("photos upload", "drive upload", "upload", "gmail import"):
            reason = "binary_media_upload"
        elif cmd == "gmail track opens":
            reason = "external_tracking_service"
        elif cmd == "update status":
            reason = "github_release_check"
        elif cmd.startswith("auth ") and cmd not in (
            "auth services",
            "auth alias list",
            "auth service-account status",
        ):
            reason = "local_credential_management"
        elif cmd in ("login", "logout"):
            reason = "local_credential_management"
        if reason:
            status = "unsupported"
        elif cmd == "mcp" or cmd.startswith("api "):
            status = "dynamic"
        elif methods:
            status = "partial" if additional else "rest"
        else:
            status = "local"
        commands[cmd] = {
            "status": status,
            **({"reason": reason} if reason else {}),
            **({"additionalRequirements": sorted(additional)} if additional else {}),
            **({"operations": sorted(methods)} if methods else {}),
        }
    used = {
        m
        for spec in commands.values()
        if spec["status"] in ("rest", "partial")
        for m in spec["operations"]
    }
    # Keep transport-only calls in the inventory without granting their JSON
    # counterpart when no supported command can make that call.
    for command, spec in commands.items():
        methods = spec.get("operations", [])
        blocked = sorted(set(methods) - used)
        if command == "photos upload":
            blocked.extend(
                [
                    "photoslibrary:v1/photoslibrary.uploads",
                    "photoslibrary:v1/photoslibrary.mediaItems.batchCreate",
                ]
            )
        if blocked:
            spec["unavailableOperations"] = blocked
            remaining = sorted(set(methods) & used)
            if remaining:
                spec["operations"] = remaining
            else:
                spec.pop("operations", None)
    for name, (route, global_params, params, scopes, request) in sorted(
        all_methods.items()
    ):
        combined = {**global_params, **params}
        query = {
            k: parameter(v)
            for k, v in sorted(combined.items())
            if v["location"] == "query" and k not in EXCLUDED_QUERY
        }
        path_params = {
            k: parameter(v)
            for k, v in sorted(combined.items())
            if v["location"] == "path"
        }
        if name not in used:
            if path_params:
                route["pathParameters"] = path_params
            reserved.append(route)
            continue
        api = name.split("/")[0]
        op = ops[name] = {**route, "scopes": sorted(scopes), "query": query}
        if path_params:
            op["pathParameters"] = path_params
        if request:
            op["requestSchema"] = schema({"$ref": request}, api)["$ref"]
    photos, photo_schemas = photo_operations()
    ops.update(photos)
    schemas.update(photo_schemas)
    if used != ops.keys():
        raise ValueError(f"unmapped operations: {used.symmetric_difference(ops)}")
    return dict(
        gogVersion="0.46.0",
        commands=commands,
        operations=ops,
        reservedRoutes=reserved,
        schemas=dict(sorted(schemas.items())),
    )


def verify_reference_cases(catalog):
    # Known shapes that distinguish correct source tracing from an SDK-wide grant
    # or a graph that follows every callback installed into the CLI's runtime.
    commands = catalog["commands"]
    if commands["version"] != {"status": "local"} or commands["api call"] != {
        "status": "dynamic"
    }:
        raise ValueError("a local or dynamic command acquired an unconditional method")
    if set(commands["gmail messages search"]["operations"]) != {
        "gmail:v1/gmail.users.messages.list",
        "gmail:v1/gmail.users.labels.list",
        "gmail:v1/gmail.users.messages.get",
    }:
        raise ValueError(
            "Gmail search must include its list, label lookup and per-result metadata or body lookup"
        )
    if set(commands["drive sync push"]["operations"]) != {
        "drive:v3/drive.files.list",
        "drive:v3/drive.files.get",
        "drive:v3/drive.files.create",
        "drive:v3/drive.files.update",
    }:
        raise ValueError(
            "Drive sync must include the concrete Google implementation of its Go interface"
        )
    if (
        commands["drive upload"]["status"] != "unsupported"
        or commands["upload"] != commands["drive upload"]
    ):
        raise ValueError("a binary upload alias was advertised as a JSON operation")
    if len(commands) != 663:
        raise ValueError("review added, renamed or removed gog commands")


def format_catalog(catalog):
    # One stable record per line keeps the checked-in manifest diff reviewable.
    def encode(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    sections = []
    for key, value in catalog.items():
        if isinstance(value, dict):
            values = [f"    {encode(k)}: {encode(v)}" for k, v in sorted(value.items())]
            content = "{\n" + ",\n".join(values) + "\n  }"
        elif isinstance(value, list):
            content = "[\n" + ",\n".join("    " + encode(v) for v in value) + "\n  ]"
        else:
            content = encode(value)
        sections.append(f"  {encode(key)}: {content}")
    return "{\n" + ",\n".join(sections) + "\n}\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source", type=Path, help="extracted upstream gog v0.46.0 source"
    )
    parser.add_argument(
        "binary", type=Path, help="pinned Linux amd64 gog v0.46.0 binary"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the checked-in catalog without writing it",
    )
    args = parser.parse_args()
    src, binary = args.source.resolve(), args.binary.resolve()
    root = Path(__file__).resolve().parents[2]
    release_dir = root / "apps/controller/plugins/oce-google-workspace/ai.openclaw.oce"
    release = json.loads((release_dir / "release.json").read_text())
    if (
        hashlib.sha256(binary.read_bytes()).hexdigest()
        != release["artifacts"]["linux-amd64"]["binarySha256"]
    ):
        parser.error("executable differs from the reviewed release")
    files = [src / "go.mod", src / "go.sum"]
    for subdir in ("internal", "cmd/gog"):
        files.extend(
            p for p in (src / subdir).rglob("*.go") if not p.name.endswith("_test.go")
        )
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(
            path.relative_to(src).as_posix().encode()
            + b"\x00"
            + hashlib.sha256(path.read_bytes()).digest()
        )
    if (
        digest.hexdigest()
        != "f9ea4ed0b7f87305369882d37aeebfaa1098fba4542d0db5368d6d6029c8710e"
    ):
        parser.error("sources differ from the reviewed gog revision e0e3cb9c")
    env = {**os.environ, "GOWORK": "off", "GOOS": "linux", "GOARCH": "amd64"}
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        cli, packages = work / "cli.json", work / "packages.json"
        # An isolated empty home also excludes run-specific command safety profiles.
        with cli.open("wb") as out:
            subprocess.run(
                [binary, "--home", tmp, "schema", "--include-hidden"],
                env={"PATH": os.defpath},
                stdout=out,
                check=True,
            )
        with packages.open("wb") as out:
            subprocess.run(
                [
                    "go",
                    "list",
                    "-buildvcs=false",
                    "-mod=readonly",
                    "-deps",
                    "-export",
                    "-json",
                    "./cmd/gog",
                ],
                cwd=src,
                env=env,
                stdout=out,
                check=True,
            )
        # Check the downloaded dependencies against their recorded module checksums.
        subprocess.run(["go", "mod", "verify"], cwd=src, env=env, check=True)
        sdk = Path(
            subprocess.check_output(
                ["go", "list", "-m", "-f", "{{.Dir}}", "google.golang.org/api"],
                cwd=src,
                env=env,
                text=True,
            ).strip()
        )
        graph = json.loads(
            subprocess.check_output(
                [
                    "go",
                    "run",
                    str(root / "scripts/google-operation-map/trace.go"),
                    packages,
                    cli,
                ],
                cwd=src,
                env=env,
            )
        )
        catalog = compile_catalog(graph, sdk)
        verify_reference_cases(catalog)
        output = release_dir / "operations.json"
        formatted = format_catalog(catalog)
        checksum = hashlib.sha256(formatted.encode()).hexdigest()
        if args.check:
            if (
                formatted != output.read_text()
                or release["operationsSha256"] != checksum
            ):
                parser.exit(
                    1, "regenerate the pinned Google operation map and release digest\n"
                )
        else:
            manifest_path = release_dir / "release.json"
            manifest, count = re.subn(
                r'("operationsSha256": ")[0-9a-f]{64}(")',
                lambda m: m[1] + checksum + m[2],
                manifest_path.read_text(),
            )
            if count != 1:
                parser.error("expected one operationsSha256 in the managed release")
            output.write_text(formatted)
            manifest_path.write_text(manifest)
        print(
            f"{len(catalog['commands'])} command paths, {len(catalog['operations'])} bounded REST operations"
        )
