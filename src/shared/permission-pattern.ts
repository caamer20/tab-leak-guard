type ParsedOriginPattern = {
  scheme: "*" | "http" | "https";
  host: string;
};

/**
 * Return whether one Firefox host-permission grant covers the exact origin
 * pattern the extension wants to monitor. The caller must still register the
 * desired pattern, never the broader grant, so selected-site scope cannot
 * expand accidentally.
 */
export function permissionGrantCoversOrigin(
  grantedPattern: string,
  desiredOrigin: string
): boolean {
  if (grantedPattern === "<all_urls>") return parseOriginPattern(desiredOrigin) !== null;

  const granted = parseOriginPattern(grantedPattern);
  const desired = parseOriginPattern(desiredOrigin);
  if (!granted || !desired) return false;
  if (granted.scheme !== "*" && granted.scheme !== desired.scheme) return false;

  if (desired.host === "*") return granted.host === "*";
  if (granted.host === "*") return true;
  if (granted.host.startsWith("*.")) {
    const suffix = granted.host.slice(2);
    const desiredHostname = hostnameOf(desired.host);
    return desiredHostname === suffix || desiredHostname.endsWith(`.${suffix}`);
  }
  return (
    canonicalHost(granted.host, desired.scheme) ===
    canonicalHost(desired.host, desired.scheme)
  );
}

function parseOriginPattern(value: string): ParsedOriginPattern | null {
  const match = /^(\*|https?):\/\/([^/]+)\/\*$/.exec(value.trim().toLowerCase());
  if (!match) return null;
  const scheme = match[1];
  const host = match[2];
  if ((scheme !== "*" && scheme !== "http" && scheme !== "https") || !host) return null;
  if (host !== "*" && host.includes("*") && !/^\*\.[^*]+$/.test(host)) return null;
  return { scheme, host };
}

function hostnameOf(host: string): string {
  try {
    return new URL(`https://${host}/`).hostname.toLowerCase();
  } catch {
    return host.toLowerCase();
  }
}

function canonicalHost(host: string, scheme: "*" | "http" | "https"): string {
  try {
    const concreteScheme = scheme === "*" ? "https" : scheme;
    return new URL(`${concreteScheme}://${host}/`).host.toLowerCase();
  } catch {
    return host.toLowerCase();
  }
}
