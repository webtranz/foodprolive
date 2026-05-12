export const pagePermissionMap = {
  FoodCategories: 'manage_food_categories'
};

export function getRequiredPagePermission(pageName) {
  return pagePermissionMap[pageName] || null;
}

export function canAccessPage(pageName, can) {
  const requiredPermission = getRequiredPagePermission(pageName);
  if (!requiredPermission) {
    return true;
  }

  return typeof can === 'function' ? Boolean(can(requiredPermission)) : false;
}
