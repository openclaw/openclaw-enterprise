import {
  createDocsMarkdown,
  parseDocsDocument,
  rewriteDocsRelativeLinks,
  parseAttrs,
  markerPrefix,
  inlineMarkerPrefix,
} from "./docs-markdown.mjs";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import http from "highlight.js/lib/languages/http";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { icons as lucideIcons } from "lucide";

const languages = {
  bash,
  css,
  diff,
  dockerfile,
  go,
  http,
  ini,
  java,
  javascript,
  json,
  markdown,
  powershell,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, language] of Object.entries(languages)) hljs.registerLanguage(name, language);
const languageAliases = new Map([
  ["sh", "bash"],
  ["zsh", "bash"],
  ["console", "bash"],
  ["terminal", "bash"],
  ["ps1", "powershell"],
  ["pwsh", "powershell"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["jsonc", "json"],
  ["json5", "javascript"],
  ["yml", "yaml"],
  ["html", "xml"],
  ["md", "markdown"],
  ["text", "plaintext"],
  ["txt", "plaintext"],
]);
export function createMarkdownRenderer() {
  const md = createDocsMarkdown({ highlight: highlightCode });
  const renderHeadingOpen = md.renderer.rules.heading_open ?? renderToken;
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const alias = tokens[idx].meta?.anchorAlias;
    return `${renderHeadingOpen(tokens, idx, options, env, self)}${alias ? `<span id="${escapeAttr(alias)}" class="anchor-alias" aria-hidden="true"></span>` : ""}`;
  };
  const renderHeadingClose = md.renderer.rules.heading_close ?? renderToken;
  md.renderer.rules.heading_close = (tokens, idx, options, env, self) => {
    const headingOpen = tokens[idx - 2];
    const id = headingOpen?.type === "heading_open" ? headingOpen.attrGet("id") : "";
    const copyAnchor = id ? headingAnchorButton(id) : "";
    return `${copyAnchor}${renderHeadingClose(tokens, idx, options, env, self)}`;
  };
  md.renderer.rules.fence = renderFence;
  return md;
}

function renderToken(tokens, idx, options, _env, self) {
  return self.renderToken(tokens, idx, options);
}

function headingAnchorButton(id) {
  return `<button type="button" class="heading-anchor" data-heading-anchor="${escapeAttr(id)}" data-copy-label="Copy link to section" aria-label="Copy link to section">${headingLinkIcon()}${headingCheckIcon()}</button>`;
}

function headingLinkIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" class="heading-anchor-icon heading-anchor-link lucide lucide-link-icon lucide-link" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
}

function headingCheckIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" class="heading-anchor-icon heading-anchor-check lucide lucide-check-icon lucide-check" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>`;
}

function renderFence(tokens, idx) {
  const token = tokens[idx];
  const { lang, label, lines, highlight, focus, wrap, expandable } = parseCodeInfo(token.info);
  if (lang === "mermaid") return mermaidHtml(token.content);
  const highlighted = renderCodeLines(token.content, lang, { highlight, focus });
  const className = lang ? ` class="language-${escapeAttr(lang)}"` : "";
  const dataLabel = label || lang || "Code";
  const classes = [
    "oc-code",
    lines ? "has-line-numbers" : "",
    wrap ? "is-wrapped" : "",
    expandable ? "is-expandable" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const expandControl = expandable
    ? `<button type="button" class="oc-code-expand" data-code-expand aria-expanded="false">Show more</button>`
    : "";
  return `<figure class="${classes}" data-code-label="${escapeAttr(dataLabel)}"><figcaption><span class="oc-code-label">${escapeHtml(dataLabel)}</span><button type="button" data-code-copy data-copy-label="Copy code" aria-label="Copy code"><span class="oc-visually-hidden">Copy code</span></button></figcaption><pre><code${className}>${highlighted}</code></pre>${expandControl}</figure>`;
}

function parseCodeInfo(rawInfo = "") {
  const info = String(rawInfo).trim();
  const base = {
    lang: "",
    label: "",
    lines: false,
    highlight: new Set(),
    focus: new Set(),
    wrap: false,
    expandable: false,
  };
  if (!info) return base;
  const parts = info.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  base.lang = normalizeLang(parts.shift() ?? "");
  const labelParts = [];
  for (const rawPart of parts) {
    const part = rawPart.replace(/^["']|["']$/g, "");
    if (["lines", "lineNumbers", "numbers"].includes(part)) {
      base.lines = true;
    } else if (part === "wrap") {
      base.wrap = true;
    } else if (part === "expand" || part === "expandable") {
      base.expandable = true;
    } else if (/^\{[^}]+\}$/.test(part)) {
      base.highlight = parseLineSet(part.slice(1, -1));
    } else if (part.startsWith("highlight=")) {
      base.highlight = parseLineSet(part.slice("highlight=".length));
    } else if (part.startsWith("focus=")) {
      base.focus = parseLineSet(part.slice("focus=".length));
    } else if (
      part.startsWith("title=") ||
      part.startsWith("filename=") ||
      part.startsWith("label=")
    ) {
      labelParts.push(part.replace(/^[^=]+=/, ""));
    } else {
      labelParts.push(part);
    }
  }
  base.label = labelParts.join(" ").trim();
  return base;
}

function parseLineSet(raw) {
  const set = new Set();
  for (const piece of String(raw)
    .replace(/[[\]"]/g, "")
    .split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i++) set.add(i);
    } else {
      const line = Number(trimmed);
      if (Number.isFinite(line) && line > 0) set.add(line);
    }
  }
  return set;
}

function renderCodeLines(code, lang, options) {
  const rawLines = String(code).replace(/\n$/, "").split("\n");
  const focusActive = options.focus.size > 0;
  return rawLines
    .map((line, index) => {
      const number = index + 1;
      const classes = [
        "code-line",
        line.startsWith("+") ? "is-added" : "",
        line.startsWith("-") ? "is-removed" : "",
        options.highlight.has(number) ? "is-highlighted" : "",
        focusActive && !options.focus.has(number) ? "is-dimmed" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const content = line ? highlightCode(line, lang) : " ";
      return `<span class="${classes}" data-line="${number}">${content}</span>`;
    })
    .join("");
}

function highlightCode(code, rawLang = "") {
  const lang = normalizeLang(rawLang);
  const language = languageAliases.get(lang) ?? lang;
  if (!language || language === "plaintext") return escapeHtml(code);
  if (hljs.getLanguage(language)) {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  }
  return escapeHtml(code);
}

function normalizeLang(rawLang) {
  return (
    String(rawLang)
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/^language-/, "") ?? ""
  );
}

function mermaidHtml(source) {
  const diagram = String(source).trim();
  return `<figure class="oc-mermaid" data-mermaid="${escapeAttr(diagram)}"><pre><code>${escapeHtml(diagram)}</code></pre></figure>`;
}

export function renderMdxish(markdown, md, options) {
  const { tokens, env } = parseDocsDocument(markdown, md, options);
  return rewriteDocsRelativeLinks(
    postprocess(md.renderer.render(tokens, md.options, env)),
    options,
  );
}

function postprocess(html) {
  const state = {
    cta: [],
    ctaCard: [],
    pullQuote: [],
  };
  return normalizeHtmlAttributes(html)
    .replace(new RegExp(`<p>${markerPrefix}:([^<]+)</p>`, "g"), (_, payload) => {
      const html = expandMarker(payload, state);
      const encodedId = payload.split(":")[2];
      const id = encodedId ? Buffer.from(encodedId, "base64url").toString("utf8") : "";
      return id ? html.replace(/^<[a-z]+/, (tag) => `${tag} id="${escapeAttr(id)}"`) : html;
    })
    .replace(
      /<table>([\s\S]*?)<\/table>/g,
      `<div class="oc-table-wrap"><table class="oc-table">$1</table></div>`,
    )
    .replace(
      new RegExp(`${inlineMarkerPrefix}:([A-Za-z0-9]+):([A-Za-z0-9_-]*):`, "g"),
      (_, kind, encoded) => expandInlineMarker(`${kind}:${encoded}`),
    );
}

function normalizeHtmlAttributes(html) {
  return normalizeSelfClosingHtml(html)
    .replace(/\bclassName=(["'])(.*?)\1/g, 'class="$2"')
    .replace(/\bstyle=\{\{([\s\S]*?)\}\}/g, (_, body) => {
      const style = styleObjectToCss(body);
      return style ? `style="${escapeAttr(style)}"` : "";
    });
}

const htmlVoidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function normalizeSelfClosingHtml(html) {
  return html.replace(/<([a-z][a-z0-9-]*)([^>]*)\s*\/>/gi, (match, tag, attrs) => {
    if (htmlVoidElements.has(tag.toLowerCase())) return match;
    return `<${tag}${attrs}></${tag}>`;
  });
}

function styleObjectToCss(body) {
  const declarations = [];
  const pairPattern =
    /(["']?)(--?[A-Za-z0-9_-]+|[A-Za-z_$][A-Za-z0-9_$-]*)\1\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/g;
  for (const match of body.matchAll(pairPattern)) {
    const key = match[2].startsWith("--")
      ? match[2]
      : match[2].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const value = (match[3] ?? match[4] ?? match[5] ?? "").trim();
    if (value) declarations.push(`${key}: ${value}`);
  }
  return declarations.join("; ");
}

function expandMarker(payload, state = {}) {
  const [kind, encoded = ""] = payload.split(":");
  const value = Buffer.from(encoded, "base64url").toString("utf8");
  if (kind === "blockOpen") return `<div class="oc-${escapeAttr(value)}">`;
  if (kind === "blockClose") return "</div>";
  if (kind === "calloutOpen")
    return `<aside class="oc-callout oc-callout-${slug(value)}"><strong>${escapeHtml(value)}</strong>`;
  if (kind === "calloutClose") return "</aside>";
  if (kind === "chart") return chartHtml(value);
  if (kind === "cardSelf") return cardHtml(value, true);
  if (kind === "cardOpen") return cardHtml(value, false);
  if (kind === "cardClose") return "</div></a>";
  if (kind === "ctaOpen") {
    const attrs = parseAttrs(value);
    state.cta?.push(attrs);
    const tone = slug(attrs.tone ?? attrs.variant ?? "default");
    const eyebrow = attrs.eyebrow ? `<span>${escapeHtml(attrs.eyebrow)}</span>` : "";
    return `<section class="oc-cta oc-cta-${tone}"><div class="oc-cta-copy">${eyebrow}<strong>${escapeHtml(attrs.title ?? "Next step")}</strong>`;
  }
  if (kind === "ctaClose") {
    const attrs = state.cta?.pop() ?? {};
    return `</div>${ctaActions(attrs)}</section>`;
  }
  if (kind === "ctaCardSelf") return ctaCardHtml(value, true);
  if (kind === "ctaCardOpen") {
    const attrs = parseAttrs(value);
    state.ctaCard?.push(attrs);
    return ctaCardHtml(value, false);
  }
  if (kind === "ctaCardClose") {
    const attrs = state.ctaCard?.pop() ?? {};
    return `${ctaActions(attrs, "card")}</div></a>`;
  }
  if (kind === "leadOpen") return `<div class="oc-lead">`;
  if (kind === "leadClose") return "</div>";
  if (kind === "pullQuoteOpen") {
    const attrs = parseAttrs(value);
    state.pullQuote?.push(attrs);
    return `<figure class="oc-pullquote"><blockquote>`;
  }
  if (kind === "pullQuoteClose") {
    const attrs = state.pullQuote?.pop() ?? {};
    return `</blockquote>${attrs.cite ? `<figcaption>${escapeHtml(attrs.cite)}</figcaption>` : ""}</figure>`;
  }
  if (kind === "statSelf") return statHtml(value, true);
  if (kind === "statOpen") return statHtml(value, false);
  if (kind === "statClose") return "</div></section>";
  if (kind === "stepsOpen") return `<div class="oc-steps">`;
  if (kind === "stepsClose") return "</div>";
  if (kind === "stepOpen")
    return `<li class="oc-step"><h3>${escapeHtml(parseAttrs(value).title ?? "Step")}</h3>`;
  if (kind === "stepClose") return "</li>";
  if (kind === "tabOpen")
    return `<section class="oc-tab"><h3>${escapeHtml(parseAttrs(value).title ?? "Tab")}</h3>`;
  if (kind === "tabClose") return "</section>";
  if (kind === "accordionOpen")
    return `<details class="oc-accordion"><summary>${escapeHtml(parseAttrs(value).title ?? "Details")}</summary>`;
  if (kind === "accordionClose") return "</details>";
  if (kind === "panelOpen") {
    const attrs = parseAttrs(value);
    const title = attrs.title ? `<strong>${escapeHtml(attrs.title)}</strong>` : "";
    return `<section class="oc-panel">${title}`;
  }
  if (kind === "panelClose") return "</section>";
  if (kind === "promptOpen") {
    const attrs = parseAttrs(value);
    const title = attrs.title ?? "Prompt";
    return `<section class="oc-prompt"><header><strong>${escapeHtml(title)}</strong><button type="button" data-prompt-copy aria-label="Copy prompt">Copy</button></header>`;
  }
  if (kind === "promptClose") return "</section>";
  if (kind === "mermaidBlock") return mermaidHtml(value);
  if (kind === "frameOpen") {
    const caption = parseAttrs(value).caption;
    return `<figure class="oc-frame">${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}`;
  }
  if (kind === "frameClose") return "</figure>";
  if (kind === "paramOpen") {
    const attrs = parseAttrs(value);
    const required =
      attrs.required !== undefined ? `<span class="oc-param-required">required</span>` : "";
    const type = attrs.type ? `<span class="oc-param-type">${escapeHtml(attrs.type)}</span>` : "";
    const defaultValue = attrs.default
      ? `<span class="oc-param-default">default: ${escapeHtml(attrs.default)}</span>`
      : "";
    return `<section class="oc-param"><header><code>${escapeHtml(attrs.path ?? attrs.name ?? "param")}</code>${type}${defaultValue}${required}</header>`;
  }
  if (kind === "paramClose") return "</section>";
  if (kind === "tileSelf") return tileHtml(value, true);
  if (kind === "tileOpen") return tileHtml(value, false);
  if (kind === "tileClose") return "</div></a>";
  return "";
}

function expandInlineMarker(payload) {
  const [kind, encoded = ""] = payload.split(":");
  const value = Buffer.from(encoded, "base64url").toString("utf8");
  if (kind === "tooltipOpen") {
    const attrs = parseAttrs(value);
    const tip = attrs.tip ?? attrs.title ?? "";
    return `<span class="oc-tooltip" tabindex="0"${tip ? ` data-tip="${escapeAttr(tip)}"` : ""}>`;
  }
  if (kind === "tooltipClose") return "</span>";
  if (kind === "badgeSelf") {
    const attrs = parseAttrs(value);
    return `<span class="oc-badge oc-badge-${slug(attrs.color ?? attrs.variant ?? "default")}">${escapeHtml(attrs.text ?? attrs.label ?? attrs.children ?? "Badge")}</span>`;
  }
  if (kind === "badgeOpen") {
    const attrs = parseAttrs(value);
    return `<span class="oc-badge oc-badge-${slug(attrs.color ?? attrs.variant ?? "default")}">`;
  }
  if (kind === "badgeClose") return "</span>";
  return "";
}

function cardHtml(rawAttrs, selfClosing) {
  const attrs = parseAttrs(rawAttrs);
  const href = attrs.href ?? "#";
  const title = attrs.title ?? attrs.name ?? "Open";
  const icon = attrs.icon ? iconSvg(attrs.icon) : "";
  const end = selfClosing ? "</div></a>" : "";
  return `<a class="oc-card oc-card-interactive" href="${escapeAttr(href)}">${icon}<div><strong>${escapeHtml(title)}</strong>${end}`;
}

function ctaCardHtml(rawAttrs, selfClosing) {
  const attrs = parseAttrs(rawAttrs);
  const href = attrs.href ?? "#";
  const title = attrs.title ?? attrs.name ?? "Open";
  const tone = slug(attrs.tone ?? attrs.variant ?? "default");
  const icon = attrs.icon ? iconSvg(attrs.icon) : "";
  const end = selfClosing ? `${ctaActions(attrs, "card")}</div></a>` : "";
  return `<a class="oc-card oc-card-interactive oc-cta-card oc-cta-card-${tone}" href="${escapeAttr(href)}">${icon}<div><strong>${escapeHtml(title)}</strong>${attrs.kicker ? `<span class="oc-cta-kicker">${escapeHtml(attrs.kicker)}</span>` : ""}${end}`;
}

function ctaActions(attrs, context = "block") {
  const primaryHref = attrs.href ?? attrs.primaryHref;
  const primaryLabel = attrs.label ?? attrs.primaryLabel ?? (primaryHref ? "Open" : "");
  const secondaryHref = attrs.secondaryHref;
  const secondaryLabel = attrs.secondaryLabel ?? (secondaryHref ? "Details" : "");
  const nested = context === "card";
  const links = [
    primaryHref && primaryLabel ? ctaLink(primaryHref, primaryLabel, "primary", nested) : "",
    secondaryHref && secondaryLabel
      ? ctaLink(secondaryHref, secondaryLabel, "secondary", nested)
      : "",
  ]
    .filter(Boolean)
    .join("");
  if (!links) return "";
  return `<div class="oc-cta-actions oc-cta-actions-${escapeAttr(context)}">${links}</div>`;
}

function ctaLink(href, label, variant, nested = false) {
  const actionVariant = variant === "primary" ? "primary" : "secondary";
  const className = `oc-action oc-action-${actionVariant} oc-cta-link oc-cta-link-${escapeAttr(variant)}`;
  return nested
    ? `<span class="${className}" data-href="${escapeAttr(href)}">${escapeHtml(label)}</span>`
    : `<a class="${className}" href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
}

function statHtml(rawAttrs, selfClosing) {
  const attrs = parseAttrs(rawAttrs);
  const value = attrs.value ?? attrs.number ?? "0";
  const label = attrs.label ?? attrs.title ?? "Metric";
  const delta = attrs.delta ? `<span class="oc-stat-delta">${escapeHtml(attrs.delta)}</span>` : "";
  const end = selfClosing ? "</div></section>" : "";
  return `<section class="oc-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span>${delta}<div>${end}`;
}

function chartHtml(rawPayload) {
  const payload = parseJsonPayload(rawPayload);
  const attrs = parseAttrs(payload.attrs ?? "");
  const points = chartPoints(attrs, payload.body ?? "");
  const title = attrs.title ?? "Chart";
  const type = slug(attrs.type ?? "bar");
  const unit = attrs.unit ?? "";
  const max = Math.max(...points.map((point) => point.value), 1);
  const rows = points.map((point) => chartDataRow(point, unit)).join("");
  const chartBody =
    type === "donut"
      ? donutChart(points, unit)
      : type === "line" || type === "area"
        ? lineChart(points, max, unit, { area: type === "area" })
        : barChart(points, max, unit);
  return `<figure class="oc-chart oc-chart-${escapeAttr(type)}"><figcaption><strong>${escapeHtml(title)}</strong>${attrs.subtitle ? `<span>${escapeHtml(attrs.subtitle)}</span>` : ""}</figcaption>${chartBody}<div class="oc-chart-data" role="table" aria-label="${escapeAttr(`${title} data`)}">${rows}</div></figure>`;
}

function parseJsonPayload(value) {
  try {
    return JSON.parse(value);
  } catch {
    return { attrs: value, body: "" };
  }
}

function chartPoints(attrs, body) {
  const labels = splitList(attrs.labels ?? attrs.x ?? "");
  const values = splitList(attrs.values ?? attrs.y ?? "").map(toNumber);
  const fromAttrs = labels
    .map((label, index) => ({ label, value: values[index] }))
    .filter((point) => Number.isFinite(point.value));
  if (fromAttrs.length) return fromAttrs;
  const rows = String(body)
    .trim()
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = rows
    .map((line) => {
      const clean = line.replace(/^[-*]\s+/, "");
      const parts = clean.includes("|") ? clean.split("|") : clean.split(",");
      return { label: parts[0]?.trim() ?? "", value: toNumber(parts[1]) };
    })
    .filter((point) => point.label && Number.isFinite(point.value));
  return parsed.length ? parsed : [{ label: "Value", value: 1 }];
}

function splitList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumber(value) {
  const normalized = String(value ?? "")
    .replace(/[%,$]/g, "")
    .trim();
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : Number.NaN;
}

function barChart(points, max, unit) {
  return `<div class="oc-chart-bars">${points
    .map((point) => {
      const pct = Math.max(3, Math.round((point.value / max) * 100));
      const tip = chartTip(point, unit);
      return `<div class="oc-chart-row"><span>${escapeHtml(point.label)}</span><div class="oc-chart-track"><i class="oc-chart-mark" tabindex="0" style="--oc-chart-value:${pct}%" data-tip="${escapeAttr(tip)}" aria-label="${escapeAttr(tip)}"></i></div><strong>${escapeHtml(formatChartValue(point.value, unit))}</strong></div>`;
    })
    .join("")}</div>`;
}

function lineChart(points, max, unit, options = {}) {
  const width = 640;
  const height = 220;
  const padX = 32;
  const padY = 24;
  const step = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
  const coords = points.map((point, index) => {
    const x = padX + step * index;
    const y = height - padY - (point.value / max) * (height - padY * 2);
    return { ...point, x, y };
  });
  const polyline = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const areaPoints = `${padX},${height - padY} ${polyline} ${width - padX},${height - padY}`;
  const aria = points
    .map((point) => `${point.label}: ${formatChartValue(point.value, unit)}`)
    .join(", ");
  const area = options.area
    ? `<polygon class="oc-chart-area-fill" points="${escapeAttr(areaPoints)}"/>`
    : "";
  return `<div class="oc-chart-line-wrap"><svg class="oc-chart-line-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(aria)}"><path class="oc-chart-gridline" d="M${padX} ${height - padY}H${width - padX}"/>${area}<polyline points="${escapeAttr(polyline)}"/><g>${coords.map((point) => `<circle tabindex="0" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4" aria-label="${escapeAttr(chartTip(point, unit))}"><title>${escapeHtml(chartTip(point, unit))}</title></circle>`).join("")}</g></svg><div class="oc-chart-axis">${points.map((point) => `<span>${escapeHtml(point.label)}</span>`).join("")}</div></div>`;
}

function donutChart(points, unit) {
  const total = points.reduce((sum, point) => sum + Math.max(point.value, 0), 0) || 1;
  const colors = ["var(--brand)", "var(--accent-2)", "#7aa7ff", "#c084fc", "#d97706", "#f472b6"];
  let offset = 0;
  const segments = points
    .map((point, index) => {
      const pct = Math.max(0, (point.value / total) * 100);
      const segment = `<circle class="oc-chart-donut-segment" pathLength="100" cx="110" cy="110" r="72" style="--oc-chart-offset:${offset.toFixed(3)};--oc-chart-share:${pct.toFixed(3)};--oc-chart-tone:${colors[index % colors.length]}" tabindex="0" aria-label="${escapeAttr(chartTip(point, unit))}"><title>${escapeHtml(chartTip(point, unit))}</title></circle>`;
      offset += pct;
      return segment;
    })
    .join("");
  const legend = points
    .map(
      (point, index) =>
        `<span class="oc-chart-donut-key" style="--oc-chart-tone:${colors[index % colors.length]}" tabindex="0" data-tip="${escapeAttr(chartTip(point, unit))}"><i></i><span>${escapeHtml(point.label)}</span><strong>${escapeHtml(formatChartValue(point.value, unit))}</strong></span>`,
    )
    .join("");
  return `<div class="oc-chart-donut-wrap"><svg class="oc-chart-donut-svg" viewBox="0 0 220 220" role="img" aria-label="${escapeAttr(points.map((point) => chartTip(point, unit)).join(", "))}"><circle class="oc-chart-donut-bg" cx="110" cy="110" r="72"/><g transform="rotate(-90 110 110)">${segments}</g><text x="110" y="106" text-anchor="middle">${escapeHtml(formatChartValue(total, unit))}</text><text x="110" y="126" text-anchor="middle">total</text></svg><div class="oc-chart-donut-legend">${legend}</div></div>`;
}

function chartDataRow(point, unit) {
  return `<span role="row"><span role="cell">${escapeHtml(point.label)}</span><span role="cell">${escapeHtml(formatChartValue(point.value, unit))}</span></span>`;
}

function chartTip(point, unit) {
  return `${point.label}: ${formatChartValue(point.value, unit)}`;
}

function formatChartValue(value, unit) {
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${rounded}${unit}`;
}

function tileHtml(rawAttrs, selfClosing) {
  const attrs = parseAttrs(rawAttrs);
  const href = attrs.href ?? "#";
  const title = attrs.title ?? attrs.name ?? "Open";
  const icon = attrs.icon ? iconSvg(attrs.icon) : "";
  const end = selfClosing ? "</div></a>" : "";
  return `<a class="oc-tile" href="${escapeAttr(href)}">${icon}<div><strong>${escapeHtml(title)}</strong>${end}`;
}

// Docs author icons with Lucide names (docs.json declares icons.library "lucide");
// legacy Font Awesome-style names still in the corpus map through ICON_ALIASES.
// Unknown names keep the generic fallback tile so a typo never breaks a build.
const ICON_ALIASES = {
  "arrow-up-right-from-square": "external-link",
  "arrows-rotate": "refresh-cw",
  "arrows-turn-right": "corner-down-right",
  "bars-staggered": "align-left",
  bolt: "zap",
  "car-side": "car",
  "cart-shopping": "shopping-cart",
  "circle-question": "circle-help",
  "cloud-arrow-up": "cloud-upload",
  "code-compare": "git-compare",
  "code-pull-request": "git-pull-request",
  comments: "messages-square",
  compress: "minimize-2",
  couch: "sofa",
  cube: "box",
  desktop: "monitor",
  "diagram-project": "waypoints",
  docker: "container",
  "ear-listen": "ear",
  "file-invoice-dollar": "receipt",
  "file-lines": "file-text",
  fire: "flame",
  flask: "flask-conical",
  gear: "settings",
  gears: "settings",
  grid: "grid-2x2",
  "grid-2": "grid-2x2",
  hashtag: "hash",
  home: "house",
  "house-signal": "house-wifi",
  language: "languages",
  "layer-group": "layers",
  "list-check": "list-checks",
  "magnifying-glass": "search",
  message: "message-square",
  "message-lines": "message-square-text",
  microchip: "cpu",
  microphone: "mic",
  mobile: "smartphone",
  "people-roof": "users",
  "pen-ruler": "pencil-ruler",
  "photo-film": "images",
  "plane-departure": "plane-takeoff",
  print: "printer",
  "puzzle-piece": "puzzle",
  "ranking-star": "trophy",
  ring: "circle",
  robot: "bot",
  "scale-balanced": "scale",
  seedling: "sprout",
  "shield-exclamation": "shield-alert",
  "shield-halved": "shield-half",
  sitemap: "network",
  // Lucide carries no brand marks; hash is the Slack channel metaphor.
  slack: "hash",
  sliders: "sliders-horizontal",
  "square-poll-horizontal": "chart-bar",
  "toggle-on": "toggle-right",
  train: "train-front",
  vial: "test-tube",
  "volume-high": "volume-2",
  "walkie-talkie": "radio",
  "wand-magic-sparkles": "wand-sparkles",
  "waveform-lines": "audio-waveform",
  "window-maximize": "app-window",
  "wine-glass": "wine",
};

const ICON_FALLBACK = `<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 12h8M12 8v8"/>`;
const iconCache = new Map();

function lucideIconBody(kebab) {
  const pascal = kebab
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join("");
  const nodes = lucideIcons[pascal];
  if (!nodes) return null;
  return nodes
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([key, value]) => `${key}="${value}"`)
          .join(" ")}/>`,
    )
    .join("");
}

function iconSvg(name) {
  const key = slug(name);
  let body = iconCache.get(key);
  if (body === undefined) {
    body = lucideIconBody(ICON_ALIASES[key] ?? key) ?? ICON_FALLBACK;
    iconCache.set(key, body);
  }
  return `<svg class="oc-card-icon" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
