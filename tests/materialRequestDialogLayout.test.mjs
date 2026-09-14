import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/pages/MaterialRequests.jsx', import.meta.url), 'utf8');

test('acknowledgement dialog keeps actions visible inside the viewport', () => {
  const dialogStart = source.indexOf('<Dialog open={Boolean(selectedRequest)}');
  const dialogEnd = source.indexOf('</Dialog>', dialogStart);
  assert.ok(dialogStart >= 0, 'acknowledgement dialog should exist');
  assert.ok(dialogEnd > dialogStart, 'acknowledgement dialog should close');
  const dialog = source.slice(dialogStart, dialogEnd);

  assert.match(dialog, /DialogContent className="[^"]*max-h-\[92vh\][^"]*overflow-hidden/);
  assert.match(dialog, /className="[^"]*min-h-0[^"]*flex-1[^"]*overflow-y-auto/);
  assert.match(dialog, /className="[^"]*max-h-\[45vh\][^"]*overflow-y-auto/);
  assert.match(dialog, /DialogFooter className="[^"]*shrink-0[^"]*border-t/);
  assert.match(dialog, /Confirm Acknowledgement/);
});
