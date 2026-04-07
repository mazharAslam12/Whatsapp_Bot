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
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 20000);
        const res = await fetch(url, { redirect: "follow", signal: controller.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    } catch (e) {
        console.error("❌ [IMAGE GEN] Failed:", e.message);
        return null;
    }
}

// Style variants synced from `image maker/script.js`
const STYLE_VARIANTS = [
    { label: 'Balanced', desc: 'General purpose', suffix: '' },
    { label: 'Photoreal', desc: 'Sharp, natural', suffix: ', photorealistic, 8k uhd, detailed texture, natural lighting, shot on full frame' },
    { label: 'Anime', desc: 'Illustration', suffix: ', anime style, clean line art, vibrant colors, cel shading, high detail' },
    { label: '3D render', desc: 'CGI look', suffix: ', 3d render, octane render, studio lighting, subsurface scattering, highly detailed' },
    { label: 'Cinematic', desc: 'Film still', suffix: ', cinematic composition, dramatic lighting, film grain, wide angle, color graded' },
    { label: 'Oil paint', desc: 'Fine art', suffix: ', oil painting, visible brush strokes, rich impasto, museum quality' }
];

/**
 * Describe the reference image so text-to-image can follow it (Pollinations vision API).
 * Ported from image maker/script.js for bot use.
 */
async function analyzeReferenceImage(dataUrl) {
    const payload = {
        model: 'openai',
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: 'Describe ONLY what is visible in this image: main subjects, poses, colors, materials, lighting, background, art style, and composition. Be concrete. No preamble — max 1200 characters.'
                },
                { type: 'image_url', image_url: { url: dataUrl } }
            ]
        }],
        max_tokens: 500,
        temperature: 0.3
    };
    try {
        const res = await fetch('https://text.pollinations.ai/openai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Vision request failed');
        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim();
    } catch (err) {
        console.warn('Vision analysis failed', err);
        return null;
    }
}

async function generatePollinationsImageVariants(prompt, { count = 2, width = 1024, height = 1024, model = "flux" } = {}) {
    const base = (prompt || "").trim();
    const safeCount = Math.min(Math.max(parseInt(count, 10) || 2, 1), STYLE_VARIANTS.length);
    const picks = STYLE_VARIANTS.slice(0, safeCount);
    const results = [];
    for (const v of picks) {
        const fullPrompt = `${base}${v.suffix}`;
        const url = buildPollinationsUrl(fullPrompt, { width, height, model });
        const buf = await generatePollinationsImage(fullPrompt, { width, height, model });
        if (buf && buf.length) results.push({ label: v.label, buffer: buf, url });
    }
    return results;
}

module.exports = {
    searchImages,
    buildPollinationsUrl,
    generatePollinationsImage,
    generatePollinationsImageVariants,
    analyzeReferenceImage,
    STYLE_VARIANTS
};
