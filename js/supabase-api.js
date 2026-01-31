// ═══════════════════════════════════════════════════════════════
// SUPABASE API CLIENT - KAPRUKA CAMPAIGN PORTAL (UPDATED)
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';
const ADMIN_PASSWORD = 'Kapruka2026!Admin';
const HEAD_APPROVAL_PASSWORD = '207';
const SUPERADMIN_PASSWORD = 'Superadmin';  // Change this!

function verifySuperAdminPassword(password) {
  return password === SUPERADMIN_PASSWORD;
}

const VALID_STATUSES = ['Request Submitted', 'Working', 'Live', 'Completed', 'Rejected'];
const STUDIO_STATUSES = ['Received', 'Working', 'Submitted for Review', 'Approved'];

// Page assignments by day of week
const PAGE_SCHEDULE = {
  0: { page: 'TikTok Video', slots: 1 },           // Sunday
  1: { page: 'Kapruka FB', slots: 3 },             // Monday
  2: { page: 'Electronic Factory', slots: 3 },     // Tuesday
  3: { page: 'Social Mart', slots: 3 },            // Wednesday
  4: { page: 'Fashion Factory', slots: 3 },        // Thursday
  5: { page: 'Toys Factory', slots: 3 },           // Friday
  6: { page: 'Handbag Factory', slots: 3 }         // Saturday
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
    const errorText = await response.text();
    throw new Error(`API Error: ${response.statusText} - ${errorText}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

function getCurrentMonth() {
  const now = new Date();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}

function generateId(prefix) {
  return `${prefix}-${Date.now()}`;
}

function getDayName(dayNumber) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[dayNumber];
}

// ═══════════════════════════════════════════════════════════════
// SLOT AVAILABILITY FUNCTIONS (UPDATED)
// ═══════════════════════════════════════════════════════════════

async function getAvailableSlotsForPage(pageName) {
  try {
    // Get page schedule info
    let dayOfWeek = null;
    let slotsPerDay = 3;
    
    for (const [day, config] of Object.entries(PAGE_SCHEDULE)) {
      if (config.page === pageName) {
        dayOfWeek = parseInt(day);
        slotsPerDay = config.slots;
        break;
      }
    }
    
    if (dayOfWeek === null) {
      throw new Error('Invalid page name');
    }
    
    // Get dates for next 3 weeks matching this day
    const availableDates = [];
    const today = new Date();
    
    for (let i = 0; i < 21; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(today.getDate() + i);
      
      if (checkDate.getDay() === dayOfWeek) {
        availableDates.push(checkDate.toISOString().split('T')[0]);
      }
    }
    
    // CHECK BOTH product_suggestions AND studio_calendar
    const todayStr = today.toISOString().split('T')[0];
    
    // Get booked slots from product_suggestions
    const bookedFromProducts = await supabaseQuery(
      `product_suggestions?assigned_page=eq.${encodeURIComponent(pageName)}&status=eq.Approved&slot_date=gte.${todayStr}`
    );
    
    // Get booked slots from studio_calendar (includes manual bookings)
    const bookedFromStudio = await supabaseQuery(
      `studio_calendar?page_name=eq.${encodeURIComponent(pageName)}&booking_status=eq.booked&date=gte.${todayStr}`
    );
    
    // Build availability map
    const slots = [];
    
    for (const date of availableDates) {
      for (let slotNum = 1; slotNum <= slotsPerDay; slotNum++) {
        const isBookedInProducts = bookedFromProducts.some(
          s => s.slot_date === date && s.slot_number === slotNum
        );
        const isBookedInStudio = bookedFromStudio.some(
          s => s.date === date && s.slot_number === slotNum
        );
        const isBooked = isBookedInProducts || isBookedInStudio;
        
        slots.push({
          date: date,
          slotNumber: slotNum,
          available: !isBooked,
          pageName: pageName
        });
      }
    }
    
    return slots;
  } catch (error) {
    console.error('getAvailableSlotsForPage error:', error);
    throw error;
  }
}

async function bookProductSlot(productId, slotDate, slotNumber, pageName) {
  try {
    const existing = await supabaseQuery(
      `product_suggestions?slot_date=eq.${slotDate}&slot_number=eq.${slotNumber}&assigned_page=eq.${encodeURIComponent(pageName)}&status=eq.Approved`
    );
    
    if (existing.length > 0) {
      throw new Error('This slot is already booked');
    }
    
    const dateObj = new Date(slotDate);
    const dayName = getDayName(dateObj.getDay());
    
    await supabaseQuery(
      `product_suggestions?id=eq.${productId}`,
      'PATCH',
      {
        slot_date: slotDate,
        slot_number: slotNumber,
        slot_day_name: dayName
      }
    );
    
    return { success: true };
  } catch (error) {
    console.error('bookProductSlot error:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
/* STUDIO CALENDAR CORE (UPDATED) */
// ═══════════════════════════════════════════════════════════════

async function upsertStudioCalendarEntry(entry) {
  const payload = {
    date: entry.date,
    department: entry.department || null,
    source_type: entry.source_type,
    source_id: entry.source_id || null,
    product_code: entry.product_code || null,
    page_name: entry.page_name || null,
    format: entry.format || null,
    content_details: entry.content_details || '',
    reference_links: entry.reference_links || '',
    slot_number: entry.slot_number || null,
    slot_type: entry.slot_type || 'content_calendar',
    booking_status: entry.booking_status || 'booked',
    studio_status: 'Received',
    approval_status: 'Received'
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
    `studio_calendar?date=gte.${startDate}&date=lte.${endDate}&order=date.asc,slot_number.asc`
  );
}

async function getStudioCalendarForDate(date) {
  return await supabaseQuery(
    `studio_calendar?date=eq.${date}&order=slot_type.asc,slot_number.asc,created_at.asc`
  );
}

async function getStudioCalendarItem(id) {
  const rows = await supabaseQuery(`studio_calendar?id=eq.${id}`);
  return rows.length ? rows[0] : null;
}

// ═══════════════════════════════════════════════════════════════
// DM APPROVAL HELPERS
// ═══════════════════════════════════════════════════════════════

async function getDmApprovals() {
  return await supabaseQuery('dm_approvals?order=created_at.desc');
}

// ═════════════════════════════════════════════════════════════
/* UPDATED: DM APPROVAL UPDATE - NOW SYNCS WITH STUDIO_CALENDAR */
// ═════════════════════════════════════════════════════════════
async function updateDmApproval(id, data) {
  const payload = {
    dm_status: data.dm_status,
    updated_at: new Date().toISOString()
  };

  if (data.dm_status === 'Approved') {
    payload.approved_at = new Date().toISOString();
    payload.dm_approved_by = data.approved_by || 'DM';
    
    // Update studio_calendar
    const dmRecord = await supabaseQuery(`dm_approvals?id=eq.${id}`);
    if (dmRecord.length > 0) {
      await supabaseQuery(
        `studio_calendar?id=eq.${dmRecord[0].content_id}`,
        'PATCH',
        {
          approval_status: 'Approved by DM',
          dm_approved_at: new Date().toISOString(),
          dm_approved_by: data.approved_by || 'DM'
        }
      );
    }
  } else if (data.dm_status === 'Rejected') {
    payload.dm_rejection_reason = data.rejection_reason || '';
    
    // Update studio_calendar
    const dmRecord = await supabaseQuery(`dm_approvals?id=eq.${id}`);
    if (dmRecord.length > 0) {
      await supabaseQuery(
        `studio_calendar?id=eq.${dmRecord[0].content_id}`,
        'PATCH',
        {
          approval_status: 'Rejected by DM',
          dm_rejection_reason: data.rejection_reason || ''
        }
      );
    }
  }

  await supabaseQuery(`dm_approvals?id=eq.${id}`, 'PATCH', payload);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
/* UPDATED: STUDIO STATUS UPDATE (WITH HEAD REJECTION & RESUBMISSION) */
// ═══════════════════════════════════════════════════════════════

async function updateStudioStatus(id, statusData) {
  const payload = {
    studio_status: statusData.studio_status
  }
  if (statusData.assigned_to !== undefined) {
  payload.assigned_to = statusData.assigned_to;
}  
    ;

  // Map studio_status → approval_status for filters
  if (statusData.studio_status === 'Approved') {
    payload.approval_status = 'Approved by Head';
  } else if (statusData.studio_status === 'Submitted for Review') {
    // Check if this is a resubmission
    const current = await supabaseQuery(`studio_calendar?id=eq.${id}`);
    if (current.length && (current[0].approval_status === 'Rejected by Head' || 
                           current[0].approval_status === 'Rejected by DM')) {
      payload.approval_status = 'Resubmitted for Review';
    } else {
      payload.approval_status = 'Submitted for Review';
    }
  } else if (statusData.studio_status === 'Working') {
    payload.approval_status = 'Working';
  } else if (statusData.studio_status === 'Received') {
    payload.approval_status = 'Received';
  }

  // If submitting for review, require content link
  if (statusData.studio_status === 'Submitted for Review') {
    if (!statusData.content_link) {
      throw new Error('Content link is required for submission');
    }
    payload.content_link = statusData.content_link;
  }

  // If approving (Head), require password
  if (statusData.studio_status === 'Approved') {
    if (!statusData.password || statusData.password !== HEAD_APPROVAL_PASSWORD) {
      throw new Error('Invalid approval password');
    }
    payload.head_approved = true;
    payload.head_approved_at = new Date().toISOString();
    payload.approved_by = statusData.approved_by || 'Content Head';
    payload.content_link = statusData.content_link || null;
  }

  // ADDED: If rejecting (Head), require password and reason
  if (statusData.studio_status === 'Rejected by Head') {
    if (!statusData.password || statusData.password !== HEAD_APPROVAL_PASSWORD) {
      throw new Error('Invalid password');
    }
    if (!statusData.rejection_reason) {
      throw new Error('Rejection reason is required');
    }
    payload.approval_status = 'Rejected by Head';
    payload.head_rejection_reason = statusData.rejection_reason;
    payload.head_rejected_at = new Date().toISOString();
  }

  payload.updated_at = new Date().toISOString();

  // Update studio_calendar row
  await supabaseQuery(`studio_calendar?id=eq.${id}`, 'PATCH', payload);

  // If Head approved, create or reset DM approval record
  if (statusData.studio_status === 'Approved') {
    const existingDm = await supabaseQuery(
      `dm_approvals?content_id=eq.${id}&source_type=eq.studio`
    );

    const dmPayload = {
      content_id: id,
      source_type: 'studio',
      scheduled_live_date: statusData.date || null,
      page_name: statusData.page_name || null,
      drive_link: statusData.content_link || null,  // ADDED: Drive link
      dm_status: 'Pending'
    };

    if (existingDm.length > 0) {
      await supabaseQuery(
        `dm_approvals?id=eq.${existingDm[0].id}`,
        'PATCH',
        dmPayload
      );
    } else {
      await supabaseQuery('dm_approvals', 'POST', dmPayload);
    }
  }

  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
/* STUDIO SLOTS / EXTRA CONTENT (unchanged) */
// ═══════════════════════════════════════════════════════════════

async function generateEmptySlotsForMonth(year, month) {
  try {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    const existingSlots = await supabaseQuery(
      `studio_calendar?date=gte.${startDateStr}&date=lte.${endDateStr}&slot_type=eq.lead_form`
    );
    
    const existingKeys = new Set(
      existingSlots.map(s => `${s.date}_${s.slot_number}`)
    );
    
    const slots = [];
    
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const dayOfWeek = d.getDay();
      const schedule = PAGE_SCHEDULE[dayOfWeek];
      
      if (!schedule) continue;
      
      for (let slotNum = 1; slotNum <= schedule.slots; slotNum++) {
        const slotKey = `${dateStr}_${slotNum}`;
        
        if (!existingKeys.has(slotKey)) {
          slots.push({
            date: dateStr,
            source_type: 'lead_form',
            source_id: null,
            page_name: schedule.page,
            slot_number: slotNum,
            slot_type: 'lead_form',
            booking_status: 'empty',
            studio_status: 'Received',
            format: 'Lead Form Slot',
            content_details: `Empty slot ${slotNum}`,
            reference_links: null,
            product_code: null
          });
        }
      }
    }
    
    if (slots.length > 0) {
      await supabaseQuery('studio_calendar', 'POST', slots);
    }
    
    return { success: true, slotsCreated: slots.length };
  } catch (error) {
    console.error('generateEmptySlotsForMonth error:', error);
    throw error;
  }
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
    department: extra.department,
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
    department: saved.department,
    source_type: 'extra_content',
    source_id: saved.id,
    product_code: null,
    page_name: saved.page_name,
    format: saved.format,
    content_details: saved.content_details,
    reference_links: saved.reference_links,
    slot_type: 'content_calendar',
    booking_status: 'booked'
  });

  return saved;
}

async function updateExtraContent(id, extra) {
  const row = {
    date: extra.date,
    department: extra.department,
    page_name: extra.page_name,
    format: extra.format || '',
    content_details: extra.content_details,
    reference_links: extra.reference_links || ''
  };

  await supabaseQuery(`extra_content?id=eq.${id}`, 'PATCH', row);

  await upsertStudioCalendarEntry({
    date: extra.date,
    department: extra.department,
    source_type: 'extra_content',
    source_id: id,
    product_code: null,
    page_name: extra.page_name,
    format: extra.format,
    content_details: extra.content_details,
    reference_links: extra.reference_links,
    slot_type: 'content_calendar',
    booking_status: 'booked'
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
// PRODUCT SUGGESTION API (UPDATED)
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
// ADMIN DASHBOARD API (UPDATED)
// ═══════════════════════════════════════════════════════════════

function verifyAdminPassword(password) {
  return password === ADMIN_PASSWORD;
}

function verifyHeadPassword(password) {
  return password === HEAD_APPROVAL_PASSWORD;
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
    slotNumber: p.slot_number || '',
    slotDayName: p.slot_day_name || '',
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
    updateData.product_reference = reviewData.productReference || null;
    updateData.slot_date = reviewData.slotDate || null;
    updateData.slot_number = reviewData.slotNumber || null;
    updateData.rejection_reason = '';
    
    if (reviewData.slotDate) {
      const dateObj = new Date(reviewData.slotDate);
      updateData.slot_day_name = getDayName(dateObj.getDay());
    }
  } else {
    updateData.assigned_page = '';
    updateData.product_reference = null;
    updateData.slot_date = null;
    updateData.slot_number = null;
    updateData.slot_day_name = null;
    updateData.rejection_reason = reviewData.rejectionReason || '';
  }

  await supabaseQuery(`product_suggestions?id=eq.${row}`, 'PATCH', updateData);

  if (reviewData.status === 'Approved') {
    const rows = await supabaseQuery(`product_suggestions?id=eq.${row}`);
    if (rows.length) {
      const p = rows[0];

      await upsertStudioCalendarEntry({
        date: reviewData.slotDate || p.slot_date,
        source_type: 'product_suggestion',
        source_id: p.id,
        product_code: p.product_code || null,
        page_name: reviewData.assignedPage || p.assigned_page || null,
        format: 'Lead Form - Product Suggestion',
        content_details: p.promotion_idea || p.product_link,
        reference_links: p.product_link,
        slot_number: reviewData.slotNumber || p.slot_number || null,
        slot_type: 'lead_form',
        booking_status: 'booked'
      });
    }
  }

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
      theme: themeName,
      page_name: bookingData.pageName || null
    };

    const result = await supabaseQuery('content_calendar', 'POST', booking);
    
    await upsertStudioCalendarEntry({
      date: bookingData.date,
      source_type: 'content_calendar',
      source_id: result[0].id,
      product_code: bookingData.productCode,
      page_name: bookingData.pageName || null,
      format: 'Content Calendar - ' + themeName,
      content_details: `${themeName} - ${bookingData.category}`,
      reference_links: bookingData.productLink || '',
      slot_type: 'content_calendar',
      booking_status: 'booked'
    });
    
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

    if (updateData.productCode !== undefined) {
      data.product_code = updateData.productCode;
    }

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
          source_type: 'content_calendar',
          source_id: b.id,
          product_code: b.product_code,
          page_name: b.page_name || null,
          format: 'Content Calendar',
          content_details: `${b.theme || ''} - ${b.category || ''}`.trim(),
          reference_links: b.product_link || '',
          slot_type: 'content_calendar',
          booking_status: 'booked'
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
    return { success: true, productId: result[0].id };
  } catch (error) {
    console.error('addHotProduct error:', error);
    throw error;
  }
}

async function deleteHotProduct(id) {
  try {
    await supabaseQuery(`hot_products?id=eq.${id}`, 'DELETE');
    return { success: true };
  } catch (error) {
    console.error('deleteHotProduct error:', error);
    throw error;
  }
}

// HOT PRODUCTS UPDATE
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
    } else {
      const campaignMatches = results.filter(r => 
        r.campaign_name && r.campaign_name.toLowerCase().includes(keywordLower)
      );

      if (campaignMatches.length > 0) {
        aggregationLevel = 'campaign';
        dataToAggregate = campaignMatches;
        groupBy = 'campaign_name';
      } else {
        const adsetMatches = results.filter(r => 
          r.adset_name && r.adset_name.toLowerCase().includes(keywordLower)
        );

        if (adsetMatches.length > 0) {
          aggregationLevel = 'adset';
          dataToAggregate = adsetMatches;
          groupBy = 'adset_name';
        } else {
          const adMatches = results.filter(r => 
            r.ad_name && r.ad_name.toLowerCase().includes(keywordLower)
          );
          if (adMatches.length > 0) {
            dataToAggregate = adMatches;
            groupBy = 'ad_name';
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
          campaign_name: row.campaign_name || 'NA',
          adset_name: row.adset_name || 'NA',
          ad_name: row.ad_name || 'NA',
          objective: row.objective || 'NA',
          amount_spent: 0,
          reach: 0,
          impression: 0,
          clicks: 0,
          results: 0,
          direct_orders: 0,
          dates: [],
          ad_account_id: row.ad_account_id || 'NA'
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
      const dateRange = sortedDates.length > 0 ? `${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}` : 'NA';

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
