/* ═══════════════════════════════════════════════════════════════
   KAPRUKA CAMPAIGN PORTAL - API CONNECTION
   Connects GitHub Pages frontend to Google Apps Script backend
   ═══════════════════════════════════════════════════════════════ */

// YOUR GOOGLE APPS SCRIPT WEB APP URL
// TODO: Replace this after deploying your Apps Script
const API_URL = 'https://script.google.com/macros/s/AKfycbx8-GghAdLB24QTuT-tzF_Y3lzkonbJJTSXYhqStEgl1yVkHsss8YHrjiw07X1AuR9xAg/exec';

// Admin password (stored here for demo - in production use secure auth)
const ADMIN_PASSWORD = 'Kapruka2026!Admin';

/* ═══════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
   ═══════════════════════════════════════════════════════════════ */

function showLoading() {
  const loader = document.getElementById('loading');
  if (loader) loader.classList.add('show');
}

function hideLoading() {
  const loader = document.getElementById('loading');
  if (loader) loader.classList.remove('show');
}

function showModal(title, message, isSuccess = true) {
  const modal = document.getElementById('modal');
  const content = document.getElementById('modalContent');
  
  if (!modal || !content) return;
  
  const iconColor = isSuccess ? '#4CAF50' : '#d32f2f';
  const icon = isSuccess ? '✓' : '✕';
  
  content.innerHTML = `
    <div class="modal-icon" style="background: ${iconColor};">${icon}</div>
    <h2>${title}</h2>
    <p>${message}</p>
    <button class="modal-btn" onclick="closeModal()">Close</button>
  `;
  
  modal.classList.add('show');
}

function closeModal() {
  const modal = document.getElementById('modal');
  if (modal) modal.classList.remove('show');
}

/* ═══════════════════════════════════════════════════════════════
   API CALL FUNCTIONS
   ═══════════════════════════════════════════════════════════════ */

// Generic GET request
async function apiGet(action, params = {}) {
  try {
    const url = new URL(API_URL);
    url.searchParams.append('action', action);
    
    Object.keys(params).forEach(key => {
      url.searchParams.append(key, params[key]);
    });
    
    const response = await fetch(url.toString());
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
    
  } catch (error) {
    console.error('API GET Error:', error);
    throw error;
  }
}

// Generic POST request
async function apiPost(action, data = {}) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: action,
        ...data
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const result = await response.json();
    return result;
    
  } catch (error) {
    console.error('API POST Error:', error);
    throw error;
  }
}

/* ═══════════════════════════════════════════════════════════════
   CAMPAIGN BOOKING API CALLS
   ═══════════════════════════════════════════════════════════════ */

async function getInitialData() {
  return await apiGet('getInitialData');
}

async function getSlotsForMonth(month) {
  return await apiGet('getSlotsForMonth', { month });
}

async function submitCampaignRequest(formData) {
  return await apiPost('submitCampaignRequest', formData);
}

/* ═══════════════════════════════════════════════════════════════
   PRODUCT SUGGESTION API CALLS
   ═══════════════════════════════════════════════════════════════ */

async function getProductDashboard() {
  return await apiGet('getProductDashboard');
}

async function searchProducts(query) {
  return await apiGet('searchProducts', { query });
}

async function submitProductSuggestion(formData) {
  return await apiPost('submitProductSuggestion', formData);
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN API CALLS
   ═══════════════════════════════════════════════════════════════ */

async function verifyAdminPassword(password) {
  return await apiPost('verifyAdminPassword', { password });
}

async function getAllDepartments() {
  return await apiGet('getAllDepartments');
}

async function addDepartment(config) {
  return await apiPost('addDepartment', config);
}

async function deleteDepartment(row) {
  return await apiPost('deleteDepartment', { row });
}

async function getAllRequests() {
  return await apiGet('getAllRequests');
}

async function updateRequestStatus(row, status, reviewer, comments) {
  return await apiPost('updateRequestStatus', { row, status, reviewer, comments });
}

async function getAllProducts() {
  return await apiGet('getAllProducts');
}

async function updateProductReview(row, reviewData) {
  return await apiPost('updateProductReview', { row, reviewData });
}

async function getAvailableMonths() {
  return await apiGet('getAvailableMonths');
}

async function getStatusOptions() {
  return await apiGet('getStatusOptions');
}

/* ═══════════════════════════════════════════════════════════════
   NAVIGATION HELPERS
   ═══════════════════════════════════════════════════════════════ */

function goBack() {
  window.location.href = 'index.html';
}

function goToAdmin() {
  window.location.href = 'admin.html';
}

function goToCampaigns() {
  window.location.href = 'campaign-booking.html';
}

function goToProducts() {
  window.location.href = 'product-suggestion.html';
}

/* ═══════════════════════════════════════════════════════════════
   ERROR HANDLER
   ═══════════════════════════════════════════════════════════════ */

window.addEventListener('error', function(e) {
  console.error('Global error:', e.error);
  hideLoading();
});

window.addEventListener('unhandledrejection', function(e) {
  console.error('Unhandled promise rejection:', e.reason);
  hideLoading();
});

console.log('✅ API.js loaded successfully');
console.log('📡 API URL:', API_URL);
