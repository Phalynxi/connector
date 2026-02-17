const WebSocket = require("ws");

const server = new WebSocket.Server({ port: 3000 });

server.on("connection", (client) => {
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
