import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

const POPUP_SOURCE = readFileSync(
  new URL("../../src/ui/popup/index.ts", import.meta.url),
  "utf8"
);

const POPUP_FUNCTIONS = [
  "executePreparedRecovery",
  "closeRecoveryDialog",
  "cancelRecoveryDialog",
  "expireRecoveryDialog",
  "handleDialogCancel",
  "cleanup"
] as const;

interface PopupHarness {
  commands: Array<Record<string, unknown>>;
  messages: unknown[][];
  executePreparedRecovery(): Promise<void>;
  cancelRecoveryDialog(): Promise<void>;
  expireRecoveryDialog(): Promise<void>;
  handleDialogCancel(event: Event): void;
  cleanup(): void;
  setCancelling(): void;
  state(): { executing: boolean; cancelling: boolean } | null;
}

function buildPopupHarness(): PopupHarness {
  const declarations = new Map<string, string>();
  for (const name of POPUP_FUNCTIONS) {
    const startMatch = new RegExp(`^(?:async\\s+)?function\\s+${name}\\b`, "m").exec(
      POPUP_SOURCE
    );
    if (!startMatch) continue;
    const tail = POPUP_SOURCE.slice(startMatch.index);
    const endMatch = /^\}/m.exec(tail);
    if (!endMatch) continue;
    declarations.set(name, tail.slice(0, endMatch.index + 1));
  }
  expect([...declarations.keys()].sort()).toEqual([...POPUP_FUNCTIONS].sort());

  const harnessSource = `
    function makeHarness() {
      const commands = [];
      const messages = [];
      let dialogState = {
        preparation: {
          operationId: "operation-1234",
          nonce: "nonce-1234",
          tabId: 1,
          action: "discard",
          expiresAt: Date.now() + 60_000,
          requiresUserEditAcknowledgement: false
        },
        returnFocusKey: null,
        timer: 7,
        announcedTenSeconds: false,
        executing: false,
        cancelling: false
      };
      let deferredRenderTimer;
      const executionResult = new Promise(() => undefined);
      const acknowledgement = { checked: false, focus() {} };
      const liveRegion = { textContent: "" };
      const dialog = { open: true, close() { this.open = false; } };
      const window = { clearInterval() {}, clearTimeout() {} };
      const browser = {
        runtime: {
          sendMessage(command) {
            commands.push(command);
            return Promise.resolve({ ok: true, data: null });
          }
        },
        storage: { onChanged: { removeListener() {} } }
      };
      function requiredInput() { return acknowledgement; }
      function required() { return liveRegion; }
      function updateExecuteButton() {}
      function restoreFocus() {}
      function stopLiveRefresh() {}
      function handleStorageChange() {}
      function t(key) { return key; }
      function showMessage(...args) { messages.push(args); }
      function render() { return Promise.resolve(); }
      function errorText(error) { return String(error); }
      function sendCommand(command) {
        commands.push(command);
        if (command.type === "EXECUTE_RECOVERY") return executionResult;
        return Promise.resolve(null);
      }
      ${POPUP_FUNCTIONS.map((name) => declarations.get(name)).join("\n")}
      return {
        commands,
        messages,
        executePreparedRecovery,
        cancelRecoveryDialog,
        expireRecoveryDialog,
        handleDialogCancel,
        cleanup,
        setCancelling() { dialogState.cancelling = true; },
        state() { return dialogState; }
      };
    }
  `;
  const output = transformSync(harnessSource, {
    loader: "ts",
    target: "es2022",
    format: "esm"
  }).code;
  return new Function(`${output}\nreturn makeHarness();`)() as PopupHarness;
}

describe("popup recovery authority boundaries", () => {
  it("ignores cancel, Escape, expiry, and pagehide while execution is in flight", async () => {
    const harness = buildPopupHarness();

    void harness.executePreparedRecovery();
    expect(harness.state()).toMatchObject({ executing: true, cancelling: false });
    expect(harness.commands).toEqual([
      {
        type: "EXECUTE_RECOVERY",
        operationId: "operation-1234",
        nonce: "nonce-1234",
        acknowledgeUserEditRisk: false
      }
    ]);

    await harness.cancelRecoveryDialog();
    const escape = { preventDefault: vi.fn() } as unknown as Event;
    harness.handleDialogCancel(escape);
    await harness.expireRecoveryDialog();
    harness.cleanup();

    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(harness.commands).toHaveLength(1);
    expect(harness.messages).toEqual([]);
    expect(harness.state()).toBeNull();
  });

  it("does not send a second cancellation during pagehide cleanup", () => {
    const harness = buildPopupHarness();
    harness.setCancelling();

    harness.cleanup();

    expect(harness.commands).toEqual([]);
    expect(harness.messages).toEqual([]);
    expect(harness.state()).toBeNull();
  });
});
