import { logger } from './mailer.js';

const smsEnv = {
  SMS_RU_API_KEY: process.env.SMS_RU_API_KEY,
  SMS_RU_SIGNATURE: process.env.SMS_RU_SIGNATURE,
  SMS_RU_TEST: process.env.SMS_RU_TEST === 'true',
};

interface SmsRuResponse {
  status: string;
  status_code: number;
  status_text?: string;
  balance?: number;
  sms?: Record<string, { status: string; status_code: number; status_text?: string }>;
}

/**
 * Отправка SMS через SMS.RU (https://sms.ru).
 * Без SMS_RU_API_KEY: в development — пропуск с явным warn (без стаба кода),
 * в production — жёсткая ошибка, чтобы не терять коды молча.
 */
export async function sendSms(phone: string, text: string): Promise<void> {
  if (!smsEnv.SMS_RU_API_KEY) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMS_RU_API_KEY is required in production to send SMS');
    }
    logger.warn({ phone }, 'SMS skipped: SMS_RU_API_KEY is not set (dev mode, configure sms.ru or MailHog)');
    return;
  }

  const params = new URLSearchParams();
  params.set('to', phone.replace(/^\+/, ''));
  params.set('msg', text);
  if (smsEnv.SMS_RU_SIGNATURE) params.set('from', smsEnv.SMS_RU_SIGNATURE);
  if (smsEnv.SMS_RU_TEST) params.set('test', '1');

  const url = `https://sms.ru/sms/send?json=1&api_id=${encodeURIComponent(smsEnv.SMS_RU_API_KEY)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (err) {
    throw new Error(`SMS.RU недоступен: ${(err as Error).message}`);
  }

  let data: SmsRuResponse | null = null;
  try {
    data = (await res.json()) as SmsRuResponse;
  } catch {
    data = null;
  }

  if (!res.ok || !data || data.status !== 'OK') {
    throw new Error(
      `SMS.RU error: http=${res.status} code=${data?.status_code ?? '-'} text=${data?.status_text ?? ''}`
    );
  }

  const sms = data.sms?.[phone] ?? data.sms?.[phone.replace(/^\+/, '')];
  if (sms && sms.status !== 'OK') {
    logger.warn(
      { phone, code: sms.status_code, text: sms.status_text },
      `SMS.RU не доставил на ${phone} (возможно, нет подписи отправителя: https://sms.ru/?panel=senders)`
    );
  }

  logger.info({ phone, status_code: data.status_code, balance: data.balance }, 'sms sent via SMS.RU');
}