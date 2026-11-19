import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("oce_pins", HERE / "oce_pins.py")
pins = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pins)


def dockerfile(codex="0.163.0-alpha.2", gh="2.100.0", checksums="e" * 64, patches=("one.patch",), extra=""):
    lines = [
        *(f"COPY deploy/runtime/{patch} /tmp/{patch}" for patch in patches),
        "RUN curl https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/releases/download/v0.6.6/x",
        f"x64) library=matrix-sdk-crypto.linux-x64-gnu.node; sha256={'c' * 64} ;;",
        f"arm64) library=matrix-sdk-crypto.linux-arm64-gnu.node; sha256={'d' * 64} ;;",
        "ENV OPENAI_CODEX_VERSION=" + codex,
        f"RUN curl -O https://github.com/cli/cli/releases/download/v{gh}/gh_{gh}_checksums.txt",
        f"RUN echo '{checksums}  gh_{gh}_checksums.txt' | sha256sum --check --strict",
        extra,
    ]
    return "\n".join(lines) + "\n"


def manifest(commit="a" * 40, sha256="b" * 64, timestamp="2026-10-23T16:16:05Z"):
    return f'{{"commit": "{commit}", "sourceArchiveSha256": "{sha256}", "buildTimestamp": "{timestamp}"}}'


CONF = "OCE_REVIEWED_COMMIT={reviewed}\n"


class DockerfilePinTests(unittest.TestCase):
    def test_extracts_inline_pins(self):
        found = pins.dockerfile_pins(dockerfile())
        self.assertEqual(found["OPENAI_CODEX_VERSION"], "0.163.0-alpha.2")
        self.assertEqual(found["MATRIX_SDK_CRYPTO_SHA256_ARM64"], "d" * 64)
        self.assertEqual(found["GH_VERSION"], "2.100.0")
        self.assertEqual(found["GH_CHECKSUMS_SHA256"], "e" * 64)

    def test_rejects_a_missing_pin(self):
        with self.assertRaises(pins.RecipeError):
            pins.dockerfile_pins(dockerfile().replace("ENV OPENAI_CODEX_VERSION", "ENV OTHER"))

    def test_masks_pin_only_changes(self):
        self.assertEqual(pins.masked(dockerfile()), pins.masked(dockerfile(codex="0.170.0", gh="2.103.2", checksums="f" * 64)))

    def test_package_manager(self):
        version, sha512 = pins.package_manager('{"packageManager": "pnpm@12.5.1+sha512.' + "f" * 128 + '"}')
        self.assertEqual((version, sha512), ("12.5.1", "f" * 128))


class ManifestPinsTests(unittest.TestCase):
    def test_extracts_manifest_pins(self):
        found = pins.manifest_pins(manifest())
        self.assertEqual(found["OPENCLAW_COMMIT"], "a" * 40)
        self.assertEqual(found["OPENCLAW_SOURCE_SHA256"], "b" * 64)
        self.assertEqual(found["OPENCLAW_BUILD_TIMESTAMP"], "2026-10-23T16:16:05Z")

    def test_rejects_unexpected_keys(self):
        with self.assertRaises(pins.RecipeError):
            pins.manifest_pins('{"commit": "%s"}' % ("a" * 40))

    def test_rejects_extra_keys(self):
        with self.assertRaises(pins.RecipeError):
            pins.manifest_pins(manifest()[:-1] + ', "extra": 1}')

    def test_rejects_a_non_object(self):
        for body in ("[]", "42", "null"):
            with self.assertRaises(pins.RecipeError):
                pins.manifest_pins(body)

    def test_rejects_a_malformed_value(self):
        with self.assertRaises(pins.RecipeError):
            pins.manifest_pins(manifest(commit="not-a-commit"))

    def test_rejects_a_malformed_timestamp(self):
        with self.assertRaises(pins.RecipeError):
            pins.manifest_pins(manifest(timestamp="2026-10-23 16:16:05"))

    def test_rejects_an_impossible_timestamp(self):
        with self.assertRaises(pins.RecipeError):
            pins.manifest_pins(manifest(timestamp="2026-02-31T16:16:05Z"))

    def test_rejects_a_non_string_field(self):
        with self.assertRaises(pins.RecipeError):
            pins.manifest_pins(
                '{"commit": 42, "sourceArchiveSha256": "%s", "buildTimestamp": "2026-10-23T16:16:05Z"}' % ("b" * 64)
            )

    def test_rejects_invalid_json(self):
        with self.assertRaises(pins.RecipeError):
            pins.manifest_pins("not json")


class RecipeDriftTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        cwd = os.getcwd()
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, cwd)
        pins.CONTAINERFILE.parent.mkdir(parents=True)
        pins.CONTAINERFILE.write_text("RUN git apply /tmp/oce/one.patch\n")

    def drift(self, reviewed_dockerfile, new_dockerfile, clients=("[]\n", "[]\n")):
        content = CONF.format(reviewed="2" * 40)

        def repo_file(ref, path):
            if path == pins.DOWNLOAD_CLIENTS:
                return clients[0] if ref else clients[1]
            return reviewed_dockerfile

        with (
            mock.patch.object(pins, "repo_file", side_effect=repo_file),
            mock.patch.object(pins, "repo_file_or_empty", side_effect=repo_file),
        ):
            return pins.recipe_drift(content, new_dockerfile)

    def test_pin_only_bump_has_no_drift(self):
        self.assertEqual(self.drift(dockerfile(), dockerfile(gh="2.103.2", checksums="f" * 64)), [])

    def test_structural_change_reports_a_diff(self):
        problems = self.drift(dockerfile(), dockerfile(extra="RUN new-stage"))
        self.assertEqual(len(problems), 1)
        self.assertIn("+RUN new-stage", problems[0])

    def test_patch_checksum_change_has_no_drift(self):
        before = dockerfile(extra=f"RUN echo '{'1' * 64}  /tmp/one.patch' | sha256sum --check --strict")
        after = dockerfile(extra=f"RUN echo '{'2' * 64}  /tmp/one.patch' | sha256sum --check --strict")
        self.assertEqual(self.drift(before, after), [])

    def test_other_patch_checksum_change_is_drift(self):
        before = dockerfile(extra=f"RUN echo '{'1' * 64}  /tmp/other.patch' | sha256sum --check --strict")
        after = dockerfile(extra=f"RUN echo '{'2' * 64}  /tmp/other.patch' | sha256sum --check --strict")
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_comment_change_has_no_drift(self):
        before = dockerfile(extra="# matches tests/integration/repository-credentials-package.test.mjs.")
        after = dockerfile(extra="# matches tests/integration/repository-credentials-package.test.ts.")
        self.assertEqual(self.drift(before, after), [])

    def test_continuation_comment_change_has_no_drift(self):
        before = dockerfile(extra="RUN echo one \\\n    # mid-continuation comment\n    two")
        after = dockerfile(extra="RUN echo one \\\n    # changed comment\n    two")
        self.assertEqual(self.drift(before, after), [])

    def test_comment_change_with_heredoc_has_no_drift(self):
        heredoc = "RUN node --input-type=module <<'NODE'\nconsole.log(1)\nNODE"
        before = dockerfile(extra="# old comment.\n" + heredoc)
        after = dockerfile(extra="# new comment.\n" + heredoc)
        self.assertEqual(self.drift(before, after), [])

    def test_heredoc_body_change_is_drift(self):
        before = dockerfile(extra="RUN node --input-type=module <<'NODE'\n# content comment\nNODE")
        after = dockerfile(extra="RUN node --input-type=module <<'NODE'\n# other comment\nNODE")
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_heredoc_with_destination_body_change_is_drift(self):
        before = dockerfile(extra="COPY <<EOF /usr/local/bin/run\n#!/bin/sh\necho hi\nEOF")
        after = dockerfile(extra="COPY <<EOF /usr/local/bin/run\n#!/bin/bash\necho hi\nEOF")
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_interpreter_heredoc_body_change_is_drift(self):
        before = dockerfile(extra="RUN <<EOF bash\n# comment\necho hi\nEOF")
        after = dockerfile(extra="RUN <<EOF bash\n# other comment\necho hi\nEOF")
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_quoted_delimiter_heredoc_body_change_is_drift(self):
        before = dockerfile(extra="COPY <<'EOF-SCRIPT' /usr/local/bin/run\n#!/bin/sh\necho hi\nEOF-SCRIPT")
        after = dockerfile(extra="COPY <<'EOF-SCRIPT' /usr/local/bin/run\n#!/bin/bash\necho hi\nEOF-SCRIPT")
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_multiple_heredocs_body_change_is_drift(self):
        before = dockerfile(extra="RUN cat <<A && cat <<B\n# a-body\nA\n# b-body\nB")
        after = dockerfile(extra="RUN cat <<A && cat <<B\n# a-body\nA\n# b-body changed\nB")
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_marker_inside_a_string_is_not_an_opener(self):
        heredoc = "RUN cat <<EOF\n# head\nb\n# tail\nEOF\n"
        before = dockerfile(extra='RUN echo "a<<b"\n' + heredoc)
        after = dockerfile(extra='RUN echo "a<<b"\n' + heredoc.replace("# tail", "# tail changed"))
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_marker_inside_quotes_is_not_an_opener(self):
        heredoc = "RUN cat <<EOF\n# head\nB\n# tail\nEOF\n"
        before = dockerfile(extra='RUN echo " <<B literal"\n' + heredoc)
        after = dockerfile(extra='RUN echo " <<B literal"\n' + heredoc.replace("# tail", "# tail changed"))
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_marker_after_a_continued_quote_opens_heredoc(self):
        before = dockerfile(extra='RUN echo "a\\\nb" && cat <<EOF\n# old banner\nEOF')
        after = dockerfile(extra='RUN echo "a\\\nb" && cat <<EOF\n# new banner\nEOF')
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_whitespace_change_has_no_drift(self):
        before = dockerfile(extra="RUN echo hi   \n")
        after = dockerfile(extra="\nRUN echo hi")
        self.assertEqual(self.drift(before, after), [])

    def test_parser_directive_change_is_drift(self):
        before = "# syntax=docker/dockerfile:1\n" + dockerfile()
        after = "# syntax=docker/dockerfile:2\n" + dockerfile()
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_indented_directive_change_is_drift(self):
        before = "   # check=skip=all\n" + dockerfile()
        after = "   # check=skip=none\n" + dockerfile()
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_indented_directive_keeps_directives_active(self):
        before = "   # check=skip=all\n# escape=`\n" + dockerfile()
        after = "   # check=skip=all\n# escape=\\\n" + dockerfile()
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_check_directive_change_is_drift(self):
        before = "# check=error=true\n" + dockerfile()
        after = "# check=error=false\n" + dockerfile()
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_directive_after_instructions_is_a_comment(self):
        before = dockerfile(extra="# syntax=docker/dockerfile:1")
        after = dockerfile(extra="# syntax=docker/dockerfile:2")
        self.assertEqual(self.drift(before, after), [])

    def test_directive_activated_by_comment_removal_is_drift(self):
        before = "# a header comment\n# escape=@\n" + dockerfile()
        after = "# escape=@\n" + dockerfile()
        self.assertEqual(len(self.drift(before, after)), 1)

    def bridge_tests(self, files="a.test.ts b.test.ts", graphs='["core"]', extra=""):
        return dockerfile(
            extra="FROM patched AS openclaw-bridge-tests\n"
            f"RUN node scripts/test-projects.mts {files.replace(' ', ' \\\n    ')}\n"
            f"RUN node scripts/run-tsgo-core-test-shards.mjs --ci-graphs-json '{graphs}'\n"
            f"{extra}FROM patched AS openclaw-build\n"
        )

    def test_bridge_test_selection_change_has_no_drift(self):
        after = self.bridge_tests(files="a.test.ts b.test.ts c.test.tsx", graphs='["core","core-test-ui-app"]')
        self.assertEqual(self.drift(self.bridge_tests(), after), [])

    def test_bridge_test_runner_change_is_drift(self):
        after = self.bridge_tests().replace("scripts/test-projects.mts a.test.ts", "scripts/test-projects.mts --bail a.test.ts")
        self.assertEqual(len(self.drift(self.bridge_tests(), after)), 1)

    def test_later_bridge_test_run_change_is_drift(self):
        before = self.bridge_tests(extra="RUN node scripts/test-projects.mts cua.test.ts\n")
        after = self.bridge_tests(extra="RUN node scripts/test-projects.mts cua.test.ts other.test.ts\n")
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_test_files_outside_the_stage_are_drift(self):
        before = dockerfile(extra="RUN node scripts/test-projects.mts a.test.ts")
        after = dockerfile(extra="RUN node scripts/test-projects.mts b.test.ts")
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_bridge_test_selection_change_before_a_chained_call_has_no_drift(self):
        chained = "&& node scripts/test-projects.mts c.test.ts -t name"
        before = self.bridge_tests(files=f"a.test.ts {chained}")
        after = self.bridge_tests(files=f"a.test.ts b.test.ts {chained}")
        self.assertEqual(self.drift(before, after), [])

    def test_chained_bridge_test_call_change_is_drift(self):
        before = self.bridge_tests(files="a.test.ts && node scripts/test-projects.mts c.test.ts -t name")
        after = self.bridge_tests(files="a.test.ts && node scripts/test-projects.mts d.test.ts -t name")
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_bridge_test_call_after_a_semicolon_is_drift(self):
        before = self.bridge_tests(files="a.test.ts ; node scripts/test-projects.mts c.test.ts -t name")
        after = self.bridge_tests(files="a.test.ts ; node scripts/test-projects.mts d.test.ts -t name")
        self.assertEqual(len(self.drift(before, after)), 1)

    def test_download_client_selection_change_is_drift(self):
        problems = self.drift(dockerfile(), dockerfile(), clients=("[]\n", '["/opt/devtools/bin/cargo"]\n'))
        self.assertEqual(len(problems), 1)
        self.assertIn(pins.DOWNLOAD_CLIENTS, problems[0])

    def test_node_compile_stage_change_has_no_drift(self):
        stages = "FROM base AS node-source\nRUN sh fetch.sh\nFROM node-source AS node-compiled\nARG NODE_BUILD_JOBS={jobs}\n"
        before = dockerfile(extra=stages.format(jobs=4) + "FROM base AS node-repaired-build-base")
        after = dockerfile(extra=stages.format(jobs="auto") + "FROM base AS node-repaired-build-base")
        self.assertEqual(self.drift(before, after), [])

    def test_change_after_the_node_compile_stages_is_drift(self):
        stages = "FROM node-source AS node-compiled\nRUN sh build.sh\nFROM base AS node-repaired-build-base\n"
        after = dockerfile(extra=stages + "RUN apt-get install -y extra")
        self.assertEqual(len(self.drift(dockerfile(extra=stages), after)), 1)

    def test_new_bridge_patch_is_drift(self):
        problems = self.drift(dockerfile(), dockerfile(patches=("one.patch", "two.patch")))
        self.assertTrue(any("bridge patches differ" in problem for problem in problems))



CONTROLLER_DOCKERFILE = (
    "ARG NODE_RUNTIME_BASE_IMAGE=docker.io/library/node:{node}-bookworm-slim@sha256:{digest}\n"
    "FROM base AS development\nRUN {development}\n"
    "FROM base AS runtime\n{extra}"
)


def controller_dockerfile(node="24.22.1", digest="a" * 64, development="pnpm install", extra=""):
    return CONTROLLER_DOCKERFILE.format(node=node, digest=digest, development=development, extra=extra)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        cwd = os.getcwd()
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, cwd)
        pins.CONTROLLER_CONF.parent.mkdir(parents=True)

    def drift(self, reviewed_dockerfile, new_dockerfile):
        content = CONF.format(reviewed="2" * 40)
        files = {"2" * 40: reviewed_dockerfile, None: new_dockerfile}
        with mock.patch.object(pins, "repo_file", side_effect=lambda ref, path: files[ref]):
            return pins.controller_drift(content)

    def test_base_image_bump_has_no_drift(self):
        after = controller_dockerfile(node="24.23.0", digest="b" * 64)
        self.assertEqual(self.drift(controller_dockerfile(), after), [])

    def test_base_image_major_change_is_drift(self):
        problems = self.drift(controller_dockerfile(), controller_dockerfile(node="26.0.0"))
        self.assertEqual(len(problems), 1)
        self.assertIn("node:26.<MINOR>.<PATCH>-bookworm-slim", problems[0])

    def test_development_stage_change_has_no_drift(self):
        after = controller_dockerfile(development="pnpm install --frozen-lockfile")
        self.assertEqual(self.drift(controller_dockerfile(), after), [])

    def test_dockerfile_change_reports_a_diff(self):
        problems = self.drift(controller_dockerfile(), controller_dockerfile(extra="RUN precompile\n"))
        self.assertEqual(len(problems), 1)
        self.assertIn("+RUN precompile", problems[0])

    def test_comment_change_has_no_drift(self):
        before = controller_dockerfile(extra="# build the client\n")
        self.assertEqual(self.drift(before, controller_dockerfile(extra="# build it\n")), [])

    def test_heredoc_with_destination_body_change_is_drift(self):
        heredoc = "COPY <<EOF /usr/local/bin/run\n#!/bin/sh\necho hi\nEOF\n"
        after = controller_dockerfile(extra=heredoc.replace("/bin/sh", "/bin/bash"))
        self.assertEqual(len(self.drift(controller_dockerfile(extra=heredoc), after)), 1)

    def test_sync_copies_shared_pins_and_advances_the_review(self):
        pins.CONTROLLER_CONF.write_text(
            CONF.format(reviewed="2" * 40) + f"PNPM_OCE_VERSION=11.0.0\nPNPM_OCE_SHA512={'0' * 128}\n"
        )
        runtime = CONF.format(reviewed="3" * 40) + f"PNPM_OCE_VERSION=11.15.1\nPNPM_OCE_SHA512={'4' * 128}\n"
        with (
            mock.patch.object(pins, "repo_file", return_value=controller_dockerfile()),
            mock.patch.object(pins, "last_change", return_value="1" * 40),
        ):
            pins.sync_controller(runtime)
        controller = pins.CONTROLLER_CONF.read_text()
        for key in pins.SHARED_PINS:
            self.assertEqual(pins.get_value(controller, key), pins.get_value(runtime, key))
        self.assertEqual(pins.get_value(controller, "OCE_REVIEWED_COMMIT"), "1" * 40)


PORT = "ARG BASE_IMAGE=hi/nodejs:24@sha256:{digest}\nARG BUILDER_IMAGE=hi/nodejs:24-builder@sha256:{digest}\n{extra}"


class PortTests(unittest.TestCase):
    """The recorded port fingerprints and the shared base images."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        cwd = os.getcwd()
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, cwd)
        for conf, port in pins.IMAGES.values():
            conf.parent.mkdir(parents=True, exist_ok=True)
            port.parent.mkdir(parents=True, exist_ok=True)
            port.write_text(PORT.format(digest="a" * 64, extra="RUN build\n"))
            conf.write_text(CONF.format(reviewed="2" * 40) + f"OCE_PORT_SHA256={pins.port_digest(port)}\n")

    def test_recorded_ports_have_no_problems(self):
        self.assertEqual(pins.port_problems(), [])

    def test_base_digest_and_comment_changes_keep_the_fingerprint(self):
        for _, port in pins.IMAGES.values():
            port.write_text(PORT.format(digest="b" * 64, extra="# build it\nRUN build\n"))
        self.assertEqual(pins.port_problems(), [])

    def test_unrecorded_port_change_is_a_problem(self):
        pins.CONTAINERFILE.write_text(PORT.format(digest="a" * 64, extra="RUN build --fast\n"))
        problems = pins.port_problems()
        self.assertEqual(len(problems), 1)
        self.assertIn("--ported runtime", problems[0])

    def test_mismatched_base_images_are_a_problem(self):
        pins.CONTROLLER_CONTAINERFILE.write_text(PORT.format(digest="b" * 64, extra="RUN build\n"))
        self.assertIn("must pin the same base images", pins.port_problems()[0])

    def test_ported_refuses_an_unchanged_port(self):
        with self.assertRaises(pins.RecipeError):
            pins.ported("controller")

    def test_ported_records_the_port(self):
        pins.CONTROLLER_CONTAINERFILE.write_text(PORT.format(digest="a" * 64, extra="RUN build --fast\n"))
        with mock.patch.object(pins, "last_change", return_value="1" * 40) as last_change:
            pins.ported("controller")
        last_change.assert_called_once_with(pins.CONTROLLER_DOCKERFILE)
        content = pins.CONTROLLER_CONF.read_text()
        self.assertEqual(pins.get_value(content, "OCE_REVIEWED_COMMIT"), "1" * 40)
        self.assertEqual(pins.get_value(content, "OCE_PORT_SHA256"), pins.port_digest(pins.CONTROLLER_CONTAINERFILE))
        self.assertEqual(pins.port_problems(), [])

    def test_missing_controller_conf_fails_the_check(self):
        pins.CONTROLLER_CONF.unlink()
        with (
            mock.patch.object(pins, "derive", return_value=("", {})),
            mock.patch.object(pins, "recipe_drift", return_value=[]),
            self.assertRaises(FileNotFoundError),
        ):
            pins.check()


class GitBaselineTests(unittest.TestCase):
    """The review baseline comes from this repository's own history."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        cwd = os.getcwd()
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, cwd)
        subprocess.run(["git", "init", "-q"], check=True)
        Path(pins.RUNTIME_DOCKERFILE).parent.mkdir(parents=True)
        pins.CONF.parent.mkdir(parents=True)
        pins.CONF.write_text(CONF.format(reviewed="0" * 40) + f"OCE_PORT_SHA256={'0' * 64}\n")
        pins.CONTAINERFILE.parent.mkdir(parents=True)
        pins.CONTAINERFILE.write_text("RUN build\n")

    def commit(self, dockerfile_text):
        Path(pins.RUNTIME_DOCKERFILE).write_text(dockerfile_text)
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com"]
        subprocess.run([*git, "add", "-A"], check=True)
        subprocess.run([*git, "commit", "-q", "-m", "change"], check=True)
        return subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()

    def test_reads_the_reviewed_dockerfile_from_history(self):
        reviewed = self.commit(dockerfile())
        self.commit(dockerfile(extra="RUN new-stage"))
        self.assertEqual(pins.repo_file(reviewed, pins.RUNTIME_DOCKERFILE), dockerfile())
        self.assertIn("RUN new-stage", pins.repo_file(None, pins.RUNTIME_DOCKERFILE))

    def test_ported_records_the_latest_dockerfile_change(self):
        self.commit(dockerfile())
        latest = self.commit(dockerfile(extra="RUN new-stage"))
        Path("unrelated").write_text("x")
        subprocess.run(["git", "add", "unrelated"], check=True)
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "other"], check=True)
        pins.ported("runtime")
        self.assertEqual(pins.get_value(pins.CONF.read_text(), "OCE_REVIEWED_COMMIT"), latest)

    def test_ported_runtime_records_a_toolchain_selection_change(self):
        self.commit(dockerfile())
        Path(pins.DOWNLOAD_CLIENTS).write_text('["/opt/devtools/bin/cargo"]\n')
        latest = self.commit(dockerfile())
        pins.ported("runtime")
        self.assertEqual(pins.get_value(pins.CONF.read_text(), "OCE_REVIEWED_COMMIT"), latest)

    def test_a_file_the_baseline_predates_reads_as_empty(self):
        reviewed = self.commit(dockerfile())
        Path(pins.DOWNLOAD_CLIENTS).write_text("[]\n")
        self.commit(dockerfile())
        self.assertEqual(pins.repo_file_or_empty(reviewed, pins.DOWNLOAD_CLIENTS), "")
        self.assertEqual(pins.repo_file_or_empty(None, pins.DOWNLOAD_CLIENTS), "[]\n")

    def test_unknown_baseline_is_a_recipe_error(self):
        self.commit(dockerfile())
        with self.assertRaises(pins.RecipeError):
            pins.repo_file("1" * 40, pins.RUNTIME_DOCKERFILE)


if __name__ == "__main__":
    unittest.main()
