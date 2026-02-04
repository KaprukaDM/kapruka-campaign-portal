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
     * Send a message to a customer
     */
    async sendMessage(pageId, recipientId, messageText) {
        try {
            const response = await fetch(`${this.API_BASE_URL}/api/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    page_id: pageId,
                    recipient_id: recipientId,
                    message_text: messageText
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
    }
};
