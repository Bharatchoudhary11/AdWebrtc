export const deviceId =
  typeof navigator !== 'undefined' && navigator.userAgent
    ? navigator.userAgent
    : 'unknown';
