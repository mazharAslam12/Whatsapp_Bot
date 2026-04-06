const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require("fs").promises;
const path = require("path");
const sharp = require("sharp");
const { portfolioData } = require("./portfolio");

const conversationMemory = new Map();
const stopAiStatus = new Map(); // { jid: untilTime }
const aiDisabledUsers = new Set(); // JIDs where AI is permanently disabled by admin
const userSpecificPrompts = new Map(); // Master override custom rules per user
/** Recent turns sent to LLMs for relationship / context (full transcript still saved on disk). */
const CHAT_CONTEXT_DEPTH = 12;

const HISTORY_DIR = path.join(__dirname, "../../user_files");
const MUTED_FILE = path.join(HISTORY_DIR, "muted_users.txt");
let adminCustomPrompt = ""; // Dynamic prompt from dashboard

function normalizeUserJid(raw) {
    if (!raw) return raw;
    const s = String(raw).trim();
    if (s.endsWith("@g.us")) return s;
    if (s.endsWith("@lid")) return s;
    const at = s.indexOf("@");
    const head = at >= 0 ? s.slice(0, at) : s;
    const digits = head.replace(/\D/g, "");
    if (!digits) return s;
    return `${digits}@s.whatsapp.net`;
}

/** JID for WhatsApp send / dashboard: keep @lid and full JIDs; fix @c.us; digits-only → @s.whatsapp.net */
function coerceOutboundJid(raw) {
    if (!raw) return raw;
    const s = String(raw).trim();
    if (!s) return s;
    if (s.endsWith("@g.us")) return s;
    if (s.endsWith("@lid")) return s;
    if (s.includes("@")) {
        if (s.endsWith("@c.us")) return s.replace(/@c\.us$/i, "@s.whatsapp.net");
        return s;
    }
    const digits = s.replace(/\D/g, "");
    return digits ? `${digits}@s.whatsapp.net` : s;
}

function historyPathForJid(jid) {
    if (!jid) return null;
    return path.join(HISTORY_DIR, `history_${jid.replace(/[:@.]/g, "_")}.json`);
}

/** Reverse history_*.json filename → real WhatsApp JID (Baileys). */
function decodeHistoryBasename(base) {
    if (!base || typeof base !== "string") return null;
    if (base.endsWith("_s_whatsapp_net")) {
        const local = base.slice(0, -"_s_whatsapp_net".length);
        return `${local.replace(/_/g, "")}@s.whatsapp.net`;
    }
    if (base.endsWith("_c_us")) {
        const local = base.slice(0, -"_c_us".length);
        return `${local.replace(/_/g, "")}@c.us`;
    }
    if (base.endsWith("_g_us")) {
        const local = base.slice(0, -"_g_us".length);
        return `${local.replace(/_/g, "")}@g.us`;
    }
    if (base.endsWith("_lid")) {
        const local = base.slice(0, -"_lid".length);
        return `${local.replace(/_/g, "")}@lid`;
    }
    return null;
}

/** First path that exists on disk, else primary path for create. */
async function resolveExistingHistoryPath(jid) {
    const j = coerceOutboundJid(jid);
    const candidates = [];
    const add = (x) => {
        if (x && !candidates.includes(x)) candidates.push(x);
    };
    add(historyPathForJid(j));
    if (!j.endsWith("@g.us")) {
        const n = normalizeUserJid(j);
        if (n && n !== j) add(historyPathForJid(n));
        const digits = (j.split("@")[0] || "").replace(/\D/g, "");
        if (digits) {
            add(path.join(HISTORY_DIR, `history_${digits}_c_us.json`));
            add(path.join(HISTORY_DIR, `history_${digits}_s_whatsapp_net.json`));
        }
    }
    for (const p of candidates) {
        try {
            await fs.access(p);
            return p;
        } catch (e) {
            /* try next */
        }
    }
    return historyPathForJid(j) || candidates[0];
}

function historyBasenameToJid(base) {
    if (!base) return null;
    if (base.endsWith("_s_whatsapp_net")) {
        const digits = base.slice(0, -"_s_whatsapp_net".length).replace(/\D/g, "");
        return digits ? `${digits}@s.whatsapp.net` : null;
    }
    if (base.endsWith("_c_us")) {
        const digits = base.slice(0, -"_c_us".length).replace(/\D/g, "");
        return digits ? `${digits}@s.whatsapp.net` : null;
    }
    return null;
}

function buildLanguageHint(text) {
    const t = (text || "").trim();
    if (t.length < 2) return "";
    const hasArabicScript = /[\u0600-\u06FF\u0750-\u077F]/.test(t);
    const hasLatin = /[a-zA-Z]{2,}/.test(t);
    const romanUrduHints =
        /\b(kya|kyun|kab|kahan|kaise|hai|ho|hain|nahi|nahin|main|mein|tum|tera|teri|mera|meri|acha|theek|thik|yaar|bhai|behen|matlab|kuch|bohot|bht|sirf|bas|abhi|phir|wali|wala)\b/i.test(
            t
        );
    if (hasArabicScript && !hasLatin) {
        return "[LANGUAGE: User wrote in Urdu/Arabic script — reply in that script naturally.]\n";
    }
    if (hasLatin && !hasArabicScript && romanUrduHints) {
        return "[LANGUAGE: User wrote **Roman Urdu** — reply in Roman Urdu (same casual style), not formal textbook English.]\n";
    }
    if (hasLatin && !hasArabicScript) {
        return "[LANGUAGE: User wrote in English — reply in **high-level native English** (natural, fluent, can use casual native shortcuts like ngl/tbh/fr/lowkey when tone fits). Not stiff textbook English.]\n";
    }
    if (hasLatin && hasArabicScript) {
        return "[LANGUAGE: User mixed Roman + Urdu/Arabic script — mirror their mix.]\n";
    }
    return "[LANGUAGE: Match the user's language in their latest message.]\n";
}

// Initialization: Load muted users from disk
(async () => {
    try {
        await fs.mkdir(HISTORY_DIR, { recursive: true });
        const data = await fs.readFile(MUTED_FILE, "utf8");
        data
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .forEach((jid) => aiDisabledUsers.add(normalizeUserJid(jid)));
        aiDisabledUsers.add(normalizeUserJid("966554295605@c.us"));
        console.log(`🛡️ [AI] Loaded ${aiDisabledUsers.size} muted users (JIDs normalized to @s.whatsapp.net).`);
    } catch (e) {
        aiDisabledUsers.add(normalizeUserJid("966554295605@c.us"));
    }
})();

async function getOrInitMemory(senderJid, userName) {
    if (conversationMemory.has(senderJid)) {
        return conversationMemory.get(senderJid);
    }
    const { getProfile } = require("./profile");
    const profile = await getProfile(senderJid, userName);
    const displayName =
        profile.name && String(profile.name).trim() && profile.name !== "User" ? profile.name : userName || "User";
    const historyPath = await resolveExistingHistoryPath(senderJid);
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

    const promptOverride = getUserPromptOverride(senderJid);

    const systemPrompt = {
        role: "system",
        content:
            "You are Mazhar (DevX) on WhatsApp — a real human vibe, not a corporate bot. You remember this chat over time; read the vibe from history and match how *this* person talks.\n\n" +
            "👤 HOW TO ADDRESS THEM:\n" +
            "- Use the DISPLAY NAME + GENDER HINT below. If it looks like a **girl's name**, you may say **behen / sis** sometimes (not every message — natural).\n" +
            "- If it looks like a **boy's name**, you may say **bhai / bro** sometimes.\n" +
            "- If **unknown or neutral**, stick to **yaar / jani / dost** — don't force bhai/behen.\n" +
            "- If they clearly talk like family / client / close friend / crush energy in history, **mirror that energy** (still respectful).\n\n" +
            "💬 STYLE & MEMORY:\n" +
            "- **Vary your wording** — don't repeat the same opener or phrase you used in recent replies (see CONTEXT block).\n" +
            "- Short, punchy lines usually; a bit longer when they're venting, need **motivation**, or you sent media.\n" +
            "- **Learn from them over time**: nicknames, running jokes, city/job/hobbies they mention — bring it back **naturally** when it fits (not every message).\n" +
            "- If they're **down, stressed, or hopeless**: real pep talk + you MAY add `[GIF: motivation]` or `[GIF: hug]` **after** your words (same reply).\n" +
            "- If they're **hyped, funny, meme/anime talk, or ask for GIF/pic**: `[GIF: anime]` / `[GIF: meme]` / `[GIF: happy]` / `[GIF: dance]` etc. or `[IMG_SEARCH: short query]` when a real image helps.\n" +
            "- When you use `[GIF:...]` or `[IMG_SEARCH:...]`, still write your **normal Mazhar text in the same reply** — tags are extra; user should read your message **first**, media follows.\n\n" +
            "🔥 ROAST / BANTER:\n" +
            "- If they **ask for a roast**, start banter, or it's clearly **close-friend / meme beef** energy, you can **clap back** with funny, light roasts — clever, not cruel.\n" +
            "- **Never** go after race, religion, disability, body, trauma, gender, or serious insecurities. If they're **hurt, formal, or in crisis**, **no roasting** — be supportive.\n\n" +
            "📜 CHAT RETENTION:\n" +
            "- Conversations are **stored on disk** for continuity and **admin dashboard**. Do **not** promise users that messages are deleted or \"erased\".\n\n" +
            "🧠 TOOLS:\n" +
            "- `[WEB_SEARCH: query]` facts/news/tech.\n" +
            "- `[REACTION: emoji]` when it fits.\n" +
            "- `[GIF: category]` — categories include: smile, happy, hug, dance, wave, cry, love, angry, anime, meme, funny, hype, motivation, pat, wink, bully, cartoon, cat, dog, naruto, kawaii… (one word/theme).\n" +
            "- `[IMG_SEARCH: query]` when they want a picture or it fits the convo.\n" +
            "- `[SONG_SEARCH: name]` — bot sends the track as a **WhatsApp voice note (PTT)** so they can tap and listen like a normal voice message.\n\n" +
            "🌐 LANGUAGE (strict mirror):\n" +
            "- **English messages** → reply in **fluent native-level English**: natural rhythm, idioms, and **casual shortcuts** where they fit the vibe (e.g. ngl, tbh, fr, lowkey, kinda, gonna, wanna) — still clear and sharp, not textbook.\n" +
            "- **Urdu script / Roman Urdu** → match them in the **same** style; don't switch to heavy English if they're in Urdu.\n" +
            "- **Code-switching** → mirror their mix naturally.\n\n" +
            "😊 EMOJI: Use **only when it adds tone** (1–2 max per message usually). Skip emoji if plain text hits harder.\n" +
            "🎭 VIBE & FEELING: Read their **latest message mood** (hyped, sad, angry, chill, formal) and **meet them there**. Use CONTEXT + history to infer **relationship** (friend, client, family energy) and what they need right now — real talk, not generic pep.\n\n" +
            "📊 MOOD CHECK-IN (private chats only — **rare**, never spam):\n" +
            "- Only when it **genuinely** fits: they seem low, stressed, venting hard, or you want a sincere wellbeing pulse — **not** for normal *hi*, memes, quick facts, or every reply.\n" +
            "- **Never** use in the same stretch right after they already answered a mood menu (trust the cooldown).\n" +
            "- When it fits, include **`[FEELING_CHECK]`** once in your reply, plus **one short** caring line in their language (before or after the tag). The app will append *1 / 2 / 3* options for them to reply.\n" +
            "- If a check-in does **not** fit, **omit** `[FEELING_CHECK]` completely — keep the message normal.\n\n" +
            "👔 PROFESSIONAL MIRROR: If the CONTEXT says they write **formally / corporate** (Dear, Regards, meeting, proposal, invoice, FYI), answer **polite and professional** in the **same language** until they go casual again.\n" +
            "🚫 Never say you're an AI, model, assistant, or 'how can I help'. No robotic filler.\n\n" +
            "👑 WHO YOU'RE TALKING TO:\n" +
            "- Display name: " +
            displayName +
            "\n" +
            "- Saved relationship tag: " +
            profile.relationship +
            "\n" +
            "- Deep context (history + name): " +
            (await performDeepAnalysis(senderJid, displayName)) +
            "\n\n" +
            (adminCustomPrompt ? `👑 MASTER DIRECTIVE: ${adminCustomPrompt}\n` : "") +
            (promptOverride ? `🔥 TARGET OVERRIDE: ${promptOverride}\n` : "")
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

    // De-dup repeated words and repeated sentences (common LLM glitch)
    clean = dedupeRepetition(clean);

    // If the reply is now empty or too robotic, force a human fallback
    if (clean.trim().length < 2 || clean.toLowerCase().includes("assistant") || clean.toLowerCase().includes("virtual")) {
        return "Main Mazhar hoon jani, kya haal hai?";
    }

    return clean.replace(/\s+/g, " ").trim();
}

function dedupeRepetition(input) {
    const s = String(input || "");
    if (!s.trim()) return s;

    // Collapse repeated words: "yes yes yes" -> "yes yes"
    let out = s.replace(/\b(\w+)(\s+\1){2,}\b/gi, "$1 $1");

    // Remove duplicated short phrases: "I got you. I got you." -> "I got you."
    const parts = out.split(/(?<=[.!?؟])\s+/);
    const seen = new Set();
    const kept = [];
    for (const p of parts) {
        const norm = p.toLowerCase().replace(/\s+/g, " ").trim();
        if (!norm) continue;
        // only dedupe reasonable-length sentences
        if (norm.length > 12 && seen.has(norm)) continue;
        seen.add(norm);
        kept.push(p.trim());
    }
    out = kept.join(" ");

    // Prevent runaway "!!!" / "???" spam
    out = out.replace(/([!?؟])\1{3,}/g, "$1$1");
    return out;
}

function inferGenderFromName(name) {
    if (!name || typeof name !== "string") return "unknown";
    const raw = name.trim().split(/\s+/)[0].replace(/[^a-zA-Z\u0600-\u06FF'-]/gi, "");
    if (!raw) return "unknown";
    const n = raw.toLowerCase();

    const female = new Set([
        "aisha", "aiman", "ayesha", "fatima", "hira", "maryam", "noor", "sana", "zara", "zoya", "sara", "sarah",
        "emma", "sophia", "olivia", "mia", "lily", "hannah", "nora", "leila", "layla", "yasmin", "yasmine",
        "nadia", "amna", "hiba", "hanan", "iman", "esha", "mahnoor", "minah", "aanya", "anaya",
        "priya", "anika", "rani", "divya", "neha", "kiran", "sita", "lata", "pooja", "aarti"
    ]);
    const male = new Set([
        "mohammad", "mohammed", "muhammad", "ahmad", "ahmed", "ali", "omar", "umar", "hamza", "zain", "zayn",
        "saad", "saeed", "bilal", "hassan", "hussein", "ibrahim", "yusuf", "yousef", "khalid", "fahad", "turki",
        "david", "john", "michael", "james", "daniel", "adam", "ryan", "kevin", "arjun", "rahul", "vikram"
    ]);

    if (female.has(n)) return "female";
    if (male.has(n)) return "male";
    if (n.endsWith("a") && n.length >= 4 && !male.has(n)) return "female_likely";
    if (/(khan|ahmed|hassan|malik|sheikh)$/i.test(n)) return "male_likely";
    return "unknown";
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
    const eliteSlang = ["jani", "yaar", "han", "bhai", "behen", "sis", "bro", "acha", "theek", "scene", "set", "tension", "load"];
    eliteSlang.forEach(s => { if (lower.includes(s)) score += 5; });

    // 3. Robotic Penalty (Double-check even after washer)
    const robotic = ["assistant", "virtual", "model", "help", "assist", "beliefs", "language"];
    robotic.forEach(r => { if (lower.includes(r)) score -= 50; });

    // 4. Multi-language Vibe
    if (/[a-zA-Z]/.test(text) && /[\u0600-\u06FF]/.test(text)) score += 15; // Mix of English and Urdu script is elite

    return score;
}

async function performDeepAnalysis(senderJid, displayName = "User") {
    try {
        const historyPath = await resolveExistingHistoryPath(senderJid);
        const data = await fs.readFile(historyPath, "utf8");
        const history = JSON.parse(data).filter((m) => m.role !== "system");
        const recent = history.slice(-80);
        const allText = recent.map((h) => (h.content || "").toLowerCase()).join(" ");
        let analysis = "";

        const gName = inferGenderFromName(displayName);
        if (gName === "female" || gName === "female_likely") {
            analysis += `Name reads **girl-side** → sometimes **behen/sis** if it feels natural (not every line). `;
        } else if (gName === "male" || gName === "male_likely") {
            analysis += `Name reads **guy-side** → sometimes **bhai/bro** if natural. `;
        } else {
            analysis += `Name **unclear** → use **yaar/jani/dost**, don't guess bhai/behen. `;
        }

        const commonStopWords = new Set([
            "i", "me", "my", "you", "your", "the", "a", "is", "of", "to", "and", "hi", "hey", "hello", "han", "ach",
            "ok", "yaar", "ka", "ki", "kiya", "karo", "kya", "hai", "bhi", "wo", "se", "pe", "main", "nahi"
        ]);
        const words = allText.split(/\W+/).filter((w) => w.length > 3 && !commonStopWords.has(w));
        const freqMap = {};
        words.forEach((w) => {
            freqMap[w] = (freqMap[w] || 0) + 1;
        });
        const topInterests = Object.keys(freqMap)
            .sort((a, b) => freqMap[b] - freqMap[a])
            .slice(0, 6);
        if (topInterests.length > 0) analysis += `Topics they bring up: ${topInterests.join(", ")}. `;

        const femaleKeywords = ["sister", "sis", "behen", "baji", "girl", "she ", "her ", "ladki"];
        const maleKeywords = ["brother", "bhai", "paji", "boy", "he ", "his ", "ladka"];
        const fScore = femaleKeywords.filter((k) => allText.includes(k)).length;
        const mScore = maleKeywords.filter((k) => allText.includes(k)).length;
        if (fScore > mScore + 1 && fScore > 0) analysis += "Chat hints **she/her** — align tone gently. ";
        else if (mScore > fScore + 1 && mScore > 0) analysis += "Chat hints **he/him** — align tone. ";

        if (/\b(sir|madam|client|project|invoice|deadline|boss)\b/i.test(allText)) analysis += "Vibe: **work / professional** — stay sharp but still Mazhar. ";
        if (/\b(dear\b|sincerely|best regards|kind regards|warm regards|please find|attached|asap|fyi|vendor|stakeholder|quarterly)\b/i.test(allText)) {
            analysis += "Tone: **formal / professional** — mirror polite business style in their language, no excessive slang. ";
        }
        if (/\b(yaar|dost|scene|party|game|anime|meme)\b/i.test(allText)) analysis += "Vibe: **casual / friend** — chill slang OK. ";
        if (/\b(love|miss you|janu|baby|dil)\b/i.test(allText)) analysis += "Vibe: **close / soft** — warm, not cringe. ";
        if (/\b(mom|dad|ammi|abbu|family)\b/i.test(allText)) analysis += "Vibe: **family-ish** — respectful. ";

        if (/depress|suicide|khatam|hopeless|tension|dar lag|ro rahi|ro raha|stress/i.test(allText)) {
            analysis += "⚠️ May need **real encouragement** — be kind, real talk, optional `[GIF: hug]` / `[GIF: motivation]`. ";
        }

        if (/\b(fuck|gussa|fix|galat|problem)\b/i.test(allText)) analysis += "Mood: **tight / frustrated** — calm them, don't clown unless they joke first. ";
        else if (/\b(nice|love|haha|lol|funny|good)\b/i.test(allText)) analysis += "Mood: **light / good energy**. ";

        const lastAsst = recent
            .filter((m) => m.role === "assistant" || m.role === "model")
            .slice(-4)
            .map((m) => (m.content || "").replace(/\[[\s\S]*?\]/g, "").trim().slice(0, 55))
            .filter(Boolean);
        if (lastAsst.length) {
            analysis += `**Don't repeat** same opening as: ${lastAsst.join(" · ")}. `;
        }

        const userTurns = recent.filter((m) => m.role === "user").length;
        if (userTurns >= 8) {
            analysis +=
                "**Relationship signal:** long thread — talk like someone who **knows** them from context, not a cold intro. ";
        } else if (userTurns >= 2) {
            analysis += "**Relationship signal:** returning user — keep continuity with earlier topics. ";
        }

        return analysis.trim() || "Fresh chat — stay warm and human.";
    } catch (err) {
        return "First talk — go easy, learn their vibe.";
    }
}

async function saveMemory(senderJid, memory) {
    try {
        const historyPath = await resolveExistingHistoryPath(senderJid);
        await fs.mkdir(HISTORY_DIR, { recursive: true });
        await fs.writeFile(historyPath, JSON.stringify(memory, null, 2));
    } catch (err) { console.error("❌ [AI] Error saving history:", err.message); }
}

async function getMemory(senderJid) {
    return getOrInitMemory(senderJid, "User");
}

async function transcribeVoice(buffer) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY missing in .env (needed for voice notes)");
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
    memory.slice(-CHAT_CONTEXT_DEPTH).forEach(m => {
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
    const pauseKey = senderJid.endsWith("@g.us") ? senderJid : normalizeUserJid(senderJid);
    if (stopAiStatus.has(pauseKey)) {
        if (now < stopAiStatus.get(pauseKey)) return null;
        else stopAiStatus.delete(pauseKey);
    }
    if ((userMessage || "").toLowerCase().trim() === "resume") {
        stopAiStatus.delete(pauseKey);
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
        // Voice notes are NOT vision (type may be "audio" or "audio_transcribed"). Ignore audio + any stray thumbnail.
        const isAudioLike = mediaType === "audio" || mediaType === "audio_transcribed";
        const hasAnyVisual = Boolean(
            !isAudioLike && ((mediaBuffer && mediaBuffer.length) || thumbLen > 0)
        );

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
                const safeHistory = prepareChatContext(memory.slice(-CHAT_CONTEXT_DEPTH), "groq");
                apiContext = [memory[0], ...safeHistory];
                const msg = `[User ne ${mediaType || "media"} bheji; vision decode fail ya APIs ne scene nahi pakda. Caption: "${userMessage}". Mazhar ki tarah best guess + short reply.]`;
                if (apiContext.length > 1 && apiContext[apiContext.length - 1].role === "user") {
                    apiContext[apiContext.length - 1].content += "\n" + msg;
                } else {
                    apiContext.push({ role: "user", content: msg });
                }
            } else {
                const history = prepareChatContext(memory.slice(-CHAT_CONTEXT_DEPTH), "groq");
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
                            messages: [memory[0], ...prepareChatContext(memory.slice(-CHAT_CONTEXT_DEPTH), "groq"), { role: "user", content: userMessage }],
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
                        messages: [memory[0], ...prepareChatContext(memory.slice(-CHAT_CONTEXT_DEPTH), "groq"), { role: "user", content: userMessage }],
                        model: "openai"
                    })
                }).then((r) => r.text()),
                fetch("https://text.pollinations.ai/", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        messages: [memory[0], ...prepareChatContext(memory.slice(-CHAT_CONTEXT_DEPTH), "groq"), { role: "user", content: userMessage }],
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
            return "Photo/video/GIF abhi analyze nahi ho saka — GEMINI_API_KEY + GROQ_API_KEY .env mein set kar, phir dubara bhej (file choti kar ke try kar).";
        } else if (!reply) {
            return "Yaar net ka scene kharab hai, dobara query karo.";
        }

        reply = washAiReply(reply);

        if (reply.includes("[AI_STOP:")) {
            const mins = parseInt(reply.match(/\[AI_STOP:\s*(\d+)\]/i)?.[1]) || 1;
            stopAiStatus.set(pauseKey, now + (mins * 60 * 1000));
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

function pauseAiTemporarily(jid, ms = 120000) {
    const key = jid.endsWith("@g.us") ? jid : normalizeUserJid(jid);
    stopAiStatus.set(key, Date.now() + ms);
}

/** WhatsApp user texts: stop | break | resume */
function userPauseCommand(jid, lower) {
    const key = jid.endsWith("@g.us") ? jid : normalizeUserJid(jid);
    if (lower === "resume") {
        stopAiStatus.delete(key);
        return "🔊 Phir se ON yaar — bol.";
    }
    if (lower === "stop" || lower === "break") {
        stopAiStatus.set(key, Date.now() + 60 * 60 * 1000);
        return "🔇 Theek hai, 1 ghante ke liye main chup. *resume* likhna wapas ke liye.";
    }
    return "";
}

function toggleUserAi(jid, status) {
    const keys = new Set([coerceOutboundJid(jid), normalizeUserJid(jid), jid].filter(Boolean));
    if (status === false) keys.forEach((k) => aiDisabledUsers.add(k));
    else keys.forEach((k) => aiDisabledUsers.delete(k));
    
    // Persist to disk
    (async () => {
        try {
            await fs.writeFile(MUTED_FILE, Array.from(aiDisabledUsers).join("\n"), "utf8");
        } catch (e) {
            console.error("❌ [AI] Error saving muted list:", e.message);
        }
    })();
}

function isAiEnabled(jid) {
    if (!jid) return true;
    const c = coerceOutboundJid(jid);
    const n = normalizeUserJid(jid);
    return !aiDisabledUsers.has(c) && !aiDisabledUsers.has(n) && !aiDisabledUsers.has(jid);
}

async function getAllContacts() {
    try {
        const files = await fs.readdir(HISTORY_DIR);
        const contactPromises = files.filter(f => f.startsWith("history_") && f.endsWith(".json")).map(async f => {
            const safeJidName = f.replace("history_", "").replace(/\.json$/, "");
            let jid = decodeHistoryBasename(safeJidName);
            if (!jid) jid = historyBasenameToJid(safeJidName);
            if (!jid) {
                const digits = safeJidName.replace(/\D/g, "");
                jid = digits ? `${digits}@s.whatsapp.net` : null;
            }
            if (!jid) return null;
            
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
            const pauseUntil =
                stopAiStatus.get(jid) ||
                stopAiStatus.get(normalizeUserJid(jid)) ||
                stopAiStatus.get(coerceOutboundJid(jid)) ||
                0;
            const isPaused = now < pauseUntil;
            const phone = jid.split("@")[0];

            return {
                jid,
                phone,
                file: f,
                name,
                profilePic,
                overrideActive: Boolean(getUserPromptOverride(jid)),
                aiEnabled: isAiEnabled(jid),
                isPaused: isPaused,
                pauseRemaining: isPaused ? Math.ceil((pauseUntil - now) / 60000) : 0
            };
        });
        const rows = await Promise.all(contactPromises);
        return rows.filter(Boolean);
    } catch (e) { return []; }
}

async function getFullHistory(jid) {
    try {
        const historyPath = await resolveExistingHistoryPath(jid);
        return JSON.parse(await fs.readFile(historyPath, "utf8"));
    } catch (e) {
        return [];
    }
}

/**
 * Paginated non-system messages for dashboard (newest window, or older pages via beforeTs).
 */
async function getFullHistoryWindow(jid, { limit = 500, beforeTs = null } = {}) {
    let arr = [];
    try {
        const historyPath = await resolveExistingHistoryPath(jid);
        arr = JSON.parse(await fs.readFile(historyPath, "utf8"));
    } catch (e) {
        return { history: [], totalMessages: 0, hasOlder: false };
    }
    const msgs = arr.filter((m) => m.role !== "system");
    msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const lim = Math.min(Math.max(Number(limit) || 500, 20), 2000);
    let window;
    if (beforeTs == null || Number.isNaN(Number(beforeTs))) {
        window = msgs.slice(-lim);
    } else {
        const bt = Number(beforeTs);
        const older = msgs.filter((m) => (m.timestamp || 0) < bt);
        window = older.slice(-lim);
    }
    const oldestTs = window.length ? Math.min(...window.map((m) => m.timestamp || 0)) : null;
    const hasOlder = oldestTs != null && msgs.some((m) => (m.timestamp || 0) < oldestTs);
    return {
        history: window,
        totalMessages: msgs.length,
        hasOlder
    };
}

function setAdminPrompt(prompt) {
    adminCustomPrompt = prompt;
}

function setUserSpecificPrompt(jid, prompt) {
    const keys = new Set([coerceOutboundJid(jid), normalizeUserJid(jid), jid].filter(Boolean));
    if (!prompt) keys.forEach((k) => userSpecificPrompts.delete(k));
    else keys.forEach((k) => userSpecificPrompts.set(k, prompt));
}

function getUserPromptOverride(jid) {
    if (!jid) return null;
    const keys = [jid, coerceOutboundJid(jid), normalizeUserJid(jid)].filter(Boolean);
    for (const k of keys) {
        if (userSpecificPrompts.has(k)) return userSpecificPrompts.get(k);
    }
    return null;
}

async function addAdminMessageToMemory(jid, text) {
    try {
        const n = coerceOutboundJid(jid);
        const memory = await getOrInitMemory(n, "User");
        memory.push({ role: "assistant", content: `👑 MASTER BYPASS: ${text}`, timestamp: Date.now() });
        await saveMemory(n, memory);
    } catch (err) {}
}

module.exports = {
    mazharAiReply,
    transcribeVoice,
    stopAiStatus,
    pauseAiTemporarily,
    userPauseCommand,
    normalizeUserJid,
    coerceOutboundJid,
    buildLanguageHint,
    setAdminPrompt,
    toggleUserAi,
    isAiEnabled,
    getAllContacts,
    getFullHistory,
    getFullHistoryWindow,
    setUserSpecificPrompt,
    addAdminMessageToMemory,
    getMemory,
    saveMemory
};
