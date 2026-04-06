const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const fs = require("fs").promises;
const path = require("path");
const { mazharAiReply, isAiEnabled, transcribeVoice, buildLanguageHint, userPauseCommand } = require("../services/ai");
const { searchImages } = require("../services/image");
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
        const pushName = msg.pushName || "User";
        const phoneNumber = jid.split("@")[0];

        const rawText = content.conversation ||
            content.extendedTextMessage?.text ||
            content.imageMessage?.caption ||
            content.videoMessage?.caption ||
            content.documentMessage?.caption ||
            "";
        const text = rawText.trim();

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

        // --- PROFILE & IDENTITY SYNC ---
        let profilePic = profilePicCache.get(jid) || null;
        try {
            // Force fetch if not in cache or every few messages
            if (!profilePic || Math.random() > 0.8) {
                profilePic = await sock.profilePictureUrl(jid, 'image').catch(() => null);
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
            profilePic: profilePic || `https://ui-avatars.com/api/?name=${encodeURIComponent(pushName)}&background=0a0f1f&color=00f2fe&bold=true`
        });


        const lower = text.toLowerCase();


        if (lower === "stop" || lower === "break" || lower === "resume") {
            const res = userPauseCommand(jid, lower);
            if (res) await safeSendMessage(sock, jid, { text: res });
            return;
        }

        if (text === "/" || lower === "/menu" || lower === "/help") {
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
        // We only trigger AI if it's a private message or the bot is mentioned/replied to
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

        if (isGroup && !isMentioned && !isReplyToMe) return;

        // --- MANUAL MODE CHECK ---
        if (!isAiEnabled(jid)) {
            console.log(`👤 [MANUAL MODE] AI ignored for ${jid} (Admin is in control)`);
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
        let userLine = langHint + prompt.replace("@" + sock.user.id.split(":")[0], "").trim() + quotedContext;
        if (!userLine.replace(/\[LANGUAGE:[^\]]*\]/g, "").trim() && hasVisualMedia) {
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

        let aiMediaBuffer = mediaBuffer;
        let aiMediaData = mediaData;
        let aiThumb = mediaThumbnail;
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
            const outEarly = attachFeelingSuffix(finalCleanReply, feelingMenuSuffix, feelingLangForSend);
            console.log(`✅ [SYSTEM] Text-first (before GIF/image): ${outEarly.substring(0, 40)}...`);
            await safeSendMessage(sock, jid, { text: outEarly }, { quoted: msg });
            events.emit("ai_reply", { text: outEarly, jid: jid });
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
                    }
                } catch (e) {
                    console.error("❌ Image buffer fetch fail:", e.message);
                }
            }
        }

        const gifMatch = aiReply.match(/\[GIF:\s*(.*?)\]/i);
        if (gifMatch) {
            const { getGif } = require("../services/gif");
            const category = gifMatch[1].toLowerCase();
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
                } catch (e) {
                    console.error("❌ GIF fetch/send failed:", e.message);
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
            const outFinal = attachFeelingSuffix(finalCleanReply, feelingMenuSuffix, feelingLangForSend);
            console.log(`✅ [SYSTEM] Sending final clean reply: ${outFinal.substring(0, 30)}...`);
            await safeSendMessage(sock, jid, { text: outFinal }, { quoted: msg });
            events.emit("ai_reply", { text: outFinal, jid: jid });

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
