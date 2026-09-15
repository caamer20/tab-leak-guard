import { MONITORED_ORIGINS } from "../shared/constants";
import type { CommandResponse, ExtensionSnapshot, UiCommand } from "../shared/types";

const messageTimers = new WeakMap<HTMLElement, number>();

export async function sendCommand<T = unknown>(command: UiCommand): Promise<T> {
  const response = (await browser.runtime.sendMessage(command)) as CommandResponse<T>;
  if (!response?.ok) throw new Error(response?.error ?? t("errorExtensionDidNotRespond"));
  return response.data;
}

export function getSnapshot(): Promise<ExtensionSnapshot> {
  return sendCommand<ExtensionSnapshot>({ type: "GET_SNAPSHOT" });
}

export async function requestContinuousPermission(): Promise<boolean> {
  const granted = await browser.permissions.request({ origins: [...MONITORED_ORIGINS] });
  await sendCommand({ type: "SYNC_PERMISSION" });
  return granted;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function t(key: string, substitutions?: string | string[]): string {
  const translated = browser.i18n.getMessage(key, substitutions);
  return translated || key;
}

export function localizeDocument(root: ParentNode = document): void {
  document.documentElement.lang = browser.i18n.getUILanguage() || "en";
  const direction = browser.i18n.getMessage("@@bidi_dir");
  if (direction === "ltr" || direction === "rtl") document.documentElement.dir = direction;

  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = node.dataset.i18nTitle;
    if (key) node.title = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    const key = node.dataset.i18nAriaLabel;
    if (key) node.setAttribute("aria-label", t(key));
  }
  for (const node of root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    const key = node.dataset.i18nPlaceholder;
    if (key) node.placeholder = t(key);
  }
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  const formatter = new Intl.RelativeTimeFormat(browser.i18n.getUILanguage(), { numeric: "auto" });
  if (elapsedSeconds < 60) return formatter.format(-elapsedSeconds, "second");
  const minutes = Math.round(elapsedSeconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.round(hours / 24), "day");
}

export function formatFutureTime(timestamp: number, now = Date.now()): string {
  const remainingSeconds = Math.max(0, Math.ceil((timestamp - now) / 1_000));
  if (remainingSeconds < 60) {
    return t(remainingSeconds === 1 ? "timeOneSecondRemaining" : "timeSecondsRemaining", String(remainingSeconds));
  }
  const minutes = Math.ceil(remainingSeconds / 60);
  return t(minutes === 1 ? "timeOneMinuteRemaining" : "timeMinutesRemaining", String(minutes));
}

export function showMessage(
  target: HTMLElement,
  message: string,
  kind: "error" | "success" | "info" = "error",
  options: { autoHide?: boolean; timeoutMs?: number } = {}
): void {
  clearMessageTimer(target);
  target.textContent = message;
  target.dataset.kind = kind;
  target.setAttribute("role", kind === "error" ? "alert" : "status");
  target.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  target.hidden = false;

  const autoHide = options.autoHide ?? kind !== "error";
  if (!autoHide) return;
  const timer = window.setTimeout(() => {
    if (messageTimers.get(target) !== timer) return;
    target.hidden = true;
    messageTimers.delete(target);
  }, options.timeoutMs ?? 5_000);
  messageTimers.set(target, timer);
}

export function clearMessage(target: HTMLElement): void {
  clearMessageTimer(target);
  target.hidden = true;
  target.textContent = "";
}

function clearMessageTimer(target: HTMLElement): void {
  const timer = messageTimers.get(target);
  if (timer !== undefined) window.clearTimeout(timer);
  messageTimers.delete(target);
}
