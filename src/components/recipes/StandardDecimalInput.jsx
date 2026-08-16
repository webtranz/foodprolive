import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  formatRecipeQuantity,
  getRecipeQuantityPrecision,
  parseStandardDecimal,
  standardizeDecimalValue
} from '../../../shared/recipeNumbers.js';

export default function StandardDecimalInput({
  value,
  unit = '',
  precision,
  min = 0,
  max = null,
  allowZero = true,
  allowEmpty = true,
  label = 'Quantity',
  onValueChange,
  onValidationChange,
  className,
  ...inputProps
}) {
  const resolvedPrecision = precision ?? getRecipeQuantityPrecision(unit);
  const focusedRef = useRef(false);
  const [draft, setDraft] = useState(() => (
    value === null || value === undefined || value === ''
      ? ''
      : formatRecipeQuantity(value, unit, { precision: resolvedPrecision, useGrouping: false })
  ));

  useEffect(() => {
    if (focusedRef.current) return;
    setDraft(value === null || value === undefined || value === ''
      ? ''
      : formatRecipeQuantity(value, unit, { precision: resolvedPrecision, useGrouping: false }));
  }, [resolvedPrecision, unit, value]);

  const publishStatus = (status) => {
    onValidationChange?.(status);
  };

  const handleChange = (event) => {
    const raw = event.target.value;
    const parsed = parseStandardDecimal(raw, {
      unit,
      precision: resolvedPrecision,
      min,
      max,
      allowZero,
      allowEmpty,
      mode: 'input',
      label
    });
    if (!parsed.valid) {
      publishStatus({ error: parsed.error, notice: '' });
      return;
    }

    setDraft(parsed.display);
    const notice = parsed.normalized && raw !== ''
      ? `${raw} normalized to ${parsed.display}`
      : '';
    publishStatus({ error: '', notice });
    onValueChange?.(parsed.value, { ...parsed, notice });
  };

  const handleBlur = (event) => {
    focusedRef.current = false;
    const finalSource = draft.endsWith('.') ? draft.slice(0, -1) : draft;
    const parsed = standardizeDecimalValue(finalSource, {
      unit,
      precision: resolvedPrecision,
      min,
      max,
      allowZero,
      allowEmpty,
      label
    });
    if (parsed.valid) {
      setDraft(parsed.display);
      onValueChange?.(parsed.value, parsed);
      publishStatus({ error: '', notice: '' });
    } else {
      publishStatus({ error: parsed.error, notice: '' });
    }
    inputProps.onBlur?.(event);
  };

  return (
    <Input
      {...inputProps}
      type="text"
      inputMode={resolvedPrecision === 0 ? 'numeric' : 'decimal'}
      autoComplete="off"
      value={draft}
      onFocus={(event) => {
        focusedRef.current = true;
        inputProps.onFocus?.(event);
      }}
      onChange={handleChange}
      onBlur={handleBlur}
      className={cn(className)}
      aria-label={inputProps['aria-label'] || label}
    />
  );
}
