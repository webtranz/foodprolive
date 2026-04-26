import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import nodemailer from 'nodemailer';
import {
  uploadsDir,
  listDocuments,
  findDocument,
  createDocument,
  updateDocument,
  deleteDocument,
  initDatabase,
  getUserByToken,
  revokeToken,
  loginUser,
  inviteUser,
  createAppLog,
  createEmailLog
} from './db.js';
import { authorizeEntityAction, ensureKnownEntity } from './entities.js';
import {
  getPosSources,
  createPosSource,
  updatePosSource,
  deletePosSource,
  getRecipeMappings,
  createRecipeMapping,
  updateRecipeMapping,
  deleteRecipeMapping,
  getSyncLogs,
  importPosOrders,
  syncPosSource,
  getDailySalesSummary,
  getSalesProductionVariance
} from './pos.js';
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  listPurchaseRequests,
  createPurchaseRequest,
  approvePurchaseRequest,
  autoGeneratePurchaseRequestFromLowStock,
  listPurchaseOrders,
  createPurchaseOrder,
  approvePurchaseOrder,
  cancelPurchaseOrder,
  listGoodsReceipts,
  createGoodsReceipt,
  listSupplierInvoices,
  createSupplierInvoice,
  listSupplierPriceComparison,
  getSupplierPerformanceDashboard
} from './procurement.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const rootDir = path.resolve(process.cwd());
const distDir = path.join(rootDir, 'dist');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadsDir),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname || '');
    const baseName = path.basename(file.originalname || 'upload', extension).replace(/[^a-zA-Z0-9-_]/g, '-');
    callback(null, `${Date.now()}-${baseName}${extension}`);
  }
});

const upload = multer({ storage });

function getBearerToken(request) {
  const header = request.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function requireAuth(request, response, next) {
  const token = getBearerToken(request);
  const user = await getUserByToken(token);

  if (!user) {
    return response.status(401).json({ message: 'Authentication required' });
  }

  request.user = user;
  request.token = token;
  return next();
}

function requireRole(roles) {
  return (request, response, next) => {
    if (!request.user || !roles.includes(request.user.role)) {
      return response.status(403).json({ message: 'You do not have permission to access this resource' });
    }
    return next();
  };
}

function numericMatch(input, fallback = 0) {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function parseAvailableIngredients(prompt = '') {
  const section = prompt.split('Available Ingredients')[1] || '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .slice(0, 8)
    .map((line, index) => {
      const match = line.match(/-\s*(.+?)\s+\(([\d.]+)\s*(.*?)\)/);
      if (!match) {
        return { ingredient_name: line.replace(/^-/, '').trim(), quantity: index + 1, unit: 'unit' };
      }
      return {
        ingredient_name: match[1].trim(),
        quantity: Math.max(1, Math.round(numericMatch(match[2], index + 1) / 4)),
        unit: match[3] || 'unit'
      };
    });
}

function inferRecipeCategory(prompt = '') {
  const match = prompt.match(/Meal Category:\s*(.+)/i);
  return match?.[1]?.trim() || 'main_course';
}

function inferCuisine(prompt = '') {
  const match = prompt.match(/Cuisine Type:\s*(.+)/i);
  return match?.[1]?.trim() || 'continental';
}

function invokeFallbackLLM(prompt, schema) {
  const properties = schema?.properties || {};

  if (properties.name && properties.ingredients && properties.instructions) {
    const cuisine = inferCuisine(prompt);
    const category = inferRecipeCategory(prompt);
    const ingredients = parseAvailableIngredients(prompt);

    return {
      name: `${cuisine[0].toUpperCase()}${cuisine.slice(1)} ${category.replace(/_/g, ' ')}`.trim(),
      description: `A practical ${cuisine} ${category.replace(/_/g, ' ')} recipe generated from current inventory.`,
      ingredients,
      instructions: [
        'Prepare and portion all ingredients before starting production.',
        'Cook aromatics and core ingredients until fragrant and evenly combined.',
        'Add the remaining ingredients in stages and monitor texture carefully.',
        'Adjust seasoning, simmer until cooked through, and verify internal temperature.',
        'Portion for service and garnish before dispatch.'
      ].join('\n'),
      prep_time_minutes: 20,
      cook_time_minutes: 35,
      calories_per_serving: 420,
      protein_per_serving: 24,
      carbs_per_serving: 38,
      fat_per_serving: 16
    };
  }

  if (properties.substitutions && properties.quantity_adjustments) {
    return {
      substitutions: [
        {
          original_ingredient: 'Premium cream',
          substitute: 'Evaporated milk',
          cost_savings: 4.5,
          impact_on_quality: 'Slightly lighter texture with similar richness.',
          flavor_profile_notes: 'Keeps the savory profile balanced and clean.'
        },
        {
          original_ingredient: 'Imported herbs',
          substitute: 'Local fresh herbs',
          cost_savings: 2.25,
          impact_on_quality: 'Freshness remains strong with lower procurement cost.',
          flavor_profile_notes: 'Use the same finishing quantity for aroma.'
        }
      ],
      quantity_adjustments: [
        {
          ingredient: 'Oil',
          current_quantity: 1,
          suggested_quantity: 0.8,
          reasoning: 'A modest reduction controls cost without affecting cooking performance.'
        }
      ],
      price_fluctuation_forecast: {
        increase_10_percent: 55,
        increase_20_percent: 60,
        decrease_10_percent: 45,
        decrease_20_percent: 40
      },
      optimization_summary: 'Prioritize locally sourced substitutes, tighten high-cost fat usage, and review garnish standards.'
    };
  }

  if (properties.tomorrow_estimate && properties.suggestions) {
    return {
      tomorrow_estimate: {
        labor_kg: 72,
        junior_kg: 38,
        senior_kg: 24,
        total_kg: 134,
        expected_attendance: 340
      },
      adjustment_percent: -8,
      adjustment_direction: 'reduce',
      suggestions: [
        'Reduce production slightly for low-demand categories and keep a fast replenishment buffer.',
        'Shift surplus side dishes into next-meal reusable preparations where safe.',
        'Track no-show rates by weekday and pre-cut fewer garnishes on low-demand days.'
      ],
      pattern_observation: 'Mid-week demand remains strongest while weekend attendance softens, increasing overproduction risk late in the week.',
      category_insights: [
        'Labor meals show the most stable demand.',
        'Junior demand varies more and benefits from conservative prep.',
        'Senior meals justify a smaller premium buffer because counts are lower.'
      ],
      waste_risk: 'medium'
    };
  }

  if (properties.detected_food_types && properties.waste_percentage) {
    return {
      detected_food_types: ['rice', 'chicken', 'vegetables'],
      waste_percentage: 34,
      estimated_waste_grams: 180,
      waste_category: 'plate_waste',
      confidence_score: 72,
      suggestions: [
        'Reduce rice portioning by 10% during low-demand periods.',
        'Offer smaller default portions with optional top-ups.',
        'Review menu acceptance for the protein item served in this meal.'
      ],
      cost_estimate: 1.8,
      observation: 'The remaining food suggests moderate plate waste from oversized portions.'
    };
  }

  return Object.fromEntries(
    Object.keys(properties).map((key) => [key, null])
  );
}

async function invokeOpenAI(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return invokeFallbackLLM(payload.prompt, payload.response_json_schema);
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: payload.prompt || 'Return a valid JSON object.' },
            ...((payload.file_urls || []).map((url) => ({
              type: 'input_image',
              image_url: url.startsWith('http') ? url : `${process.env.PUBLIC_APP_URL || `http://localhost:${port}`}${url}`
            })))
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'foodpro_response',
          schema: payload.response_json_schema || { type: 'object', properties: {} }
        }
      }
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`LLM request failed: ${message}`);
  }

  const result = await response.json();
  const textChunk = result.output?.[0]?.content?.find((item) => item.type === 'output_text')?.text;
  return textChunk ? JSON.parse(textChunk) : invokeFallbackLLM(payload.prompt, payload.response_json_schema);
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(',').map((item) => item.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((item) => item.trim());
    return Object.fromEntries(headers.map((header, index) => {
      const rawValue = values[index] ?? '';
      const numeric = Number(rawValue);
      return [header, Number.isFinite(numeric) && rawValue !== '' ? numeric : rawValue];
    }));
  });
}

function projectToSchema(rows, schema) {
  if (!schema?.properties?.data?.items?.properties) {
    return rows;
  }

  const targetShape = schema.properties.data.items.properties;
  return rows.map((row) => {
    const projected = {};
    for (const [key, rules] of Object.entries(targetShape)) {
      const sourceKey = Object.keys(row).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      const value = sourceKey ? row[sourceKey] : null;
      projected[key] = rules.type === 'number' ? numericMatch(value, 0) : value;
    }
    return projected;
  });
}

app.post('/api/auth/login', async (request, response) => {
  const { email, password } = request.body || {};
  const session = await loginUser(email || '', password || '');

  if (!session) {
    return response.status(401).json({ message: 'Invalid email or password' });
  }

  return response.json(session);
});

app.get('/api/auth/me', requireAuth, (request, response) => {
  response.json(request.user);
});

app.patch('/api/auth/me', requireAuth, async (request, response, next) => {
  try {
    authorizeEntityAction(request.user, 'User', 'update', request.body || {}, request.user);
    const updated = await updateDocument('User', request.user.id, request.body || {});
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, async (request, response) => {
  await revokeToken(request.token);
  response.status(204).send();
});

app.post('/api/users/invite', requireAuth, async (request, response, next) => {
  try {
    authorizeEntityAction(request.user, 'User', 'create');
    const invited = await inviteUser(request.body?.email, request.body?.role);
    response.json(invited);
  } catch (error) {
    next(error);
  }
});

app.get('/api/entities/:entity', requireAuth, async (request, response, next) => {
  try {
    const { entity } = request.params;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'list');
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    const records = await listDocuments(entity, {
      sort: request.query.sort,
      limit
    });
    response.json(records);
  } catch (error) {
    next(error);
  }
});

app.post('/api/entities/:entity/filter', requireAuth, async (request, response, next) => {
  try {
    const { entity } = request.params;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'filter');
    const records = await listDocuments(entity, {
      filters: request.body?.filters || {},
      sort: request.body?.sort,
      limit: request.body?.limit
    });
    response.json(records);
  } catch (error) {
    next(error);
  }
});

app.post('/api/entities/:entity', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'create', request.body || {});
    const record = await createDocument(entity, request.body || {});
    response.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/entities/:entity/:id', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    const existing = await findDocument(entity, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Record not found' });
    }
    authorizeEntityAction(request.user, entity, 'update', request.body || {}, existing);
    const updated = await updateDocument(entity, request.params.id, request.body || {});
    return response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/entities/:entity/:id', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    const existing = await findDocument(entity, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Record not found' });
    }
    authorizeEntityAction(request.user, entity, 'delete', null, existing);
    const removed = await deleteDocument(entity, request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'Record not found' });
    }
    return response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/integrations/upload', requireAuth, upload.single('file'), (request, response) => {
  response.json({ file_url: `/uploads/${request.file.filename}` });
});

app.post('/api/integrations/send-email', requireAuth, async (request, response) => {
  const payload = request.body || {};

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: payload.to,
      subject: payload.subject || 'FoodPro Notification',
      html: payload.html || payload.body || '<p>No content provided.</p>'
    });
  } else {
    await createEmailLog({
      ...payload,
      status: 'logged_only'
    });
  }

  response.json({ success: true });
});

app.post('/api/integrations/invoke-llm', requireAuth, async (request, response, next) => {
  try {
    const output = await invokeOpenAI(request.body || {});
    response.json(output);
  } catch (error) {
    next(error);
  }
});

app.post('/api/integrations/extract-file', requireAuth, async (request, response, next) => {
  try {
    const { file_url: fileUrl, json_schema: jsonSchema } = request.body || {};
    const localPath = fileUrl?.startsWith('/uploads/')
      ? path.join(uploadsDir, path.basename(fileUrl))
      : null;

    if (!localPath || !fs.existsSync(localPath)) {
      return response.status(404).json({ message: 'Uploaded file not found' });
    }

    const content = fs.readFileSync(localPath, 'utf8');
    const rows = projectToSchema(parseCsv(content), jsonSchema);
    response.json({
      status: 'success',
      output: { data: rows }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/app-logs', requireAuth, (request, response) => {
  createAppLog({
    page_name: request.body?.pageName,
    user_id: request.user.id,
    user_email: request.user.email,
    payload: request.body || {}
  }).then((log) => {
    response.status(201).json(log);
  }).catch((error) => {
    response.status(500).json({ message: error.message || 'Failed to create app log' });
  });
});

app.get('/api/pos/sources', requireAuth, requireRole(['admin']), async (_request, response, next) => {
  try {
    response.json(await getPosSources());
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/sources', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const created = await createPosSource(request.body || {});
    response.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/pos/sources/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const updated = await updatePosSource(request.params.id, request.body || {});
    if (!updated) {
      return response.status(404).json({ message: 'POS source not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/pos/sources/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const removed = await deletePosSource(request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'POS source not found' });
    }
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/mappings', requireAuth, requireRole(['admin', 'manager']), async (_request, response, next) => {
  try {
    response.json(await getRecipeMappings());
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/mappings', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const created = await createRecipeMapping(request.body || {});
    response.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/pos/mappings/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const updated = await updateRecipeMapping(request.params.id, request.body || {});
    if (!updated) {
      return response.status(404).json({ message: 'POS mapping not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/pos/mappings/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const removed = await deleteRecipeMapping(request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'POS mapping not found' });
    }
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/sync-logs', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const limit = request.query.limit ? Number(request.query.limit) : 100;
    response.json(await getSyncLogs(limit));
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/import/manual', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const result = await importPosOrders({
      sourceId: request.body?.source_id || null,
      syncType: 'manual_upload',
      actorEmail: request.user.email,
      orders: request.body?.orders || [],
      requestPayload: {
        source_id: request.body?.source_id || null,
        order_count: Array.isArray(request.body?.orders) ? request.body.orders.length : 0
      }
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/sources/:id/sync', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const result = await syncPosSource(request.params.id, request.user.email);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/sales-summary', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    response.json(await getDailySalesSummary({
      startDate: request.query.start_date,
      endDate: request.query.end_date,
      locationId: request.query.location_id
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/variance-report', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    response.json(await getSalesProductionVariance({
      startDate: request.query.start_date,
      endDate: request.query.end_date,
      locationId: request.query.location_id
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/webhooks/:sourceId', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const payload = Array.isArray(request.body?.orders) ? request.body.orders : (Array.isArray(request.body) ? request.body : []);
    const result = await importPosOrders({
      sourceId: request.params.sourceId,
      syncType: 'webhook',
      actorEmail: request.user.email,
      orders: payload,
      requestPayload: { sourceId: request.params.sourceId, webhook: true }
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/suppliers', requireAuth, async (_request, response, next) => {
  try {
    response.json(await listSuppliers());
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/suppliers', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    response.status(201).json(await createSupplier(request.body || {}));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/procurement/suppliers/:id', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const updated = await updateSupplier(request.params.id, request.body || {});
    if (!updated) {
      return response.status(404).json({ message: 'Supplier not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/procurement/suppliers/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const removed = await deleteSupplier(request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'Supplier not found' });
    }
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/requests', requireAuth, async (_request, response, next) => {
  try {
    response.json(await listPurchaseRequests());
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests', requireAuth, async (request, response, next) => {
  try {
    response.status(201).json(await createPurchaseRequest(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests/auto-generate', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    response.status(201).json(await autoGeneratePurchaseRequestFromLowStock(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests/:id/approve', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const updated = await approvePurchaseRequest(request.params.id, { ...(request.body || {}), status: 'approved' }, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase request not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests/:id/reject', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const updated = await approvePurchaseRequest(request.params.id, { ...(request.body || {}), status: 'rejected' }, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase request not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/orders', requireAuth, async (_request, response, next) => {
  try {
    response.json(await listPurchaseOrders());
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/orders', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    response.status(201).json(await createPurchaseOrder(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/orders/:id/approve', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const updated = await approvePurchaseOrder(request.params.id, request.body || {}, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase order not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/orders/:id/cancel', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const updated = await cancelPurchaseOrder(request.params.id, request.body || {}, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase order not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/receipts', requireAuth, async (_request, response, next) => {
  try {
    response.json(await listGoodsReceipts());
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/receipts', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    response.status(201).json(await createGoodsReceipt(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/invoices', requireAuth, async (_request, response, next) => {
  try {
    response.json(await listSupplierInvoices());
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/invoices', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    response.status(201).json(await createSupplierInvoice(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/price-comparison', requireAuth, async (request, response, next) => {
  try {
    response.json(await listSupplierPriceComparison({
      ingredientId: request.query.ingredient_id,
      supplierId: request.query.supplier_id
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/performance', requireAuth, requireRole(['admin', 'manager']), async (_request, response, next) => {
  try {
    response.json(await getSupplierPerformanceDashboard());
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/') || request.path.startsWith('/uploads/')) {
      return next();
    }
    return response.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ message: error.message || 'Internal server error' });
});

await initDatabase();

app.listen(port, () => {
  console.log(`FoodPro server listening on port ${port}`);
});
