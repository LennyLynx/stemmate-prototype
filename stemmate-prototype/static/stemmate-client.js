/* STEMMate client library: local-first storage, offline queue, sync, conflict handling.
   No DOM code in here, so the same file runs in the browser and in the Node integration tests.
   The session token is held by the Client object; the web interface keeps a copy in sessionStorage
   (cleared when the tab closes) so a page reload while offline does not lock the facilitator out. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StemmateClient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUBJECTS = ['Mathematics', 'Physical Science', 'Life Science', 'ICT', 'Robotics', 'Other'];
  var STATUS_TEXT = {
    waiting: 'Saved on this device \u2014 waiting to sync',
    syncing: 'Syncing\u2026',
    synced: 'Synced',
    attention: 'Needs attention',
    conflict: 'Conflict \u2014 choose a version'
  };
  var TEXT_LIMITS = { notes: 500, steps: 1000, materials: 1000, safety: 1000, inclusion: 1000 };
  var TEXT_LABEL = { notes: 'Notes', steps: 'Steps', materials: 'Materials', safety: 'Safety', inclusion: 'Inclusion' };
  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
  var ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
  var DIGIT_RUN_RE = /(?:^|[^\d])(?:\+?\d[ -]?){9,15}(?!\d)/;   // no look-behind: older phones

  function looksPersonal(text) {
    return EMAIL_RE.test(text) || DIGIT_RUN_RE.test(text.replace(ISO_DATE_RE, ' '));
  }
  function personalMessage(field) {
    var label = TEXT_LABEL[field];
    return (field === 'safety' || field === 'inclusion')
      ? label + ' looks like it contains contact or ID details. Remove it.'
      : label + ' look like they contain contact or ID details. Remove them.';
  }
  function localToday() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function isWhole(v) { return typeof v === 'number' && Number.isInteger(v); }

  /* Same rules and wording as the server (app/validation.py) for quick feedback while typing.
     The server is still the authority: it re-checks everything. */
  function validatePlan(d, today) {
    var e = {};
    today = today || localToday();
    var title = typeof d.title === 'string' ? d.title.trim() : '';
    if (!title) e.title = 'Enter a lesson title.';
    else if (title.length > 80) e.title = 'Lesson title must be 80 characters or fewer.';
    if (SUBJECTS.indexOf(d.subject) < 0) e.subject = 'Choose a subject from the list.';
    if (typeof d.lessonDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.lessonDate) ||
        isNaN(Date.parse(d.lessonDate + 'T00:00:00Z')) ||
        new Date(d.lessonDate + 'T00:00:00Z').toISOString().slice(0, 10) !== d.lessonDate) {
      e.lessonDate = 'Enter the lesson date as YYYY-MM-DD.';
    } else if (d.lessonDate > today) e.lessonDate = 'Lesson date cannot be in the future.';
    else if (d.lessonDate < '2000-01-01') e.lessonDate = 'Enter a lesson date from the year 2000 onwards.';
    if (!isWhole(d.durationMin) || d.durationMin < 5 || d.durationMin > 240)
      e.durationMin = 'Duration must be a whole number from 5 to 240 minutes.';
    if (!isWhole(d.learnerCount) || d.learnerCount < 0 || d.learnerCount > 200)
      e.learnerCount = 'Learner count must be a whole number from 0 to 200.';
    Object.keys(TEXT_LIMITS).forEach(function (f) {
      var v = d[f];
      if (v === undefined || v === null || v === '') return;
      if (typeof v !== 'string') e[f] = TEXT_LABEL[f] + ' must be text.';
      else if (v.trim().length > TEXT_LIMITS[f]) e[f] = TEXT_LABEL[f] + ' must be ' + TEXT_LIMITS[f] + ' characters or fewer.';
      else if (looksPersonal(v.trim())) e[f] = personalMessage(f);
    });
    return e;
  }

  var PLAN_FIELDS = ['title', 'subject', 'lessonDate', 'durationMin', 'learnerCount', 'steps', 'materials',
    'safety', 'inclusion', 'notes', 'activityId'];
  function pickFields(src) {
    var out = {};
    PLAN_FIELDS.forEach(function (f) { if (src[f] !== undefined) out[f] = src[f]; });
    return out;
  }
  function uid(prefix) {
    var c = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return prefix + '-' + c;
  }

  function Client(opts) {
    this.baseUrl = opts.baseUrl || '';
    this.storage = opts.storage;
    this.fetchFn = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.token = null;
    this.fid = null;
    this.state = { plans: [], queue: [] };
    this.simulateOffline = false;    // demo switch: pretend the network is down
    this.timeoutMs = opts.timeoutMs || 4000;
  }

  var P = Client.prototype;

  /* ---- storage ------------------------------------------------------------------------------ */
  P._key = function () { return 'stemmate:v2:' + this.fid; };
  P._load = function () {
    try {
      var raw = this.storage.getItem(this._key());
      var s = raw ? JSON.parse(raw) : null;
      this.state = s && Array.isArray(s.plans) && Array.isArray(s.queue) ? s : { plans: [], queue: [] };
    } catch (e) { this.state = { plans: [], queue: [] }; }
  };
  P._save = function () {
    try { this.storage.setItem(this._key(), JSON.stringify(this.state)); return true; }
    catch (e) { return false; }      // storage full or blocked
  };
  P._plan = function (clientId) {
    return this.state.plans.filter(function (p) { return p.clientId === clientId; })[0] || null;
  };

  /* ---- network ------------------------------------------------------------------------------ */
  P.request = function (method, path, body) {
    var self = this;
    if (this.simulateOffline) return Promise.reject({ offline: true });
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, this.timeoutMs) : null;
    var headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    return this.fetchFn(this.baseUrl + path, {
      method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined, cache: 'no-store'
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      var type = res.headers.get('Content-Type') || '';
      return (type.indexOf('json') >= 0 ? res.json() : res.text()).then(function (data) {
        if (res.status === 401 && self.token && path !== '/api/auth/login') self.token = null;
        return { status: res.status, data: data, headers: res.headers };
      });
    }, function () {
      if (timer) clearTimeout(timer);
      return Promise.reject({ offline: true });
    });
  };

  P.isOnline = function () {
    return this.request('GET', '/api/health').then(function (r) { return r.status === 200; },
      function () { return false; });
  };

  /* ---- sign in / out ------------------------------------------------------------------------ */
  P.login = function (facilitatorId, pin) {
    var self = this;
    return this.request('POST', '/api/auth/login', { facilitatorId: facilitatorId, pin: pin }).then(function (r) {
      if (r.status === 200) {
        self.token = r.data.token;
        self.fid = r.data.facilitatorId;
        self._load();
        return { ok: true, facilitatorId: self.fid };
      }
      return { ok: false, status: r.status, message: r.data && r.data.error ? r.data.error.message : 'Sign-in failed.',
        retryAfterSec: r.data && r.data.retryAfterSec };
    }, function () { return { ok: false, offline: true, message: 'You are offline. Sign-in needs a connection to the server.' }; });
  };

  /* Resume a session after a page reload (token and code come from sessionStorage). */
  P.restore = function (token, facilitatorId) {
    this.token = token; this.fid = facilitatorId; this._load();
    return this;
  };

  /* Number of items that exist only on this device. */
  P.unsyncedCount = function () {
    return this.state.queue.length + this.state.plans.filter(function (p) { return p.status === 'conflict' || p.status === 'attention'; }).length;
  };

  P.signOut = function (clearDevice) {
    var self = this;
    var done = function () {
      if (clearDevice && self.fid) { try { self.storage.removeItem(self._key()); } catch (e) { /* ignore */ } }
      self.token = null; self.fid = null; self.state = { plans: [], queue: [] };
      return { ok: true };
    };
    if (!this.token) return Promise.resolve(done());
    return this.request('POST', '/api/auth/logout', {}).then(done, done);   // local sign-out even if offline
  };

  /* ---- plans (local first) ------------------------------------------------------------------- */
  P.plans = function () {
    return this.state.plans.filter(function (p) { return !p.deleted; }).sort(function (a, b) {
      return (b.savedAt || '').localeCompare(a.savedAt || '');
    });
  };

  P.savePlan = function (input, clientId) {
    var data = pickFields(input);
    var errors = validatePlan(data);
    if (Object.keys(errors).length) return { ok: false, errors: errors };
    var plan = clientId ? this._plan(clientId) : null;
    var op;
    if (plan && plan.status === 'conflict') return { ok: false, errors: { _: 'Choose a version for this lesson first.' } };
    if (!plan) {
      plan = { clientId: uid('c'), lessonId: null, version: 0, data: data, status: 'waiting', errors: null, serverCopy: null };
      this.state.plans.push(plan);
    } else {
      plan.data = data;
    }
    plan.status = 'waiting';
    plan.errors = null;
    plan.savedAt = new Date().toISOString();
    var queue = this.state.queue;
    var existing = queue.filter(function (o) { return o.clientId === plan.clientId && (o.type === 'create' || o.type === 'update'); })[0];
    if (existing) { existing.data = data; }                       // merge repeated edits into one operation
    else if (plan.lessonId === null) queue.push({ opId: uid('op'), type: 'create', clientId: plan.clientId, data: data });
    else queue.push({ opId: uid('op'), type: 'update', clientId: plan.clientId, baseVersion: plan.version, data: data });
    if (!this._save()) return { ok: false, errors: { _: 'This device is out of storage space. Free some space and save again.' }, storageFull: true };
    return { ok: true, plan: plan };
  };

  P.deletePlan = function (clientId) {
    var plan = this._plan(clientId);
    if (!plan) return false;
    this.state.queue = this.state.queue.filter(function (o) { return o.clientId !== clientId; });
    if (plan.lessonId === null) {
      this.state.plans = this.state.plans.filter(function (p) { return p.clientId !== clientId; });   // never reached the server
    } else {
      plan.deleted = true;
      this.state.queue.push({ opId: uid('op'), type: 'delete', clientId: clientId, baseVersion: plan.version });
    }
    return this._save();
  };

  /* ---- sync ---------------------------------------------------------------------------------- */
  P.syncNow = function () {
    var self = this;
    if (!this.token) return Promise.resolve({ unauthorised: true });
    var batch = this.state.queue.slice(0, 100);
    if (!batch.length) return this.pull().then(function (p) { return Object.assign({ synced: 0 }, p); });
    batch.forEach(function (o) { var p = self._plan(o.clientId); if (p) p.status = 'syncing'; });
    return this.request('POST', '/api/sync', { ops: batch }).then(function (r) {
      if (r.status === 401) { self._restoreWaiting(batch); return { unauthorised: true }; }
      if (r.status !== 200) { self._restoreWaiting(batch); return { failed: true, message: r.data && r.data.error ? r.data.error.message : 'Sync failed.' }; }
      var counts = { applied: 0, rejected: 0, conflict: 0 };
      r.data.results.forEach(function (res) {
        var op = batch.filter(function (o) { return o.opId === res.opId; })[0];
        if (!op) return;
        self.state.queue = self.state.queue.filter(function (o) { return o.opId !== op.opId; });
        var plan = self._plan(op.clientId);
        counts[res.status] = (counts[res.status] || 0) + 1;
        if (res.status === 'applied') {
          if (op.type === 'delete') { self.state.plans = self.state.plans.filter(function (p) { return p.clientId !== op.clientId; }); }
          else if (plan && res.lesson) {
            plan.lessonId = res.lesson.lessonId; plan.version = res.lesson.version;
            var more = self.state.queue.some(function (o) { return o.clientId === op.clientId; });
            plan.status = more ? 'waiting' : 'synced'; plan.errors = null;
          }
        } else if (res.status === 'conflict' && plan) {
          plan.status = 'conflict'; plan.serverCopy = res.serverCopy || null;
        } else if (plan) {
          plan.status = 'attention'; plan.errors = res.error && res.error.fields ? res.error.fields : { _: res.error ? res.error.message : 'The server did not accept this lesson.' };
          if (res.error && res.error.code === 'not_found') { plan.lessonId = null; plan.version = 0; }
        }
      });
      self._save();
      return self.pull().then(function (p) { return Object.assign({ synced: counts.applied, rejected: counts.rejected, conflicts: counts.conflict }, p); });
    }, function () { self._restoreWaiting(batch); return { offline: true }; });
  };

  P._restoreWaiting = function (batch) {
    var self = this;
    batch.forEach(function (o) { var p = self._plan(o.clientId); if (p && p.status === 'syncing') p.status = 'waiting'; });
    this._save();
  };

  /* Bring in lessons created or changed on other devices. Never overwrites unsynced local work. */
  P.pull = function () {
    var self = this;
    return this.request('GET', '/api/lessons').then(function (r) {
      if (r.status !== 200) return {};
      var server = r.data.lessons, ids = {};
      server.forEach(function (l) {
        ids[l.clientId] = true;
        var p = self._plan(l.clientId);
        var data = pickFields(l);
        if (!p) {
          self.state.plans.push({ clientId: l.clientId, lessonId: l.lessonId, version: l.version, data: data,
            status: 'synced', errors: null, serverCopy: null, savedAt: l.updatedAt });
        } else if (p.status === 'synced' && l.version > p.version) {
          p.data = data; p.version = l.version; p.savedAt = l.updatedAt;
        }
      });
      self.state.plans = self.state.plans.filter(function (p) { return p.status !== 'synced' || ids[p.clientId]; });
      self._save();
      return { pulled: server.length };
    }, function () { return {}; });
  };

  /* choice 'phone' = keep my edit (re-send it on top of the server's version); 'online' = take the server copy */
  P.resolveConflict = function (clientId, choice) {
    var plan = this._plan(clientId);
    if (!plan || plan.status !== 'conflict' || !plan.serverCopy) return false;
    if (choice === 'phone') {
      this.state.queue.push({ opId: uid('op'), type: 'update', clientId: clientId, baseVersion: plan.serverCopy.version, data: plan.data });
      plan.status = 'waiting';
    } else {
      plan.data = pickFields(plan.serverCopy); plan.version = plan.serverCopy.version; plan.status = 'synced';
    }
    plan.serverCopy = null; plan.errors = null;
    return this._save();
  };

  /* ---- activities, export, delete ------------------------------------------------------------- */
  P.loadActivities = function () {
    var self = this, key = 'stemmate:v2:activities';
    return this.request('GET', '/api/activities').then(function (r) {
      if (r.status === 200) {
        try { self.storage.setItem(key, JSON.stringify(r.data.activities)); } catch (e) { /* ignore */ }
        return { activities: r.data.activities, fromCache: false };
      }
      throw new Error('bad status');
    }).catch(function () {
      var cached = null;
      try { cached = JSON.parse(self.storage.getItem(key) || 'null'); } catch (e) { /* ignore */ }
      return { activities: cached || [], fromCache: true };
    });
  };

  P.exportFile = function (format) {
    return this.request('GET', '/api/export?format=' + encodeURIComponent(format)).then(function (r) {
      if (r.status !== 200) return { ok: false, message: r.data && r.data.error ? r.data.error.message : 'Export failed.' };
      var text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
      return { ok: true, text: text, filename: 'stemmate-lessons.' + format, mime: format === 'csv' ? 'text/csv' : 'application/json' };
    }, function () { return { ok: false, offline: true, message: 'Export needs a connection to the server.' }; });
  };

  P.deleteAllData = function () {
    var self = this;
    return this.request('POST', '/api/me/delete-all', { confirm: 'DELETE' }).then(function (r) {
      if (r.status !== 200) return { ok: false, message: r.data && r.data.error ? r.data.error.message : 'Could not delete.' };
      self.state = { plans: [], queue: [] }; self._save();
      return { ok: true, deletedLessons: r.data.deletedLessons };
    }, function () { return { ok: false, offline: true, message: 'Deleting server data needs a connection.' }; });
  };

  return { Client: Client, validatePlan: validatePlan, STATUS_TEXT: STATUS_TEXT, SUBJECTS: SUBJECTS, looksPersonal: looksPersonal };
});
