const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const events = require("../lib/events");
const { setAdminPrompt, toggleUserAi, getAllContacts, getFullHistory, addAdminMessageToMemory, setUserSpecificPrompt } = require("./ai");




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
        } else if (req.url.startsWith("/media/profiles/")) {
            const fileName = req.url.split("/").pop();
            const filePath = path.join(process.cwd(), "user_files", "profiles", fileName);
            if (fs.existsSync(filePath)) {
                res.writeHead(200, { "Content-Type": "image/jpeg" });
                fs.createReadStream(filePath).pipe(res);
            } else {
                res.writeHead(404);
                res.end("Profile pic not found");
            }
        } else if (req.url.startsWith("/media/")) {
            const fileName = req.url.split("/").pop();
            const filePath = path.join(process.cwd(), "user_files", fileName);
            if (fs.existsSync(filePath)) {
                res.writeHead(200);
                fs.createReadStream(filePath).pipe(res);
            } else {
                res.writeHead(404);
                res.end("Media not found");
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

        socket.on("admin_reply", async (data) => {
            console.log(`📩 [DASHBOARD] Replying to ${data.jid}: ${data.text}`);
            
            // 🛡️ SMART PAUSE: We pause the AI for 30 seconds (Ultra Performance)
            // so the admin can send a message without the bot replying immediately.
            const thirtySeconds = 30 * 1000;
            stopAiStatus.set(data.jid, Date.now() + thirtySeconds);
            
            await addAdminMessageToMemory(data.jid, data.text);
            events.emit("send_whatsapp", data);
        });

        socket.on("override_user_ai", (data) => {
            console.log(`👑 [MASTER OVERRIDE] Target: ${data.jid}. Rule: ${data.prompt}`);
            setUserSpecificPrompt(data.jid, data.prompt);
            socket.emit("get_contacts"); // Refresh UI
        });

        socket.on("toggle_ai", (data) => {
            toggleUserAi(data.jid, data.status);
        });

        socket.on("get_contacts", async () => {
            const contacts = await getAllContacts();
            socket.emit("contact_list", contacts);
        });

        socket.on("load_chat", async (data) => {
            const history = await getFullHistory(data.jid);
            socket.emit("chat_history", { jid: data.jid, history: history });
        });

        socket.on("update_ai_prompt", (data) => {
            setAdminPrompt(data.prompt);
        });



        // Periodic Telemetry
        const telemetryTimer = setInterval(() => {
            const mem = process.memoryUsage();
            socket.emit("telemetry", {
                rss: (mem.rss / 1024 / 1024).toFixed(1) + "MB",
                heap: (mem.heapUsed / 1024 / 1024).toFixed(1) + "MB",
                uptime: Math.floor(process.uptime() / 60) + "m"
            });
        }, 5000);

        socket.on("disconnect", () => clearInterval(telemetryTimer));
    });

    // Listen to Global Events
    events.on("wa_message", (data) => io.emit("new_message", { role: "whatsapp", ...data }));
    events.on("ai_reply", (data) => io.emit("new_message", { role: "ai", ...data }));
    events.on("wa_status", (status) => io.emit("connect_status", { status }));
    events.on("wa_qr", () => io.emit("qr_update"));

    server.listen(PORT, "0.0.0.0", () => {
        console.log("🌐 [SYSTEM] Elite Dashboard running at port " + PORT);
    });
}

module.exports = { startWebServer };
