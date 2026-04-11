document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('sidebar');
    const menuToggle = document.getElementById('menuToggle');
    const welcomeBanner = document.getElementById('welcomeBanner');
    const closeBanner = document.getElementById('closeBanner');
    const promptInput = document.getElementById('promptInput');
    const heroSection = document.getElementById('heroSection');
    const chatResults = document.getElementById('chatResults');
    const newChatBtn = document.querySelector('.new-chat-btn');
    const imageBtn = document.getElementById('imageBtn');
    const fileInput = document.getElementById('fileInput');
    const voiceBtn = document.getElementById('voiceBtn');
    const attachmentPreview = document.getElementById('attachmentPreview');

    const API_BASE_URL = window.location.hostname === 'localhost' ? 'http://localhost:5000' : '';

    // Persistence State (Multi-Chat Upgrade)
    let allChats = JSON.parse(localStorage.getItem('gemini_all_chats') || '[]');
    let currentChatId = localStorage.getItem('gemini_current_chat_id');
    
    // Migration logic for old format
    if (allChats.length === 0) {
        let oldHistory = JSON.parse(localStorage.getItem('gemini_chat_history') || '[]');
        if (oldHistory.length > 0) {
            const initialChat = {
                id: Date.now().toString(),
                title: 'Restored Conversation',
                messages: oldHistory,
                timestamp: Date.now()
            };
            allChats.push(initialChat);
            currentChatId = initialChat.id;
            localStorage.setItem('gemini_all_chats', JSON.stringify(allChats));
            localStorage.setItem('gemini_current_chat_id', currentChatId);
        }
    }

    let chatHistory = [];
    if (currentChatId) {
        const currentChat = allChats.find(c => c.id === currentChatId);
        if (currentChat) chatHistory = currentChat.messages;
    }

    let pendingFile = null;
    let pendingImage = null; // Base64 image data
    let currentSources = [];
    let isSpeaking = false;
    let synth = window.speechSynthesis;
    let currentAbortController = null;

    const stopBtn = document.getElementById('stopBtn');
    const historyList = document.getElementById('historyList');

    // --- Stop Generation Logic ---
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
                stopBtn.style.display = 'none';
                sendBtn.style.display = 'flex';
            }
        });
    }

    // --- Image / File Handling ---
    if (imageBtn && fileInput) {
        imageBtn.addEventListener('click', () => fileInput.click());
        
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files[0];
            if (!file) return;
            
            if (file.type.startsWith('image/')) {
                pendingImage = await convertToBase64(file);
                pendingFile = file;
            } else {
                pendingFile = file;
                pendingImage = null;
            }
            
            renderAttachmentPreview();
            fileInput.value = ''; 
            promptInput.focus();
        });
    }

    const convertToBase64 = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = error => reject(error);
        });
    };

    const renderAttachmentPreview = () => {
        attachmentPreview.innerHTML = '';
        if (!pendingFile) return;

        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        const icon = pendingImage ? 'image' : 'description';
        chip.innerHTML = `
            <span class="material-icons-outlined" style="font-size: 16px;">${icon}</span>
            <span>${pendingFile.name}</span>
            <span class="material-icons-outlined close-chip" id="removeAttachment">close</span>
        `;
        attachmentPreview.appendChild(chip);

        document.getElementById('removeAttachment').addEventListener('click', () => {
            pendingFile = null;
            pendingImage = null;
            renderAttachmentPreview();
        });
    };

    // --- Voice Input (Speech Recognition) ---
    if (voiceBtn) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            const recognition = new SpeechRecognition();
            recognition.continuous = false;
            recognition.lang = 'en-US';

            voiceBtn.addEventListener('click', () => {
                if (voiceBtn.classList.contains('listening')) {
                    recognition.stop();
                } else {
                    recognition.start();
                    voiceBtn.classList.add('listening');
                    promptInput.placeholder = "Listening...";
                }
            });

            recognition.onresult = (event) => {
                const transcript = event.results[0][0].transcript;
                promptInput.value = transcript;
                sendMessage();
            };

            recognition.onend = () => {
                voiceBtn.classList.remove('listening');
                promptInput.placeholder = "Ask Gemini";
            };
        } else {
            voiceBtn.style.display = 'none';
        }
    }

    // --- Sidebar & Banner ---
    if (menuToggle) menuToggle.addEventListener('click', (e) => { e.stopPropagation(); sidebar.classList.toggle('expanded'); });
    document.addEventListener('click', (e) => { if (!sidebar.contains(e.target) && sidebar.classList.contains('expanded')) sidebar.classList.remove('expanded'); });
    if (closeBanner) closeBanner.addEventListener('click', () => { welcomeBanner.style.display = 'none'; });

    // --- History UI Rendering ---
    const renderHistory = () => {
        if (!historyList) return;
        historyList.innerHTML = '';
        
        // Sort by timestamp descending
        const sortedChats = [...allChats].sort((a, b) => b.timestamp - a.timestamp);
        
        sortedChats.forEach(chat => {
            const item = document.createElement('div');
            item.className = `history-item ${chat.id === currentChatId ? 'active' : ''}`;
            item.innerHTML = `
                <span class="material-icons-outlined">chat_bubble_outline</span>
                <span>${chat.title}</span>
            `;
            item.onclick = () => loadChat(chat.id);
            historyList.appendChild(item);
        });
    };

    const loadChat = (id) => {
        const chat = allChats.find(c => c.id === id);
        if (!chat) return;

        currentChatId = id;
        chatHistory = chat.messages;
        localStorage.setItem('gemini_current_chat_id', id);
        
        // Update UI
        chatResults.innerHTML = '';
        if (chatHistory.length > 0) {
            heroSection.style.display = 'none';
            chatResults.style.display = 'flex';
            if (welcomeBanner) welcomeBanner.style.display = 'none';
            chatHistory.forEach(msg => appendMessage(msg.role, msg.content, null, false));
        } else {
            heroSection.style.display = 'flex';
            chatResults.style.display = 'none';
            if (welcomeBanner) welcomeBanner.style.display = 'block';
        }
        
        renderHistory();
        promptInput.focus();
    };

    const createNewChat = () => {
        const newId = Date.now().toString();
        const newChat = {
            id: newId,
            title: 'New Chat',
            messages: [],
            timestamp: Date.now()
        };
        allChats.push(newChat);
        currentChatId = newId;
        chatHistory = [];
        saveAllChats();
        loadChat(newId);
    };

    const generateChatTitle = async (prompt, chatId) => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/title`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt })
            });
            const data = await response.json();
            if (data.title) {
                const chat = allChats.find(c => c.id === chatId);
                if (chat) {
                    chat.title = data.title;
                    saveAllChats();
                    renderHistory();
                }
            }
        } catch (err) { console.error('Title generation failed:', err); }
    };

    // --- Main Chat Logic ---
    const sendMessage = async (prompt) => {
        const inputVal = prompt || promptInput.value;
        if (!inputVal.trim() && !pendingFile) return;

        // If no active chat, create one
        if (!currentChatId || (allChats.length > 0 && !allChats.find(c => c.id === currentChatId))) {
            createNewChat();
        }

        // Handle Abort Controller
        if (currentAbortController) currentAbortController.abort();
        currentAbortController = new AbortController();
        const { signal } = currentAbortController;

        if (stopBtn) stopBtn.style.display = 'flex';
        if (sendBtn) sendBtn.style.display = 'none';

        if (heroSection.style.display !== 'none') {
            heroSection.style.display = 'none';
            chatResults.style.display = 'flex';
            if (welcomeBanner) welcomeBanner.style.display = 'none';
        }

        const userPrompt = inputVal.trim() || (pendingFile ? `Analyze this: ${pendingFile.name}` : '');
        
        // Generate title for the very first message
        if (chatHistory.length === 0) {
            generateChatTitle(userPrompt, currentChatId);
        }

        appendMessage('user', userPrompt);
        promptInput.value = '';

        const loadingId = 'ai-' + Date.now();
        appendMessage('ai', '', loadingId, false);
        const currentMessageEl = document.getElementById(loadingId);
        const contentEl = currentMessageEl.querySelector('.message-content');

        let directContext = null;
        let imagePayload = null;

        // Handle Image
        if (pendingImage) {
            imagePayload = { data: pendingImage, mimeType: pendingFile.type };
            pendingImage = null;
        }

        // Handle Documents
        if (pendingFile && !imagePayload) {
            try {
                const formData = new FormData();
                formData.append('file', pendingFile);
                const uploadResponse = await fetch(`${API_BASE_URL}/api/upload`, { method: 'POST', body: formData });
                const reader = uploadResponse.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const lines = decoder.decode(value).split('\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const event = JSON.parse(line.substring(6));
                            if (event.type === 'text') directContext = (directContext || '') + event.content;
                            if (event.type === 'log') {
                                const consoleEl = currentMessageEl.querySelector('.crawler-console') || createCrawlerConsole(loadingId);
                                appendLogToConsole(consoleEl, event.message);
                            }
                        }
                    }
                }
            } catch (err) { console.error('Upload error:', err); }
        }
        pendingFile = null;
        renderAttachmentPreview();

        // Streaming Request
        try {
            const apiHistory = chatHistory.filter(msg => msg.content).map(msg => ({
                role: msg.role === 'ai' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            }));

            const response = await fetch(`${API_BASE_URL}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: userPrompt, history: apiHistory, directContext, image: imagePayload })
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let aiText = '';
            let collectedSuggestions = [];
            contentEl.innerHTML = '<div class="typing-cursor"></div>';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');
                for (const line of lines) {
                    if (line.trim().startsWith('data: ')) {
                        try {
                            const event = JSON.parse(line.trim().substring(6));
                            if (event.type === 'chunk') {
                                aiText += event.text;
                                contentEl.innerHTML = formatMessage(aiText) + '<div class="typing-cursor"></div>';
                                window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
                            } else if (event.type === 'log') {
                                const consoleEl = currentMessageEl.querySelector('.crawler-console') || createCrawlerConsole(loadingId);
                                appendLogToConsole(consoleEl, event.message);
                            } else if (event.type === 'sources') {
                                currentSources = event.sources;
                            } else if (event.type === 'grounding') {
                                if (event.metadata && event.metadata.groundingChunks) {
                                    const nativeSources = event.metadata.groundingChunks.map((chunk, i) => ({
                                        id: currentSources.length + i + 1,
                                        title: chunk.web?.title || `Source ${i + 1}`,
                                        url: chunk.web?.uri || '#'
                                    }));
                                    currentSources = [...currentSources, ...nativeSources];
                                }
                            } else if (event.type === 'suggestions') {
                                collectedSuggestions = event.suggestions;
                            }
                        } catch (e) {}
                    }
                }
            }

            if (stopBtn) stopBtn.style.display = 'none';
            if (sendBtn) sendBtn.style.display = 'flex';
            currentAbortController = null;
            
            // Final render
            contentEl.innerHTML = formatMessage(aiText);
            addMessageControls(loadingId, aiText);

            // Now show the "links" and suggestions after thinking/retrieving is done
            if (currentSources.length > 0) renderSources(loadingId, currentSources);
            if (collectedSuggestions.length > 0) renderSuggestions(loadingId, collectedSuggestions);

            chatHistory.push({ role: 'ai', content: aiText });
            saveChat(currentChatId);
        } catch (error) {
            if (error.name === 'AbortError') {
                contentEl.innerHTML += ' <span style="color:var(--text-secondary); font-style:italic;">(Generation stopped)</span>';
            } else {
                contentEl.innerText = `Error: ${error.message}`;
            }
            if (stopBtn) stopBtn.style.display = 'none';
            if (sendBtn) sendBtn.style.display = 'flex';
        }
    };

    // --- Message Formatting (Marked + DOMPurify) ---
    function formatMessage(text) {
        if (!text) return '';
        
        let processed = text.replace(/\[GEN_IMAGE:\s*(.*?)\]/g, (m, p) => {
            const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=800&height=500&nologo=true`;
            return `<div class="media-result image-result"><img src="${url}" alt="${p}"/><div class="media-info"><span class="material-icons-outlined">image</span>Generated Visual: ${p}</div></div>`;
        });

        processed = processed.replace(/\[GEN_MUSIC:\s*(.*?)\]/g, (m, p) => {
            const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?model=audio`;
            return `<div class="media-result audio-result"><audio controls src="${url}"></audio><div class="media-info"><span class="material-icons-outlined">music_note</span>Generated Music: ${p}</div></div>`;
        });

        processed = processed.replace(/\[GEN_SFX:\s*(.*?)\]/g, (m, p) => {
            const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?model=audio`;
            return `<div class="media-result audio-result"><audio controls src="${url}"></audio><div class="media-info"><span class="material-icons-outlined">graphic_eq</span>Generated SFX: ${p}</div></div>`;
        });

        processed = processed.replace(/\[([0-9]+)\]/g, `<span class="citation" onclick="jumpToSource($1)">[$1]</span>`);

        const rawHtml = marked.parse(processed);
        return DOMPurify.sanitize(rawHtml);
    }

    const addMessageControls = (id, text) => {
        const msgEl = document.getElementById(id);
        const controls = document.createElement('div');
        controls.className = 'message-controls';
        controls.innerHTML = `
            <span class="material-icons-outlined control-icon" onclick="copyToClipboard('${id}-text')">content_copy</span>
            <span class="material-icons-outlined control-icon" id="speak-${id}">volume_up</span>
        `;
        msgEl.querySelector('.message-content').appendChild(controls);
        
        const hiddenText = document.createElement('div');
        hiddenText.id = `${id}-text`;
        hiddenText.style.display = 'none';
        hiddenText.innerText = text;
        msgEl.appendChild(hiddenText);

        document.getElementById(`speak-${id}`).addEventListener('click', () => toggleSpeech(text, `speak-${id}`));
    };

    const toggleSpeech = (text, btnId) => {
        const btn = document.getElementById(btnId);
        if (isSpeaking) {
            synth.cancel();
            isSpeaking = false;
            btn.innerText = 'volume_up';
        } else {
            const utterance = new SpeechSynthesisUtterance(text.replace(/\[.*?\]/g, ''));
            utterance.onend = () => { isSpeaking = false; btn.innerText = 'volume_up'; };
            synth.speak(utterance);
            isSpeaking = true;
            btn.innerText = 'volume_off';
        }
    };

    // --- Helper Functions ---
    const createCrawlerConsole = (pid) => {
        const parent = document.getElementById(pid);
        const contentArea = parent.querySelector('.message-content');
        const consoleEl = document.createElement('div');
        consoleEl.className = 'crawler-console';
        contentArea.prepend(consoleEl);
        return consoleEl;
    };

    const appendLogToConsole = (el, msg) => {
        // Only show a single status at a time for a cleaner UI
        el.innerHTML = ''; 
        const log = document.createElement('div');
        log.className = 'log-entry';
        if (msg.includes('✅') || msg.includes('🔍')) log.classList.add('success');
        if (msg.includes('❌')) log.classList.add('error');
        
        // Remove technical emojis if present for a cleaner look
        const cleanMsg = msg.replace(/[🔍✅📖🧠]/g, '').trim();
        log.innerText = cleanMsg;
        el.appendChild(log);
    };

    const appendMessage = (role, content, id = null, save = true) => {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${role}`;
        if (id) msgDiv.id = id;

        if (role === 'ai') {
            msgDiv.innerHTML = `
                <div class="ai-icon"><span class="material-icons-outlined" style="font-size: 18px;">auto_awesome</span></div>
                <div class="message-content">${content ? formatMessage(content) : '<div class="thinking-text"><span class="material-icons-outlined pulse">psychology</span>Thinking...</div>'}</div>
            `;
        } else {
            msgDiv.innerHTML = `<div class="message-content">${content}</div>`;
        }
        chatResults.appendChild(msgDiv);
        if (save) { 
            chatHistory.push({ role, content }); 
            saveChat(currentChatId); 
        }
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    };

    const saveChat = (id) => {
        const chat = allChats.find(c => c.id === id);
        if (chat) {
            chat.messages = chatHistory;
            chat.timestamp = Date.now();
            saveAllChats();
        }
    };

    const saveAllChats = () => localStorage.setItem('gemini_all_chats', JSON.stringify(allChats));

    window.copyToClipboard = (id) => {
        const text = document.getElementById(id).innerText;
        navigator.clipboard.writeText(text).then(() => {
            alert('Copied to clipboard!');
        });
    };

    function renderSources(messageId, sources) {
        const msgEl = document.getElementById(messageId);
        if (!msgEl || !sources.length) return;
        const html = `<div class="suggestion-label">Sources</div><div class="sources-container">${sources.map(s => `
            <a href="${s.url}" target="_blank" class="source-card" id="source-${s.id}">
                <div class="source-id">${s.id}</div><div class="source-title">${s.title}</div><div class="source-url">${new URL(s.url).hostname}</div>
            </a>`).join('')}</div>`;
        const div = document.createElement('div');
        div.innerHTML = html;
        msgEl.querySelector('.message-content').prepend(div);
    }

    function renderSuggestions(messageId, suggestions) {
        const msgEl = document.getElementById(messageId);
        if (!msgEl || !suggestions.length) return;
        const html = `<div class="suggestions-wrapper"><div class="suggestion-label">Related</div>${suggestions.map(s => `
            <div class="suggestion-chip" onclick="useSuggestion('${s.replace(/'/g, "\\'")}')">${s}</div>`).join('')}</div>`;
        const div = document.createElement('div');
        div.innerHTML = html;
        msgEl.querySelector('.message-content').appendChild(div);
    }

    window.useSuggestion = (text) => { promptInput.value = text; sendMessage(); };
    window.jumpToSource = (id) => {
        const el = document.getElementById(`source-${id}`);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.background = 'rgba(138, 180, 248, 0.2)'; setTimeout(() => el.style.background = '', 2000); }
    };

    if (newChatBtn) newChatBtn.addEventListener('click', createNewChat);
    promptInput.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    
    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => { sendMessage(chip.innerText.trim()); });
    });

    // Initial Load
    if (currentChatId) {
        loadChat(currentChatId);
    } else {
        renderHistory();
    }
    promptInput.focus();
});
