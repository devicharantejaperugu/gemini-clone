const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdf = require('pdf-parse');
const vectorStore = require('./vector-store');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Validate API key at startup
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY || API_KEY.trim() === '') {
    console.error('❌ GEMINI_API_KEY is missing in .env file!');
    process.exit(1);
}
console.log(`🔑 API Key loaded: ${API_KEY.substring(0, 10)}...${API_KEY.substring(API_KEY.length - 4)}`);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname)));

// Multer Config for Uploads
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads/')) fs.mkdirSync('uploads/');

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(API_KEY);

const BASE_SYSTEM_INSTRUCTION = `You are an Advanced Autonomous Intelligence (Gemini 2.0 Apex).
Your mission is to provide definitive, research-grounded answers with absolute efficiency.

[CORE OPERATING PROTOCOLS]:
1. NO APOLOGIES: Never state "I cannot provide information" or "I apologize." If info is missing from immediate sources, use your vast internal neural knowledge combined with the provided context to synthesize a definitive expert-level answer.
2. GROUNDING: Leverage BOTH the [GROUNDING CONTEXT] (files/web) and your internal intelligence. Cite sources strictly with [number].
3. PERMANENT KNOWLEDGE: You have access to a permanent Vector Knowledge Base. treat it as your long-term memory.
4. AUTHORITY: Respond as a world-class domain expert. Be assertive, concise, and highly accurate.
5. CREATIVE POWER: If asked for media (image/music/sfx), generate it instantly with high creativity.

[CAPABILITIES]:
- [GEN_IMAGE: detailed prompt]
- [GEN_MUSIC: mood/style]
- [GEN_SFX: description]

[IDENTITY]: Apex Intelligence — The standard in real-time research and generation.`;

function getDynamicSystemInstruction() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    return `${BASE_SYSTEM_INSTRUCTION}\n\nCURRENT DATE AND TIME: ${dateStr}, ${timeStr}. Use this to handle relative time (yesterday, today, tomorrow).`;
}

// Models in priority order — falls back across different families to leverage separate quota buckets
// We prioritize 1.5-flash-8b and 1.5-flash as they have much higher free-tier quotas
const MODEL_LIST = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-lite",
    "gemini-3-flash-preview"
];

// Helper: sleep for ms
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ensures Gemini history follows strict (user, model, user, model) pattern
 * and excludes invalid/empty entries.
 */
function strictSanitizeHistory(history) {
    if (!Array.isArray(history)) return [];

    let sanitized = [];
    let expectedRole = 'user';

    for (const msg of history) {
        if (!msg.parts || !msg.parts[0] || !msg.parts[0].text || msg.parts[0].text.trim() === '') continue;

        // Gemini expects strict alternating roles starting with 'user'
        if (msg.role === expectedRole) {
            sanitized.push({
                role: msg.role,
                parts: [{ text: msg.parts[0].text.trim() }]
            });
            expectedRole = expectedRole === 'user' ? 'model' : 'user';
        }
    }

    // History must end with a model response for startChat to accept the next sendMessage as the next 'user' part
    if (sanitized.length > 0 && sanitized[sanitized.length - 1].role !== 'model') {
        sanitized.pop();
    }

    return sanitized;
}

async function tryStreamGenerate(promptParts, history = [], onChunk) {
    let lastError = null;
    const sanitizedHistory = strictSanitizeHistory(history);

    for (const modelName of MODEL_LIST) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(`📡 Streaming from model: ${modelName} (attempt ${attempt}/3)`);
                const model = genAI.getGenerativeModel({
                    model: modelName,
                    systemInstruction: getDynamicSystemInstruction(),
                    tools: [{ googleSearch: {} }]
                });

                const chat = model.startChat({
                    history: sanitizedHistory,
                });

                const result = await chat.sendMessageStream(promptParts);
                let fullText = "";
                
                for await (const chunk of result.stream) {
                    const chunkText = chunk.text();
                    fullText += chunkText;
                    if (onChunk) onChunk(chunkText);
                }

                const response = await result.response;
                const metadata = response.candidates?.[0]?.groundingMetadata;

                console.log(`✅ Stream complete from ${modelName}`);
                return { text: fullText, metadata };
            } catch (error) {
                lastError = error;
                const errMsg = error.message || '';
                console.error(`⚠️ ${modelName} Error: ${errMsg}`);

                if (errMsg.includes('API_KEY_INVALID') || errMsg.includes('401') || errMsg.includes('403')) {
                    throw new Error('Your API key is invalid or expired.');
                }
                
                const isRetryable = errMsg.includes('429') || errMsg.includes('503') || errMsg.includes('fetch failed') || errMsg.includes('Resource has been exhausted');
                if (isRetryable && attempt < 2) {
                    const waitTime = 2000;
                    console.warn(`⏳ Retrying ${modelName} in ${waitTime/1000}s...`);
                    await sleep(waitTime);
                    continue;
                }
                
                if (modelName !== MODEL_LIST[MODEL_LIST.length - 1]) {
                    console.warn(`🔄 Falling back from ${modelName}...`);
                    break; 
                }
            }
        }
    }
    throw lastError || new Error('All models failed. Please check your quota and API key.');
}

async function tryGenerate(prompt, history = []) {
    let fullText = "";
    await tryStreamGenerate(prompt, history, (chunk) => { fullText += chunk; });
    return fullText;
}

const { spawn } = require('child_process');

// Helper: Extract URL from prompt
function extractUrl(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const match = text.match(urlRegex);
    return match ? match[0] : null;
}

// Helper: Run Crawl4AI Python script
function crawlPage(url, onLog) {
    return new Promise((resolve) => {
        if (onLog) onLog(`🕸️ Starting crawl for: ${url}`);
        const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
        const pythonCmd = process.env.NODE_ENV === 'production' ? 'python3' : '.venv/Scripts/python';
        const pythonProcess = spawn(pythonCmd, ['crawler.py', '--url', url], { env });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg && onLog) onLog(msg);
            stderr += msg;
        });

        const timeout = setTimeout(() => {
            if (onLog) onLog(`⏳ Crawl timeout for ${url}`);
            pythonProcess.kill();
            resolve(null);
        }, 30000);

        pythonProcess.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0 && stdout.trim()) {
                if (onLog) onLog(`✅ Crawl complete (${stdout.length} characters)`);
                resolve(stdout.trim());
            } else {
                if (onLog) onLog(`❌ Crawl failed with code ${code}`);
                resolve(null);
            }
        });

        pythonProcess.on('error', (err) => {
            clearTimeout(timeout);
            if (onLog) onLog(`💥 Crawler Error: ${err.message}`);
            resolve(null);
        });
    });
}

// Helper: Run Web Search via Python script
function webSearch(query, onLog) {
    return new Promise((resolve) => {
        if (onLog) onLog(`🔍 Searching for: "${query}"`);
        const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
        const pythonCmd = process.env.NODE_ENV === 'production' ? 'python3' : '.venv/Scripts/python';
        const pythonProcess = spawn(pythonCmd, ['crawler.py', '--search', query], { env });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        pythonProcess.stderr.on('data', (data) => {
            if (onLog) onLog(data.toString());
            stderr += data.toString();
        });

        const timeout = setTimeout(() => {
            if (onLog) onLog(`⏳ Search timeout`);
            pythonProcess.kill();
            resolve(null);
        }, 30000);

        pythonProcess.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0 && stdout.trim()) {
                if (onLog) onLog(`✅ Search results gathered`);
                resolve(stdout.trim());
            } else {
                if (onLog) onLog(`❌ Search failed`);
                resolve(null);
            }
        });

        pythonProcess.on('error', (err) => {
            clearTimeout(timeout);
            if (onLog) onLog(`💥 Search Error: ${err.message}`);
            resolve(null);
        });
    });
}

// API Route for Chat (Now with Real-time Streaming and Multi-modal support)
app.post('/api/chat', async (req, res) => {
    const { prompt, history, directContext, image } = req.body;
    
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        let groundingContext = "";

        // PRIORITY 1: Direct Context (Newly attached file)
        if (directContext) {
            groundingContext += `\n[CURRENTLY ATTACHED DOCUMENT]:\n${directContext}\n[End of Attached Document]\n`;
            sendEvent({ type: 'log', message: `🔍 Focus: Analyzing the specific document you just attached...` });
        }

        // PRIORITY 2: VECTOR RAG: Search in previously uploaded documents
        try {
            sendEvent({ type: 'log', message: `🔍 Deep Search: Scanning knowledge base for relevant sections...` });
            const docResults = await vectorStore.queryDocuments(prompt);
            if (docResults.length > 0) {
                sendEvent({ type: 'log', message: `✅ Found ${docResults.length} relevant context blocks in your library.` });
                groundingContext += "\n\n[CONTEXT FROM KNOWLEDGE BASE]:\n";
                docResults.forEach(r => {
                    groundingContext += `\n--- Source: ${r.filename} ---\n${r.content}\n`;
                });
                groundingContext += "\n[End of Document Context]\n";
            }
        } catch (err) {
            console.error("Vector Search Error:", err);
            sendEvent({ type: 'log', message: `⚠️ Vector search failed (skipping docs)...` });
        }

        // 1. Check for URL to browse
        const urlToBrowse = extractUrl(prompt);
        if (urlToBrowse) {
            sendEvent({ type: 'log', message: `🔍 Detected URL: ${urlToBrowse}` });
            const pageMarkdown = await crawlPage(urlToBrowse, (log) => sendEvent({ type: 'log', message: log }));
            if (pageMarkdown) {
                groundingContext += `\n\n[LIVE WEB CONTEXT from ${urlToBrowse}]:\n${pageMarkdown}\n\n`;
            }
        }

        // 2. Autonomous Search Decision (Real AI behavior)
        let needsSearch = false;
        let searchQuery = prompt;
        
        // Safety Net: Force search for high-priority real-time topics
        const forceSearchKeywords = ["ipl", "score", "match", "cricket", "latest news", "stock price", "weather"];
        const isHighPriority = forceSearchKeywords.some(kw => prompt.toLowerCase().includes(kw));

        try {
            sendEvent({ type: 'log', message: `🧠 Thinking...` });
            
            // Inject current date context for the decision model
            const now = new Date();
            const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            
            const decisionPrompt = `TODAY'S DATE: ${dateStr}. 
            User request: "${prompt}". 
            Factual/Real-time requirement? YES/NONE. 
            If YES, return: YES | <optimized search query>. 
            If NONE, return: NONE.`;
            
            const decisionRaw = await tryGenerate(decisionPrompt);
            const decision = decisionRaw.trim();
            if (isHighPriority || decision.startsWith("YES")) {
                needsSearch = true;
                searchQuery = decision.includes("|") ? decision.split("|")[1].trim() : prompt;
                sendEvent({ type: 'log', message: `🔍 Searching...` });
            }
        } catch (e) {
            console.warn("Autonomous Search Decision failed, falling back to keywords.");
            needsSearch = isHighPriority || ["search", "latest", "news", "today"].some(kw => prompt.toLowerCase().includes(kw));
        }

        if (needsSearch && !urlToBrowse) {
            let searchOutput = await webSearch(searchQuery);
            
            if (searchOutput && searchOutput !== "[]") {
                try {
                    const searchResults = JSON.parse(searchOutput);
                    let sourceMetadata = [];
                    
                    sendEvent({ type: 'log', message: `🔍 Searching...` });
                    
                    // --- BREADTH GROUNDING: Add snippets directly to context ---
                    groundingContext += "\n\n[SEARCH RESULTS OVERVIEW]:\n";
                    searchResults.forEach((res, idx) => {
                        const sid = idx + 1;
                        groundingContext += `\n[Source ${sid}]: ${res.title}\nURL: ${res.url}\nMetadata: ${res.snippet}\n`;
                        sourceMetadata.push({ id: sid, title: res.title, url: res.url });
                    });

                    sendEvent({ type: 'sources', sources: sourceMetadata });

                    // --- DEEP RESEARCH & MAPPING TO MEMORY ---
                    const topUrls = searchResults.slice(0, 3).map(r => r.url);
                    if (topUrls.length > 0) {
                        sendEvent({ type: 'log', message: `🧠 Thinking...` });
                        
                        const crawlPromises = topUrls.map(async (url, idx) => {
                            const content = await crawlPage(url);
                            if (content) {
                                await vectorStore.addDocument(`WEBSOURCE_${Date.now()}_${idx}`, content);
                                return `[Source Web ${idx+1}]: Indexed successfully.`;
                            }
                            return "";
                        });

                        await Promise.all(crawlPromises);
                    }
                } catch (pe) {
                    console.error("Accuracy Refine Error:", pe);
                }
            }
        }

        // 3. SEAMANTICALLY ALIGNED RETRIEVAL (Unified RAG)
        // Use the AI-optimized 'searchQuery' for vector retrieval if a search was performed, 
        // as it is much more likely to match high-value facts than the raw user prompt.
        const retrievalQuery = needsSearch ? searchQuery : prompt;
        sendEvent({ type: 'log', message: `🧠 Thinking...` });
        
        const vectorResults = await vectorStore.queryDocuments(retrievalQuery, 8);
        if (vectorResults.length > 0) {
            groundingContext += "\n\n[DETAILED RETRIEVED FACTS]:\n";
            vectorResults.forEach((res, i) => {
                groundingContext += `\nDetail ${i+1} (from ${res.filename}):\n${res.content}\n`;
            });
        }

        // 4. Prepare Final Prompt (Grounding Enforcement)
        const finalPromptText = groundingContext
            ? `[GROUNDING CONTEXT]:
You are provided with a high-level [SEARCH RESULTS OVERVIEW] and [DETAILED RETRIEVED FACTS]. 
Your goal is to cross-reference multiple specific details to provide a 100% accurate, definitive answer.
Cite sources using [number] matches from the overview.
If data across sources is conflicting, prioritize more recent info or state the consensus.

RESEARCH DATA:
${groundingContext}

USER REQUEST: "${prompt}"`
            : prompt;

        // Support for Multi-modal Image parts
        let promptParts = [finalPromptText];
        if (image && image.data && image.mimeType) {
            sendEvent({ type: 'log', message: `🧠 Thinking...` });
            promptParts.push({
                inlineData: {
                    data: image.data,
                    mimeType: image.mimeType
                }
            });
        }

        sendEvent({ type: 'log', message: `🧠 Thinking...` });

        // 4. Generate AI response with Streaming
        let fullAiResponse = "";
        const result = await tryStreamGenerate(promptParts, history || [], (chunk) => {
            fullAiResponse += chunk;
            sendEvent({ type: 'chunk', text: chunk });
        });

        if (result.metadata) {
            sendEvent({ type: 'grounding', metadata: result.metadata });
        }

        // 5. Generate Follow-up Suggestions (Real-time AI behavior)
        try {
            const suggestionPrompt = `Based on our current conversation and the user's last request: "${prompt}", generate 3 short, curiosity-inducing follow-up questions the user might want to ask next. 
            Format: Exactly three lines, each starting with a bullet point "-". No other text.`;
            
            const suggestionsRaw = await tryGenerate(suggestionPrompt, history || [{ role: 'user', parts: [{ text: prompt }] }, { role: 'model', parts: [{ text: fullAiResponse }] }]);
            const suggestions = suggestionsRaw
                .split('\n')
                .filter(s => s.trim().startsWith('-'))
                .map(s => s.trim().replace(/^-\s*/, '').replace(/^[0-9]\.\s*/, ''))
                .slice(0, 3);
            
            if (suggestions.length > 0) {
                sendEvent({ type: 'suggestions', suggestions });
            }
        } catch (suggestionErr) {
            console.error("Suggestion Error:", suggestionErr);
        }

        res.end();
    } catch (error) {
        console.error("Gemini API Error Detail:", error.message || error);
        sendEvent({ type: 'error', message: error.message || "Failed to generate AI response" });
        res.end();
    }
});

// API Route for File Upload & Indexing
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = req.file.path;
    const originalName = req.file.originalname;
    
    // Set up SSE headers for the response to show progress
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    
    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        sendEvent({ type: 'log', message: `📂 Received ${originalName}. Extracting text...` });
        
        let text = "";
        if (originalName.toLowerCase().endsWith('.pdf')) {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);
            text = data.text;
        } else {
            text = fs.readFileSync(filePath).toString();
        }

        if (!text || text.trim().length === 0) {
            throw new Error("No text content could be extracted from this file.");
        }

        // Send extracted text to frontend so it can be used immediately in the next prompt
        sendEvent({ type: 'text', content: text });

        sendEvent({ type: 'log', message: `🧠 Indexing content into Vector DB for long-term memory...` });
        await vectorStore.addDocument(originalName, text, (msg) => {
            sendEvent({ type: 'log', message: msg });
        });

        sendEvent({ type: 'success', message: `${originalName} indexed successfully!` });
        res.end();
    } catch (error) {
        console.error("Upload/Indexing Error:", error);
        sendEvent({ type: 'error', message: error.message || "Failed to index document" });
        res.end();
    } finally {
        // Clean up temporary file
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
});

/**
 * AI Title Generation Endpoint
 * Generates a concise, catchy title (3-5 words) for a new chat session based on the first message.
 */
app.post('/api/title', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    try {
        const titlePrompt = `Generate a very concise, poetic, and catchy title (MAX 4 words) for a chat that starts with this request: "${prompt}". 
        Be creative and use professional language. Return ONLY the title text, no quotes or punctuation.`;
        
        const title = await tryGenerate(titlePrompt);
        res.json({ title: title.trim().replace(/^"|"$/g, '') });
    } catch (error) {
        console.error("Title Generation Error:", error);
        res.status(500).json({ title: "New Conversation" });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
