"""Local administration without a server or an admin screen.
  python manage.py add-facilitator CODE        add a facilitator (asks for a 4-8 digit PIN)
  python manage.py reset-pin CODE              set a new PIN and clear any lock
  python manage.py unlock CODE                 clear a lock after repeated wrong PINs
  python manage.py backup FILE                 copy the database safely while it is in use
  python manage.py purge                       remove expired tokens and old replay/audit records
  python manage.py check-activities            check the activity catalogue file
Add --db PATH before the command to use a different database file."""
import argparse
import getpass
import sqlite3
import sys

from app import auth, db
from app.service import Service


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=db.default_db_path())
    ap.add_argument("command", choices=["add-facilitator", "reset-pin", "unlock", "backup", "purge", "check-activities"])
    ap.add_argument("arg", nargs="?")
    args = ap.parse_args(argv)
    svc = Service(args.db)
    conn = db.connect(args.db)
    try:
        if args.command in ("add-facilitator", "reset-pin"):
            if not args.arg:
                sys.exit("Give the facilitator code, e.g. FAC-03")
            pin = getpass.getpass("New PIN (4-8 digits): ")
            if pin != getpass.getpass("Repeat PIN: "):
                sys.exit("The PINs did not match.")
            print("Saved", auth.set_pin(conn, args.arg, pin))
        elif args.command == "unlock":
            fid = auth.normalise_id(args.arg or "")
            n = conn.execute("UPDATE facilitator SET failed_attempts=0, locked_until=0 WHERE facilitator_id=?",
                             (fid,)).rowcount
            print("Unlocked" if n else "No such facilitator", fid)
        elif args.command == "backup":
            if not args.arg:
                sys.exit("Give the backup file name, e.g. backup.db")
            dest = sqlite3.connect(args.arg)
            try:
                conn.backup(dest)
            finally:
                dest.close()
            print("Backup written to", args.arg, "(contains PIN hashes: store it safely)")
        elif args.command == "purge":
            print(svc.purge_old())
        elif args.command == "check-activities":
            items = svc.activities()
            print("%d activities loaded from %s" % (len(items), svc.activities_path))
            for a in items:
                print(" -", a["id"], a["title"])
    finally:
        conn.close()


if __name__ == "__main__":
    main()
