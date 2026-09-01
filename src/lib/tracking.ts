// Tracking service for source parameters (NFC, QR, WhatsApp, etc.)

/**
 * Get source parameter from URL
 * @returns {string} Source parameter value or empty string
 */
export const getSourceParam = (): string => {
  if (typeof window === 'undefined') return '';
  
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('source') || '';
};

/**
 * Store source parameter in sessionStorage for persistence
 * @param {string} source - Source parameter to store
 */
export const storeSourceParam = (source: string): void => {
  if (source && typeof window !== 'undefined') {
    sessionStorage.setItem('washo_source', source);
  }
};

/**
 * Get stored source parameter from sessionStorage
 * @returns {string} Stored source parameter or empty string
 */
export const getStoredSourceParam = (): string => {
  if (typeof window === 'undefined') return '';
  return sessionStorage.getItem('washo_source') || '';
};

/**
 * Initialize source tracking on page load
 */
export const initializeSourceTracking = (): void => {
  if (typeof window === 'undefined') return;
  
  // Get source from URL
  const urlSource = getSourceParam();
  
  // If we have a source in URL, store it
  if (urlSource) {
    storeSourceParam(urlSource);
  }
};

// Initialize on module load if in browser
if (typeof window !== 'undefined') {
  initializeSourceTracking();
}

export default {
  getSourceParam,
  storeSourceParam,
  getStoredSourceParam,
  initializeSourceTracking
};
