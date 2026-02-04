// Messenger Hub Supabase Configuration
// Separate from main portal Supabase API

const MESSENGER_CONFIG = {
    supabaseUrl: 'https://txtarwndhuccthrhodlo.supabase.co',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4dGFyd25kaHVjY3RocmhvZGxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxNjczNTksImV4cCI6MjA4NTc0MzM1OX0.Fi-ygjyoSw5dVSy3q70ZbrtKBm3sj5KJ_x2fKrd11H4',
    renderApiUrl: 'https://chathubfactory.onrender.com'
};

// Supabase Client (using REST API - no library needed)
class MessengerSupabaseClient {
    constructor(url, key) {
        this.url = url;
        this.key = key;
        this.headers = {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
        };
    }

    async query(table, method = 'GET', filters = {}, body = null) {
        let url = `${this.url}/rest/v1/${table}`;

        // Add filters to URL
        const params = new URLSearchParams();
        if (filters.select) params.append('select', filters.select);
        if (filters.eq) {
            Object.keys(filters.eq).forEach(key => {
                params.append(key, `eq.${filters.eq[key]}`);
            });
        }
        if (filters.order) params.append('order', filters.order);
        if (filters.limit) params.append('limit', filters.limit);

        if (params.toString()) url += '?' + params.toString();

        const options = {
            method,
            headers: this.headers
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(url, options);
            const data = await response.json();
            return { data, error: !response.ok ? data : null };
        } catch (error) {
            return { data: null, error: error.message };
        }
    }

    // Get all conversations
    async getConversations() {
        return this.query('conversations', 'GET', {
            select: '*',
            eq: { status: 'active' },
            order: 'last_message_time.desc'
        });
    }

    // Get messages for a conversation
    async getMessages(conversationId) {
        return this.query('messages', 'GET', {
            select: '*',
            eq: { conversation_id: conversationId },
            order: 'created_at.asc'
        });
    }

    // Insert a new message (for display purposes)
    async insertMessage(messageData) {
        return this.query('messages', 'POST', {}, messageData);
    }
}

// Initialize Supabase Client
const messengerSupabase = new MessengerSupabaseClient(
    MESSENGER_CONFIG.supabaseUrl,
    MESSENGER_CONFIG.supabaseKey
);

// Render API Client
class RenderAPIClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }

    async sendMessage(pageId, recipientId, messageText) {
        try {
            const response = await fetch(`${this.baseUrl}/api/send`, {
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

            return await response.json();
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async getConversations() {
        try {
            const response = await fetch(`${this.baseUrl}/api/conversations`);
            return await response.json();
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async getConversation(conversationId) {
        try {
            const response = await fetch(`${this.baseUrl}/api/conversation/${conversationId}`);
            return await response.json();
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

// Initialize Render API Client
const renderAPI = new RenderAPIClient(MESSENGER_CONFIG.renderApiUrl);
