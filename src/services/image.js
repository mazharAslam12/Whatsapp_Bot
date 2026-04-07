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

// Style variants copied from `image maker/script.js` so WhatsApp can generate multi-style images too.
const STYLE_VARIANTS = [
    { label: "Balanced", suffix: "" },
    { label: "Photoreal", suffix: ", photorealistic, 8k uhd, detailed texture, natural lighting, shot on full frame" },
    { label: "Anime", suffix: ", anime style, clean line art, vibrant colors, cel shading, high detail" },
    { label: "3D render", suffix: ", 3d render, octane render, studio lighting, subsurface scattering, highly detailed" },
    { label: "Cinematic", suffix: ", cinematic composition, dramatic lighting, film grain, wide angle, color graded" },
    { label: "Oil paint", suffix: ", oil painting, visible brush strokes, rich impasto, museum quality" }
];

async function generatePollinationsImageVariants(prompt, { count = 2, width = 1024, height = 1024, model = "flux" } = {}) {
    const base = (prompt || "").trim();
    const safeCount = Math.min(Math.max(parseInt(count, 10) || 2, 1), 4);
    const picks = STYLE_VARIANTS.slice(0, safeCount);
    const results = [];
    for (const v of picks) {
        const buf = await generatePollinationsImage(`${base}${v.suffix}`, { width, height, model });
        if (buf && buf.length) results.push({ label: v.label, buffer: buf });
    }
    return results;
}

module.exports = {
    searchImages,
    buildPollinationsUrl,
    generatePollinationsImage,
    generatePollinationsImageVariants,
    STYLE_VARIANTS
};
