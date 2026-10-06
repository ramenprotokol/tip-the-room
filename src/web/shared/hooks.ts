import type { SignHost, SignView } from "./sign";

/** Test and debug hooks every page publishes on window.__marquee (see reference/v2/README.md). */
export interface MarqueeHooks {
  page: string;
  ready: boolean;
  views: SignView[];
  host?: SignHost | null;
  /** API calls and page actions in flight (parity tests wait for 0). */
  readonly pending?: number;
}

declare global {
  interface Window {
    __marquee: MarqueeHooks;
  }
}

export {};
