/// <reference types="vite/client" />

/** Public build-time settings (never secrets). See .env.example. */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_PAYPAL_CLIENT_ID?: string;
  readonly VITE_PUBLIC_ORIGIN?: string;
  readonly VITE_SANDBOX_BUYER_EMAIL?: string;
  readonly VITE_SANDBOX_BUYER_PASSWORD?: string;
  readonly VITE_E2E_HOOKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
