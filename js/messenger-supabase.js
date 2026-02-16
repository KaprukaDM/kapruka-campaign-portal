// Messenger Supabase API Handler
// Handles all API communication with the backend

const messengerSupabase = {
    // Base API URL - change this to your backend URL
    API_BASE_URL: 'https://chathubfactory.onrender.com',

    /**
     * Get all active conversations
     */
    async getConversations() {
        try {
            const response = await fetch(`${this.API_BASE_URL}/api/conversations`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            return {
                success: data.success || false,
                data: data.conversations || [],
                error: data.error || null
            };
        } catch (error) {
            console.error('Error fetching conversations:', error);
            return {
                success: false,
                data: [],
                error: error.message
            };
        }
    },

    /**
     * Get messages for a specific conversation
     */
    async getMessages(conversationId) {
        try {
            const response = await fetch(`${this.API_BASE_URL}/api/conversation/${conversationId}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            return {
                success: data.success || false,
                data: data.messages || [],
                error: data.error || null
            };
        } catch (error) {
            console.error('Error fetching messages:', error);
            return {
                success: false,
                data: [],
                error: error.message
            };
        }
    },

    /**
     * NEW: Get customer name from Facebook Graph API
     * This will be called by backend to fetch real customer names
     */
    async fetchCustomerName(conversationId, customerPsid) {
        try {
            const response = await fetch(`${this.API_BASE_URL}/api/customer-name/${customerPsid}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            return {
                success: data.success || false,
                name: data.name || null,
                error: data.error || null
            };
        } catch (error) {
            console.error('Error fetching customer name:', error);
            return {
                success: false,
                name: null,
                error: error.message
            };
        }
    },

    /**
     * NEW: Get unreplied message counts per page
     */
    async getUnrepliedCounts() {
        try {
            const response = await fetch(`${this.API_BASE_URL}/api/unreplied-counts`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            return {
                success: data.success || false,
                counts: data.counts || {},
                error: data.error || null
            };
        } catch (error) {
            console.error('Error fetching unreplied counts:', error);
            return {
                success: false,
                counts: {},
                error: error.message
            };
        }
    },

    /**
     * NEW: Check if conversation window is still open
     * Returns window status and time remaining
     */
    checkConversationWindow(lastMessageTime) {
        const now = new Date();
        const lastMessage = new Date(lastMessageTime);
        const hoursPassed = (now - lastMessage) / (1000 * 60 * 60);
        const daysPassed = hoursPassed / 24;

        if (hoursPassed <= 24) {
            return {
                status: 'open',
                color: 'green',
                canReply: true,
                message: 'You can reply freely',
                hoursRemaining: Math.floor(24 - hoursPassed),
                requiresTag: false
            };
        } else if (daysPassed <= 7) {
            return {
                status: 'extended',
                color: 'orange',
                canReply: true,
                message: 'Extended customer service window (requires HUMAN_AGENT tag)',
                daysRemaining: Math.floor(7 - daysPassed),
                requiresTag: true
            };
        } else {
            return {
                status: 'closed',
                color: 'red',
                canReply: false,
                message: 'Conversation window expired',
                daysExpired: Math.floor(daysPassed - 7),
                requiresTag: false
            };
        }
    }
};

/**
 * Render API Handler
 * Handles sending messages back to customers
 */
const renderAPI = {
    // Base API URL - change this to your backend URL
    API_BASE_URL: 'https://chathubfactory.onrender.com',

    /**
     * Send a text message to a customer
     */
    async sendMessage(pageId, recipientId, messageText, useHumanAgentTag = false) {
        try {
            const response = await fetch(`${this.API_BASE_URL}/api/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    page_id: pageId,
                    recipient_id: recipientId,
                    message_text: messageText,
                    use_human_agent_tag: useHumanAgentTag
                })
            });

            const data = await response.json();

            if (!response.ok) {
                return {
                    success: false,
                    error: data.error || `HTTP ${response.status}`,
                    data: null
                };
            }

            return {
                success: data.success || true,
                data: data.data || null,
                error: null
            };
        } catch (error) {
            console.error('Error sending message:', error);
            return {
                success: false,
                error: error.message,
                data: null
            };
        }
    },

    /**
     * NEW: Send an image message to a customer
     */
    async sendImageMessage(pageId, recipientId, imageFile, useHumanAgentTag = false) {
        try {
            // Create FormData for file upload
            const formData = new FormData();
            formData.append('page_id', pageId);
            formData.append('recipient_id', recipientId);
            formData.append('image', imageFile);
            formData.append('use_human_agent_tag', useHumanAgentTag);

            const response = await fetch(`${this.API_BASE_URL}/api/send-image`, {
                method: 'POST',
                body: formData
                // Note: Don't set Content-Type header, browser will set it automatically with boundary
            });

            const data = await response.json();

            if (!response.ok) {
                return {
                    success: false,
                    error: data.error || `HTTP ${response.status}`,
                    data: null
                };
            }

            return {
                success: data.success || true,
                data: data.data || null,
                error: null
            };
        } catch (error) {
            console.error('Error sending image:', error);
            return {
                success: false,
                error: error.message,
                data: null
            };
        }
    },

    /**
     * NEW: Upload image to get URL (if you want to upload first, then send URL)
     * Alternative approach to sendImageMessage
     */
    async uploadImage(imageFile) {
        try {
            const formData = new FormData();
            formData.append('image', imageFile);

            const response = await fetch(`${this.API_BASE_URL}/api/upload-image`, {
                method: 'POST',
                body: formData
            });

            const data = await response.json();

            if (!response.ok) {
                return {
                    success: false,
                    error: data.error || `HTTP ${response.status}`,
                    imageUrl: null
                };
            }

            return {
                success: data.success || true,
                imageUrl: data.image_url || data.url,
                error: null
            };
        } catch (error) {
            console.error('Error uploading image:', error);
            return {
                success: false,
                error: error.message,
                imageUrl: null
            };
        }
    }
};
