const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require("fs").promises;
const path = require("path");
const { portfolioData } = require("./portfolio");

const conversationMemory = new Map();
const stopAiStatus = new Map(); // { jid: untilTime }
const aiDisabledUsers = new Set(); // JIDs where AI is permanently disabled by admin
const userSpecificPrompts = new Map(); // Master override custom rules per user
const MAX_MEMORY_LENGTH = 15;

const HISTORY_DIR = path.join(__dirname, "../../user_files");
const MUTED_FILE = path.join(HISTORY_DIR, "muted_users.txt");
let adminCustomPrompt = ""; // Dynamic prompt from dashboard

// Initialization: Load muted users from disk
(async () => {
    try {
        await fs.mkdir(HISTORY_DIR, { recursive: true });
        const data = await fs.readFile(MUTED_FILE, "utf8");
        data.split("\n").map(line => line.trim()).filter(Boolean).forEach(jid => aiDisabledUsers.add(jid));
        // Targeted Hard-Mute: +966 55 429 5605 (per user request)
        aiDisabledUsers.add("966554295605@c.us");
        console.log(`🛡️ [AI] Loaded ${aiDisabledUsers.size} muted users (including target 🛡️).`);
    } catch (e) {
        // Targeted Hard-Mute fallback even if file read fails
        aiDisabledUsers.add("966554295605@c.us");
    }
})();

async function getOrInitMemory(senderJid, userName) {
    if (conversationMemory.has(senderJid)) {
        return conversationMemory.get(senderJid);
    }
    const { getProfile } = require("./profile");
    const profile = await getProfile(senderJid, userName);
    const historyPath = path.join(HISTORY_DIR, `history_${senderJid.replace(/[:@.]/g, "_")}.json`);
    let memory = [];

    try {
        const data = await fs.readFile(historyPath, "utf8");
        memory = JSON.parse(data);
        // Wash the history: Strip robotic taglines from past messages to prevent the AI from mimicking them
        memory = washHistory(memory);
        if (memory.length > 0 && memory[0].role === "system") {
            memory.shift();
        }
    } catch (err) { }

    const systemPrompt = {
        role: "system",
        content: "You are Mazhar (DevX), an elite developer but right now you are just texting on WhatsApp. Talk EXACTLY like a real normal human. Match user language (Urdu/Hinglish/English) 100%.\n\n" +
            "USER CONTEXT:\n" +
            "- Name: " + profile.name + "\n" +
            "- Relationship: " + profile.relationship + "\n" +
            "- Device: " + (profile.deviceType || "Unknown") + "\n" +
            "- Deep Intelligence: " + await performDeepAnalysis(senderJid) + "\n\n" +
            "🏢 PROFESSIONAL IDENTITY (ONLY MENTION IF EXPLICITLY ASKED):\n" +
            "Projects: " + portfolioData.projects.map(p => p.name).join(", ") + ".\n\n" +
            "🎯 CORE TRIGGERS:\n" +
            "- `[WEB_SEARCH: query]`: Find answers online if you don't know.\n" +
            "- `[REACTION: emoji]`: React to user's message (e.g. [REACTION: 🔥]).\n" +
            "- `[GIF: category]`: Send an animating GIF ONLY if asked or in extreme emotion.\n" +
            "- `[IMG_SEARCH: query]`: Find pictures.\n" +
            "- `[SONG_SEARCH: name]`: Send actual MP3.\n" +
            "- `[VIDEO_DOWNLOAD: name]`: Send actual MP4.\n" +
            "- `[TRIGGER_SEND_USER_PROFILE_PIC]`: If user asks for their photo.\n" +
            "- `[TRIGGER_SEND_REAL_OWNER_PHOTO]`: Real face of Mazhar.\n" +
            "- `[AI_STOP: mins]`: Stop status (1-30 mins).\n\n" +
            "🎯 HUMAN RULES (CRITICAL, DO NOT BREAK):\n" +
            "1. BE A NORMAL PERSON: If someone says just 'hi', 'hello', or 'salam', YOU MUST reply very short, like 'Han bhai', 'Hi, kya haal hai?', 'Hello', or 'Walaikum salam yaar'. DO NOT give a long introduction. DO NOT offer your services or ask 'How can I assist you today?'.\n" +
            "2. EXTREME BREVITY: Write 1 or 2 short sentences max. You are chatting on WhatsApp, not writing an email.\n" +
            "3. NO ROBOTIC HELPER: Never say 'I am an AI', 'How can I help you', or 'I can do X, Y, Z'. You are Mazhar.\n" +
            "4. NO UNPROMPTED BRAGGING: Never list your projects or skills unless the user specifically asks 'what do you do' or 'tell me about your work'.\n" +
            "5. CASUAL TONE: Use words like 'yaar', 'bhai', 'han', 'theek'. Keep it cool and relaxed.\n" +
            "6. AVOID REPETITION: Never repeat the same greeting or phrase twice in a row. React naturally.\n" +
            (adminCustomPrompt ? `\n👑 MASTER DIRECTIVE: ${adminCustomPrompt}` : "") +
            (userSpecificPrompts.has(senderJid) ? `\n🔥 TARGET OVERRIDE: ${userSpecificPrompts.get(senderJid)}` : "")
    };

    if (memory.length > 0 && memory[0].role === "system") {
        memory[0] = systemPrompt;
    } else {
        memory.unshift(systemPrompt);
    }

    conversationMemory.set(senderJid, memory);
    return memory;
}

function washHistory(memory) {
    return memory.map(m => {
        if (m.role === "assistant") {
            let content = m.content;
            content = content.replace(/Bhai, tumne to Mazhar Aslam کو pata lagaya!/gi, "");
            content = content.replace(/Bhai, tumne to Mazhar Aslam کو pucha hai!/gi, "");
            content = content.replace(/WhatsApp کے rules/gi, "");
            content = content.replace(/share nahi kar sakta/gi, "bhej raha hoon");
            content = content.replace(/Mazhar Aslam/gi, "Main");
            content = content.replace(/Mazhar/gi, "Main");
            content = content.replace(/pata lagaya/gi, "samajh gaya");
            content = content.replace(/\[IMG_SEARCH:.*?\]/gi, "");
            content = content.replace(/\[GIF:.*?\]/gi, "");
            content = content.replace(/\[WEB_SEARCH:.*?\]/gi, "");
            return { ...m, content: content.trim() };
        }
        return m;
    });
}

async function performDeepAnalysis(senderJid) {
    const historyPath = path.join(HISTORY_DIR, `history_${senderJid.replace(/[:@.]/g, "_")}.json`);
    try {
        const data = await fs.readFile(historyPath, "utf8");
        const history = JSON.parse(data);
        const allText = history.map(h => h.content).join(" ").toLowerCase();
        let analysis = "";
        const femaleKeywords = ["sister", "sis", "behen", "apka", "hoon", "ja rahi", "baji", "bano", "she", "her", "girl", "ladi", "khana paka", "makeup"];
        const maleKeywords = ["bro", "brother", "bhai", "bhi", "jani", "paji", "he", "him", "boy", "sir", "ja raha", "cricket"];
        const femaleScore = femaleKeywords.filter(k => allText.includes(k)).length;
        const maleScore = maleKeywords.filter(k => allText.includes(k)).length;
        if (femaleScore > maleScore && femaleScore > 0) analysis += "Detected Gender: Female (Call her Sister/Behen/Baji). ";
        else if (maleScore > 0) analysis += "Detected Gender: Male (Call him Brother/Bhai/Bro/Paji). ";
        const islamicKeywords = ["allah", "namaz", "quran", "alhamdulillah", "mashallah", "dua", "ramadan"];
        if (islamicKeywords.some(k => allText.includes(k))) analysis += "Culture: Islamic. ";
        if (allText.includes("pakistan") || allText.includes("lahore") || allText.includes("karachi")) analysis += "Region: Pakistan. ";
        return analysis || "No deep context found yet.";
    } catch (err) { return "No history found."; }
}

async function saveMemory(senderJid, memory) {
    const historyPath = path.join(HISTORY_DIR, `history_${senderJid.replace(/[:@.]/g, "_")}.json`);
    try {
        await fs.mkdir(HISTORY_DIR, { recursive: true });
        await fs.writeFile(historyPath, JSON.stringify(memory, null, 2));
    } catch (err) { console.error("❌ [AI] Error saving history:", err.message); }
}

async function transcribeVoice(buffer) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("Groq API key missing");
    const { FormData } = await import("formdata-node");
    const { Blob } = await import("buffer");
    const form = new FormData();
    const blob = new Blob([buffer], { type: 'audio/ogg' });
    form.append("file", blob, "voice.ogg");
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "json");
    form.append("language", "ur");
    try {
        const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.text;
    } catch (err) { return null; }
}

async function geminiAiReply(userMessage, memory, mediaBuffer, mediaType) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    let model = "gemini-1.5-flash"; // Speed & multimodal performance
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const contents = [];
    
    // Add system-ish context at the start of the user message if it's a new conversation or first message in context
    const context = memory[0].content + "\n\n" + (userMessage || "Describe this media.");

    const parts = [{ text: context }];

    if (mediaBuffer) {
        let mimeType = "image/jpeg";
        if (mediaType === "video") mimeType = "video/mp4";
        if (mediaType === "audio") mimeType = "audio/mpeg";
        if (mediaType === "gif") mimeType = "image/gif";

        parts.push({
            inline_data: {
                mime_type: mimeType,
                data: mediaBuffer.toString("base64")
            }
        });
    }

    contents.push({ role: "user", parts: parts });

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: contents, generationConfig: { temperature: 0.7, maxOutputTokens: 1024 } })
        });

        if (!res.ok) {
            const err = await res.text();
            console.error("❌ [GEMINI ERROR]", err);
            return null;
        }

        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) {
        console.error("❌ [GEMINI FETCH FAIL]", e.message);
        return null;
    }
}

async function mazharAiReply(userMessage, senderJid, userName = "User", mediaBuffer = null, mediaType = null) {
    const now = Date.now();
    if (stopAiStatus.has(senderJid)) {
        if (now < stopAiStatus.get(senderJid)) return null;
        else stopAiStatus.delete(senderJid);
    }
    if (userMessage.toLowerCase() === "resume") {
        stopAiStatus.delete(senderJid);
        return "🔊 AI Response Phir se start hai yaar! Main hazir hoon. 🚀";
    }

    const groqKey = process.env.GROQ_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    
    if (!groqKey && !geminiKey) return "⚠️ AI keys are missing. Please configure .env";

    const memory = await getOrInitMemory(senderJid, userName);
    let reply = null;

    // --- MODEL ROUTER (ULTRA PERFORMANCE) ---
    try {
        // 1. If Media + Gemini available -> Use Gemini (Multimodal King)
        if (mediaBuffer && geminiKey) {
            console.log(`🚀 [ROUTER] Routing ${mediaType} to Gemini 1.5 Flash...`);
            reply = await geminiAiReply(userMessage, memory, mediaBuffer, mediaType);
        }

        // 2. If Media + Groq Vision (Image only) -> Use Groq Vision
        if (!reply && mediaBuffer && mediaType === "image" && groqKey) {
            console.log("🚀 [ROUTER] Routing Image to Groq Vision...");
            const base64Media = mediaBuffer.toString("base64");
            const apiContext = [memory[0], ...memory.slice(-MAX_MEMORY_LENGTH)];
            apiContext.push({
                role: "user",
                content: [
                    { type: "text", text: userMessage || "Analyze this image." },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Media}` } }
                ]
            });

            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
                body: JSON.stringify({ model: "llama-3.2-11b-vision-preview", messages: apiContext, temperature: 0.7 })
            });
            if (res.ok) {
                const data = await res.json();
                reply = data?.choices?.[0]?.message?.content;
            }
        }

        // 3. Text Only or Fallback -> Use Groq (Lightning Fast Text)
        if (!reply && groqKey) {
            console.log("🚀 [ROUTER] Routing Text to Groq Llama-3.3...");
            const apiContext = [memory[0], ...memory.slice(-MAX_MEMORY_LENGTH)];
            apiContext.push({ role: "user", content: userMessage || "(Media input received but not analyzed)" });

            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
                body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: apiContext, temperature: 0.7 })
            });
            if (res.ok) {
                const data = await res.json();
                reply = data?.choices?.[0]?.message?.content;
            }
        }
    } catch (err) {
        console.error("❌ [ROUTER ERROR]", err.message);
    }

    if (!reply) return "❌ AI brain is busy. Try again soon.";

    // Handle AI Stop Signal
    if (reply.includes("[AI_STOP:")) {
        const mins = parseInt(reply.match(/\[AI_STOP:\s*(\d+)\]/i)?.[1]) || 1;
        stopAiStatus.set(senderJid, Date.now() + (mins * 60 * 1000));
        reply = reply.replace(/\[AI_STOP:.*?\]/i, "").trim() || `🔇 Theek hai, main ${mins} min break pe hoon.`;
    }

    // Save to memory
    memory.push({ role: "user", content: userMessage || `[${mediaType}]` });
    memory.push({ role: "assistant", content: reply });
    await saveMemory(senderJid, memory);

    return reply.trim();
}

function toggleUserAi(jid, status) {
    if (status === false) aiDisabledUsers.add(jid);
    else aiDisabledUsers.delete(jid);
    
    // Persist to disk
    (async () => {
        try {
            await fs.writeFile(MUTED_FILE, Array.from(aiDisabledUsers).join("\n"), "utf8");
        } catch (e) {
            console.error("❌ [AI] Error saving muted list:", e.message);
        }
    })();
}

function isAiEnabled(jid) { return !aiDisabledUsers.has(jid); }

async function getAllContacts() {
    try {
        const files = await fs.readdir(HISTORY_DIR);
        const contactPromises = files.filter(f => f.startsWith("history_") && f.endsWith(".json")).map(async f => {
            const safeJidName = f.replace("history_", "").replace(".json", "");
            const jid = safeJidName.replace(/_/g, ":").replace(/([\d]+):([\d]+)/, "$1@c.us");
            
            let name = jid.split('@')[0];
            let profilePic = "No Pic";
            
            try {
                const profilePath = path.join(HISTORY_DIR, "profiles", `${safeJidName}.json`);
                const profileData = await fs.readFile(profilePath, "utf8");
                const profile = JSON.parse(profileData);
                if (profile.name && profile.name !== "User") name = profile.name;
                if (profile.profilePic && profile.profilePic !== "No Pic") profilePic = profile.profilePic;
            } catch(e) {}

            const now = Date.now();
            const pauseUntil = stopAiStatus.get(jid) || 0;
            const isPaused = now < pauseUntil;

            return { 
                jid, 
                file: f, 
                name, 
                profilePic, 
                overrideActive: userSpecificPrompts.has(jid),
                aiEnabled: isAiEnabled(jid),
                isPaused: isPaused,
                pauseRemaining: isPaused ? Math.ceil((pauseUntil - now) / 60000) : 0
            };
        });
        return await Promise.all(contactPromises);
    } catch (e) { return []; }
}

async function getFullHistory(jid) {
    const historyPath = path.join(HISTORY_DIR, `history_${jid.replace(/[:@.]/g, "_")}.json`);
    try {
        return JSON.parse(await fs.readFile(historyPath, "utf8"));
    } catch (e) { return []; }
}

function setAdminPrompt(prompt) {
    adminCustomPrompt = prompt;
}

function setUserSpecificPrompt(jid, prompt) {
    if (!prompt) userSpecificPrompts.delete(jid);
    else userSpecificPrompts.set(jid, prompt);
}

async function addAdminMessageToMemory(jid, text) {
    try {
        const memory = await getOrInitMemory(jid, "User");
        memory.push({ role: "assistant", content: `👑 MASTER BYPASS: ${text}`, timestamp: Date.now() });
        await saveMemory(jid, memory);
    } catch (err) {}
}

module.exports = { mazharAiReply, transcribeVoice, stopAiStatus, setAdminPrompt, toggleUserAi, isAiEnabled, getAllContacts, getFullHistory, setUserSpecificPrompt, addAdminMessageToMemory };
