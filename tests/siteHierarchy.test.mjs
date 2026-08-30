import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  buildCanonicalHierarchyFields,
  getAllowedParentSites,
  getVisibleHierarchyRoots,
  normalizeSiteType,
  SITE_HIERARCHY_TYPES,
  validateCanonicalSiteParent,
  validateSiteChildrenForParent
} from '../shared/siteHierarchy.js';

const area = { id: 'area-west', name: 'Western Area', type: 'area' };
const legacyArea = { id: 'region-west', name: 'Legacy Western Region', type: 'region' };
const project = { id: 'project-jeddah', name: 'Jeddah Project', type: 'project', parent_site_id: area.id };
const legacyProject = { id: 'camp-taif', name: 'Taif Camp', type: 'camp', parent_site_id: legacyArea.id };
const store = { id: 'store-main', name: 'Main Store', type: 'store', parent_site_id: project.id };

assert.equal(normalizeSiteType('region'), SITE_HIERARCHY_TYPES.AREA);
assert.equal(normalizeSiteType('location'), SITE_HIERARCHY_TYPES.PROJECT);
assert.equal(normalizeSiteType('warehouse'), SITE_HIERARCHY_TYPES.STORE);
assert.equal(normalizeSiteType('kitchen'), SITE_HIERARCHY_TYPES.STORE);

assert.equal(validateCanonicalSiteParent({ type: 'area' }), null);
assert.match(
  validateCanonicalSiteParent({ type: 'area', parent: project, parentId: project.id }),
  /top-level/
);
assert.equal(
  validateCanonicalSiteParent({ type: 'project', parent: area, parentId: area.id }),
  null
);
assert.equal(
  validateCanonicalSiteParent({ type: 'project', parent: legacyArea, parentId: legacyArea.id }),
  null
);
assert.match(validateCanonicalSiteParent({ type: 'project' }), /under an? Area/i);
assert.equal(
  validateCanonicalSiteParent({ type: 'store', parent: legacyProject, parentId: legacyProject.id }),
  null
);
assert.match(
  validateCanonicalSiteParent({ type: 'store', parent: area, parentId: area.id }),
  /under a Project/i
);

assert.deepEqual(
  getAllowedParentSites('project', [area, legacyArea, project, legacyProject, store]).map((site) => site.id),
  [area.id, legacyArea.id]
);
assert.deepEqual(
  getAllowedParentSites('store', [area, legacyArea, project, legacyProject, store]).map((site) => site.id),
  [project.id, legacyProject.id]
);

assert.deepEqual(
  getVisibleHierarchyRoots([project, store]).map((site) => site.id),
  [project.id],
  'a project must become the visible root when its area is outside the returned scope'
);
assert.deepEqual(
  getVisibleHierarchyRoots([store]).map((site) => site.id),
  [store.id],
  'an assigned store must render even when its project is outside the returned scope'
);

assert.equal(validateSiteChildrenForParent(area, [project]), null);
assert.equal(validateSiteChildrenForParent(project, [store]), null);
assert.match(
  validateSiteChildrenForParent(project, [{ id: 'child-project', name: 'Child Project', type: 'project' }]),
  /Child Project cannot remain.*under an? Area/i
);
assert.match(
  validateSiteChildrenForParent(area, [{ id: 'child-area', name: 'Child Area', type: 'area' }]),
  /Child Area cannot remain.*top-level/i
);

assert.deepEqual(
  buildCanonicalHierarchyFields({
    ancestors: [
      { id: 'company', name: 'Legacy Company', type: 'company' },
      legacyArea,
      project
    ],
    site: store
  }),
  {
    area_name: legacyArea.name,
    project_name: project.name,
    store_name: store.name,
    region_name: legacyArea.name,
    location_name: project.name,
    storage_name: store.name
  }
);

const [sitesPage, entityClient, entityPreparation, database, entities] = await Promise.all([
  fs.readFile(new URL('../src/pages/Sites.jsx', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/api/base44Client.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../server/entityPreparation.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../server/db.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../server/entities.js', import.meta.url), 'utf8')
]);

assert.match(sitesPage, /Area → Project → Store/);
assert.match(sitesPage, /getAllowedParentSites/);
assert.match(sitesPage, /getVisibleHierarchyRoots\(sites\)/);
assert.match(entityPreparation, /validateCanonicalSiteParent/);
assert.match(database, /isCanonicalSiteType\(record\.type\)/);
assert.match(database, /validateSiteChildrenAfterStructureChange/);
assert.match(entities, /SUPPORTED_SITE_TYPES/);

if (/deleteSiteSubtree/.test(database)) {
  assert.match(entityClient, /includeDescendants[\s\S]*include_descendants=true/);
  assert.match(sitesPage, /Site\.delete\(id, \{ includeDescendants: true \}\)/);
  assert.match(sitesPage, /onError:[\s\S]*setDeleteError/);
  assert.match(sitesPage, /deleteMutation\.isPending/);
  assert.match(sitesPage, /role="alert"/);
  assert.match(
    database,
    /clearDocumentsForBulk[\s\S]*entity === 'Site'[\s\S]*SITE_BULK_CLEAR_FORBIDDEN/,
    'bulk Site replace/delete must be rejected instead of bypassing subtree reference checks'
  );
}

console.log('PASS site hierarchy canonical types, legacy aliases, parent rules, and wiring');
