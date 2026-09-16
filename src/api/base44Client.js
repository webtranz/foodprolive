const ACCESS_TOKEN_KEY = 'foodpro_access_token';
const eventBus = new EventTarget();
let realtimeController = null;
let realtimeSubscribers = 0;
const realtimeEntityTimers = new Map();
const realtimeEntityDetails = new Map();

const getStoredToken = () => (
  window.localStorage.getItem(ACCESS_TOKEN_KEY) ||
  window.sessionStorage.getItem(ACCESS_TOKEN_KEY)
);

function setStoredToken(token, remember = true) {
  if (remember) {
    window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    return;
  }

  window.sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
}

function clearStoredToken() {
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  realtimeController?.abort();
  realtimeController = null;
}

async function apiRequest(path, options = {}) {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});

  if (!options.body?.constructor?.name?.includes('FormData')) {
    headers.set('Content-Type', 'application/json');
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers
    });
  } catch (error) {
    const networkError = new Error('Cannot reach the server. Check that the deployment is running and the domain points to the correct VPS.');
    networkError.status = 503;
    networkError.cause = error;
    throw networkError;
  }

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || 'Request failed');
    error.status = response.status;
    error.data = payload;
    throw error;
  }

  return payload;
}

async function apiBlobRequest(path, options = {}) {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (error) {
    const networkError = new Error('Cannot reach the server. Check that the deployment is running and the domain points to the correct VPS.');
    networkError.status = 503;
    networkError.cause = error;
    throw networkError;
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.message || 'Download failed');
    error.status = response.status;
    error.data = payload;
    throw error;
  }
  return response.blob();
}

const entityCacheKey = (entity) => `entity:${entity}`;

function emitEntityChange(entity, detail = {}) {
  eventBus.dispatchEvent(new CustomEvent(entityCacheKey(entity), { detail }));
}

function scheduleRemoteEntityChange(entity, detail) {
  realtimeEntityDetails.set(entity, detail);
  if (realtimeEntityTimers.has(entity)) return;
  const timer = setTimeout(() => {
    realtimeEntityTimers.delete(entity);
    const latest = realtimeEntityDetails.get(entity) || detail;
    realtimeEntityDetails.delete(entity);
    emitEntityChange(entity, latest);
  }, 250 + Math.floor(Math.random() * 500));
  realtimeEntityTimers.set(entity, timer);
}

function handleRealtimeFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (eventName !== 'entity-change' || !data) return;
  try {
    const event = JSON.parse(data);
    if (event?.entity) scheduleRemoteEntityChange(event.entity, { ...event, remote: true });
  } catch {
    // Ignore malformed event frames and keep the stream alive.
  }
}

async function runRealtimeStream(controller) {
  while (!controller.signal.aborted && realtimeSubscribers > 0) {
    const token = getStoredToken();
    if (!token) return;
    try {
      const response = await fetch('/api/events', {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`Realtime connection failed (${response.status})`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          handleRealtimeFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn(error.message || 'Realtime connection interrupted.');
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function retainRealtimeConnection() {
  realtimeSubscribers += 1;
  if (!realtimeController && getStoredToken()) {
    realtimeController = new AbortController();
    runRealtimeStream(realtimeController).finally(() => {
      if (realtimeController?.signal.aborted || realtimeSubscribers === 0) {
        realtimeController = null;
      }
    });
  }
}

function releaseRealtimeConnection() {
  realtimeSubscribers = Math.max(0, realtimeSubscribers - 1);
  if (realtimeSubscribers === 0) {
    realtimeController?.abort();
    realtimeController = null;
  }
}

function buildQueryString(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && typeof value !== 'undefined' && value !== '') {
      search.set(key, String(value));
    }
  });
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

function createEntityModule(entity) {
  return {
    get(id) {
      return apiRequest(`/api/entities/${entity}/${id}`);
    },
    list(sort, limit) {
      const params = new URLSearchParams();
      if (sort) params.set('sort', sort);
      if (typeof limit === 'number') params.set('limit', String(limit));
      return apiRequest(`/api/entities/${entity}?${params.toString()}`);
    },
    filter(filters = {}, sort, limit, { rangeFilters = {} } = {}) {
      return apiRequest(`/api/entities/${entity}/filter`, {
        method: 'POST',
        body: JSON.stringify({ filters, rangeFilters, sort, limit })
      });
    },
    page({ filters = {}, rangeFilters = {}, sort, page = 1, limit = 50 } = {}) {
      return apiRequest(`/api/entities/${entity}/page`, {
        method: 'POST',
        body: JSON.stringify({ filters, rangeFilters, sort, page, limit })
      });
    },
    create(data) {
      return apiRequest(`/api/entities/${entity}`, {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange(entity, { action: 'create', result });
        return result;
      });
    },
    update(id, data) {
      return apiRequest(`/api/entities/${entity}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange(entity, { action: 'update', result });
        return result;
      });
    },
    delete(id, { includeDescendants = false } = {}) {
      const query = includeDescendants ? '?include_descendants=true' : '';
      return apiRequest(`/api/entities/${entity}/${id}${query}`, {
        method: 'DELETE'
      }).then((result) => {
        emitEntityChange(entity, { action: 'delete', result, id });
        return result;
      });
    },
    deleteImpact(id) {
      return apiRequest(`/api/entities/${entity}/${id}/delete-impact`);
    },
    subscribe(callback) {
      const handler = (event) => callback(event.detail);
      eventBus.addEventListener(entityCacheKey(entity), handler);
      retainRealtimeConnection();
      return () => {
        eventBus.removeEventListener(entityCacheKey(entity), handler);
        releaseRealtimeConnection();
      };
    }
  };
}

const entities = new Proxy({}, {
  get(_target, entityName) {
    return createEntityModule(entityName);
  }
});

async function ensureAuth() {
  const token = getStoredToken();
  if (!token) {
    throw Object.assign(new Error('Authentication required'), { status: 401 });
  }
  return token;
}

export const base44 = {
  entities,
  managementDashboard: {
    getSnapshot(filters = {}) {
      return apiRequest(`/api/dashboard/management${buildQueryString({
        view: filters.view,
        date: filters.date,
        start_date: filters.start_date ?? filters.startDate,
        end_date: filters.end_date ?? filters.endDate,
        site_id: filters.site_id ?? filters.siteId
      })}`);
    }
  },
  reports: {
    getFoodCost(filters = {}) {
      return apiRequest(`/api/reports/food-cost${buildQueryString({
        start_date: filters.start_date ?? filters.startDate,
        end_date: filters.end_date ?? filters.endDate,
        location_id: filters.location_id ?? filters.locationId,
        category: filters.category,
        meal_type: filters.meal_type ?? filters.mealType,
        menu_type: filters.menu_type ?? filters.menuType,
        view: filters.view
      })}`);
    }
  },
  database: {
    getAudit({ includeOk = false } = {}) {
      return apiRequest(`/api/database/audit${buildQueryString({ include_ok: includeOk ? 'true' : '' })}`);
    }
  },
  budgets: {
    getPlanningContext(filters = {}) {
      return apiRequest(`/api/budgets/planning-context${buildQueryString({
        month: filters.month,
        date: filters.date
      })}`);
    }
  },
  ingredients: {
    search(filters = {}) {
      return apiRequest(`/api/ingredients/search${buildQueryString(filters)}`);
    }
  },
  auth: {
    async login(email, password, options = {}) {
      const session = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      setStoredToken(session.token, options.remember !== false);
      return session.user;
    },
    async me() {
      await ensureAuth();
      return apiRequest('/api/auth/me');
    },
    async updateMe(data) {
      await ensureAuth();
      return apiRequest('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify(data)
      });
    },
    logout(redirectTo) {
      const token = getStoredToken();
      if (token) {
        fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          keepalive: true
        }).catch(() => {});
      }
      clearStoredToken();
      if (redirectTo) {
        window.location.assign(redirectTo);
      }
    },
    redirectToLogin(redirectTo = '/login') {
      window.location.assign(redirectTo);
    }
  },
  users: {
    inviteUser(email, role) {
      return apiRequest('/api/users/invite', {
        method: 'POST',
        body: JSON.stringify({ email, role })
      });
    },
    deactivateUser(id, { confirmation, reason }) {
      return apiRequest(`/api/users/${id}/deactivate`, {
        method: 'POST',
        body: JSON.stringify({ confirmation, reason })
      }).then((result) => {
        emitEntityChange('User', { action: 'deactivate', result, id });
        return result;
      });
    }
  },
  userGroups: {
    bulkImport(data) {
      return apiRequest('/api/user-groups/bulk-members', {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('UserGroup', { action: 'bulk-members', result, id: result?.id });
        return result;
      });
    }
  },
  pos: {
    listSources() {
      return apiRequest('/api/pos/sources');
    },
    createSource(data) {
      return apiRequest('/api/pos/sources', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    updateSource(id, data) {
      return apiRequest(`/api/pos/sources/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      });
    },
    deleteSource(id) {
      return apiRequest(`/api/pos/sources/${id}`, {
        method: 'DELETE'
      });
    },
    syncSource(id) {
      return apiRequest(`/api/pos/sources/${id}/sync`, {
        method: 'POST',
        body: JSON.stringify({})
      });
    },
    listMappings() {
      return apiRequest('/api/pos/mappings');
    },
    createMapping(data) {
      return apiRequest('/api/pos/mappings', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    updateMapping(id, data) {
      return apiRequest(`/api/pos/mappings/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      });
    },
    deleteMapping(id) {
      return apiRequest(`/api/pos/mappings/${id}`, {
        method: 'DELETE'
      });
    },
    importManual(data) {
      return apiRequest('/api/pos/import/manual', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    listSyncLogs(limit = 100) {
      return apiRequest(`/api/pos/sync-logs${buildQueryString({ limit })}`);
    },
    getSalesSummary(filters = {}) {
      return apiRequest(`/api/pos/sales-summary${buildQueryString(filters)}`);
    },
    getVarianceReport(filters = {}) {
      return apiRequest(`/api/pos/variance-report${buildQueryString(filters)}`);
    }
  },
  procurement: {
    listSuppliers() {
      return apiRequest('/api/procurement/suppliers');
    },
    createSupplier(data) {
      return apiRequest('/api/procurement/suppliers', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    updateSupplier(id, data) {
      return apiRequest(`/api/procurement/suppliers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      });
    },
    deleteSupplier(id) {
      return apiRequest(`/api/procurement/suppliers/${id}`, {
        method: 'DELETE'
      });
    },
    listRequests() {
      return apiRequest('/api/procurement/requests');
    },
    createRequest(data) {
      return apiRequest('/api/procurement/requests', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    autoGenerateRequest(data) {
      return apiRequest('/api/procurement/requests/auto-generate', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    approveRequest(id, data = {}) {
      return apiRequest(`/api/procurement/requests/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    rejectRequest(id, data = {}) {
      return apiRequest(`/api/procurement/requests/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    listOrders() {
      return apiRequest('/api/procurement/orders');
    },
    createOrder(data) {
      return apiRequest('/api/procurement/orders', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    approveOrder(id, data = {}) {
      return apiRequest(`/api/procurement/orders/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    cancelOrder(id, data = {}) {
      return apiRequest(`/api/procurement/orders/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    listReceipts() {
      return apiRequest('/api/procurement/receipts');
    },
    createReceipt(data) {
      return apiRequest('/api/procurement/receipts', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    listInvoices() {
      return apiRequest('/api/procurement/invoices');
    },
    createInvoice(data) {
      return apiRequest('/api/procurement/invoices', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    getPriceComparison(filters = {}) {
      return apiRequest(`/api/procurement/price-comparison${buildQueryString(filters)}`);
    },
    getPerformance() {
      return apiRequest('/api/procurement/performance');
    }
  },
  materialRequests: {
    list() {
      return apiRequest('/api/material-requests');
    },
    createFromProduction(productionId, data = {}) {
      return apiRequest(`/api/material-requests/from-production/${productionId}`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    acknowledge(id, data = {}) {
      return apiRequest(`/api/material-requests/${id}/acknowledge`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    repairIssues(id, data = {}) {
      return apiRequest(`/api/material-requests/${id}/repair-issues`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    }
  },
  productionWorkflow: {
    start(id, data = {}) {
      return apiRequest(`/api/entities/Production/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...data, status: 'in_progress' })
      });
    },
    adjustApprovedQuantity(id, data = {}) {
      return apiRequest(`/api/productions/${id}/approved-quantity`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      });
    },
    cancel(id, data = {}) {
      return apiRequest(`/api/productions/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    }
  },
  menuPlanning: {
    getWeek(siteId, weekStart, options = {}) {
      return apiRequest(`/api/menu-plans/week${buildQueryString({
        site_id: siteId,
        week_start: weekStart,
        cuisine_type: options.cuisine_type,
        menu_category: options.menu_category
      })}`);
    },
    getByDate(siteId, planDate, options = {}) {
      return apiRequest(`/api/menu-plans/by-date${buildQueryString({
        site_id: siteId,
        plan_date: planDate,
        cuisine_type: options.cuisine_type,
        menu_category: options.menu_category
      })}`);
    },
    previewCost(data) {
      return apiRequest('/api/menu-plans/cost-preview', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    getBudgetContext(siteId, planDate, budgetId, totalPlannedCost) {
      return apiRequest(`/api/menu-plans/budgets${buildQueryString({
        site_id: siteId,
        plan_date: planDate,
        budget_id: budgetId,
        total_planned_cost: totalPlannedCost
      })}`);
    },
    getPRGenerationContext(siteId, referenceDate) {
      return apiRequest(`/api/menu-plans/pr-generation${buildQueryString({
        site_id: siteId,
        reference_date: referenceDate
      })}`);
    },
    savePRGenerationConfig(data) {
      return apiRequest('/api/menu-plans/pr-generation/config', {
        method: 'PATCH',
        body: JSON.stringify(data)
      });
    },
    runPRGeneration(data) {
      return apiRequest('/api/menu-plans/pr-generation/run', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    create(data) {
      return apiRequest('/api/menu-plans', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    update(id, data) {
      return apiRequest(`/api/menu-plans/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      });
    },
    delete(id) {
      return apiRequest(`/api/menu-plans/${id}`, {
        method: 'DELETE'
      });
    }
  },
  specialEvents: {
    list(limit = 300, details = true) {
      return apiRequest(`/api/special-events${buildQueryString({ limit, details })}`);
    },
    get(id) {
      return apiRequest(`/api/special-events/${id}`);
    },
    getHistory(id) {
      return apiRequest(`/api/special-events/${id}/history`);
    },
    listRecipes(siteId = '') {
      return apiRequest(`/api/special-events/recipes${buildQueryString({ site_id: siteId })}`);
    },
    getBudgetContext(siteId, eventDate, eventName, budgetId, estimatedCost) {
      return apiRequest(`/api/special-events/budgets${buildQueryString({
        site_id: siteId,
        event_date: eventDate,
        event_name: eventName,
        budget_id: budgetId,
        estimated_cost: estimatedCost
      })}`);
    },
    create(data) {
      return apiRequest('/api/special-events', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    update(id, data) {
      return apiRequest(`/api/special-events/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      });
    },
    generateProduction(id, data = {}) {
      return apiRequest(`/api/special-events/${id}/generate-production`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    createPurchaseRequest(id, data = {}) {
      return apiRequest(`/api/special-events/${id}/create-pr`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    submit(id, note) {
      return apiRequest(`/api/special-events/${id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ note })
      });
    },
    approve(id, note) {
      return apiRequest(`/api/special-events/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ note })
      });
    },
    reject(id, reason) {
      return apiRequest(`/api/special-events/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
    }
  },
  foodWaste: {
    list(filters = {}) {
      return apiRequest(`/api/food-waste${buildQueryString(filters)}`);
    },
    getContext(siteId, wasteDate, mealType) {
      return apiRequest(`/api/food-waste/context${buildQueryString({
        site_id: siteId,
        waste_date: wasteDate,
        meal_type: mealType
      })}`);
    },
    create(data) {
      return apiRequest('/api/food-waste', {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('FoodWaste', { action: 'create', result });
        if (data?.source_type === 'batch_overproduction' || data?.waste_category === 'batch_overproduction') {
          emitEntityChange('ProducedItemBatch', { action: 'food-waste', result });
        }
        if (data?.waste_category === 'plate_waste' || result?.meal_service_adjustment_weight_grams > 0) {
          emitEntityChange('MealServiceConsumption', { action: 'plate-waste-adjustment', result });
        }
        return result;
      });
    },
    update(id, data) {
      return apiRequest(`/api/food-waste/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('FoodWaste', { action: 'update', result, id });
        if (data?.source_type === 'batch_overproduction' || data?.waste_category === 'batch_overproduction' || result?.source_type === 'batch_overproduction') {
          emitEntityChange('ProducedItemBatch', { action: 'food-waste-update', result, id });
        }
        if (data?.waste_category === 'plate_waste' || result?.meal_service_adjustment_weight_grams > 0) {
          emitEntityChange('MealServiceConsumption', { action: 'plate-waste-adjustment', result, id });
        }
        return result;
      });
    },
    reverse(id, data = {}) {
      return apiRequest(`/api/food-waste/${encodeURIComponent(id)}/reverse`, {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('FoodWaste', { action: 'reverse', result, id });
        emitEntityChange('ProducedItemBatch', { action: 'food-waste-reversal', result, id });
        emitEntityChange('MealServiceConsumption', { action: 'plate-waste-reversal', result, id });
        emitEntityChange('Inventory', { action: 'food-waste-reversal', result, id });
        return result;
      });
    }
  },
  mealService: {
    availability(filters = {}) {
      return apiRequest(`/api/meal-service/availability${buildQueryString(filters)}`);
    },
    updatePortionSize(data = {}) {
      return apiRequest('/api/meal-service/portion-size', {
        method: 'PATCH',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('ProducedItemBatch', { action: 'meal-service-portion-size', result });
        return result;
      });
    },
    preview(data = {}) {
      return apiRequest('/api/meal-service/preview', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    confirm(data = {}) {
      return apiRequest('/api/meal-service/attendance', {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('ProducedItemBatch', { action: 'meal-service', result });
        emitEntityChange('MealServiceAttendance', { action: 'create', result });
        emitEntityChange('MealServiceConsumption', { action: 'create', result });
        emitEntityChange('FoodWaste', { action: 'meal-service-leftover', result });
        return result;
      });
    },
    recordAttendance(data = {}) {
      return apiRequest('/api/meal-service/attendance', {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('ProducedItemBatch', { action: 'meal-service', result });
        emitEntityChange('MealServiceAttendance', { action: 'create', result });
        emitEntityChange('MealServiceConsumption', { action: 'create', result });
        return result;
      });
    },
    reverseAttendance(id, data = {}) {
      return apiRequest(`/api/meal-service/attendance/${encodeURIComponent(id)}/reverse`, {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('ProducedItemBatch', { action: 'meal-service-reversal', result });
        emitEntityChange('MealServiceAttendance', { action: 'reverse', result, id });
        emitEntityChange('MealServiceConsumption', { action: 'reverse', result });
        emitEntityChange('FoodWaste', { action: 'meal-service-leftover-reversal', result });
        return result;
      });
    },
    report(filters = {}) {
      return apiRequest(`/api/meal-service/report${buildQueryString(filters)}`);
    }
  },
  staffMealQr: {
    list() {
      return apiRequest('/api/staff-meal-qr');
    },
    create(data = {}) {
      return apiRequest('/api/staff-meal-qr', {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('QRCode', { action: 'staff-meal-qr-create', result });
        return result;
      });
    },
    update(id, data = {}) {
      return apiRequest(`/api/staff-meal-qr/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('QRCode', { action: 'staff-meal-qr-update', result, id });
        return result;
      });
    },
    delete(id) {
      return apiRequest(`/api/staff-meal-qr/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      }).then((result) => {
        emitEntityChange('QRCode', { action: 'staff-meal-qr-delete', result, id });
        return result;
      });
    },
    scan(data = {}) {
      return apiRequest('/api/staff-meal-qr/scan', {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('QRCode', { action: 'staff-meal-qr-scan', result });
        emitEntityChange('AttendanceRecord', { action: 'staff-meal-qr-scan', result });
        return result;
      });
    }
  },
  inventory: {
    receive(data) {
      return apiRequest('/api/inventory/receive', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    adjust(data) {
      return apiRequest('/api/inventory/adjust', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    transfer(data) {
      return apiRequest('/api/inventory/transfer', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    completeProduction(id, data = {}) {
      return apiRequest(`/api/inventory/production/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('Production', { action: 'complete', result, id });
        if (result?.produced_item_batch) {
          emitEntityChange('ProducedItemBatch', { action: 'create', result: result.produced_item_batch });
        }
        return result;
      });
    },
    getProductionCompletionJob(id) {
      return apiRequest(`/api/inventory/production/${id}/completion-job`);
    },
    getProductionReversalBlockers(id) {
      return apiRequest(`/api/inventory/production/${id}/reversal-blockers`);
    },
    repairProductionReversalBalance(id, data = {}) {
      return apiRequest(`/api/inventory/production/${id}/repair-reversal-balance`, {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('ProducedItemBatch', { action: 'repair-reversal-balance', result: result?.produced_item_batch });
        emitEntityChange('Production', { action: 'repair-reversal-balance', result, id });
        return result;
      });
    },
    reverseCompletedProduction(id, data = {}) {
      return apiRequest(`/api/inventory/production/${id}/reverse-completion`, {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('Production', { action: 'reverse-completion', result, id });
        emitEntityChange('ProducedItemBatch', { action: 'void', result: result?.voided_produced_item_batch });
        emitEntityChange('ProductionConsumptionReport', { action: 'reverse', result: result?.reversed_consumption_report });
        emitEntityChange('Inventory', { action: 'production-reversal', result });
        emitEntityChange('InventoryLot', { action: 'production-reversal', result });
        emitEntityChange('InventoryTransaction', { action: 'production-reversal', result });
        return result;
      });
    },
    partialReverseCompletedProduction(id, data = {}) {
      return apiRequest(`/api/inventory/production/${id}/partial-reverse-completion`, {
        method: 'POST',
        body: JSON.stringify(data)
      }).then((result) => {
        emitEntityChange('Production', { action: 'partial-reverse-completion', result, id });
        emitEntityChange('ProducedItemBatch', { action: 'partial-reverse', result: result?.adjusted_produced_item_batch });
        emitEntityChange('ProductionConsumptionReport', { action: 'partial-reverse', result: result?.partially_reversed_consumption_report });
        emitEntityChange('Inventory', { action: 'production-partial-reversal', result });
        emitEntityChange('InventoryLot', { action: 'production-partial-reversal', result });
        emitEntityChange('InventoryTransaction', { action: 'production-partial-reversal', result });
        return result;
      });
    },
    listLots(filters = {}) {
      return apiRequest(`/api/inventory/lots${buildQueryString(filters)}`);
    },
    getStockOnHand() {
      return apiRequest('/api/inventory/reports/stock-on-hand');
    },
    getMovements(filters = {}) {
      return apiRequest(`/api/inventory/reports/movements${buildQueryString(filters)}`);
    },
    getExpiryReport(filters = {}) {
      return apiRequest(`/api/inventory/reports/expiry${buildQueryString(filters)}`);
    },
    getVelocity(filters = {}) {
      return apiRequest(`/api/inventory/reports/velocity${buildQueryString(filters)}`);
    },
    getValuation(filters = {}) {
      return apiRequest(`/api/inventory/reports/valuation${buildQueryString(filters)}`);
    },
    getValueReport(filters = {}) {
      return apiRequest(`/api/inventory/reports/value-history${buildQueryString(filters)}`);
    }
  },
  erp: {
    export(data) {
      return apiRequest('/api/erp/export', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    listLogs() {
      return apiRequest('/api/erp/logs');
    },
    importInventory(data = {}) {
      return apiRequest('/api/erp/import/inventory', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    previewInventoryImport(data = {}) {
      return apiRequest('/api/erp/import/inventory/preview', {
        method: 'POST',
        body: JSON.stringify({ ...data, dry_run: true })
      });
    },
    importIngredients(data = {}) {
      return apiRequest('/api/erp/import/ingredients', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    getLogDetails(id, filters = {}) {
      return apiRequest(`/api/erp/logs/${id}/rows${buildQueryString(filters)}`);
    },
    retryLog(id) {
      return apiRequest(`/api/erp/logs/${id}/retry`, {
        method: 'POST',
        body: JSON.stringify({})
      });
    }
  },
  forecasting: {
    getSummary(filters = {}) {
      return apiRequest(`/api/forecasting/summary${buildQueryString(filters)}`);
    },
    runScenario(id) {
      return apiRequest(`/api/forecasting/scenarios/${id}/run`, {
        method: 'POST',
        body: JSON.stringify({})
      });
    }
  },
  utilities: {
    listModules() {
      return apiRequest('/api/utilities/modules');
    },
    downloadTemplate(moduleKey) {
      return apiBlobRequest(`/api/utilities/templates/${encodeURIComponent(moduleKey)}`);
    },
    submitBulkUpload({ module, import_mode, file, project_id, site_id, site_name, source_name, recipe_type, menu_cuisine, menu_category }) {
      const formData = new FormData();
      formData.append('module', module);
      formData.append('import_mode', import_mode || 'keep_existing');
      if (file) formData.append('file', file);
      if (project_id) formData.append('project_id', project_id);
      if (site_id) formData.append('site_id', site_id);
      if (site_name) formData.append('site_name', site_name);
      if (source_name) formData.append('source_name', source_name);
      if (recipe_type) formData.append('recipe_type', recipe_type);
      if (menu_cuisine) formData.append('menu_cuisine', menu_cuisine);
      if (menu_category) formData.append('menu_category', menu_category);
      return apiRequest('/api/utilities/bulk-upload', {
        method: 'POST',
        body: formData,
        headers: {}
      });
    },
    getReport(moduleKey, limit = 500) {
      return apiRequest(`/api/utilities/reports/${encodeURIComponent(moduleKey)}${buildQueryString({ limit })}`);
    }
  },
  activity: {
    listNotifications(limit = 50) {
      return apiRequest(`/api/activity/notifications${buildQueryString({ limit })}`);
    },
    listBulkUploadJobs(limit = 100) {
      return apiRequest(`/api/activity/bulk-upload-jobs${buildQueryString({ limit })}`);
    },
    getBulkUploadJob(id) {
      return apiRequest(`/api/activity/bulk-upload-jobs/${encodeURIComponent(id)}`);
    },
    listAuditLogs(filters = {}) {
      return apiRequest(`/api/activity/audit-logs${buildQueryString(filters)}`);
    }
  },
  recipes: {
    syncIngredientUnits({ changes = [] } = {}) {
      return apiRequest('/api/recipes/sync-ingredient-units', {
        method: 'POST',
        body: JSON.stringify({ changes })
      });
    }
  },
  integrations: {
    Core: {
      UploadFile({ file }) {
        const formData = new FormData();
        formData.append('file', file);
        return apiRequest('/api/integrations/upload', {
          method: 'POST',
          body: formData,
          headers: {}
        });
      },
      UploadRecipeImage({ file }) {
        const formData = new FormData();
        formData.append('file', file);
        return apiRequest('/api/integrations/recipe-image', {
          method: 'POST',
          body: formData,
          headers: {}
        });
      },
      UploadWasteImage({ file }) {
        const formData = new FormData();
        formData.append('file', file);
        return apiRequest('/api/integrations/waste-image', {
          method: 'POST',
          body: formData,
          headers: {}
        });
      },
      SendEmail(payload) {
        return apiRequest('/api/integrations/send-email', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      },
      InvokeLLM(payload) {
        return apiRequest('/api/integrations/invoke-llm', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      },
      ExtractDataFromUploadedFile(payload) {
        return apiRequest('/api/integrations/extract-file', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }
    }
  },
  appLogs: {
    logUserInApp(pageName) {
      return apiRequest('/api/app-logs', {
        method: 'POST',
        body: JSON.stringify({ pageName })
      });
    }
  }
};
