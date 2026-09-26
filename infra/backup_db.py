"""Резервная копия Postgres в отдельное S3-совместимое хранилище.

Использование:
    python infra/backup_db.py            разовый бэкап (+ prune + отчёт)
    python infra/backup_db.py --check    только проверка окружения

Главное правило: бэкап обязан лежать НЕ там же, где фото (отдельный бакет
BACKUP_S3_BUCKET), иначе смерть диска/багета унесёт и базу, и копию.

Что делает:
  1. pg_dump в custom-формате (сжатый, пригоден для частичного pg_restore).
  2. Заливка в бакет BACKUP_S3_BUCKET, префикс postgres/ (по воскресеньям —
     дубль в postgres/weekly/).
  3. Retention: дневные старше 14 дней — удалить, недельные старше 90 — удалить.
  4. При любой ошибке — POST в BACKUP_ALERT_WEBHOOK (напр. Telegram Bot API).

Расписание — НЕ внутри приложения (бэкап должен работать, даже если API
упало): Windows — Планировщик заданий, Linux VPS — cron (см. README).
"""

import datetime
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

RETENTION_DAILY_DAYS = 14
RETENTION_WEEKLY_DAYS = 90


def log(msg):
    print("[backup] %s" % msg, flush=True)


def die(msg):
    print("[backup] ОШИБКА: %s" % msg, flush=True)
    raise SystemExit(1)


def find_pg_dump():
    override = os.environ.get("PG_DUMP_BIN")
    if override and os.path.exists(override):
        return override
    found = shutil.which("pg_dump")
    if found:
        return found
    for root in (r"C:\Program Files\PostgreSQL", r"C:\Program Files (x86)\PostgreSQL"):
        if not os.path.isdir(root):
            continue
        for ver in sorted(os.listdir(root), reverse=True):
            cand = os.path.join(root, ver, "bin", "pg_dump.exe")
            if os.path.exists(cand):
                return cand
    return ""


def alert(webhook, text):
    if not webhook:
        return
    try:
        req = urllib.request.Request(
            webhook, data=text.encode("utf-8"), method="POST", headers={"Content-Type": "text/plain"}
        )
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        log("не удалось отправить алерт: %s" % e)


def parse_db_name(database_url):
    # postgresql://user:pass@host:port/dbname?params
    try:
        path = database_url.split("?", 1)[0]
        return path.rsplit("/", 1)[1] or "marketplace"
    except IndexError:
        return "marketplace"


def prune(s3, bucket, prefix, keep_days, now):
    """Удалить объекты prefix/* старше keep_days. Возвращает число удалённых."""
    cutoff = now - datetime.timedelta(days=keep_days)
    deleted = 0
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        res = s3.list_objects_v2(**kwargs)
        for obj in res.get("Contents", []):
            key = obj.get("Key", "")
            if key.endswith("/"):
                continue
            # Дневной проход не трогает weekly/ — у них свой срок (90 дней).
            if prefix == "postgres/" and key.startswith("postgres/weekly/"):
                continue
            if obj.get("LastModified", now) >= cutoff:
                continue
            s3.delete_object(Bucket=bucket, Key=key)
            log("удалён старый бэкап: %s" % key)
            deleted += 1
        token = res.get("NextContinuationToken") if res.get("IsTruncated") else None
        if not token:
            break
    return deleted


def load_dotenv():
    """Подтянуть переменные из корневого .env (не перезаписывая окружение)."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip("'").strip('"')
            if key and key not in os.environ:
                os.environ[key] = val


def main(argv):
    load_dotenv()
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        die("не задан DATABASE_URL")
    endpoint = os.environ.get("BACKUP_S3_ENDPOINT", "http://127.0.0.1:9000")
    bucket = os.environ.get("BACKUP_S3_BUCKET", "marketplace-backups")
    access = os.environ.get("BACKUP_S3_ACCESS_KEY_ID", "minioadmin")
    secret = os.environ.get("BACKUP_S3_SECRET_ACCESS_KEY", "minioadmin")
    webhook = os.environ.get("BACKUP_ALERT_WEBHOOK", "")
    pg_dump = find_pg_dump()

    if "--check" in argv:
        log("pg_dump: %s" % (pg_dump or "НЕ НАЙДЕН"))
        try:
            import boto3  # noqa: F401
            log("boto3: ok")
        except ImportError:
            die("нет модуля boto3 — pip install boto3")
        if not pg_dump:
            die("pg_dump не найден")
        log("окружение в порядке")
        return

    if not pg_dump:
        die("pg_dump не найден (PG_DUMP_BIN или PATH)")
    try:
        import boto3
    except ImportError:
        die("нет модуля boto3 — pip install boto3")

    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H-%M-%SZ")
    db_name = parse_db_name(database_url)
    is_weekly = now.isoweekday() == 7

    tmp = tempfile.mkdtemp(prefix="marketplace-backup-")
    dump_file = os.path.join(tmp, "backup-%s.dump" % stamp)
    try:
        # pg_dump не понимает Prisma-параметров (?schema=public) — отрезаем query.
        pg_url = database_url.split("?", 1)[0]
        log("pg_dump %s ..." % db_name)
        r = subprocess.run(
            [pg_dump, pg_url, "--format=custom", "--file=%s" % dump_file, "--no-owner"],
            capture_output=True, text=True,
        )
        if r.returncode != 0 or not os.path.exists(dump_file):
            raise RuntimeError("pg_dump failed: %s" % (r.stderr or r.stdout)[-2000:])
        size_mb = os.path.getsize(dump_file) / 1048576
        log("дамп готов: %.1f МБ" % size_mb)

        s3 = boto3.client(
            "s3", endpoint_url=endpoint, aws_access_key_id=access,
            aws_secret_access_key=secret, region_name="us-east-1",
        )
        try:
            s3.head_bucket(Bucket=bucket)
        except Exception:
            s3.create_bucket(Bucket=bucket)
            log("создан бакет %s" % bucket)

        daily_key = "postgres/%s.dump" % stamp
        s3.upload_file(dump_file, bucket, daily_key)
        log("залито: s3://%s/%s" % (bucket, daily_key))
        if is_weekly:
            weekly_key = "postgres/weekly/%s.dump" % stamp
            s3.upload_file(dump_file, bucket, weekly_key)
            log("воскресенье — дубль в %s" % weekly_key)

        pruned_daily = prune(s3, bucket, "postgres/", RETENTION_DAILY_DAYS, now)
        pruned_weekly = prune(s3, bucket, "postgres/weekly/", RETENTION_WEEKLY_DAYS, now)
        log("retention: удалено дневных=%d недельных=%d" % (pruned_daily, pruned_weekly))
        print("Backup uploaded: %s.dump" % stamp, flush=True)
    except Exception as e:
        alert(webhook, "Marketplace backup FAILED at %s: %s" % (stamp, e))
        die(str(e))
    finally:
        try:
            if os.path.exists(dump_file):
                os.remove(dump_file)
            os.rmdir(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    main(sys.argv[1:])
