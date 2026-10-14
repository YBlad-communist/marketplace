import 'dotenv/config';

/**
 * Env-конфиг платёжного слоя (API и worker читают одни и те же переменные).
 * Геттеры читают process.env на каждый вызов — тесты могут менять env
 * после загрузки модуля.
 */
function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}
function bool(name: string): boolean {
  const v = process.env[name];
  return v === 'true' || v === '1';
}

export const paymentEnv = {
  get PAYMENT_PROVIDER(): 'yookassa' | 'moneta' | 'mock' {
    return str('PAYMENT_PROVIDER', 'yookassa') as 'yookassa' | 'moneta' | 'mock';
  },

  get YOOKASSA_SHOP_ID(): string | undefined {
    return str('YOOKASSA_SHOP_ID') || undefined;
  },
  get YOOKASSA_SECRET_KEY(): string | undefined {
    return str('YOOKASSA_SECRET_KEY') || undefined;
  },
  get YOOKASSA_INSECURE_WEBHOOKS(): boolean {
    return bool('YOOKASSA_INSECURE_WEBHOOKS');
  },

  get MONETA_ACCOUNT_ID(): string | undefined {
    return str('MONETA_ACCOUNT_ID') || undefined;
  },
  get MONETA_ACCOUNT_CODE(): string | undefined {
    return str('MONETA_ACCOUNT_CODE') || undefined;
  },
  get MONETA_TRANSIT_ACCOUNT(): string | undefined {
    return str('MONETA_TRANSIT_ACCOUNT') || undefined;
  },
  get MONETA_BASE_URL(): string {
    return str('MONETA_BASE_URL', 'https://service.moneta.ru/services');
  },
  get MONETA_API_USERNAME(): string | undefined {
    return str('MONETA_API_USERNAME') || undefined;
  },
  get MONETA_API_PASSWORD(): string | undefined {
    return str('MONETA_API_PASSWORD') || undefined;
  },
  get MONETA_PAYMENT_PASSWORD(): string | undefined {
    return str('MONETA_PAYMENT_PASSWORD') || undefined;
  },
  get MONETA_TEST_MODE(): boolean {
    return bool('MONETA_TEST_MODE');
  },
  get MONETA_ASSISTANT_URL(): string {
    return str('MONETA_ASSISTANT_URL', 'https://moneta.ru/assistant.htm');
  },
};

export type PaymentEnv = typeof paymentEnv;
