#!/usr/bin/env python3
"""Read-only verification of a user-facing Console against released Git source."""

import hashlib
from html.parser import HTMLParser
import http.client
import json
import re
import signal
import ssl
import subprocess
import sys
from urllib.parse import unquote, urlsplit


MAX_HTML = 256 * 1024
MAX_ASSET = 2 * 1024 * 1024
DEADLINE = 20
ASSET = "/console/console.css"
SOURCE = "apps/controller/src/console/"
REVISION = re.compile(r"[0-9a-f]{40}")


class Refusal(Exception):
    pass


class ConsoleHTML(HTMLParser):
    """Recognize the explicit release head, not arbitrary browser-repaired HTML."""

    def __init__(self, data):
        super().__init__(convert_charrefs=True)
        self.markers = []
        self.stylesheet = False
        self.links = 0
        self.phase = "before"
        self.child = None
        self.root = False
        try:
            self.feed(data.decode("utf-8", errors="strict"))
            self.close()
        except (AssertionError, ValueError):
            # Older standard parsers can assert on untrusted marked declarations.
            raise Refusal("invalid-html") from None
        if self.phase != "after":
            raise Refusal("invalid-html")

    def handle_starttag(self, tag, attrs):
        if tag == "base":
            raise Refusal("invalid-html")
        if tag == "head":
            if self.phase != "before" or not self.root:
                raise Refusal("invalid-html")
            self.phase = "head"
            return
        if self.phase == "before":
            if tag != "html" or self.root:
                raise Refusal("invalid-html")
            self.root = True
            return
        if self.phase == "head":
            if self.child or tag not in ("meta", "link", "title", "style", "script"):
                raise Refusal("invalid-html")
            if tag in ("title", "style", "script"):
                self.child = tag
        values = dict(attrs)
        if tag == "meta" and ("name", "occ-build-revision") in attrs:
            valid = (self.phase == "head" and len(values) == len(attrs)
                     and set(values) == {"name", "content"})
            self.markers.append(values.get("content") if valid else None)
        if tag == "link" and ("href", ASSET) in attrs:
            self.links += 1
            self.stylesheet = (self.phase == "head" and self.links == 1 and
                               len(attrs) == 2 and
                               values == {"rel": "stylesheet", "href": ASSET})

    def handle_startendtag(self, tag, attrs):
        if tag in ("html", "head", "title", "style", "script"):
            raise Refusal("invalid-html")
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if self.phase == "head":
            if self.child and tag == self.child:
                self.child = None
            elif not self.child and tag == "head":
                self.phase = "after"
            else:
                raise Refusal("invalid-html")
        elif self.phase == "before" or tag == "head":
            raise Refusal("invalid-html")

    def handle_data(self, data):
        if self.phase != "after" and not self.child and data.strip():
            raise Refusal("invalid-html")

    def unknown_decl(self, _data):
        raise Refusal("invalid-html")

    def revision(self):
        if not self.markers:
            raise Refusal("missing-marker")
        if len(self.markers) != 1:
            raise Refusal("duplicate-marker")
        value = self.markers[0]
        if not isinstance(value, str) or not REVISION.fullmatch(value):
            raise Refusal("invalid-marker")
        return value


def git(source, *args):
    # Promised objects must not turn a read-only probe into a remote fetch.
    return subprocess.run(
        ["git", "--no-lazy-fetch", "--no-replace-objects", "-C", source, *args],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=5,
    ).stdout


def source_blob(source, revision, name, limit):
    # Resolve only these fixed paths. Never inspect or copy the whole checkout.
    blob = git(source, "rev-parse", "--verify", f"{revision}:{SOURCE}{name}").strip()
    if not REVISION.fullmatch(blob.decode("ascii")):
        raise Refusal("invalid-source")
    if int(git(source, "cat-file", "-s", blob.decode("ascii"))) > limit:
        raise Refusal("invalid-source")
    return git(source, "cat-file", "blob", blob.decode("ascii"))


def fetch(origin, path, limit, media_type):
    connection = http.client.HTTPSConnection(
        origin.hostname, origin.port, timeout=5, context=ssl.create_default_context(),
    )
    try:
        # No cookie jar, proxy credentials, Authorization, or redirect handling.
        connection.request("GET", path, headers={"Accept-Encoding": "identity"})
        response = connection.getresponse()
        if response.headers.defects:
            raise Refusal("unexpected-content")
        if 300 <= response.status < 400:
            raise Refusal("redirect-refused")
        if response.status in (401, 403):
            raise Refusal("authentication-required")
        if response.status != 200:
            raise Refusal("unavailable")
        types = response.headers.get_all("Content-Type", [])
        if (len(types) != 1 or not re.fullmatch(
                re.escape(media_type) + r'(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?[ \t]*',
                types[0], re.IGNORECASE)):
            raise Refusal("unexpected-content")
        if response.getheader("Content-Encoding", "identity").lower() != "identity":
            raise Refusal("unexpected-content")
        # HTTPResponse tolerates truncated chunk trailers. Only confirm messages
        # framed by one bounded Content-Length, never chunked or close-delimited.
        lengths = response.headers.get_all("Content-Length", [])
        if (response.headers.get_all("Transfer-Encoding") or len(lengths) != 1
                or not re.fullmatch(r"[0-9]{1,10}", lengths[0])):
            raise Refusal("unexpected-content")
        length = int(lengths[0])
        if length > limit:
            raise Refusal("response-too-large")
        try:
            data = response.read(limit + 1)
        except http.client.IncompleteRead:
            raise Refusal("incomplete-response") from None
        if len(data) != length:
            raise Refusal("incomplete-response")
        return data
    finally:
        connection.close()


def deadline(_signum, _frame):
    raise Refusal("deadline-exceeded")


def main():
    if len(sys.argv) != 4 or not REVISION.fullmatch(sys.argv[2]):
        raise Refusal("invalid-input")
    source, revision, url = sys.argv[1:]
    origin = urlsplit(url)
    if (origin.scheme != "https" or not origin.hostname or origin.username is not None
            or origin.password is not None or origin.query or origin.fragment
            or any(ord(char) <= 32 or ord(char) >= 127 for char in url)
            or "\\" in url or origin.path.startswith("//")
            or any(unquote(part) in (".", "..") for part in origin.path.split("/"))):
        raise Refusal("invalid-input")
    try:
        origin.port
    except ValueError:
        raise Refusal("invalid-input") from None
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(DEADLINE)
    try:
        commit = git(source, "rev-parse", "--verify", f"{revision}^{{commit}}")
        if commit.decode("ascii").strip() != revision:
            raise Refusal("invalid-source")
        shell = ConsoleHTML(source_blob(source, revision, "index.html", MAX_HTML))
        if (len(shell.markers) != 1 or shell.markers[0] not in ("", revision)
                or not shell.stylesheet):
            raise Refusal("invalid-source")
        expected = source_blob(source, revision, "console.css", MAX_ASSET)
    except (subprocess.SubprocessError, ValueError, OSError, Refusal):
        raise Refusal("invalid-source") from None
    html = ConsoleHTML(fetch(origin, origin.path or "/", MAX_HTML, "text/html"))
    observed = html.revision()
    if observed != revision:
        raise Refusal("wrong-revision")
    if not html.stylesheet:
        raise Refusal("missing-stylesheet")
    asset = fetch(origin, ASSET, MAX_ASSET, "text/css")
    if asset != expected:
        raise Refusal("wrong-asset")
    return {"result": "verified", "revision": revision,
            "assetSha256": hashlib.sha256(asset).hexdigest()}


if __name__ == "__main__":
    try:
        result = main()
    except Refusal as error:
        result = {"result": str(error)}
    except (OSError, ValueError, http.client.HTTPException):
        result = {"result": "unavailable"}
    finally:
        signal.alarm(0)
    # Never print response bodies, headers, URLs, local paths, or exception text.
    print(json.dumps(result, sort_keys=True))
    sys.exit(0 if result["result"] == "verified" else 1)
