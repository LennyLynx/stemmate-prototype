/* STEMMate web interface. Talks to the backend through stemmate-client.js.
   All text is placed with textContent (never innerHTML), so stored notes cannot inject script. */
(function () {
  'use strict';
  var SC = window.StemmateClient;
  var client = new SC.Client({ baseUrl: '', storage: window.localStorage });
  var app = document.getElementById('app');
  var live = document.getElementById('live');
  var banner = document.getElementById('banner');
  var nav = document.getElementById('nav');
  var who = document.getElementById('who');
  var online = true;
  var screen = 'home';
  var activitiesCache = null;
  var filter = '';
  var SAVED_KEY = 'stemmate:v2:saved-activities';

  /* ---- tiny DOM helper -------------------------------------------------------------------- */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function say(msg) { live.textContent = ''; setTimeout(function () { live.textContent = msg; }, 30); }
  function render(nodes, focusSelector) {
    app.textContent = '';
    nodes.forEach(function (n) { if (n) app.appendChild(n); });
    var target = (focusSelector && app.querySelector(focusSelector)) || app.querySelector('h1');
    if (target) { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: false }); }
    nav.hidden = !client.token;
    who.hidden = !client.token;
    who.textContent = client.token ? 'Signed in: ' + client.fid : '';
    Array.prototype.forEach.call(nav.querySelectorAll('button'), function (b) {
      if (b.getAttribute('data-go') === screen) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  function title(text, lead) { return [h('h1', { text: text }), lead ? h('p', { class: 'lead', text: lead }) : null]; }

  /* ---- connection banner (a real check of the server, not a switch) ----------------------------- */
  function paintBanner() {
    var demo = client.simulateOffline;
    banner.className = 'banner ' + (online ? 'online' : 'offline');
    banner.textContent = online ? '\u25CF Online \u2014 changes can sync now'
      : '\u25CF Offline' + (demo ? ' (demo switch is on)' : '') + ' \u2014 your work is saved on this device';
    var b = document.getElementById('demoOffline');
    b.setAttribute('aria-pressed', demo ? 'true' : 'false');
    b.textContent = demo ? 'Demo switch is ON: tap to go back online' : 'Demo: pretend to be offline';
  }
  function checkOnline() {
    return client.isOnline().then(function (ok) {
      var wasOffline = !online;
      online = ok;
      paintBanner();
      if (ok && wasOffline && client.token) return syncAndRefresh(true);
    });
  }
  document.getElementById('demoOffline').addEventListener('click', function () {
    client.simulateOffline = !client.simulateOffline;
    say(client.simulateOffline ? 'Demo offline switch on' : 'Demo offline switch off');
    checkOnline();
  });
  window.addEventListener('online', checkOnline);
  window.addEventListener('offline', checkOnline);
  setInterval(function () { if (!document.hidden) checkOnline(); }, 20000);

  /* ---- sign-in ---------------------------------------------------------------------------------------- */
  function showSignIn(message) {
    screen = 'signin';
    var code = h('input', { id: 'code', type: 'text', autocomplete: 'username', autocapitalize: 'characters', required: true, 'aria-describedby': 'code-hint' });
    var pin = h('input', { id: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', required: true, 'aria-describedby': 'pin-hint' });
    var msg = h('p', { id: 'signin-msg', class: 'err', role: 'alert', text: message || '' });
    if (!message) msg.hidden = true;
    var form = h('form', { novalidate: true }, [
      h('label', { for: 'code' }, ['Facilitator code ', h('span', { class: 'req', text: '(required)' })]), code,
      h('p', { id: 'code-hint', class: 'hint', text: 'For example FAC-01. Your coordinator gives you this code.' }),
      h('label', { for: 'pin' }, ['PIN ', h('span', { class: 'req', text: '(required)' })]), pin,
      h('p', { id: 'pin-hint', class: 'hint', text: '4 to 8 digits.' }), msg,
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Sign in' })
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      client.login(code.value, pin.value).then(function (r) {
        if (r.ok) { sessionStorage.setItem('stemmate:session', JSON.stringify({ t: client.token, f: client.fid })); startSession(); return; }
        pin.value = '';
        showSignIn(r.message);
        var m = document.getElementById('signin-msg'); if (m) m.focus();
      });
    });
    render(title('Sign in', 'Your lesson plans are saved on this device first and sync to the server when you are online.').concat([form]), message ? '#signin-msg' : 'h1');
    if (message) { var m2 = document.getElementById('signin-msg'); m2.setAttribute('tabindex', '-1'); m2.focus(); }
  }

  function startSession() {
    checkOnline().then(function () { return client.syncNow(); }).then(function () { go('home'); });
  }

  /* ---- navigation ----------------------------------------------------------------------------------------- */
  function go(name, arg) {
    if (!client.token) return showSignIn();
    screen = name;
    ({ home: showHome, activities: showActivities, plans: showPlans, account: showAccount, edit: showForm })[name](arg);
  }
  Array.prototype.forEach.call(nav.querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () { go(b.getAttribute('data-go')); });
  });

  function syncAndRefresh(quiet) {
    return client.syncNow().then(function (r) {
      if (r.unauthorised) { sessionStorage.removeItem('stemmate:session'); showSignIn('Your session ended. Sign in again; your unsynced lessons are still on this device.'); return r; }
      if (r.offline) { online = false; paintBanner(); if (!quiet) say('Still offline. Your lessons are saved on this device.'); }
      else if (!quiet) say(r.conflicts ? 'Sync finished. ' + r.conflicts + ' lesson needs your decision.' : 'Sync finished.');
      if (screen === 'plans') showPlans(); else if (screen === 'home') showHome();
      return r;
    });
  }

  /* ---- home ---------------------------------------------------------------------------------------------------------- */
  function card(label, sub, to) {
    return h('button', { class: 'card-btn', type: 'button', onclick: function () { go(to); } }, [h('b', { text: label }), h('span', { class: 'muted', text: sub })]);
  }
  function showHome() {
    var waiting = client.state.queue.length;
    render(title('Hello, Facilitator', 'What do you want to do today?').concat([
      waiting ? h('p', { class: 'toast', text: waiting + (waiting === 1 ? ' lesson is' : ' lessons are') + ' saved on this device and waiting to sync.' }) : null,
      card('1. Browse activities', 'Find a lesson for your class. Works offline.', 'activities'),
      card('2. Create a plan', 'Start a new lesson plan.', 'edit'),
      card('3. View saved plans', 'See your saved work and sync status.', 'plans')
    ]));
  }

  /* ---- activities -------------------------------------------------------------------------------------------------- */
  function savedIds() { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { return []; } }
  function toggleSaved(id) {
    var s = savedIds(), i = s.indexOf(String(id));
    if (i >= 0) s.splice(i, 1); else s.push(String(id));
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(s)); } catch (e) { say('This device is out of storage space.'); }
  }
  function showActivities() {
    client.loadActivities().then(function (r) {
      activitiesCache = r.activities;
      var levels = [];
      r.activities.forEach(function (a) { if (a.level && levels.indexOf(a.level) < 0) levels.push(a.level); });
      var pills = h('div', { class: 'pills', role: 'group', 'aria-label': 'Filter by level' },
        [''].concat(levels).map(function (l) {
          return h('button', { class: 'pill', type: 'button', 'aria-pressed': filter === l ? 'true' : 'false', text: l || 'All',
            onclick: function () { filter = l; showActivities(); } });
        }));
      var saved = savedIds();
      var list = r.activities.filter(function (a) { return !filter || a.level === filter; }).map(function (a) {
        var isSaved = saved.indexOf(String(a.id)) >= 0;
        return h('div', { class: 'card' }, [
          h('h2', { text: a.title }),
          h('p', { class: 'muted', text: [a.desc || a.description || '', a.level ? 'Level: ' + a.level : '', a.duration ? 'Time: ' + a.duration : ''].filter(Boolean).join(' \u2022 ') }),
          h('button', { class: 'btn btn-light', type: 'button', 'aria-pressed': isSaved ? 'true' : 'false',
            text: isSaved ? '\u2713 Saved on this phone (tap to remove)' : 'Save to phone',
            onclick: function () { toggleSaved(a.id); say(isSaved ? 'Removed from this phone.' : 'Saved on this phone.'); showActivities(); } }),
          h('button', { class: 'btn btn-primary', type: 'button', text: 'Use in a new plan', onclick: function () { go('edit', { activity: a }); } })
        ]);
      });
      render(title('Activities', 'Pick a lesson to teach. The list is kept on this device for offline use.').concat([
        r.fromCache ? h('p', { class: 'toast', text: r.activities.length ? 'Showing the list saved on this device.' : 'No activities saved yet. Connect once to download them.' }) : null,
        pills
      ], list, [list.length ? null : h('p', { class: 'lead', text: 'No activities for this level.' })]));
    });
  }

  /* ---- plan form ----------------------------------------------------------------------------------------------------------- */
  var FIELDS = [
    ['title', 'Lesson title', 'text', true, ''],
    ['subject', 'Subject', 'select', true, ''],
    ['lessonDate', 'Lesson date', 'date', true, ''],
    ['durationMin', 'Time needed (minutes)', 'number', true, 'A whole number from 5 to 240.'],
    ['learnerCount', 'Number of learners', 'number', true, 'A number only. Never type learner names.'],
    ['steps', 'Steps', 'textarea', false, 'What will the learners do?'],
    ['materials', 'Materials', 'textarea', false, 'What items do you need?'],
    ['safety', 'Safety', 'textarea', false, 'Any safety rules?'],
    ['inclusion', 'Inclusion', 'textarea', false, 'How will you include every learner?'],
    ['notes', 'Notes', 'textarea', false, 'Do not type learner names, phone numbers, emails or ID numbers.']
  ];
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  function showForm(arg) {
    var existing = arg && arg.clientId ? client._plan(arg.clientId) : null;
    var values = (arg && arg.values) || (existing ? existing.data : { lessonDate: todayStr(), subject: '' });
    if (arg && arg.activity) { values = Object.assign({}, values, { title: arg.activity.title, activityId: String(arg.activity.id) }); }
    var errors = (arg && arg.errors) || {};
    var form = h('form', { novalidate: true });
    var controls = {};
    FIELDS.forEach(function (f) {
      var name = f[0], id = 'f-' + name, el;
      if (f[2] === 'select') {
        el = h('select', { id: id, name: name }, [h('option', { value: '', text: 'Choose a subject' })].concat(SC.SUBJECTS.map(function (s) { return h('option', { value: s, text: s }); })));
      } else if (f[2] === 'textarea') {
        el = h('textarea', { id: id, name: name, rows: name === 'notes' ? 2 : 3 });
      } else {
        el = h('input', { id: id, name: name, type: f[2], max: name === 'lessonDate' ? todayStr() : null,
          min: f[2] === 'number' ? '0' : null, inputmode: f[2] === 'number' ? 'numeric' : null });
      }
      var v = values[name];
      el.value = v === undefined || v === null ? '' : String(v);
      var describedBy = [];
      if (f[4]) describedBy.push(id + '-hint');
      if (errors[name]) { el.setAttribute('aria-invalid', 'true'); describedBy.push(id + '-err'); }
      if (f[3]) el.setAttribute('aria-required', 'true');
      if (describedBy.length) el.setAttribute('aria-describedby', describedBy.join(' '));
      controls[name] = el;
      form.appendChild(h('label', { for: id }, [f[1] + ' ', f[3] ? h('span', { class: 'req', text: '(required)' }) : h('span', { class: 'muted', text: '(optional)' })]));
      form.appendChild(el);
      if (f[4]) form.appendChild(h('p', { id: id + '-hint', class: 'hint', text: f[4] }));
      if (errors[name]) form.appendChild(h('p', { id: id + '-err', class: 'err', text: errors[name] }));
    });
    var save = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save plan' });
    form.appendChild(save);
    form.appendChild(h('button', { class: 'btn btn-light', type: 'button', text: 'Cancel', onclick: function () { go('plans'); } }));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {};
      FIELDS.forEach(function (f) {
        var raw = controls[f[0]].value;
        data[f[0]] = f[2] === 'number' ? (raw.trim() === '' ? null : Number(raw)) : raw;
      });
      if (values.activityId) data.activityId = values.activityId;
      var r = client.savePlan(data, existing ? existing.clientId : null);
      if (!r.ok) {
        screen = 'edit';
        var first = Object.keys(r.errors)[0];
        showForm({ clientId: existing && existing.clientId, values: data, errors: r.errors, focus: first });
        return;
      }
      say('Saved on this device. Waiting to sync.');
      screen = 'plans';
      showPlans({ justSaved: r.plan.clientId });
      if (online) syncAndRefresh(false);
    });
    var count = Object.keys(errors).length;
    var summary = count ? h('div', { class: 'summary', id: 'summary', role: 'alert', tabindex: '-1' },
      [h('span', { text: count === 1 ? 'There is 1 problem to fix. Your other answers are kept.' : 'There are ' + count + ' problems to fix. Your other answers are kept.' })]) : null;
    render(title(existing ? 'Edit lesson plan' : 'New lesson plan',
      'Press Save plan to keep it. It is stored on this device first, so it is not lost if you close the app.').concat([summary, form]),
      count ? '#summary' : 'h1');
    if (count && arg && arg.focus && controls[arg.focus]) { controls[arg.focus].focus(); }
  }

  /* ---- plans ------------------------------------------------------------------------------------------------------------------ */
  var STATUS_ICON = { waiting: '\u23F3 ', syncing: '\u21BB ', synced: '\u2713 ', attention: '\u26A0 ', conflict: '\u26A0 ' };
  var COMPARE = [['title', 'Title'], ['lessonDate', 'Date'], ['subject', 'Subject'], ['durationMin', 'Minutes'], ['learnerCount', 'Learners'],
    ['steps', 'Steps'], ['materials', 'Materials'], ['safety', 'Safety'], ['inclusion', 'Inclusion'], ['notes', 'Notes']];

  function conflictPanel(p) {
    var rows = COMPARE.map(function (c) {
      var mine = p.data[c[0]], theirs = p.serverCopy[c[0]];
      var diff = String(mine == null ? '' : mine) !== String(theirs == null ? '' : theirs);
      return h('tr', {}, [h('th', { scope: 'row', text: c[1] }),
        h('td', { class: diff ? 'diff' : null, text: (mine == null || mine === '' ? '\u2014' : String(mine)) + (diff ? ' (different)' : '') }),
        h('td', { class: diff ? 'diff' : null, text: theirs == null || theirs === '' ? '\u2014' : String(theirs) })]);
    });
    return h('div', {}, [
      h('p', { class: 'err', text: 'This lesson changed since you opened it. Your latest edit was not applied.' }),
      h('table', {}, [h('caption', { text: 'Compare the two versions' }),
        h('thead', {}, [h('tr', {}, [h('th', { scope: 'col', text: 'Field' }), h('th', { scope: 'col', text: 'My phone version' }), h('th', { scope: 'col', text: 'Online version' })])]),
        h('tbody', {}, rows)]),
      h('p', { class: 'hint', text: 'Nothing is merged automatically. Choose which version to keep.' }),
      h('button', { class: 'btn btn-primary', type: 'button', text: 'Keep my phone version', onclick: function () { client.resolveConflict(p.clientId, 'phone'); say('Keeping your phone version. Syncing.'); showPlans(); if (online) syncAndRefresh(false); } }),
      h('button', { class: 'btn btn-light', type: 'button', text: 'Keep the online version', onclick: function () { client.resolveConflict(p.clientId, 'online'); say('Online version kept.'); showPlans(); } })
    ]);
  }

  function showPlans(opts) {
    var plans = client.plans();
    var waiting = client.state.queue.length;
    var cards = plans.map(function (p) {
      var parts = [
        h('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, [
          h('h2', { text: p.data.title }),
          h('span', { class: 'badge ' + p.status, text: STATUS_ICON[p.status] + SC.STATUS_TEXT[p.status] })]),
        h('p', { class: 'muted', text: [p.data.subject, p.data.lessonDate, p.data.durationMin + ' min', p.data.learnerCount + ' learners'].join(' \u2022 ') })
      ];
      ['steps', 'materials', 'safety', 'inclusion'].forEach(function (f) {
        if (p.data[f]) parts.push(h('p', { class: 'muted' }, [h('b', { text: f.charAt(0).toUpperCase() + f.slice(1) + ': ' }), p.data[f]]));
      });
      if (p.status === 'waiting') parts.push(h('p', { class: 'hint', text: online ? 'Not uploaded yet. Tap Sync now.' : 'Not uploaded yet. It will upload when you are back online.' }));
      if (p.status === 'attention') {
        Object.keys(p.errors || {}).forEach(function (k) { parts.push(h('p', { class: 'err', text: p.errors[k] })); });
        parts.push(h('p', { class: 'hint', text: 'The server did not accept this lesson. Edit it, fix the problem and save again.' }));
      }
      if (p.status === 'conflict' && p.serverCopy) parts.push(conflictPanel(p));
      if (p.status !== 'conflict') {
        parts.push(h('div', { class: 'row' }, [
          h('button', { class: 'btn btn-light', type: 'button', text: 'Edit', 'aria-label': 'Edit ' + p.data.title, onclick: function () { go('edit', { clientId: p.clientId }); } }),
          h('button', { class: 'btn btn-danger', type: 'button', text: 'Delete', 'aria-label': 'Delete ' + p.data.title,
            onclick: function () { if (window.confirm('Delete "' + p.data.title + '"?')) { client.deletePlan(p.clientId); say('Lesson deleted.'); showPlans(); if (online) syncAndRefresh(true); } } })]));
      }
      return h('div', { class: 'card', id: 'plan-' + p.clientId }, parts);
    });
    var top = h('div', { class: 'card' }, [
      h('p', { class: 'muted', text: plans.length + (plans.length === 1 ? ' lesson' : ' lessons') + ' on this device. ' + waiting + ' waiting to sync.' }),
      h('button', { class: 'btn btn-primary', type: 'button', text: 'Sync now', onclick: function () { checkOnline().then(function () { if (!online) { say('No connection. Your lessons are saved on this device.'); showPlans({ msg: 'No connection. Nothing was uploaded; your lessons are safe on this device.' }); } else syncAndRefresh(false); }); } })
    ]);
    render(title('My plans', 'Check whether each lesson has been uploaded.').concat([
      opts && opts.justSaved ? h('p', { class: 'toast', text: 'Saved on this device. ' + (online ? 'Syncing now.' : 'It will sync when you are online.') }) : null,
      opts && opts.msg ? h('p', { class: 'toast', text: opts.msg }) : null, top,
      plans.length ? null : h('div', { class: 'card' }, [h('b', { text: 'No plans yet' }), h('p', { class: 'muted', text: 'Create your first lesson plan from Home.' })])
    ], cards));
  }

  /* ---- account: export, sign out, delete ---------------------------------------------------------------------------------------- */
  function download(file) {
    var url = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
    var a = document.createElement('a'); a.href = url; a.download = file.filename; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }
  function showAccount(opts) {
    var unsynced = client.unsyncedCount();
    function doExport(fmt) { client.exportFile(fmt).then(function (r) { if (r.ok) { download(r); say('Export ready.'); } else showAccount({ msg: r.message }); }); }
    function out(clear) {
      var warn = unsynced && clear ? 'You have ' + unsynced + ' lesson change(s) that are only on this device. Clearing the device will delete them for good. Continue?' : null;
      if (warn && !window.confirm(warn)) return;
      client.signOut(clear).then(function () { sessionStorage.removeItem('stemmate:session'); showSignIn(); say('You are signed out.'); });
    }
    render(title('Account', 'Signed in as ' + client.fid + '.').concat([
      opts && opts.msg ? h('p', { class: 'toast', text: opts.msg }) : null,
      h('div', { class: 'card' }, [h('h2', { text: 'Export my lessons' }), h('p', { class: 'muted', text: 'Downloads your own lessons from the server. Needs a connection.' }),
        h('button', { class: 'btn btn-light', type: 'button', text: 'Export as CSV (spreadsheet)', onclick: function () { doExport('csv'); } }),
        h('button', { class: 'btn btn-light', type: 'button', text: 'Export as JSON', onclick: function () { doExport('json'); } })]),
      h('div', { class: 'card' }, [h('h2', { text: 'Sign out' }),
        unsynced ? h('p', { class: 'err', text: unsynced + ' change(s) are only on this device and not uploaded yet.' }) : h('p', { class: 'muted', text: 'Everything is uploaded.' }),
        h('p', { class: 'hint', text: 'Sign out keeps your lessons on this device. On a shared device, use the second button after everything is uploaded.' }),
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Sign out', onclick: function () { out(false); } }),
        h('button', { class: 'btn btn-light', type: 'button', text: 'Sign out and clear this device', onclick: function () { out(true); } })]),
      h('div', { class: 'card' }, [h('h2', { text: 'Delete my data' }), h('p', { class: 'muted', text: 'Deletes all your lessons from the server and from this device. This cannot be undone.' }),
        h('button', { class: 'btn btn-danger', type: 'button', text: 'Delete all my lessons',
          onclick: function () { if (window.confirm('Delete ALL your lessons from the server and this device? This cannot be undone.')) client.deleteAllData().then(function (r) { showAccount({ msg: r.ok ? 'Deleted ' + r.deletedLessons + ' lesson(s).' : r.message }); }); } })])
    ]));
  }

  /* ---- start-up --------------------------------------------------------------------------------------------------------------------------- */
  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(function () { /* offline start-up is optional */ }); }
  var saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('stemmate:session') || 'null'); } catch (e) { saved = null; }
  paintBanner();
  if (saved && saved.t && saved.f) {
    client.restore(saved.t, saved.f);
    checkOnline().then(function () {
      if (online) return client.request('GET', '/api/me').then(function (r) { return r.status === 200; }, function () { return true; });
      return true;
    }).then(function (valid) { if (valid) { go('home'); if (online) syncAndRefresh(true); } else { sessionStorage.removeItem('stemmate:session'); showSignIn('Your session ended. Sign in again.'); } });
  } else {
    checkOnline();
    showSignIn();
  }
})();
