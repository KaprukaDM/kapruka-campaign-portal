// ═══════════════════════════════════════════════════════════════
// SUPABASE API CLIENT - KAPRUKA CAMPAIGN PORTAL
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';
const ADMIN_PASSWORD = 'Kapruka2026!Admin';

const VALID_STATUSES = ['Request Submitted', 'Working', 'Live', 'Completed', 'Rejected'];

// ═══════════════════════════════════════════════════════════════
// PAGE SCHEDULE CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const PAGE_SCHEDULE = {
  'Kapruka FB Leads': { day: 1, slots: 3 },      // Monday
  'Electronic Factory': { day: 2, slots: 3 },    // Tuesday
  'Social Mart': { day: 3, slots: 3 },          // Wednesday
  'Fashion Factory': { day: 4, slots: 3 },       // Thursday
  'Toys Factory': { day: 5, slots: 3 },         // Friday
  'Handbag Factory': { day: 6, slots: 3 },      // Saturday
  'TikTok Video': { day: 0, slots: 1 }          // Sunday (weekly)
};

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

function getAllPageNames() {
  return Object.keys(PAGE_SCHEDULE);
}

// ═══════════════════════════════════════════════════════════════
// ENHANCED STUDIO CALENDAR - SHOW ALL CONTENT CALENDAR SLOTS
// ═══════════════════════════════════════════════════════════════

async function getStudioCalendarData(month, year) {
  try {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    // Get all content themes
    const themes = await supabaseQuery(
      `theme_config?start_date=lte.${endDate}&end_date=gte.${startDate}`
    );

    // Get all category slots (this defines ALL possible slots)
    const categorySlots = await supabaseQuery(
      `category_slots?date=gte.${startDate}&date=lte.${endDate}&order=date.asc,slot_number.asc`
    );

    // Get all content bookings
    const contentBookings = await supabaseQuery(
      `content_calendar?date=gte.${startDate}&date=lte.${endDate}`
    );

    // Get approved product suggestions that have been assigned
    const productSuggestions = await supabaseQuery(
      `product_suggestions?status=eq.Approved&go_live_date=gte.${startDate}&go_live_date=lte.${endDate}`
    );

    // Get existing studio calendar entries
    const studioEntries = await supabaseQuery(
      `studio_calendar?date=gte.${startDate}&date=lte.${endDate}`
    );

    // Combine all data
    const calendarItems = [];

    // Process ALL category slots (both empty and booked)
    categorySlots.forEach(slot => {
      // Check if this slot is booked in content_calendar
      const booking = contentBookings.find(b => 
        b.date === slot.date && 
        b.slot_number === slot.slot_number &&
        (b.status === 'Approved' || b.status === 'Pending')
      );

      // Check if there's a studio entry for this
      const studioEntry = studioEntries.find(s => 
        s.date === slot.date && 
        s.source_type === 'content_booking' &&
        s.source_id === booking?.id
      );

      calendarItems.push({
        date: slot.date,
        slotNumber: slot.slot_number,
        category: slot.category,
        type: 'content_slot',
        status: booking ? (booking.status === 'Approved' ? 'booked' : 'pending') : 'empty',
        productCode: booking?.product_code || null,
        productLink: booking?.product_link || null,
        theme: booking?.theme || '',
        submittedBy: booking?.submitted_by || null,
        studioStatus: studioEntry?.completion_status || 'pending',
        studioLink: studioEntry?.content_link || null,
        studioId: studioEntry?.id || null,
        bookingId: booking?.id || null
      });
    });

    // Add TikTok Video slots for every Sunday
    const currentDate = new Date(startDate);
    const endDateObj = new Date(endDate);
    
    while (currentDate <= endDateObj) {
      if (currentDate.getDay() === 0) { // Sunday
        const dateStr = currentDate.toISOString().split('T')[0];
        
        const tiktokEntry = studioEntries.find(s => 
          s.date === dateStr && 
          s.page_name === 'TikTok Video'
        );

        calendarItems.push({
          date: dateStr,
          slotNumber: 1,
          category: 'TikTok Video',
          type: 'tiktok_slot',
          status: tiktokEntry ? 'booked' : 'empty',
          productCode: tiktokEntry?.product_code || null,
          pageName: 'TikTok Video',
          studioStatus: tiktokEntry?.completion_status || 'pending',
          studioLink: tiktokEntry?.content_link || null,
          studioId: tiktokEntry?.id || null,
          contentDetails: tiktokEntry?.content_details || null
        });
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Add product suggestions
    productSuggestions.forEach(product => {
      const existingStudio = studioEntries.find(s => 
        s.source_type === 'product_suggestion' && 
        s.source_id === product.id
      );

      calendarItems.push({
        date: product.go_live_date,
        slotNumber: product.slot_number || null,
        type: 'product_suggestion',
        status: 'booked',
        productLink: product.product_link,
        pageName: product.assigned_page,
        category: product.category,
        promotionIdea: product.promotion_idea,
        studioStatus: existingStudio?.completion_status || 'pending',
        studioLink: existingStudio?.content_link || null,
        studioId: existingStudio?.id || null,
        productSuggestionId: product.id
      });
    });

    return {
      themes: themes || [],
      calendarItems: calendarItems.sort((a, b) => {
        if (a.date === b.date) {
          return (a.slotNumber || 0) - (b.slotNumber || 0);
        }
        return a.date.localeCompare(b.date);
      })
    };
  } catch (error) {
    console.error('getStudioCalendarData error:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// GET AVAILABLE SLOTS FOR PAGE (Next 3 Weeks)
// ═══════════════════════════════════════════════════════════════

async function getAvailableSlotsForPage(pageName) {
  try {
    if (!PAGE_SCHEDULE[pageName]) {
      throw new Error(`Invalid page name: ${pageName}`);
    }

    const schedule = PAGE_SCHEDULE[pageName];
    const targetDay = schedule.day; // 0=Sunday, 1=Monday, etc.
    const slotsPerDay = schedule.slots;

    // Get dates for next 3 weeks for this specific weekday
    const dates = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find next occurrence of the target day
    let currentDate = new Date(today);
    const daysUntilTarget = (targetDay - currentDate.getDay() + 7) % 7;
    if (daysUntilTarget === 0) {
      // If today is the target day, start from next week
      currentDate.setDate(currentDate.getDate() + 7);
    } else {
      currentDate.setDate(currentDate.getDate() + daysUntilTarget);
    }

    // Get next 3 occurrences of this weekday
    for (let i = 0; i < 3; i++) {
      dates.push(currentDate.toISOString().split('T')[0]);
      currentDate.setDate(currentDate.getDate() + 7);
    }

    // Get existing bookings for these dates and page
    const contentBookings = await supabaseQuery(
      `content_calendar?page_name=eq.${encodeURIComponent(pageName)}`
    );

    // Check product_suggestions bookings
    const productBookings = await supabaseQuery(
      `product_suggestions?assigned_page=eq.${encodeURIComponent(pageName)}&status=eq.Approved`
    );

    // Build slot availability for each date
    const slotAvailability = [];

    dates.forEach(date => {
      for (let slotNum = 1; slotNum <= slotsPerDay; slotNum++) {
        // Check if slot is booked in content_calendar
        const contentBooked = contentBookings.find(b => 
          b.date === date && 
          b.slot_number === slotNum &&
          (b.status === 'Approved' || b.status === 'Pending')
        );

        // Check if slot is booked in product_suggestions
        const productBooked = productBookings.find(p => 
          p.slot_date === date && 
          p.slot_number === slotNum
        );

        const isBooked = !!(contentBooked || productBooked);

        slotAvailability.push({
          date: date,
          slotNumber: slotNum,
          available: !isBooked,
          bookedBy: contentBooked ? `Content: ${contentBooked.product_code}` : 
                    productBooked ? `Product: ${productBooked.submission_id}` : null
        });
      }
    });

    return {
      pageName: pageName,
      weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][targetDay],
      slots: slotAvailability
    };
  } catch (error) {
    console.error('getAvailableSlotsForPage error:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// STUDIO CALENDAR + EXTRA CONTENT CORE (LEGACY FUNCTIONS)
// ═══════════════════════════════════════════════════════════════

async function upsertStudioCalendarEntry(entry) {
  const payload = {
    date: entry.date,
    source_type: entry.source_type,
    source_id: entry.source_id || null,
    product_code: entry.product_code || null,
    page_name: entry.page_name || null,
    format: entry.format || null,
    content_details: entry.content_details || '',
    reference_links: entry.reference_links || ''
  };

  if (entry.source_id) {
    const existing = await supabaseQuery(
      `studio_calendar?source_type=eq.${encodeURIComponent(entry.source_type)}&source_id=eq.${entry.source_id}`
    );

    if (existing.length > 0) {
      const id = existing[0].id;
      await supabaseQuery(`studio_calendar?id=eq.${id}`, 'PATCH', payload);
      return id;
    }
  }

  const result = await supabaseQuery('studio_calendar', 'POST', payload);
  return result[0].id;
}

async function getStudioCalendarForMonth(year, month) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

  return await supabaseQuery(
    `studio_calendar?date=gte.${startDate}&date=lte.${endDate}&order=date.asc`
  );
}

async function getStudioCalendarForDate(date) {
  return await supabaseQuery(
    `studio_calendar?date=eq.${date}&order=created_at.asc`
  );
}

async function getStudioCalendarItem(id) {
  const rows = await supabaseQuery(`studio_calendar?id=eq.${id}`);
  return rows.length ? rows[0] : null;
}

async function updateStudioCompletion(id, data) {
  const payload = {
    completion_status: data.completion_status,
    content_link: data.content_link || null
  };
  await supabaseQuery(`studio_calendar?id=eq.${id}`, 'PATCH', payload);
  return { success: true };
}

async function addExtraContent(extra) {
  const row = {
    date: extra.date,
    page_name: extra.page_name,
    format: extra.format || '',
    content_details: extra.content_details,
    reference_links: extra.reference_links || '',
    created_by: extra.created_by || ''
  };

  const result = await supabaseQuery('extra_content', 'POST', row);
  const saved = result[0];

  await upsertStudioCalendarEntry({
    date: saved.date,
    source_type: 'extra_content',
    source_id: saved.id,
    product_code: null,
    page_name: saved.page_name,
    format: saved.format,
    content_details: saved.content_details,
    reference_links: saved.reference_links
  });

  return saved;
}

async function updateExtraContent(id, extra) {
  const row = {
    date: extra.date,
    page_name: extra.page_name,
    format: extra.format || '',
    content_details: extra.content_details,
    reference_links: extra.reference_links || ''
  };

  await supabaseQuery(`extra_content?id=eq.${id}`, 'PATCH', row);

  await upsertStudioCalendarEntry({
    date: extra.date,
    source_type: 'extra_content',
    source_id: id,
    product_code: null,
    page_name: extra.page_name,
    format: extra.format,
    content_details: extra.content_details,
    reference_links: extra.reference_links
  });

  return { success: true };
}

async function deleteExtraContent(id) {
  await supabaseQuery(`extra_content?id=eq.${id}`, 'DELETE');
  await supabaseQuery(`studio_calendar?source_type=eq.extra_content&source_id=eq.${id}`, 'DELETE');
  return { success: true };
}

async function getExtraContentForMonth(year, month) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

  return await supabaseQuery(
    `extra_content?date=gte.${startDate}&date=lte.${endDate}&order=date.asc`
  );
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
          req.status !== 'Rejected' &&
          req.status !== 'Completed') {
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
    req.status && 
    req.status !== 'Rejected' && 
    req.status !== 'Completed'
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
    status: 'Request Submitted'
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
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 3);

    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 4);

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
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Valid statuses are: ${VALID_STATUSES.join(', ')}`);
  }

  const updateData = {
    status,
    reviewer,
    updated_at: new Date().toISOString(),
    comments
  };

  if (status === 'Completed') {
    updateData.completed_at = new Date().toISOString();
  }

  await supabaseQuery(
    `request_log?id=eq.${row}`,
    'PATCH',
    updateData
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
    slotDate: p.slot_date || '',
    slotNumber: p.slot_number || null,
    reviewerName: p.reviewer_name || '',
    rejectionReason: p.rejection_reason || ''
  }));
}

async function updateProductReviewWithSlot(row, reviewData) {
  try {
    const updateData = {
      status: reviewData.status,
      reviewer_name: reviewData.reviewerName
    };

    if (reviewData.status === 'Approved') {
      updateData.assigned_page = reviewData.assignedPage || '';
      updateData.go_live_date = reviewData.goLiveDate || null;
      updateData.slot_date = reviewData.slotDate || reviewData.goLiveDate;
      updateData.slot_number = reviewData.slotNumber || null;
      updateData.rejection_reason = '';
    } else {
      updateData.assigned_page = '';
      updateData.go_live_date = null;
      updateData.slot_date = null;
      updateData.slot_number = null;
      updateData.rejection_reason = reviewData.rejectionReason || '';
    }

    await supabaseQuery(`product_suggestions?id=eq.${row}`, 'PATCH', updateData);

    // Add to studio calendar if approved
    if (reviewData.status === 'Approved') {
      const rows = await supabaseQuery(`product_suggestions?id=eq.${row}`);
      if (rows.length) {
        const p = rows[0];

        await upsertStudioCalendarEntry({
          date: reviewData.slotDate || reviewData.goLiveDate || p.go_live_date,
          source_type: 'product_suggestion',
          source_id: p.id,
          product_code: p.product_code || p.submission_id,
          page_name: reviewData.assignedPage || p.assigned_page || null,
          format: 'Product Suggestion',
          content_details: p.promotion_idea || p.product_link,
          reference_links: p.product_link
        });
      }
    }

    return { success: true };
  } catch (error) {
    console.error('updateProductReviewWithSlot error:', error);
    throw error;
  }
}

// Keep the old function for backward compatibility
async function updateProductReview(row, reviewData) {
  return await updateProductReviewWithSlot(row, reviewData);
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

async function getCalendarData(month, year) {
  try {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    const themes = await supabaseQuery(
      `theme_config?start_date=lte.${endDate}&end_date=gte.${startDate}`
    );

    const monthYear = `${year}-${String(month).padStart(2, '0')}`;
    const categorySlots = await supabaseQuery(
      `category_slots?month_year=eq.${monthYear}`
    );

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

async function submitContentBooking(bookingData) {
  try {
    const existing = await supabaseQuery(
      `content_calendar?date=eq.${bookingData.date}&slot_number=eq.${bookingData.slotNumber}`
    );

    const alreadyBooked = existing.some(b => b.status === 'Pending' || b.status === 'Approved');

    if (alreadyBooked) {
      throw new Error('This slot is already booked');
    }

    const themes = await supabaseQuery(
      `theme_config?start_date=lte.${bookingData.date}&end_date=gte.${bookingData.date}`
    );

    const themeName = themes.length > 0 ? themes[0].theme_name : 'Daily Post';

    const booking = {
      date: bookingData.date,
      slot_number: parseInt(bookingData.slotNumber),
      category: bookingData.category,
      product_code: bookingData.productCode,
      product_link: bookingData.productLink || '',
      status: 'Pending',
      submitted_by: bookingData.submittedBy || 'User',
      theme: themeName
    };

    const result = await supabaseQuery('content_calendar', 'POST', booking);
    return { success: true, bookingId: result[0].id };
  } catch (error) {
    console.error('submitContentBooking error:', error);
    throw error;
  }
}

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
      pageName: b.page_name,
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

    if (updateData.status === 'Approved') {
      const rows = await supabaseQuery(`content_calendar?id=eq.${id}`);
      if (rows.length) {
        const b = rows[0];
        await upsertStudioCalendarEntry({
          date: updateData.goLiveDate || b.date,
          source_type: 'content_booking',
          source_id: b.id,
          product_code: b.product_code,
          page_name: b.page_name || null,
          format: 'Content Calendar',
          content_details: `${b.theme || ''} - ${b.category || ''}`.trim(),
          reference_links: b.product_link || ''
        });
      }
    }

    return { success: true };
  } catch (error) {
    throw error;
  }
}

async function getAllThemes() {
  try {
    const themes = await supabaseQuery('theme_config?order=start_date.desc');
    return themes;
  } catch (error) {
    console.error('getAllThemes error:', error);
    return [];
  }
}

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

    await generateCategorySlots(
      themeData.startDate, 
      themeData.endDate, 
      themeData.slotsPerDay,
      themeData.isSeasonal
    );

    return { success: true, themeId: result[0].id };
  } catch (error) {
    throw error;
  }
}

async function generateCategorySlots(startDate, endDate, slotsPerDay, isSeasonal = false) {
  try {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const slots = [];

    const categoriesToUse = isSeasonal 
      ? ['Any Category']
      : [...CATEGORIES].sort(() => Math.random() - 0.5);

    let categoryIndex = 0;

    let currentDate = new Date(start);
    let weekNumber = Math.floor((currentDate.getDate() - 1) / 7) + 1;

    while (currentDate <= end) {
      const dateStr = currentDate.toISOString().split('T')[0];
      const monthYear = dateStr.substring(0, 7);

      if (!isSeasonal && currentDate.getDay() === 0 && currentDate > start) {
        categoriesToUse.sort(() => Math.random() - 0.5);
        categoryIndex = 0;
        weekNumber++;
      }

      for (let slotNum = 1; slotNum <= slotsPerDay; slotNum++) {
        slots.push({
          date: dateStr,
          slot_number: slotNum,
          category: categoriesToUse[categoryIndex % categoriesToUse.length],
          week_number: weekNumber,
          month_year: monthYear
        });
        categoryIndex++;
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    if (slots.length > 0) {
      await supabaseQuery('category_slots', 'POST', slots);
    }

    return { success: true, slotsCreated: slots.length };
  } catch (error) {
    console.error('generateCategorySlots error:', error);
    throw error;
  }
}

async function deleteTheme(themeId) {
  try {
    const themes = await supabaseQuery(`theme_config?id=eq.${themeId}`);
    if (themes.length === 0) throw new Error('Theme not found');

    const theme = themes[0];

    const slots = await supabaseQuery(
      `category_slots?date=gte.${theme.start_date}&date=lte.${theme.end_date}`
    );

    if (slots.length > 0) {
      await supabaseQuery(
        `category_slots?date=gte.${theme.start_date}&date=lte.${theme.end_date}`,
        'DELETE'
      );
    }

    await supabaseQuery(`theme_config?id=eq.${themeId}`, 'DELETE');

    return { success: true, slotsDeleted: slots.length };
  } catch (error) {
    console.error('deleteTheme error:', error);
    throw error;
  }
}

async function refreshCategorySlotsForMonth(month, year) {
  try {
    const monthYear = `${year}-${String(month).padStart(2, '0')}`;

    await supabaseQuery(`category_slots?month_year=eq.${monthYear}`, 'DELETE');

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    const themes = await supabaseQuery(
      `theme_config?start_date=lte.${endDate}&end_date=gte.${startDate}`
    );

    for (const theme of themes) {
      const themeStart = theme.start_date > startDate ? theme.start_date : startDate;
      const themeEnd = theme.end_date < endDate ? theme.end_date : endDate;
      await generateCategorySlots(themeStart, themeEnd, theme.slots_per_day, theme.is_seasonal);
    }

    return { success: true };
  } catch (error) {
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// PRODUCT PERFORMANCE API
// ═══════════════════════════════════════════════════════════════

async function searchProductPerformance(keyword, startDate, endDate) {
  try {
    let url = `${SUPABASE_URL}/rest/v1/meta_ads_performance?`;

    if (startDate && endDate) {
      url += `date=gte.${startDate}&date=lte.${endDate}&`;
    }

    url += `order=date.desc`;

    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const allData = await response.json();

    const keywordLower = keyword.toLowerCase();
    const results = allData.filter(row => 
      (row.campaign_name && row.campaign_name.toLowerCase().includes(keywordLower)) ||
      (row.adset_name && row.adset_name.toLowerCase().includes(keywordLower)) ||
      (row.ad_name && row.ad_name.toLowerCase().includes(keywordLower))
    );

    if (results.length === 0) {
      return { level: 'none', data: [], aggregated: [] };
    }

    const uniqueAccounts = [...new Set(results.map(r => r.ad_account_id).filter(Boolean))];

    let aggregationLevel = 'ad';
    let dataToAggregate = results;
    let groupBy = 'ad_name';

    if (uniqueAccounts.length > 1) {
      aggregationLevel = 'account';
      groupBy = 'ad_account_id';
    }
    else {
      const campaignMatches = results.filter(r => 
        r.campaign_name && r.campaign_name.toLowerCase().includes(keywordLower)
      );

      if (campaignMatches.length > 0) {
        aggregationLevel = 'campaign';
        dataToAggregate = campaignMatches;
        groupBy = 'campaign_name';
      } 
      else {
        const adsetMatches = results.filter(r => 
          r.adset_name && r.adset_name.toLowerCase().includes(keywordLower)
        );

        if (adsetMatches.length > 0) {
          aggregationLevel = 'adset';
          dataToAggregate = adsetMatches;
          groupBy = 'adset_name';
        }
        else {
          const adMatches = results.filter(r => 
            r.ad_name && r.ad_name.toLowerCase().includes(keywordLower)
          );

          if (adMatches.length > 0) {
            dataToAggregate = adMatches;
          }
        }
      }
    }

    const grouped = {};
    dataToAggregate.forEach(row => {
      const key = row[groupBy] || 'Unknown';
      if (!grouped[key]) {
        grouped[key] = {
          name: key,
          campaign_name: row.campaign_name || 'N/A',
          adset_name: row.adset_name || 'N/A',
          ad_name: row.ad_name || 'N/A',
          objective: row.objective || 'N/A',
          amount_spent: 0,
          reach: 0,
          impression: 0,
          clicks: 0,
          results: 0,
          direct_orders: 0,
          dates: [],
          ad_account_id: row.ad_account_id || 'N/A'
        };
      }

      grouped[key].amount_spent += parseFloat(row.amount_spent || 0);
      grouped[key].reach += parseInt(row.reach || 0);
      grouped[key].impression += parseInt(row.impression || 0);
      grouped[key].clicks += parseInt(row.clicks || 0);
      grouped[key].results += parseInt(row.results || 0);
      grouped[key].direct_orders += parseInt(row.if_direct_orders || 0);
      grouped[key].dates.push(row.date);
    });

    const aggregated = Object.values(grouped).map(item => {
      const cpc = item.clicks > 0 ? (item.amount_spent / item.clicks).toFixed(2) : 0;
      const cpm = item.impression > 0 ? ((item.amount_spent / item.impression) * 1000).toFixed(2) : 0;
      const ctr = item.impression > 0 ? ((item.clicks / item.impression) * 100).toFixed(2) : 0;
      const conversionRate = item.clicks > 0 ? ((item.direct_orders / item.clicks) * 100).toFixed(2) : 0;

      const sortedDates = item.dates.sort();
      const dateRange = sortedDates.length > 0 
        ? `${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}` 
        : 'N/A';

      return {
        ...item,
        cpc,
        cpm,
        ctr,
        conversionRate,
        dateRange,
        dayCount: new Set(item.dates).size
      };
    });

    return {
      level: aggregationLevel,
      data: results,
      aggregated: aggregated,
      totalRecords: results.length
    };

  } catch (error) {
    console.error('searchProductPerformance error:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// HOT PRODUCTS API
// ═══════════════════════════════════════════════════════════════

async function getHotProductsByCategory(category) {
  try {
    const products = await supabaseQuery(
      `hot_products?category=eq.${encodeURIComponent(category)}&order=created_at.desc`
    );
    return products;
  } catch (error) {
    console.error('getHotProductsByCategory error:', error);
    throw error;
  }
}

async function getAllHotProducts() {
  try {
    const products = await supabaseQuery('hot_products?order=created_at.desc');
    return products;
  } catch (error) {
    console.error('getAllHotProducts error:', error);
    throw error;
  }
}

async function addHotProduct(productData) {
  try {
    const data = {
      category: productData.category,
      product_link: productData.productLink,
      sales_count: parseInt(productData.salesCount) || 0,
      listed: false,
      kapruka_link: null
    };

    const result = await supabaseQuery('hot_products', 'POST', data);
    return { success: true, product: result[0] };
  } catch (error) {
    console.error('addHotProduct error:', error);
    throw error;
  }
}

async function updateHotProduct(productId, updateData) {
  try {
    const data = {};

    if (updateData.listed !== undefined) {
      data.listed = updateData.listed;
    }

    if (updateData.kapruka_link !== undefined) {
      data.kapruka_link = updateData.kapruka_link || null;
    }

    if (updateData.salesCount !== undefined) {
      data.sales_count = parseInt(updateData.salesCount) || 0;
    }

    await supabaseQuery(`hot_products?id=eq.${productId}`, 'PATCH', data);
    return { success: true };
  } catch (error) {
    console.error('updateHotProduct error:', error);
    throw error;
  }
}

async function deleteHotProduct(productId) {
  try {
    await supabaseQuery(`hot_products?id=eq.${productId}`, 'DELETE');
    return { success: true };
  } catch (error) {
    console.error('deleteHotProduct error:', error);
    throw error;
  }
}

async function getHotProductsStats() {
  try {
    const products = await supabaseQuery('hot_products');

    const stats = {
      totalProducts: products.length,
      listedProducts: products.filter(p => p.listed).length,
      byCategory: {}
    };

    products.forEach(p => {
      if (!stats.byCategory[p.category]) {
        stats.byCategory[p.category] = {
          total: 0,
          listed: 0,
          totalSales: 0
        };
      }
      stats.byCategory[p.category].total++;
      if (p.listed) stats.byCategory[p.category].listed++;
      stats.byCategory[p.category].totalSales += (p.sales_count || 0);
    });

    return stats;
  } catch (error) {
    console.error('getHotProductsStats error:', error);
    throw error;
  }
}
