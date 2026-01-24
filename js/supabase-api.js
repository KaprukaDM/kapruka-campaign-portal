// ═══════════════════════════════════════════════════════════
// KAPRUKA ADMIN DASHBOARD - COMPLETE SUPABASE API
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';
const ADMIN_PASSWORD = 'Kapruka2026!Admin';
const HEAD_PASSWORD = '207';

// Page Schedule Configuration
const PAGE_SCHEDULE = {
  'Kapruka FB Leads': { day: 1, slots: 3 },
  'Electronic Factory': { day: 2, slots: 3 },
  'Social Mart': { day: 3, slots: 3 },
  'Fashion Factory': { day: 4, slots: 3 },
  'Toys Factory': { day: 5, slots: 3 },
  'Handbag Factory': { day: 6, slots: 3 },
  'TikTok Video': { day: 0, slots: 1 }
};

const PAGE_SCHEDULE_DISPLAY = {
  'Kapruka FB Leads': { day: 'Monday', slots: 3 },
  'Electronic Factory': { day: 'Tuesday', slots: 3 },
  'Social Mart': { day: 'Wednesday', slots: 3 },
  'Fashion Factory': { day: 'Thursday', slots: 3 },
  'Toys Factory': { day: 'Friday', slots: 3 },
  'Handbag Factory': { day: 'Saturday', slots: 3 },
  'TikTok Video': { day: 'Sunday', slots: 1 }
};

// ═══════════════════════════════════════════════════════════
// CORE SUPABASE QUERY FUNCTION
// ═══════════════════════════════════════════════════════════
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

  const data = await response.json();
  return data;
}

// ═══════════════════════════════════════════════════════════
// AUTHENTICATION FUNCTIONS
// ═══════════════════════════════════════════════════════════
function verifyAdminPassword(password) {
  return password === ADMIN_PASSWORD;
}

function verifyHeadPassword(password) {
  return password === HEAD_PASSWORD;
}

function getAllPageNames() {
  return Object.keys(PAGE_SCHEDULE);
}

// ═══════════════════════════════════════════════════════════
// 1. CAMPAIGN REQUEST LOG FUNCTIONS
// ═══════════════════════════════════════════════════════════
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

async function addRequest(requestData) {
  const data = {
    request_id: requestData.requestId,
    timestamp: new Date().toISOString(),
    email: requestData.email,
    name: requestData.name,
    department: requestData.department,
    month: requestData.month,
    slot: requestData.slot,
    campaign: requestData.campaign,
    duration: requestData.duration,
    start_date: requestData.startDate,
    end_date: requestData.endDate,
    status: 'Submitted'
  };

  await supabaseQuery('request_log', 'POST', data);
  return { success: true };
}

async function updateRequestStatus(row, status, reviewer, comments) {
  const updateData = {
    status,
    reviewer,
    updated_at: new Date().toISOString(),
    comments
  };

  if (status === 'Completed') {
    updateData.completed_at = new Date().toISOString();
  }

  await supabaseQuery(`request_log?id=eq.${row}`, 'PATCH', updateData);
  return { success: true };
}

async function deleteRequest(row) {
  await supabaseQuery(`request_log?id=eq.${row}`, 'DELETE');
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// 2. PRODUCT SUGGESTIONS FUNCTIONS
// ═══════════════════════════════════════════════════════════
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

async function addProductSuggestion(productData) {
  const data = {
    submission_id: productData.submissionId,
    timestamp: new Date().toISOString(),
    email: productData.email,
    name: productData.name,
    product_link: productData.productLink,
    product_type: productData.productType,
    category: productData.category,
    margin: productData.margin,
    promotion_idea: productData.promotionIdea,
    available_qty: productData.availableQty,
    status: 'Pending'
  };

  await supabaseQuery('product_suggestions', 'POST', data);
  return { success: true };
}

async function updateProductReview(row, reviewData) {
  return await updateProductReviewWithSlot(row, reviewData);
}

async function updateProductReviewWithSlot(row, reviewData) {
  try {
    const updateData = {
      status: reviewData.status,
      reviewer_name: reviewData.reviewerName,
      updated_at: new Date().toISOString()
    };

    if (reviewData.status === 'Approved') {
      updateData.assigned_page = reviewData.assignedPage || '';
      updateData.go_live_date = reviewData.goLiveDate || null;
      updateData.slot_date = reviewData.slotDate || reviewData.goLiveDate;
      updateData.slot_number = reviewData.slotNumber || null;
      updateData.rejection_reason = '';
    } else if (reviewData.status === 'Rejected') {
      updateData.assigned_page = '';
      updateData.go_live_date = null;
      updateData.slot_date = null;
      updateData.slot_number = null;
      updateData.rejection_reason = reviewData.rejectionReason || '';
    }

    // Update product code if provided
    if (reviewData.productCode !== undefined) {
      updateData.product_code = reviewData.productCode;
    }

    await supabaseQuery(`product_suggestions?id=eq.${row}`, 'PATCH', updateData);
    return { success: true };
  } catch (error) {
    console.error('updateProductReviewWithSlot error:', error);
    throw error;
  }
}

async function deleteProductSuggestion(row) {
  await supabaseQuery(`product_suggestions?id=eq.${row}`, 'DELETE');
  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// 3. SLOT AVAILABILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════
async function getAvailableSlotsForPage(pageName) {
  try {
    if (!PAGE_SCHEDULE[pageName]) {
      throw new Error(`Invalid page name: ${pageName}`);
    }

    const schedule = PAGE_SCHEDULE[pageName];
    const targetDay = schedule.day;
    const slotsPerDay = schedule.slots;

    // Calculate next 3 occurrences of the target day
    const dates = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let currentDate = new Date(today);
    const daysUntilTarget = (targetDay - currentDate.getDay() + 7) % 7;

    if (daysUntilTarget === 0) {
      currentDate.setDate(currentDate.getDate() + 7);
    } else {
      currentDate.setDate(currentDate.getDate() + daysUntilTarget);
    }

    for (let i = 0; i < 3; i++) {
      dates.push(currentDate.toISOString().split('T')[0]);
      currentDate.setDate(currentDate.getDate() + 7);
    }

    // Fetch existing bookings
    const contentBookings = await supabaseQuery(
      `content_calendar?page_name=eq.${encodeURIComponent(pageName)}`
    );

    const productBookings = await supabaseQuery(
      `product_suggestions?assigned_page=eq.${encodeURIComponent(pageName)}&status=eq.Approved`
    );

    const slotAvailability = [];

    dates.forEach(date => {
      for (let slotNum = 1; slotNum <= slotsPerDay; slotNum++) {
        const contentBooked = contentBookings.find(b => 
          b.date === date && 
          b.slot_number === slotNum &&
          (b.status === 'Approved' || b.status === 'Pending')
        );

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

// ═══════════════════════════════════════════════════════════
// 4. THEME CONFIG FUNCTIONS
// ═══════════════════════════════════════════════════════════
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
      is_seasonal: themeData.isSeasonal || false,
      created_at: new Date().toISOString()
    };

    const result = await supabaseQuery('theme_config', 'POST', theme);
    return { success: true, themeId: result[0]?.id };
  } catch (error) {
    console.error('addTheme error:', error);
    throw error;
  }
}

async function updateTheme(themeId, updateData) {
  try {
    await supabaseQuery(`theme_config?id=eq.${themeId}`, 'PATCH', updateData);
    return { success: true };
  } catch (error) {
    console.error('updateTheme error:', error);
    throw error;
  }
}

async function deleteTheme(themeId) {
  try {
    await supabaseQuery(`theme_config?id=eq.${themeId}`, 'DELETE');
    return { success: true };
  } catch (error) {
    console.error('deleteTheme error:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════
// 5. CATEGORY SLOTS FUNCTIONS
// ═══════════════════════════════════════════════════════════
async function getCategorySlots(startDate, endDate) {
  try {
    const slots = await supabaseQuery(
      `category_slots?date=gte.${startDate}&date=lte.${endDate}&order=date.asc,slot_number.asc`
    );
    return slots;
  } catch (error) {
    console.error('getCategorySlots error:', error);
    return [];
  }
}

async function addCategorySlot(slotData) {
  try {
    const data = {
      date: slotData.date,
      slot_number: slotData.slotNumber,
      category: slotData.category,
      page_name: slotData.pageName,
      theme_id: slotData.themeId || null,
      created_at: new Date().toISOString()
    };

    await supabaseQuery('category_slots', 'POST', data);
    return { success: true };
  } catch (error) {
    console.error('addCategorySlot error:', error);
    throw error;
  }
}

async function deleteCategorySlot(id) {
  try {
    await supabaseQuery(`category_slots?id=eq.${id}`, 'DELETE');
    return { success: true };
  } catch (error) {
    console.error('deleteCategorySlot error:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════
// 6. CONTENT CALENDAR FUNCTIONS (FIXED)
// ═══════════════════════════════════════════════════════════
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
      createdAt: b.created_at,
      updatedAt: b.updated_at
    }));
  } catch (error) {
    console.error('getAllContentBookings error:', error);
    return [];
  }
}

async function addContentBooking(bookingData) {
  try {
    const data = {
      date: bookingData.date,
      slot_number: bookingData.slotNumber,
      category: bookingData.category,
      product_code: bookingData.productCode,
      product_link: bookingData.productLink,
      status: bookingData.status || 'Pending',
      submitted_by: bookingData.submittedBy,
      theme: bookingData.theme || '',
      page_name: bookingData.pageName,
      schedule_date: bookingData.scheduleDate,
      go_live_date: bookingData.goLiveDate,
      created_at: new Date().toISOString()
    };

    const result = await supabaseQuery('content_calendar', 'POST', data);
    return { success: true, id: result[0]?.id };
  } catch (error) {
    console.error('addContentBooking error:', error);
    throw error;
  }
}

// FIXED: Added productCode update support
async function updateContentBooking(id, updateData) {
  try {
    const data = {
      updated_at: new Date().toISOString()
    };

    if (updateData.status !== undefined) {
      data.status = updateData.status;
    }

    if (updateData.reviewer !== undefined) {
      data.reviewer = updateData.reviewer;
    }

    // FIXED: Allow product code updates
    if (updateData.productCode !== undefined) {
      data.product_code = updateData.productCode;
    }

    if (updateData.productLink !== undefined) {
      data.product_link = updateData.productLink;
    }

    if (updateData.status === 'Rejected' && updateData.rejectionReason !== undefined) {
      data.rejection_reason = updateData.rejectionReason;
    }

    await supabaseQuery(`content_calendar?id=eq.${id}`, 'PATCH', data);
    return { success: true };
  } catch (error) {
    console.error('updateContentBooking error:', error);
    throw error;
  }
}

async function deleteContentBooking(id) {
  try {
    await supabaseQuery(`content_calendar?id=eq.${id}`, 'DELETE');
    return { success: true };
  } catch (error) {
    console.error('deleteContentBooking error:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════
// 7. STUDIO CALENDAR FUNCTIONS (FIXED)
// ═══════════════════════════════════════════════════════════
// FIXED: Proper theme sync and content display
async function getStudioCalendarData(month, year) {
  try {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    // FIXED: Fetch themes for this month
    const themes = await supabaseQuery(
      `theme_config?start_date=lte.${endDate}&end_date=gte.${startDate}`
    );

    // Fetch category slots
    const categorySlots = await supabaseQuery(
      `category_slots?date=gte.${startDate}&date=lte.${endDate}&order=date.asc,slot_number.asc`
    );

    // Fetch content bookings
    const contentBookings = await supabaseQuery(
      `content_calendar?date=gte.${startDate}&date=lte.${endDate}`
    );

    // Fetch studio entries
    const studioEntries = await supabaseQuery(
      `studio_calendar?date=gte.${startDate}&date=lte.${endDate}`
    );

    const calendarItems = [];

    // Map each category slot to calendar item
    categorySlots.forEach(slot => {
      const booking = contentBookings.find(b => 
        b.date === slot.date && 
        b.slot_number === slot.slot_number
      );

      const studioEntry = studioEntries.find(s => 
        s.date === slot.date && 
        s.source_type === 'content_booking' &&
        s.source_id === booking?.id
      );

      // FIXED: Find applicable theme for this date
      const applicableTheme = themes.find(t => 
        slot.date >= t.start_date && slot.date <= t.end_date
      );

      calendarItems.push({
        date: slot.date,
        slotNumber: slot.slot_number,
        category: slot.category,
        type: 'content_slot',
        status: booking ? (booking.status === 'Approved' ? 'booked' : booking.status === 'Pending' ? 'pending' : 'empty') : 'empty',
        productCode: booking?.product_code || null,
        productLink: booking?.product_link || null,
        theme: applicableTheme?.theme_name || '',
        themeColor: applicableTheme?.theme_color || '#5e3a8e',
        submittedBy: booking?.submitted_by || null,
        studioStatus: studioEntry?.completion_status || 'not_started',
        studioLink: studioEntry?.content_link || null,
        studioId: studioEntry?.id || null,
        bookingId: booking?.id || null,
        bookingStatus: booking?.status || 'empty'
      });
    });

    return {
      themes: themes,
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

async function addStudioEntry(entryData) {
  try {
    const data = {
      date: entryData.date,
      source_type: entryData.sourceType,
      source_id: entryData.sourceId,
      completion_status: entryData.completionStatus || 'not_started',
      content_link: entryData.contentLink || null,
      created_at: new Date().toISOString()
    };

    const result = await supabaseQuery('studio_calendar', 'POST', data);
    return { success: true, id: result[0]?.id };
  } catch (error) {
    console.error('addStudioEntry error:', error);
    throw error;
  }
}

async function updateStudioCompletion(id, data) {
  try {
    const payload = {
      updated_at: new Date().toISOString()
    };

    if (data.completion_status) {
      payload.completion_status = data.completion_status;
    }

    if (data.content_link !== undefined) {
      payload.content_link = data.content_link || null;
    }

    if (data.approved_by) {
      payload.approved_by = data.approved_by;
    }

    if (data.completion_status === 'approved') {
      payload.approved_at = new Date().toISOString();
    }

    await supabaseQuery(`studio_calendar?id=eq.${id}`, 'PATCH', payload);
    return { success: true };
  } catch (error) {
    console.error('updateStudioCompletion error:', error);
    throw error;
  }
}

async function deleteStudioEntry(id) {
  try {
    await supabaseQuery(`studio_calendar?id=eq.${id}`, 'DELETE');
    return { success: true };
  } catch (error) {
    console.error('deleteStudioEntry error:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════
// 8. HOT PRODUCTS FUNCTIONS (FIXED)
// ═══════════════════════════════════════════════════════════
async function getAllHotProducts() {
  try {
    const products = await supabaseQuery('hot_products?order=created_at.desc');
    return products.map(p => ({
      id: p.id,
      category: p.category,
      product_link: p.product_link,
      sales_count: p.sales_count || 0,
      listed: p.listed || false,
      kapruka_link: p.kapruka_link || '',
      created_at: p.created_at,
      updated_at: p.updated_at
    }));
  } catch (error) {
    console.error('getAllHotProducts error:', error);
    return [];
  }
}

async function addHotProduct(data) {
  try {
    const product = {
      category: data.category,
      product_link: data.productLink,
      sales_count: parseInt(data.salesCount) || 0,
      listed: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const result = await supabaseQuery('hot_products', 'POST', product);
    return { success: true, id: result[0]?.id };
  } catch (error) {
    console.error('addHotProduct error:', error);
    throw error;
  }
}

async function updateHotProduct(id, data) {
  try {
    const updateData = {
      updated_at: new Date().toISOString(),
      ...data
    };

    await supabaseQuery(`hot_products?id=eq.${id}`, 'PATCH', updateData);
    return { success: true };
  } catch (error) {
    console.error('updateHotProduct error:', error);
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

async function getHotProductsStats() {
  try {
    const products = await getAllHotProducts();
    const byCategory = {};
    let listedCount = 0;

    products.forEach(p => {
      byCategory[p.category] = (byCategory[p.category] || 0) + 1;
      if (p.listed) listedCount++;
    });

    return {
      totalProducts: products.length,
      listedProducts: listedCount,
      byCategory: byCategory
    };
  } catch (error) {
    console.error('getHotProductsStats error:', error);
    return { totalProducts: 0, listedProducts: 0, byCategory: {} };
  }
}

// ═══════════════════════════════════════════════════════════
// 9. DEPARTMENTS FUNCTIONS (FIXED)
// ═══════════════════════════════════════════════════════════
async function getAllDepartments() {
  try {
    const depts = await supabaseQuery('departments?order=id.desc');
    return depts.map(d => ({
      row: d.id,
      month: d.month,
      department: d.department,
      budget: d.budget,
      slots: d.slots,
      color: d.color || '#5e3a8e',
      active: d.active,
      createdAt: d.created_at,
      updatedAt: d.updated_at
    }));
  } catch (error) {
    console.error('getAllDepartments error:', error);
    return [];
  }
}

async function addDepartment(data) {
  try {
    const dept = {
      month: data.month,
      department: data.department,
      budget: parseInt(data.budget),
      slots: parseInt(data.slots),
      color: data.color || '#5e3a8e',
      active: data.active,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const result = await supabaseQuery('departments', 'POST', dept);
    return { success: true, id: result[0]?.id };
  } catch (error) {
    console.error('addDepartment error:', error);
    throw error;
  }
}

async function updateDepartment(id, data) {
  try {
    const updateData = {
      updated_at: new Date().toISOString(),
      ...data
    };

    await supabaseQuery(`departments?id=eq.${id}`, 'PATCH', updateData);
    return { success: true };
  } catch (error) {
    console.error('updateDepartment error:', error);
    throw error;
  }
}

async function deleteDepartment(id) {
  try {
    await supabaseQuery(`departments?id=eq.${id}`, 'DELETE');
    return { success: true };
  } catch (error) {
    console.error('deleteDepartment error:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════
// EXPORT ALL FUNCTIONS (if using modules)
// ═══════════════════════════════════════════════════════════
// Uncomment if you're using ES6 modules
/*
export {
  // Core
  supabaseQuery,
  verifyAdminPassword,
  verifyHeadPassword,
  getAllPageNames,
  
  // Campaign Requests
  getAllRequests,
  addRequest,
  updateRequestStatus,
  deleteRequest,
  
  // Product Suggestions
  getAllProductSuggestions,
  addProductSuggestion,
  updateProductReview,
  updateProductReviewWithSlot,
  deleteProductSuggestion,
  getAvailableSlotsForPage,
  
  // Themes
  getAllThemes,
  addTheme,
  updateTheme,
  deleteTheme,
  
  // Category Slots
  getCategorySlots,
  addCategorySlot,
  deleteCategorySlot,
  
  // Content Calendar
  getAllContentBookings,
  addContentBooking,
  updateContentBooking,
  deleteContentBooking,
  
  // Studio Calendar
  getStudioCalendarData,
  addStudioEntry,
  updateStudioCompletion,
  deleteStudioEntry,
  
  // Hot Products
  getAllHotProducts,
  addHotProduct,
  updateHotProduct,
  deleteHotProduct,
  getHotProductsStats,
  
  // Departments
  getAllDepartments,
  addDepartment,
  updateDepartment,
  deleteDepartment
};
*/
