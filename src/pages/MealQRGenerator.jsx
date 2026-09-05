import Attendance, { FOOD_CONSUMPTION_SECTIONS } from './Attendance';

export default function MealQRGenerator() {
  return <Attendance section={FOOD_CONSUMPTION_SECTIONS.MEAL_QR_GENERATOR} />;
}
