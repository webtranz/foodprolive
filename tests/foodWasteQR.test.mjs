import assert from 'node:assert/strict';

import {
  FOOD_WASTE_QR_CATEGORY,
  buildFoodWasteQrPayload,
  buildFoodWasteQrScanUrl,
  createFoodWasteQrToken,
  isFoodWasteQrCode
} from '../server/foodWasteQr.js';

const cases = [
  {
    name: 'builds a food waste QR scan url for the QR route',
    run() {
      const url = buildFoodWasteQrScanUrl('https://food.example.com/', 'token-123');
      assert.equal(url, 'https://food.example.com/FoodWasteQR?token=token-123');
    }
  },
  {
    name: 'creates prefixed QR tokens',
    run() {
      const token = createFoodWasteQrToken(() => Buffer.from('a'.repeat(24)));
      assert.ok(token.startsWith('fwqr_'));
      assert.ok(token.length > 10);
    }
  },
  {
    name: 'builds a unit-scoped food waste QR payload',
    run() {
      const payload = buildFoodWasteQrPayload({
        site: { id: 'site-1', name: 'ABQAIQ CAMP' },
        baseUrl: 'https://food.example.com',
        token: 'token-123',
        createdBy: 'chef@tamimi.local'
      });

      assert.equal(payload.category, FOOD_WASTE_QR_CATEGORY);
      assert.equal(payload.site_id, 'site-1');
      assert.equal(payload.linked_page, 'FoodWasteQR');
      assert.equal(payload.scan_url, 'https://food.example.com/FoodWasteQR?token=token-123');
      assert.equal(payload.status, 'active');
    }
  },
  {
    name: 'recognizes valid food waste qr records only',
    run() {
      assert.equal(isFoodWasteQrCode({
        category: FOOD_WASTE_QR_CATEGORY,
        token: 'token-123',
        site_id: 'site-1'
      }), true);

      assert.equal(isFoodWasteQrCode({
        category: 'custom',
        token: 'token-123',
        site_id: 'site-1'
      }), false);
    }
  }
];

let failures = 0;
for (const testCase of cases) {
  try {
    testCase.run();
    process.stdout.write(`ok - ${testCase.name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok - ${testCase.name}\n${error.stack}\n`);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
