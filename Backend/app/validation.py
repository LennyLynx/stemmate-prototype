"""Server-side validation. The server never trusts client validation."""
import datetime
import re

SUBJECTS = ["Mathematics", "Physical Science", "Life Science", "ICT", "Robotics", "Other"]
TITLE_MAX = 80
NOTES_MAX = 500
TEXT_MAX = 1000          # steps, materials, safety, inclusion

ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ACTIVITY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_ISO_DATE_INSIDE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
# 9 to 15 digits, optionally separated by single spaces or hyphens: phone numbers and
# 11-digit ID numbers. ISO dates are removed first so "2026-10-21 22 learners" is not flagged.
_DIGIT_RUN_RE = re.compile(r"(?<!\d)(?:\+?\d[ -]?){9,15}(?!\d)")

# field -> (maximum length, message when too long, message when it looks personal)
TEXT_FIELDS = {
    "notes": (NOTES_MAX, "Notes must be %d characters or fewer." % NOTES_MAX,
              "Notes look like they contain contact or ID details. Remove them."),
    "steps": (TEXT_MAX, "Steps must be %d characters or fewer." % TEXT_MAX,
              "Steps look like they contain contact or ID details. Remove them."),
    "materials": (TEXT_MAX, "Materials must be %d characters or fewer." % TEXT_MAX,
                  "Materials look like they contain contact or ID details. Remove them."),
    "safety": (TEXT_MAX, "Safety must be %d characters or fewer." % TEXT_MAX,
               "Safety looks like it contains contact or ID details. Remove it."),
    "inclusion": (TEXT_MAX, "Inclusion must be %d characters or fewer." % TEXT_MAX,
                  "Inclusion looks like it contains contact or ID details. Remove it."),
}


def looks_personal(text):
    """True if the text looks like an email address, phone number or ID number.
    This is a simple pattern check: it gives some false positives and cannot find
    every kind of personal detail."""
    if _EMAIL_RE.search(text):
        return True
    return bool(_DIGIT_RUN_RE.search(_ISO_DATE_INSIDE.sub(" ", text)))


def _is_whole_number(v):
    return isinstance(v, int) and not isinstance(v, bool)


def valid_id(value):
    return isinstance(value, str) and bool(ID_RE.match(value))


def validate_lesson(data, today=None):
    """Return (clean, errors). errors maps a field name to a plain-language message.
    Unknown fields are ignored and never stored, so learner names cannot be saved by accident."""
    if not isinstance(data, dict):
        return None, {"_": "Lesson details are missing."}
    today = today or datetime.date.today()
    clean, errors = {}, {}

    title = data.get("title")
    t = title.strip() if isinstance(title, str) else ""
    if not t:
        errors["title"] = "Enter a lesson title."
    elif len(t) > TITLE_MAX:
        errors["title"] = "Lesson title must be %d characters or fewer." % TITLE_MAX
    else:
        clean["title"] = t

    if data.get("subject") in SUBJECTS:
        clean["subject"] = data["subject"]
    else:
        errors["subject"] = "Choose a subject from the list."

    d = data.get("lessonDate")
    if not isinstance(d, str) or not _DATE_RE.match(d):
        errors["lessonDate"] = "Enter the lesson date as YYYY-MM-DD."
    else:
        try:
            parsed = datetime.date.fromisoformat(d)
        except ValueError:
            errors["lessonDate"] = "Enter the lesson date as YYYY-MM-DD."
        else:
            if parsed > today:
                errors["lessonDate"] = "Lesson date cannot be in the future."
            elif parsed.year < 2000:
                errors["lessonDate"] = "Enter a lesson date from the year 2000 onwards."
            else:
                clean["lessonDate"] = d

    dur = data.get("durationMin")
    if _is_whole_number(dur) and 5 <= dur <= 240:
        clean["durationMin"] = dur
    else:
        errors["durationMin"] = "Duration must be a whole number from 5 to 240 minutes."

    lc = data.get("learnerCount")
    if _is_whole_number(lc) and 0 <= lc <= 200:
        clean["learnerCount"] = lc
    else:
        errors["learnerCount"] = "Learner count must be a whole number from 0 to 200."

    for field, (limit, too_long, personal) in TEXT_FIELDS.items():
        v = data.get(field)
        if v is None:
            clean[field] = ""
        elif not isinstance(v, str):
            errors[field] = "%s must be text." % field.capitalize()
        else:
            v = v.strip()
            if len(v) > limit:
                errors[field] = too_long
            elif looks_personal(v):
                errors[field] = personal          # the value itself is never echoed back
            else:
                clean[field] = v

    act = data.get("activityId")
    if act is None or act == "":
        clean["activityId"] = None
    else:
        if _is_whole_number(act):
            act = str(act)
        if isinstance(act, str) and _ACTIVITY_RE.match(act):
            clean["activityId"] = act
        else:
            errors["activityId"] = "The activity reference is not valid."

    return (clean if not errors else None), errors
