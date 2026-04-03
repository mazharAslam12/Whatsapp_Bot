const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const fs = require("fs").promises;
const path = require("path");
const { mazharAiReply, stopAiStatus, isAiEnabled } = require("../services/ai");
const { searchImages } = require("../services/image");
const events = require("../lib/events");

const OWNER_JID = process.env.OWNER_JID;
const FILE_BASE_DIR = path.join(__dirname, "../../user_files");
const userStats = {};
const userMediaStats = {};
const userPresences = {};

// Categories for proactive GIFs (mapped to waifu.pics)
const GIF_CATEGORIES = ["smile", "wave", "happy", "dance", "laugh", "hug", "wink", "pat", "bonk", "yeet", "bully", "slap", "kill", "cringe", "cuddle", "cry"];
const profilePicCache = new Map(); // Simple cache for avatars


function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(2)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
}

const OWNER_IMAGES = [
    'src/assets/owner/owner1.jpg',
    'src/assets/owner/owner2.jpeg',
    'src/assets/owner/owner3.jpeg'
];

// Helper to safely send messages without crashing the terminal if connection drops
async function safeSendMessage(sock, jid, content, options = {}) {
    let retries = 3;
    while (retries > 0) {
        try {
            // Send directly and let Baileys handle the queue/state internally
            const res = await sock.sendMessage(jid, content, options);
            console.log(`✅ [SYSTEM] Sent: ${Object.keys(content)[0]} to ${jid}`);
            if (content.text) events.emit("ai_reply", { text: content.text });
            return res;
        } catch (err) {
            const isClosed = err.message.includes("Connection Closed") || err.output?.statusCode === 428;
            if (isClosed) {
                console.warn(`⏳ [SYSTEM] Connection unstable. Retrying in 2s (Attempts left: ${retries - 1})...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                retries--;
                continue;
            }
            console.error("❌ [SYSTEM] SafeSend Error:", err.message);
            return;
        }
    }
    console.error("❌ [SYSTEM] Failed to send message after all retries.");
}

function sanitizeFileName(name) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
        return null;
    }
    return trimmed;
}

function buildMainMenu() {
    return [
        "💎 *Mazhar DevX Elite v2.0*",
        "────────────────────",
        "🤖 *Elite AI (Autonomous Reasoning)*",
        "   • *Deep Web Search* – Instant global info",
        "   • *Code Pulse* – AI reads/writes its own code",
        "   • *Lead Gen* – Auto-captures project interests",
        "",
        "📂 *File Sandbox*",
        "   • *fs list* – Manage your private files",
        "",
        "🎵 *Entertainment*",
        "   • *song <name>* – HQ MP3 Download",
        "   • *video <name>* – HQ MP4 Download",
        "   • *image <query>* – Dynamic web search",
        "",
        "📊 *System & Stats*",
        "   • *status* / *stats* / *health*",
        "",
        "👑 *Owner*: mazhar.devx",
        "────────────────────",
        "Type *menu* to see this list again."
    ].join("\n");
}

async function handleMessage(sock, msg) {
    try {
        if (!msg.message || msg.key.fromMe) return;
        const msgType = Object.keys(msg.message)[0];
        const jid = msg.key.remoteJid;
        const pushName = msg.pushName || "User";
        const phoneNumber = jid.split("@")[0];

        const rawText = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            "";
        const text = rawText.trim();

        // --- DASHBOARD ENRICHMENT ---
        let mediaData = null;
        if (msgType === "imageMessage" || msgType === "videoMessage") {
            try {
                const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: { level: "silent" } });
                const fileName = `media_${Date.now()}.${msgType === "imageMessage" ? "jpg" : "mp4"}`;
                const filePath = path.join(FILE_BASE_DIR, fileName);
                await fs.writeFile(filePath, buffer);
                mediaData = { type: msgType === "imageMessage" ? "image" : "video", url: `/media/${fileName}` };
            } catch (e) {
                console.error("❌ [MEDIA DOWNLOAD ERROR]", e.message);
            }
        }

        // Fetch Profile Picture (with caching)
        let profilePic = profilePicCache.get(jid) || null;
        if (!profilePic && !jid.endsWith("@g.us")) {
            try {
                profilePic = await sock.profilePictureUrl(jid, 'image').catch(() => null);
                if (profilePic) profilePicCache.set(jid, profilePic);
            } catch (e) {}
        }

        events.emit("wa_message", { 
            text: text, 
            senderName: pushName, 
            senderNumber: phoneNumber, 
            jid: jid,
            media: mediaData,
            profilePic: profilePic
        });


        const lower = text.toLowerCase();


        if (lower === "stop" || lower === "break" || lower === "resume") {
            const res = stopAiStatus(jid, lower);
            await safeSendMessage(sock, jid, { text: res });
            return;
        }

        if (text === "/" || lower === "/menu" || lower === "/help") {
            await safeSendMessage(sock, sender, { text: buildMainMenu() });
            return;
        }


        // --- THE ELITE AI ENGINE ---
        // We only trigger AI if it's a private message or the bot is mentioned/replied to
        const isGroup = jid.endsWith("@g.us");
        const isMentioned = text.includes("@" + sock.user.id.split(":")[0]);
        const isReplyToMe = msg.message.extendedTextMessage?.contextInfo?.participant === sock.user.id;

        if (isGroup && !isMentioned && !isReplyToMe) return;

        // --- MANUAL MODE CHECK ---
        if (!isAiEnabled(jid)) {
            console.log(`👤 [MANUAL MODE] AI ignored for ${jid} (Admin is in control)`);
            return;
        }

        // Strip mention if it exists

        const prompt = text.replace("@" + sock.user.id.split(":")[0], "").trim();
        if (!prompt) return;

        const aiReply = await mazharAiReply(prompt, jid, pushName);



        // Filter and clean the reply from AI system tags before sending
        let cleanReply = aiReply
            .replace(/\[IMG_SEARCH:.*?\]/g, "")
            .replace(/\[GIF:.*?\]/g, "")
            .replace(/\[WEB_SEARCH:.*?\]/g, "")
            .replace(/\[READ_CODE:.*?\]/g, "")
            .replace(/\[WRITE_CODE:.*?\]/g, "")
            .replace(/\[NEW_LEAD:.*?\]/g, "")
            .trim();

        console.log(`💎 [AI REPLY] ${cleanReply.substring(0, 100)}...`);
        events.emit("ai_reply", { text: cleanReply });


        // 3. Anti-Repetition Shield (Hard Block for strict loops)
        const lastReplies = userStats[jid]?.history || [];
        const isRepeating = lastReplies.length > 2 && lastReplies[lastReplies.length - 1] === cleanReply;

        if (isRepeating) {
            console.warn(`🛡️ [ANTI-ECHO] Blocked repeated response to ${jid}`);
            return;
        }

        // Send the cleaned text reply
        if (cleanReply) {
            await safeSendMessage(sock, jid, { text: cleanReply });
        }

    } catch (err) {
        console.error("❌ [HANDLER ERROR]", err.message);
    }
}

async function handlePresence(update) {
    const { id, presences } = update;
    userPresences[id] = presences;
}

module.exports = { handleMessage, handlePresence, safeSendMessage };
