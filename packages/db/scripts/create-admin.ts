/**
 * Регистрация/обновление администратора из консоли.
 *
 * Использование:
 *   pnpm create:admin
 *   pnpm create:admin -- --email admin@example.com --phone +79991234567 --password 'Secret123' --name Имя
 *
 * Без флагов — интерактивные подсказки. Если email уже существует,
 * аккаунт обновляется (роль/пароль/телефон), иначе создаётся новый.
 */
import readline from 'node:readline/promises';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

// Дубль правил из @marketplace/shared (PASSWORD_REGEX / MIN_PASSWORD_LENGTH),
// чтобы не добавлять зависимость db → shared только ради скрипта.
const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;

const USAGE = `
Создание администратора:
  pnpm create:admin -- --email <email> --phone <телефон> --password <пароль> [--name <имя>]

  --email      Email для входа в админку (обязателен)
  --phone      Телефон в формате +7XXXXXXXXXX (обязателен, логин на сайте по нему)
  --password   Пароль: минимум 8 символов, заглавная + строчная буква + цифра
  --name       Имя (по умолчанию "Администратор")
  -h, --help   Эта справка

Без аргументов скрипт спросит недостающие поля интерактивно.
Повторный запуск с тем же email обновляет пароль/телефон существующего аккаунта.
`;

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
    return argv[i + 1];
  }
  const withEq = argv.find((a) => a.startsWith(`${flag}=`));
  return withEq ? withEq.slice(flag.length + 1) : undefined;
}

/** Приводит номер к единому виду +7XXXXXXXXXX (как phoneSchema в shared). */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) return `+7${digits}`;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return `+7${digits.slice(1)}`;
  }
  return null;
}

function fail(message: string): never {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const interactive = Boolean(process.stdin.isTTY);
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;

  const ask = async (label: string): Promise<string> => (await rl!.question(label)).trim();

  let email = argValue('--email') ?? '';
  let phone = argValue('--phone') ?? '';
  let password = argValue('--password') ?? '';
  let name = argValue('--name') ?? '';

  if (rl) {
    if (!email) email = (await ask('Email: ')).trim();
    if (!phone) phone = (await ask('Телефон (+7XXXXXXXXXX): ')).trim();
    if (!password) password = await ask('Пароль: ');
    if (!name) name = (await ask('Имя [Администратор]: ')) || 'Администратор';
  }
  rl?.close();

  if (!email || !phone || !password) {
    console.error(USAGE);
    fail('не указаны --email / --phone / --password (и нет интерактивного ввода)');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`некорректный email: ${email}`);
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    fail(`некорректный телефон: ${phone} (ожидается +7XXXXXXXXXX)`);
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 72) {
    fail(`пароль должен быть длиной ${MIN_PASSWORD_LENGTH}–72 символа`);
  }
  if (!PASSWORD_REGEX.test(password)) {
    fail('пароль должен содержать заглавную букву, строчную букву и цифру');
  }
  if (name.length < 2) fail('имя должно быть не короче 2 символов');

  const byEmail = await prisma.user.findUnique({ where: { email } });
  const byPhone = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
  if (byPhone && byPhone.id !== byEmail?.id) {
    fail(`телефон ${normalizedPhone} уже занят аккаунтом ${byPhone.email ?? byPhone.id}`);
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const data = {
    email,
    phone: normalizedPhone,
    name,
    passwordHash,
    role: 'ADMIN' as const,
    isVerified: true,
    phoneVerifiedAt: new Date(),
  };

  const user = byEmail
    ? await prisma.user.update({ where: { id: byEmail.id }, data })
    : await prisma.user.create({ data });

  console.log(byEmail ? 'Администратор обновлён:' : 'Администратор создан:');
  console.log(`  id:    ${user.id}`);
  console.log(`  email: ${user.email}`);
  console.log(`  phone: ${user.phone}`);
  console.log(`  name:  ${user.name}`);
  console.log(`  role:  ${user.role}`);
  console.log('Вход на сайте — по телефону и паролю.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
