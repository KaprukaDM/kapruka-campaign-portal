// ============================================================
// SUPABASE API CLIENT - KAPRUKA CAMPAIGN PORTAL
// ============================================================

// UPDATED GLOBAL VARIABLES - These are accessible from other scripts
window.SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
window.SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';

// Also create non-window versions for backward compatibility
const SUPABASE_URL = window.SUPABASE_URL;
const SUPABASE_KEY = window.SUPABASE_KEY;

const ADMIN_PASSWORD = 'Kapruka2026!Admin';
const HEAD_APPROVAL_PASSWORD = '207';
const SUPER_ADMIN_PASSWORD = 'Superadmin'; // Change this!

function verifySuperAdminPassword(password) {
  return password === SUPER_ADMIN_PASSWORD;
}

const VALID_STATUSES = ['Request Submitted', 'Working', 'Live', 'Completed', 'Rejected'];
const STUDIO_STATUSES = ['Received', 'Working', 'Submitted for Review', 'Approved'];

// Page assignments by day of week
const PAGE_SCHEDULE = {
  0: { page: 'TikTok Video', slots: 1 },  // Sunday
  1: { page: 'Kapruka FB', slots: 3 },    // Monday
  2: { page: 'Electronic Factory', slots: 3 }, // Tuesday
  3: { page: 'Social Mart', slots: 3 },   // Wednesday
  4: { page: 'Fashion Factory', slots: 3 }, // Thursday
  5: { page: 'Toys Factory', slots: 3 },  // Friday
  6: { page: 'Handbag Factory', slots: 3 } // Saturday
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

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

// ============================================================
// SLOT AVAILABILITY FUNCTIONS - UPDATED
// ============================================================

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
    
    if (dayOfWeek === null) throw new Error('Invalid page name');
    
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
      `productsuggestions?assignedpage=eq.${encodeURIComponent(pageName)}&status=eq.Approved&slotdate=gte.${todayStr}`
    );
    
    // Get booked slots from studio_calendar (includes manual bookings)
    const bookedFromStudio = await supabaseQuery(
      `studiocalendar?pagename=eq.${encodeURIComponent(pageName)}&bookingstatus=eq.booked&date=gte.${todayStr}`
    );
    
    // Build availability map
    const slots = [];
    for (const date of availableDates) {
      for (let slotNum = 1; slotNum <= slotsPerDay; slotNum++) {
        const isBookedInProducts = bookedFromProducts.some(s => s.slotdate === date && s.slotnumber === slotNum);
        const isBookedInStudio = bookedFromStudio.some(s => s.date === date && s.slotnumber === slotNum);
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
      `productsuggestions?slotdate=eq.${slotDate}&slotnumber=eq.${slotNumber}&assignedpage=eq.${encodeURIComponent(pageName)}&status=eq.Approved`
    );
    
    if (existing.length > 0) {
      throw new Error('This slot is already booked');
    }
    
    const dateObj = new Date(slotDate);
    const dayName = getDayName(dateObj.getDay());
    
    await supabaseQuery(`productsuggestions?id=eq.${productId}`, 'PATCH', {
      slotdate: slotDate,
      slotnumber: slotNumber,
      slotdayname: dayName
    });
    
    return { success: true };
  } catch (error) {
    console.error('bookProductSlot error:', error);
    throw error;
  }
}

// ============================================================
// STUDIO CALENDAR CORE - UPDATED
// ============================================================

async function upsertStudioCalendarEntry(entry) {
  const payload = {
    date: entry.date,
    department: entry.department || null,
    sourcetype: entry.sourcetype,
    sourceid: entry.sourceid || null,
    productcode: entry.productcode || null,
    pagename: entry.pagename || null,
    format: entry.format || null,
    contentdetails: entry.contentdetails || '',
    reference_links: entry.referencelinks || '',  // ✅ FIXED: Changed to reference_links
    slotnumber: entry.slotnumber || null,
    slottype: entry.slottype || 'contentcalendar',
    bookingstatus: entry.bookingstatus || 'booked',
    studiostatus: 'Received',
    approvalstatus: 'Received'
  };
  
  if (entry.sourceid) {
    const existing = await supabaseQuery(
      `studiocalendar?sourcetype=eq.${encodeURIComponent(entry.sourcetype)}&sourceid=eq.${entry.sourceid}`
    );
    
    if (existing.length > 0) {
      const id = existing[0].id;
      await supabaseQuery(`studiocalendar?id=eq.${id}`, 'PATCH', payload);
      return id;
    }
  }
  
  const result = await supabaseQuery('studiocalendar', 'POST', payload);
  return result[0].id;
}

async function getStudioCalendarForMonth(year, month) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
  
  return await supabaseQuery(
    `studiocalendar?date=gte.${startDate}&date=lte.${endDate}&order=date.asc,slotnumber.asc`
  );
}

async function getStudioCalendarForDate(date) {
  return await supabaseQuery(
    `studiocalendar?date=eq.${date}&order=slottype.asc,slotnumber.asc,created_at.asc`
  );
}

async function getStudioCalendarItem(id) {
  const rows = await supabaseQuery(`studiocalendar?id=eq.${id}`);
  return rows.length ? rows[0] : null;
}

// ============================================================
// DM APPROVAL HELPERS
// ============================================================

async function getDmApprovals() {
  return await supabaseQuery('dmapprovals?order=created_at.desc');
}

// UPDATED DM APPROVAL UPDATE - NOW SYNCS WITH STUDIO_CALENDAR
async function updateDmApproval(id, data) {
  const payload = {
    dmstatus: data.dmstatus,
    updatedat: new Date().toISOString()
  };
  
  if (data.dmstatus === 'Approved') {
    payload.approvedat = new Date().toISOString();
    payload.dmapprovedby = `${data.approvedby} (DM)`;
    
    // Update studio_calendar
    const dmRecord = await supabaseQuery(`dmapprovals?id=eq.${id}`);
    if (dmRecord.length > 0) {
      await supabaseQuery(`studiocalendar?id=eq.${dmRecord[0].contentid}`, 'PATCH', {
        approvalstatus: 'Approved by DM',
        dmapprovedat: new Date().toISOString(),
        dmapprovedby: `${data.approvedby} (DM)`
      });
    }
  } else if (data.dmstatus === 'Rejected') {
    payload.dmrejectionreason = data.rejectionreason;
    
    // Update studio_calendar
    const dmRecord = await supabaseQuery(`dmapprovals?id=eq.${id}`);
    if (dmRecord.length > 0) {
      await supabaseQuery(`studiocalendar?id=eq.${dmRecord[0].contentid}`, 'PATCH', {
        approvalstatus: 'Rejected by DM',
        dmrejectionreason: data.rejectionreason
      });
    }
  }
  
  await supabaseQuery(`dmapprovals?id=eq.${id}`, 'PATCH', payload);
  return { success: true };
}

// ============================================================
// STUDIO STATUS UPDATE WITH HEAD REJECTION & RESUBMISSION
// ============================================================

async function updateStudioStatus(id, statusData) {
  const payload = {
    studiostatus: statusData.studiostatus
  };
  
  if (statusData.assignedto !== undefined) {
    payload.assignedto = statusData.assignedto;
  }
  
  // Map studio_status → approval_status for filters
  if (statusData.studiostatus === 'Approved') {
    payload.approvalstatus = 'Approved by Head';
  } else if (statusData.studiostatus === 'Submitted for Review') {
    // Check if this is a resubmission
    const current = await supabaseQuery(`studiocalendar?id=eq.${id}`);
    if (current.length && (current[0].approvalstatus === 'Rejected by Head' || current[0].approvalstatus === 'Rejected by DM')) {
      payload.approvalstatus = 'Resubmitted for Review';
    } else {
      payload.approvalstatus = 'Submitted for Review';
    }
  } else if (statusData.studiostatus === 'Working') {
    payload.approvalstatus = 'Working';
  } else if (statusData.studiostatus === 'Received') {
    payload.approvalstatus = 'Received';
  }
  
  // If submitting for review, require content link
  if (statusData.studiostatus === 'Submitted for Review') {
    if (!statusData.contentlink) {
      throw new Error('Content link is required for submission');
    }
    payload.contentlink = statusData.contentlink;
  }
  
  // If approving (Head), require password
  if (statusData.studiostatus === 'Approved') {
    if (!statusData.password || statusData.password !== HEAD_APPROVAL_PASSWORD) {
      throw new Error('Invalid approval password');
    }
    payload.headapproved = true;
    payload.headapprovedat = new Date().toISOString();
    payload.approvedby = `${statusData.approvedby} (Content Head)`;
    payload.contentlink = statusData.contentlink || null; // ADDED
  }
  
  // If rejecting (Head), require password and reason
  if (statusData.studiostatus === 'Rejected by Head') {
    if (!statusData.password || statusData.password !== HEAD_APPROVAL_PASSWORD) {
      throw new Error('Invalid password');
    }
    if (!statusData.rejectionreason) {
      throw new Error('Rejection reason is required');
    }
    payload.approvalstatus = 'Rejected by Head';
    payload.headrejectionreason = statusData.rejectionreason;
    payload.headrejectedat = new Date().toISOString();
  }
  
  payload.updatedat = new Date().toISOString();
  
  // Update studio_calendar row
  await supabaseQuery(`studiocalendar?id=eq.${id}`, 'PATCH', payload);
  
  // If Head approved, create or reset DM approval record
  if (statusData.studiostatus === 'Approved') {
    const existingDm = await supabaseQuery(`dmapprovals?contentid=eq.${id}&sourcetype=eq.studio`);
    
    const dmPayload = {
      contentid: id,
      sourcetype: 'studio',
      scheduledlivedate: statusData.date || null,
      pagename: statusData.pagename || null,
      drivelink: statusData.contentlink || null, // ADDED Drive link
      dmstatus: 'Pending'
    };
    
    if (existingDm.length > 0) {
      await supabaseQuery(`dmapprovals?id=eq.${existingDm[0].id}`, 'PATCH', dmPayload);
    } else {
      await supabaseQuery('dmapprovals', 'POST', dmPayload);
    }
  }
  
  return { success: true };
}

// ============================================================
// STUDIO SLOTS & EXTRA CONTENT
// ============================================================

async function generateEmptySlotsForMonth(year, month) {
  try {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    const existingSlots = await supabaseQuery(
      `studiocalendar?date=gte.${startDateStr}&date=lte.${endDateStr}&slottype=eq.leadform`
    );
    
    const existingKeys = new Set(existingSlots.map(s => `${s.date}-${s.slotnumber}`));
    
    const slots = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const dayOfWeek = d.getDay();
      const schedule = PAGE_SCHEDULE[dayOfWeek];
      
      if (!schedule) continue;
      
      for (let slotNum = 1; slotNum <= schedule.slots; slotNum++) {
        const slotKey = `${dateStr}-${slotNum}`;
        if (!existingKeys.has(slotKey)) {
          slots.push({
            date: dateStr,
            sourcetype: 'leadform',
            sourceid: null,
            pagename: schedule.page,
            slotnumber: slotNum,
            slottype: 'leadform',
            bookingstatus: 'empty',
            studiostatus: 'Received',
            format: 'Lead Form Slot',
            contentdetails: `Empty slot ${slotNum}`,
            reference_links: null,  // ✅ FIXED: Changed to reference_links
            productcode: null
          });
        }
      }
    }
    
    if (slots.length > 0) {
      await supabaseQuery('studiocalendar', 'POST', slots);
    }
    
    return { success: true, slotsCreated: slots.length };
  } catch (error) {
    console.error('generateEmptySlotsForMonth error:', error);
    throw error;
  }
}

async function updateStudioCompletion(id, data) {
  const payload = {
    completionstatus: data.completionstatus,
    contentlink: data.contentlink || null
  };
  
  await supabaseQuery(`studiocalendar?id=eq.${id}`, 'PATCH', payload);
  return { success: true };
}

async function addExtraContent(extra) {
  const row = {
    date: extra.date,
    department: extra.department,
    pagename: extra.pagename,
    format: extra.format || '',
    contentdetails: extra.contentdetails,
    referencelinks: extra.referencelinks || '',
    createdby: extra.createdby
  };
  
  const result = await supabaseQuery('extracontent', 'POST', row);
  const saved = result[0];
  
  await upsertStudioCalendarEntry({
    date: saved.date,
    department: saved.department,
    sourcetype: 'extracontent',
    sourceid: saved.id,
    productcode: null,
    pagename: saved.pagename,
    format: saved.format,
    contentdetails: saved.contentdetails,
    referencelinks: saved.referencelinks,
    slottype: 'contentcalendar',
    bookingstatus: 'booked'
  });
  
  return saved;
}

async function updateExtraContent(id, extra) {
  const row = {
    date: extra.date,
    department: extra.department,
    pagename: extra.pagename,
    format: extra.format || '',
    contentdetails: extra.contentdetails,
    referencelinks: extra.referencelinks || ''
  };
  
  await supabaseQuery(`extracontent?id=eq.${id}`, 'PATCH', row);
  
  await upsertStudioCalendarEntry({
    date: extra.date,
    department: extra.department,
    sourcetype: 'extracontent',
    sourceid: id,
    productcode: null,
    pagename: extra.pagename,
    format: extra.format,
    contentdetails: extra.contentdetails,
    referencelinks: extra.referencelinks,
    slottype: 'contentcalendar',
    bookingstatus: 'booked'
  });
  
  return { success: true };
}

async function deleteExtraContent(id) {
  await supabaseQuery(`extracontent?id=eq.${id}`, 'DELETE');
  await supabaseQuery(`studiocalendar?sourcetype=eq.extracontent&sourceid=eq.${id}`, 'DELETE');
  return { success: true };
}

async function getExtraContentForMonth(year, month) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
  
  return await supabaseQuery(`extracontent?date=gte.${startDate}&date=lte.${endDate}&order=date.asc`);
}

// ============================================================
// CAMPAIGN BOOKING API
// ============================================================

async function getInitialData() {
  const configs = await supabaseQuery('departmentconfig?active=eq.Yes&select=month');
  const months = [...new Set(configs.map(c => c.month))];
  const currentMonth = getCurrentMonth();
  
  return {
    months: months.length > 0 ? months : [currentMonth],
    currentMonth: months.includes(currentMonth) ? currentMonth : months[0] || currentMonth
  };
}

async function getSlotsForMonth(month) {
  const configs = await supabaseQuery(`departmentconfig?month=eq.${encodeURIComponent(month)}&active=eq.Yes`);
  if (configs.length === 0) return [];
  
  const requests = await supabaseQuery(`requestlog?month=eq.${encodeURIComponent(month)}`);
  
  return configs.map(dept => {
    const slots = [];
    const bookedSlots = {};
    
    requests.forEach(req => {
      if (req.department === dept.department && req.status && req.status !== 'Rejected') {
        bookedSlots[req.slot] = {
          requestId: req.requestid,
          campaign: req.campaign || 'N/A',
          status: req.status,
          requestor: req.name,
          startDate: req.startdate || 'N/A',
          endDate: req.enddate || 'N/A'
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
    `requestlog?department=eq.${encodeURIComponent(formData.department)}&month=eq.${encodeURIComponent(formData.month)}&slot=eq.${encodeURIComponent(formData.slot)}`
  );
  
  const alreadyBooked = existing.some(req => req.status && req.status !== 'Rejected' && req.status !== 'Completed');
  
  if (alreadyBooked) {
    throw new Error('This slot is already booked');
  }
  
  const requestData = {
    requestid: generateId('REQ'),
    email: 'user@kapruka.lk',
    name: formData.name || 'User',
    department: formData.department,
    month: formData.month,
    slot: formData.slot,
    campaign: formData.campaign,
    duration: formData.duration,
    startdate: formData.startDate,
    enddate: formData.endDate,
    status: 'Request Submitted'
  };
  
  const result = await supabaseQuery('requestlog', 'POST', requestData);
  return { success: true, requestId: result[0].requestid };
}

// ============================================================
// PRODUCT SUGGESTION API - UPDATED
// ============================================================

async function getActiveWindow() {
  const windows = await supabaseQuery('submissionwindows?status=eq.Active&order=created_at.desc&limit=1');
  
  if (windows.length === 0) {
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 3);
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 4);
    
    const newWindow = {
      windowid: generateId('WIN'),
      startdate: startDate.toISOString().split('T')[0],
      enddate: endDate.toISOString().split('T')[0],
      targetsuggestions: 30,
      status: 'Active'
    };
    
    const result = await supabaseQuery('submissionwindows', 'POST', newWindow);
    return result[0];
  }
  
  return windows[0];
}

async function getProductDashboard() {
  try {
    const window = await getActiveWindow();
    if (!window) return { window: null, target: 30, actual: 0, picked: 0, categories: [], rejections: [] };
    
    const products = await supabaseQuery(
      `productsuggestions?timestamp=gte.${window.startdate}T00:00:00&timestamp=lte.${window.enddate}T23:59:59`
    );
    
    const categoryCount = {};
    const rejections = [];
    let picked = 0;
    
    products.forEach(p => {
      categoryCount[p.category] = (categoryCount[p.category] || 0) + 1;
      if (p.status === 'Approved') picked++;
      if (p.status === 'Rejected') {
        rejections.push({
          productName: p.productlink.split('/').pop().replace(/-/g, ' ').substring(0, 40),
          reason: p.rejectionreason || 'Not specified'
        });
      }
    });
    
    const categories = Object.keys(categoryCount).map(cat => ({
      category: cat,
      count: categoryCount[cat]
    })).sort((a, b) => b.count - a.count);
    
    return {
      window: window,
      target: window.targetsuggestions,
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
  if (!window) throw new Error('No active submission window');
  
  const submissionData = {
    submissionid: generateId('SUB'),
    email: 'user@kapruka.lk',
    name: formData.name || 'User',
    productlink: formData.productLink,
    producttype: formData.productType || '',
    category: formData.category,
    margin: parseFloat(formData.margin),
    promotionidea: formData.promotionIdea || '',
    availableqty: parseInt(formData.availableQty),
    status: 'Pending'
  };
  
  const result = await supabaseQuery('productsuggestions', 'POST', submissionData);
  return { success: true, submissionId: result[0].submissionid };
}

async function searchProductSuggestions(query) {
  const products = await supabaseQuery('productsuggestions?order=timestamp.desc');
  const searchLower = query.toLowerCase();
  
  return products.filter(p =>
    p.productlink.toLowerCase().includes(searchLower) ||
    p.category.toLowerCase().includes(searchLower) ||
    p.submissionid.toLowerCase().includes(searchLower)
  ).slice(0, 20);
}
// ============================================================
// ADMIN DASHBOARD API - UPDATED
// ============================================================

function verifyAdminPassword(password) {
  return password === ADMIN_PASSWORD;
}

function verifyHeadPassword(password) {
  return password === HEAD_APPROVAL_PASSWORD;
}

async function getAllRequests() {
  const requests = await supabaseQuery('requestlog?order=timestamp.desc');
  return requests.map(r => ({
    row: r.id,
    requestId: r.requestid,
    timestamp: r.timestamp,
    email: r.email,
    name: r.name,
    department: r.department,
    month: r.month,
    slot: r.slot,
    campaign: r.campaign,
    duration: r.duration,
    startDate: r.startdate,
    endDate: r.enddate,
    status: r.status,
    reviewer: r.reviewer || '',
    updated: r.updatedat,
    comments: r.comments
  }));
}

async function updateRequestStatus(row, status, reviewer, comments) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status "${status}". Valid statuses are: ${VALID_STATUSES.join(', ')}`);
  }
  
  const updateData = {
    status,
    reviewer,
    updatedat: new Date().toISOString(),
    comments
  };
  
  if (status === 'Completed') {
    updateData.completedat = new Date().toISOString();
  }
  
  await supabaseQuery(`requestlog?id=eq.${row}`, 'PATCH', updateData);
  return { success: true };
}

async function getAllProductSuggestions() {
  const products = await supabaseQuery('productsuggestions?order=timestamp.desc');
  return products.map(p => ({
    row: p.id,
    submissionId: p.submissionid,
    timestamp: p.timestamp,
    email: p.email,
    name: p.name,
    productLink: p.productlink,
    productType: p.producttype,
    category: p.category,
    margin: p.margin,
    promotionIdea: p.promotionidea,
    availableQty: p.availableqty,
    status: p.status,
    assignedPage: p.assignedpage || '',
    goLiveDate: p.golivedate || '',
    slotDate: p.slotdate || '',
    slotNumber: p.slotnumber || '',
    slotDayName: p.slotdayname || '',
    reviewerName: p.reviewername || '',
    rejectionReason: p.rejectionreason
  }));
}

async function updateProductReview(row, reviewData) {
  const updateData = {
    status: reviewData.status,
    reviewername: reviewData.reviewerName
  };
  
  if (reviewData.status === 'Approved') {
    updateData.assignedpage = reviewData.assignedPage;
    updateData.productreference = reviewData.productReference || null;
    updateData.slotdate = reviewData.slotDate || null;
    updateData.slotnumber = reviewData.slotNumber || null;
    updateData.rejectionreason = '';
    
    if (reviewData.slotDate) {
      const dateObj = new Date(reviewData.slotDate);
      updateData.slotdayname = getDayName(dateObj.getDay());
    }
  } else {
    updateData.assignedpage = '';
    updateData.productreference = null;
    updateData.slotdate = null;
    updateData.slotnumber = null;
    updateData.slotdayname = null;
    updateData.rejectionreason = reviewData.rejectionReason;
  }
  
  await supabaseQuery(`productsuggestions?id=eq.${row}`, 'PATCH', updateData);
  
  // ✅ FIXED: Sync to studio_calendar when approved
  if (reviewData.status === 'Approved') {
    const rows = await supabaseQuery(`productsuggestions?id=eq.${row}`);
    if (rows.length) {
      const p = rows[0];
      
      // Create the productsuggestion entry
      await upsertStudioCalendarEntry({
        date: reviewData.slotDate || p.slotdate,
        sourcetype: 'productsuggestion',
        sourceid: p.id,
        productcode: p.productcode || null,
        pagename: reviewData.assignedPage || p.assignedpage || null,
        format: 'Lead Form - Product Suggestion',
        contentdetails: p.promotionidea || p.productlink,
        referencelinks: p.productreference || p.productlink,  // ✅ FIXED: Uses productreference first
        slotnumber: reviewData.slotNumber || p.slotnumber || null,
        slottype: 'leadform',
        bookingstatus: 'booked'
      });
      
      // ✅ FIXED: Delete the empty leadform slot to prevent duplicates
      const slotDate = reviewData.slotDate || p.slotdate;
      const slotNumber = reviewData.slotNumber || p.slotnumber;
      const pageName = reviewData.assignedPage || p.assignedpage;
      
      if (slotDate && slotNumber && pageName) {
        await supabaseQuery(
          `studiocalendar?date=eq.${slotDate}&slotnumber=eq.${slotNumber}&pagename=eq.${encodeURIComponent(pageName)}&sourcetype=eq.leadform&bookingstatus=eq.empty`,
          'DELETE'
        );
      }
    }
  }
  
  return { success: true };
}

async function getAllDepartments() {
  const configs = await supabaseQuery('departmentconfig?order=id.asc');
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
  await supabaseQuery('departmentconfig', 'POST', {
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
  await supabaseQuery(`departmentconfig?id=eq.${row}`, 'DELETE');
  return { success: true };
}

// ============================================================
// CONTENT CALENDAR API
// ============================================================

const CATEGORIES = [
  'Cakes', 'Flowers', 'Chocolates', 'Clothing', 'Electronics', 'Fashion',
  'Food & Restaurants', 'Fruits', 'Soft Toys & Kids Toys', 'Grocery & Hampers',
  'Greeting Cards & Party Supplies', 'Sports and Bicycles', 'Mother and Baby',
  'Jewellery and Watches', 'Cosmetics & Perfumes', 'Customized Gifts',
  'Health and Wellness', 'Home & Lifestyle', 'Combo and Gift Sets', 'Books & Stationery'
];

async function getCalendarData(month, year) {
  try {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    
    const themes = await supabaseQuery(
      `themeconfig?startdate=lte.${endDate}&enddate=gte.${startDate}`
    );
    
    const monthYear = `${year}-${String(month).padStart(2, '0')}`;
    const categorySlots = await supabaseQuery(`categoryslots?monthyear=eq.${monthYear}`);
    
    const bookings = await supabaseQuery(
      `contentcalendar?date=gte.${startDate}&date=lte.${endDate}`
    );
    
    return { themes, categorySlots, bookings };
  } catch (error) {
    console.error('getCalendarData error:', error);
    return { themes: [], categorySlots: [], bookings: [] };
  }
}

async function getThemeForDate(date) {
  try {
    const themes = await supabaseQuery(
      `themeconfig?startdate=lte.${date}&enddate=gte.${date}`
    );
    return themes.length > 0 ? themes[0] : null;
  } catch (error) {
    console.error('getThemeForDate error:', error);
    return null;
  }
}

async function getCategorySlotsForDate(date) {
  try {
    const slots = await supabaseQuery(`categoryslots?date=eq.${date}&order=slotnumber.asc`);
    return slots;
  } catch (error) {
    console.error('getCategorySlotsForDate error:', error);
    return [];
  }
}

async function submitContentBooking(bookingData) {
  try {
    const existing = await supabaseQuery(
      `contentcalendar?date=eq.${bookingData.date}&slotnumber=eq.${bookingData.slotNumber}`
    );
    
    const alreadyBooked = existing.some(b => b.status === 'Pending' || b.status === 'Approved');
    
    if (alreadyBooked) {
      throw new Error('This slot is already booked');
    }
    
    const themes = await supabaseQuery(
      `themeconfig?startdate=lte.${bookingData.date}&enddate=gte.${bookingData.date}`
    );
    const themeName = themes.length > 0 ? themes[0].themename : 'Daily Post';
    
    const booking = {
      date: bookingData.date,
      slotnumber: parseInt(bookingData.slotNumber),
      category: bookingData.category,
      productcode: bookingData.productCode,
      productlink: bookingData.productLink || '',
      status: 'Pending',
      submittedby: bookingData.submittedBy || 'User',
      theme: themeName,
      pagename: bookingData.pageName || null
    };
    
    const result = await supabaseQuery('contentcalendar', 'POST', booking);
    
    await upsertStudioCalendarEntry({
      date: bookingData.date,
      sourcetype: 'contentcalendar',
      sourceid: result[0].id,
      productcode: bookingData.productCode,
      pagename: bookingData.pageName || null,
      format: `Content Calendar - ${themeName}`,
      contentdetails: `${themeName} - ${bookingData.category}`,
      referencelinks: bookingData.productLink || '',
      slottype: 'contentcalendar',
      bookingstatus: 'booked'
    });
    
    return { success: true, bookingId: result[0].id };
  } catch (error) {
    console.error('submitContentBooking error:', error);
    throw error;
  }
}

async function getAllContentBookings() {
  try {
    const bookings = await supabaseQuery('contentcalendar?order=date.desc,slotnumber.asc');
    return bookings.map(b => ({
      id: b.id,
      date: b.date,
      slotNumber: b.slotnumber,
      category: b.category,
      productCode: b.productcode,
      productLink: b.productlink,
      status: b.status,
      submittedBy: b.submittedby,
      theme: b.theme,
      pageName: b.pagename,
      scheduleDate: b.scheduledate,
      goLiveDate: b.golivedate,
      reviewer: b.reviewer,
      rejectionReason: b.rejectionreason,
      createdAt: b.createdat
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
      updatedat: new Date().toISOString()
    };
    
    if (updateData.productCode !== undefined) {
      data.productcode = updateData.productCode;
    }
    
    if (updateData.status === 'Approved') {
      data.golivedate = updateData.goLiveDate || null;
    } else if (updateData.status === 'Rejected') {
      data.rejectionreason = updateData.rejectionReason;
    }
    
    await supabaseQuery(`contentcalendar?id=eq.${id}`, 'PATCH', data);
    
    if (updateData.status === 'Approved') {
      const rows = await supabaseQuery(`contentcalendar?id=eq.${id}`);
      if (rows.length) {
        const b = rows[0];
        await upsertStudioCalendarEntry({
          date: updateData.goLiveDate || b.date,
          sourcetype: 'contentcalendar',
          sourceid: b.id,
          productcode: b.productcode,
          pagename: b.pagename || null,
          format: 'Content Calendar',
          contentdetails: `${b.theme} - ${b.category}`.trim(),
          referencelinks: b.productlink || '',
          slottype: 'contentcalendar',
          bookingstatus: 'booked'
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
    const themes = await supabaseQuery('themeconfig?order=startdate.desc');
    return themes;
  } catch (error) {
    console.error('getAllThemes error:', error);
    return [];
  }
}

async function addTheme(themeData) {
  try {
    const theme = {
      themename: themeData.themeName,
      startdate: themeData.startDate,
      enddate: themeData.endDate,
      slotsperday: parseInt(themeData.slotsPerDay),
      themecolor: themeData.themeColor || '#422B73',
      isseasonal: themeData.isSeasonal || false
    };
    
    const result = await supabaseQuery('themeconfig', 'POST', theme);
    
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
    
    const categoriesToUse = isSeasonal ? ['Any Category'] : [...CATEGORIES].sort(() => Math.random() - 0.5);
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
          slotnumber: slotNum,
          category: categoriesToUse[categoryIndex % categoriesToUse.length],
          weeknumber: weekNumber,
          monthyear: monthYear
        });
        categoryIndex++;
      }
      
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    if (slots.length > 0) {
      await supabaseQuery('categoryslots', 'POST', slots);
    }
    
    return { success: true, slotsCreated: slots.length };
  } catch (error) {
    console.error('generateCategorySlots error:', error);
    throw error;
  }
}

async function deleteTheme(themeId) {
  try {
    const themes = await supabaseQuery(`themeconfig?id=eq.${themeId}`);
    if (themes.length === 0) throw new Error('Theme not found');
    
    const theme = themes[0];
    
    const slots = await supabaseQuery(
      `categoryslots?date=gte.${theme.startdate}&date=lte.${theme.enddate}`
    );
    
    if (slots.length > 0) {
      await supabaseQuery(
        `categoryslots?date=gte.${theme.startdate}&date=lte.${theme.enddate}`,
        'DELETE'
      );
    }
    
    await supabaseQuery(`themeconfig?id=eq.${themeId}`, 'DELETE');
    
    return { success: true, slotsDeleted: slots.length };
  } catch (error) {
    console.error('deleteTheme error:', error);
    throw error;
  }
}

async function refreshCategorySlotsForMonth(month, year) {
  try {
    const monthYear = `${year}-${String(month).padStart(2, '0')}`;
    await supabaseQuery(`categoryslots?monthyear=eq.${monthYear}`, 'DELETE');
    
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    
    const themes = await supabaseQuery(
      `themeconfig?startdate=lte.${endDate}&enddate=gte.${startDate}`
    );
    
    for (const theme of themes) {
      const themeStart = theme.startdate > startDate ? theme.startdate : startDate;
      const themeEnd = theme.enddate < endDate ? theme.enddate : endDate;
      
      await generateCategorySlots(themeStart, themeEnd, theme.slotsperday, theme.isseasonal);
    }
    
    return { success: true };
  } catch (error) {
    throw error;
  }
}

// ============================================================
// HOT PRODUCTS API
// ============================================================

async function getHotProductsByCategory(category) {
  try {
    const products = await supabaseQuery(
      `hotproducts?category=eq.${encodeURIComponent(category)}&order=created_at.desc`
    );
    return products;
  } catch (error) {
    console.error('getHotProductsByCategory error:', error);
    throw error;
  }
}

async function getAllHotProducts() {
  try {
    const products = await supabaseQuery('hotproducts?order=created_at.desc');
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
      productlink: productData.productLink,
      salescount: parseInt(productData.salesCount) || 0,
      listed: false,
      kaprukalink: null
    };
    
    const result = await supabaseQuery('hotproducts', 'POST', data);
    return { success: true, productId: result[0].id };
  } catch (error) {
    console.error('addHotProduct error:', error);
    throw error;
  }
}

async function deleteHotProduct(id) {
  try {
    await supabaseQuery(`hotproducts?id=eq.${id}`, 'DELETE');
    return { success: true };
  } catch (error) {
    console.error('deleteHotProduct error:', error);
    throw error;
  }
}

async function updateHotProduct(productId, updateData) {
  try {
    const data = {};
    
    if (updateData.listed !== undefined) {
      data.listed = updateData.listed;
    }
    if (updateData.kaprukaLink !== undefined) {
      data.kaprukalink = updateData.kaprukaLink || null;
    }
    if (updateData.salesCount !== undefined) {
      data.salescount = parseInt(updateData.salesCount) || 0;
    }
    
    await supabaseQuery(`hotproducts?id=eq.${productId}`, 'PATCH', data);
    return { success: true };
  } catch (error) {
    console.error('updateHotProduct error:', error);
    throw error;
  }
}

// ============================================================
// PRODUCT PERFORMANCE API
// ============================================================

async function searchProductPerformance(keyword, startDate, endDate) {
  try {
    let url = `${SUPABASE_URL}/rest/v1/metaadsperformance?`;
    if (startDate && endDate) {
      url += `date=gte.${startDate}&date=lte.${endDate}&`;
    }
    url += 'order=date.desc';
    
    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    
    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    
    const allData = await response.json();
    const keywordLower = keyword.toLowerCase();
    
    const results = allData.filter(row =>
      (row.campaignname && row.campaignname.toLowerCase().includes(keywordLower)) ||
      (row.adsetname && row.adsetname.toLowerCase().includes(keywordLower)) ||
      (row.adname && row.adname.toLowerCase().includes(keywordLower))
    );
    
    if (results.length === 0) {
      return { level: 'none', data: [], aggregated: [] };
    }
    
    const uniqueAccounts = [...new Set(results.map(r => r.adaccountid))].filter(Boolean);
    
    let aggregationLevel = 'ad';
    let dataToAggregate = results;
    let groupBy = 'adname';
    
    if (uniqueAccounts.length === 1) {
      aggregationLevel = 'account';
      groupBy = 'adaccountid';
    } else {
      const campaignMatches = results.filter(r => r.campaignname && r.campaignname.toLowerCase().includes(keywordLower));
      if (campaignMatches.length > 0) {
        aggregationLevel = 'campaign';
        dataToAggregate = campaignMatches;
        groupBy = 'campaignname';
      } else {
        const adsetMatches = results.filter(r => r.adsetname && r.adsetname.toLowerCase().includes(keywordLower));
        if (adsetMatches.length > 0) {
          aggregationLevel = 'adset';
          dataToAggregate = adsetMatches;
          groupBy = 'adsetname';
        } else {
          const adMatches = results.filter(r => r.adname && r.adname.toLowerCase().includes(keywordLower));
          if (adMatches.length > 0) {
            dataToAggregate = adMatches;
            groupBy = 'adname';
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
          campaignname: row.campaignname || 'N/A',
          adsetname: row.adsetname || 'N/A',
          adname: row.adname || 'N/A',
          objective: row.objective || 'N/A',
          amountspent: 0,
          reach: 0,
          impression: 0,
          clicks: 0,
          results: 0,
          directorders: 0,
          dates: [],
          adaccountid: row.adaccountid || 'N/A'
        };
      }
      grouped[key].amountspent += parseFloat(row.amountspent) || 0;
      grouped[key].reach += parseInt(row.reach) || 0;
      grouped[key].impression += parseInt(row.impression) || 0;
      grouped[key].clicks += parseInt(row.clicks) || 0;
      grouped[key].results += parseInt(row.results) || 0;
      grouped[key].directorders += parseInt(row.ifdirectorders) || 0;
      grouped[key].dates.push(row.date);
    });
    
    const aggregated = Object.values(grouped).map(item => {
      const cpc = item.clicks > 0 ? (item.amountspent / item.clicks).toFixed(2) : '0';
      const cpm = item.impression > 0 ? ((item.amountspent / item.impression) * 1000).toFixed(2) : '0';
      const ctr = item.impression > 0 ? ((item.clicks / item.impression) * 100).toFixed(2) : '0';
      const conversionRate = item.clicks > 0 ? ((item.directorders / item.clicks) * 100).toFixed(2) : '0';
      const sortedDates = item.dates.sort();
      const dateRange = sortedDates.length > 0 ? `${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}` : 'N/A';
      
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
    
    return { level: aggregationLevel, data: results, aggregated: aggregated, totalRecords: results.length };
  } catch (error) {
    console.error('searchProductPerformance error:', error);
    throw error;
  }
}

console.log('✅ Supabase API loaded successfully with global variables');

// ============================================================
// EXPERIMENT CAMPAIGNS API
// ============================================================

// Get experiment campaigns with date filtering
async function getExperimentCampaigns(startDate, endDate) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/experimentcampaigns?date=gte.${startDate}&date=lte.${endDate}&order=campaignname.asc,date.desc`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) throw new Error(`Failed to fetch experiments: ${response.status}`);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('getExperimentCampaigns error:', error);
    throw error;
  }
}

// Get all experiment campaigns (no date filter)
async function getAllExperimentCampaigns() {
  try {
    const url = `${SUPABASE_URL}/rest/v1/experimentcampaigns?order=date.desc,campaignname.asc`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) throw new Error(`Failed to fetch all experiments: ${response.status}`);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('getAllExperimentCampaigns error:', error);
    throw error;
  }
}
