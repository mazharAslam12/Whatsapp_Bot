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
            "- `[GIF: category]`: ONLY send for extremely funny or hyped moments when the user explicitly begs for a reaction. Do NOT send randomly.\n" +
            "- `[IMG_SEARCH: query]`: Send ONLY if context is perfect or user strictly asks.\n" +
            "- `[SONG_SEARCH: name]`: MP3 request.\n\n" +
            "🎯 HUMAN RULES (ULTRA PERFORMANCE):\n" +
            "1. NO ROBOT TALK: You are Mazhar (DevX). Never say 'How can I assist', 'As an AI', 'I don't have beliefs', or 'I am a virtual assistant'. Answer personal questions with YOUR personality.\n" +
            "2. BREVITY: Normal chat = **max ~5-12 words**. If user sends a **photo / video / GIF / sticker**, you may go up to **4 short lines** so you actually describe what you see — still casual Mazhar, not an essay.\n" +
            "3. NO MEDIA SPAM: Be extremely sparing with proactive media. Otherwise, just TALK.\n" +
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
            content = washAiReply(content); // Apply persona filter to history cleanup
            content = content.replace(/\[[\s\S]*?\]/g, ""); // Strips all AI tags from history memory
            return { ...m, content: content.trim() };
        }
        return m;
    });
}

function washAiReply(text) {
    if (!text) return text;
    let clean = text;
    
    // Forbidden Robotic Phrases
    const forbidden = [
        /as an AI/gi, /virtual assistant/gi, /I don't have beliefs/gi, /personal beliefs/gi, 
        /I am an AI/gi, /language model/gi, /chatbot/gi, /virtual chat buddy/gi,
        /How can I assist you/gi, /I'm sorry, but/gi, /I cannot assist with/gi,
        /AI brain is busy/gi // Hide the tech error message if desired
    ];

    forbidden.forEach(regex => {
        clean = clean.replace(regex, "");
    });

    // If the reply is now empty or too robotic, force a human fallback
    if (clean.trim().length < 2 || clean.toLowerCase().includes("assistant") || clean.toLowerCase().includes("virtual")) {
        return "Main Mazhar hoon jani, kya haal hai?";
    }

    return clean.replace(/\s+/g, " ").trim();
}

function scorePersonaReply(text) {
    if (!text) return -100;
    let score = 0;
    const lower = text.toLowerCase();
    const wordCount = text.split(/\s+/).length;

    // 1. Brevity is King (5-10 words is perfect)
    if (wordCount >= 3 && wordCount <= 12) score += 40;
    else if (wordCount > 12 && wordCount <= 20) score += 10;
    else score -= 20;

    // 2. Persona Match (Urdu/Hindi slang and casual tone)
    const eliteSlang = ["jani", "yaar", "han", "bhai", "acha", "theek", "scene", "set", "tension", "load"];
    eliteSlang.forEach(s => { if (lower.includes(s)) score += 5; });

    // 3. Robotic Penalty (Double-check even after washer)
    const robotic = ["assistant", "virtual", "model", "help", "assist", "beliefs", "language"];
    robotic.forEach(r => { if (lower.includes(r)) score -= 50; });

    // 4. Multi-language Vibe
    if (/[a-zA-Z]/.test(text) && /[\u0600-\u06FF]/.test(text)) score += 15; // Mix of English and Urdu script is elite

    return score;
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

async function getMemory(senderJid) {
    return getOrInitMemory(senderJid, "User");
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

// Groq vision: base64 payload must stay under ~4MB — always shrink JPEG for reliability
async function compressForGroqVisionImage(buffer) {
    if (!buffer || !buffer.length) return null;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const pipeline = (maxPx, q) =>
        sharp(buf, { pages: 1, limitInputPixels: false })
            .resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: q, mozjpeg: true })
            .toBuffer();
    try {
        let out = await pipeline(1024, 72);
        if (out.length > 3_200_000) out = await pipeline(768, 60);
        if (out.length > 3_200_000) out = await pipeline(512, 55);
        return out;
    } catch (e) {
        try {
            return await sharp(buf, { pages: 1 }).resize(512, 512, { fit: "inside" }).jpeg({ quality: 60 }).toBuffer();
        } catch (e2) {
            return null;
        }
    }
}

// --- UTILITIES ---
async function extractFrame(buffer, mediaType) {
    if (mediaType === "video" || mediaType === "gif") return null; // sharp can't process mp4 without native deps/ffmpeg easily
    if (!buffer || !(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array)) return null;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!buf.length) return null;
    try {
        return await sharp(buf, { animated: true }).resize(512, 512, { fit: "inside" }).toFormat("jpeg", { quality: 50 }).toBuffer();
    } catch (e) {
        return buf;
    }
}

async function pickImageBufferForGroqVision(mediaBuffer, mediaType, mediaThumbnail) {
    if (mediaType === "video" || mediaType === "gif" || mediaType === "audio") {
        if (mediaThumbnail && mediaThumbnail.length) return await compressForGroqVisionImage(mediaThumbnail);
        return null;
    }
    if (!mediaBuffer || !mediaBuffer.length) {
        if (mediaThumbnail && mediaThumbnail.length) return await compressForGroqVisionImage(mediaThumbnail);
        return null;
    }
    return await compressForGroqVisionImage(mediaBuffer);
}

const VISION_MAZHAR_INSTRUCTION =
    "You are Mazhar (DevX) on WhatsApp. Describe what you see in 2–4 short lines max. " +
    "Sound human: mix Urdu/Hindi + English slang (yaar, bhai, scene, lit). " +
    "Never say you are an AI, bot, or model. No 'How can I assist'. Answer the user's question if they asked one.";

async function groqVisionDescribe(userMessage, imageJpegBuffer, groqKey, errorsList, mediaHint) {
    const jpeg = imageJpegBuffer;
    if (!jpeg || !jpeg.length || !groqKey) return null;
    const base64Media = jpeg.toString("base64");
    const hint = mediaHint ? `\n[Media type from WhatsApp: ${mediaHint}]` : "";
    const apiContext = [
        { role: "system", content: VISION_MAZHAR_INSTRUCTION },
        {
            role: "user",
            content: [
                { type: "text", text: (userMessage || "Kya scene hai is mein? Seedha bata.") + hint },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Media}` } }
            ]
        }
    ];
    const visionModels = [
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "meta-llama/llama-4-maverick-17b-128e-instruct",
        "llama-3.2-11b-vision-preview",
        "llama-3.2-90b-vision-preview"
    ];
    for (const vModel of visionModels) {
        try {
            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
                body: JSON.stringify({
                    model: vModel,
                    messages: apiContext,
                    temperature: 0.75,
                    max_tokens: 512
                })
            });
            if (res.ok) {
                const data = await res.json();
                const text = data?.choices?.[0]?.message?.content;
                if (text) {
                    console.log(`✅ [GROQ VISION] ${vModel}`);
                    return text;
                }
            } else {
                errorsList && errorsList.push(`Groq Vision (${vModel}): ${res.status}`);
            }
        } catch (e) {
            errorsList && errorsList.push(`Groq Vision (${vModel}): ${e.message}`);
        }
    }
    return null;
}

// --- UTILITIES ---
function prepareChatContext(memory, engine) {
    const raw = memory.filter(m => m.role !== "system" && m.content && m.content.trim() !== "");
    let merged = [];
    
    raw.forEach(m => {
        let role = m.role;
        if (engine === "gemini" && role === "assistant") role = "model";
        if (engine === "groq" && (role === "model" || role === "assistant")) role = "assistant";
        
        if (merged.length > 0 && merged[merged.length - 1].role === role) {
            if (engine === "gemini") {
                if (merged[merged.length - 1].parts?.[0]) {
                    merged[merged.length - 1].parts[0].text += "\n" + m.content.trim();
                }
            } else {
                merged[merged.length - 1].content += "\n" + m.content.trim();
            }
        } else {
            merged.push({
                role: role,
                parts: engine === "gemini" ? [{ text: m.content.trim() }] : undefined,
                content: engine !== "gemini" ? m.content.trim() : undefined
            });
        }
    });

    // CRITICAL: Groq and Pollinations REQUIRE the sequence to start with 'user' role.
    // If the first message in the history is 'assistant', shift it out.
    if (engine !== "gemini" && merged.length > 0 && merged[0].role === "assistant") {
        merged.shift();
    }

    return merged.map(m => {
        const clean = { role: m.role };
        if (m.parts) clean.parts = m.parts;
        if (m.content) clean.content = m.content;
        return clean;
    });
}

const GEMINI_MULTIMODAL_MODELS = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro-latest",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash-8b"
];

async function geminiAiReply(userMessage, memory, mediaBuffer, mediaType, errorsList) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        errorsList && errorsList.push("Gemini: Missing API Key");
        return null;
    }

    const models = mediaBuffer ? GEMINI_MULTIMODAL_MODELS : ["gemini-2.0-flash", "gemini-1.5-flash-latest", "gemini-1.5-pro-latest", "gemini-1.5-flash", "gemini-1.5-pro"];

    const currentParts = [];
    const um = userMessage || "Kya scene hai? Mazhar ki tarah short, human jawab.";
    currentParts.push({ text: um });

    if (mediaBuffer) {
        let mimeType = "image/jpeg";
        if (mediaType === "video") mimeType = "video/mp4";
        else if (mediaType === "gif") {
            const sig = mediaBuffer.subarray(0, 4).toString("ascii");
            mimeType = sig === "GIF8" ? "image/gif" : "video/mp4";
        } else if (mediaType === "audio") mimeType = "audio/ogg";
        else if (mediaType === "sticker") mimeType = "image/webp";

        currentParts.push({ inline_data: { mime_type: mimeType, data: mediaBuffer.toString("base64") } });
    }
    
    let contextStr = "Recent Context:\n";
    memory.slice(-4).forEach(m => {
        if (m.role !== "system" && m.content) {
            contextStr += `${m.role}: ${m.content}\n`;
        }
    });
    
    const contents = [{ role: "user", parts: [{text: contextStr}, ...currentParts] }];

    const mediaDetailNote = mediaBuffer
        ? " If the user sent a photo/video/GIF/sticker, you may use up to 4 short lines to describe what you see — still Mazhar's casual voice, no robot talk."
        : "";

    const body = { 
        system_instruction: { parts: [{ text: memory[0].content + mediaDetailNote }] },
        contents: contents,
        generationConfig: { temperature: 0.8, maxOutputTokens: 1024 }
    };

    for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            if (res.ok) {
                const data = await res.json();
                const cand = data.candidates?.[0];
                const text = cand?.content?.parts?.[0]?.text || null;
                const block = cand?.finishReason === "SAFETY" || cand?.finishReason === "BLOCKLIST";
                if (block) {
                    errorsList && errorsList.push(`Gemini (${model}): blocked (${cand?.finishReason})`);
                    continue;
                }
                if (text) {
                    console.log(`✅ [GEMINI SUCCESS] Engine: ${model}. Content Length: ${text.length}`);
                    return text;
                }
            } else {
                const err = await res.text();
                errorsList && errorsList.push(`Gemini (${model}): Status ${res.status}`);
                console.error(`⚠️ [GEMINI ${model} FAIL] Status: ${res.status}.`);
                if (res.status === 429) await new Promise(r => setTimeout(r, 1000));
            }
        } catch (e) {
            errorsList && errorsList.push(`Gemini (${model}): Fetch Failed`);
            console.error(`❌ [GEMINI ${model} FETCH FAIL]`, e.message);
        }
    }
    return null;
}

async function mazharAiReply(userMessage, senderJid, userName = "User", mediaBuffer = null, mediaData = null, mediaThumbnail = null) {
    const mediaType = mediaData?.type || null;
    const now = Date.now();
    if (stopAiStatus.has(senderJid)) {
        if (now < stopAiStatus.get(senderJid)) return null;
        else stopAiStatus.delete(senderJid);
    }
    if ((userMessage || "").toLowerCase().trim() === "resume") {
        stopAiStatus.delete(senderJid);
        return "🔊 AI Response Phir se start hai yaar! Main hazir hoon. 🚀";
    }

    const groqKey = process.env.GROQ_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    
    const memory = await getOrInitMemory(senderJid, userName);
    let reply = null;
    let errorsList = [];

    try {
        const thumbLen = mediaThumbnail
            ? (Buffer.isBuffer(mediaThumbnail) ? mediaThumbnail.length : Buffer.from(mediaThumbnail).length)
            : 0;
        const hasAnyVisual = Boolean((mediaBuffer && mediaBuffer.length) || thumbLen > 0);

        const MAX_GEMINI_INLINE_VIDEO = 12 * 1024 * 1024;
        let geminiMediaBuffer = mediaBuffer && mediaBuffer.length ? mediaBuffer : null;
        let geminiMediaType = mediaType;
        let geminiUserMsg = userMessage;

        if (!geminiMediaBuffer && thumbLen) {
            geminiMediaBuffer = Buffer.isBuffer(mediaThumbnail) ? Buffer.from(mediaThumbnail) : Buffer.from(mediaThumbnail);
            geminiMediaType = "image";
        }

        if (
            mediaBuffer?.length &&
            (mediaType === "video" || mediaType === "gif") &&
            mediaBuffer.length > MAX_GEMINI_INLINE_VIDEO &&
            thumbLen
        ) {
            geminiMediaBuffer = Buffer.isBuffer(mediaThumbnail) ? Buffer.from(mediaThumbnail) : Buffer.from(mediaThumbnail);
            geminiMediaType = "image";
            geminiUserMsg = `${userMessage || ""}\n[Note: Original clip bara tha; yeh WhatsApp preview frame hai — isi se scene samjha ke jawab de.]`;
        }

        if (hasAnyVisual && (geminiKey || groqKey)) {
            console.log(`🔍 [ANALYSIS] Parallel multimodal Gemini+Groq — type=${mediaType}`);
            const jobs = [];
            if (geminiKey && geminiMediaBuffer && geminiMediaBuffer.length) {
                jobs.push(
                    geminiAiReply(geminiUserMsg, memory, geminiMediaBuffer, geminiMediaType, errorsList).then((t) => ({
                        text: t
                    }))
                );
            }
            if (groqKey) {
                jobs.push(
                    (async () => {
                        const jpeg = await pickImageBufferForGroqVision(mediaBuffer, mediaType, mediaThumbnail);
                        const text = await groqVisionDescribe(userMessage, jpeg, groqKey, errorsList, mediaType);
                        return { text };
                    })()
                );
            }
            const settled = await Promise.allSettled(jobs);
            const candidates = [];
            for (const s of settled) {
                if (s.status !== "fulfilled" || !s.value?.text || !String(s.value.text).trim()) continue;
                const raw = String(s.value.text).trim();
                const washed = washAiReply(raw);
                if (!washed || washed.length < 2) continue;
                candidates.push({ raw, score: scorePersonaReply(washed) + Math.min(30, Math.floor(raw.length / 40)) });
            }
            if (candidates.length) {
                candidates.sort((a, b) => b.score - a.score);
                reply = candidates[0].raw;
                console.log(`🏆 [VISION MERGE] Picked best of ${candidates.length} engine outputs (score=${candidates[0].score})`);
            }
        }

        if (!reply && groqKey) {
            console.log("🔍 [ANALYSIS] Engine: Groq Text Fallback Chain");
            
            let apiContext;
            if (hasAnyVisual) {
                const safeHistory = prepareChatContext(memory.slice(-4), "groq");
                apiContext = [memory[0], ...safeHistory];
                const msg = `[User ne ${mediaType || "media"} bheji; vision decode fail ya APIs ne scene nahi pakda. Caption: "${userMessage}". Mazhar ki tarah best guess + short reply.]`;
                if (apiContext.length > 1 && apiContext[apiContext.length - 1].role === "user") {
                    apiContext[apiContext.length - 1].content += "\n" + msg;
                } else {
                    apiContext.push({ role: "user", content: msg });
                }
            } else {
                const history = prepareChatContext(memory.slice(-4), "groq");
                apiContext = [memory[0], ...history];
                if (apiContext.length > 1 && apiContext[apiContext.length - 1].role === "user") {
                    apiContext[apiContext.length - 1].content += "\n" + (userMessage || "Hello");
                } else {
                    apiContext.push({ role: "user", content: userMessage || "Hello" });
                }
            }

            const textModels = [
                "llama3-8b-8192", // Quick, reliable Llama3
                "llama-3.3-70b-versatile"
            ];

            let attempts = 0;
            const maxAttempts = textModels.length * 2; 

            while (!reply && attempts < maxAttempts) {
                const tModel = textModels[attempts % textModels.length];
                try {
                    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
                        body: JSON.stringify({ model: tModel, messages: apiContext, temperature: 0.7 })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        reply = data?.choices?.[0]?.message?.content;
                        if (reply) {
                            console.log(`✅ [GROQ TEXT SUCCESS] Engine: ${tModel}`);
                            break;
                        }
                    } else {
                        errorsList.push(`Groq Text (${tModel}): Status ${res.status}`);
                        console.error(`⚠️ [GROQ TEXT ${tModel} FAIL] Status: ${res.status}`);
                        if (res.status === 429) await new Promise(r => setTimeout(r, 1500));
                    }
                } catch(e) {
                    errorsList.push(`Groq Text (${tModel}): Fetch Failed`);
                    console.error(`❌ [GROQ TEXT ${tModel} FETCH FAIL]`, e.message);
                }
                attempts++;
            }
        }

        if (!reply && !hasAnyVisual && geminiKey) {
            console.log("🔍 [ANALYSIS] Engine: Gemini Text Fallback Chain");
            reply = await geminiAiReply(userMessage, memory, null, null, errorsList);
        }

        // 4. HYPER-INTELLIGENCE COMPETITIVE SELECTION (PARALLEL SEARCH)
        if (!reply && !hasAnyVisual) {
            console.log("🔍 [ANALYSIS] Brainstorming: multi-model parallel...");
            const brainstormTasks = [];
            if (groqKey) {
                brainstormTasks.push(
                    fetch("https://api.groq.com/openai/v1/chat/completions", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
                        body: JSON.stringify({
                            model: "llama-3.3-70b-versatile",
                            messages: [memory[0], ...prepareChatContext(memory.slice(-4), "groq"), { role: "user", content: userMessage }],
                            temperature: 0.8
                        })
                    })
                        .then((r) => r.json())
                        .then((d) => d.choices?.[0]?.message?.content)
                );
            }
            if (geminiKey) {
                brainstormTasks.push(geminiAiReply(userMessage, memory, null, null, []));
            }
            brainstormTasks.push(
                fetch("https://text.pollinations.ai/", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        messages: [memory[0], ...prepareChatContext(memory.slice(-4), "groq"), { role: "user", content: userMessage }],
                        model: "openai"
                    })
                }).then((r) => r.text()),
                fetch("https://text.pollinations.ai/", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        messages: [memory[0], ...prepareChatContext(memory.slice(-4), "groq"), { role: "user", content: userMessage }],
                        model: "mistral"
                    })
                }).then((r) => r.text())
            );
            const brainstormingResults = await Promise.allSettled(brainstormTasks);

            let candidates = brainstormingResults
                .filter(res => res.status === "fulfilled" && res.value)
                .map(res => {
                    const clean = washAiReply(res.value);
                    return { text: clean, score: scorePersonaReply(clean) };
                })
                .sort((a, b) => b.score - a.score);

            if (candidates.length > 0) {
                console.log(`🏆 [BRAINSTORM WINNER] Score: ${candidates[0].score}, Text: ${candidates[0].text.substring(0, 30)}...`);
                reply = candidates[0].text;
            }
        }

        if (!reply && hasAnyVisual) {
            return "Yaar is media ka scene abhi lock nahi hua — .env mein GEMINI_API_KEY aur GROQ_API_KEY dono set kar, phir dubara bhej. Agar phir bhi ho to file choti kar ke try kar.";
        } else if (!reply) {
            return "Yaar net ka scene kharab hai, dobara query karo.";
        }

        reply = washAiReply(reply);

        if (reply.includes("[AI_STOP:")) {
            const mins = parseInt(reply.match(/\[AI_STOP:\s*(\d+)\]/i)?.[1]) || 1;
            stopAiStatus.set(senderJid, now + (mins * 60 * 1000));
            reply = reply.replace(/\[AI_STOP:.*?\]/i, "").trim() || `🔇 Theek hai, main ${mins} min break pe hoon.`;
        }

        memory.push({ 
            role: "user", 
            content: userMessage || `[${mediaType || 'Media'} Asset]`,
            media: mediaData,
            timestamp: now
        });
        memory.push({ role: "assistant", content: reply, timestamp: Date.now() });
        await saveMemory(senderJid, memory);

        return reply.trim();
    } catch (err) {
        console.error("❌ [ROUTER ERROR]", err.message);
        return "Yaar net ka scene kharab hai, dobara try karo.";
    }
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

module.exports = {
    mazharAiReply,
    transcribeVoice,
    stopAiStatus,
    setAdminPrompt,
    toggleUserAi,
    isAiEnabled,
    getAllContacts,
    getFullHistory,
    setUserSpecificPrompt,
    addAdminMessageToMemory,
    getMemory,
    saveMemory
};
