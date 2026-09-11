export function formatPrice(value: number | string, currency = 'EUR'): string {
  const num = typeof value === 'string' ? Number(value) : value;
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(num);
}

export function formatDate(value: string | Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

export function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function fieldError(err: { fields?: Record<string, string> } | null, field: string): string | undefined {
  return err?.fields?.[field];
}
