import type { AiInput, AiPort, BudgetPort, ModelId } from "../../src/agent/ai";

/** Answers in order; an Error answer is thrown. */
export class FakeAi implements AiPort {
  readonly calls: { model: ModelId; input: AiInput }[] = [];
  constructor(private readonly answers: unknown[] = []) {}
  async run(model: ModelId, input: AiInput): Promise<unknown> {
    this.calls.push({ model, input });
    const a = this.answers.shift();
    if (a instanceof Error) throw a;
    return a;
  }
}

export function fakeBudget(limit = Number.POSITIVE_INFINITY) {
  let used = 0;
  const port: BudgetPort = {
    async tryReserve(n: number) {
      if (used + n > limit) return false;
      used += n;
      return true;
    },
  };
  return { port, used: () => used };
}

/** A Workers AI text answer carrying JSON. */
export const json = (value: unknown) => ({ response: JSON.stringify(value) });
