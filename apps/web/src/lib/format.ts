export function formatPrice(value: number | string, currency = 'RUB'): string {
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

/**
 * Склонение существительного по числу: plural(5, ['объявление','объявления','объявлений']).
 * Формы — [1, 2-4, 5+]; для 11-14 берётся форма «множественное» (русские правила).
 */
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/** Подпись разделителя даты в ленте: «Сегодня», «Вчера» или «12 сентября». */
export function dayLabel(value: string | Date): string {
  const d = new Date(value);
  const today = startOfDay(new Date());
  const day = startOfDay(d);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays <= 0) return 'Сегодня';
  if (diffDays === 1) return 'Вчера';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(d);
}

/** Время для строки чата: сегодня — «14:32», раньше — «12 сен». */
export function formatChatTime(value: string | Date): string {
  const d = new Date(value);
  const today = startOfDay(new Date());
  if (startOfDay(d).getTime() === today.getTime()) {
    return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(d);
}

/** Время внутри пузыря: всегда «14:32». */
export function formatBubbleTime(value: string | Date): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
