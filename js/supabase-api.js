// ═══════════════════════════════════════════════════════════════
// SUPABASE API CLIENT - KAPRUKA CAMPAIGN PORTAL
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';
const ADMIN_PASSWORD = 'Kapruka2026!Admin';

// Valid status options (only 3 now)
const VALID_STATUSES = ['Working', 'Live', 'Rejected'];

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
  const configs = await supabaseQuery(`department_config?month=eq.${encodeURIComponent(month)}&active=eq.Yes`);
  
  if (configs.length === 0) return [];

  const requests = await supabaseQuery(`request_log?month=eq.${encodeURIComponent(month)}`);

  return configs.map(dept => {
    const slots = [];
    const bookedSlots = {};

    requests.forEach(req => {
      if (req.department === dept.department && 
          req.status && 
          req.status !== 'Rejected') {
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
  const existing = await supabaseQuery(
    `request_log?department=eq.${encodeURIComponent(formData.department)}&month=eq.${encodeURIComponent(formData.month)}&slot=eq.${encodeURIComponent(formData.slot)}`
  );

  const alreadyBooked = existing.some(req => 
    req.status && req.status !== 'Rejected'
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
    status: 'Working'
  };

  const result = await supabaseQuery('request_log', 'POST', requestData);
  return { success: true, requestId: result[0].request_id };
}

// ═══════════════════════════════════════════════════════════════
// PRODUCT SUGGESTION API
// ═══════════════════════════════════════════════════════════════

async function getActiveWindow() {
  const windows = await supabaseQuery('submission_windows?status=eq.Active&order=created_at.desc&limit=1');
  
  if (windows.length === 0) {
    // Create CURRENT 7-day window (started 3 days ago, ends in 4 days)
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 3); // Started 3 days ago
    
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 4); // Ends in 4 days (total 7 days)
    
    const newWindow = {
      window_id: generateId('WIN'),
      start_date: startDate.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0],
      target_suggestions: 30,
      status: 'Active'
    };
    
    const result = await supabaseQuery('submission_windows', 'POST', newWindow);
    return result[0];
  }
  
  return windows[0];
}
async function getProductDashboard() {
  try {
    const window = await getActiveWindow();
    
    if (!window) {
      return { window: null, target: 30, actual: 0, picked: 0, categories: [], rejections: [] };
    }

    const products = await supabaseQuery(
      `product_suggestions?timestamp=gte.${window.start_date}T00:00:00&timestamp=lte.${window.end_date}T23:59:59`
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
  } catch (error) {
    console.error('getProductDashboard error:', error);
    return { window: null, target: 30, actual: 0, picked: 0, categories: [], rejections: [] };
  }
}

async function submitProductSuggestion(formData) {
  const window = await getActiveWindow();
  
  if (!window) {
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

async function searchProductSuggestions(query) {
  const products = await supabaseQuery('product_suggestions?order=timestamp.desc');
  const searchLower = query.toLowerCase();
  
  return products.filter(p => 
    p.product_link.toLowerCase().includes(searchLower) ||
    p.category.toLowerCase().includes(searchLower) ||
    p.submission_id.toLowerCase().includes(searchLower)
  ).slice(0, 20);
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
// ═══════════════════════════════════════════════════════════════
// CONTENT CALENDAR API
// ═══════════════════════════════════════════════════════════════

// Category list (20 categories from Kapruka)
const CATEGORIES = [
  'Cakes',
  'Flowers',
  'Chocolates',
  'Clothing',
  'Electronics',
  'Fashion',
  'Food & Restaurants',
  'Fruits',
  'Soft Toys & Kids Toys',
  'Grocery & Hampers',
  'Greeting Cards & Party Supplies',
  'Sports and Bicycles',
  'Mother and Baby',
  'Jewellery and Watches',
  'Cosmetics & Perfumes',
  'Customized Gifts',
  'Health and Wellness',
  'Home & Lifestyle',
  'Combo and Gift Sets',
  'Books & Stationery'
];

// Get calendar data for a specific month
async function getCalendarData(month, year) {
  try {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    // Get themes for this month
    const themes = await supabaseQuery(
      `theme_config?start_date=lte.${endDate}&end_date=gte.${startDate}`
    );

    // Get category slots for this month
    const monthYear = `${year}-${String(month).padStart(2, '0')}`;
    const categorySlots = await supabaseQuery(
      `category_slots?month_year=eq.${monthYear}`
    );

    // Get bookings for this month
    const bookings = await supabaseQuery(
      `content_calendar?date=gte.${startDate}&date=lte.${endDate}`
    );

    return {
      themes: themes,
      categorySlots: categorySlots,
      bookings: bookings
    };
  } catch (error) {
    console.error('getCalendarData error:', error);
    return { themes: [], categorySlots: [], bookings: [] };
  }
}

// Get theme for a specific date
async function getThemeForDate(date) {
  try {
    const themes = await supabaseQuery(
      `theme_config?start_date=lte.${date}&end_date=gte.${date}`
    );
    return themes.length > 0 ? themes[0] : null;
  } catch (error) {
    console.error('getThemeForDate error:', error);
    return null;
  }
}

// Get category slots for a specific date
async function getCategorySlotsForDate(date) {
  try {
    const slots = await supabaseQuery(
      `category_slots?date=eq.${date}&order=slot_number.asc`
    );
    return slots;
  } catch (error) {
    console.error('getCategorySlotsForDate error:', error);
    return [];
  }
}

// Submit content booking
async function submitContentBooking(bookingData) {
  try {
    // Check if slot is already booked
    const existing = await supabaseQuery(
      `content_calendar?date=eq.${bookingData.date}&slot_number=eq.${bookingData.slotNumber}`
    );

    if (existing.length > 0 && existing[0].status !== 'Rejected') {
      throw new Error('This slot is already booked');
    }

    const booking = {
      date: bookingData.date,
      slot_number: bookingData.slotNumber,
      category: bookingData.category,
      product_code: bookingData.productCode,
      product_link: bookingData.productLink || '',
      status: 'Pending',
      submitted_by: bookingData.submittedBy || 'User',
      theme: bookingData.theme || 'Daily Post'
    };

    const result = await supabaseQuery('content_calendar', 'POST', booking);
    return { success: true, bookingId: result[0].id };
  } catch (error) {
    throw error;
  }
}

// Get all content bookings (for admin)
async function getAllContentBookings() {
  try {
    const bookings = await supabaseQuery('content_calendar?order=date.desc,slot_number.asc');
    return bookings.map(b => ({
      id: b.id,
      date: b.date,
      slotNumber: b.slot_number,
      category: b.category,
      productCode: b.product_code,
      productLink: b.product_link,
      status: b.status,
      submittedBy: b.submitted_by,
      theme: b.theme,
      scheduleDate: b.schedule_date,
      goLiveDate: b.go_live_date,
      reviewer: b.reviewer,
      rejectionReason: b.rejection_reason,
      createdAt: b.created_at
    }));
  } catch (error) {
    console.error('getAllContentBookings error:', error);
    return [];
  }
}

// Update content booking status (admin)
async function updateContentBooking(id, updateData) {
  try {
    const data = {
      status: updateData.status,
      reviewer: updateData.reviewer,
      updated_at: new Date().toISOString()
    };

    if (updateData.status === 'Approved') {
      data.go_live_date = updateData.goLiveDate || null;
    } else if (updateData.status === 'Rejected') {
      data.rejection_reason = updateData.rejectionReason || '';
    }

    await supabaseQuery(`content_calendar?id=eq.${id}`, 'PATCH', data);
    return { success: true };
  } catch (error) {
    throw error;
  }
}

// Get all themes (for admin)
async function getAllThemes() {
  try {
    const themes = await supabaseQuery('theme_config?order=start_date.desc');
    return themes;
  } catch (error) {
    console.error('getAllThemes error:', error);
    return [];
  }
}

// Add new theme (admin)
async function addTheme(themeData) {
  try {
    const theme = {
      theme_name: themeData.themeName,
      start_date: themeData.startDate,
      end_date: themeData.endDate,
      slots_per_day: parseInt(themeData.slotsPerDay),
      theme_color: themeData.themeColor || '#422B73',
      is_seasonal: themeData.isSeasonal || false
    };

    const result = await supabaseQuery('theme_config', 'POST', theme);

    // If it's a Daily Post theme, generate category slots
    if (!themeData.isSeasonal) {
      await generateCategorySlots(themeData.startDate, themeData.endDate, themeData.slotsPerDay);
    }

    return { success: true, themeId: result[0].id };
  } catch (error) {
    throw error;
  }
}

// Generate category slots for a date range (admin)
async function generateCategorySlots(startDate, endDate, slotsPerDay) {
  try {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const slots = [];

    // Shuffle categories for variety
    const shuffledCategories = [...CATEGORIES].sort(() => Math.random() - 0.5);
    let categoryIndex = 0;

    let currentDate = new Date(start);
    let weekNumber = Math.floor((currentDate.getDate() - 1) / 7) + 1;

    while (currentDate <= end) {
      const dateStr = currentDate.toISOString().split('T')[0];
      const monthYear = dateStr.substring(0, 7);

      // Reshuffle every week (7 days)
      if (currentDate.getDay() === 0 && currentDate > start) {
        shuffledCategories.sort(() => Math.random() - 0.5);
        categoryIndex = 0;
        weekNumber++;
      }

      // Create slots for this day
      for (let slotNum = 1; slotNum <= slotsPerDay; slotNum++) {
        slots.push({
          date: dateStr,
          slot_number: slotNum,
          category: shuffledCategories[categoryIndex % shuffledCategories.length],
          week_number: weekNumber,
          month_year: monthYear
        });
        categoryIndex++;
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Batch insert
    if (slots.length > 0) {
      await supabaseQuery('category_slots', 'POST', slots);
    }

    return { success: true, slotsCreated: slots.length };
  } catch (error) {
    console.error('generateCategorySlots error:', error);
    throw error;
  }
}

// Delete theme (admin)
async function deleteTheme(themeId) {
  try {
    await supabaseQuery(`theme_config?id=eq.${themeId}`, 'DELETE');
    return { success: true };
  } catch (error) {
    throw error;
  }
}

// Refresh category slots for a month (admin - for monthly refresh)
async function refreshCategorySlotsForMonth(month, year) {
  try {
    const monthYear = `${year}-${String(month).padStart(2, '0')}`;
    
    // Delete existing slots for this month
    await supabaseQuery(`category_slots?month_year=eq.${monthYear}`, 'DELETE');

    // Get Daily Post themes for this month
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    const themes = await supabaseQuery(
      `theme_config?start_date=lte.${endDate}&end_date=gte.${startDate}&is_seasonal=eq.false`
    );

    // Regenerate slots for each Daily Post theme
    for (const theme of themes) {
      const themeStart = theme.start_date > startDate ? theme.start_date : startDate;
      const themeEnd = theme.end_date < endDate ? theme.end_date : endDate;
      await generateCategorySlots(themeStart, themeEnd, theme.slots_per_day);
    }

    return { success: true };
  } catch (error) {
    throw error;
  }
}
