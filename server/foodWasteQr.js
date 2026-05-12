import crypto from 'node:crypto';

export const FOOD_WASTE_QR_CATEGORY = 'food_waste_recording';

export function createFoodWasteQrToken(randomBytes = crypto.randomBytes) {
  return `fwqr_${randomBytes(24).toString('hex')}`;
}

export function buildFoodWasteQrScanUrl(baseUrl, token) {
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  const normalizedToken = String(token || '').trim();
  if (!normalizedBaseUrl || !normalizedToken) {
    return '';
  }
  return `${normalizedBaseUrl}/FoodWasteQR?token=${encodeURIComponent(normalizedToken)}`;
}

export function isFoodWasteQrCode(record) {
  return String(record?.category || '').trim().toLowerCase() === FOOD_WASTE_QR_CATEGORY
    && Boolean(String(record?.token || '').trim())
    && Boolean(String(record?.site_id || record?.linked_item || '').trim());
}

export function buildFoodWasteQrPayload({
  site,
  baseUrl,
  token,
  existing = null,
  createdBy = null
}) {
  const siteId = String(site?.id || '').trim();
  const siteName = String(site?.name || '').trim();
  const scanUrl = buildFoodWasteQrScanUrl(baseUrl, token);

  return {
    title: `Food Waste - ${siteName || 'Unit'}`,
    category: FOOD_WASTE_QR_CATEGORY,
    description: `Unit-level Food Waste Recording access for ${siteName || siteId}.`,
    linked_item: siteId,
    linked_page: 'FoodWasteQR',
    site_id: siteId,
    site_name: siteName,
    token,
    scan_url: scanUrl,
    status: 'active',
    is_one_time: false,
    max_scans: 0,
    scan_count: Number(existing?.scan_count || 0),
    created_by: createdBy,
    last_refreshed_at: new Date().toISOString()
  };
}
