const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

/**
 * Searches for images using a stable public source.
 * Switches to a more reliable keyword-based image fetch.
 */
async function searchImages(query, count = 1) {
    const safeQuery = (query || "random").replace(/[^\w\s]/gi, "").trim();
    console.log(`🔍 [SYSTEM] Searching for ${count} images: ${safeQuery}`);

    try {
        const results = [];
        const safeCount = Math.min(Math.max(1, count), 5);

        for (let i = 0; i < safeCount; i++) {
            const lock = Math.floor(Math.random() * 1000000);
            // Switched to LoremFlickr as Unsplash Source is deprecated
            const url = `https://loremflickr.com/1280/720/${encodeURIComponent(safeQuery)}?lock=${lock}`;
            results.push(url);
        }
        return results;
    } catch (err) {
        console.error("❌ [IMAGE SERVICE] Error during URL generation:", err.message);
        return [];
    }
}

/**
 * Pollinations image generator – same provider used in your `image maker/` UI.
 * Returns a Buffer so Baileys can send it as an image reliably.
 */
function buildPollinationsUrl(prompt, { width = 1024, height = 1024, model = "flux", seed = null } = {}) {
    const basePrompt = (prompt || "ultra professional artwork").trim();
    const cb = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const base = `https://image.pollinations.ai/prompt/${encodeURIComponent(basePrompt)}`;
    const params = new URLSearchParams({
        width: String(width),
        height: String(height),
        model: String(model || "flux"),
        nologo: "true",
        enhance: "false",
        cb
    });
    const finalSeed = seed == null ? Math.floor(Math.random() * 2147483647) : seed;
    params.set("seed", String(finalSeed));
    return `${base}?${params.toString()}`;
}

async function generatePollinationsImage(prompt, opts = {}) {
    const url = buildPollinationsUrl(prompt, opts);
    console.log(`🖼️ [IMAGE GEN] Pollinations: ${url}`);
    try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    } catch (e) {
        console.error("❌ [IMAGE GEN] Failed:", e.message);
        return null;
    }
}

module.exports = { searchImages, buildPollinationsUrl, generatePollinationsImage };
