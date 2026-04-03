const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const events = require("../lib/events");

const PORT = process.env.PORT || 8080;
const QR_PATH = path.join(process.cwd(), "user_files", "login-qr.png");
const DASHBOARD_HTML = path.join(__dirname, "dashboard.html");

function startWebServer() {
    const server = http.createServer((req, res) => {
        if (req.url === "/qr-img") { // Path for the actual image file
            if (fs.existsSync(QR_PATH)) {
                res.writeHead(200, { "Content-Type": "image/png" });
                fs.createReadStream(QR_PATH).pipe(res);
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("QR not found.");
            }
        } else if (req.url === "/download-qr") {
             if (fs.existsSync(QR_PATH)) {
                res.writeHead(200, { 
                    "Content-Type": "image/png",
                    "Content-Disposition": 'attachment; filename="Mazhar_DevX_Login_QR.png"'
                });
                fs.createReadStream(QR_PATH).pipe(res);
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("QR not found.");
            }
        } else if (req.url === "/" || req.url === "/qr") { // Support both root and /qr as dashboard paths
            // Serve the Elite Dashboard
            if (fs.existsSync(DASHBOARD_HTML)) {
                res.writeHead(200, { "Content-Type": "text/html" });
                fs.createReadStream(DASHBOARD_HTML).pipe(res);
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Dashboard file missing.");
            }
        }
    });

    const io = new Server(server);

    // Socket logic
    io.on("connection", (socket) => {
        // Send initial status request to index.js
        events.emit("request_status");

        socket.on("nuke_session", () => {
            console.warn("🧨 [DASHBOARD] Session Reset Requested.");
            const authDir = path.join(process.cwd(), "auth");
            if (fs.existsSync(authDir)) {
                 fs.rmSync(authDir, { recursive: true, force: true });
                 console.log("✅ [SYSTEM] Session cleared. Restarting...");
                 process.exit(0); // Exit so Railway/PM2 restarts the bot fresh
            }
        });
    });

    // Listen to Global Events
    events.on("wa_message", (data) => io.emit("new_message", { role: "whatsapp", text: data.text }));
    events.on("ai_reply", (data) => io.emit("new_message", { role: "ai", text: data.text }));
    events.on("wa_status", (status) => io.emit("connect_status", { status }));
    events.on("wa_qr", () => io.emit("qr_update"));

    server.listen(PORT, "0.0.0.0", () => {
        console.log("🌐 [SYSTEM] Elite Dashboard running at port " + PORT);
    });
}

module.exports = { startWebServer };
