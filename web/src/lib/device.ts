// Generate a unique browser ID and store it in localStorage
function generateUniqueId() {
  return 'browser_' + Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15) + 
         '_' + Date.now();
}

// Get or create a unique browser ID
function getBrowserId() {
  const storageKey = 'webrtc_vlm_browser_id';
  let id = localStorage.getItem(storageKey);
  
  if (!id) {
    id = generateUniqueId();
    localStorage.setItem(storageKey, id);
  }
  
  return id;
}

// Export the browser ID
export const deviceId = typeof window !== 'undefined' ? getBrowserId() : 'unknown';

// Add browser info to the ID for debugging purposes
export const deviceInfo = 
  typeof navigator !== 'undefined' ? 
    `${deviceId}|${navigator.userAgent.substring(0, 100)}` : 
    deviceId;
