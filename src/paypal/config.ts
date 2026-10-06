export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

export interface PayPalEnv {
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_API_BASE?: string;
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/** Reads the sandbox keys. Never puts a key's value in an error message. */
export function loadConfig(env: PayPalEnv): PayPalConfig {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  const missing = [!clientId && "PAYPAL_CLIENT_ID", !clientSecret && "PAYPAL_CLIENT_SECRET"].filter(Boolean);
  if (!clientId || !clientSecret) throw new Error(`PayPal sandbox keys are missing: set ${missing.join(" and ")} in .dev.vars`);
  const baseUrl = (env.PAYPAL_API_BASE?.trim() || SANDBOX_BASE).replace(/\/+$/, "");
  if (baseUrl !== SANDBOX_BASE) throw new Error(`PAYPAL_API_BASE must be ${SANDBOX_BASE}: this project is sandbox-only`);
  return { clientId, clientSecret, baseUrl };
}
