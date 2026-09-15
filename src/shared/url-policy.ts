export type UrlSupport = { supported: true; hostname: string } | { supported: false; reason: string };

// Firefox blocks extension script injection on these Mozilla-owned origins
// even when a matching host permission or activeTab grant exists.
const FIREFOX_RESTRICTED_HOSTS = new Set([
  "accounts-static.cdn.mozilla.net",
  "accounts.firefox.com",
  "addons.cdn.mozilla.net",
  "addons.mozilla.org",
  "api.accounts.firefox.com",
  "content.cdn.mozilla.net",
  "discovery.addons.mozilla.org",
  "install.mozilla.org",
  "oauth.accounts.firefox.com",
  "profile.accounts.firefox.com",
  "support.mozilla.org",
  "sync.services.mozilla.com"
]);

export function inspectUrl(rawUrl: string | undefined): UrlSupport {
  if (!rawUrl) return { supported: false, reason: "Tab URL is unavailable" };
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { supported: false, reason: `The ${url.protocol} scheme cannot be monitored` };
    }
    const hostname = url.hostname.toLowerCase();
    if (FIREFOX_RESTRICTED_HOSTS.has(hostname)) {
      return { supported: false, reason: "Firefox does not allow extensions to monitor this site" };
    }
    return { supported: true, hostname };
  } catch {
    return { supported: false, reason: "Tab URL is invalid" };
  }
}

export function normalizeHostname(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized || normalized.length > 253 || /[^a-z0-9.:-]/i.test(normalized)) return null;
  return normalized;
}
