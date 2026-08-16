import { format } from 'date-fns';
import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
import { replaceVisibleUSDCurrency } from '@/lib/currency';

function normalizeExportRows(data) {
  if (!data || data.length === 0) {
    return [];
  }

  return data.map((row) => {
    const normalized = {};
    Object.entries(row || {}).forEach(([key, value]) => {
      if (key.startsWith('_') || key === 'id' || key === 'created_by_id' || key === 'entity_name' || key === 'app_id') {
        return;
      }
      if (Array.isArray(value)) {
        normalized[key] = JSON.stringify(value);
      } else if (typeof value === 'object' && value !== null) {
        normalized[key] = JSON.stringify(value);
      } else {
        normalized[key] = typeof value === 'string' ? replaceVisibleUSDCurrency(value) : (value ?? '');
      }
    });
    return normalized;
  });
}

export function downloadCSV(data, filename) {
  if (!data || data.length === 0) {
    alert('No data to export');
    return;
  }

  // Get all keys from all objects to handle different structures
  const allKeys = new Set();
  const normalizedRows = normalizeExportRows(data);

  normalizedRows.forEach(item => {
    Object.keys(item).forEach(key => allKeys.add(key));
  });
  
  const headers = Array.from(allKeys).filter(key => 
    !key.startsWith('_') && key !== 'id' && key !== 'created_by_id' && key !== 'entity_name' && key !== 'app_id'
  );

  // Create CSV content
  let csv = headers.map((header) => replaceVisibleUSDCurrency(header)).join(',') + '\n';
  
  normalizedRows.forEach(row => {
    const values = headers.map(header => {
      let value = row[header] ?? row.data?.[header] ?? '';
      
      // Handle arrays and objects
      if (Array.isArray(value)) {
        value = JSON.stringify(value);
      } else if (typeof value === 'object' && value !== null) {
        value = JSON.stringify(value);
      }
      
      // Escape quotes and wrap in quotes if contains comma
      value = replaceVisibleUSDCurrency(String(value)).replace(/"/g, '""');
      if (value.includes(',') || value.includes('\n')) {
        value = `"${value}"`;
      }
      
      return value;
    });
    csv += values.join(',') + '\n';
  });

  // Create blob and download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', `${filename}_${format(new Date(), 'yyyy-MM-dd_HHmm')}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadExcel(data, filename, sheetName = 'Report') {
  if (!data || data.length === 0) {
    alert('No data to export');
    return;
  }

  const rows = normalizeExportRows(data);
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, `${filename}_${format(new Date(), 'yyyy-MM-dd_HHmm')}.xlsx`);
}

export function downloadPDF({
  title,
  subtitle = '',
  sections = [],
  filename = 'report'
}) {
  const doc = new jsPDF();
  let y = 18;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(replaceVisibleUSDCurrency(title || 'Report'), 14, y);
  y += 8;

  if (subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(replaceVisibleUSDCurrency(subtitle), 180);
    doc.text(lines, 14, y);
    y += (lines.length * 5) + 3;
  }

  sections.forEach((section) => {
    if (y > 260) {
      doc.addPage();
      y = 18;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(replaceVisibleUSDCurrency(section.heading || 'Section'), 14, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const bodyLines = Array.isArray(section.lines) ? section.lines : [];
    bodyLines.forEach((line) => {
      const lines = doc.splitTextToSize(replaceVisibleUSDCurrency(String(line)), 180);
      if (y + (lines.length * 5) > 275) {
        doc.addPage();
        y = 18;
      }
      doc.text(lines, 14, y);
      y += (lines.length * 5) + 1;
    });
    y += 4;
  });

  doc.save(`${filename}_${format(new Date(), 'yyyy-MM-dd_HHmm')}.pdf`);
}

export function exportToCSV(data, filename, customHeaders = null) {
  if (!data || data.length === 0) {
    alert('No data to export');
    return;
  }

  const headers = customHeaders || Object.keys(data[0]);
  
  let csv = headers.map((header) => replaceVisibleUSDCurrency(header)).join(',') + '\n';
  
  data.forEach(row => {
    const values = headers.map(header => {
      let value = row[header] ?? '';
      
      if (Array.isArray(value)) {
        value = value.length;
      } else if (typeof value === 'object' && value !== null) {
        value = JSON.stringify(value);
      }
      
      value = replaceVisibleUSDCurrency(String(value)).replace(/"/g, '""');
      if (value.includes(',') || value.includes('\n') || value.includes('"')) {
        value = `"${value}"`;
      }
      
      return value;
    });
    csv += values.join(',') + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', `${filename}_${format(new Date(), 'yyyy-MM-dd_HHmm')}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
