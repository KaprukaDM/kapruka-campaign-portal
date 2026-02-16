// Messenger Hub - Password Protected with Page Filtering

// Password Configuration
const MESSENGER_PASSWORD = 'kapruka2026'; // Change this to your desired password

let conversations = [];
let currentConversation = null;
let currentMessages = [];
let currentPageFilter = 'all';
let currentPlatformFilter = 'all';
let autoRefreshInterval = null;
let pageStats = {};
let platformStats = {};
let unrepliedCounts = {};
let selectedImageFile = null;

// Check password on page load
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
});

function checkAuth() {
    const isAuthenticated = sessionStorage.getItem('messengerAuth');
    if (isAuthenticated === 'true') {
        showMainApp();
    }
}

function checkPassword() {
    const input = document.getElementById('passwordInput');
    const password = input.value;

    if (password === MESSENGER_PASSWORD) {
        sessionStorage.setItem('messengerAuth', 'true');
        showMainApp();
    } else {
        document.getElementById('passwordError').classList.add('show');
        input.value = '';
        input.focus();
        setTimeout(() => {
            document.getElementById('passwordError').classList.remove('show');
        }, 3000);
    }
}

function logout() {
    sessionStorage.removeItem('messengerAuth');
    location.reload();
}

function showMainApp() {
    document.getElementById('passwordScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.add('visible');

    // Initialize app
    loadConversations();
    setupEventListeners();
    startAutoRefresh();
}

// Setup event listeners
function setupEventListeners() {
    const replyInput = document.getElementById('replyInput');
    replyInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendReply();
        }
    });

    // Image upload listener
    const imageInput = document.getElementById('imageInput');
    if (imageInput) {
        imageInput.addEventListener('change', handleImageSelect);
    }
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
        
        // Fetch unreplied counts
        await loadUnrepliedCounts();
        
        calculatePageStats();
        calculatePlatformStats();
        renderPlatformFilters();
        renderPageFilters();
        renderConversations();
    } catch (error) {
        showToast('Failed to load conversations', 'error');
        console.error(error);
    }
}

// NEW: Load unreplied message counts
async function loadUnrepliedCounts() {
    try {
        const result = await messengerSupabase.getUnrepliedCounts();
        if (result.success) {
            unrepliedCounts = result.counts || {};
        }
    } catch (error) {
        console.error('Error loading unreplied counts:', error);
    }
}

// Calculate statistics by page
function calculatePageStats() {
    pageStats = {};
    conversations.forEach(conv => {
        const pageKey = conv.page_id || 'unknown';
        if (!pageStats[pageKey]) {
            pageStats[pageKey] = {
                name: conv.page_name || 'Unknown Page',
                count: 0,
                unreplied: 0
            };
        }
        pageStats[pageKey].count++;
        
        // Count unreplied for this page
        const unrepliedKey = `${conv.page_id}_${conv.customer_psid}`;
        if (unrepliedCounts[unrepliedKey]) {
            pageStats[pageKey].unreplied += unrepliedCounts[unrepliedKey];
        }
    });
}

// NEW: Calculate statistics by platform
function calculatePlatformStats() {
    platformStats = {};
    conversations.forEach(conv => {
        const platform = conv.platform || 'facebook';
        if (!platformStats[platform]) {
            platformStats[platform] = {
                name: getPlatformName(platform),
                icon: getPlatformIcon(platform),
                count: 0,
                unreplied: 0
            };
        }
        platformStats[platform].count++;
        
        // Count unreplied for this platform
        const unrepliedKey = `${conv.page_id}_${conv.customer_psid}`;
        if (unrepliedCounts[unrepliedKey]) {
            platformStats[platform].unreplied += unrepliedCounts[unrepliedKey];
        }
    });
}

// NEW: Get platform display name
function getPlatformName(platform) {
    const names = {
        'facebook': 'Facebook',
        'instagram': 'Instagram',
        'whatsapp': 'WhatsApp',
        'messenger': 'Messenger'
    };
    return names[platform] || platform.charAt(0).toUpperCase() + platform.slice(1);
}

// NEW: Get platform icon
function getPlatformIcon(platform) {
    const icons = {
        'facebook': '📘',
        'instagram': '📷',
        'whatsapp': '💬',
        'messenger': '💬'
    };
    return icons[platform] || '💬';
}

// NEW: Render platform filter buttons
function renderPlatformFilters() {
    const container = document.getElementById('platformFilters');
    if (!container) return;

    const totalCount = conversations.length;
    let totalUnreplied = Object.values(unrepliedCounts).reduce((sum, count) => sum + count, 0);

    let html = `
        <div class="platform-filter ${currentPlatformFilter === 'all' ? 'active' : ''}" onclick="filterByPlatform('all')">
            🌐 All Platforms
            <span class="count">${totalCount}</span>
            ${totalUnreplied > 0 ? `<span class="unreplied-badge">${totalUnreplied}</span>` : ''}
        </div>
    `;

    Object.keys(platformStats).forEach(platform => {
        const stat = platformStats[platform];
        html += `
            <div class="platform-filter ${currentPlatformFilter === platform ? 'active' : ''}" 
                 onclick="filterByPlatform('${platform}')">
                ${stat.icon} ${stat.name}
                <span class="count">${stat.count}</span>
                ${stat.unreplied > 0 ? `<span class="unreplied-badge">${stat.unreplied}</span>` : ''}
            </div>
        `;
    });

    container.innerHTML = html;
}

// NEW: Filter by platform
function filterByPlatform(platform) {
    currentPlatformFilter = platform;
    currentPageFilter = 'all'; // Reset page filter when changing platform
    renderPlatformFilters();
    renderPageFilters();
    renderConversations();
}

// Render page filter buttons
function renderPageFilters() {
    const container = document.getElementById('pageFilters');
    
    // Filter conversations by current platform first
    let platformFilteredConvs = conversations;
    if (currentPlatformFilter !== 'all') {
        platformFilteredConvs = conversations.filter(c => 
            (c.platform || 'facebook') === currentPlatformFilter
        );
    }
    
    const totalCount = platformFilteredConvs.length;
    
    // Recalculate page stats for current platform
    let filteredPageStats = {};
    platformFilteredConvs.forEach(conv => {
        const pageKey = conv.page_id || 'unknown';
        if (!filteredPageStats[pageKey]) {
            filteredPageStats[pageKey] = {
                name: conv.page_name || 'Unknown Page',
                count: 0,
                unreplied: 0
            };
        }
        filteredPageStats[pageKey].count++;
        
        const unrepliedKey = `${conv.page_id}_${conv.customer_psid}`;
        if (unrepliedCounts[unrepliedKey]) {
            filteredPageStats[pageKey].unreplied += unrepliedCounts[unrepliedKey];
        }
    });

    let html = `
        <div class="page-filter ${currentPageFilter === 'all' ? 'active' : ''}" onclick="filterByPage('all')">
            📘 All Pages
            <span class="count">${totalCount}</span>
        </div>
    `;

    Object.keys(filteredPageStats).forEach(pageId => {
        const page = filteredPageStats[pageId];
        html += `
            <div class="page-filter ${currentPageFilter === pageId ? 'active' : ''}" 
                 onclick="filterByPage('${pageId}')">
                📄 ${page.name}
                <span class="count">${page.count}</span>
                ${page.unreplied > 0 ? `<span class="unreplied-badge">${page.unreplied}</span>` : ''}
            </div>
        `;
    });

    container.innerHTML = html;
}

// Filter conversations by page
function filterByPage(pageId) {
    currentPageFilter = pageId;
    renderPageFilters();
    renderConversations();
}

// Render conversations in sidebar
function renderConversations() {
    const list = document.getElementById('conversationList');

    // Apply filters
    let filteredConversations = conversations;
    
    // Filter by platform
    if (currentPlatformFilter !== 'all') {
        filteredConversations = filteredConversations.filter(c => 
            (c.platform || 'facebook') === currentPlatformFilter
        );
    }
    
    // Filter by page
    if (currentPageFilter !== 'all') {
        filteredConversations = filteredConversations.filter(c => c.page_id === currentPageFilter);
    }

    if (filteredConversations.length === 0) {
        list.innerHTML = `
            <li class="loading">
                <div class="empty-state">
                    <p>No conversations for this filter</p>
                </div>
            </li>
        `;
        return;
    }

    list.innerHTML = filteredConversations.map(conv => {
        const windowStatus = messengerSupabase.checkConversationWindow(conv.last_message_time);
        const unrepliedKey = `${conv.page_id}_${conv.customer_psid}`;
        const unrepliedCount = unrepliedCounts[unrepliedKey] || 0;
        const platform = conv.platform || 'facebook';
        const platformIcon = getPlatformIcon(platform);
        
        // Use customer_name if available, otherwise show a better fallback
        const customerName = conv.customer_name || `User #${conv.customer_psid.substring(0, 8)}`;
        
        return `
            <li class="conversation-item ${currentConversation && currentConversation.id === conv.conversation_id ? 'active' : ''}" 
                data-conversation-id="${conv.conversation_id}"
                data-page-name="${escapeQuotes(conv.page_name || 'Facebook Page')}"
                data-page-id="${conv.page_id}"
                data-customer-psid="${conv.customer_psid}"
                data-customer-name="${escapeQuotes(customerName)}"
                data-platform="${platform}"
                data-last-message-time="${conv.last_message_time}">
                <div class="conversation-header">
                    <div class="conversation-page">
                        ${platformIcon} ${conv.page_name || 'Facebook Page'}
                    </div>
                    <div class="conversation-time">${formatTime(conv.last_message_time)}</div>
                </div>
                <div class="conversation-name-row">
                    <div class="conversation-name">${customerName}</div>
                    ${unrepliedCount > 0 ? `<span class="unreplied-badge-small">${unrepliedCount}</span>` : ''}
                </div>
                <div class="conversation-id">ID: ${conv.customer_psid.substring(0, 20)}...</div>
                <div class="conversation-footer">
                    <span class="window-status window-${windowStatus.color}">
                        ${windowStatus.status === 'open' ? '🟢' : windowStatus.status === 'extended' ? '🟠' : '🔴'}
                        ${windowStatus.message.split('(')[0].trim()}
                    </span>
                </div>
            </li>
        `;
    }).join('');

    // Attach event listeners to conversation items
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('click', function() {
            const conversationId = this.getAttribute('data-conversation-id');
            const pageName = this.getAttribute('data-page-name');
            const pageId = this.getAttribute('data-page-id');
            const customerPsid = this.getAttribute('data-customer-psid');
            const customerName = this.getAttribute('data-customer-name');
            const platform = this.getAttribute('data-platform');
            const lastMessageTime = this.getAttribute('data-last-message-time');
            
            selectConversation(conversationId, pageName, pageId, customerPsid, customerName, platform, lastMessageTime);
        });
    });
}

// Select and load a conversation
async function selectConversation(conversationId, pageName, pageId, customerPsid, customerName, platform, lastMessageTime) {
    currentConversation = {
        id: conversationId,
        pageName: pageName,
        pageId: pageId,
        customerPsid: customerPsid,
        customerName: customerName,
        platform: platform || 'facebook',
        lastMessageTime: lastMessageTime
    };

    // Fetch real customer name if showing fallback
    if (customerName.startsWith('User #')) {
        fetchAndUpdateCustomerName(customerPsid);
    }

    await loadMessages();
    updateChatHeader();
    updateReplyAreaBasedOnWindow();

    // Update active state in sidebar
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.remove('active');
    });
    const selectedItem = document.querySelector(`[data-conversation-id="${conversationId}"]`);
    if (selectedItem) {
        selectedItem.classList.add('active');
    }
}

// NEW: Fetch and update customer name
async function fetchAndUpdateCustomerName(customerPsid) {
    try {
        const result = await messengerSupabase.fetchCustomerName(null, customerPsid);
        if (result.success && result.name) {
            // Update current conversation
            if (currentConversation && currentConversation.customerPsid === customerPsid) {
                currentConversation.customerName = result.name;
                updateChatHeader();
            }
            
            // Update in conversations list
            const conv = conversations.find(c => c.customer_psid === customerPsid);
            if (conv) {
                conv.customer_name = result.name;
                renderConversations();
            }
        }
    } catch (error) {
        console.error('Error fetching customer name:', error);
    }
}

// NEW: Update reply area based on conversation window
function updateReplyAreaBasedOnWindow() {
    if (!currentConversation) return;

    const windowStatus = messengerSupabase.checkConversationWindow(currentConversation.lastMessageTime);
    const replyInput = document.getElementById('replyInput');
    const sendBtn = document.getElementById('sendBtn');
    const imageBtn = document.getElementById('imageUploadBtn');
    const windowWarning = document.getElementById('windowWarning');

    if (windowStatus.canReply) {
        // Enable reply area
        replyInput.disabled = false;
        sendBtn.disabled = false;
        if (imageBtn) imageBtn.disabled = false;

        // Show warning for extended window
        if (windowStatus.status === 'extended' && windowWarning) {
            windowWarning.style.display = 'flex';
            windowWarning.innerHTML = `
                <span class="warning-icon">⚠️</span>
                <span>${windowStatus.message}</span>
            `;
        } else if (windowWarning) {
            windowWarning.style.display = 'none';
        }
    } else {
        // Disable reply area
        replyInput.disabled = true;
        sendBtn.disabled = true;
        if (imageBtn) imageBtn.disabled = true;
        replyInput.placeholder = 'Conversation window expired...';

        // Show expired message
        if (windowWarning) {
            windowWarning.style.display = 'flex';
            windowWarning.innerHTML = `
                <span class="warning-icon">🔴</span>
                <span>This conversation expired ${windowStatus.daysExpired} days ago. You cannot send messages.</span>
            `;
        }
    }
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

        // Check if message is image
        const messageType = msg.message_type || 'text';
        const isImage = messageType === 'image' || msg.image_url;

        html += `
            <div class="message ${msg.sender_type}">
                <div class="message-bubble">
                    ${isImage ? 
                        `<img src="${msg.image_url}" alt="Sent image" class="message-image" onclick="openImageModal('${msg.image_url}')">` :
                        escapeHtml(msg.message_text)
                    }
                </div>
                <div class="message-time">${formatMessageTime(msg.created_at)}</div>
            </div>
        `;
    });

    container.innerHTML = html;

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

// NEW: Open image in modal
function openImageModal(imageUrl) {
    const modal = document.getElementById('imageModal');
    const modalImg = document.getElementById('modalImage');
    if (modal && modalImg) {
        modal.style.display = 'flex';
        modalImg.src = imageUrl;
    }
}

// NEW: Close image modal
function closeImageModal() {
    const modal = document.getElementById('imageModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Update chat header
function updateChatHeader() {
    const header = document.getElementById('chatHeader');
    const title = document.getElementById('chatTitle');
    const subtitle = document.getElementById('chatSubtitle');
    const badge = document.getElementById('pageBadge');

    if (currentConversation) {
        header.style.display = 'flex';
        
        const windowStatus = messengerSupabase.checkConversationWindow(currentConversation.lastMessageTime);
        const statusIcon = windowStatus.status === 'open' ? '🟢' : windowStatus.status === 'extended' ? '🟠' : '🔴';
        
        title.innerHTML = `${statusIcon} ${currentConversation.customerName}`;
        subtitle.textContent = `Customer ID: ${currentConversation.customerPsid}`;
        badge.textContent = `${getPlatformIcon(currentConversation.platform)} ${currentConversation.pageName}`;
    }
}

// NEW: Handle image selection
function handleImageSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
        showToast('Please select an image file', 'error');
        return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
        showToast('Image size must be less than 5MB', 'error');
        return;
    }

    selectedImageFile = file;

    // Show preview
    const reader = new FileReader();
    reader.onload = function(e) {
        showImagePreview(e.target.result);
    };
    reader.readAsDataURL(file);
}

// NEW: Show image preview
function showImagePreview(imageSrc) {
    const preview = document.getElementById('imagePreview');
    const previewImg = document.getElementById('previewImage');
    
    if (preview && previewImg) {
        previewImg.src = imageSrc;
        preview.style.display = 'flex';
    }
}

// NEW: Cancel image upload
function cancelImageUpload() {
    selectedImageFile = null;
    const preview = document.getElementById('imagePreview');
    const imageInput = document.getElementById('imageInput');
    
    if (preview) preview.style.display = 'none';
    if (imageInput) imageInput.value = '';
}

// NEW: Trigger image upload
function triggerImageUpload() {
    const imageInput = document.getElementById('imageInput');
    if (imageInput) {
        imageInput.click();
    }
}

// Send reply (text or image)
async function sendReply() {
    const input = document.getElementById('replyInput');
    const messageText = input.value.trim();

    // Check if we have either text or image
    if (!messageText && !selectedImageFile) return;
    if (!currentConversation) return;

    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';

    try {
        const windowStatus = messengerSupabase.checkConversationWindow(currentConversation.lastMessageTime);
        const useHumanAgentTag = windowStatus.requiresTag;

        let result;

        // Send image if selected
        if (selectedImageFile) {
            result = await renderAPI.sendImageMessage(
                currentConversation.pageId,
                currentConversation.customerPsid,
                selectedImageFile,
                useHumanAgentTag
            );
            
            if (result.success) {
                cancelImageUpload();
            }
        }
        
        // Send text if provided
        if (messageText && (!selectedImageFile || result.success)) {
            result = await renderAPI.sendMessage(
                currentConversation.pageId,
                currentConversation.customerPsid,
                messageText,
                useHumanAgentTag
            );
            
            if (result.success) {
                input.value = '';
            }
        }

        if (result.success) {
            showToast('Message sent successfully', 'success');
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

// Escape quotes for onclick attributes
function escapeQuotes(text) {
    return text.replace(/'/g, "\\\\'").replace(/"/g, '&quot;');
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
