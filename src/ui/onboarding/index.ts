import {
  localizeDocument,
  requestContinuousPermission,
  sendCommand,
  showMessage,
  t
} from "../client";

const message = required("message");
localizeDocument();
required("continue").addEventListener("click", () => void completeSetup());
required("open-settings").addEventListener("click", () => void browser.runtime.openOptionsPage());
for (const input of document.querySelectorAll<HTMLInputElement>("input[name='scope']")) {
  input.addEventListener("change", updateScopeFields);
}

async function completeSetup(): Promise<void> {
  const button = required("continue") as HTMLButtonElement;
  const scope = document.querySelector<HTMLInputElement>("input[name='scope']:checked")?.value ?? "manual";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    if (scope === "all-sites") {
      const granted = await requestContinuousPermission();
      if (!granted) throw new Error(t("permissionDeniedManualAvailable"));
      await sendCommand({
        type: "UPDATE_PREFERENCES",
        patch: {
          monitoringEnabled: true,
          monitoringIntent: "continuous",
          permissionMode: "all-sites",
          recoveryMode: "notify"
        }
      });
      showSuccess(t("setupAllSitesDescription"));
    } else if (scope === "selected-sites") {
      const originInput = required("selected-site-origin") as HTMLInputElement;
      const origin = normalizeOriginInput(originInput.value);
      if (!origin) {
        originInput.focus();
        throw new Error(t("invalidSiteAddress"));
      }
      const granted = await browser.permissions.request({ origins: [origin] });
      if (!granted) throw new Error(t("selectedSitePermissionDenied"));
      await sendCommand({
        type: "UPDATE_PREFERENCES",
        patch: {
          monitoringEnabled: true,
          monitoringIntent: "continuous",
          permissionMode: "selected-sites",
          selectedOrigins: [origin],
          recoveryMode: "notify"
        }
      });
      showSuccess(t("setupSelectedSiteDescription", displayOrigin(origin)));
    } else {
      await sendCommand({
        type: "UPDATE_PREFERENCES",
        patch: {
          monitoringEnabled: false,
          monitoringIntent: "manual",
          permissionMode: "manual",
          recoveryMode: "notify"
        }
      });
      showSuccess(t("setupManualDescription"));
    }
  } catch (error) {
    showMessage(message, error instanceof Error ? error.message : String(error));
    button.disabled = false;
  } finally {
    button.removeAttribute("aria-busy");
  }
}

function updateScopeFields(): void {
  const selected = document.querySelector<HTMLInputElement>("input[name='scope']:checked")?.value;
  const entry = required("selected-site-entry");
  const input = required("selected-site-origin") as HTMLInputElement;
  entry.hidden = selected !== "selected-sites";
  input.required = selected === "selected-sites";
  if (selected === "selected-sites") input.focus();
}

function normalizeOriginInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return null;
  try {
    const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const authority = /^https?:\/\/([^/]+)/i.exec(candidate)?.[1];
    if (!authority || authority.includes(":")) return null;
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      parsed.hostname.includes("*")
    ) return null;
    return `${parsed.protocol}//${parsed.host.toLowerCase()}/*`;
  } catch {
    return null;
  }
}

function displayOrigin(origin: string): string {
  try {
    const parsed = new URL(origin.replace(/\/\*$/, "/"));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return origin;
  }
}

function showSuccess(description: string): void {
  const success = required("success");
  required("success-description").textContent = description;
  success.hidden = false;
  success.focus();
  required("continue").setAttribute("hidden", "");
  for (const input of document.querySelectorAll<HTMLInputElement>("input[name='scope']")) {
    input.disabled = true;
  }
}

function required(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node;
}
