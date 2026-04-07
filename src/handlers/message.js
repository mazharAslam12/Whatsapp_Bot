const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const fs = require("fs").promises;
const path = require("path");
const { mazharAiReply, isAiEnabled, transcribeVoice, buildLanguageHint, userPauseCommand, pauseAiTemporarily, toggleUserAi } = require("../services/ai");
const { generatePollinationsImage } = require("../services/image");
const { getGif } = require("../services/gif");
const events = require("../lib/events");

const OWNER_JID = process.env.OWNER_JID;
const FILE_BASE_DIR = path.join(__dirname, "../../user_files");
const userStats = {};
const userMediaStats = {};
const userPresences = {};

/** Mood menu: awaiting *1* / *2* / *3* reply (private chats). */
const FEELING_TTL_MS = 35 * 60 * 1000;
const FEELING_COOLDOWN_MS = 90 * 60 * 1000;
const pendingFeelingByJid = new Map();
const lastFeelingPromptAt = new Map();

// Burst messages: if user sends multiple texts quickly, answer step-by-step in one reply.
const BURST_WINDOW_MS = 1200;
const pendingBurstByJid = new Map(); // jid -> { timer, items: { plain, singleUserLine }[], pushName }
const lastMediaTagByJid = new Map(); // jid -> { key, at }
const MEDIA_TAG_COOLDOWN_MS = 45 * 60 * 1000;

// Rude handling ladder (C then B then A): clapback → warning → mute 30m → permanent mute
const RUDE_WINDOW_MS = 48 * 60 * 60 * 1000;
const rudeStateByJid = new Map(); // jid -> { strikes, lastAt }

function detectRudeTowardOwner(text) {
    const t = String(text || "").toLowerCase();
    if (!t.trim()) return false;
    // Profanity / insult list (broad but simple)
    const rude =
        /\b(fuck|f\*+k|motherf\w*|bitch|bastard|asshole|idiot|moron|stupid|shit|chutiya|chutya|bhenchod|behenchod|madarchod|mc\b|bc\b|randi|gandu|harami|kutta|kutti)\b/i.test(
            t
        );
    if (!rude) return false;

    // Targeting: mentions Mazhar/DevX OR direct "you/tu" style in same message
    const target =
        /\b(mazhar|devx|dev x)\b/i.test(t) ||
        /\b(you|u|ur|your|tu|tum|tera|teri|tujhe|aap)\b/i.test(t);
    return target;
}

function rudeLangKeyFromHint(langHint) {
    return detectFeelingLangFromHint(langHint);
}

function rudeReplyForStage(langKey, stage) {
    // stage: 1 clapback, 2 warning, 3 mute 30m, 4 perm mute
    if (langKey === "en") {
        if (stage === 1) return "Easy. Talk normal, don’t get loud behind a screen.";
        if (stage === 2) return "Last warning: keep it respectful. Next = muted.";
        if (stage === 3) return "Muted for 30 minutes. Come back with respect.";
        return "Muted permanently. Not entertaining this.";
    }
    if (langKey === "ur_ar") {
        if (stage === 1) return "اوئے آہستہ۔ زبان ٹھیک رکھو۔";
        if (stage === 2) return "آخری وارننگ: بدتمیزی بند۔ اگلی بار mute۔";
        if (stage === 3) return "30 منٹ کے لیے mute۔ عزت سے بات کرو۔";
        return "ہمیشہ کے لیے mute۔ بس۔";
    }
    // Roman/bilingual
    if (stage === 1) return "Aahista. Zaban theek rakho.";
    if (stage === 2) return "Last warning: tameez se. Next = mute.";
    if (stage === 3) return "30 min mute. Baad mein respect se baat karna.";
    return "Permanent mute. Bas khatam.";
}

function detectFeelingLangFromHint(hint) {
    const h = hint || "";
    if (/Urdu\/Arabic script/i.test(h)) return "ur_ar";
    if (/\*\*Roman Urdu\*\*/i.test(h)) return "roman";
    if (/high-level native English/i.test(h)) return "en";
    return "bilingual";
}

function buildFeelingMenu(langKey) {
    if (langKey === "ur_ar") {
        return (
            "ابھی آپ *کیسا محسوس* کر رہے ہیں؟\n\n" +
            "*1* — اچھا نہیں / اداس یا پریشان\n" +
            "*2* — ٹھیک / معمول\n" +
            "*3* — بہت اچھا / زبردست"
        );
    }
    if (langKey === "roman") {
        return (
            "Abhi *kaisa feel* ho raha hai?\n\n" +
            "*1* — Kharab / low mood\n" +
            "*2* — Theek / okay\n" +
            "*3* — Bohot acha / great"
        );
    }
    if (langKey === "en") {
        return (
            "How are you *feeling* right now?\n\n" +
            "*1* — Not great / low\n" +
            "*2* — Okay / good\n" +
            "*3* — Great / very good"
        );
    }
    return (
        "How are you *feeling*? / Abhi *kaisa mood* hai?\n\n" +
        "*1* — Not great · low / kharab\n" +
        "*2* — Okay · good · theek\n" +
        "*3* — Great · very good · sorted"
    );
}

function defaultFeelingIntro(langKey) {
    if (langKey === "ur_ar") return "بس یہ پوچھنا تھا۔";
    if (langKey === "roman") return "Bas ek choti si baat puchni thi yaar.";
    if (langKey === "en") return "Quick check-in from my side.";
    return "Quick check-in / choti si baat.";
}

function attachFeelingSuffix(base, suffix, langKey) {
    const b = (base || "").trim();
    if (!suffix) return b;
    if (!b) return defaultFeelingIntro(langKey) + suffix;
    return b + suffix;
}

function parseFeelingChoice(raw) {
    const t = String(raw || "")
        .replace(/\*/g, "")
        .trim()
        .toLowerCase();
    if (!t) return null;
    if (/\bnot\s+bad\b|\bnot\s+so\s+bad\b/i.test(t)) return 2;
    if (/^1\b|^one\b/i.test(t)) return 1;
    if (/^2\b|^two\b/i.test(t)) return 2;
    if (/^3\b|^three\b/i.test(t)) return 3;
    if (
        /\b(great|excellent|amazing|perfect|awesome|fantastic|blessed|lit|fire|sorted|zabardast|bohot acha|bohot achha|mast|very good)\b/i.test(t)
    ) {
        return 3;
    }
    if (
        /\b(bad|awful|terrible|worst|depress|hopeless|kharab|bura|udaas|udas|pareshan|gussa|cry|crying|broken|tired of life)\b/i.test(t)
    ) {
        return 1;
    }
    if (/\b(okay|ok\b|fine|good|well|alright|theek|thik|acha|achha|chill|better|normal|meh)\b/i.test(t)) {
        return 2;
    }
    return null;
}

function hasEmoji(s) {
    const t = String(s || "");
    // basic emoji-ish ranges + common symbols
    return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(t);
}

function maybeAddOneEmoji(replyText, userText, langHint) {
    const r = String(replyText || "").trim();
    if (!r) return r;
    if (hasEmoji(r)) return r;
    const u = String(userText || "").toLowerCase();
    // Always add exactly 1 emoji (user requested). Keep it relevant to user's message.
    if (/\b(hi|hey|hello|yo|sup|salam|assalam|aoa)\b/i.test(u)) return r + " 👋";
    if (/\b(thanks|thank you|thx|shukriya|jazak|jzk)\b/i.test(u)) return r + " 🙏";
    if (/\b(lol|lmao|haha|hehe)\b/i.test(u)) return r + " 😂";
    if (/\b(congrats|congratulations|mubarak)\b/i.test(u)) return r + " 🎉";
    if (/\b(sad|upset|depress|stress|tension|udaas|pareshan)\b/i.test(u)) return r + " 🫂";
    if (/\b(sorry|apolog|maaf)\b/i.test(u)) return r + " 🙇";
    if (/\b(love|miss|crush|janu|baby)\b/i.test(u)) return r + " ❤️";
    if (/\b(angry|mad|gussa|annoy|irritat)\b/i.test(u)) return r + " 😤";
    if (/\b(ok|okay|theek|thik|fine)\b/i.test(u)) return r + " 👍";
    if (/\b(help|support|issue|problem|error|bug|fix|nahi\s+chal)\b/i.test(u)) return r + " 🛠️";
    if (/high-level native English/i.test(String(langHint || "")) && /\b(great|nice|cool|awesome|amazing)\b/i.test(r.toLowerCase())) return r + " 🤝";
    return r + " 🙂";
}

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
            if (content.text && options.skipAiReplyEvent !== true) events.emit("ai_reply", { text: content.text, jid });
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
        "🤖 *Mazhar AI (Conversation Memory Enabled)*",
        "   • Just type: *mazhar <your question>*",
        "   • *elite ai* – personality check",
        "",
        "📂 *File Sandbox*",
        "   • *fs help* – manage your files",
        "   • *fs list* – see your sandbox",
        "",
        "🎵 *Entertainment*",
        "   • *song <name>* / *video <name>*",
        "   • *image <query>* – web search",
        "",
        "📊 *System & Stats*",
        "   • *status* – see online users",
        "   • *stats* – your chat history",
        "   • *gallery* – see media stats",
        "   • *health* – system performance",
        "",
        "💡 *Fun & Info*",
        "   • *joke* / *quote* / *time*",
        "   • */premium* – about Mazhar.DevX",
        "",
        "👑 *Owner*: mazhar.devx",
        "────────────────────",
        "Type *menu* to see this list again."
    ].join("\n");
}

async function handleMessage(sock, msg) {
    try {
        const getMessageContent = (m) => {
            if (!m) return null;
            if (m.ephemeralMessage) return getMessageContent(m.ephemeralMessage.message);
            if (m.viewOnceMessage) return getMessageContent(m.viewOnceMessage.message);
            if (m.viewOnceMessageV2) return getMessageContent(m.viewOnceMessageV2.message);
            if (m.documentWithCaptionMessage) return getMessageContent(m.documentWithCaptionMessage.message);
            return m;
        };

        const content = getMessageContent(msg.message);
        if (!content) return;

        const msgType = Object.keys(content)[0];
        const jid = msg.key.remoteJid;
        const fromMe = Boolean(msg.key.fromMe);
        const pushName = msg.pushName || "User";
        const phoneNumber = jid.split("@")[0];

        const rawText = content.conversation ||
            content.extendedTextMessage?.text ||
            content.imageMessage?.caption ||
            content.videoMessage?.caption ||
            content.documentMessage?.caption ||
            "";
        const text = rawText.trim();

        // ✅ Do not process outbound/admin messages.
        // Prevents the bot/AI from replying to dashboard sends or its own WhatsApp messages.
        if (fromMe) return;

        // Extract Quoted Context
        let quotedContext = "";
        const contextInfo = content.extendedTextMessage?.contextInfo;
        if (contextInfo?.quotedMessage) {
            const qMsg = contextInfo.quotedMessage;
            const qText = qMsg.conversation || qMsg.extendedTextMessage?.text || qMsg.imageMessage?.caption || qMsg.videoMessage?.caption || "";
            if (qText) {
                quotedContext = `\n[Context: You are replying to an earlier message that says: "${qText}"]`;
            }
        }

        // --- MEDIA PROCESSING ---
        let mediaBuffer = null;
        let mediaType = null;
        let mediaData = null;
        let mediaThumbnail = content[msgType]?.jpegThumbnail || null; // Instant Whatsapp Preview
        if (mediaThumbnail && !Buffer.isBuffer(mediaThumbnail)) {
            mediaThumbnail = Buffer.from(mediaThumbnail);
        }

        const mediaTypes = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];
        if (mediaTypes.includes(msgType)) {
            mediaType = msgType.replace("Message", "");
            if (msgType === "videoMessage" && content.videoMessage?.gifPlayback) {
                mediaType = "gif";
            }
            if (msgType === "documentMessage" && content.documentMessage?.mimetype) {
                const mt = content.documentMessage.mimetype.toLowerCase();
                if (mt.includes("gif")) mediaType = "gif";
                else if (mt.startsWith("image/")) mediaType = "image";
                else if (mt.startsWith("video/")) mediaType = "video";
            }

            try {
                const downloadOpts = {
                    logger: { level: "silent" },
                    ...(typeof sock.updateMediaMessage === "function"
                        ? { reuploadRequest: sock.updateMediaMessage }
                        : {})
                };
                mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, downloadOpts);
                if (mediaBuffer) {
                    console.log(`✅ [SYSTEM] Media Downloaded: ${msgType} (${mediaBuffer.length} bytes)`);
                } else {
                    console.warn(`⚠️ [SYSTEM] Media Download FAILED for ${msgType}. Relying on Thumbnail.`);
                }
            } catch (e) {
                console.error("❌ [MEDIA DOWNLOAD ERROR]", e.message);
            }

            if (!mediaBuffer || !mediaBuffer.length) {
                try {
                    mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: { level: "silent" } });
                    if (mediaBuffer?.length) console.log(`✅ [SYSTEM] Media downloaded (fallback path) ${mediaBuffer.length} bytes`);
                } catch (e2) {
                    console.warn("⚠️ [MEDIA] Fallback download also failed:", e2.message);
                }
            }

            try {
                const extensionMap = { image: "jpg", video: "mp4", audio: "mp3", document: "bin", sticker: "webp", gif: "gif" };
                const extension = extensionMap[mediaType] || "bin";

                if (mediaBuffer && mediaBuffer.length) {
                    await fs.mkdir(FILE_BASE_DIR, { recursive: true });
                    const fileName = `media_${Date.now()}.${extension}`;
                    const filePath = path.join(FILE_BASE_DIR, fileName);
                    await fs.writeFile(filePath, mediaBuffer);
                    mediaData = { type: mediaType, url: `/media/${fileName}` };
                } else if (mediaThumbnail && mediaThumbnail.length) {
                    await fs.mkdir(FILE_BASE_DIR, { recursive: true });
                    const fileName = `media_thumb_${Date.now()}.jpg`;
                    const filePath = path.join(FILE_BASE_DIR, fileName);
                    await fs.writeFile(filePath, mediaThumbnail);
                    mediaData = { type: mediaType || "image", url: `/media/${fileName}`, previewOnly: true };
                }
            } catch (e) {
                console.error("❌ [MEDIA FILE SAVE ERROR]", e.message);
            }
        }

        // Stats: count messages + media types (simple in-memory counters)
        userStats[jid] = userStats[jid] || { messages: 0, lastSeen: 0 };
        userStats[jid].messages += 1;
        userStats[jid].lastSeen = Date.now();
        if (mediaType) {
            userMediaStats[jid] =
                userMediaStats[jid] || { image: 0, video: 0, gif: 0, audio: 0, document: 0, sticker: 0 };
            if (userMediaStats[jid][mediaType] != null) userMediaStats[jid][mediaType] += 1;
        }

        let documentExtractedText = null;
        if (msgType === "documentMessage" && mediaBuffer && mediaBuffer.length) {
            const dm = content.documentMessage;
            const mime = (dm?.mimetype || "").toLowerCase();
            const fname = (dm?.fileName || "").toLowerCase();
            try {
                if (mime.includes("pdf") || fname.endsWith(".pdf")) {
                    const { extractTextFromPdf } = require("../services/pdf");
                    documentExtractedText = await extractTextFromPdf(mediaBuffer);
                    console.log(`📄 [DOCUMENT] PDF text extracted (${documentExtractedText?.length || 0} chars)`);
                } else if (
                    mime.includes("text/plain") ||
                    fname.endsWith(".txt") ||
                    (mime.startsWith("text/") && !mime.includes("html"))
                ) {
                    documentExtractedText = mediaBuffer.toString("utf8");
                    console.log(`📄 [DOCUMENT] Plain text (${documentExtractedText.length} chars)`);
                } else if (mime.includes("json") || fname.endsWith(".json")) {
                    documentExtractedText = mediaBuffer.toString("utf8");
                } else if (mime.includes("markdown") || fname.endsWith(".md")) {
                    documentExtractedText = mediaBuffer.toString("utf8");
                }
            } catch (docErr) {
                console.warn("⚠️ [DOCUMENT] Could not read file:", docErr.message);
            }
            if (documentExtractedText && documentExtractedText.length > 48000) {
                documentExtractedText = documentExtractedText.slice(0, 48000) + "\n\n[…truncated for length…]";
            }
        }

        // --- PROFILE & IDENTITY SYNC (only for inbound user messages) ---
        let profilePic = profilePicCache.get(jid) || null;
        if (!fromMe) {
            try {
                // Force fetch if not in cache or every few messages
                if (!profilePic || Math.random() > 0.8) {
                    profilePic = await sock.profilePictureUrl(jid, "image").catch(() => null);
                    if (profilePic) {
                        profilePicCache.set(jid, profilePic);
                        // Save profile pic locally for dashboard use
                        const safeJidName = jid.replace(/[:@.]/g, "_");
                        const profileDir = path.join(FILE_BASE_DIR, "profiles");
                        await fs.mkdir(profileDir, { recursive: true });

                        const picRes = await fetch(profilePic);
                        if (picRes.ok) {
                            const picBuffer = Buffer.from(await picRes.arrayBuffer());
                            await fs.writeFile(path.join(profileDir, `${safeJidName}.jpg`), picBuffer);
                            profilePic = `/media/profiles/${safeJidName}.jpg`;
                        }

                        // Update user metadata JSON
                        const { getProfile } = require("../services/profile");
                        const profile = await getProfile(jid, pushName);
                        profile.profilePic = profilePic;
                        const profilePath = path.join(FILE_BASE_DIR, "profiles", `${safeJidName}.json`);
                        await fs.writeFile(profilePath, JSON.stringify(profile, null, 2));
                    }
                }
            } catch (e) {}

            events.emit("wa_message", {
                text: text,
                senderName: pushName,
                senderNumber: phoneNumber,
                jid: jid,
                media: mediaData,
                profilePic:
                    profilePic ||
                    `https://ui-avatars.com/api/?name=${encodeURIComponent(pushName)}&background=0a0f1f&color=00f2fe&bold=true`
            });
        }


        const lower = text.toLowerCase();

        // --- COMMAND ROUTER (works in private + group) ---
        // These are the commands shown in `menu`. Handle them directly so they always work.
        // Auto-GIF reply: if user sends a GIF with no caption (private chat), send a different GIF back.
        if (mediaType === "gif" && !jid.endsWith("@g.us") && !text) {
            try {
                const hint = "happy";
                const gifData = await getGif(hint);
                if (gifData?.url) {
                    const mediaRes = await fetch(gifData.url, { redirect: "follow" });
                    if (mediaRes.ok) {
                        const bodyBuf = Buffer.from(await mediaRes.arrayBuffer());
                        if (bodyBuf.length > 14 * 1024 * 1024) {
                            await safeSendMessage(sock, jid, { text: "GIF bari thi, yeh link le: " + gifData.url }, { quoted: msg });
                            return;
                        }
                        const urlLower = gifData.url.toLowerCase();
                        const ct = (mediaRes.headers.get("content-type") || "").toLowerCase();
                        const looksMp4 = gifData.isMp4 || urlLower.includes(".mp4") || ct.includes("video/mp4");
                        const looksWebm = urlLower.includes(".webm") || ct.includes("webm");
                        if (looksMp4 || looksWebm) {
                            await safeSendMessage(sock, jid, {
                                video: bodyBuf,
                                mimetype: looksWebm ? "video/webm" : "video/mp4",
                                gifPlayback: true
                            });
                        } else {
                            await safeSendMessage(sock, jid, { image: bodyBuf, mimetype: ct.includes("gif") ? "image/gif" : "image/jpeg" });
                        }
                        return;
                    }
                }
            } catch (e) {
                // ignore auto-gif failures; continue normal flow
            }
        }
        if (lower === "status") {
            await safeSendMessage(sock, jid, { text: "✅ Online. Bol bhai." }, { quoted: msg });
            return;
        }
        if (lower === "health") {
            const mem = process.memoryUsage();
            const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
            const rss = (mem.rss / 1024 / 1024).toFixed(1);
            const upM = Math.floor(process.uptime() / 60);
            await safeSendMessage(sock, jid, { text: `🧠 Health\n- Heap: ${heap}MB\n- RSS: ${rss}MB\n- Uptime: ${upM}m` }, { quoted: msg });
            return;
        }
        if (lower === "stats") {
            const s = userStats[jid] || { messages: 0, lastSeen: 0 };
            const last = s.lastSeen ? new Date(s.lastSeen).toLocaleString() : "—";
            await safeSendMessage(
                sock,
                jid,
                { text: `📊 Your Stats\n- Messages: ${s.messages || 0}\n- Last seen: ${last}` },
                { quoted: msg }
            );
            return;
        }
        if (lower === "gallery") {
            const g = userMediaStats[jid] || { image: 0, video: 0, gif: 0, audio: 0, document: 0, sticker: 0 };
            await safeSendMessage(
                sock,
                jid,
                {
                    text:
                        `🖼️ Your Media Stats\n` +
                        `- Images: ${g.image || 0}\n` +
                        `- GIFs: ${g.gif || 0}\n` +
                        `- Videos: ${g.video || 0}\n` +
                        `- Audio: ${g.audio || 0}\n` +
                        `- Docs: ${g.document || 0}\n` +
                        `- Stickers: ${g.sticker || 0}`
                },
                { quoted: msg }
            );
            return;
        }

        // image <query>  (web image fetch via your existing deep search service)
        if (lower.startsWith("image ")) {
            const q = text.slice(6).trim();
            if (!q) {
                await safeSendMessage(sock, jid, { text: "Likho: image <kya chahiye>" }, { quoted: msg });
                return;
            }
            const { searchWebImages } = require("../services/search");
            const urls = await searchWebImages(q, 1);
            if (!urls?.[0]) {
                await safeSendMessage(sock, jid, { text: "Image nahi mili. Thora different keyword try kar." }, { quoted: msg });
                return;
            }
            try {
                const imgRes = await fetch(urls[0]);
                if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
                const buffer = Buffer.from(await imgRes.arrayBuffer());
                await safeSendMessage(sock, jid, { image: buffer, caption: `🖼️ ${q}` }, { quoted: msg });
            } catch (e) {
                await safeSendMessage(sock, jid, { text: "Image send fail ho gai — dobara try kar." }, { quoted: msg });
            }
            return;
        }

        // make image <prompt>  (AI generated image using your "image maker" engine)
        if (
            lower.startsWith("make image ") ||
            lower.startsWith("make an image ") ||
            lower.startsWith("generate image ") ||
            lower.startsWith("create image ")
        ) {
            const promptText = text
                .replace(/^make an image\s+/i, "")
                .replace(/^make image\s+/i, "")
                .replace(/^generate image\s+/i, "")
                .replace(/^create image\s+/i, "")
                .trim();
            if (!promptText) {
                await safeSendMessage(sock, jid, { text: "Likho: make image <prompt>" }, { quoted: msg });
                return;
            }
            const buf = await generatePollinationsImage(promptText);
            if (!buf) {
                await safeSendMessage(sock, jid, { text: "Abhi image generate nahi ho saki — 10 sec baad try." }, { quoted: msg });
                return;
            }
            await safeSendMessage(sock, jid, { image: buf, caption: `🎨 ${promptText}` }, { quoted: msg });
            return;
        }

        // gif <query/category>
        if (lower.startsWith("gif ")) {
            const q = text.slice(4).trim();
            if (!q) {
                await safeSendMessage(sock, jid, { text: "Likho: gif <happy|anime|meme|hug|dance...>" }, { quoted: msg });
                return;
            }
            const gifData = await getGif(q);
            if (!gifData?.url) {
                await safeSendMessage(sock, jid, { text: "GIF nahi mili. Another keyword try kar." }, { quoted: msg });
                return;
            }
            try {
                const mediaRes = await fetch(gifData.url, { redirect: "follow" });
                if (!mediaRes.ok) throw new Error(`HTTP ${mediaRes.status}`);
                const bodyBuf = Buffer.from(await mediaRes.arrayBuffer());
                if (bodyBuf.length > 14 * 1024 * 1024) {
                    await safeSendMessage(sock, jid, { text: "GIF bari thi, yeh link le: " + gifData.url }, { quoted: msg });
                    return;
                }
                const urlLower = gifData.url.toLowerCase();
                const ct = (mediaRes.headers.get("content-type") || "").toLowerCase();
                const looksMp4 = gifData.isMp4 || urlLower.includes(".mp4") || ct.includes("video/mp4");
                const looksWebm = urlLower.includes(".webm") || ct.includes("webm");
                if (looksMp4 || looksWebm) {
                    await safeSendMessage(sock, jid, {
                        video: bodyBuf,
                        mimetype: looksWebm ? "video/webm" : "video/mp4",
                        gifPlayback: true
                    });
                } else {
                    await safeSendMessage(sock, jid, { image: bodyBuf, mimetype: ct.includes("gif") ? "image/gif" : "image/jpeg" });
                }
            } catch (e) {
                await safeSendMessage(sock, jid, { text: "GIF send fail ho gayi — dobara try kar." }, { quoted: msg });
            }
            return;
        }

        // song <name> / video <name>
        if (lower.startsWith("song ")) {
            const q = text.slice(5).trim();
            if (!q) {
                await safeSendMessage(sock, jid, { text: "Likho: song <name>" }, { quoted: msg });
                return;
            }
            try {
                const { searchAudio } = require("../services/search");
                const audioBuffer = await searchAudio(q);
                await safeSendMessage(sock, jid, { audio: audioBuffer, mimetype: "audio/mpeg", ptt: true }, { quoted: msg });
            } catch (e) {
                await safeSendMessage(sock, jid, { text: "Song load nahi hui — name thora change karke try kar." }, { quoted: msg });
            }
            return;
        }
        if (lower.startsWith("video ")) {
            const q = text.slice(6).trim();
            if (!q) {
                await safeSendMessage(sock, jid, { text: "Likho: video <name>" }, { quoted: msg });
                return;
            }
            try {
                const { searchVideo } = require("../services/search");
                const vidBuffer = await searchVideo(q);
                await safeSendMessage(sock, jid, { video: vidBuffer, mimetype: "video/mp4" }, { quoted: msg });
            } catch (e) {
                await safeSendMessage(sock, jid, { text: "Video nahi mil raha — thora short keyword try kar." }, { quoted: msg });
            }
            return;
        }


        if (lower === "stop" || lower === "break" || lower === "resume") {
            const res = userPauseCommand(jid, lower);
            if (res) await safeSendMessage(sock, jid, { text: res });
            return;
        }

        if (text === "/" || lower === "/menu" || lower === "/help" || lower === "menu" || lower === "help") {
            await safeSendMessage(sock, jid, { text: buildMainMenu() });
            return;
        }

        // --- THE ELITE AI ENGINE ---
        let prompt = text;
        
        // Handle Voice Notes (Transcribe to text)
        if (msgType === "audioMessage" && mediaBuffer) {
            console.log("🎤 [SYSTEM] Transcribing voice note...");
            try {
                const transcript = await transcribeVoice(mediaBuffer);
                if (transcript) {
                    console.log(`🎤 [VOICE] Transcribed: "${transcript}"`);
                    prompt = transcript;
                } else {
                    prompt =
                        "[Voice note transcribe nahi hua — Groq API fail. User ko short Urdu/English mein keh de: GROQ_API_KEY check karein ya dubara bhejein.]";
                }
            } catch (ve) {
                console.error("🎤 [VOICE] Transcribe error:", ve.message);
                prompt = `[Voice note — ${ve.message || "transcription off"}. Mazhar style mein short jawab.]`;
            }
        }
        // We only trigger AI if it's a private message or the bot is mentioned/replied to.
        // Allow explicit command-style messages in groups without mention (menu/image/gif/song/etc).
        const isGroup = jid.endsWith("@g.us");
        const isMentioned = text.includes("@" + sock.user.id.split(":")[0]);
        const replyCtx =
            content.extendedTextMessage?.contextInfo ||
            content.imageMessage?.contextInfo ||
            content.videoMessage?.contextInfo ||
            content.documentMessage?.contextInfo ||
            content.audioMessage?.contextInfo ||
            content.stickerMessage?.contextInfo ||
            null;
        const isReplyToMe = replyCtx?.participant === sock.user.id;
        const isExplicitCommand =
            lower === "menu" ||
            lower === "help" ||
            lower === "/menu" ||
            lower === "/help" ||
            lower === "status" ||
            lower === "stats" ||
            lower === "gallery" ||
            lower === "health" ||
            lower.startsWith("fs ") ||
            lower.startsWith("image ") ||
            lower.startsWith("gif ") ||
            lower.startsWith("song ") ||
            lower.startsWith("video ") ||
            lower.startsWith("make image ") ||
            lower.startsWith("make an image ") ||
            lower.startsWith("generate image ") ||
            lower.startsWith("create image ");

        if (isGroup && !isMentioned && !isReplyToMe && !isExplicitCommand) return;

        // --- MANUAL MODE CHECK ---
        if (!isAiEnabled(jid)) {
            console.log(`👤 [MANUAL MODE] AI ignored for ${jid} (Admin is in control)`);
            return;
        }

        // --- RUDE LADDER (private chats only) ---
        if (!isGroup && detectRudeTowardOwner(text || prompt)) {
            const now = Date.now();
            const prev = rudeStateByJid.get(jid);
            const recent = prev && now - prev.lastAt < RUDE_WINDOW_MS ? prev : { strikes: 0, lastAt: 0 };
            const strikes = Math.min((recent.strikes || 0) + 1, 4);
            rudeStateByJid.set(jid, { strikes, lastAt: now });

            const langHint0 = buildLanguageHint((text || "") + " " + (prompt || ""));
            const lk = rudeLangKeyFromHint(langHint0);

            if (strikes === 1) {
                await safeSendMessage(sock, jid, { text: rudeReplyForStage(lk, 1) }, { quoted: msg });
                return;
            }
            if (strikes === 2) {
                await safeSendMessage(sock, jid, { text: rudeReplyForStage(lk, 2) }, { quoted: msg });
                return;
            }
            if (strikes === 3) {
                pauseAiTemporarily(jid, 30 * 60 * 1000);
                await safeSendMessage(sock, jid, { text: rudeReplyForStage(lk, 3) }, { quoted: msg });
                return;
            }
            // strike 4+
            toggleUserAi(jid, false);
            await safeSendMessage(sock, jid, { text: rudeReplyForStage(lk, 4) }, { quoted: msg });
            return;
        }

        // --- MOOD MENU: reply *1* / *2* / *3* (private only) ---
        if (!isGroup && pendingFeelingByJid.has(jid)) {
            const exp = pendingFeelingByJid.get(jid);
            if (Date.now() > exp) {
                pendingFeelingByJid.delete(jid);
            } else {
                const choice = parseFeelingChoice(prompt || text);
                if (choice != null) {
                    pendingFeelingByJid.delete(jid);
                    const labels = { 1: "not great / low", 2: "okay / good", 3: "great / very good" };
                    prompt = `I'm answering your mood check-in: I'm feeling *${labels[choice]}* (option ${choice} of 3). Reply briefly in my language — warm and real. Do not use [FEELING_CHECK] or another mood menu.`;
                } else if (String(text || prompt || "").trim().length > 0) {
                    await safeSendMessage(sock, jid, {
                        text: "Just reply with *1*, *2*, or *3* (rough · okay · great). / صرف *1*، *2*، یا *3* بھیجیں۔"
                    });
                    return;
                }
            }
        }

        // Strip mention if it exists
        const hasVisualMedia =
            mediaTypes.includes(msgType) &&
            msgType !== "audioMessage" &&
            (mediaBuffer?.length > 0 || mediaThumbnail?.length > 0);
        if (documentExtractedText) {
            const fn = content.documentMessage?.fileName || "document";
            prompt =
                (prompt ? prompt + "\n\n" : "") +
                `[User sent file: "${fn}". Read extracted content and answer in the same language they use.]\n---\n${documentExtractedText}\n---`;
        }
        const langHint = buildLanguageHint(prompt + rawText);
        const plainPrompt = prompt.replace("@" + sock.user.id.split(":")[0], "").trim();
        let userLine = langHint + plainPrompt + quotedContext;

        // Only analyze media when user asked about it / caption is empty.
        const wantsVisualAnalysis =
            hasVisualMedia &&
            (!plainPrompt ||
                plainPrompt.length < 3 ||
                /\b(what\s+is\s+this|what\s+happening|describe|explain|caption|meme|meaning|rate|react|is\s+it\s+good|kya\s+hai|ye\s+kya|samjhao|dekho|batao|scene)\b/i.test(
                    plainPrompt
                ) ||
                /[?؟]$/.test(plainPrompt));

        if (!userLine.replace(/\[LANGUAGE:[^\]]*\]/g, "").trim() && wantsVisualAnalysis) {
            const label =
                mediaType === "gif"
                    ? "GIF/animation"
                    : mediaType === "video"
                      ? "video"
                      : mediaType === "image"
                        ? "photo"
                        : mediaType === "sticker"
                          ? "sticker"
                          : "media";
            userLine = `[User ne WhatsApp pe ${label} bheji hai — caption khali hai. Dekh ke Mazhar ki tarah short, human, mix Urdu/English mein jawab de. Kya scene hai, kya dikh raha hai — seedha bata.]`;
        }

        const userLineForGate = userLine.replace(/\[LANGUAGE:[^\]]*\]\s*/g, "").trim();
        if (!userLineForGate && !mediaBuffer?.length && !mediaThumbnail?.length && !documentExtractedText) return;

        let aiMediaBuffer = wantsVisualAnalysis ? mediaBuffer : null;
        let aiMediaData = mediaData;
        let aiThumb = wantsVisualAnalysis ? mediaThumbnail : null;
        if (documentExtractedText && msgType === "documentMessage") {
            aiMediaBuffer = null;
            aiThumb = null;
            if (aiMediaData) aiMediaData = { ...aiMediaData, type: "document_text" };
        }
        if (msgType === "audioMessage") {
            aiMediaBuffer = null;
            aiThumb = null;
            if (aiMediaData) aiMediaData = { ...aiMediaData, type: "audio_transcribed" };
        }

        // --- BURST COMBINE (text-only): reply once, step-by-step ---
        const isTextOnly = !mediaTypes.includes(msgType);
        const isEligibleForBurst =
            isTextOnly &&
            !isGroup &&
            !pendingFeelingByJid.has(jid) &&
            !documentExtractedText &&
            String(prompt || "").trim().length > 0;

        if (isEligibleForBurst) {
            const cleanLine = String(prompt || "")
                .replace("@" + sock.user.id.split(":")[0], "")
                .trim();
            if (cleanLine) {
                const existing = pendingBurstByJid.get(jid) || { timer: null, items: [], pushName };
                existing.items.push({ plain: cleanLine, singleUserLine: userLine });
                existing.pushName = pushName;
                if (existing.timer) clearTimeout(existing.timer);
                existing.timer = setTimeout(async () => {
                    try {
                        const b = pendingBurstByJid.get(jid);
                        pendingBurstByJid.delete(jid);
                        if (!b || !b.items || b.items.length === 0) return;

                        let r = null;
                        if (b.items.length === 1) {
                            // Single message: reply normally (but after a short debounce).
                            const one = b.items[0];
                            r = await mazharAiReply(one.singleUserLine, jid, b.pushName || "User", null, null, null);
                        } else {
                            const combined = b.items.map((x) => x.plain).slice(-8); // cap to avoid huge prompts
                            const numbered = combined.map((t, i) => `${i + 1}) ${t}`).join("\n");
                            const langHint2 = buildLanguageHint(numbered);
                            const burstPrompt =
                                langHint2 +
                                "User sent multiple messages quickly. Reply in the same language and answer **step-by-step**, matching each line.\n\n" +
                                numbered;
                            r = await mazharAiReply(burstPrompt, jid, b.pushName || "User", null, null, null);
                        }
                        if (r && String(r).trim()) {
                            await safeSendMessage(sock, jid, { text: String(r).trim() }, { quoted: msg });
                        }
                    } catch (e) {
                        console.error("❌ [BURST REPLY ERROR]", e.message);
                    }
                }, BURST_WINDOW_MS);
                pendingBurstByJid.set(jid, existing);

                // Let the timer flush. Don't answer immediately for the first message in a burst.
                return;
            }
        }

        let aiReply = await mazharAiReply(userLine, jid, pushName, aiMediaBuffer, aiMediaData, aiThumb);

        if (aiReply == null || aiReply === undefined) {
            return;
        }
        if (String(aiReply).trim() === "") {
            const voiceHint =
                msgType === "audioMessage"
                    ? "Voice note ka text nahi nikal saka — GROQ_API_KEY .env mein set kar (Whisper), phir dubara bhej."
                    : "Abhi jawab clear nahi — GEMINI_API_KEY / GROQ_API_KEY .env check kar, phir dubara try.";
            await safeSendMessage(sock, jid, { text: voiceHint });
            return;
        }

        console.log(`💎 [AI-BRAIN] Raw: ${String(aiReply).substring(0, 50)}...`);

        let feelingMenuSuffix = null;
        let feelingMenuLangKey = null;

        // --- MULTIPLE AGENTIC TRIGGERS ---
        // 0. GLOBAL MEMORY RESET
        if (aiReply.includes("[GLOBAL_MEMORY_RESET]")) {
            const { getMemory, saveMemory } = require("../services/ai");
            await saveMemory(jid, []);
            console.log(`♻️ [SYSTEM] Global Memory Reset triggered for ${jid}`);
            aiReply = aiReply.replace(/\[GLOBAL_MEMORY_RESET\]/g, "").trim();
        }

        // 1. DEEP RESEARCH (The Intelligent Core)
        if (aiReply.includes("[DEEP_RESEARCH:")) {
            const match = aiReply.match(/\[DEEP_RESEARCH:\s*(.*?)\]/i);
            if (match) {
                const query = match[1].trim();
                const { performResearch } = require("../services/search");
                console.log(`📡 [RESEARCH] ${query}`);

                const researchResult = await performResearch(query);
                const webReport = researchResult.web.map(r => `- ${r.title}: ${r.url}`).join("\n");
                const researchPrompt = `Translate and explain this info briefly, casually, and naturally in your persona. Match the user's language: ${webReport}`;

                const synthesis = await mazharAiReply(researchPrompt, jid, "System_Research");
                await safeSendMessage(sock, jid, { text: synthesis.trim() });

                // Image Fetching logic
                if (researchResult.images.length > 0) {
                    for (const imgUrl of researchResult.images) {
                        try {
                            const imgRes = await fetch(imgUrl);
                            if (imgRes.ok) {
                                const buffer = Buffer.from(await imgRes.arrayBuffer());
                                await safeSendMessage(sock, jid, {
                                    image: buffer,
                                    caption: `🖼️ Research Image\n🔗 Source: ${imgUrl}` 
                                });
                                break; 
                            }
                        } catch (err) {
                            console.warn("⚠️ [RESEARCH] Skipping broken image URL:", imgUrl);
                        }
                    }
                }

                if (researchResult.video && researchResult.video.length > 0) {
                    const topVid = researchResult.video[0];
                    await safeSendMessage(sock, jid, { text: `🎬 *Video Found:* ${topVid.url}` });
                }
                return; // STOP execution of other triggers
            }
        }

        // --- MOOD CHECK-IN tag (after research branch — avoids losing menu on mixed tags) ---
        if (/\[FEELING_CHECK\]/i.test(aiReply || "")) {
            if (isGroup) {
                aiReply = aiReply.replace(/\[FEELING_CHECK\]/gi, "").trim();
            } else {
                const lastShow = lastFeelingPromptAt.get(jid) || 0;
                if (Date.now() - lastShow < FEELING_COOLDOWN_MS) {
                    aiReply = aiReply.replace(/\[FEELING_CHECK\]/gi, "").trim();
                } else {
                    const lh0 = buildLanguageHint(prompt + rawText);
                    feelingMenuLangKey = detectFeelingLangFromHint(lh0);
                    feelingMenuSuffix =
                        "\n\n─────────────\n" +
                        buildFeelingMenu(feelingMenuLangKey) +
                        "\n\n_Reply *1*, *2*, or *3*_";
                    lastFeelingPromptAt.set(jid, Date.now());
                    pendingFeelingByJid.set(jid, Date.now() + FEELING_TTL_MS);
                    aiReply = aiReply.replace(/\[FEELING_CHECK\]/gi, "").trim();
                }
            }
        }

        const feelingLangForSend =
            feelingMenuLangKey || detectFeelingLangFromHint(buildLanguageHint(prompt + rawText));

        // 2. REACTION
        const reactionMatch = aiReply.match(/\[REACTION:\s*(.*?)\]/i);
        if (reactionMatch) {
            await safeSendMessage(sock, jid, { react: { text: reactionMatch[1], key: msg.key } });
        }

        let finalCleanReply = aiReply.replace(/\[[\s\S]*?\]/g, "").replace(/\n{2,}/g, "\n").trim();
        const wantsTextBeforeMedia =
            Boolean(finalCleanReply) &&
            (/\[IMG_SEARCH:/i.test(aiReply) || /\[GIF:/i.test(aiReply) || /\[TRIGGER_SEND_REAL_OWNER_PHOTO\]/i.test(aiReply));
        let assistantTextSent = false;

        if (wantsTextBeforeMedia) {
            const outEarly = maybeAddOneEmoji(
                attachFeelingSuffix(finalCleanReply, feelingMenuSuffix, feelingLangForSend),
                text || prompt,
                langHint
            );
            console.log(`✅ [SYSTEM] Text-first (before GIF/image): ${outEarly.substring(0, 40)}...`);
            await safeSendMessage(sock, jid, { text: outEarly }, { quoted: msg });
            assistantTextSent = true;
            const { getMemory, saveMemory } = require("../services/ai");
            const historyEarly = await getMemory(jid);
            if (historyEarly.length && historyEarly[historyEarly.length - 1].role === "assistant") {
                historyEarly[historyEarly.length - 1].content = outEarly;
                await saveMemory(jid, historyEarly);
            }
        }

        // 3. MEDIA TRIGGERS
        const imgMatch = aiReply.match(/\[IMG_SEARCH:\s*(.*?)\]/i);
        if (imgMatch) {
            const q = (imgMatch[1] || "").trim().toLowerCase();
            const last = lastMediaTagByJid.get(jid);
            if (last && last.key === `img:${q}` && Date.now() - last.at < MEDIA_TAG_COOLDOWN_MS) {
                // Skip repeating the same image query too often
            } else {
            const { searchWebImages } = require("../services/search");
            const urls = await searchWebImages(imgMatch[1], 1);
            if (urls?.[0]) {
                try {
                    // Buffer level fetch for max reliability
                    const imgRes = await fetch(urls[0]);
                    if (imgRes.ok) {
                        const buffer = Buffer.from(await imgRes.arrayBuffer());
                        await safeSendMessage(sock, jid, { image: buffer, caption: "💎 Mazhar DevX Discovery" });
                        
                        // Save to memory
                        const { getMemory, saveMemory } = require("../services/ai");
                        const history = await getMemory(jid);
                        if (history.length && history[history.length - 1].role === "assistant") {
                            history[history.length - 1].media = { type: "image", url: urls[0] };
                            await saveMemory(jid, history);
                        }
                        lastMediaTagByJid.set(jid, { key: `img:${q}`, at: Date.now() });
                    }
                } catch (e) {
                    console.error("❌ Image buffer fetch fail:", e.message);
                }
            }
            }
        }

        const gifMatch = aiReply.match(/\[GIF:\s*(.*?)\]/i);
        if (gifMatch) {
            const { getGif } = require("../services/gif");
            const category = gifMatch[1].toLowerCase();
            const last = lastMediaTagByJid.get(jid);
            if (last && last.key === `gif:${category}` && Date.now() - last.at < MEDIA_TAG_COOLDOWN_MS) {
                // Skip repeating same GIF category too often
            } else {
            const gifData = await getGif(category);

            if (gifData && gifData.url) {
                try {
                    const mediaRes = await fetch(gifData.url, { redirect: "follow" });
                    if (!mediaRes.ok) throw new Error(`HTTP ${mediaRes.status}`);
                    const bodyBuf = Buffer.from(await mediaRes.arrayBuffer());
                    const urlLower = gifData.url.toLowerCase();
                    const ct = (mediaRes.headers.get("content-type") || "").toLowerCase();
                    const looksMp4 = gifData.isMp4 || urlLower.includes(".mp4") || ct.includes("video/mp4");
                    const looksWebm = urlLower.includes(".webm") || ct.includes("webm");

                    if (looksMp4 || looksWebm) {
                        await safeSendMessage(sock, jid, {
                            video: bodyBuf,
                            mimetype: looksWebm ? "video/webm" : "video/mp4",
                            gifPlayback: true
                        });
                    } else {
                        // Static PNG/JPEG/WebP from fallbacks — send as image (WhatsApp rejects many as fake "GIF" video)
                        let mime = "image/jpeg";
                        if (ct.includes("png") || urlLower.includes(".png")) mime = "image/png";
                        else if (ct.includes("webp") || urlLower.includes(".webp")) mime = "image/webp";
                        else if (ct.includes("gif") || urlLower.includes(".gif")) mime = "image/gif";
                        await safeSendMessage(sock, jid, { image: bodyBuf, mimetype: mime, caption: "🔥" });
                    }

                    const { getMemory, saveMemory } = require("../services/ai");
                    const history = await getMemory(jid);
                    if (history.length && history[history.length - 1].role === "assistant") {
                        history[history.length - 1].media = { type: "gif", url: gifData.url };
                        await saveMemory(jid, history);
                    }
                    lastMediaTagByJid.set(jid, { key: `gif:${category}`, at: Date.now() });
                } catch (e) {
                    console.error("❌ GIF fetch/send failed:", e.message);
                }
            }
            }
        }

        const webMatch = aiReply.match(/\[WEB_SEARCH:\s*(.*?)\]/i);
        if (webMatch) {
            const { deepSearch } = require("../services/search");
            const results = await deepSearch(webMatch[1], "web");
            if (results && results.length > 0) {
                let textResult = `🌐 *Deep Search: "${webMatch[1]}"*\n\n`;
                results.slice(0, 3).forEach((r, i) => {
                     textResult += `*${i+1}. ${r.title}*\n${r.url}\n\n`;
                });
                await safeSendMessage(sock, jid, { text: textResult.trim() });
            }
        }

        const songMatch = aiReply.match(/\[SONG_SEARCH:\s*(.*?)\]/i);
        if (songMatch) {
            try {
                const { searchAudio } = require("../services/search");
                const audioBuffer = await searchAudio(songMatch[1]);
                // ptt: true = WhatsApp voice note (tap to play), not a generic audio file
                await safeSendMessage(sock, jid, {
                    audio: audioBuffer,
                    mimetype: "audio/mpeg",
                    ptt: true
                });
            } catch (e) {
                console.error("❌ Song trigger fail:", e.message);
                await safeSendMessage(sock, jid, { text: `Song load nahi hui: ${e.message}` });
            }
        }

        const videoMatch = aiReply.match(/\[VIDEO_DOWNLOAD:\s*(.*?)\]/i);
        if (videoMatch) {
            try {
                const { searchVideo } = require("../services/search");
                const vidBuffer = await searchVideo(videoMatch[1]);
                await safeSendMessage(sock, jid, { video: vidBuffer, mimetype: "video/mp4" });
            } catch (e) { console.error("❌ Video trigger fail:", e.message); }
        }

        const ownerPhotoMatch = aiReply.match(/\[TRIGGER_SEND_REAL_OWNER_PHOTO\]/i);
        if (ownerPhotoMatch) {
            const chosen = OWNER_IMAGES[Math.floor(Math.random() * OWNER_IMAGES.length)];
            await safeSendMessage(sock, jid, { image: { url: chosen }, caption: "Me (Mazhar DevX)" });
        }

        // --- UNIVERSAL TAG STRIPPER (FINAL PASS) ---
        finalCleanReply = aiReply.replace(/\[[\s\S]*?\]/g, "").replace(/\n{2,}/g, "\n").trim();

        if ((finalCleanReply || feelingMenuSuffix) && !assistantTextSent) {
            const outFinal = maybeAddOneEmoji(
                attachFeelingSuffix(finalCleanReply, feelingMenuSuffix, feelingLangForSend),
                text || prompt,
                langHint
            );
            console.log(`✅ [SYSTEM] Sending final clean reply: ${outFinal.substring(0, 30)}...`);
            await safeSendMessage(sock, jid, { text: outFinal }, { quoted: msg });

            const { getMemory, saveMemory } = require("../services/ai");
            const history = await getMemory(jid);
            if (history.length && history[history.length - 1].role === "assistant") {
                history[history.length - 1].content = outFinal;
                await saveMemory(jid, history);
            }
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
