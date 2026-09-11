import 'dotenv/config';
import nodemailer from 'nodemailer';
import pino from 'pino';

const env = {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 1025),
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  MAIL_FROM: process.env.MAIL_FROM ?? 'Marketplace <no-reply@localhost>',
  APP_URL: process.env.APP_URL ?? 'http://localhost:3000',
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'marketplace-worker' },
});

let transport: nodemailer.Transporter | null = null;

export function getTransport(): nodemailer.Transporter {
  if (!transport) {
    if (!env.SMTP_HOST) {
      throw new Error(
        'SMTP_HOST is not configured. Set SMTP_HOST/SMTP_PORT in .env (dev: MailHog on localhost:1025, see README) or disable email notifications.'
      );
    }
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    });
  }
  return transport;
}

function htmlWrap(inner: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#222;max-width:600px;margin:0 auto">${inner}</body></html>`;
}

function renderTemplate(template?: string, data: Record<string, unknown> = {}): string {
  switch (template) {
    case 'verification': {
      const code = String(data.code ?? '');
      return htmlWrap(
        `<h2>Здравствуйте, ${escapeHtml(String(data.name ?? ''))}!</h2><p>Ваш код подтверждения:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${escapeHtml(code)}</p><p>Код действителен 10 минут.</p>`
      );
    }
    case 'password-reset': {
      const code = String(data.code ?? '');
      return htmlWrap(
        `<h2>Сброс пароля</h2><p>Код для сброса пароля:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${escapeHtml(code)}</p><p>Код действителен 10 минут.</p>`
      );
    }
    case 'new-message': {
      return htmlWrap(
        `<h2>Новое сообщение</h2><p>${escapeHtml(String(data.name ?? ''))}, у вас новое сообщение.</p><blockquote style="background:#f5f5f5;padding:12px">${escapeHtml(String(data.preview ?? ''))}</blockquote><p><a href="${env.APP_URL}/chat">Открыть чат</a></p>`
      );
    }
    case 'order-updated': {
      return htmlWrap(
        `<h2>Заказ ${escapeHtml(String(data.orderId ?? ''))}</h2><p>Статус вашего заказа изменился. Сумма: ${escapeHtml(String(data.amount ?? ''))}</p><p><a href="${env.APP_URL}/orders">Открыть заказы</a></p>`
      );
    }
    default:
      return htmlWrap(`<p>${escapeHtml(String(data.message ?? ''))}</p>`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function sendEmail(payload: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  template?: string;
  templateData?: Record<string, unknown>;
}): Promise<void> {
  const html = payload.html ?? renderTemplate(payload.template, payload.templateData);
  await getTransport().sendMail({
    from: env.MAIL_FROM,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html,
  });
}

export function escapeHtmlForTemplate(value: unknown): string {
  return escapeHtml(String(value ?? ''));
}
