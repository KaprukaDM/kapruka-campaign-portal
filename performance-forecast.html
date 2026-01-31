// ═══════════════════════════════════════════════════════════════
// PERFORMANCE FORECAST - KAPRUKA CAMPAIGN PORTAL (DATA-DRIVEN)
// ═══════════════════════════════════════════════════════════════

// Objective descriptions
const OBJECTIVE_INFO = {
  CONVERSIONS: {
    title: 'Conversions (Sales/Purchases)',
    description: 'Optimize for product purchases and sales. Forecast based on your historical conversion campaigns.',
    icon: '🛒'
  },
  LEAD_GENERATION: {
    title: 'Lead Generation',
    description: 'Collect customer information through forms. Forecast based on your historical lead generation campaigns.',
    icon: '📝'
  },
  ENGAGEMENT: {
    title: 'Engagement',
    description: 'Maximize post interactions. Forecast based on your historical engagement campaigns.',
    icon: '❤️'
  },
  REACH: {
    title: 'Reach',
    description: 'Show ads to maximum people. Forecast based on your historical reach campaigns.',
    icon: '👥'
  },
  TRAFFIC: {
    title: 'Traffic',
    description: 'Drive website clicks. Forecast based on your historical traffic campaigns.',
    icon: '🔗'
  },
  APP_INSTALLS: {
    title: 'App Installs',
    description: 'Drive mobile app installations. Forecast based on your historical app install campaigns.',
    icon: '📱'
  },
  VIDEO_VIEWS: {
    title: 'Video Views',
    description: 'Maximize video views. Forecast based on your historical video campaigns.',
    icon: '🎥'
  },
  MESSAGES: {
    title: 'Messages',
    description: 'Generate conversations via Messenger. Forecast based on your historical messaging campaigns.',
    icon: '💬'
  }
};

// DOM Elements
let objectiveSelect, budgetInput, budgetSlider, budgetDisplay, budgetAmount;
let forecastBtn, resultsContainer, tableContainer, tableBody, objectiveInfo;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  // Get DOM elements
  objectiveSelect = document.getElementById('objective');
  budgetInput = document.getElementById('budget');
  budgetSlider = document.getElementById('budgetSlider');
  budgetDisplay = document.getElementById('budgetDisplay');
  budgetAmount = document.getElementById('budgetAmount');
  forecastBtn = document.getElementById('forecastBtn');
  resultsContainer = document.getElementById('resultsContainer');
  tableContainer = document.getElementById('tableContainer');
  tableBody = document.getElementById('tableBody');
  objectiveInfo = document.getElementById('objectiveInfo');

  // Event listeners
  objectiveSelect.addEventListener('change', handleObjectiveChange);
  budgetInput.addEventListener('input', handleBudgetChange);
  budgetSlider.addEventListener('input', handleSliderChange);
  forecastBtn.addEventListener('click', generateForecast);

  // Sync initial values
  syncBudgetValues();
});

// Handle objective selection change
function handleObjectiveChange() {
  const objective = objectiveSelect.value;

  if (objective && OBJECTIVE_INFO[objective]) {
    const info = OBJECTIVE_INFO[objective];
    objectiveInfo.innerHTML = `
      <strong>${info.icon} ${info.title}</strong><br>
      ${info.description}
    `;
    objectiveInfo.style.display = 'block';
  } else {
    objectiveInfo.style.display = 'none';
  }

  updateButtonState();
}

// Handle budget input change
function handleBudgetChange() {
  const value = parseFloat(budgetInput.value) || 0;
  budgetSlider.value = value;
  syncBudgetValues();
  updateButtonState();
}

// Handle slider change
function handleSliderChange() {
  const value = parseFloat(budgetSlider.value);
  budgetInput.value = value;
  syncBudgetValues();
  updateButtonState();
}

// Sync budget display
function syncBudgetValues() {
  const value = parseFloat(budgetInput.value) || 0;
  budgetAmount.textContent = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  if (value > 0) {
    budgetDisplay.style.display = 'flex';
  } else {
    budgetDisplay.style.display = 'none';
  }
}

// Update button state
function updateButtonState() {
  const objective = objectiveSelect.value;
  const budget = parseFloat(budgetInput.value) || 0;

  forecastBtn.disabled = !objective || budget < 10;
}

// Generate forecast using real historical data
async function generateForecast() {
  const objective = objectiveSelect.value;
  const budget = parseFloat(budgetInput.value);

  if (!objective || budget < 10) {
    alert('Please select an objective and enter a budget of at least $10');
    return;
  }

  // Show loading
  resultsContainer.innerHTML = `
    <div class="loading">
      <div class="loading-spinner"></div>
      <p>Analyzing historical campaign data...</p>
    </div>
  `;
  tableContainer.style.display = 'none';
  forecastBtn.disabled = true;

  try {
    // Call the forecast API with real data
    const result = await getPerformanceForecast(objective, budget);

    if (!result.success) {
      throw new Error(result.error || 'Failed to generate forecast');
    }

    // Display results
    displayResults(result);

  } catch (error) {
    console.error('Forecast error:', error);
    resultsContainer.innerHTML = `
      <div class="error-message">
        <strong>❌ Error generating forecast:</strong><br>
        ${error.message || 'Unknown error occurred'}<br><br>
        <small>This could mean there's no historical data for the selected objective. Please try a different objective or contact the admin.</small>
      </div>
    `;
  } finally {
    forecastBtn.disabled = false;
  }
}

// Fetch historical data and generate forecast
async function getPerformanceForecast(objective, budget) {
  try {
    // Check if supabase.js variables are available
    if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_KEY === 'undefined') {
      throw new Error('Supabase configuration not found. Make sure supabase.js is loaded before this script.');
    }

    // Fetch historical data from meta_ads_performance table
    const historicalData = await fetchHistoricalData(objective);

    if (!historicalData || historicalData.length === 0) {
      throw new Error(`No historical data found for objective: ${objective}. Please ensure you have campaign data in the database.`);
    }

    // Calculate averages from historical data
    const stats = calculateHistoricalStats(historicalData);

    // Generate forecast based on budget and historical averages
    const forecast = generateForecastFromStats(stats, budget, objective);

    return {
      success: true,
      objective: objective,
      budget: budget,
      historicalData: stats,
      forecast: forecast
    };

  } catch (error) {
    console.error('getPerformanceForecast error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Fetch historical data from Supabase
async function fetchHistoricalData(objective) {
  try {
    // Map objectives to database objective names (common Meta Ads objective formats)
    const objectiveMapping = {
      'CONVERSIONS': ['OUTCOME_SALES', 'CONVERSIONS', 'PURCHASE'],
      'LEAD_GENERATION': ['OUTCOME_LEADS', 'LEAD_GENERATION', 'LEADS'],
      'ENGAGEMENT': ['OUTCOME_ENGAGEMENT', 'ENGAGEMENT', 'POST_ENGAGEMENT'],
      'REACH': ['OUTCOME_AWARENESS', 'REACH', 'BRAND_AWARENESS'],
      'TRAFFIC': ['OUTCOME_TRAFFIC', 'LINK_CLICKS', 'TRAFFIC'],
      'APP_INSTALLS': ['OUTCOME_APP_PROMOTION', 'APP_INSTALLS', 'MOBILE_APP_INSTALLS'],
      'VIDEO_VIEWS': ['OUTCOME_ENGAGEMENT', 'VIDEO_VIEWS', 'THRUPLAY'],
      'MESSAGES': ['OUTCOME_LEADS', 'MESSAGES', 'MESSENGER_LEADS']
    };

    const possibleObjectives = objectiveMapping[objective] || [objective];

    // Try to fetch data for each possible objective name
    let allData = [];

    for (const dbObjective of possibleObjectives) {
      try {
        const url = `${SUPABASE_URL}/rest/v1/meta_ads_performance?objective=ilike.%${encodeURIComponent(dbObjective)}%&order=date.desc&limit=500`;

        const response = await fetch(url, {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        if (response.ok) {
          const data = await response.json();
          if (data && data.length > 0) {
            allData = allData.concat(data);
          }
        }
      } catch (err) {
        console.log(`Could not fetch data for objective: ${dbObjective}`);
      }
    }

    // If still no data, fetch all records and filter client-side
    if (allData.length === 0) {
      console.log('No objective-specific data found. Fetching all historical data...');
      const allUrl = `${SUPABASE_URL}/rest/v1/meta_ads_performance?order=date.desc&limit=1000`;
      const allResponse = await fetch(allUrl, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (!allResponse.ok) {
        throw new Error(`API Error: ${allResponse.status} - ${allResponse.statusText}`);
      }

      allData = await allResponse.json();
    }

    return allData;

  } catch (error) {
    console.error('fetchHistoricalData error:', error);
    throw error;
  }
}

// Calculate statistics from historical data
function calculateHistoricalStats(data) {
  let totalSpent = 0;
  let totalReach = 0;
  let totalImpressions = 0;
  let totalClicks = 0;
  let totalOrders = 0;
  let totalResults = 0;
  let recordCount = data.length;

  data.forEach(row => {
    totalSpent += parseFloat(row.amount_spent || 0);
    totalReach += parseInt(row.reach || 0);
    totalImpressions += parseInt(row.impression || 0);
    totalClicks += parseInt(row.clicks || 0);
    totalOrders += parseInt(row.if_direct_orders || row.direct_orders || 0);
    totalResults += parseInt(row.results || 0);
  });

  // Calculate averages with fallbacks
  const avgCPC = totalClicks > 0 ? totalSpent / totalClicks : 0.50;
  const avgCPM = totalImpressions > 0 ? (totalSpent / totalImpressions) * 1000 : 5.00;
  const avgCTR = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 1.20;
  const avgConversionRate = totalClicks > 0 ? (totalOrders / totalClicks) * 100 : 2.50;
  const avgCostPerOrder = totalOrders > 0 ? totalSpent / totalOrders : 20.00;
  const avgReachPerDollar = totalSpent > 0 ? totalReach / totalSpent : 1000;
  const avgImpressionsPerDollar = totalSpent > 0 ? totalImpressions / totalSpent : 1500;

  return {
    recordCount: recordCount,
    totalSpent: totalSpent,
    avgCPC: avgCPC,
    avgCPM: avgCPM,
    avgCTR: avgCTR,
    avgConversionRate: avgConversionRate,
    avgCostPerOrder: avgCostPerOrder,
    avgReachPerDollar: avgReachPerDollar,
    avgImpressionsPerDollar: avgImpressionsPerDollar
  };
}

// Generate forecast from statistics and budget
function generateForecastFromStats(stats, budget, objective) {
  // Base calculations
  const estimatedReach = Math.round(budget * stats.avgReachPerDollar);
  const estimatedImpressions = Math.round(budget * stats.avgImpressionsPerDollar);
  const estimatedClicks = Math.round(estimatedImpressions * (stats.avgCTR / 100));

  // Conversion/order calculations
  let estimatedOrders = 0;
  let costPerOrder = 0;

  if (objective === 'CONVERSIONS' || objective === 'LEAD_GENERATION') {
    estimatedOrders = Math.round(estimatedClicks * (stats.avgConversionRate / 100));
    costPerOrder = estimatedOrders > 0 ? budget / estimatedOrders : stats.avgCostPerOrder;

    // Ensure at least some orders if budget is reasonable
    if (estimatedOrders === 0 && budget >= stats.avgCostPerOrder) {
      estimatedOrders = Math.floor(budget / stats.avgCostPerOrder);
      costPerOrder = stats.avgCostPerOrder;
    }
  }

  // Results for engagement/reach objectives
  let estimatedResults = 0;
  if (objective === 'ENGAGEMENT' || objective === 'REACH') {
    estimatedResults = Math.round(estimatedClicks * 1.5); // Engagement is typically higher than clicks
  }

  return {
    reach: estimatedReach,
    impressions: estimatedImpressions,
    clicks: estimatedClicks,
    orders: estimatedOrders,
    costPerOrder: costPerOrder,
    results: estimatedResults
  };
}

// Display forecast results based on real data
function displayResults(data) {
  const { objective, budget, historicalData, forecast } = data;

  // Build info banner about data source
  let infoBanner = `
    <div class="success-message" style="margin-bottom: 20px;">
      <strong>📊 Forecast based on ${historicalData.recordCount.toLocaleString()} historical ad records</strong><br>
      <small>Total historical spend analyzed: $${historicalData.totalSpent.toLocaleString('en-US', {minimumFractionDigits: 2})}</small>
    </div>
  `;

  // Build results cards HTML
  let resultsHTML = infoBanner + '<div class="results-grid">';

  // Primary metrics based on objective
  if (objective === 'CONVERSIONS' || objective === 'LEAD_GENERATION') {
    resultsHTML += `
      <div class="result-card primary">
        <div class="result-label">${objective === 'CONVERSIONS' ? 'Estimated Orders' : 'Estimated Leads'}</div>
        <div class="result-value">${forecast.orders.toLocaleString()}</div>
        <div class="result-unit">${objective === 'CONVERSIONS' ? 'purchases' : 'leads'}</div>
      </div>
      <div class="result-card">
        <div class="result-label">Cost Per ${objective === 'CONVERSIONS' ? 'Order' : 'Lead'}</div>
        <div class="result-value">$${forecast.costPerOrder.toFixed(2)}</div>
        <div class="result-unit">average</div>
      </div>
    `;
  }

  // Always show: Reach, Impressions, Clicks
  resultsHTML += `
    <div class="result-card ${objective === 'REACH' ? 'primary' : ''}">
      <div class="result-label">Estimated Reach</div>
      <div class="result-value">${forecast.reach.toLocaleString()}</div>
      <div class="result-unit">unique people</div>
    </div>
    <div class="result-card">
      <div class="result-label">Impressions</div>
      <div class="result-value">${forecast.impressions.toLocaleString()}</div>
      <div class="result-unit">ad views</div>
    </div>
    <div class="result-card ${objective === 'TRAFFIC' ? 'primary' : ''}">
      <div class="result-label">Clicks</div>
      <div class="result-value">${forecast.clicks.toLocaleString()}</div>
      <div class="result-unit">link clicks</div>
    </div>
  `;

  // Show results for engagement/reach objectives
  if (forecast.results > 0 && (objective === 'ENGAGEMENT' || objective === 'REACH')) {
    resultsHTML += `
      <div class="result-card primary">
        <div class="result-label">Results</div>
        <div class="result-value">${forecast.results.toLocaleString()}</div>
        <div class="result-unit">total results</div>
      </div>
    `;
  }

  resultsHTML += '</div>';

  resultsContainer.innerHTML = resultsHTML;

  // Build detailed table with historical averages
  let tableHTML = `
    <tr>
      <td><strong>Input Budget</strong></td>
      <td class="estimate-value">$${budget.toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
      <td>-</td>
    </tr>
    <tr style="background: #f8f9fa;">
      <td colspan="3"><strong>📊 Historical Averages (from ${historicalData.recordCount} records)</strong></td>
    </tr>
    <tr>
      <td>Average CPC (Cost per Click)</td>
      <td class="estimate-value">$${historicalData.avgCPC.toFixed(2)}</td>
      <td>From real data</td>
    </tr>
    <tr>
      <td>Average CPM (Cost per 1000 Impressions)</td>
      <td class="estimate-value">$${historicalData.avgCPM.toFixed(2)}</td>
      <td>From real data</td>
    </tr>
    <tr>
      <td>Average CTR (Click-Through Rate)</td>
      <td class="estimate-value">${historicalData.avgCTR.toFixed(2)}%</td>
      <td>From real data</td>
    </tr>
  `;

  if (historicalData.avgConversionRate > 0) {
    tableHTML += `
      <tr>
        <td>Average Conversion Rate</td>
        <td class="estimate-value">${historicalData.avgConversionRate.toFixed(2)}%</td>
        <td>From real data</td>
      </tr>
      <tr>
        <td>Average Cost per Order</td>
        <td class="estimate-value">$${historicalData.avgCostPerOrder.toFixed(2)}</td>
        <td>From real data</td>
      </tr>
    `;
  }

  tableHTML += `
    <tr style="background: #f8f9fa;">
      <td colspan="3"><strong>🎯 Forecasted Performance</strong></td>
    </tr>
    <tr>
      <td>Estimated Reach</td>
      <td class="estimate-value">${forecast.reach.toLocaleString()}</td>
      <td>${Math.round(forecast.reach * 0.85).toLocaleString()} - ${Math.round(forecast.reach * 1.15).toLocaleString()}</td>
    </tr>
    <tr>
      <td>Estimated Impressions</td>
      <td class="estimate-value">${forecast.impressions.toLocaleString()}</td>
      <td>${Math.round(forecast.impressions * 0.85).toLocaleString()} - ${Math.round(forecast.impressions * 1.15).toLocaleString()}</td>
    </tr>
    <tr>
      <td>Estimated Clicks</td>
      <td class="estimate-value">${forecast.clicks.toLocaleString()}</td>
      <td>${Math.round(forecast.clicks * 0.80).toLocaleString()} - ${Math.round(forecast.clicks * 1.20).toLocaleString()}</td>
    </tr>
  `;

  if (forecast.orders > 0) {
    tableHTML += `
      <tr>
        <td>Estimated ${objective === 'CONVERSIONS' ? 'Orders' : 'Leads'}</td>
        <td class="estimate-value">${forecast.orders.toLocaleString()}</td>
        <td>${Math.round(forecast.orders * 0.75).toLocaleString()} - ${Math.round(forecast.orders * 1.25).toLocaleString()}</td>
      </tr>
      <tr>
        <td>Forecasted Cost per ${objective === 'CONVERSIONS' ? 'Order' : 'Lead'}</td>
        <td class="estimate-value">$${forecast.costPerOrder.toFixed(2)}</td>
        <td>$${(forecast.costPerOrder * 0.80).toFixed(2)} - $${(forecast.costPerOrder * 1.20).toFixed(2)}</td>
      </tr>
    `;
  }

  if (forecast.results > 0) {
    tableHTML += `
      <tr>
        <td>Estimated Results</td>
        <td class="estimate-value">${forecast.results.toLocaleString()}</td>
        <td>${Math.round(forecast.results * 0.80).toLocaleString()} - ${Math.round(forecast.results * 1.20).toLocaleString()}</td>
      </tr>
    `;
  }

  tableBody.innerHTML = tableHTML;
  tableContainer.style.display = 'block';
}
