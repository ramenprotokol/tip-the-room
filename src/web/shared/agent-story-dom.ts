// The agent log's two pieces of structure: per-fan lines folded into one summary row that opens on click, and the
// "Decisions" strip pinned above the log. All text goes in with textContent (backend text never touches innerHTML).
import { AgentLog } from "./ui";
import { buildDecisions, firstCents, groupKind, groupSummary, KIND_WORD, ruleLabel, type Decision, type GroupKind, type GroupStat, type StoryEntry } from "./agent-story";
import { RULES } from "../../core/rules";

export type TaggedEntry = StoryEntry & { tag: string };

interface Group {
  li: HTMLLIElement;
  summary: HTMLElement;
  lines: AgentLog;
  stat: GroupStat;
  kind: GroupKind;
}

export interface StoryOptions {
  /** The show's name for a tag ("a" → "Juniper Vale"). Shown on a decision when the page holds more than one show. */
  name: (tag: string) => string;
  /** More than one show on the page: decisions name their show, and each show gets its own folded rows. */
  multi: boolean;
  /** Fold the per-fan lines. Off for the pixel-parity runs, which compare the log with the reference's. */
  fold: boolean;
  /** Starting fans for a show (the home page knows; the show page does not). */
  starting?: (tag: string) => number | undefined;
  /** Clock time for a decision, in the show's time zone. */
  time: (at: number, tag: string) => string;
  /** Called with the newest decision (or null) each time the strip is rebuilt. */
  onLatest?: (d: Decision | null) => void;
}

export class StoryLog {
  private groups = new Map<string, Group>();
  private shown: TaggedEntry[] = [];
  private seen = new Set<string>();
  constructor(
    private readonly log: AgentLog,
    private readonly strip: HTMLElement,
    private readonly opts: StoryOptions,
  ) {
    this.renderStrip();
  }

  /** Starts over (a fresh copy of the demo, Start over). */
  clear(): void {
    this.log.clear();
    this.groups.clear();
    this.shown = [];
    this.seen.clear();
    this.renderStrip();
  }

  /** The starting-fan counts changed (a new copy): re-word the folded rows. */
  refresh(): void {
    for (const [id, g] of this.groups) g.summary.textContent = groupSummary(g.kind, g.stat, this.opts.starting?.(id.split(":")[1]));
  }

  /**
   * Shows one log entry: folded into its summary row when it repeats once per fan, else as its own line through `line`
   * (which writes it into the log it is given). The Decisions strip is rebuilt either way.
   */
  add(e: TaggedEntry, line: (into: AgentLog, e: TaggedEntry) => void): void {
    const id = `${e.tag}:${e.seq}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.shown.push(e);
    const kind = this.opts.fold ? groupKind(e) : null;
    if (kind) {
      const g = this.group(kind, e.tag);
      g.stat.count += 1;
      g.stat.cents += firstCents(e.did);
      g.summary.textContent = groupSummary(kind, g.stat, this.opts.starting?.(e.tag));
      line(g.lines, e);
    } else line(this.log, e);
    this.renderStrip();
  }

  private group(kind: GroupKind, tag: string): Group {
    const id = `${kind}:${tag}`;
    let g = this.groups.get(id);
    if (g) return g;
    const li = document.createElement("li");
    li.className = "fold";
    li.dataset.tag = tag;
    li.dataset.fold = kind;
    const det = document.createElement("details");
    const summary = document.createElement("span");
    summary.className = "fold-text";
    const sm = document.createElement("summary");
    const mark = document.createElement("span");
    mark.className = "fold-mark";
    mark.setAttribute("aria-hidden", "true");
    const hint = document.createElement("span");
    hint.className = "fold-hint";
    hint.textContent = "Show every line";
    sm.append(mark, summary, hint);
    const ol = document.createElement("ol");
    ol.className = "log fold-lines";
    det.append(sm, ol);
    li.append(det);
    this.log.el.appendChild(li);
    g = { li, summary, lines: new AgentLog(ol), stat: { count: 0, cents: 0 }, kind };
    this.groups.set(id, g);
    return g;
  }

  /** The strip, newest decision first. */
  private renderStrip(): void {
    const list = buildDecisions(this.shown);
    const ol = this.strip.querySelector<HTMLElement>("[data-decisions-list]");
    const empty = this.strip.querySelector<HTMLElement>("[data-decisions-empty]");
    if (!ol) return;
    ol.textContent = "";
    if (empty) empty.hidden = list.length > 0;
    for (const d of list.slice().reverse()) ol.append(this.row(d));
    this.opts.onLatest?.(list.length ? list[list.length - 1] : null);
  }

  private row(d: Decision): HTMLLIElement {
    const li = document.createElement("li");
    li.dataset.kind = d.kind;
    li.dataset.tag = d.tag;
    const kind = document.createElement("span");
    kind.className = "d-kind";
    kind.textContent = KIND_WORD[d.kind];
    const body = document.createElement("span");
    body.className = "d-body";
    const text = document.createElement("span");
    text.className = "d-text";
    text.textContent = d.text;
    const meta = document.createElement("small");
    meta.className = "d-meta";
    const bits: (string | HTMLElement)[] = [this.opts.time(d.at, d.tag)];
    if (this.opts.multi) bits.push(this.opts.name(d.tag));
    if (d.ruleId) {
      const r = document.createElement("span");
      r.className = "d-rule";
      r.textContent = ruleLabel(d.ruleId);
      r.title = RULES[d.ruleId].title;
      bits.push(r);
    }
    if (d.ref) bits.push(`PayPal batch ${d.ref}`);
    bits.forEach((b, i) => {
      if (i) meta.append(" · ");
      meta.append(b);
    });
    body.append(text, meta);
    li.append(kind, body);
    return li;
  }
}
