export const pagePermissionMap = {
  EventPlanning: [
    'manage_menu_planning',
    'create_special_event',
    'edit_special_event',
    'submit_special_event',
    'review_special_event',
    'approve_special_event',
    'reject_special_event'
  ],
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

  if (Array.isArray(requiredPermission)) {
    return typeof can === 'function' ? requiredPermission.some((permission) => can(permission)) : false;
  }

  return typeof can === 'function' ? Boolean(can(requiredPermission)) : false;
}
