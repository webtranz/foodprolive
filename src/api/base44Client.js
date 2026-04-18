const ACCESS_TOKEN_KEY = 'foodpro_access_token';
const eventBus = new EventTarget();

const getStoredToken = () => window.localStorage.getItem(ACCESS_TOKEN_KEY);
const setStoredToken = (token) => window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
const clearStoredToken = () => window.localStorage.removeItem(ACCESS_TOKEN_KEY);

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
    async login(email, password) {
      const session = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      setStoredToken(session.token);
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
