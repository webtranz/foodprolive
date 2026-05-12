export const pagePermissionMap = {
  FoodCategories: 'manage_food_categories',
  FoodWaste: 'manage_waste',
  FoodWasteQR: 'manage_waste'
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
