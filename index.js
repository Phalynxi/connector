const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 3000;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on("connection", (client) => {
    const gameSocket = new WebSocket("wss://moomoo.io");

    client.on("message", (msg) => {
        if (gameSocket.readyState === WebSocket.OPEN)
            gameSocket.send(msg);
    });

    gameSocket.on("message", (msg) => {
        if (client.readyState === WebSocket.OPEN)
            client.send(msg);
    });
});

server.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
