const http = require("http");
const net = require("net");
const tls = require("tls");
const { URL } = require("url");
const crypto = require("crypto");

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
      "access-control-allow-origin": "*",
    });
    res.end(clientScript);
    return;
  }
  res.writeHead(200, {
    "content-type": "text/plain",
    "access-control-allow-origin": "*",
  });
  res.end("ok");
});
server.on("connection", (socket) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 1000);
});

const controlClients = new Set();

const makeAcceptKey = (key) =>
  crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

const sendWsText = (socket, text) => {
  const payload = Buffer.from(text);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x81;
  socket.write(Buffer.concat([header, payload]));
};

const parseWsFrames = (buffer) => {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let length = byte2 & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength += 2;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength += 8;
    }
    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + (masked ? 4 : 0);
    const frameEnd = payloadOffset + length;
    if (frameEnd > buffer.length) break;
    let payload = buffer.slice(payloadOffset, frameEnd);
    if (masked) {
      const mask = buffer.slice(maskOffset, maskOffset + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }
    if (opcode === 1) {
      messages.push(payload.toString("utf8"));
    } else if (opcode === 8) {
      messages.push(null);
    }
    offset = frameEnd;
  }
  return { messages, remaining: buffer.slice(offset) };
};

const handleControlUpgrade = (req, socket, head) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = makeAcceptKey(key);
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 1000);
  if (head && head.length) {
    socket.unshift(head);
  }
  socket._wsBuffer = Buffer.alloc(0);
  controlClients.add(socket);
  sendWsText(socket, JSON.stringify({ type: "ready" }));
  socket.on("data", (chunk) => {
    socket._wsBuffer = Buffer.concat([socket._wsBuffer, chunk]);
    const { messages, remaining } = parseWsFrames(socket._wsBuffer);
    socket._wsBuffer = remaining;
    for (const message of messages) {
      if (message === null) {
        socket.end();
        return;
      }
      let payload;
      try {
        payload = JSON.parse(message);
      } catch {
        continue;
      }
      socket._controlState = socket._controlState || {};
      if (payload?.type === "settings") {
        socket._controlState.settings = payload.data || {};
      } else if (payload?.type === "input") {
        socket._controlState.input = payload.data || {};
      }
    }
  });
  socket.on("close", () => controlClients.delete(socket));
  socket.on("error", () => controlClients.delete(socket));
};

server.on("upgrade", (req, socket, head) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 1000);
  let requestUrl;
  try {
    requestUrl = new URL(req.url || "/", "http://localhost");
  } catch {
    socket.destroy();
    return;
  }
  if (requestUrl.pathname === "/control") {
    handleControlUpgrade(req, socket, head);
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
  targetSocket.setNoDelay(true);
  targetSocket.setKeepAlive(true, 1000);

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
