// The "For judges" box: a judge types the code from Devpost's private testing instructions, the Worker checks it, and from then on
// the page sends it in a header so the judge draws from the reserved pool of demo copies and AI calls. Never read from the URL.
import type { JudgeCheckResponse } from "../../worker/api-types";
import { ApiFailure, type ApiClient } from "./api";
import { JUDGE_CODE_SHAPE, judgeCode, saveJudgeCode } from "./env";

export interface JudgeBuyer {
  email: string;
  password: string;
}

export interface JudgePassHooks {
  /** The pass is accepted (or still good after a reload). `buyer` is the judges-only sandbox login, or null to keep the public one. */
  onAccepted?(reply: JudgeCheckResponse, fresh: boolean): void;
  /** The pass was removed or the Worker no longer accepts the stored code. */
  onCleared?(): void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

/**
 * Builds the form inside `host`. A code kept from an earlier visit is checked again quietly, so a rotated or removed
 * secret takes effect at once. Every message is set as text.
 */
export function mountJudgePass(host: HTMLElement, api: ApiClient, hooks: JudgePassHooks = {}): { active(): boolean } {
  host.textContent = "";
  let active = false;

  const intro = node("p", "", "Have a judge code? Enter it to use demo copies and AI calls kept back for judges, plus a judges-only sandbox login.");
  const form = node("form", "judge-pass");
  const label = node("label", "sr", "Judge code");
  const input = node("input", "judge-pass-input");
  input.type = "text";
  input.name = "judge-code";
  input.id = "judge-code";
  label.htmlFor = input.id;
  input.placeholder = "Judge code from the Devpost testing instructions";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = 64;
  input.setAttribute("autocapitalize", "off");
  const go = node("button", "btn", "Use judge pass");
  go.type = "submit";
  const drop = node("button", "linkish", "Remove judge pass");
  drop.type = "button";
  drop.hidden = true;
  const say = node("p", "hint", "");
  say.setAttribute("aria-live", "polite");
  form.append(label, input, go, drop);
  host.append(intro, form, say);

  const show = (accepted: boolean, text: string) => {
    active = accepted;
    intro.hidden = accepted;
    input.hidden = go.hidden = accepted;
    drop.hidden = !accepted;
    say.textContent = text;
  };

  async function verify(code: string, fresh: boolean): Promise<void> {
    if (!JUDGE_CODE_SHAPE.test(code.trim())) {
      show(false, "That doesn’t look like a judge code. It is 8 to 64 letters, digits, - or _.");
      return;
    }
    go.disabled = true;
    try {
      const reply = await api.judgeCheck(code.trim());
      saveJudgeCode(code.trim());
      input.value = "";
      show(true, reply.buyer ? "Judge pass active. Start over opens a demo copy from the reserved pool, and the judges-only sandbox login is below." : "Judge pass active. Start over opens a demo copy from the reserved pool.");
      hooks.onAccepted?.(reply, fresh);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 403) saveJudgeCode(null);
      show(false, e instanceof ApiFailure ? e.message : "Something went wrong. Please try again.");
      hooks.onCleared?.();
    } finally {
      go.disabled = false;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void verify(input.value, true);
  });
  drop.addEventListener("click", () => {
    saveJudgeCode(null);
    show(false, "Judge pass removed.");
    hooks.onCleared?.();
  });

  const kept = judgeCode();
  if (kept) void verify(kept, false);
  return { active: () => active };
}
