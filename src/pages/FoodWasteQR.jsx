import React from 'react';
import { useSearchParams } from 'react-router-dom';
import FoodWaste from './FoodWaste';

export default function FoodWasteQR() {
  const [searchParams] = useSearchParams();
  const token = String(searchParams.get('token') || '').trim();

  return <FoodWaste qrToken={token} qrMode />;
}
