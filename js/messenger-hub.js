// Messenger Hub Main JavaScript

let conversations = [];
let currentConversation = null;
let currentMessages = [];
let currentFilter = 'all';
let autoRefreshInterval = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    loadConversations();
    setupEventListeners();
    startAutoRefresh();
});

// Setup event listeners
function setupEventListeners() {
    const replyInput = document.getElementById('replyInput');
    replyInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendReply();
        }
    });
}

// Load all conversations
async function loadConversations() {
    try {
        const result = await messengerSupabase.getConversations();

        if (result.error) {
            showToast('Error loading conversations: ' + result.error, 'error');
            return;
        }

        conversations = result.data || [];
        renderConversations();
    } catch (error) {
        showToast('Failed to load conversations', 'error');
        console.error(error);
    }
}

// Filter conversations
function filterConversations(filter) {
    currentFilter = filter;

    // Update active tab
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    event.target.classList.add('active');

    renderConversations();
}

// Render conversations in sidebar
function renderConversations() {
    const list = document.getElementById('conversationList');

    let filteredConversations = conversations;
    if (currentFilter !== 'all') {
        filteredConversations = conversations.filter(c => c.platform === currentFilter);
    }

    if (filteredConversations.length === 0) {
        list.innerHTML = `
            <li class="loading">
                <div class="empty-state">
                    <p>No conversations yet</p>
                </div>
            </li>
        `;
        return;
    }

    list.innerHTML = filteredConversations.map(conv => `
        <li class="conversation-item ${currentConversation && currentConversation.id === conv.conversation_id ? 'active' : ''}" 
            onclick="selectConversation('${conv.conversation_id}', '${conv.page_name || 'Facebook Page'}', '${conv.page_id}', '${conv.customer_psid}')">
            <div class="conversation-header">
                <div class="conversation-page">📘 ${conv.page_name || 'Facebook Page'}</div>
                <div class="conversation-time">${formatTime(conv.last_message_time)}</div>
            </div>
            <div class="conversation-id">Customer: ${conv.customer_psid.substring(0, 20)}...</div>
            <div class="conversation-preview">Click to view messages</div>
        </li>
    `).join('');
}

// Select and load a conversation
async function selectConversation(conversationId, pageName, pageId, customerPsid) {
    currentConversation = {
        id: conversationId,
        pageName: pageName,
        pageId: pageId,
        customerPsid: customerPsid
    };

    await loadMessages();
    enableReplyArea();
    updateChatHeader();

    // Update active state in sidebar
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.remove('active');
    });
    event.target.closest('.conversation-item').classList.add('active');
}

// Load messages for current conversation
async function loadMessages() {
    if (!currentConversation) return;

    try {
        const result = await messengerSupabase.getMessages(currentConversation.id);

        if (result.error) {
            showToast('Error loading messages: ' + result.error, 'error');
            return;
        }

        currentMessages = result.data || [];
        renderMessages();
    } catch (error) {
        showToast('Failed to load messages', 'error');
        console.error(error);
    }
}

// Render messages in chat area
function renderMessages() {
    const container = document.getElementById('messagesContainer');

    if (currentMessages.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <h3>No messages yet</h3>
                <p>Start the conversation by sending a message</p>
            </div>
        `;
        return;
    }

    let html = '';
    let lastDate = '';

    currentMessages.forEach(msg => {
        const msgDate = new Date(msg.created_at).toLocaleDateString();

        // Add date divider if date changed
        if (msgDate !== lastDate) {
            html += `<div class="message-date-divider">${formatDate(msg.created_at)}</div>`;
            lastDate = msgDate;
        }

        html += `
            <div class="message ${msg.sender_type}">
                <div class="message-bubble">${escapeHtml(msg.message_text)}</div>
                <div class="message-time">${formatMessageTime(msg.created_at)}</div>
            </div>
        `;
    });

    container.innerHTML = html;

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

// Update chat header
function updateChatHeader() {
    const header = document.getElementById('chatHeader');
    const title = document.getElementById('chatTitle');
    const subtitle = document.getElementById('chatSubtitle');

    if (currentConversation) {
        header.style.display = 'flex';
        title.innerHTML = `<span class="status-indicator"></span>${currentConversation.pageName}`;
        subtitle.textContent = `Customer ID: ${currentConversation.customerPsid}`;
    }
}

// Send reply
async function sendReply() {
    const input = document.getElementById('replyInput');
    const messageText = input.value.trim();

    if (!messageText || !currentConversation) return;

    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';

    try {
        const result = await renderAPI.sendMessage(
            currentConversation.pageId,
            currentConversation.customerPsid,
            messageText
        );

        if (result.success) {
            input.value = '';
            showToast('Message sent successfully', 'success');

            // Reload messages after short delay
            setTimeout(() => loadMessages(), 500);
        } else {
            showToast('Failed to send message: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showToast('Error sending message', 'error');
        console.error(error);
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
    }
}

// Refresh current chat
async function refreshCurrentChat() {
    if (currentConversation) {
        await loadMessages();
        showToast('Messages refreshed', 'success');
    }
}

// Enable reply area
function enableReplyArea() {
    document.getElementById('replyInput').disabled = false;
    document.getElementById('sendBtn').disabled = false;
}

// Auto-refresh every 30 seconds
function startAutoRefresh() {
    autoRefreshInterval = setInterval(() => {
        loadConversations();
        if (currentConversation) {
            loadMessages();
        }
    }, 30000);
}

// Format time (relative)
function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

    return date.toLocaleDateString();
}

// Format message time
function formatMessageTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// Format date for divider
function formatDate(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Show toast notification
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3000);
}
