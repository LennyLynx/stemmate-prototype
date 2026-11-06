# STEMMate Namibia backend and web interface (Role 4, v2)
Python 3.10+ standard library only. No installs, no internet needed to run.

    python seed.py --sample-lessons     # synthetic facilitators FAC-01 (PIN 4821), FAC-02 (PIN 7365)
    python run.py                       # http://127.0.0.1:8000  (API + web interface)
    python manage.py backup backup.db   # safe copy of the database
    python -m unittest discover -s tests -v     # 33 backend tests (B01-B29)
    node --test tests/client_sync.test.mjs      # 13 client-to-backend tests (C01-C13), needs Node 18+
    node tests/ui_e2e.mjs                       # 21 browser checks, needs Playwright + Chromium

Replace data/activities.json with the team repository's 12-activity file.
Not included: HTTPS (use a reverse proxy), password reset screen, background sync, admin screen.
