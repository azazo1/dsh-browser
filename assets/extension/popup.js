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
        userScripts: false
      });
    }
  }
  element("reconnect").addEventListener("click", () => {
    void chrome.runtime.sendMessage({ kind: "reconnect" }).then(() => {
      void refresh();
    });
  });
  void refresh();
  setInterval(() => {
    void refresh();
  }, 1e3);
})();
