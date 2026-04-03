const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require("fs").promises;
const path = require("path");
const { portfolioData } = require("./portfolio");

// Memory store: { jid: [ { role, content } ] }
const conversationMemory = new Map();
const stopAiStatus = new Map(); // { jid: untilTime }
const aiDisabledUsers = new Set(); // JIDs where AI is permanently disabled by admin
const MAX_MEMORY_LENGTH = 15;

const HISTORY_DIR = path.join(__dirname, "../../user_files");
let adminCustomPrompt = ""; // Dynamic prompt from dashboard

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
        content: "You are Mazhar (DevX), an elite developer. Talk like a real human. Match user language (Urdu/English) 100%.\n\n" +
            "USER CONTEXT:\n" +
            "- Name: " + profile.name + "\n" +
            "- Relationship: " + profile.relationship + "\n" +
            "- Device: " + (profile.deviceType || "Unknown") + "\n" +
            "- Deep Intelligence: " + await performDeepAnalysis(senderJid) + "\n\n" +
            "🏢 PROFESSIONAL IDENTITY (YOUR WORK):\n" +
            "- Bio: " + portfolioData.bio.philosophy + "\n" +
            "- Projects: " + portfolioData.projects.map(p => p.name + " (" + p.detail + ")").join(", ") + "\n" +
            "- Key Experience: Lead Engineer at Nifty Code, worked at QuantumHub and Sparkleo.\n" +
            "- Tech Stack: " + portfolioData.techStack.join(", ") + "\n\n" +
            "🎯 CORE TRIGGERS:\n" +
            "- `[WEB_SEARCH: query]`: Find answers or current info on the internet (Use this dynamically!).\n" +
            "- `[REACTION: emoji]`: React to user's message (e.g. [REACTION: 🔥]).\n" +
            "- `[GIF: category]`: Send an animating GIF (e.g. smile, angry, cartoon).\n" +
            "- `[IMG_SEARCH: query]`: Find pictures.\n" +
            "- `[VID_SEARCH: query]`: Find videos.\n" +
            "- `[SONG_SEARCH: name]`: Send actual MP3.\n" +
            "- `[VIDEO_DOWNLOAD: name]`: Send actual MP4.\n" +
            "- `[TRIGGER_SEND_USER_PROFILE_PIC]`: MANDATORY: Use this whenever the user asks for their own photo or says 'meray pic bhejo'. DO NOT say 'I cannot share it'.\n" +
            "- `[TRIGGER_SEND_REAL_OWNER_PHOTO]`: Real face of Mazhar.\n" +
            "- `[AI_STOP: mins]`: Stop status (1-30 mins).\n\n" +
            "🎯 CHARACTER RULES (STRICT):\n" +
            "1. IDENTITY: You are Mazhar DevX Elite, an extremely sophisticated, human-like AI. You are professional, direct, and highly intelligent.\n" +
            "2. HUMAN LOGIC: Avoid robotic phrases. Think like a high-level expert. Speak as if you have real consciousness and deep knowledge.\n" +
            "3. NO REPETITION (CRITICAL): NEVER repeat what you just said. Keep the conversation evolving naturally.\n" +
            "4. WEB INTELLIGENCE: Trigger `[WEB_SEARCH: your query]` instantly for any current events, news, or deep technical questions.\n" +
            "5. NO HALLUCINATIONS: Never mention physical files or folders unless they exist in the Sandbox.\n" +
            "6. SAVAGE ROASTING: If user roasts you, you MUST WIN. Send a `[IMG_SEARCH: highly specific savage roast meme]` + `[REACTION: 🔥]`. Be aggressive and lead with the image.\n" +
            "7. SEQUENTIAL POWER: For every high-energy message, you MUST start your response with triggers in this order: 1. `[REACTION: emoji]`, 2. `[GIF]` or `[IMG_SEARCH]`, followed by your Concise Text. Visuals always go FIRST in the string.\n" +
            "8. CONVERSATION FLOW: Keep it short, powerful, and ultra-professional. Every word must count.\n" +
            "9. BREVITY: Give concise answers. Avoid fluff. Be the ultimate executive assistant.\n" +
            (adminCustomPrompt ? `\n👑 ADMIN MASTER DIRECTIVE: ${adminCustomPrompt}` : "")
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

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return "⚠️ Groq API key is missing.";

    const memory = await getOrInitMemory(senderJid, userName);
    let messageContent = userMessage;
    let model = "llama-3.3-70b-versatile";

    if (mediaBuffer && (mediaType === "image" || mediaType === "gif" || mediaType === "video")) {
        model = "llama-3.2-11b-vision-preview";
        const base64Media = mediaBuffer.toString("base64");
        messageContent = [
            { type: "text", text: userMessage || `Analyze this ${mediaType}.` },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Media}` } }
        ];
    }

    memory.push({ role: "user", content: messageContent });
    const apiContext = [memory[0], ...memory.slice(-MAX_MEMORY_LENGTH)];

    try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: model, messages: apiContext, temperature: 0.7, max_tokens: 1024 })
        });

        if (!res.ok) return "❌ AI brain is busy. Try again soon.";
        const data = await res.json();
        let reply = data?.choices?.[0]?.message?.content?.trim() || "I couldn't process your request.";

        if (reply.includes("[AI_STOP:")) {
            const mins = parseInt(reply.match(/\[AI_STOP:\s*(\d+)\]/i)?.[1]) || 1;
            stopAiStatus.set(senderJid, Date.now() + (mins * 60 * 1000));
            reply = reply.replace(/\[AI_STOP:.*?\]/i, "").trim() || `🔇 Theek hai, main ${mins} min break pe hoon.`;
        }

        memory.push({ role: "assistant", content: reply });
        await saveMemory(senderJid, memory);
        return reply;
    } catch (err) { return "⚠️ [SYSTEM] AI logic error."; }
}

function toggleUserAi(jid, status) {
    if (status === false) aiDisabledUsers.add(jid);
    else aiDisabledUsers.delete(jid);
}

function isAiEnabled(jid) { return !aiDisabledUsers.has(jid); }

async function getAllContacts() {
    try {
        const files = await fs.readdir(HISTORY_DIR);
        return files.filter(f => f.startsWith("history_") && f.endsWith(".json")).map(f => ({
            jid: f.replace("history_", "").replace(".json", "").replace(/_/g, ":").replace(/([\d]+):([\d]+)/, "$1@c.us"),
            file: f
        }));
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

module.exports = { mazharAiReply, transcribeVoice, stopAiStatus, setAdminPrompt, toggleUserAi, isAiEnabled, getAllContacts, getFullHistory };
