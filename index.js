const http = require("http");
const net = require("net");
const tls = require("tls");
const { URL } = require("url");

const clientScript = `(() => {
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
      return \`\${base}?target=\${encodeURIComponent(originalUrl)}\`;
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
})();`;

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("/index.js")) {
    res.writeHead(200, {
      "content-type": "application/javascript",
      "cache-control": "no-store",
    });
    res.end(clientScript);
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

server.on("upgrade", (req, socket, head) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url || "/", "http://localhost");
  } catch {
    socket.destroy();
    return;
  }

  const target = requestUrl.searchParams.get("target");
  if (!target) {
    socket.destroy();
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    socket.destroy();
    return;
  }

  const isSecure = targetUrl.protocol === "wss:";
  const port = targetUrl.port ? Number(targetUrl.port) : isSecure ? 443 : 80;
  const connect = isSecure ? tls.connect : net.connect;
  const targetSocket = connect({
    host: targetUrl.hostname,
    port,
    servername: targetUrl.hostname,
  });

  targetSocket.on("error", () => socket.destroy());
  socket.on("error", () => targetSocket.destroy());

  targetSocket.on("connect", () => {
    const headers = Object.assign({}, req.headers);
    headers.host = targetUrl.host;
    const path = targetUrl.pathname + (targetUrl.search || "");
    const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        value.forEach((v) => lines.push(`${key}: ${v}`));
      } else if (value !== undefined) {
        lines.push(`${key}: ${value}`);
      }
    }
    lines.push("\r\n");
    targetSocket.write(lines.join("\r\n"));
    if (head && head.length) {
      targetSocket.write(head);
    }
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });
});

const port = process.env.PORT ? Number(process.env.PORT) : 10000;
server.listen(port, "0.0.0.0");
