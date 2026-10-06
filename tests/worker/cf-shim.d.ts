// The root type-check has no Cloudflare types. The Durable Object classes are type-checked for real by tsconfig.worker.json;
// these stand-ins only let the Node tests import them.
/* eslint-disable @typescript-eslint/no-explicit-any */
type DurableObjectState = any;
type DurableObjectNamespace = any;
