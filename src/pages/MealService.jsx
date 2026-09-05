import Attendance, { FOOD_CONSUMPTION_SECTIONS } from './Attendance';

export default function MealService() {
  return <Attendance section={FOOD_CONSUMPTION_SECTIONS.MEAL_SERVICE} />;
}
