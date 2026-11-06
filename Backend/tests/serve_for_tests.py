"""Start a throw-away server on a random port with synthetic data, for the browser-side tests.
Prints 'PORT <n>' once ready, then runs until it is killed."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import auth, db                      # noqa: E402
from app.server import make_server            # noqa: E402
from app.service import Service               # noqa: E402

tmp = tempfile.mkdtemp()
path = os.path.join(tmp, "test.db")
svc = Service(path)
conn = db.connect(path)
auth.set_pin(conn, "FAC-01", "4821")
auth.set_pin(conn, "FAC-02", "7365")
conn.close()
httpd = make_server(svc, "127.0.0.1", 0, quiet=True)
print("PORT %d" % httpd.server_address[1], flush=True)
httpd.serve_forever()
