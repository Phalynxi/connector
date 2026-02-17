(() => {
  if (window.AbyssConnectorLoaded) return;
  window.AbyssConnectorLoaded = true;

  const connectorHost = "connector-pbv5.onrender.com";
  const defaultConnectorUrl = "wss://connector-pbv5.onrender.com";

  const normalizeUrl = (value) => {
    if (!value) return defaultConnectorUrl;
    if (value.startsWith("https://")) return "wss://" + value.slice(8);
    if (value.startsWith("http://")) return "ws://" + value.slice(7);
    return value;
  };

  const buildConnectorUrl = (originalUrl) => {
    const base = normalizeUrl(window.AbyssConnectorUrl);
    try {
      const url = new URL(base);
      if (!url.searchParams.get("target")) {
        url.searchParams.set("target", originalUrl);
      }
      return url.toString();
    } catch {
      return `${base}?target=${encodeURIComponent(originalUrl)}`;
    }
  };

  const shouldWrap = (url) =>
    typeof url === "string" && !url.includes(connectorHost);

  const wrapWebSocket = () => {
    const CurrentWebSocket = window.WebSocket;
    if (!CurrentWebSocket || CurrentWebSocket.abyssConnectorWrapped) return;
    const WrappedWebSocket = new Proxy(CurrentWebSocket, {
      construct(target, args) {
        const originalUrl = args[0];
        if (shouldWrap(originalUrl)) {
          args[0] = buildConnectorUrl(originalUrl);
        }
        return new target(...args);
      },
    });
    WrappedWebSocket.abyssConnectorWrapped = true;
    window.WebSocket = WrappedWebSocket;
  };

  wrapWebSocket();
  setInterval(wrapWebSocket, 500);
})();
