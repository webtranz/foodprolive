const ACCESS_TOKEN_KEY = 'foodpro_access_token';
const eventBus = new EventTarget();

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

const entityCacheKey = (entity) => `entity:${entity}`;

function emitEntityChange(entity, detail = {}) {
  eventBus.dispatchEvent(new CustomEvent(entityCacheKey(entity), { detail }));
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
    list(sort, limit) {
      const params = new URLSearchParams();
      if (sort) params.set('sort', sort);
      if (typeof limit === 'number') params.set('limit', String(limit));
      return apiRequest(`/api/entities/${entity}?${params.toString()}`);
    },
    filter(filters = {}, sort, limit) {
      return apiRequest(`/api/entities/${entity}/filter`, {
        method: 'POST',
        body: JSON.stringify({ filters, sort, limit })
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
    delete(id) {
      return apiRequest(`/api/entities/${entity}/${id}`, {
        method: 'DELETE'
      }).then((result) => {
        emitEntityChange(entity, { action: 'delete', result, id });
        return result;
      });
    },
    subscribe(callback) {
      const handler = (event) => callback(event.detail);
      eventBus.addEventListener(entityCacheKey(entity), handler);
      return () => eventBus.removeEventListener(entityCacheKey(entity), handler);
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
    }
  },
  menuPlanning: {
    getByDate(siteId, planDate) {
      return apiRequest(`/api/menu-plans/by-date${buildQueryString({ site_id: siteId, plan_date: planDate })}`);
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
    completeProduction(id) {
      return apiRequest(`/api/inventory/production/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({})
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
    getValuation() {
      return apiRequest('/api/inventory/reports/valuation');
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
