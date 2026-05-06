import assert from 'node:assert/strict';

import {
  SAR_CODE,
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
        `Total: ${SAR_SYMBOL} 123.45 (${SAR_CODE})`
      );
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
