const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const fs = require("fs").promises;
const path = require("path");
const { mazharAiReply, stopAiStatus, isAiEnabled, transcribeVoice } = require("../services/ai");
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

        const mediaTypes = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];
        if (mediaTypes.includes(msgType)) {
            try {
                mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: { level: "silent" } });
                if (mediaBuffer) {
                    console.log(`✅ [SYSTEM] Media Downloaded: ${msgType} (${mediaBuffer.length} bytes)`);
                } else {
                    console.warn(`⚠️ [SYSTEM] Media Download FAILED for ${msgType}`);
                }
                
                mediaType = msgType.replace("Message", "");
                
                // Detect GIFs specifically (Baileys sends them as videoMessage with gifPlayback: true)
                if (msgType === "videoMessage" && content.gifPlayback) {
                    mediaType = "gif";
                }

                const extensionMap = { image: "jpg", video: "mp4", audio: "mp3", document: "bin", sticker: "webp", gif: "gif" };
                const extension = extensionMap[mediaType] || "bin";
                
                const fileName = `media_${Date.now()}.${extension}`;
                const filePath = path.join(FILE_BASE_DIR, fileName);
                await fs.writeFile(filePath, mediaBuffer);
                mediaData = { type: mediaType, url: `/media/${fileName}` };
            } catch (e) {
                console.error("❌ [MEDIA DOWNLOAD ERROR]", e.message);
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
            const res = stopAiStatus(jid, lower);
            await safeSendMessage(sock, jid, { text: res });
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
            const transcript = await transcribeVoice(mediaBuffer);
            if (transcript) {
                console.log(`🎤 [VOICE] Transcribed: "${transcript}"`);
                prompt = transcript;
            }
        }
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

        const finalPrompt = prompt.replace("@" + sock.user.id.split(":")[0], "").trim() + quotedContext;
        if (!finalPrompt && !mediaBuffer) return;

        const aiReply = await mazharAiReply(finalPrompt, jid, pushName, mediaBuffer, mediaData);

        console.log(`💎 [AI-BRAIN] Raw: ${aiReply.substring(0, 50)}...`);


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

        // 2. REACTION
        const reactionMatch = aiReply.match(/\[REACTION:\s*(.*?)\]/i);
        if (reactionMatch) {
            await safeSendMessage(sock, jid, { react: { text: reactionMatch[1], key: msg.key } });
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
                // gifData.isMp4 tells us if it's natively an MP4 video or a webp/gif
                await safeSendMessage(sock, jid, { video: { url: gifData.url }, gifPlayback: true });
                
                // Persistent History Fix
                const { getMemory, saveMemory } = require("../services/ai");
                const history = await getMemory(jid);
                if (history.length && history[history.length - 1].role === "assistant") {
                    history[history.length - 1].media = { type: "gif", url: gifData.url };
                    await saveMemory(jid, history);
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
                await safeSendMessage(sock, jid, { audio: audioBuffer, mimetype: "audio/mp4", ptt: false });
            } catch (e) { console.error("❌ Song trigger fail:", e.message); }
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
        // Robust multiline removal of [ANY_TAG:...]
        let finalCleanReply = aiReply.replace(/\[[\s\S]*?\]/g, "").replace(/\n{2,}/g, "\n").trim();

        // Send the cleaned text reply
        if (finalCleanReply) {
            console.log(`✅ [SYSTEM] Sending final clean reply: ${finalCleanReply.substring(0, 30)}...`);
            await safeSendMessage(sock, jid, { text: finalCleanReply });
            events.emit("ai_reply", { text: finalCleanReply, jid: jid });

            // Persist the AI's cleaned text in memory (overwriting the raw version)
            const { getMemory, saveMemory } = require("../services/ai");
            const history = await getMemory(jid);
            if (history.length && history[history.length - 1].role === "assistant") {
                history[history.length - 1].content = finalCleanReply;
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
