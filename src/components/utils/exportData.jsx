import { format } from 'date-fns';

export function downloadCSV(data, filename) {
  if (!data || data.length === 0) {
    alert('No data to export');
    return;
  }

  // Get all keys from all objects to handle different structures
  const allKeys = new Set();
  data.forEach(item => {
    Object.keys(item).forEach(key => allKeys.add(key));
  });
  
  const headers = Array.from(allKeys).filter(key => 
    !key.startsWith('_') && key !== 'id' && key !== 'created_by_id' && key !== 'entity_name' && key !== 'app_id'
  );

  // Create CSV content
  let csv = headers.join(',') + '\n';
  
  data.forEach(row => {
    const values = headers.map(header => {
      let value = row[header] || row.data?.[header] || '';
      
      // Handle arrays and objects
      if (Array.isArray(value)) {
        value = JSON.stringify(value);
      } else if (typeof value === 'object' && value !== null) {
        value = JSON.stringify(value);
      }
      
      // Escape quotes and wrap in quotes if contains comma
      value = String(value).replace(/"/g, '""');
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
}

export function exportToCSV(data, filename, customHeaders = null) {
  if (!data || data.length === 0) {
    alert('No data to export');
    return;
  }

  const headers = customHeaders || Object.keys(data[0]);
  
  let csv = headers.join(',') + '\n';
  
  data.forEach(row => {
    const values = headers.map(header => {
      let value = row[header] ?? '';
      
      if (Array.isArray(value)) {
        value = value.length;
      } else if (typeof value === 'object' && value !== null) {
        value = JSON.stringify(value);
      }
      
      value = String(value).replace(/"/g, '""');
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