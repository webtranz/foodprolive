import { Client } from 'pg';

const CHANNEL = 'foodpro_entity_events';
const realtimeConnectionString = String(
  process.env.REALTIME_DATABASE_URL
  || process.env.DATABASE_URL
  || `postgresql://${encodeURIComponent(process.env.POSTGRES_USER || 'foodpro')}:${encodeURIComponent(process.env.POSTGRES_PASSWORD || 'foodpro')}@${process.env.POSTGRES_HOST || '127.0.0.1'}:${process.env.POSTGRES_PORT || '5432'}/${encodeURIComponent(process.env.POSTGRES_DB || 'foodpro')}`
).trim();
const listeners = new Set();
let listenerClient = null;
let connectPromise = null;
let reconnectTimer = null;

function dispatch(payload) {
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return;
  }
  listeners.forEach((listener) => {
    try {
      listener(event);
    } catch (error) {
      console.warn(`Realtime event listener failed: ${error.message}`);
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer || listeners.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureListener().catch((error) => {
      console.warn(`Realtime database listener reconnect failed: ${error.message}`);
      scheduleReconnect();
    });
  }, 1000);
  reconnectTimer.unref?.();
}

async function ensureListener() {
  if (listenerClient) return listenerClient;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const client = new Client({
      connectionString: realtimeConnectionString,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
      application_name: 'foodpro-realtime-listener'
    });
    await client.connect();
    client.on('notification', (message) => {
      if (message.channel === CHANNEL && message.payload) dispatch(message.payload);
    });
    client.on('error', (error) => {
      console.warn(`Realtime database listener disconnected: ${error.message}`);
      if (listenerClient === client) listenerClient = null;
      client.end().catch(() => {});
      scheduleReconnect();
    });
    client.on('end', () => {
      if (listenerClient === client) listenerClient = null;
      scheduleReconnect();
    });
    await client.query(`LISTEN ${CHANNEL}`);
    listenerClient = client;
    return client;
  })().finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

export async function subscribeToEntityEvents(listener) {
  listeners.add(listener);
  try {
    await ensureListener();
  } catch (error) {
    listeners.delete(listener);
    throw error;
  }
  return () => {
    listeners.delete(listener);
  };
}

export async function closeRealtime() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  listeners.clear();
  const client = listenerClient;
  listenerClient = null;
  if (client) {
    await client.query(`UNLISTEN ${CHANNEL}`).catch(() => {});
    await client.end().catch(() => {});
  }
}
