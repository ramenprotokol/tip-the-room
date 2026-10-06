/** Dev and preview servers serve the same routes as Cloudflare Pages' public/_redirects. */
export function rewritePagePath(url: string): string {
  const q = url.indexOf("?");
  const path = q < 0 ? url : url.slice(0, q);
  const search = q < 0 ? "" : url.slice(q);
  if (/^\/s\/[^/]+\/manage\/?$/.test(path)) return `/manage.html${search}`;
  if (/^\/s\/[^/]+\/?$/.test(path)) return `/pledge.html${search}`;
  if (path === "/start" || path === "/start/") return `/start.html${search}`;
  return url;
}
