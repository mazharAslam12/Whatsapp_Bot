const { searchWebImages } = require("./search");

/**
 * Searches for images using a stable public source.
 * Switches to a more reliable keyword-based image fetch.
 */
async function searchImages(query, count = 1) {
    try {
        return await searchWebImages(query, count);
    } catch (err) {
        console.error("❌ [IMAGE SERVICE] Error during URL generation:", err.message);
        // Fallback
        const safeQuery = (query || "random").replace(/[^\w\s]/gi, "").trim();
        const lock = Math.floor(Math.random() * 1000000);
        return [`https://loremflickr.com/1280/720/${encodeURIComponent(safeQuery)}?lock=${lock}`];
    }
}

module.exports = { searchImages };
