(() => {
  // extension/src/panel/popup.ts
  function element(id) {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`popup \u7F3A\u5C11\u5143\u7D20 #${id}`);
    return found;
  }
  function render(status) {
    const dot = element("dot");
    const headline = element("headline");
    const detail = element("detail");
    const binding = element("binding");
    const capabilities = element("capabilities");
    if (status.linked) {
      dot.className = "dot ok";
      headline.textContent = "\u5DF2\u8FDE\u63A5\u5230 dsh";
      detail.textContent = `\u901A\u9053: native messaging (${status.hostName})`;
    } else if (status.hostConnected) {
      dot.className = "dot warn";
      headline.textContent = "\u5DF2\u8FDE\u4E0A\u672C\u5730\u7EC4\u4EF6, \u4F46 dsh \u672A\u5C31\u7EEA";
      detail.textContent = 'native host \u6B63\u5728\u91CD\u8BD5\u8FDE\u63A5 dsh. \u8BF7\u786E\u8BA4 dsh \u6B63\u5728\u8FD0\u884C, \u5E76\u5728\u63D2\u4EF6\u914D\u7F6E\u9875\u70B9\u4E00\u4E0B"\u5B89\u88C5\u8FDE\u63A5\u7EC4\u4EF6".';
    } else {
      dot.className = "dot bad";
      headline.textContent = "\u672A\u8FDE\u63A5";
      detail.textContent = status.lastError ?? "\u6B63\u5728\u5EFA\u7ACB\u8FDE\u63A5...";
    }
    binding.textContent = status.boundTabId === null ? "\u5C1A\u672A\u7ED1\u5B9A\u6807\u7B7E\u9875" : `\u5DF2\u7ED1\u5B9A\u6807\u7B7E\u9875 #${status.boundTabId}`;
    const pairingState = element("pairing-state");
    if (status.pairingError !== null) {
      pairingState.className = "pairing-state bad";
      pairingState.textContent = `dsh \u62D2\u7EDD\u4E86\u914D\u5BF9: ${status.pairingError}`;
    } else if (status.linked) {
      pairingState.className = "pairing-state ok";
      pairingState.textContent = "dsh \u5DF2\u63A5\u53D7\u914D\u5BF9.";
    } else {
      pairingState.className = "pairing-state";
      pairingState.textContent = "\u5C55\u5F00\u914D\u5BF9\u4EE4\u724C, \u590D\u5236\u540E\u586B\u8FDB dsh \u7684 pairingToken, \u8FDE\u63A5\u4F1A\u81EA\u52A8\u6062\u590D.";
    }
    const tokenElement = element("pairing-token");
    tokenElement.textContent = status.pairingToken === "" ? "\u8BFB\u53D6\u4E2D..." : status.pairingToken;
    capabilities.textContent = status.userScripts ? "\u6D4F\u89C8\u5668\u6C42\u503C: \u53EF\u7528" : "\u6D4F\u89C8\u5668\u6C42\u503C: \u672A\u542F\u7528 (\u5728\u6269\u5C55\u8BE6\u60C5\u9875\u6253\u5F00 Allow User Scripts)";
  }
  async function refresh() {
    try {
      const status = await chrome.runtime.sendMessage({ kind: "status" });
      render(status);
    } catch (error) {
      render({
        hostConnected: false,
        linked: false,
        lastError: `\u65E0\u6CD5\u8BE2\u95EE\u540E\u53F0: ${String(error)}`,
        attempts: 0,
        boundTabId: null,
        hostName: "unknown",
        userScripts: false,
        pairingError: null,
        pairingToken: ""
      });
    }
  }
  element("reconnect").addEventListener("click", () => {
    void chrome.runtime.sendMessage({ kind: "reconnect" }).then(() => {
      void refresh();
    });
  });
  element("copy-pairing").addEventListener("click", () => {
    const token = element("pairing-token").textContent ?? "";
    if (token === "" || token === "\u8BFB\u53D6\u4E2D...") return;
    void navigator.clipboard.writeText(token).then(() => {
      element("pairing-state").className = "pairing-state ok";
      element("pairing-state").textContent = "\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F, \u7C98\u8D34\u5230 dsh \u7684 pairingToken \u5373\u53EF.";
    }, () => {
      element("pairing-state").className = "pairing-state";
      element("pairing-state").textContent = "\u81EA\u52A8\u590D\u5236\u4E0D\u53EF\u7528, \u8BF7\u624B\u52A8\u9009\u4E2D\u4E0A\u9762\u7684\u4EE4\u724C\u590D\u5236.";
    });
  });
  element("reset-pairing").addEventListener("click", () => {
    void chrome.runtime.sendMessage({ kind: "reset-pairing" }).then(() => {
      void refresh();
    });
  });
  void refresh();
  setInterval(() => {
    void refresh();
  }, 1e3);
})();
