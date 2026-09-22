/* ============================================================
   DayDing — daily routine alarms
   Features: routine table (localStorage), scheduled alarms,
   synthesized ringtones (Web Audio), snooze, notifications.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- constants & state ---------------- */

  const LS_ROUTINES = 'dayding.routines.v1';
  const LS_FIRED = 'dayding.firedLog.v1';
  const LS_SNOOZES = 'dayding.snoozes.v1';
  const SNOOZE_MINUTES = 5;
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const RINGTONE_LABELS = {
    classic: 'Classic Bell',
    digital: 'Digital Beep',
    chime: 'Gentle Chime',
    sunrise: 'Morning Rise',
  };

  const DEFAULT_ROUTINES = [
    { id: 'r-wake',      time: '06:00', title: 'Wake up & freshen up',     note: 'Drink a glass of water',   days: [0,1,2,3,4,5,6], ringtone: 'chime',   enabled: true },
    { id: 'r-workout',   time: '06:30', title: 'Morning workout',          note: '20 min stretch or walk',   days: [1,2,3,4,5],     ringtone: 'sunrise', enabled: true },
    { id: 'r-breakfast', time: '08:00', title: 'Breakfast',                note: 'Eat something healthy',    days: [0,1,2,3,4,5,6], ringtone: 'classic', enabled: true },
    { id: 'r-work',      time: '09:00', title: 'Start work / study',       note: 'Focus block one',          days: [1,2,3,4,5],     ringtone: 'digital', enabled: true },
    { id: 'r-hydrate',   time: '11:30', title: 'Hydration & snack break',  note: '',                         days: [0,1,2,3,4,5,6], ringtone: 'chime',   enabled: true },
    { id: 'r-lunch',     time: '13:00', title: 'Lunch break',              note: 'Step away from the screen',days: [0,1,2,3,4,5,6], ringtone: 'classic', enabled: true },
    { id: 'r-walk',      time: '18:00', title: 'Evening walk / exercise',  note: '',                         days: [0,1,2,3,4,5,6], ringtone: 'sunrise', enabled: true },
    { id: 'r-dinner',    time: '20:00', title: 'Dinner',                   note: '',                         days: [0,1,2,3,4,5,6], ringtone: 'chime',   enabled: true },
    { id: 'r-plan',      time: '21:30', title: 'Plan tomorrow',            note: '5 minutes of journaling',  days: [0,1,2,3,4,5,6], ringtone: 'digital', enabled: true },
    { id: 'r-sleep',     time: '22:30', title: 'Wind down & sleep',        note: 'Screens off',              days: [0,1,2,3,4,5,6], ringtone: 'chime',   enabled: true },
  ];

  let routines = [];
  let firedLog = {};          // { routineId: 'YYYY-MM-DD' } last day each alarm fired
  let snoozes = [];           // [{ key, title, note, timeLabel, ringtone, fireAt }]
  let currentAlarm = null;    // { player, vibInterval, wakeLock }
  let previewPlayer = null;
  let previewTimer = null;
  let audioCtx = null;

  /* ---------------- helpers ---------------- */

  const $ = (sel) => document.querySelector(sel);

  function loadLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function saveLS(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full/blocked */ }
  }

  function uid() {
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function timeToMinutes(hhmm) {
    const parts = String(hhmm).split(':');
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  }

  function fmt12(hhmm) {
    let h = timeToMinutes(hhmm) / 60 | 0;
    const m = timeToMinutes(hhmm) % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + ampm;
  }

  function fmtClock(d) {
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') + ' ' + ampm;
  }

  function daysLabel(days) {
    if (!Array.isArray(days) || days.length === 0) return 'Never';
    if (days.length === 7) return 'Every day';
    const set = new Set(days);
    const weekdays = [1, 2, 3, 4, 5].every((d) => set.has(d));
    const weekend = [0, 6].every((d) => set.has(d));
    if (weekdays && weekend) return 'Every day';
    if (weekdays && days.length === 5) return 'Weekdays';
    if (weekend && days.length === 2) return 'Weekends';
    return [1, 2, 3, 4, 5, 6, 0].filter((d) => set.has(d)).map((d) => DAY_LABELS[d]).join(' · ');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showToast(msg, ms) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, ms || 3000);
  }

  /* ---------------- Web Audio: ringtones ---------------- */

  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function tone(ctx, out, opts) {
    const start = opts.start;
    const dur = opts.dur || 0.2;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, start);
    if (opts.glideTo) osc.frequency.exponentialRampToValueAtTime(opts.glideTo, start + dur);
    const vol = opts.vol || 0.4;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(vol, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain); gain.connect(out);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  /* Each ringtone schedules ONE repeating cycle starting at `t`. */
  const RINGTONES = {
    classic: {
      label: RINGTONE_LABELS.classic,
      cycle: 2.4,
      play(ctx, out, t) {
        // "ding-ding… pause" bell strikes
        [0, 0.55].forEach((off) => {
          tone(ctx, out, { start: t + off, dur: 0.5, freq: 1318.5, type: 'triangle', vol: 0.35 });
          tone(ctx, out, { start: t + off, dur: 0.5, freq: 1975.5, type: 'sine', vol: 0.18 });
        });
      },
    },
    digital: {
      label: RINGTONE_LABELS.digital,
      cycle: 1.8,
      play(ctx, out, t) {
        // rapid square-wave beeps: beep x6, pause
        for (let i = 0; i < 6; i++) {
          tone(ctx, out, { start: t + i * 0.18, dur: 0.11, freq: 1560, type: 'square', vol: 0.18 });
        }
      },
    },
    chime: {
      label: RINGTONE_LABELS.chime,
      cycle: 2.6,
      play(ctx, out, t) {
        // gentle ascending arpeggio E5 G5 C6 E6
        const notes = [659.25, 783.99, 1046.5, 1318.5];
        notes.forEach((f, i) => {
          tone(ctx, out, { start: t + i * 0.34, dur: 0.65, freq: f, type: 'sine', vol: 0.3 });
        });
      },
    },
    sunrise: {
      label: RINGTONE_LABELS.sunrise,
      cycle: 2.2,
      play(ctx, out, t) {
        // two rising sweeps — energetic wake-up
        [0, 0.95].forEach((off) => {
          tone(ctx, out, { start: t + off, dur: 0.7, freq: 320, glideTo: 1280, type: 'sawtooth', vol: 0.16 });
          tone(ctx, out, { start: t + off, dur: 0.7, freq: 640, glideTo: 2560, type: 'sine', vol: 0.12 });
        });
      },
    },
  };

  function startRingtone(name) {
    const ctx = ensureAudio();
    if (!ctx) return { stop() {} };
    const def = RINGTONES[name] || RINGTONES.classic;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    let nextT = ctx.currentTime + 0.06;
    def.play(ctx, master, nextT);
    nextT += def.cycle;

    const scheduler = setInterval(() => {
      while (nextT < ctx.currentTime + 1.5) {
        def.play(ctx, master, nextT);
        nextT += def.cycle;
      }
    }, 200);

    return {
      stop() {
        clearInterval(scheduler);
        try { master.disconnect(); } catch (e) { /* already stopped */ }
      },
    };
  }

  function playPreview(name) {
    stopPreview();
    previewPlayer = startRingtone(name);
    previewTimer = setTimeout(stopPreview, 2600);
  }

  function stopPreview() {
    if (previewPlayer) { previewPlayer.stop(); previewPlayer = null; }
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  }

  /* ---------------- alarm firing ---------------- */

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        return await navigator.wakeLock.request('screen');
      }
    } catch (e) { /* not allowed */ }
    return null;
  }

  function fireAlarm(item) {
    // item: { title, note, timeLabel, ringtone }
    stopPreview();
    if (currentAlarm) stopAlarmSound();

    $('#alarmTime').textContent = item.timeLabel;
    $('#alarmTitle').textContent = item.title;
    $('#alarmNote').textContent = item.note || '';
    $('#alarmOverlay').hidden = false;
    document.body.classList.add('no-scroll');

    currentAlarm = currentAlarm || {};
    currentAlarm.player = startRingtone(item.ringtone);
    currentAlarm.item = item;

    if (navigator.vibrate) {
      try {
        navigator.vibrate([400, 150, 400]);
        currentAlarm.vibInterval = setInterval(() => navigator.vibrate([400, 150, 400]), 1500);
      } catch (e) { /* unsupported */ }
    }

    requestWakeLock().then((lock) => { if (currentAlarm) currentAlarm.wakeLock = lock; });
    notify(item);
  }

  function stopAlarmSound() {
    if (!currentAlarm) return;
    if (currentAlarm.player) { currentAlarm.player.stop(); currentAlarm.player = null; }
    if (currentAlarm.vibInterval) { clearInterval(currentAlarm.vibInterval); currentAlarm.vibInterval = null; }
    if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
    if (currentAlarm.wakeLock) { try { currentAlarm.wakeLock.release(); } catch (e) {} currentAlarm.wakeLock = null; }
  }

  function closeAlarmOverlay() {
    $('#alarmOverlay').hidden = true;
    document.body.classList.remove('no-scroll');
  }

  function snoozeAlarm() {
    const item = currentAlarm && currentAlarm.item;
    stopAlarmSound();
    closeAlarmOverlay();
    currentAlarm = null;
    if (!item) return;
    const fireAt = Date.now() + SNOOZE_MINUTES * 60 * 1000;
    snoozes.push({ key: uid(), title: item.title, note: item.note, timeLabel: item.timeLabel, ringtone: item.ringtone, fireAt });
    saveLS(LS_SNOOZES, snoozes);
    const at = new Date(fireAt);
    showToast('😴 Snoozed “' + item.title + '” until ' + fmtClock(at).slice(0, -6) + ' ' + fmtClock(at).slice(-2));
  }

  function dismissAlarm() {
    stopAlarmSound();
    closeAlarmOverlay();
    currentAlarm = null;
    showToast('✓ Alarm dismissed. Have a great one!');
  }

  function notify(item) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification('⏰ ' + item.title, {
        body: item.timeLabel + (item.note ? ' — ' + item.note : ''),
        tag: 'dayding-alarm',
      });
    } catch (e) { /* notifications blocked (e.g. iOS Safari) */ }
  }

  /* ---------------- scheduler tick ---------------- */

  function tick() {
    const now = new Date();

    $('#clockTime').textContent = fmtClock(now);
    $('#clockDate').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

    // 1) snoozed alarms due?
    if (snoozes.length) {
      const due = snoozes.filter((s) => s.fireAt <= Date.now());
      if (due.length) {
        snoozes = snoozes.filter((s) => s.fireAt > Date.now());
        saveLS(LS_SNOOZES, snoozes);
        fireAlarm(due[due.length - 1]);
      }
    }

    // 2) scheduled routines (match HH:MM once per day)
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const today = todayStr(now);
    const weekday = now.getDay();
    let fired = false;

    routines.forEach((r) => {
      if (!r.enabled || fired) return;
      if (r.time !== hhmm) return;
      if (!Array.isArray(r.days) || r.days.indexOf(weekday) === -1) return;
      if (firedLog[r.id] === today) return;
      firedLog[r.id] = today;
      saveLS(LS_FIRED, firedLog);
      fireAlarm({ title: r.title, note: r.note, timeLabel: fmt12(r.time), ringtone: r.ringtone });
      fired = true;
    });

    updateNextInfo(now);
  }

  function findNextRoutine(from) {
    let best = null;
    for (let offset = 0; offset < 8 && !best; offset++) {
      const day = new Date(from);
      day.setDate(day.getDate() + offset);
      const wd = day.getDay();
      routines
        .filter((r) => r.enabled && Array.isArray(r.days) && r.days.indexOf(wd) !== -1)
        .forEach((r) => {
          const dt = new Date(day);
          dt.setHours(Math.floor(timeToMinutes(r.time) / 60), timeToMinutes(r.time) % 60, 0, 0);
          if (dt > from && (!best || dt < best.dt)) best = { dt, routine: r };
        });
    }
    return best;
  }

  function updateNextInfo(now) {
    // nearest of: next routine OR pending snooze
    let text = 'No upcoming alarms — add a routine below.';
    const next = findNextRoutine(now);
    let bestDt = next ? next.dt : null;

    if (next) {
      const diffMin = Math.round((next.dt - now) / 60000);
      let rel;
      if (diffMin < 60) rel = 'in ' + diffMin + ' min';
      else if (diffMin < 24 * 60) rel = 'in ' + Math.floor(diffMin / 60) + 'h ' + (diffMin % 60) + 'm';
      else rel = next.dt.toLocaleDateString(undefined, { weekday: 'short' });
      text = next.routine.title + ' — ' + fmt12(next.routine.time) + ' (' + rel + ')';
    }

    snoozes.forEach((s) => {
      if (!bestDt || s.fireAt < bestDt.getTime()) {
        bestDt = new Date(s.fireAt);
        const mins = Math.max(1, Math.round((s.fireAt - Date.now()) / 60000));
        text = '😴 ' + s.title + ' (snoozed, rings in ' + mins + ' min)';
      }
    });

    $('#nextInfo').textContent = text;

    // highlight the next row in the table
    document.querySelectorAll('#routineBody tr').forEach((tr) => tr.classList.remove('is-next'));
    if (next && next.dt.toDateString() === now.toDateString()) {
      const row = document.querySelector('#routineBody tr[data-id="' + next.routine.id + '"]');
      if (row) {
        row.classList.add('is-next');
        const badge = row.querySelector('.next-badge');
        if (badge) badge.hidden = false;
      }
    }
    document.querySelectorAll('#routineBody tr .next-badge').forEach((b) => {
      if (!b.closest('tr').classList.contains('is-next')) b.hidden = true;
    });
  }

  /* ---------------- rendering ---------------- */

  function renderTable() {
    const tbody = $('#routineBody');
    const sorted = routines.slice().sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time) || a.title.localeCompare(b.title));

    $('#routineCount').textContent = routines.filter((r) => r.enabled).length + ' active';
    $('#tableEmpty').hidden = routines.length > 0;

    tbody.innerHTML = sorted.map((r) => {
      return (
        '<tr data-id="' + r.id + '" class="' + (r.enabled ? '' : 'off') + '">' +
          '<td class="td-time" data-label="Time">' + escapeHtml(fmt12(r.time)) +
            '<span class="next-badge" hidden>Next</span></td>' +
          '<td class="td-routine" data-label="Routine"><div class="rt-title">' + escapeHtml(r.title) + '</div>' +
            (r.note ? '<div class="rt-note">' + escapeHtml(r.note) + '</div>' : '') + '</td>' +
          '<td class="td-days" data-label="Days">' + escapeHtml(daysLabel(r.days)) + '</td>' +
          '<td class="td-ringtone" data-label="Ringtone">' + escapeHtml(RINGTONE_LABELS[r.ringtone] || 'Classic Bell') + '</td>' +
          '<td class="td-toggle" data-label="Alarm">' +
            '<label class="switch"><input type="checkbox" data-action="toggle" ' + (r.enabled ? 'checked' : '') +
            ' aria-label="Alarm on/off for ' + escapeHtml(r.title) + '" /><span class="slider"></span></label></td>' +
          '<td class="td-actions">' +
            '<button class="icon-btn" data-action="test" title="Preview ringtone" aria-label="Preview ringtone">▶</button> ' +
            '<button class="icon-btn" data-action="edit" title="Edit" aria-label="Edit">✎</button> ' +
            '<button class="icon-btn danger" data-action="delete" title="Delete" aria-label="Delete">🗑</button>' +
          '</td>' +
        '</tr>'
      );
    }).join('');

    updateNextInfo(new Date());
  }

  /* ---------------- form modal ---------------- */

  let formDays = new Set([0, 1, 2, 3, 4, 5, 6]);

  function refreshDayChips() {
    document.querySelectorAll('#dayChips .chip').forEach((chip) => {
      chip.classList.toggle('on', formDays.has(parseInt(chip.dataset.day, 10)));
    });
  }

  function openForm(routine) {
    stopPreview();
    const isEdit = !!routine;
    $('#formTitle').textContent = isEdit ? 'Edit routine' : 'Add routine';
    $('#f-id').value = isEdit ? routine.id : '';
    $('#f-time').value = isEdit ? routine.time : '07:00';
    $('#f-title').value = isEdit ? routine.title : '';
    $('#f-note').value = isEdit ? (routine.note || '') : '';
    $('#f-ringtone').value = isEdit ? routine.ringtone : 'classic';
    formDays = new Set(isEdit ? routine.days : [0, 1, 2, 3, 4, 5, 6]);
    refreshDayChips();
    $('#formError').hidden = true;
    $('#formModal').hidden = false;
    document.body.classList.add('no-scroll');
    setTimeout(() => $('#f-title').focus(), 60);
  }

  function closeForm() {
    $('#formModal').hidden = true;
    document.body.classList.remove('no-scroll');
    stopPreview();
  }

  function submitForm(ev) {
    ev.preventDefault();
    const time = $('#f-time').value;
    const title = $('#f-title').value.trim();
    const err = $('#formError');

    if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      err.textContent = 'Please pick a valid time.'; err.hidden = false; return;
    }
    if (!title) {
      err.textContent = 'Please give the routine a name.'; err.hidden = false; return;
    }
    if (formDays.size === 0) {
      err.textContent = 'Select at least one day (or use “Every day”).'; err.hidden = false; return;
    }

    const id = $('#f-id').value || uid();
    const data = {
      id,
      time,
      title,
      note: $('#f-note').value.trim(),
      days: Array.from(formDays),
      ringtone: $('#f-ringtone').value,
      enabled: true,
    };

    const idx = routines.findIndex((r) => r.id === id);
    if (idx >= 0) {
      data.enabled = routines[idx].enabled; // preserve on/off state when editing
      routines[idx] = data;
    } else {
      routines.push(data);
    }

    saveLS(LS_ROUTINES, routines);
    renderTable();
    closeForm();
    showToast('💾 Saved “' + title + '” at ' + fmt12(time));
  }

  /* ---------------- boot ---------------- */

  function enableSound() {
    const ctx = ensureAudio();
    if (!ctx) {
      showToast('Sorry, this browser does not support audio playback.');
      return;
    }
    // short confirmation blip
    tone(ctx, ctx.destination, { start: ctx.currentTime + 0.02, dur: 0.15, freq: 880, type: 'sine', vol: 0.25 });
    tone(ctx, ctx.destination, { start: ctx.currentTime + 0.2, dur: 0.2, freq: 1320, type: 'sine', vol: 0.25 });

    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
    $('#soundBanner').hidden = true;
    try { sessionStorage.setItem('dayding.soundOk', '1'); } catch (e) {}
    showToast('🔔 Sound enabled — alarms will ring on this page.');
  }

  function init() {
    routines = loadLS(LS_ROUTINES, null);
    if (!Array.isArray(routines) || routines.length === 0) {
      routines = DEFAULT_ROUTINES.slice();
      saveLS(LS_ROUTINES, routines);
    }
    firedLog = loadLS(LS_FIRED, {}) || {};
    snoozes = (loadLS(LS_SNOOZES, []) || []).filter((s) => s.fireAt > Date.now());
    saveLS(LS_SNOOZES, snoozes);

    if (sessionStorage.getItem('dayding.soundOk') === '1') {
      $('#soundBanner').hidden = true;
    }

    renderTable();
    tick();
    setInterval(tick, 1000);

    /* --- events --- */

    $('#enableSoundBtn').addEventListener('click', enableSound);

    // Unlock audio on the first user gesture anywhere (mobile autoplay rule)
    document.addEventListener('pointerdown', function unlock() {
      ensureAudio();
      document.removeEventListener('pointerdown', unlock);
    }, { once: true });

    $('#addRoutineBtn').addEventListener('click', () => openForm(null));
    $('#formCloseBtn').addEventListener('click', closeForm);
    $('#formCancelBtn').addEventListener('click', closeForm);
    $('#formModal').addEventListener('click', (e) => { if (e.target === $('#formModal')) closeForm(); });
    $('#routineForm').addEventListener('submit', submitForm);

    $('#dayChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const d = parseInt(chip.dataset.day, 10);
      if (formDays.has(d)) formDays.delete(d); else formDays.add(d);
      refreshDayChips();
    });
    $('#daysAll').addEventListener('click', () => { formDays = new Set([0,1,2,3,4,5,6]); refreshDayChips(); });
    $('#daysWeek').addEventListener('click', () => { formDays = new Set([1,2,3,4,5]); refreshDayChips(); });
    $('#daysWeekend').addEventListener('click', () => { formDays = new Set([0,6]); refreshDayChips(); });

    $('#previewRingtoneBtn').addEventListener('click', () => {
      ensureAudio();
      playPreview($('#f-ringtone').value);
    });

    // Table actions (event delegation)
    $('#routineBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const row = e.target.closest('tr[data-id]');
      if (!row) return;
      const r = routines.find((x) => x.id === row.dataset.id);
      if (!r) return;
      const action = btn.dataset.action;

      if (action === 'edit') openForm(r);
      else if (action === 'test') { ensureAudio(); playPreview(r.ringtone); }
      else if (action === 'delete') {
        if (confirm('Delete “' + r.title + '” from your routine?')) {
          routines = routines.filter((x) => x.id !== r.id);
          saveLS(LS_ROUTINES, routines);
          renderTable();
          showToast('🗑 Routine deleted');
        }
      }
    });

    $('#routineBody').addEventListener('change', (e) => {
      const input = e.target.closest('[data-action="toggle"]');
      if (!input) return;
      const row = e.target.closest('tr[data-id]');
      const r = routines.find((x) => x.id === row.dataset.id);
      if (!r) return;
      r.enabled = input.checked;
      saveLS(LS_ROUTINES, routines);
      row.classList.toggle('off', !r.enabled);
      renderTable();
      showToast(r.enabled ? '🔔 Alarm on: ' + r.title : '🔕 Alarm off: ' + r.title);
    });

    // Alarm overlay
    $('#snoozeBtn').addEventListener('click', snoozeAlarm);
    $('#dismissBtn').addEventListener('click', dismissAlarm);

    // Keyboard: Escape closes modal, Enter dismisses ringing alarm
    document.addEventListener('keydown', (e) => {
      if (!$('#alarmOverlay').hidden) {
        if (e.key === 'Enter') dismissAlarm();
        if (e.key === ' ' || e.key.toLowerCase() === 's') snoozeAlarm();
        return;
      }
      if (!$('#formModal').hidden && e.key === 'Escape') closeForm();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
