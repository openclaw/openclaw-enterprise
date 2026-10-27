const citationOpen = "<oai-mem-citation>";
const citationClose = "</oai-mem-citation>";
const planOpen = "<proposed_plan>";
const planClose = "</proposed_plan>";
const whitespace = /\p{White_Space}/u;

// Literal, non-nested citations retain only a possible delimiter across pushes.
class CitationProjection {
  private pending = "";
  private hidden = false;

  push(text: string): string {
    const input = this.pending + text;
    const visible: string[] = [];
    let start = 0;
    this.pending = "";
    while (start < input.length) {
      const tag = this.hidden ? citationClose : citationOpen;
      const next = input.indexOf(tag, start);
      if (next !== -1) {
        if (!this.hidden) {
          visible.push(input.slice(start, next));
        }
        this.hidden = !this.hidden;
        start = next + tag.length;
        continue;
      }
      let keep = Math.min(tag.length - 1, input.length - start);
      while (keep > 0 && !input.endsWith(tag.slice(0, keep))) {
        keep--;
      }
      if (!this.hidden) {
        visible.push(input.slice(start, input.length - keep));
      }
      this.pending = input.slice(input.length - keep);
      break;
    }
    return visible.join("");
  }

  finish(): string {
    const tail = this.hidden ? "" : this.pending;
    this.pending = "";
    return tail;
  }
}

export function withoutCitations(text: string): string {
  if (!text.includes(citationOpen)) {
    return text;
  }
  const parser = new CitationProjection();
  return parser.push(text) + parser.finish();
}

interface PlanConsumer {
  start: () => void;
  delta: (text: string) => void;
}

// Match standalone lines, buffering only while a line could still be a tag.
// Slug is bounded by the tag length; whitespace never causes prefix rescanning.
class PlanProjection {
  private active = false;
  private detecting = true;
  private line: string[] = [];
  private slug = "";
  private trailingWhitespace = false;
  private readonly consumer: PlanConsumer;

  constructor(consumer: PlanConsumer) {
    this.consumer = consumer;
  }

  push(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (!this.detecting) {
        if (ch === "\n") {
          this.emit(text.slice(start, i + 1));
          start = i + 1;
          this.detecting = true;
        }
        continue;
      }
      if (ch === "\n") {
        this.line.push(text.slice(start, i + 1));
        start = i + 1;
        this.finishLine();
      } else if (whitespace.test(ch)) {
        this.trailingWhitespace = this.slug !== "";
      } else {
        this.slug += ch;
        if (
          this.trailingWhitespace ||
          (!planOpen.startsWith(this.slug) && !planClose.startsWith(this.slug))
        ) {
          this.line.push(text.slice(start, i + 1));
          this.emit(this.line.join(""));
          this.resetLine();
          this.detecting = false;
          start = i + 1;
        }
      }
    }
    if (this.detecting) {
      if (start < text.length) {
        this.line.push(text.slice(start));
      }
    } else {
      this.emit(text.slice(start));
    }
  }

  finish(): void {
    this.finishLine();
    this.active = false;
  }

  private emit(text: string): void {
    if (this.active && text !== "") {
      this.consumer.delta(text);
    }
  }

  private finishLine(): void {
    if (!this.active && this.slug === planOpen) {
      this.active = true;
      this.consumer.start();
    } else if (this.active && this.slug === planClose) {
      this.active = false;
    } else {
      this.emit(this.line.join(""));
    }
    this.resetLine();
  }

  private resetLine(): void {
    this.line = [];
    this.slug = "";
    this.trailingWhitespace = false;
  }
}

// Completed Plan selects the last raw block BEFORE citation removal. A citation
// outside the block must not hide a plan that the completed-message reader sees.
export function completedAssistantPlan(text: string): string | undefined {
  if (!text.includes(planOpen)) {
    return undefined;
  }
  let chunks: string[] | undefined;
  const parser = new PlanProjection({
    start: () => {
      chunks = [];
    },
    delta: (text) => {
      chunks?.push(text);
    },
  });
  parser.push(text);
  parser.finish();
  return chunks === undefined ? undefined : withoutCitations(chunks.join(""));
}

// Incremental Plan does the opposite: strip citations, then recognize line tags.
// A close ends a block, but does not complete the response-owned Plan lifecycle.
export class AssistantPlanStream {
  private readonly citations = new CitationProjection();
  private readonly plan: PlanProjection;

  constructor(delta: (text: string) => void) {
    this.plan = new PlanProjection({ start: () => {}, delta });
  }

  push(text: string): void {
    this.plan.push(this.citations.push(text));
  }

  finish(): void {
    this.plan.push(this.citations.finish());
    this.plan.finish();
  }
}
