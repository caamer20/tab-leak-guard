import { createConnection } from "node:net";

// Marionette is connected only to the disposable Firefox profile created by
// headless-smoke.mjs. No personal profile or additional npm dependency is used.
export async function checkFirefoxPopup(port, extensionId) {
  const socket = await new Promise((resolve, reject) => {
    const connection = createConnection({ host: "127.0.0.1", port });
    connection.once("connect", () => resolve(connection));
    connection.once("error", reject);
  });
  let buffer = Buffer.alloc(0);
  let sequence = 0;
  const pending = new Map();
  const fail = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Marionette connection closed")));
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const colon = buffer.indexOf(58);
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon).toString());
      if (!Number.isSafeInteger(length) || length < 0) {
        fail(new Error("Invalid Marionette frame"));
        socket.destroy();
        return;
      }
      if (buffer.length < colon + 1 + length) return;
      const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString());
      buffer = buffer.subarray(colon + 1 + length);
      if (!Array.isArray(message)) continue; // Initial protocol greeting.
      const [, id, error, result] = message;
      const request = pending.get(id);
      if (!request) continue;
      pending.delete(id);
      if (error) request.reject(new Error(JSON.stringify(error)));
      else request.resolve(result);
    }
  });
  function command(name, parameters = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${name} timed out`));
      }, 20_000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); }
      });
      const payload = JSON.stringify([0, id, name, parameters]);
      socket.write(`${Buffer.byteLength(payload)}:${payload}`);
    });
  }
  try {
    await command("WebDriver:NewSession", { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
    await command("Marionette:SetContext", { value: "chrome" });
    const result = await command("WebDriver:ExecuteAsyncScript", {
      args: [extensionId],
      scriptTimeout: 15_000,
      script: `
        const id = arguments[0];
        const done = arguments[arguments.length - 1];
        (async () => {
          const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
          const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
          const { BasePopup } = ChromeUtils.importESModule("resource:///modules/ExtensionPopups.sys.mjs");
          const extension = ExtensionParent.GlobalManager.getExtension(id);
          const action = ExtensionParent.apiManager.global.browserAction.for(extension);
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          CustomizableUI.addWidgetToArea(action.id, CustomizableUI.AREA_NAVBAR);
          win.focus();
          await action.openPopup(win);
          const deadline = Date.now() + 10000;
          let popup;
          while (Date.now() < deadline) {
            popup = BasePopup.for(extension, win);
            if (popup?.dimensions && popup.browser?.getBoundingClientRect().height > 0) break;
            await new Promise(resolve => win.setTimeout(resolve, 100));
          }
          if (!popup?.browser) throw new Error("Toolbar popup did not open");
          await popup.contentReady;
          await new Promise(resolve => win.setTimeout(resolve, 1000));
          const rect = popup.browser.getBoundingClientRect();
          const page = await new Promise((resolve, reject) => {
            const mm = popup.browser.messageManager;
            const name = "TabLeakGuard:PopupSmoke";
            const timeout = win.setTimeout(() => {
              mm.removeMessageListener(name, listener);
              reject(new Error("Popup content inspection timed out"));
            }, 3000);
            function listener(message) {
              win.clearTimeout(timeout);
              mm.removeMessageListener(name, listener);
              resolve(message.data);
            }
            mm.addMessageListener(name, listener);
            const inspect = function () {
              const doc = content.document;
              const settings = doc.querySelector("#settings");
              const button = settings?.getBoundingClientRect();
              sendAsyncMessage("TabLeakGuard:PopupSmoke", {
                heading: doc.querySelector("h1")?.textContent,
                status: doc.querySelector("#monitoring-state-title")?.textContent,
                width: content.innerWidth,
                bodyWidth: doc.body.getBoundingClientRect().width,
                settingsVisible: !!button && button.width > 0 && button.left >= 0 && button.right <= content.innerWidth
              });
            };
            mm.loadFrameScript("data:application/javascript," + encodeURIComponent("(" + inspect.toString() + ")()"), false);
          });
          const dimensions = { width: rect.width, height: rect.height, page };
          popup.closePopup();
          return dimensions;
        })().then(done, error => done({ error: String(error), stack: error.stack }));
      `
    });
    const dimensions = result.value;
    if (dimensions?.error) throw new Error(JSON.stringify(dimensions));
    if (!(dimensions?.width >= 400 && dimensions.width <= 460 && dimensions.height >= 400)) {
      throw new Error(`Collapsed or clipped Firefox toolbar popup: ${JSON.stringify(dimensions)}`);
    }
    if (dimensions.page?.heading !== "Resource monitor" || !dimensions.page?.settingsVisible ||
        !dimensions.page?.status || dimensions.page.status === "Checking monitoring…") {
      throw new Error(`Firefox popup content did not render correctly: ${JSON.stringify(dimensions)}`);
    }
    return dimensions;
  } finally {
    await command("WebDriver:DeleteSession").catch(() => undefined);
    socket.destroy();
  }
}
