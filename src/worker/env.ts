/** The Workers AI binding, reduced to the one call we make. */
export interface WorkersAiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

/** Bindings and vars for the Worker and its Durable Objects. Secrets come from .dev.vars locally (never printed). */
export interface Env {
  CAMPAIGN: DurableObjectNamespace;
  QUOTA: DurableObjectNamespace;
  AI?: WorkersAiBinding;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_API_BASE?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_RECEIVER_ROOM?: string;
  PAYPAL_RECEIVER_OPENER?: string;
  PAYPAL_RECEIVER_ARTIST?: string;
  ALLOWED_ORIGINS?: string;
  RATE_SALT?: string;
}
