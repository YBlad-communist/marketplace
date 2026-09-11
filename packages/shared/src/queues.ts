export const QUEUES = {
  EMAIL: 'emails',
  SMS: 'sms',
  IMAGES: 'images',
  MODERATION: 'moderation',
  NOTIFICATIONS: 'notifications',
  MAINTENANCE: 'maintenance',
} as const;

export const EMAIL_JOBS = {
  SEND: 'send',
  VERIFY: 'send-verification',
  PASSWORD_RESET: 'send-password-reset',
  NEW_MESSAGE: 'new-message',
  ORDER_UPDATED: 'order-updated',
} as const;

export const SMS_JOBS = {
  SEND: 'send-sms',
} as const;

export const IMAGE_JOBS = {
  PROCESS: 'process-image',
} as const;

export const MODERATION_JOBS = {
  CHECK_LISTING: 'check-listing',
} as const;

export const NOTIFICATION_JOBS = {
  SAVED_SEARCH_MATCH: 'saved-search-match',
} as const;

export const MAINTENANCE_JOBS = {
  CLEANUP_TOKENS: 'cleanup-tokens',
  CLEANUP_EXPIRED: 'cleanup-expired',
} as const;
