"""Полный локальный запуск РынокRU одной командой::

    python start.py

Скрипт сам поднимает Redis и MinIO (если они ещё не запущены),
применяет pending-миграции Prisma и запускает web + api + worker
через ``pnpm dev``. Остановка — Ctrl+C (Redis/MinIO остаются работать
в фоне, это нормально: повторный запуск их просто переиспользует).

Опции:
    python start.py --no-migrate   пропустить prisma migrate deploy
    python start.py --check        только проверить окружение, ничего не запускать
    python start.py --prod         production-режим: pnpm build + запуск собранного
                                   кода (страницы открываются СРАЗУ, без компиляции
                                   на первом заходе как в dev). Если сменился LAN-IP,
                                   просто запустите --prod ещё раз (пересоберёт web).
"""

import os
import shutil
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))

REDIS_EXE = os.environ.get("MARKETPLACE_REDIS_EXE", r"C:\redis5\redis-server.exe")
REDIS_CONF = os.environ.get("MARKETPLACE_REDIS_CONF", r"C:\redis5\redis.windows.conf")
MINIO_EXE = os.environ.get("MARKETPLACE_MINIO_EXE", r"C:\minio\minio.exe")
MINIO_DATA = os.environ.get("MARKETPLACE_MINIO_DATA", r"C:\minio\data")
MINIO_USER = os.environ.get("MINIO_ROOT_USER", "minioadmin")
MINIO_PASSWORD = os.environ.get("MINIO_ROOT_PASSWORD", "minioadmin")

WEB_URL = "http://localhost:3000"
API_URL = "http://localhost:4000"
MINIO_CONSOLE = "http://localhost:9001"


def log(msg):
    print("[start] %s" % msg, flush=True)


def die(msg):
    print("[start] ОШИБКА: %s" % msg, flush=True)
    sys.exit(1)


def port_open(port, host="127.0.0.1"):
    s = socket.socket()
    s.settimeout(1)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def wait_port(port, name, timeout=30):
    for _ in range(timeout * 2):
        if port_open(port):
            return True
        time.sleep(0.5)
    die("%s не отвечает на порту %d за %d c" % (name, port, timeout))
    return False


def parse_dotenv(path):
    """Минимальный парсер .env (без внешних зависимостей)."""
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip("'").strip('"')
            if key and key not in os.environ:
                values[key] = val
    return values


def ensure_redis():
    if port_open(6379):
        log("Redis уже запущен (:6379)")
        return
    if not os.path.exists(REDIS_EXE):
        die("не найден %s — поправьте MARKETPLACE_REDIS_EXE" % REDIS_EXE)
    log("запускаю Redis...")
    subprocess.Popen(
        [REDIS_EXE, REDIS_CONF],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
    )
    wait_port(6379, "Redis")
    log("Redis запущен (:6379)")


def ensure_minio():
    if port_open(9000):
        log("MinIO уже запущен (:9000)")
        return
    if not os.path.exists(MINIO_EXE):
        die("не найден %s — поправьте MARKETPLACE_MINIO_EXE" % MINIO_EXE)
    if not os.path.isdir(MINIO_DATA):
        die("нет каталога данных %s" % MINIO_DATA)
    log("запускаю MinIO...")
    env = dict(os.environ, MINIO_ROOT_USER=MINIO_USER, MINIO_ROOT_PASSWORD=MINIO_PASSWORD)
    subprocess.Popen(
        [MINIO_EXE, "server", MINIO_DATA, "--address", "0.0.0.0:9000", "--console-address", ":9001"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
    )
    wait_port(9000, "MinIO")
    log("MinIO запущен (:9000, консоль :9001)")


def check_tools():
    for tool in ("node", "pnpm"):
        if shutil.which(tool) is None:
            die("не найден '%s' в PATH" % tool)
    if not os.path.exists(os.path.join(ROOT, "package.json")):
        die("запускайте из корня репозитория (рядом с package.json)")


def run_cmd(args, env):
    """Запуск консольных команд (pnpm — .CMD, на Windows нужен shell)."""
    if os.name == "nt":
        return subprocess.run(" ".join(args), cwd=ROOT, env=env, shell=True)
    return subprocess.run(args, cwd=ROOT, env=env)


def migrate(env):
    log("применяю миграции Prisma (deploy)...")
    r = run_cmd(["pnpm", "--filter", "@marketplace/db", "exec", "prisma", "migrate", "deploy"], env)
    if r.returncode != 0:
        die("prisma migrate deploy завершился с кодом %d" % r.returncode)
    log("миграции применены")


def check_only():
    problems = []
    for tool in ("node", "pnpm", "python"):
        log("%s: %s" % (tool, shutil.which(tool) or "НЕТ в PATH"))
    for port, name in ((5432, "PostgreSQL"), (6379, "Redis"), (9000, "MinIO")):
        state = "OK" if port_open(port) else "ЗАКРЫТ"
        log("%s :%d — %s" % (name, port, state))
        if state != "OK":
            problems.append(name)
    if problems:
        die("недоступно: %s" % ", ".join(problems))
    log("окружение в порядке")


def main(argv):
    check_tools()
    if "--check" in argv:
        return check_only()
    dotenv = parse_dotenv(os.path.join(ROOT, ".env"))
    env = dict(os.environ, **dotenv)

    if not port_open(5432):
        die("PostgreSQL недоступен на :5432 — запустите службу Postgres и повторите")

    busy = [p for p in (3000, 4000) if port_open(p)]
    if busy:
        die("порты уже заняты (%s) — сайт, похоже, уже запущен" % ", ".join(":%d" % p for p in busy))

    ensure_redis()
    ensure_minio()

    if "--no-migrate" not in argv:
        migrate(env)
    else:
        log("миграции пропущены (--no-migrate)")

    prod = "--prod" in argv
    if prod:
        # .env задаёт NODE_ENV=development для dev-запуска; сборке и prod-запуску
        # нужен production, иначе next build пререндерит в dev-режиме и падает.
        env["NODE_ENV"] = "production"
        log("собираю production (pnpm build, займёт несколько минут)...")
        r = run_cmd(["pnpm", "build"], env)
        if r.returncode != 0:
            die("pnpm build завершился с кодом %d" % r.returncode)
        log("сборка готова")
        dev_cmd = (
            "pnpm exec concurrently -n api,web,worker -c magenta,cyan,yellow "
            "\"pnpm --filter @marketplace/api start\" "
            "\"pnpm --filter @marketplace/web start\" "
            "\"pnpm --filter @marketplace/worker start\""
        )
    else:
        dev_cmd = None

    print("", flush=True)
    print("  РынокRU запускается:", flush=True)
    print("    сайт          %s" % WEB_URL, flush=True)
    print("    API           %s" % API_URL, flush=True)
    print("    MinIO консоль %s" % MINIO_CONSOLE, flush=True)
    print("  Остановка — Ctrl+C", flush=True)
    if prod:
        print("  Режим: PRODUCTION (собранный код, быстрые переходы)", flush=True)
    print("", flush=True)
    try:
        r = run_cmd(["pnpm", "dev"] if dev_cmd is None else [dev_cmd], env)
        sys.exit(r.returncode)
    except KeyboardInterrupt:
        print("", flush=True)
        log("остановлено (Redis/MinIO оставлены работать в фоне)")


if __name__ == "__main__":
    main(sys.argv[1:])
