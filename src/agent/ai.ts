import type { AiSource } from "./events";

/**
 * Checked against the live catalogue (GET /ai/models/search) and real calls on 2026-10-06. `small` must accept
 * `response_format: json_schema`: `@cf/meta/llama-3.1-8b-instruct-fp8` rejects it with error 5025 ("This model
 * doesn't support JSON Schema"), which sent every draft to the template. `@cf/meta/llama-3.2-3b-instruct` accepts it.
 */
export const MODELS = {
  big: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  small: "@cf/meta/llama-3.2-3b-instruct",
} as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** ESTIMATES, not measurements (a typical call is roughly 10 to 50 neurons at the catalogue rates): the fixed neuron cost charged to the daily budget per call, set high on purpose. */
export const NEURON_ESTIMATE: Record<ModelId, number> = {
  [MODELS.big]: 150,
  [MODELS.small]: 40,
};

export interface AiMessage {
  role: "system" | "user";
  content: string;
}

export interface AiInput {
  messages: AiMessage[];
  max_tokens: number;
  temperature?: number;
  response_format?: { type: "json_schema"; json_schema: Record<string, unknown> };
}

/** The Workers AI binding, reduced to the one call we make. */
export interface AiPort {
  run(model: ModelId, input: AiInput): Promise<unknown>;
}

export interface BudgetPort {
  tryReserve(neurons: number): Promise<boolean>;
}

export interface AiDeps {
  /** Null when there is no binding (local dev, tests): templates only. */
  ai: AiPort | null;
  budget: BudgetPort;
}

export interface AiResult<T> {
  value: T;
  source: AiSource;
}

export type ModelAnswer = { ok: true; value: unknown } | { ok: false; why: "resting" | "unavailable" };

/** Reserves budget, calls the model, and returns its `response` (parsed as JSON when it is a JSON string). Never throws. */
export async function askModel(deps: AiDeps, model: ModelId, input: AiInput): Promise<ModelAnswer> {
  if (!deps.ai) return { ok: false, why: "unavailable" };
  let reserved: boolean;
  try {
    reserved = await deps.budget.tryReserve(NEURON_ESTIMATE[model]);
  } catch {
    reserved = false;
  }
  if (!reserved) return { ok: false, why: "resting" };
  try {
    const out = await deps.ai.run(model, input);
    const response = out && typeof out === "object" ? (out as { response?: unknown }).response : undefined;
    if (typeof response === "string") {
      try {
        return { ok: true, value: JSON.parse(response) };
      } catch {
        return { ok: true, value: response };
      }
    }
    return response === undefined ? { ok: false, why: "unavailable" } : { ok: true, value: response };
  } catch {
    return { ok: false, why: "unavailable" };
  }
}
