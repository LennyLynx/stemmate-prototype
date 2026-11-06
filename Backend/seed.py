"""Create stemmate.db with SYNTHETIC demo facilitators (no real people, no real learner data).
Usage: python seed.py [--db PATH] [--sample-lessons]"""
import argparse
import sys

from app import auth, db
from app.service import Service

DEMO_FACILITATORS = {"FAC-01": "4821", "FAC-02": "7365"}      # synthetic demo codes and PINs

SAMPLE_LESSONS = [
    {"clientId": "seed-0001", "title": "Fractions with bottle caps", "subject": "Mathematics",
     "lessonDate": "2026-10-12", "durationMin": 45, "learnerCount": 22,
     "steps": "Sort caps into groups; name each fraction; compare.", "materials": "Bottle caps, paper",
     "safety": "Keep small items out of mouths.", "inclusion": "Pair confident readers with others.",
     "notes": "Synthetic sample lesson."},
    {"clientId": "seed-0002", "title": "Paper bridge challenge", "subject": "Physical Science",
     "lessonDate": "2026-10-14", "durationMin": 30, "learnerCount": 18,
     "steps": "Fold paper, test the load, improve the design.", "materials": "Paper, coins, ruler",
     "safety": "Use blunt scissors only.", "inclusion": "Offer large-print instructions.",
     "notes": "Synthetic sample lesson."},
]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=db.default_db_path())
    ap.add_argument("--sample-lessons", action="store_true", help="also add two synthetic lessons for FAC-01")
    args = ap.parse_args(argv)
    svc = Service(args.db)
    conn = db.connect(args.db)
    try:
        for fid, pin in DEMO_FACILITATORS.items():
            auth.set_pin(conn, fid, pin)
    finally:
        conn.close()
    if args.sample_lessons:
        for lesson in SAMPLE_LESSONS:
            svc.create_lesson("FAC-01", lesson, lesson["clientId"])
    print("Created %s with synthetic facilitators: %s" % (args.db, ", ".join(
        "%s (PIN %s)" % kv for kv in DEMO_FACILITATORS.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
