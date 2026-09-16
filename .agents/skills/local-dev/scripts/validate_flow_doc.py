#!/usr/bin/env python3
"""
Validate flow-doc structure for repository-local development.
Adapted from Specy 2.0.0; Python standard library only.

Checks:
- Flow-doc heading and trace structure
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path


CODE_BLOCK_RE = re.compile(r"```[A-Za-z0-9_-]*\n.*?```", re.S)
SUDOCODE_FENCE_RE = re.compile(r"```sudocode\b")
FIRST_H1_RE = re.compile(r"(?m)^#\s+(.+?)\s*$")
PR_TITLE_RE = re.compile(r"(?i)^PR(?:\s+[#A-Za-z0-9][^:\n]*)?:\s+\S")
LOCAL_ABSOLUTE_MARKDOWN_LINK_RE = re.compile(
    r"\[[^\]]+\]\(((?:/Users/|/home/)[^)]+)\)"
)
SOURCE_POINTER_RE = re.compile(
    r"(?:(?:[\w.@-]+/)+[\w.@-]+|[\w.@-]+\.[A-Za-z0-9]+):"
    r"(?:[A-Za-z_$][\w.$-]*|\d+(?::\d+)?)"
)
MERMAID_GRAPH_RE = re.compile(
    r"```mermaid[ \t]*\r?\n[ \t]*graph[ \t]+TD\b(?P<body>.*?)\r?\n[ \t]*```",
    re.I | re.S,
)
MERMAID_DIAGRAM_RE = re.compile(
    r"```mermaid[ \t]*\r?\n(?P<body>.*?)\r?\n[ \t]*```", re.I | re.S
)
BRACED_PLACEHOLDER_RE = re.compile(r"\{\{[^{}]+\}\}", re.S)
TEMPLATE_PLACEHOLDER_RE = re.compile(
    r"\[(?:Feature|Phase Name|Step in phase|add additional phases as necessary|"
    r"1-3 sentences\b[^\]]*|how this flow starts\b[^\]]*|"
    r"route/handler/hook/builder/component entrypoint|"
    r"Related flow docs|Architecture docs|Specs / design docs / PR docs|"
    r"metric name\b[^\]]*|log line/logger path\b[^\]]*|"
    r"YYYY-MM-DD HH:MM|description of update|agent session id|codex session id|"
    r"\$sudocode describing)\]",
    re.I,
)
CHANGELOG_ENTRY_RE = re.compile(
    r"^-\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\s+.+?\s+"
    r"\((?P<session>[^()\n]+?)\s+-\s+(?P<sha>[a-fA-F0-9]{7,40})\)\s*$"
)
PLACEHOLDER_SOURCE_POINTER_RE = re.compile(
    r"\bpath/to/file\.[A-Za-z0-9]+:[A-Za-z_$][\w.$-]*"
)
PLACEHOLDER_SESSION_RE = re.compile(
    r"(?:^|/)(?:session[-_ ]?id|agent[-_ ]?session[-_ ]?id|unknown|todo|tbd)$",
    re.I,
)


@dataclass
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _has_h2(text: str, heading: str) -> bool:
    pattern = re.compile(rf"(?im)^##\s+{re.escape(heading)}\s*$")
    return pattern.search(text) is not None


def _h2_position(text: str, heading: str) -> int | None:
    pattern = re.compile(rf"(?im)^##\s+{re.escape(heading)}\s*$")
    match = pattern.search(text)
    return match.start() if match else None


def _extract_h2_section(text: str, heading: str) -> str | None:
    start_re = re.compile(rf"(?im)^##\s+{re.escape(heading)}\s*$")
    match = start_re.search(text)
    if not match:
        return None
    start = match.end()
    next_h2 = re.compile(r"(?im)^##\s+").search(text, start)
    end = next_h2.start() if next_h2 else len(text)
    return text[start:end]


def _extract_frontmatter(text: str) -> str | None:
    if not text.startswith("---\n"):
        return None

    end = text.find("\n---\n", 4)
    if end == -1:
        return None

    return text[4:end]


def _extract_first_h1(text: str) -> str | None:
    match = FIRST_H1_RE.search(text)
    return match.group(1).strip() if match else None


def _extract_segments_by_heading(section: str, heading_pattern: str) -> list[tuple[str, str]]:
    """
    Returns list of (heading_text, segment_body_including_heading_to_before_next_same_level_or_h2).
    """
    matches = list(re.finditer(heading_pattern, section, flags=re.I | re.M))
    segments: list[tuple[str, str]] = []
    for idx, match in enumerate(matches):
        start = match.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(section)
        segments.append((match.group(0), section[start:end]))
    return segments


def _validate_required_h2(text: str, required_h2: list[str], result: ValidationResult) -> None:
    for heading in required_h2:
        if not _has_h2(text, heading):
            result.errors.append(f"Missing required section: '## {heading}'")


def _validate_frontmatter(text: str, result: ValidationResult) -> None:
    if not text.startswith("---\n"):
        result.errors.append("Missing YAML frontmatter block")
        return

    end = text.find("\n---\n", 4)
    if end == -1:
        result.errors.append("YAML frontmatter block is not closed")
        return

    frontmatter = text[4:end]
    for key in ("created", "updated", "last_updated_session"):
        if not re.search(rf"(?m)^{key}:\s*\S+", frontmatter):
            result.errors.append(f"Missing required frontmatter key: '{key}'")


def _validate_pr_scope_metadata(text: str, result: ValidationResult) -> None:
    frontmatter = _extract_frontmatter(text)
    title = _extract_first_h1(text)
    has_pr_frontmatter = bool(
        frontmatter and re.search(r"(?m)^pr:\s*\S+", frontmatter)
    )
    has_pr_title = bool(title and PR_TITLE_RE.match(title))

    if has_pr_frontmatter and not has_pr_title:
        result.errors.append(
            "PR-scoped flow docs must prefix the H1 with 'PR <number>:'"
        )
    if has_pr_title and not has_pr_frontmatter:
        result.errors.append(
            "PR-scoped flow docs must include non-empty frontmatter key: 'pr'"
        )


def _validate_entry_points(text: str, result: ValidationResult) -> None:
    entry_points = _extract_h2_section(text, "Entry Points")
    if entry_points is None:
        return

    pointer_count = len(SOURCE_POINTER_RE.findall(entry_points))
    if pointer_count < 1:
        result.errors.append("Entry Points must include at least one code pointer")
    if pointer_count > 3:
        result.errors.append("Entry Points must include at most three code pointers")


def _validate_execution_trace(
    text: str, result: ValidationResult, *, legacy: bool = False
) -> None:
    trace = _extract_h2_section(text, "Execution Trace")
    if trace is None:
        return

    phase_segments = _extract_segments_by_heading(trace, r"^###\s+\d+\.\s+.+$")
    if not phase_segments:
        result.errors.append("Execution Trace must use numbered phase headings like '### 1. Phase Name'")
        return

    for phase_heading, phase_segment in phase_segments:
        if SOURCE_POINTER_RE.search(phase_segment) is None:
            issue = f"{phase_heading.strip()} must include a real file/function pointer"
            (result.warnings if legacy else result.errors).append(issue)
        if SUDOCODE_FENCE_RE.search(phase_segment) is not None:
            result.errors.append(
                f"{phase_heading.strip()} must use a fenced 'ts' block for $sudocode, not 'sudocode'"
            )


def _resolve_alternative_heading(
    text: str, preferred: str, legacy: str, result: ValidationResult
) -> str | None:
    if _has_h2(text, preferred):
        return preferred
    if _has_h2(text, legacy):
        return legacy
    result.errors.append(
        f"Missing required section: '## {preferred}' (legacy '## {legacy}' is also accepted)"
    )
    return None


def _validate_flow_diagram(
    text: str, heading: str | None, result: ValidationResult, *, legacy: bool = False
) -> None:
    if heading is None:
        return
    section = _extract_h2_section(text, heading)
    if section is None:
        return
    diagram = (MERMAID_DIAGRAM_RE if legacy else MERMAID_GRAPH_RE).search(section)
    if diagram is None:
        diagram_requirement = "diagram" if legacy else "'graph TD' diagram"
        result.errors.append(f"'## {heading}' must include a fenced Mermaid {diagram_requirement}")
        return
    graph_lines = [
        line.strip()
        for line in diagram.group("body").splitlines()
        if line.strip() and not line.lstrip().startswith("%%")
    ]
    if len(graph_lines) < (2 if legacy else 1):
        diagram_description = "diagram" if legacy else "'graph TD' diagram"
        result.errors.append(f"'## {heading}' Mermaid {diagram_description} must include actual flow nodes")


def _without_manual_notes_body(text: str) -> str:
    manual_notes = _extract_h2_section(text, "Manual Notes")
    if manual_notes is None:
        return text
    return text.replace(manual_notes, "\n", 1)


def _validate_no_placeholders(text: str, result: ValidationResult) -> None:
    inspectable = _without_manual_notes_body(text)
    placeholders = BRACED_PLACEHOLDER_RE.findall(inspectable)
    placeholders.extend(TEMPLATE_PLACEHOLDER_RE.findall(inspectable))
    placeholders.extend(PLACEHOLDER_SOURCE_POINTER_RE.findall(inspectable))
    for placeholder in dict.fromkeys(placeholders):
        result.errors.append(
            f"Unresolved template placeholder: {' '.join(placeholder.split())}"
        )


def _validate_debugging_signals(
    text: str, heading: str | None, result: ValidationResult
) -> None:
    if heading is None:
        return
    section = _extract_h2_section(text, heading)
    if section is None:
        return
    if re.search(r"\bnone identified\b", section, re.I):
        return
    substantive_lines = [
        line.strip()
        for line in section.splitlines()
        if line.strip()
        and not re.fullmatch(
            r"(?:[-*]\s*)?(?:metrics?|logs?|debug(?:ging)?(?: probes)?|"
            r"verification|signals?|todo|tbd|\.{2,}):?",
            line.strip(),
            re.I,
        )
    ]
    if not substantive_lines:
        result.errors.append(
            f"'## {heading}' must include concrete debugging signals or 'None identified'"
        )


def _validate_changelog(
    text: str, result: ValidationResult, *, legacy: bool = False
) -> None:
    changelog = _extract_h2_section(text, "Changelog")
    if changelog is None:
        return
    entries = [line.strip() for line in changelog.splitlines() if line.strip().startswith("-")]
    candidates = entries if legacy else entries[:1]
    has_valid_entry = any(
        (match := CHANGELOG_ENTRY_RE.fullmatch(entry)) is not None
        and PLACEHOLDER_SESSION_RE.search(match.group("session").strip()) is None
        for entry in candidates
    )
    if not has_valid_entry:
        entry_location = "contain an entry" if legacy else "start with an entry"
        result.errors.append(
            f"Changelog must {entry_location} containing a YYYY-MM-DD HH:MM timestamp, "
            "description, non-placeholder session id, and 7-40 character git SHA"
        )


def _validate_manual_notes_and_changelog_order(text: str, result: ValidationResult) -> None:
    manual_pos = _h2_position(text, "Manual Notes")
    changelog_pos = _h2_position(text, "Changelog")
    if manual_pos is None or changelog_pos is None:
        return
    if manual_pos > changelog_pos:
        result.errors.append("Section order must place '## Manual Notes' before '## Changelog'")


def _validate_flow_doc(text: str, result: ValidationResult) -> None:
    required_h2 = [
        "Overview",
        "Entry Points",
        "Execution Trace",
        "Related docs",
        "Manual Notes",
        "Changelog",
    ]
    _validate_frontmatter(text, result)
    _validate_pr_scope_metadata(text, result)
    _validate_required_h2(text, required_h2, result)
    flow_heading = _resolve_alternative_heading(text, "Flow", "Sequence Diagram", result)
    debugging_heading = _resolve_alternative_heading(
        text, "Debugging and Verification", "Observability", result
    )
    legacy_flow = flow_heading == "Sequence Diagram"

    flow_pos = _h2_position(text, flow_heading) if flow_heading is not None else None
    trace_pos = _h2_position(text, "Execution Trace")
    if flow_pos is not None and trace_pos is not None and flow_pos > trace_pos:
        result.errors.append(
            f"Section order must place '## {flow_heading}' before '## Execution Trace'"
        )

    _validate_entry_points(text, result)
    _validate_flow_diagram(text, flow_heading, result, legacy=legacy_flow)
    _validate_execution_trace(text, result, legacy=legacy_flow)
    _validate_debugging_signals(text, debugging_heading, result)
    _validate_manual_notes_and_changelog_order(text, result)
    _validate_changelog(text, result, legacy=legacy_flow)
    _validate_no_placeholders(text, result)


def _validate_portable_repo_links(text: str, result: ValidationResult) -> None:
    scrubbed = CODE_BLOCK_RE.sub("", text)
    for match in LOCAL_ABSOLUTE_MARKDOWN_LINK_RE.finditer(scrubbed):
        result.errors.append(
            "Markdown links must not use machine-local absolute paths; "
            f"use a repo-relative target instead: {match.group(1)}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate flow-doc structure.")
    parser.add_argument(
        "--kind",
        choices=["flow-doc"],
        default="flow-doc",
        help="Flow doc type. Only flow-doc is supported.",
    )
    parser.add_argument("--doc", required=True, help="Path to flow doc markdown file.")
    args = parser.parse_args()

    doc_path = Path(args.doc).expanduser()
    if not doc_path.exists():
        print(f"ERROR: file not found: {doc_path}", file=sys.stderr)
        return 2
    if not doc_path.is_file():
        print(f"ERROR: not a file: {doc_path}", file=sys.stderr)
        return 2

    text = doc_path.read_text(encoding="utf-8")
    kind = args.kind

    result = ValidationResult()
    _validate_flow_doc(text, result)
    _validate_portable_repo_links(text, result)

    if result.errors:
        print(f"FAIL [{kind}] {doc_path}")
        for idx, err in enumerate(result.errors, 1):
            print(f"  {idx}. ERROR: {err}")
        for idx, warning in enumerate(result.warnings, 1):
            print(f"  {idx}. WARN: {warning}")
        return 1

    print(f"PASS [{kind}] {doc_path}")
    for idx, warning in enumerate(result.warnings, 1):
        print(f"  {idx}. WARN: {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
