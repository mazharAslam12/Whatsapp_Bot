require("dotenv").config();
const path = require("path");
const fs = require("fs").promises;
const { connectToWhatsApp } = require("./lib/whatsapp");
const { handleMessage, handlePresence, safeSendMessage } = require("./handlers/message");
const { startWebServer } = require("./services/web");
const { coerceOutboundJid } = require("./services/ai");
const events = require("./lib/events");

startWebServer();

let conflictCounter = 0;
let sock = null; // Global sock reference to manage state
let currentStatus = "disconnected";

// Sync Status with Dashboard
events.on("request_status", () => {
    events.emit("wa_status", currentStatus);
});

// Handle Dashboard Replies
events.on("send_whatsapp", async (data) => {
    console.log(`📤 [SYSTEM] Dashboard transmit request for ${data.jid}`);
    if (sock) {
        try {
            if (!data.jid) throw new Error("Missing JID in dashboard payload");
            const targetJid = coerceOutboundJid(data.jid);
            const hasImage = Buffer.isBuffer(data.imageBuffer) && data.imageBuffer.length > 0;
            const text = typeof data.text === "string" ? data.text.trim() : "";
            if (!hasImage && !text) throw new Error("Need text and/or image for dashboard send");

            if (hasImage) {
                const fname = `admin_out_${Date.now()}.jpg`;
                const userFiles = path.join(process.cwd(), "user_files");
                await fs.mkdir(userFiles, { recursive: true });
                await fs.writeFile(path.join(userFiles, fname), data.imageBuffer);
                const caption = typeof data.caption === "string" ? data.caption : "";
                await safeSendMessage(
                    sock,
                    targetJid,
                    { image: data.imageBuffer, caption },
                    { skipAiReplyEvent: true }
                );
                events.emit("admin_outbound", {
                    jid: targetJid,
                    text: caption || "[Image]",
                    media: { type: "image", url: `/media/${fname}` }
                });
            } else {
                await safeSendMessage(sock, targetJid, { text }, { skipAiReplyEvent: true });
                events.emit("admin_outbound", { jid: targetJid, text });
            }
            console.log(`✅ [DASHBOARD] Delivered to ${targetJid}`);
        } catch (err) {
            console.error("❌ [DASHBOARD] Transmit failed:", err.message);
        }
    } else {
        console.warn("⚠️ [DASHBOARD] Cannot transmit: Bot is offline.");
    }
});

async function startSystem() {
    process.title = "Mazhar-DevX-Bot";
    console.log("💎 [SYSTEM] Initializing Mazhar DevX Elite v2.0...");
    console.log(`🆔 [SYSTEM] Process ID: ${process.pid}`);
    console.log("🚀 [SYSTEM] Starting fresh session. Scanning QR may be required.");

    try {
        // Clean up previous socket if it exists to prevent leaks
        if (sock) {
            console.log("🧹 [SYSTEM] Cleaning up previous socket instance...");
            sock.ev.removeAllListeners();
            if (sock.ws) {
                try { sock.ws.close(); } catch (e) { }
            }
        }

        sock = await connectToWhatsApp();

        // ✅ Centralized Connection Monitor
        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                conflictCounter = 0; // Reset on success
                currentStatus = "online";
                events.emit("wa_status", "online");
                console.log("✨ [SYSTEM] All systems operational.");
                return;
            }

            if (connection === "close") {
                currentStatus = "disconnected";
                events.emit("wa_status", "disconnected");
                const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;

                // Detailed Conflict Detection
                const isConflict = statusCode === 440 || statusCode === 500 || statusCode === 403;

                if (isConflict) {
                    conflictCounter++;
                    console.warn("\n🛑 [CRITICAL CONFLICT] Connection was forcefully closed.");
                    console.warn(`👉 REASON: Another terminal is running this bot! (Current PID: ${process.pid})`);
                    console.warn("👉 ACTION: CLOSE ALL OTHER TERMINAL TABS (even hidden ones).\n");

                    if (conflictCounter >= 2) {
                        console.error("🔥 [SYSTEM] Persistent conflict. Auto-stopping. Please clear ALL terminals.");
                        process.exit(1);
                    }
                }

                // If it's not a manual logout, attempt to reconnect
                if (statusCode !== 401) {
                    const delay = isConflict ? 20000 : 5000;
                    console.log(`🔄 [SYSTEM] Reconnecting in ${delay / 1000}s... (Code: ${statusCode})`);
                    setTimeout(startSystem, delay);
                } else {
                    console.log("❌ [SYSTEM] Session expired or Logged Out. Please rescan.");
                }
            }
        });

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;
            for (const msg of messages) {
                await handleMessage(sock, msg);
            }
        });

        sock.ev.on("presence.update", (update) => {
            handlePresence(update);
        });

    } catch (err) {
        console.error("❌ [SYSTEM] Critical boot failure. Retrying in 10s...", err.message);
        setTimeout(startSystem, 10000);
    }
}

startSystem();
