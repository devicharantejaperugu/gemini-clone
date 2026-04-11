const { GoogleGenerativeAI } = require('@google/generative-ai');
const { LocalIndex } = require('vectra');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.API_KEY);
const indexPath = path.join(__dirname, 'vectors');

// Initialize Local Index
const index = new LocalIndex(indexPath);

/**
 * Split text into chunks of roughly 1000 characters with 200 character overlap
 */
/**
 * Split text into chunks of roughly 1200 characters with 300 character overlap
 */
function chunkText(text, size = 1200, overlap = 300) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        chunks.push(text.slice(i, i + size));
        i += size - overlap;
    }
    return chunks;
}

/**
 * Generate embedding for a string using Gemini text-embedding-004
 */
async function getEmbedding(text) {
    try {
        const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error("Embedding Error:", error);
        return null;
    }
}

/**
 * Add a document or web scrape to the permanent vector store
 */
async function addDocument(filename, text, onProgress) {
    try {
        if (!fs.existsSync(indexPath)) {
            await index.createIndex();
        }

        const chunks = chunkText(text);
        if (onProgress) onProgress(`🧠 Indexing ${filename}: ${chunks.length} modules...`);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const vector = await getEmbedding(chunk);
            if (vector) {
                await index.insertItem({
                    vector,
                    metadata: { filename, content: chunk, index: i, timestamp: Date.now() }
                });
            }
        }
        return true;
    } catch (err) {
        console.error("Vector Indexing Error:", err);
        return false;
    }
}

/**
 * Search the permanent knowledge base
 */
async function queryDocuments(query, topK = 6) {
    try {
        if (!fs.existsSync(indexPath)) return [];
        
        const queryVector = await getEmbedding(query);
        if (!queryVector) return [];

        const results = await index.queryItems(queryVector, topK);
        return results.map(r => ({
            content: r.item.metadata.content,
            filename: r.item.metadata.filename,
            score: r.score
        }));
    } catch (err) {
        console.error("Vector Query Error:", err);
        return [];
    }
}

module.exports = {
    addDocument,
    queryDocuments
};
