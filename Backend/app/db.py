"""Persistence layer: SQLite schema and connections (foreign keys on, WAL journal)."""
import os
import sqlite3

SCHEMA_VERSION = 2
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def default_db_path():
    return os.environ.get("STEMMATE_DB", os.path.join(ROOT, "stemmate.db"))


SCHEMA = """
CREATE TABLE IF NOT EXISTS facilitator (
    facilitator_id  TEXT PRIMARY KEY,
    pin_hash        TEXT NOT NULL,
    pin_salt        TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_token (
    token          TEXT PRIMARY KEY,           -- SHA-256 of the token, never the token itself
    facilitator_id TEXT NOT NULL REFERENCES facilitator(facilitator_id) ON DELETE CASCADE,
    expires_at     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS lesson (
    lesson_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id      TEXT NOT NULL,
    facilitator_id TEXT NOT NULL REFERENCES facilitator(facilitator_id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    subject        TEXT NOT NULL,
    lesson_date    TEXT NOT NULL,
    duration_min   INTEGER NOT NULL,
    learner_count  INTEGER NOT NULL,
    notes          TEXT NOT NULL DEFAULT '',
    steps          TEXT NOT NULL DEFAULT '',
    materials      TEXT NOT NULL DEFAULT '',
    safety         TEXT NOT NULL DEFAULT '',
    inclusion      TEXT NOT NULL DEFAULT '',
    activity_id    TEXT,
    version        INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    UNIQUE (facilitator_id, client_id)
);
CREATE TABLE IF NOT EXISTS sync_op (
    op_id          TEXT NOT NULL,
    facilitator_id TEXT NOT NULL REFERENCES facilitator(facilitator_id) ON DELETE CASCADE,
    result         TEXT NOT NULL,
    response_json  TEXT NOT NULL,              -- status and ids only, never lesson content
    created_at     TEXT NOT NULL,
    PRIMARY KEY (facilitator_id, op_id)
);
CREATE TABLE IF NOT EXISTS audit_log (
    at             TEXT NOT NULL,
    facilitator_id TEXT,
    event          TEXT NOT NULL,
    detail         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_lesson_owner ON lesson(facilitator_id, lesson_id);
"""


def connect(path):
    # isolation_level=None: autocommit; transactions are opened explicitly with BEGIN IMMEDIATE.
    conn = sqlite3.connect(path, timeout=5, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(path):
    """Create the schema if needed. Refuses to touch a database from an older schema."""
    conn = connect(path)
    try:
        has_lesson = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='lesson'").fetchone()
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if has_lesson and version != SCHEMA_VERSION:
            raise RuntimeError(
                "This database uses an older schema (version %d). It only holds synthetic "
                "demo data: delete the file and run 'python seed.py' again." % version)
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA user_version=%d" % SCHEMA_VERSION)
    finally:
        conn.close()
