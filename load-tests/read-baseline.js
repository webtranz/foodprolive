import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const baseUrl = String(__ENV.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const targetUsers = Math.max(1, Number(__ENV.TARGET_USERS || 1000));
const userPool = new SharedArray('foodpro-load-users', () => {
  if (!__ENV.USER_POOL_FILE) return [];
  const parsed = JSON.parse(open(__ENV.USER_POOL_FILE));
  if (!Array.isArray(parsed)) throw new Error('USER_POOL_FILE must contain a JSON array.');
  return parsed;
});

export const options = {
  scenarios: {
    daily_operations: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP_UP || '5m', target: targetUsers },
        { duration: __ENV.HOLD || '15m', target: targetUsers },
        { duration: __ENV.RAMP_DOWN || '2m', target: 0 }
      ],
      gracefulRampDown: '30s'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{operation:entity-page}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{operation:ingredient-search}': ['p(95)<400', 'p(99)<800'],
    checks: ['rate>0.99']
  }
};

function credentialForVu() {
  if (userPool.length > 0) {
    return userPool[(exec.vu.idInTest - 1) % userPool.length];
  }
  return {
    email: __ENV.TEST_EMAIL,
    password: __ENV.TEST_PASSWORD
  };
}

function login() {
  const credentials = credentialForVu();
  if (!credentials?.email || !credentials?.password) {
    throw new Error('Provide TEST_EMAIL/TEST_PASSWORD or USER_POOL_FILE.');
  }
  const response = http.post(`${baseUrl}/api/auth/login`, JSON.stringify(credentials), {
    headers: { 'Content-Type': 'application/json' },
    tags: { operation: 'login' }
  });
  check(response, { 'login succeeds': (result) => result.status === 200 });
  return response.json('token');
}

let accessToken = null;

function authenticatedHeaders() {
  if (!accessToken) accessToken = login();
  return {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  };
}

function page(entity, filters, sort, limit = 50) {
  const response = http.post(
    `${baseUrl}/api/entities/${entity}/page`,
    JSON.stringify({ filters, sort, page: 1, limit }),
    { ...authenticatedHeaders(), tags: { operation: 'entity-page', entity } }
  );
  check(response, {
    [`${entity} page succeeds`]: (result) => result.status === 200,
    [`${entity} page is bounded`]: (result) => {
      const items = result.json('items');
      return Array.isArray(items) && items.length <= limit;
    }
  });
}

export default function () {
  const productionDate = __ENV.PRODUCTION_DATE || new Date().toISOString().slice(0, 10);
  page('Production', { production_date: productionDate }, '-production_date', 50);
  page('MenuPlan', { plan_date: productionDate }, '-plan_date', 25);
  page('Inventory', {}, 'ingredient_name', 50);

  const ingredientResponse = http.get(
    `${baseUrl}/api/ingredients/search?q=corn&page=1&limit=20`,
    { ...authenticatedHeaders(), tags: { operation: 'ingredient-search' } }
  );
  check(ingredientResponse, {
    'ingredient search succeeds': (result) => result.status === 200,
    'ingredient search is paginated': (result) => Array.isArray(result.json('items'))
  });

  sleep(__ENV.THINK_TIME_SECONDS ? Number(__ENV.THINK_TIME_SECONDS) : 1 + Math.random() * 2);
}
