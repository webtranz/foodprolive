import assert from 'node:assert/strict';

import {
  SAR_SYMBOL,
  formatCurrency,
  replaceVisibleUSDCurrency
} from '../src/lib/currency.js';

const cases = [
  {
    name: 'formats integer amounts with Saudi Riyal sign',
    run() {
      assert.equal(
        formatCurrency(123, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
        `${SAR_SYMBOL} 123`
      );
    }
  },
  {
    name: 'formats decimal amounts with Saudi Riyal sign',
    run() {
      assert.equal(formatCurrency(123.45), `${SAR_SYMBOL} 123.45`);
    }
  },
  {
    name: 'formats negative amounts with Saudi Riyal sign',
    run() {
      assert.equal(
        formatCurrency(-50, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
        `-${SAR_SYMBOL} 50`
      );
    }
  },
  {
    name: 'replaces visible USD display labels safely',
    run() {
      assert.equal(
        replaceVisibleUSDCurrency('Total: $123.45 (USD)'),
        `Total: ${SAR_SYMBOL} 123.45 (${SAR_SYMBOL})`
      );
    }
  },
  {
    name: 'never substitutes a currency code or unrelated symbol',
    run() {
      const display = replaceVisibleUSDCurrency('SAR 10, AED 20, USD 30, ₹40, $50');
      assert.equal(display, `${SAR_SYMBOL} 10, ${SAR_SYMBOL} 20, ${SAR_SYMBOL} 30, ${SAR_SYMBOL} 40, ${SAR_SYMBOL} 50`);
      assert.equal(formatCurrency(10, { showCode: true }), `${SAR_SYMBOL} 10.00`);
    }
  },
  {
    name: 'does not corrupt template interpolation syntax',
    run() {
      assert.equal(
        replaceVisibleUSDCurrency('Total is ${amount} and fallback is $123'),
        `Total is \${amount} and fallback is ${SAR_SYMBOL} 123`
      );
    }
  }
];

let failed = false;

for (const testCase of cases) {
  try {
    testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`PASS ${cases.length} currency tests`);
}
