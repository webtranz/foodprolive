const text = (value) => String(value ?? '').trim();
const key = (value) => text(value).toLowerCase().replace(/\s+/g, ' ');
const legacyKey = (value) => key(value)
  .replace(/\bonego\b/g, '')
  .replace(/\s+v\d+$/, '')
  .replace(/\s+/g, ' ').trim();

export function recipeMatchesMenuSite(recipe, siteId, sites = []) {
  if (!siteId || !recipe.site_scope || recipe.site_scope === 'global') return true;
  const parents = new Map(sites.map((site) => [text(site.id), text(site.parent_site_id)]));
  const ancestors = (id) => {
    const result = new Set();
    while (id && !result.has(id)) {
      result.add(id);
      id = parents.get(id);
    }
    return result;
  };
  const menuAncestors = ancestors(text(siteId));
  return (recipe.site_ids || []).some((id) => (
    menuAncestors.has(text(id)) || ancestors(text(id)).has(text(siteId))
  ));
}

// Resolve portable upload references again on read, including after a recipe re-import.
export function resolveMenuRecipeLinks(plan, recipes = [], sites = []) {
  if (!plan) return plan;
  const eligible = recipes.filter((recipe) => recipeMatchesMenuSite(recipe, plan.site_id, sites));
  return {
    ...plan,
    meals: (Array.isArray(plan.meals) ? plan.meals : []).map((meal) => {
      const references = [meal.recipe_code, meal.recipe_id].map(key).filter(Boolean);
      const name = key(meal.recipe_name);
      const tiers = [
        eligible.filter((recipe) => text(meal.recipe_id) && text(recipe.id) === text(meal.recipe_id)),
        eligible.filter((recipe) => key(recipe.recipe_code) && references.includes(key(recipe.recipe_code))),
        eligible.filter((recipe) => name && key(recipe.name) === name),
        eligible.filter((recipe) => legacyKey(recipe.recipe_code)
          && references.map(legacyKey).includes(legacyKey(recipe.recipe_code))),
        eligible.filter((recipe) => name && legacyKey(recipe.name) === legacyKey(name))
      ];
      const matches = tiers.find((candidates) => candidates.length) || [];
      if (matches.length !== 1) {
        return { ...meal, recipe_link_status: matches.length ? 'ambiguous' : 'missing' };
      }
      const recipe = matches[0];
      return {
        ...meal,
        recipe_id: recipe.id,
        recipe_code: recipe.recipe_code || meal.recipe_code || '',
        recipe_name: recipe.name || meal.recipe_name || '',
        recipe_link_status: 'linked'
      };
    })
  };
}
