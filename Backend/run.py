"""Start the STEMMate backend and web interface. Usage: python run.py [--host H] [--port P] [--db PATH]
Default address: http://127.0.0.1:8000  (this machine only). HTTPS is NOT provided: put a reverse proxy
in front of it before exposing it beyond a trusted local network."""
import argparse
import os

from app import db
from app.server import make_server
from app.service import Service


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("STEMMATE_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("STEMMATE_PORT", "8000")))
    ap.add_argument("--db", default=db.default_db_path())
    args = ap.parse_args(argv)
    svc = Service(args.db)
    svc.purge_old()                                   # tidy expired tokens and old replay records on start-up
    httpd = make_server(svc, args.host, args.port)
    print("STEMMate running at http://%s:%d  (database: %s)  Ctrl+C to stop" % (args.host, args.port, args.db))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
