/**
 * MULTI-API GIF ENGINE
 * Uses multiple sources to ensure GIFs are ALWAYS found.
 */
async function getGif(query) {
    const q = (query || "happy").toLowerCase();
    const categories = [
        "naruto", "manga", "kawaii", "anime", "meme", "funny", "hype", "cat", "dog", "pet",
        "smile", "wave", "happy", "dance", "laugh", "hug", "wink", "pat", "bonk", "yeet", "bully", "slap", "kill",
        "cringe", "cuddle", "cry", "love", "angry", "surprised", "thinking", "success", "motivation", "cartoon"
    ];
    let category = categories.find((c) => q.includes(c)) || "smile";

    let tenorQ = category;
    if (q.includes("anime") || q.includes("naruto") || q.includes("manga") || q.includes("kawaii")) tenorQ = "anime";
    else if (q.includes("meme")) tenorQ = "meme funny";
    else if (q.includes("funny") || q.includes("hype")) tenorQ = "funny hype";
    else if (q.includes("cat") || q.includes("pet")) tenorQ = "cute cat";
    else if (q.includes("dog")) tenorQ = "cute dog";

    // --- Map to waifu.pics / nekos valid SFW tags ---
    if (category === "laugh") category = "smile";
    if (category === "cringe" || category === "thinking") category = "smug";
    if (category === "success" || category === "motivation") category = "happy";
    if (category === "angry" || category === "cartoon") category = "bully";
    if (["anime", "naruto", "manga", "kawaii"].includes(category)) category = "waifu";
    if (["meme", "funny", "hype"].includes(category)) category = "happy";
    if (category === "cat" || category === "pet") category = "pat";
    if (category === "dog") category = "happy";

    console.log(`🎬 [GIF ENGINE] tenorQ=${tenorQ} waifuCategory=${category}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s strict timeout

    // SOURCE 0a: Tenor Google API v2 (set TENOR_API_KEY in .env — recommended; v1 often rate-limits)
    const tenorGoogleKey = process.env.TENOR_API_KEY || process.env.GOOGLE_TENOR_KEY;
    if (tenorGoogleKey) {
        try {
            const v2Url = `https://tenor.googleapis.com/v2/search?${new URLSearchParams({
                q: tenorQ,
                key: tenorGoogleKey,
                limit: "12",
                media_filter: "tinygif,tinywebm,nanomp4"
            })}`;
            const tenorRes = await fetch(v2Url, { signal: controller.signal });
            if (tenorRes.ok) {
                const data = await tenorRes.json();
                const results = data.results || [];
                if (results.length > 0) {
                    const pick = results[Math.floor(Math.random() * Math.min(5, results.length))];
                    const fmt = pick.media_formats || {};
                    const mp4 = fmt.nanomp4 || fmt.mp4 || fmt.tinywebm || fmt.webm;
                    const url = mp4?.url || fmt.gif?.url || fmt.tinygif?.url;
                    if (url) {
                        const isMp4 = /\.mp4(\?|$)/i.test(url) || (mp4 && /mp4/i.test(mp4.url || ""));
                        console.log(`✅ [GIF] Tenor v2: ${url}`);
                        clearTimeout(timeout);
                        return { url, isMp4: !!isMp4 };
                    }
                }
            }
        } catch (err) {
            console.warn("⚠️ [GIF] Tenor v2 failed, trying legacy v1...");
        }
    }

    // SOURCE 0b: Tenor legacy v1 (public demo key — may fail)
    try {
        console.log("📡 [GIF] Fetching from Tenor API v1 (MP4)...");
        const tenorParams = new URLSearchParams({
            q: tenorQ,
            key: "LIVDSRZULELA",
            limit: "10"
        });
        const tenorRes = await fetch(`https://api.tenor.com/v1/search?${tenorParams}`, { signal: controller.signal });
        if (tenorRes.ok) {
            const data = await tenorRes.json();
            if (data.results && data.results.length > 0) {
                // Randomize selection
                const topResults = data.results.slice(0, 5);
                topResults.sort(() => 0.5 - Math.random());
                const mediaObject = topResults[0].media[0];

                // Prioritize tinywebm/mp4 for animation
                const mp4Url = mediaObject.mp4 ? mediaObject.mp4.url : (mediaObject.tinywebm ? mediaObject.tinywebm.url : mediaObject.gif.url);
                // Flag if it's explicitly an MP4 so message.js knows how to send it natively
                const isMp4 = mp4Url.endsWith('.mp4');

                console.log(`✅ [GIF] Source 0 (Tenor) Link: ${mp4Url}`);
                clearTimeout(timeout);
                return { url: mp4Url, isMp4 };
            }
        }
    } catch (err) {
        console.warn("⚠️ [GIF] Source 0 (Tenor) failed/timed out, trying Source 1...");
    }

    // --- [ORIGINAL CODE PRESERVED BELOW] ---
    // SOURCE 1: waifu.pics
    try {
        console.log("📡 [GIF] Fetching from waifu.pics...");
        const res = await fetch(`https://api.waifu.pics/sfw/${category}`, { signal: controller.signal });
        console.log(`📡 [GIF] waifu.pics status: ${res.status}`);
        if (res.ok) {
            const data = await res.json();
            console.log(`✅ [GIF] Source 1 Link: ${data.url}`);
            clearTimeout(timeout);
            return { url: data.url, isMp4: false };
        }
    } catch (err) {
        console.warn("⚠️ [GIF] Source 1 failed/timed out, trying Source 2...");
    }

    // SOURCE 2: otakugif.xyz (Fallback API)
    try {
        const otakuReact = category === "waifu" ? "happy" : category;
        console.log("📡 [GIF] Fetching from otakugif.xyz...");
        const res = await fetch(`https://api.otakugif.xyz/gif?reaction=${otakuReact}`, { signal: controller.signal });
        console.log(`📡 [GIF] otakugif.xyz status: ${res.status}`);
        if (res.ok) {
            const data = await res.json();
            console.log(`✅ [GIF] Source 2 Link: ${data.url}`);
            clearTimeout(timeout);
            return { url: data.url, isMp4: false };
        }
    } catch (err) {
        console.warn("⚠️ [GIF] Source 2 failed/timed out, trying Source 3...");
    }

    // SOURCE 3: nekos.best (New API Expansion v52.0)
    try {
        console.log("📡 [GIF] Fetching from nekos.best...");

        let nekoCategory = category;
        if (category === "waifu") nekoCategory = "waifu";
        else if (category === "angry" || category === "bully") nekoCategory = "baka";
        else if (category === "happy" || category === "smile") nekoCategory = "happy";

        const res = await fetch(`https://nekos.best/api/v2/${nekoCategory}`, { signal: controller.signal });
        console.log(`📡 [GIF] nekos.best status: ${res.status}`);
        if (res.ok) {
            const data = await res.json();
            if (data.results && data.results.length > 0) {
                console.log(`✅ [GIF] Source 3 Link: ${data.results[0].url}`);
                clearTimeout(timeout);
                return { url: data.results[0].url, isMp4: false };
            }
        }
    } catch (err) {
        console.error("❌ [GIF ENGINE] All 3 APIs failed or timed out.");
    } finally {
        clearTimeout(timeout);
    }

    // FINAL FALLBACK: Giphy Public Link
    return { url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJqZ3RreXQ0Z3RqZ3RreXQ0Z3RqZ3RreXQ0Z3RqZ3RreXQ0Z3ImZXA9djFfZ2lmc19zZWFyY2gmY3Q9Zw/3o7TKP9ln2DrM3hAS4/giphy.gif", isMp4: false };
}

module.exports = { getGif };
