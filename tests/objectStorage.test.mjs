import assert from 'node:assert/strict';

import {
  createObjectKey,
  isObjectReference,
  keyFromObjectReference,
  objectReference,
  proxiedObjectPath,
  publicObjectPath
} from '../server/objectStorage.js';

const key = createObjectKey('Recipe Picture (Final).PNG', 'recipe-images');
assert.match(key, /^recipe-images\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+-Recipe-Picture--Final-\.png$/);

const reference = objectReference(key);
assert.equal(isObjectReference(reference), true);
assert.equal(keyFromObjectReference(reference), key);
assert.equal(keyFromObjectReference('/tmp/example.csv'), null);
assert.equal(publicObjectPath('recipe-images/menu image.png'), '/files/recipe-images/menu%20image.png');
assert.equal(proxiedObjectPath('recipe-images/menu image.png'), '/files/recipe-images/menu%20image.png');

console.log('Object storage reference tests passed.');
