import { useEffect } from 'react';

function hasOverflowTitleClass(element) {
  return Array.from(element.classList || []).some((className) => (
    className === 'truncate' || className.startsWith('line-clamp-')
  ));
}

function isTextOverflowing(element) {
  return element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
}

function getNearestOverflowElement(target) {
  if (!(target instanceof Element)) return null;
  return target.closest('.truncate, .line-clamp-1, .line-clamp-2, .line-clamp-3, .line-clamp-4, .line-clamp-5, .line-clamp-6');
}

export default function OverflowTitleProvider() {
  useEffect(() => {
    const handleMouseOver = (event) => {
      const element = getNearestOverflowElement(event.target);
      if (!element || !hasOverflowTitleClass(element)) return;

      const text = element.textContent?.replace(/\s+/g, ' ').trim();
      if (!text || !isTextOverflowing(element)) return;

      const existingTitle = element.getAttribute('title');
      const generatedTitle = element.dataset.overflowTitleGenerated === 'true';
      if (existingTitle && !generatedTitle) return;

      element.setAttribute('title', text);
      element.dataset.overflowTitleGenerated = 'true';
    };

    document.addEventListener('mouseover', handleMouseOver);
    return () => document.removeEventListener('mouseover', handleMouseOver);
  }, []);

  return null;
}
