// ═══════════════════════════════════════════════════════════════
// SUPABASE API CLIENT - KAPRUKA CAMPAIGN PORTAL
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';
const ADMIN_PASSWORD = 'Kapruka2026!Admin';

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function supabaseQuery(endpoint, method = 'GET', body = null) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, options);
  
  if (!response.ok) {
    throw new Error(`API Error: ${response.statusText}`);
  }

  return response.json();
}

function getCurrentMonth() {
  const now = new Date();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}

function generateId(prefix) {
  return `${prefix}-${Date.now()}`;
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN BOOKING API
// ═══════════════════════════════════════════════════════════════

async function getInitialData() {
  const configs = await supabaseQuery('department_config?active=eq.Yes&select=month');
  const months = [...new Set(configs.map(c => c.month))];
  const currentMonth = getCurrentMonth();
  
  return {
    months: months.length > 0 ? months : [currentMonth],
    currentMonth: months.includes(currentMonth) ? currentMonth : (months[0] || currentMonth)
  };
}

async function getSlotsForMonth(month) {
  // Get department configs for this month
  const configs = await supabaseQuery(`department_config?month=eq.${encodeURIComponent(month)}&active=eq.Yes`);
  
  if (configs.length === 0) return [];

  // Get all requests for this month
  const requests = await supabaseQuery(`request_log?month=eq.${encodeURIComponent(month)}`);

  return configs.map(dept => {
    const slots = [];
    const bookedSlots = {};

    // Find booked slots for this department
    requests.forEach(req => {
      if (req.department === dept.department && 
          req.status && 
          !req.status.includes('Rejected') && 
          !req.status.includes('Cancelled')) {
        bookedSlots[req.slot] = {
          requestId: req.request_id,
          campaign: req.campaign || 'N/A',
          status: req.status,
          requestor: req.name,
          startDate: req.start_date || 'N/A',
          endDate: req.end_date || 'N/A'
        };
      }
    });

    // Create slot array
    for (let i = 1; i <= dept.slots; i++) {
      const slotName = `Slot ${i}`;
      slots.push({
        number: i,
        name: slotName,
        available: !bookedSlots[slotName],
        details: bookedSlots[slotName] || null
      });
    }

    return {
      department: dept.department,
      budget: dept.budget,
      totalSlots: dept.slots,
      color: dept.color,
      slots: slots
    };
  });
}

async function submitCampaignRequest(formData) {
  // Check if slot is already booked
  const existing = await supabaseQuery(
    `request_log?department=eq.${encodeURIComponent(formData.department)}&month=eq.${encodeURIComponent(formData.month)}&slot=eq.${encodeURIComponent(formData.slot)}`
  );

  const alreadyBooked = existing.some(req => 
    req.status && !req.status.includes('Rejected') && !req.status.includes('Cancelled')
  );

  if (alreadyBooked) {
    throw new Error('This slot is already booked');
  }

  const requestData = {
    request_id: generateId('REQ'),
    email: 'user@kapruka.lk',
    name: formData.name || 'User',
    department: formData.department,
    month: formData.month,
    slot: formData.slot,
    campaign: formData.campaign,
    duration: formData.duration,
    start_date: formData.startDate,
    end_date: formData.endDate,
    status: 'Requested'
  };

  const result = await supabaseQuery('request_log', 'POST', requestData);
  return { success: true, requestId: result[0].request_id };
}

// ═══════════════════════════════════════════════════════════════
// PRODUCT SUGGESTION API
// ═══════════════════════════════════════════════════════════════

async function getProductDashboard() {
  const windows = await supabaseQuery('submission_windows?status=eq.Active&order=created_at.desc&limit=1');
  
  if (windows.length === 0) {
    return { window: null, target: 30, actual: 0, picked: 0, categories: [], rejections: [] };
  }

  const window = windows[0];
  const products = await supabaseQuery(
    `product_suggestions?timestamp=gte.${window.start_date}&timestamp=lte.${window.end_date}`
  );

  const categoryCount = {};
  const rejections = [];
  let picked = 0;

  products.forEach(p => {
    categoryCount[p.category] = (categoryCount[p.category] || 0) + 1;
    if (p.status === 'Approved') picked++;
    if (p.status === 'Rejected') {
      rejections.push({
        productName: p.product_link.split('/').pop().replace(/-/g, ' ').substring(0, 40),
        reason: p.rejection_reason || 'Not specified'
      });
    }
  });

  const categories = Object.keys(categoryCount).map(cat => ({
    category: cat,
    count: categoryCount[cat]
  })).sort((a, b) => b.count - a.count);

  return {
    window: window,
    target: window.target_suggestions,
    actual: products.length,
    picked: picked,
    categories: categories,
    rejections: rejections.slice(0, 5)
  };
}

async function submitProductSuggestion(formData) {
  const windows = await supabaseQuery('submission_windows?status=eq.Active&limit=1');
  
  if (windows.length === 0) {
    throw new Error('No active submission window');
  }

  const submissionData = {
    submission_id: generateId('SUB'),
    email: 'user@kapruka.lk',
    name: formData.name || 'User',
    product_link: formData.productLink,
    product_type: formData.productType || '',
    category: formData.category,
    margin: parseFloat(formData.margin),
    promotion_idea: formData.promotionIdea || '',
    available_qty: parseInt(formData.availableQty),
    status: 'Pending'
  };

  const result = await supabaseQuery('product_suggestions', 'POST', submissionData);
  return { success: true, submissionId: result[0].submission_id };
}

// ═══════════════════════════════════════════════════════════════
// ADMIN DASHBOARD API
// ═══════════════════════════════════════════════════════════════

function verifyAdminPassword(password) {
  return password === ADMIN_PASSWORD;
}

async function getAllRequests() {
  const requests = await supabaseQuery('request_log?order=timestamp.desc');
  return requests.map(r => ({
    row: r.id,
    requestId: r.request_id,
    timestamp: r.timestamp,
    email: r.email,
    name: r.name,
    department: r.department,
    month: r.month,
    slot: r.slot,
    campaign: r.campaign,
    duration: r.duration,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
    reviewer: r.reviewer || '',
    updated: r.updated_at,
    comments: r.comments || ''
  }));
}

async function updateRequestStatus(row, status, reviewer, comments) {
  await supabaseQuery(
    `request_log?id=eq.${row}`,
    'PATCH',
    { status, reviewer, updated_at: new Date().toISOString(), comments }
  );
  return { success: true };
}

async function getAllProductSuggestions() {
  const products = await supabaseQuery('product_suggestions?order=timestamp.desc');
  return products.map(p => ({
    row: p.id,
    submissionId: p.submission_id,
    timestamp: p.timestamp,
    email: p.email,
    name: p.name,
    productLink: p.product_link,
    productType: p.product_type,
    category: p.category,
    margin: p.margin,
    promotionIdea: p.promotion_idea,
    availableQty: p.available_qty,
    status: p.status,
    assignedPage: p.assigned_page || '',
    goLiveDate: p.go_live_date || '',
    reviewerName: p.reviewer_name || '',
    rejectionReason: p.rejection_reason || ''
  }));
}

async function updateProductReview(row, reviewData) {
  const updateData = {
    status: reviewData.status,
    reviewer_name: reviewData.reviewerName
  };

  if (reviewData.status === 'Approved') {
    updateData.assigned_page = reviewData.assignedPage || '';
    updateData.go_live_date = reviewData.goLiveDate || null;
    updateData.rejection_reason = '';
  } else {
    updateData.assigned_page = '';
    updateData.go_live_date = null;
    updateData.rejection_reason = reviewData.rejectionReason || '';
  }

  await supabaseQuery(`product_suggestions?id=eq.${row}`, 'PATCH', updateData);
  return { success: true };
}

async function getAllDepartments() {
  const configs = await supabaseQuery('department_config?order=id.asc');
  return configs.map(c => ({
    row: c.id,
    month: c.month,
    department: c.department,
    budget: c.budget,
    slots: c.slots,
    color: c.color,
    active: c.active
  }));
}

async function addDepartment(config) {
  await supabaseQuery('department_config', 'POST', {
    month: config.month,
    department: config.department,
    budget: parseFloat(config.budget),
    slots: parseInt(config.slots),
    color: config.color || '#E8F5E9',
    active: config.active || 'Yes'
  });
  return { success: true };
}

async function deleteDepartment(row) {
  await supabaseQuery(`department_config?id=eq.${row}`, 'DELETE');
  return { success: true };
}
