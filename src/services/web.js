const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const events = require("../lib/events");
const {
    setAdminPrompt,
    toggleUserAi,
    getAllContacts,
    getFullHistory,
    getFullHistoryWindow,
    addAdminMessageToMemory,
    setUserSpecificPrompt,
    pauseAiTemporarily,
    coerceOutboundJid
} = require("./ai");




const PORT = process.env.PORT || 8080;
const QR_PATH = path.join(process.cwd(), "user_files", "login-qr.png");
const DASHBOARD_HTML = path.join(__dirname, "dashboard.html");
const IMAGE_PROGRESS_HTML = path.join(__dirname, "image_progress.html");
const IMAGE_MAKER_DIR = path.join(process.cwd(), "image maker");
const IMAGE_MAKER_INDEX = path.join(IMAGE_MAKER_DIR, "index.html");
const IMAGE_MAKER_STYLE = path.join(IMAGE_MAKER_DIR, "style.css");

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
        } else if (req.url === "/image-progress") {
            if (fs.existsSync(IMAGE_PROGRESS_HTML)) {
                res.writeHead(200, { "Content-Type": "text/html" });
                fs.createReadStream(IMAGE_PROGRESS_HTML).pipe(res);
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Progress monitor file missing.");
            }
        } else if (req.url === "/image-maker" || req.url.startsWith("/image-maker?")) {
            if (fs.existsSync(IMAGE_MAKER_INDEX)) {
                res.writeHead(200, { "Content-Type": "text/html" });
                fs.createReadStream(IMAGE_MAKER_INDEX).pipe(res);
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Image maker missing.");
            }
        } else if (req.url === "/image-maker/style.css") {
            if (fs.existsSync(IMAGE_MAKER_STYLE)) {
                res.writeHead(200, { "Content-Type": "text/css" });
                fs.createReadStream(IMAGE_MAKER_STYLE).pipe(res);
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("style.css missing.");
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
            if (!data?.jid) return;
            const jid = data.jid.endsWith("@g.us") ? data.jid.trim() : coerceOutboundJid(data.jid);
            const text = typeof data.text === "string" ? data.text.trim() : "";
            const rawB64 = data.imageBase64;
            const hasImage = typeof rawB64 === "string" && rawB64.length > 80;

            if (!text && !hasImage) return;

            console.log(`📩 [DASHBOARD] Bypass → ${jid}${hasImage ? " + image" : ""}`);
            pauseAiTemporarily(jid, 180000);

            if (hasImage) {
                let buf;
                try {
                    const b64 = rawB64.replace(/^data:image\/\w+;base64,/, "").replace(/\s/g, "");
                    buf = Buffer.from(b64, "base64");
                } catch (e) {
                    console.error("❌ [DASHBOARD] Bad image payload");
                    return;
                }
                if (!buf || !buf.length) return;
                await addAdminMessageToMemory(jid, text || "[Image]");
                events.emit("send_whatsapp", { jid, imageBuffer: buf, caption: text, text: text || "[Image]" });
            } else {
                await addAdminMessageToMemory(jid, text);
                events.emit("send_whatsapp", { jid, text });
            }
        });

        socket.on("override_user_ai", (data) => {
            const jid = data.jid && data.jid.endsWith("@g.us") ? data.jid.trim() : coerceOutboundJid(data.jid);
            console.log(`👑 [MASTER OVERRIDE] Target: ${jid}. Rule: ${data.prompt}`);
            setUserSpecificPrompt(jid, data.prompt || "");
            socket.emit("get_contacts");
        });

        socket.on("toggle_ai", (data) => {
            const jid = data.jid && data.jid.endsWith("@g.us") ? data.jid.trim() : coerceOutboundJid(data.jid);
            toggleUserAi(jid, data.status);
            socket.emit("get_contacts");
        });

        socket.on("get_contacts", async () => {
            const contacts = await getAllContacts();
            socket.emit("contact_list", contacts);
        });

        socket.on("load_chat", async (data) => {
            if (!data?.jid) return;
            const jid = data.jid.endsWith("@g.us") ? data.jid.trim() : coerceOutboundJid(data.jid);
            const limit = Math.min(Math.max(parseInt(data.limit, 10) || 500, 20), 2000);
            const beforeRaw = data.beforeTs;
            const beforeTs =
                beforeRaw != null && beforeRaw !== ""
                    ? Number(beforeRaw)
                    : null;
            const useBefore = beforeTs != null && !Number.isNaN(beforeTs);
            const result = await getFullHistoryWindow(jid, { limit, beforeTs: useBefore ? beforeTs : null });
            socket.emit("chat_history", {
                jid,
                history: result.history,
                totalMessages: result.totalMessages,
                hasOlder: result.hasOlder,
                mode: useBefore ? "prepend" : "replace"
            });
        });

        socket.on("export_chat_json", async (data) => {
            if (!data?.jid) return;
            const jid = data.jid.endsWith("@g.us") ? data.jid.trim() : coerceOutboundJid(data.jid);
            const raw = await getFullHistory(jid);
            socket.emit("export_chat_json_ready", { jid, data: raw });
        });

        socket.on("update_ai_prompt", (data) => {
            setAdminPrompt(data.prompt || "");
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
    // AI replies are emitted by safeSendMessage() only. Keep a single source to avoid duplicates.
    events.on("ai_reply", (data) => io.emit("new_message", { role: "ai", ...data }));
    events.on("admin_outbound", (data) =>
        io.emit("new_message", {
            role: "admin",
            jid: data.jid,
            text: data.text,
            media: data.media,
            senderName: "Admin"
        })
    );
    events.on("wa_status", (status) => io.emit("connect_status", { status }));
    events.on("wa_qr", () => io.emit("qr_update"));
    events.on("image_progress", (data) => io.emit("image_progress_update", data));

    server.listen(PORT, "0.0.0.0", () => {
        console.log("🌐 [SYSTEM] Elite Dashboard running at port " + PORT);
    });
}

module.exports = { startWebServer };
