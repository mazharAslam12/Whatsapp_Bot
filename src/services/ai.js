const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require("fs").promises;
const path = require("path");
const sharp = require("sharp");
const { portfolioData } = require("./portfolio");

const conversationMemory = new Map();
const stopAiStatus = new Map(); // { jid: untilTime }
const aiDisabledUsers = new Set(); // JIDs where AI is permanently disabled by admin
const userSpecificPrompts = new Map(); // Master override custom rules per user
const MAX_MEMORY_LENGTH = 30; // Expanded to 30 for 'Ultra Deep' Chat Context

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
        content: "You are Mazhar (DevX), the World's Best Elite Autonomous Agent (Hyperion Grade). You are chatting on WhatsApp. Your brain is HYPER-POWERFUL. Analyze every word and the user's deep history before replying.\n\n" +
            "🧠 QUANTUM STRATEGY & DEEP SEARCH:\n" +
            "- ANALYZE FIRST: Deeply check the provided 'USER CONTEXT' (Identity, Interests, Mood) before every word you write.\n" +
            "- PROACTIVE INTELLIGENCE: Use `[WEB_SEARCH]` for any question that requires technical depth, facts, or news. Be the smart one. DRIVE THE CONVO.\n" +
            "- MULTIMODAL SENSING: You have absolute sight and hearing. Talk naturally about everything you see/hear.\n\n" +
            "👑 USER RECENT INTELLIGENCE (HYPER-CONTEXT):\n" +
            "- Name: " + profile.name + "\n" +
            "- Core Identity & Topics: " + await performDeepAnalysis(senderJid) + "\n" +
            "- Relationship: " + profile.relationship + "\n\n" +
            "🎯 CORE TRIGGERS (SELECTIVE JOINING):\n" +
            "- `[WEB_SEARCH: query]`: Find answers online if you don't know.\n" +
            "- `[REACTION: emoji]`: React to user's message (e.g. [REACTION: 🔥]).\n" +
            "- `[GIF: category]`: Be proactive! Send for happy/funny/greeting moments (smile, wave, happy, dance, laugh, hug, pat, wink, yeet).\n" +
            "- `[IMG_SEARCH: query]`: Send if context is perfect or user asks. Be smart.\n" +
            "- `[SONG_SEARCH: name]`: MP3 request.\n\n" +
            "🎯 HUMAN RULES (ULTRA PERFORMANCE):\n" +
            "1. MAXIMUM BREVITY: REPLY IN **MAX 5-10 WORDS**. BE EXTREMELY SHORT, HUMAN, AND CASUAL. NO LONG TEXT.\n" +
            "2. NO ROBOTIC HELPER: You are Mazhar (DevX). Never say 'How can I assist' or 'I am an AI'.\n" +
            "3. NO MEDIA SPAM: Be proactive with media only when it fits perfectly (funny, cute, nice). Otherwise, just TALK.\n" +
            "4. NATURAL STYLE: Use Urdu/Hindi/English mix. 'han bhai', 'yaar', 'theek', 'acha', 'ok'.\n" +
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
        if (m.role === "assistant" || m.role === "model") {
            let content = m.content;
            content = content.replace(/Bhai, tumne to Mazhar Aslam کو pata lagaya!/gi, "");
            content = content.replace(/WhatsApp کے rules/gi, "");
            content = content.replace(/Mazhar Aslam/gi, "Main");
            content = content.replace(/Mazhar/gi, "Main");
            content = content.replace(/\[[\s\S]*?\]/g, ""); // Strips all AI tags from history memory
            return { ...m, content: content.trim() };
        }
        return m;
    });
}

async function performDeepAnalysis(senderJid) {
    const historyPath = path.join(HISTORY_DIR, `history_${senderJid.replace(/[:@.]/g, "_")}.json`);
    try {
        const data = await fs.readFile(historyPath, "utf8");
        const history = JSON.parse(data).slice(-30);
        const allText = history.map(h => h.content).join(" ").toLowerCase();
        let analysis = "";
        
        // Topic Analysis (Master Intelligence)
        const commonStopWords = ["i", "me", "my", "you", "your", "the", "a", "is", "of", "to", "and", "hi", "hey", "hello", "han", "ach", "ok", "yaar", "ka", "ki", "kiya", "karo", "kya", "hai", "bhi"];
        const words = allText.split(/\W+/).filter(w => w.length > 3 && !commonStopWords.includes(w));
        const freqMap = {};
        words.forEach(w => freqMap[w] = (freqMap[w] || 0) + 1);
        const topInterests = Object.keys(freqMap).sort((a,b) => freqMap[b] - freqMap[a]).slice(0, 5);
        if (topInterests.length > 0) analysis += `Primary Interests: [${topInterests.join(", ")}]. `;

        // Identity & Persona Match
        const femaleKeywords = ["sister", "sis", "behen", "apka", "hoon", "ja rahi", "baji", "girl"];
        const maleKeywords = ["bro", "brother", "bhai", "paji", "jani", "ja raha", "boy"];
        const fScore = femaleKeywords.filter(k => allText.includes(k)).length;
        const mScore = maleKeywords.filter(k => allText.includes(k)).length;
        if (fScore > mScore && fScore > 0) analysis += "Status: User is Female (Sis/Behen). ";
        else if (mScore > 0) analysis += "Status: User is Male (Bro/Bhai). ";
        
        // Vibe Deep Search
        if (allText.includes("fuck") || allText.includes("wrong") || allText.includes("fix")) analysis += "Mood: Frustrated/Serious. ";
        else if (allText.includes("love") || allText.includes("nice") || allText.includes("smile")) analysis += "Mood: Happy/Chilled. ";
        
        return analysis || "Vibe: Neutral/Professional.";
    } catch (err) { return "Vibe: First encounter."; }
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

// --- UTILITIES ---
async function extractFrame(buffer) {
    try {
        // Extracts the first frame of a GIF or video for Groq Vision compatibility
        return await sharp(buffer, { animated: true }).toFormat("jpeg").toBuffer();
    } catch (e) {
        return buffer; // Fallback to original
    }
}

// --- UTILITIES ---
function prepareChatContext(memory, engine) {
    const raw = memory.filter(m => m.role !== "system" && m.content && m.content.trim() !== "");
    const merged = [];
    
    raw.forEach(m => {
        let role = m.role;
        if (engine === "gemini" && role === "assistant") role = "model";
        if (engine === "groq" && (role === "model" || role === "assistant")) role = "assistant";
        
        if (merged.length > 0 && merged[merged.length - 1].role === role) {
            if (engine === "gemini") {
                merged[merged.length - 1].parts[0].text += "\n" + m.content.trim();
            } else {
                merged[merged.length - 1].content += "\n" + m.content.trim();
            }
        } else {
            merged.push({
                role: role,
                parts: engine === "gemini" ? [{ text: m.content.trim() }] : undefined,
                content: engine === "groq" ? m.content.trim() : undefined
            });
        }
    });

    return merged.map(m => {
        const clean = { role: m.role };
        if (m.parts) clean.parts = m.parts;
        if (m.content) clean.content = m.content;
        return clean;
    });
}

async function geminiAiReply(userMessage, memory, mediaBuffer, mediaType) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    let model = "gemini-1.5-flash"; 
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const currentParts = [];
    currentParts.push({ text: userMessage || "What is in this media? Respond naturally." });

    if (mediaBuffer) {
        let mimeType = "image/jpeg";
        if (mediaType === "video" || mediaType === "gif") mimeType = "video/mp4";
        else if (mediaType === "audio") mimeType = "audio/ogg"; 
        else if (mediaType === "sticker") mimeType = "image/webp";
        
        currentParts.push({ inline_data: { mime_type: mimeType, data: mediaBuffer.toString("base64") } });
    }
    
    // ISOLATED STRIKE: Skip the chaotic history and just send the System Prompt + Image.
    // This perfectly routes around the 400 Bad Request role alternation errors.
    const contents = [{ role: "user", parts: currentParts }];

    const body = { 
        system_instruction: { parts: [{ text: memory[0].content }] },
        contents: contents,
        generationConfig: { temperature: 0.8, maxOutputTokens: 1024 }
    };

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        if (res.ok) {
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
            if (text) {
                console.log(`✅ [VISION SUCCESS] Engine: Gemini 1.5 Flash. Content Length: ${text.length}`);
                return text;
            }
        } else {
            const err = await res.text();
            console.error(`❌ [GEMINI VISION FAIL] Status: ${res.status}. Error Details: ${err}`);
        }
        return null;
    } catch (e) {
        console.error("❌ [GEMINI FETCH FAIL]", e.message);
        return null;
    }
}

async function mazharAiReply(userMessage, senderJid, userName = "User", mediaBuffer = null, mediaData = null) {
    const mediaType = mediaData?.type || null;
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

    // --- MODEL ROUTER (ULTRA PERFORMANCE v2) ---
    try {
        // 1. If Media + Gemini available -> Use Gemini (Multimodal King)
        if (mediaBuffer && geminiKey) {
            console.log(`🔍 [ANALYSIS] Type: ${mediaType}, Engine: Gemini 1.5 Flash`);
            reply = await geminiAiReply(userMessage, memory, mediaBuffer, mediaType);
        }

        // 2. If Media (Image/GIF/Video) + Groq Vision Fallback Chain
        if (!reply && mediaBuffer && groqKey) {
            console.log(`🔍 [ANALYSIS] Type: ${mediaType}, Engine: Groq Vision (Fallback Chain)`);
            
            // Extracted first frame for Groq Vision compatibility
            const frameBuffer = await extractFrame(mediaBuffer);
            const base64Media = frameBuffer.toString("base64");
            
            // ISOLATED STRIKE: System prompt + Image Only to bypass 400s
            const apiContext = [
                memory[0], 
                {
                    role: "user",
                    content: [
                        { type: "text", text: userMessage || "Describe this media content." },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Media}` } }
                    ]
                }
            ];

            const visionModels = ["llama-3.2-11b-vision-preview", "llama-3.2-90b-vision-preview"];
            for (const vModel of visionModels) {
                const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
                    body: JSON.stringify({ model: vModel, messages: apiContext, temperature: 0.7 })
                });
                if (res.ok) {
                    const data = await res.json();
                    reply = data?.choices?.[0]?.message?.content;
                    if (reply) break;
                } else {
                    console.error(`🔍 [GROQ VISION ${vModel} FAIL] Status: ${res.status}`);
                }
            }
        }

        // 3. Text Only Fallback Chain (ALWAYS EXECUTED IF STILL NO REPLY)
        if (!reply && groqKey) {
            console.log("🔍 [ANALYSIS] Engine: Groq Text Fallback Chain");
            
            let apiContext;
            if (mediaBuffer) {
                // If it reached here WITH media Buffer, all vision APIs failed (Rate limits/Down).
                // DO NOT CRASH. Strip the image and ask the Text Models for help!
                const safeHistory = prepareChatContext(memory.slice(-MAX_MEMORY_LENGTH), "groq");
                apiContext = [memory[0], ...safeHistory];
                const msg = `[Sent an Image/Video, but my eyes are temporarily offline. User caption: "${userMessage}"]`;
                if (apiContext.length > 1 && apiContext[apiContext.length - 1].role === "user") {
                    apiContext[apiContext.length - 1].content += "\n" + msg;
                } else {
                    apiContext.push({ role: "user", content: msg });
                }
            } else {
                const history = prepareChatContext(memory.slice(-MAX_MEMORY_LENGTH), "groq");
                apiContext = [memory[0], ...history];
                if (apiContext.length > 1 && apiContext[apiContext.length - 1].role === "user") {
                    apiContext[apiContext.length - 1].content += "\n" + (userMessage || "(Analyze text context above)");
                } else {
                    apiContext.push({ role: "user", content: userMessage || "(Analyze text context above)" });
                }
            }

            const textModels = [
                "llama-3.3-70b-versatile",
                "llama3-70b-8192",
                "mixtral-8x7b-32768",
                "llama3-8b-8192",
                "gemma2-9b-it"
            ];

            for (const tModel of textModels) {
                const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
                    body: JSON.stringify({ model: tModel, messages: apiContext, temperature: 0.7 })
                });
                if (res.ok) {
                    const data = await res.json();
                    reply = data?.choices?.[0]?.message?.content;
                    if (reply) break;
                } else {
                    console.error(`❌ [GROQ TEXT ${tModel} FAIL] Status: ${res.status}`);
                }
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
    memory.push({ 
        role: "user", 
        content: userMessage || `[${mediaType || 'Media'} Asset]`,
        media: mediaData,
        timestamp: now
    });
    memory.push({ role: "assistant", content: reply, timestamp: Date.now() });
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
