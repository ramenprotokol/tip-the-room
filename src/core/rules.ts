export type RuleId = "rule-1-hold-only" | "rule-2-capture-at-tip" | "rule-3-void-on-miss" | "rule-4-pay-the-split" | "rule-5-ask-first";

export const RULES: Record<RuleId, { number: 1 | 2 | 3 | 4 | 5; title: string }> = {
  "rule-1-hold-only": { number: 1, title: "Fans are only held, never charged, until the target is reached." },
  "rule-2-capture-at-tip": { number: 2, title: "When the target is reached, charge every hold." },
  "rule-3-void-on-miss": { number: 3, title: "If the deadline passes below the target, cancel every hold." },
  "rule-4-pay-the-split": { number: 4, title: "Pay everyone exactly the split you signed." },
  "rule-5-ask-first": { number: 5, title: "Ask the artist first before changing the deadline or the target, or refunding." },
};
