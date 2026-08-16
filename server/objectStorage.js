import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const endpointValue = String(process.env.OBJECT_STORAGE_ENDPOINT || '').trim();
const bucket = String(process.env.OBJECT_STORAGE_BUCKET || '').trim();
const accessKey = String(process.env.OBJECT_STORAGE_ACCESS_KEY || '').trim();
const secretKey = String(process.env.OBJECT_STORAGE_SECRET_KEY || '').trim();
const sessionToken = String(process.env.OBJECT_STORAGE_SESSION_TOKEN || '').trim();
const region = String(process.env.OBJECT_STORAGE_REGION || 'us-east-1').trim();
const forcePathStyle = process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false';
const publicBaseUrl = String(process.env.OBJECT_STORAGE_PUBLIC_URL || '').trim().replace(/\/$/, '');

export const objectStorageEnabled = Boolean(endpointValue && bucket && accessKey && secretKey);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding = undefined) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function encodedObjectKey(key) {
  return String(key).split('/').filter(Boolean).map(encodePathSegment).join('/');
}

function buildObjectUrl(key) {
  const url = new URL(endpointValue);
  const endpointPath = url.pathname.replace(/\/$/, '');
  const encodedKey = encodedObjectKey(key);
  if (forcePathStyle) {
    url.pathname = `${endpointPath}/${encodePathSegment(bucket)}/${encodedKey}`;
  } else {
    url.hostname = `${bucket}.${url.hostname}`;
    url.pathname = `${endpointPath}/${encodedKey}`;
  }
  return url;
}

function signingHeaders(method, url, payload, contentType = '') {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(payload);
  const headerValues = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  if (sessionToken) headerValues['x-amz-security-token'] = sessionToken;
  const signedHeaderNames = Object.keys(headerValues).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headerValues[name]}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');
  const dateKey = hmac(`AWS4${secretKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');

  return {
    ...headerValues,
    ...(contentType ? { 'content-type': contentType } : {}),
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

async function objectRequest(method, key, body = Buffer.alloc(0), contentType = '') {
  if (!objectStorageEnabled) throw new Error('Shared object storage is not configured.');
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  const url = buildObjectUrl(key);
  const response = await fetch(url, {
    method,
    headers: signingHeaders(method, url, payload, contentType),
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: payload })
  });
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Object storage ${method} failed (${response.status})${details ? `: ${details.slice(0, 300)}` : ''}`);
  }
  return response;
}

export function createObjectKey(originalName = 'upload', prefix = 'uploads') {
  const extension = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const safeBase = path.basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .slice(0, 80) || 'upload';
  return `${prefix}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeBase}${extension}`;
}

export function objectReference(key) {
  return `object://${key}`;
}

export function isObjectReference(value) {
  return String(value || '').startsWith('object://');
}

export function keyFromObjectReference(value) {
  return isObjectReference(value) ? String(value).slice('object://'.length) : null;
}

export function publicObjectPath(key) {
  const objectPath = encodedObjectKey(key);
  return publicBaseUrl ? `${publicBaseUrl}/${objectPath}` : `/files/${objectPath}`;
}

export function proxiedObjectPath(key) {
  return `/files/${encodedObjectKey(key)}`;
}

export async function putStoredObject(key, buffer, contentType = 'application/octet-stream') {
  await objectRequest('PUT', key, buffer, contentType);
  return objectReference(key);
}

export async function getStoredObject(key) {
  const response = await objectRequest('GET', key);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    contentLength: Number(response.headers.get('content-length') || 0)
  };
}

export async function deleteStoredObject(key) {
  await objectRequest('DELETE', key);
}

export async function materializeStoredReference(reference) {
  if (!isObjectReference(reference)) {
    return { path: reference, cleanup: async () => {} };
  }
  const key = keyFromObjectReference(reference);
  const object = await getStoredObject(key);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'foodpro-upload-'));
  const temporaryPath = path.join(temporaryDirectory, path.basename(key) || 'upload');
  await fs.writeFile(temporaryPath, object.buffer);
  return {
    path: temporaryPath,
    cleanup: async () => fs.rm(temporaryDirectory, { recursive: true, force: true })
  };
}

export async function removeStoredReference(reference) {
  if (isObjectReference(reference)) {
    return deleteStoredObject(keyFromObjectReference(reference));
  }
  if (reference) await fs.unlink(reference).catch(() => {});
}
