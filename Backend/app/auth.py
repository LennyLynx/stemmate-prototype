"""Authentication: PIN hashing, session tokens, lockout. Works on an open sqlite3 connection."""
import hashlib
import hmac
import math
import re
import secrets

ITERATIONS = 120_000
SESSION_SECONDS = 30 * 60        # sliding: each request extends it
MAX_FAILS = 5
LOCK_SECONDS = 5 * 60
_FID_RE = re.compile(r"^[A-Z0-9-]{3,20}$")
_DUMMY_SALT = "00" * 16


class AuthError(Exception):
    """Wrong code or PIN. The message is deliberately the same for both."""


class LockedError(Exception):
    def __init__(self, retry_after):
        super().__init__("locked")
        self.retry_after = retry_after


def normalise_id(fid):
    fid = fid.strip().upper() if isinstance(fid, str) else ""
    return fid if _FID_RE.match(fid) else None


def new_salt():
    return secrets.token_hex(16)


def hash_pin(pin, salt_hex):
    return hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), bytes.fromhex(salt_hex), ITERATIONS).hex()


def valid_pin_format(pin):
    return isinstance(pin, str) and 4 <= len(pin) <= 8 and pin.isascii() and pin.isdigit()


def token_digest(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def set_pin(conn, fid, pin):
    """Create the facilitator or replace the PIN. Also clears any lock."""
    fid = normalise_id(fid)
    if not fid or not valid_pin_format(pin):
        raise ValueError("Facilitator code must be 3-20 letters, digits or hyphens; PIN must be 4-8 digits.")
    salt = new_salt()
    conn.execute(
        "INSERT INTO facilitator(facilitator_id, pin_hash, pin_salt, failed_attempts, locked_until) "
        "VALUES (?,?,?,0,0) ON CONFLICT(facilitator_id) DO UPDATE SET "
        "pin_hash=excluded.pin_hash, pin_salt=excluded.pin_salt, failed_attempts=0, locked_until=0",
        (fid, hash_pin(pin, salt), salt))
    return fid


def login(conn, fid, pin, now):
    """Return (facilitator_id, token). Raises AuthError or LockedError. Call inside a transaction."""
    fid = normalise_id(fid)
    row = conn.execute("SELECT * FROM facilitator WHERE facilitator_id=?", (fid,)).fetchone() if fid else None
    if row is None:
        hash_pin("0000", _DUMMY_SALT)      # similar work for unknown codes, so timing does not reveal them
        raise AuthError()
    if row["locked_until"] > now:
        raise LockedError(math.ceil(row["locked_until"] - now))
    ok = valid_pin_format(pin) and hmac.compare_digest(hash_pin(pin, row["pin_salt"]), row["pin_hash"])
    if not ok:
        fails = row["failed_attempts"] + 1
        if fails >= MAX_FAILS:
            conn.execute("UPDATE facilitator SET failed_attempts=0, locked_until=? WHERE facilitator_id=?",
                         (now + LOCK_SECONDS, row["facilitator_id"]))
            raise LockedError(LOCK_SECONDS)
        conn.execute("UPDATE facilitator SET failed_attempts=? WHERE facilitator_id=?", (fails, row["facilitator_id"]))
        raise AuthError()
    conn.execute("UPDATE facilitator SET failed_attempts=0, locked_until=0 WHERE facilitator_id=?",
                 (row["facilitator_id"],))
    token = secrets.token_urlsafe(32)
    conn.execute("INSERT INTO session_token(token, facilitator_id, expires_at) VALUES (?,?,?)",
                 (token_digest(token), row["facilitator_id"], now + SESSION_SECONDS))
    return row["facilitator_id"], token


def authenticate(conn, token, now):
    """Return the facilitator id for a live token (and extend it), or None."""
    if not isinstance(token, str) or not token:
        return None
    digest = token_digest(token)
    row = conn.execute("SELECT facilitator_id, expires_at FROM session_token WHERE token=?", (digest,)).fetchone()
    if row is None:
        return None
    if row["expires_at"] <= now:
        conn.execute("DELETE FROM session_token WHERE token=?", (digest,))
        return None
    conn.execute("UPDATE session_token SET expires_at=? WHERE token=?", (now + SESSION_SECONDS, digest))
    return row["facilitator_id"]


def logout(conn, token):
    return conn.execute("DELETE FROM session_token WHERE token=?", (token_digest(token),)).rowcount > 0
