const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 3000;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on("connection", (client) => {
    console.log("Client connected!");

    // Echo messages back
    client.on("message", (msg) => {
        console.log("Received from client:", msg.toString());
        client.send(`Server received: ${msg.toString()}`);
    });

    client.on("close", () => {
        console.log("Client disconnected");
    });
});

server.listen(PORT, () => {
    console.log("WebSocket server running on port " + PORT);
});
