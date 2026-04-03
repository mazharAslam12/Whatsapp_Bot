const fs = require('fs').promises;
const path = require('path');

const ROOT_DIR = path.join(__dirname, '../../'); // Ensure it targets the root workspace

async function readCode(filePath) {
    try {
        const fullPath = path.join(ROOT_DIR, filePath);
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
            const files = await fs.readdir(fullPath);
            return `Directory contents of ${filePath}:\n${files.join(', ')}`;
        }
        if (stat.size > 50000) { // Limit huge files
            return `File ${filePath} is too large to read entirely.`;
        }
        const data = await fs.readFile(fullPath, 'utf8');
        return `[CONTENTS OF ${filePath}]\n\`\`\`javascript\n${data}\n\`\`\``;
    } catch (err) {
        return `Error reading code: ${err.message}`;
    }
}

async function writeCode(filePath, content) {
    try {
        const fullPath = path.join(ROOT_DIR, filePath);
        // Ensure directory exists
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content);
        return `Successfully updated ${filePath}. Code successfully modified!`;
    } catch (err) {
        return `Error writing code: ${err.message}`;
    }
}

module.exports = { readCode, writeCode };
