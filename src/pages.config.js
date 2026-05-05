/**
 * pages.config.js - Page routing configuration
 * 
 * This file is AUTO-GENERATED. Do not add imports or modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 * 
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 * 
 * Example file structure:
 * 
 *   import HomePage from './pages/HomePage';
 *   import Dashboard from './pages/Dashboard';
 *   import Settings from './pages/Settings';
 *   
 *   export const PAGES = {
 *       "HomePage": HomePage,
 *       "Dashboard": Dashboard,
 *       "Settings": Settings,
 *   }
 *   
 *   export const pagesConfig = {
 *       mainPage: "HomePage",
 *       Pages: PAGES,
 *   };
 * 
 * Example with Layout (wraps all pages):
 *
 *   import Home from './pages/Home';
 *   import Settings from './pages/Settings';
 *   import __Layout from './Layout.jsx';
 *
 *   export const PAGES = {
 *       "Home": Home,
 *       "Settings": Settings,
 *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "Home",
 *       Pages: PAGES,
 *       Layout: __Layout,
 *   };
 *
 * To change the main page from HomePage to Dashboard, use find_replace:
 *   Old: mainPage: "HomePage",
 *   New: mainPage: "Dashboard",
 *
 * The mainPage value must match a key in the PAGES object exactly.
 */
import AIRecipes from './pages/AIRecipes';
import AdvancedReports from './pages/AdvancedReports';
import Attendance from './pages/Attendance';
import AutoSchedule from './pages/AutoSchedule';
import BatchTracking from './pages/BatchTracking';
import BranchOrders from './pages/BranchOrders';
import CaloriesCalculator from './pages/CaloriesCalculator';
import CostControl from './pages/CostControl';
import D365Integration from './pages/D365Integration';
import DailyMealCheckin from './pages/DailyMealCheckin';
import Dashboard from './pages/Dashboard';
import DiningScanner from './pages/DiningScanner';
import EventDiningCheckin from './pages/EventDiningCheckin';
import EventInquiry from './pages/EventInquiry';
import EventPlanning from './pages/EventPlanning';
import FoodWaste from './pages/FoodWaste';
import FoodCost from './pages/FoodCost';
import Forecasting from './pages/Forecasting';
import Ingredients from './pages/Ingredients';
import Inventory from './pages/Inventory';
import MaterialRequests from './pages/MaterialRequests';
import Menu from './pages/Menu';
import MenuBuilder from './pages/MenuBuilder';
import MenuPlanning from './pages/MenuPlanning';
import NutritionAllergen from './pages/NutritionAllergen';
import ProcurementPlanning from './pages/ProcurementPlanning';
import ProcurementModule from './pages/ProcurementModule';
import Production from './pages/Production';
import ProductionCalculator from './pages/ProductionCalculator';
import ProductionTransfer from './pages/ProductionTransfer';
import ProductivityTracking from './pages/ProductivityTracking';
import POSIntegration from './pages/POSIntegration';
import QRManagement from './pages/QRManagement';
import QualityControl from './pages/QualityControl';
import Recipes from './pages/Recipes';
import Reports from './pages/Reports';
import Sites from './pages/Sites';
import SupplierPortal from './pages/SupplierPortal';
import UserRoleManagement from './pages/UserRoleManagement';
import YieldCost from './pages/YieldCost';
import __Layout from './Layout.jsx';


export const PAGES = {
    "AIRecipes": AIRecipes,
    "AdvancedReports": AdvancedReports,
    "Attendance": Attendance,
    "AutoSchedule": AutoSchedule,
    "BatchTracking": BatchTracking,
    "BranchOrders": BranchOrders,
    "CaloriesCalculator": CaloriesCalculator,
    "CostControl": CostControl,
    "D365Integration": D365Integration,
    "DailyMealCheckin": DailyMealCheckin,
    "Dashboard": Dashboard,
    "DiningScanner": DiningScanner,
    "EventDiningCheckin": EventDiningCheckin,
    "EventInquiry": EventInquiry,
    "EventPlanning": EventPlanning,
    "FoodWaste": FoodWaste,
    "FoodCost": FoodCost,
    "Forecasting": Forecasting,
    "Ingredients": Ingredients,
    "Inventory": Inventory,
    "MaterialRequests": MaterialRequests,
    "Menu": Menu,
    "MenuBuilder": MenuBuilder,
    "MenuPlanning": MenuPlanning,
    "NutritionAllergen": NutritionAllergen,
    "ProcurementPlanning": ProcurementPlanning,
    "ProcurementModule": ProcurementModule,
    "Production": Production,
    "ProductionCalculator": ProductionCalculator,
    "ProductionTransfer": ProductionTransfer,
    "ProductivityTracking": ProductivityTracking,
    "POSIntegration": POSIntegration,
    "QRManagement": QRManagement,
    "QualityControl": QualityControl,
    "Recipes": Recipes,
    "Reports": Reports,
    "Sites": Sites,
    "SupplierPortal": SupplierPortal,
    "UserRoleManagement": UserRoleManagement,
    "YieldCost": YieldCost,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};
