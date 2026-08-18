/* Employee mobile app: sign in, GPS-verified check in/out, calendar, hours. */
(function () {
  const { api, store, $, $$, esc, toast, busy, getFix, durationText, metres, pad } = HR;

  const state = {
    tz: { offset_min: 0, label: '' },
    rules: { max_accuracy_m: 75, max_fix_age_sec: 90, selfie_mode: 'optional' },
    status: null,
    projects: [],
    fix: null,
    photo: null,      // JPEG data URL captured for the next punch
    calMonth: null,   // 'YYYY-MM'
    calDays: [],
  };

  const t = (k) => I18N.t(k);
  const show = (id) => ['loginView', 'pwdView', 'mainView']
    .forEach((v) => $(`#${v}`).classList.toggle('hidden', v !== id));

  /** Company-local now, derived from the server clock offset (not the phone's). */
  function localNow() {
    return new Date(Date.now() + state.tz.offset_min * 60000);
  }
  const localDateStr = () => localNow().toISOString().slice(0, 10);
  const localTimeStr = () => localNow().toISOString().slice(11, 16);

  // ------------------------------------------------------------------ sign in
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginForm button[type=submit]');
    const err = $('#loginError');
    err.classList.add('hidden');
    busy(btn, true, t('signIn'));
    try {
      const out = await api('/auth/login', {
        method: 'POST',
        body: { identifier: $('#identifier').value.trim(), password: $('#password').value },
      });
      store.token = out.token;
      store.user = out.user;
      state.tz = out.tz;
      $('#password').value = '';
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    } finally {
      busy(btn, false);
    }
  });

  $('#pwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#pwdError');
    err.classList.add('hidden');
    if ($('#newPwd').value !== $('#newPwd2').value) {
      err.textContent = t('passwordMismatch');
      return err.classList.remove('hidden');
    }
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { current_password: $('#curPwd').value, new_password: $('#newPwd').value },
      });
      const u = store.user; u.must_change_password = false; store.user = u;
      toast(t('saved'), 'ok');
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });

  $('#pwdForm2').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { current_password: $('#cur2').value, new_password: $('#new2').value },
      });
      $('#cur2').value = $('#new2').value = '';
      toast(t('saved'), 'ok');
    } catch (ex) { toast(ex.message, 'bad'); }
  });

  $('#btnLogout').addEventListener('click', () => { store.clear(); location.reload(); });
  $('#langBtn').addEventListener('click', () => I18N.toggle());
  $('#langBtnLogin').addEventListener('click', () => I18N.toggle());
  window.addEventListener('langchange', () => {
    applyPhotoPolicy(); renderStatus(); renderProjects(); renderCalendar();
    if (!$('#tabLeave').classList.contains('hidden')) loadLeave();
  });

  // --------------------------------------------------------------------- tabs
  $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('nav.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    ['Punch', 'Calendar', 'History', 'Leave', 'Me'].forEach((tab) =>
      $(`#tab${tab}`).classList.toggle('hidden', tab !== b.dataset.tab));
    if (b.dataset.tab === 'Calendar') loadCalendar();
    if (b.dataset.tab === 'History') loadHistory();
    if (b.dataset.tab === 'Leave') loadLeave();
  }));

  // ------------------------------------------------------------------ startup
  async function boot() {
    if (!store.token) return show('loginView');
    let me;
    try {
      me = await api('/auth/me');
    } catch { return show('loginView'); }

    store.user = me.user;
    state.tz = me.tz;
    state.rules = me.location_rules;

    if (me.user.must_change_password) return show('pwdView');
    show('mainView');

    $('#hdrName').textContent = me.user.full_name;
    $('#hdrRole').textContent = `${me.user.employee_code} · ${me.user.job_title || me.user.role}`;
    $('#hdrTz').textContent = state.tz.label;
    $('#adminLink').classList.toggle('hidden', !['admin', 'supervisor'].includes(me.user.role));
    $('#meBody').innerHTML = [
      ['Employee ID', me.user.employee_code],
      ['Name', me.user.full_name],
      ['Email', me.user.email],
      ['Phone', me.user.phone || '—'],
      ['Job title', me.user.job_title || '—'],
      ['Department', me.user.department || '—'],
      ['Role', me.user.role],
    ].map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

    const today = localDateStr();
    $('#hFrom').value = `${today.slice(0, 7)}-01`;
    $('#hTo').value = today;
    state.calMonth = today.slice(0, 7);

    tickClock();
    await refresh();
  }

  setInterval(() => { tickClock(); }, 1000);
  function tickClock() {
    if ($('#mainView').classList.contains('hidden')) return;
    const now = localNow();
    const clock = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
    $('#hdrClock').textContent = clock.slice(0, 5);
    $('#punchClock').textContent = clock;
    $('#punchDateLabel').textContent = now.toISOString().slice(0, 10);
    if (state.status?.open_record) {
      const mins = Math.round((Date.now() - new Date(state.status.open_record.check_in_at)) / 60000);
      $('#stateSub').textContent = `${t('elapsed')}: ${durationText(mins)}`;
    }
  }

  async function refresh() {
    try {
      state.status = await api('/me/status');
      state.tz = state.status.tz;
      state.rules = state.status.location_rules;
      applyPhotoPolicy();
      renderStatus();
      await loadProjects();
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  // ------------------------------------------------------------- status card
  function renderStatus() {
    const s = state.status;
    if (!s) return;
    const dot = $('#stateDot');
    const open = s.open_record;

    dot.className = 'dot ' + (open ? 'ok' : s.can_check_in ? 'warn' : 'bad');
    $('#stateText').textContent = open ? t('onSite') : s.can_check_in ? t('notCheckedIn') : t('shiftClosed');
    $('#stateSub').textContent = open
      ? `${t('checkedInAt')} ${open.check_in_local} · ${esc(open.project_name)}`
      : '';

    const box = $('#shiftBox');
    const bits = [];
    if (s.shift_window) {
      const w = s.shift_window;
      bits.push(`<b>${t('shiftLabel')}:</b> ${esc(w.shift_name)} ${w.start_local}–${w.end_local} (${w.work_date})`);
      if (!w.from_schedule) bits.push(`<div class="small">${t('noRoster')}</div>`);
    } else if (s.next_window) {
      bits.push(`${t('shiftClosed')}. <b>${esc(s.next_window.shift_name)}</b> → ${s.next_window.opens_at_local}`);
    } else if (s.today_schedule && s.today_schedule.status !== 'work') {
      bits.push(t('todayOff'));
    } else {
      bits.push(t('shiftClosed'));
    }
    if (open?.late_minutes > 0) bits.push(`<span class="pill warn">${t('late')} ${open.late_minutes} ${t('minutes')}</span>`);
    box.className = 'notice ' + (s.shift_window ? 'ok' : 'warn');
    box.innerHTML = bits.join(' ');

    updateButtons();
  }

  // ---------------------------------------------------------------- location
  $('#btnLocate').addEventListener('click', locate);

  async function locate() {
    const btn = $('#btnLocate');
    const err = $('#fixError');
    err.classList.add('hidden');
    busy(btn, true, t('locating'));
    try {
      state.fix = await getFix();
      $('#fixBox').classList.remove('hidden');
      renderFix();
      await loadProjects();          // re-sort sites by real distance
      btn.dataset.label = `<span data-i18n="refreshLocation">${t('refreshLocation')}</span>`;
    } catch (ex) {
      state.fix = null;
      $('#fixBox').classList.add('hidden');
      err.textContent = ex.message;
      err.classList.remove('hidden');
    } finally {
      busy(btn, false);
      updateButtons();
    }
  }

  function fixAgeSec() {
    if (!state.fix) return null;
    return Math.round((Date.now() - state.fix.received_at) / 1000 +
      Math.max(0, (state.fix.received_at - new Date(state.fix.captured_at).getTime()) / 1000));
  }

  function renderFix() {
    const f = state.fix;
    if (!f) return;
    const limit = state.rules.max_accuracy_m;
    $('#fixAcc').textContent = `±${Math.round(f.accuracy)} m`;
    $('#fixCoords').textContent = `${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}`;
    const age = fixAgeSec();
    $('#fixAge').textContent = `${age} s`;

    const gauge = $('#accGauge');
    const pct = Math.max(4, Math.min(100, (1 - Math.min(f.accuracy, limit * 2) / (limit * 2)) * 100));
    gauge.style.width = `${pct}%`;
    gauge.parentElement.className = 'gauge ' + (f.accuracy > limit ? 'bad' : f.accuracy > limit * 0.6 ? 'warn' : '');
  }
  setInterval(() => { if (state.fix) renderFix(); }, 5000);

  // ---------------------------------------------------------------- projects
  async function loadProjects() {
    const q = state.fix ? `?lat=${state.fix.lat}&lng=${state.fix.lng}` : '';
    try {
      const out = await api(`/me/projects${q}`);
      state.projects = out.projects;
      renderProjects();
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  function renderProjects() {
    const sel = $('#projectSel');
    const keep = state.status?.open_record?.project_id ?? (Number(sel.value) || null);
    sel.innerHTML = state.projects.map((p) => {
      const d = p.distance_m == null ? '' : ` — ${Math.round(p.distance_m)} ${t('metresFrom').replace('m from', 'm')}`;
      return `<option value="${p.id}">${esc(p.name)} (${esc(p.code)})${esc(d)}</option>`;
    }).join('') || `<option value="">—</option>`;
    if (keep && state.projects.some((p) => p.id === keep)) sel.value = String(keep);
    renderProjInfo();
  }

  $('#projectSel').addEventListener('change', () => { renderProjInfo(); updateButtons(); });

  function renderProjInfo() {
    const box = $('#projInfo');
    if (!state.projects.length) {
      box.innerHTML = `<div class="notice warn">${esc(t('noSites'))}</div>`;
      return;
    }
    const p = state.projects.find((x) => x.id === Number($('#projectSel').value));
    if (!p) { box.textContent = ''; return; }
    const lines = [`${esc(p.address || '')}`, `Geofence: ${p.radius_m} m`];
    if (p.distance_m != null) {
      const inside = p.distance_m <= p.radius_m + Math.min(state.fix?.accuracy ?? 0, state.rules.max_accuracy_m);
      lines.push(`<span class="pill ${inside ? 'ok' : 'bad'}">${Math.round(p.distance_m)} m — ${
        inside ? t('insideFence') : t('outsideFence')}</span>`);
    }
    box.innerHTML = lines.filter(Boolean).join('<br>');
  }

  function updateButtons() {
    const s = state.status;
    // The employee must have opened their GPS at least once (so they can see
    // their distance to the site) but staleness is not a gate here: punching
    // always takes a brand-new reading, so blocking on an old one would leave
    // the button dead after a rejection.
    const located = !!state.fix;
    const hasProject = !!Number($('#projectSel').value);
    const photoOk = state.rules.selfie_mode !== 'required' || !!state.photo;
    $('#btnIn').disabled = !(s?.can_check_in && located && hasProject && photoOk);
    $('#btnOut').disabled = !(s?.can_check_out && located && photoOk);
    const hint = !located ? t('locationNeeded') : !photoOk ? t('photoNeeded') : '';
    $('#btnIn').title = $('#btnOut').title = hint;
  }
  setInterval(updateButtons, 5000);

  // ------------------------------------------------------------------- punch
  $('#btnIn').addEventListener('click', () => punch('check-in', $('#btnIn')));
  $('#btnOut').addEventListener('click', () => punch('check-out', $('#btnOut')));

  async function punch(kind, btn) {
    const result = $('#punchResult');
    result.classList.add('hidden');

    // Always take a brand-new reading at the moment of the punch, so the time
    // and the position that get recorded belong to the same instant.
    busy(btn, true, t('locating'));
    try {
      state.fix = await getFix();
      renderFix();
    } catch (ex) {
      busy(btn, false);
      result.className = 'notice bad';
      result.textContent = ex.message;
      return result.classList.remove('hidden');
    }

    try {
      const out = await api(`/me/${kind}`, {
        method: 'POST',
        body: {
          project_id: Number($('#projectSel').value) || undefined,
          lat: state.fix.lat,
          lng: state.fix.lng,
          accuracy: state.fix.accuracy,
          captured_at: state.fix.captured_at,
          note: $('#noteBox').value.trim() || undefined,
          photo: state.photo || undefined,
        },
      });
      $('#noteBox').value = '';
      clearPhoto();
      result.className = 'notice ok';
      result.innerHTML = kind === 'check-in'
        ? `✅ <b>${t('checkedInAt')} ${out.check_in_local}</b><br>${esc(out.project.name)} · ${metres(out.distance_m)} · ±${out.accuracy_m} m`
          + (out.late_minutes ? `<br><span class="pill warn">${t('late')} ${out.late_minutes} ${t('minutes')}</span>` : '')
          + flagPills(out.flags)
        : `✅ <b>${t('checkedOutAt')} ${out.check_out_local}</b><br>${t('worked')}: ${durationText(out.worked_minutes)}`
          + (out.overtime_minutes ? `<br><span class="pill info">+${durationText(out.overtime_minutes)}</span>` : '')
          + flagPills(out.flags);
      result.classList.remove('hidden');
      toast(kind === 'check-in' ? t('checkedInAt') : t('checkedOutAt'), 'ok');
      await refresh();
    } catch (ex) {
      result.className = 'notice bad';
      result.innerHTML = `⚠️ ${esc(ex.message)}`;
      result.classList.remove('hidden');
    } finally {
      busy(btn, false);
      updateButtons();
    }
  }

  const FLAG_STYLE = {
    late: 'warn', overtime: 'info', early_out: 'warn', out_of_fence: 'bad',
    no_schedule: 'warn', holiday_work: 'info', site_differs_from_roster: 'warn',
    checked_out_at_other_site: 'warn', missing_checkout: 'bad', auto_closed: 'bad',
    manually_adjusted: 'info', clock_skew: 'warn', mock_location_suspected: 'bad',
  };
  const flagPills = (flags) => !flags?.length ? '' :
    '<div style="margin-top:.4rem">' + flags.map((f) =>
      `<span class="pill ${FLAG_STYLE[f] || ''}">${esc(f.replace(/_/g, ' '))}</span> `).join('') + '</div>';

  // ------------------------------------------------------------------- photo
  $('#btnPhoto').addEventListener('click', () => $('#photoInput').click());
  $('#btnPhotoClear').addEventListener('click', clearPhoto);
  $('#photoInput').addEventListener('change', onPhotoPicked);

  function applyPhotoPolicy() {
    const mode = state.rules.selfie_mode || 'off';
    $('#photoCard').classList.toggle('hidden', mode === 'off');
    if (mode === 'off') return;
    const required = mode === 'required';
    $('#photoPolicyPill').className = `pill ${required ? 'bad' : ''}`;
    $('#photoPolicyPill').textContent = required ? '!' : '';
    $('#photoHint').textContent = t(required ? 'photoHintRequired' : 'photoHintOptional');
  }

  /** Downscales the camera image so a 4 MB phone photo becomes a ~40 KB upload. */
  function shrinkToJpeg(file, maxEdge = 720, quality = 0.62) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(t('photoFailed')));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error(t('photoFailed')));
        img.onload = () => {
          const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const url = canvas.toDataURL('image/jpeg', quality);
          if (!url.startsWith('data:image/jpeg')) return reject(new Error(t('photoFailed')));
          resolve(url);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function onPhotoPicked(e) {
    const file = e.target.files?.[0];
    e.target.value = '';                       // so picking the same file twice still fires
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return toast(t('photoTooBig'), 'bad');
    busy($('#btnPhoto'), true);
    try {
      state.photo = await shrinkToJpeg(file);
      $('#photoImg').src = state.photo;
      $('#photoPreview').classList.remove('hidden');
      const kb = Math.round((state.photo.length * 3) / 4 / 1024);
      $('#photoSize').textContent = `${t('photoReady')} · ${kb} KB`;
      $('#btnPhoto').dataset.label = `<span data-i18n="retakePhoto">${t('retakePhoto')}</span>`;
    } catch (ex) {
      state.photo = null;
      toast(ex.message, 'bad');
    } finally {
      busy($('#btnPhoto'), false);
      updateButtons();
    }
  }

  function clearPhoto() {
    state.photo = null;
    $('#photoImg').removeAttribute('src');
    $('#photoPreview').classList.add('hidden');
    $('#btnPhoto').innerHTML = `<span data-i18n="takePhoto">${t('takePhoto')}</span>`;
    delete $('#btnPhoto').dataset.label;
    updateButtons();
  }

  // ---------------------------------------------------------------- calendar
  $('#calPrev').addEventListener('click', () => shiftMonth(-1));
  $('#calNext').addEventListener('click', () => shiftMonth(1));

  function shiftMonth(delta) {
    const [y, m] = state.calMonth.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    state.calMonth = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    loadCalendar();
  }

  async function loadCalendar() {
    const [y, m] = state.calMonth.split('-').map(Number);
    const from = `${state.calMonth}-01`;
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    try {
      const out = await api(`/me/calendar?from=${from}&to=${to}`);
      state.calDays = out.days;
      renderCalendar();
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  function renderCalendar() {
    if (!state.calDays.length) return;
    const grid = $('#calGrid');
    const [y, m] = state.calMonth.split('-').map(Number);
    $('#calTitle').textContent = new Date(Date.UTC(y, m - 1, 1))
      .toLocaleDateString(I18N.lang === 'ar' ? 'ar' : 'en', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    const dayNames = I18N.lang === 'ar'
      ? ['أحد', 'إثن', 'ثلا', 'أرب', 'خمي', 'جمع', 'سبت']
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const today = localDateStr();
    const firstWeekday = new Date(`${state.calMonth}-01T00:00:00Z`).getUTCDay();

    const cells = dayNames.map((n) => `<div class="hd">${n}</div>`);
    for (let i = 0; i < firstWeekday; i++) cells.push('<div class="day pad"></div>');

    for (const day of state.calDays) {
      const st = day.holiday ? 'holiday' : (day.schedule?.status || 'none');
      const cls = ['day', st === 'none' ? '' : st, day.date === today ? 'today' : ''].filter(Boolean).join(' ');
      const tags = [];
      if (day.schedule?.shift_code) tags.push(`<span class="tag">${esc(day.schedule.shift_code)}</span>`);
      if (day.holiday) tags.push(`<span class="tag miss">${esc(day.holiday.slice(0, 8))}</span>`);
      if (day.attendance) {
        const a = day.attendance;
        tags.push(`<span class="tag ${a.check_out_at ? 'done' : 'miss'}">${a.check_in_local}${
          a.check_out_at ? `–${a.check_out_local}` : '…'}</span>`);
      } else if (day.schedule?.status === 'work' && day.date < today) {
        tags.push('<span class="tag miss">✗</span>');
      }
      cells.push(`<div class="${cls}" data-date="${day.date}">
        <span class="d">${Number(day.date.slice(-2))}</span>${tags.join('')}</div>`);
    }
    grid.innerHTML = cells.join('');
    $$('.cal .day[data-date]', grid).forEach((el) =>
      el.addEventListener('click', () => showDay(el.dataset.date)));
  }

  function showDay(date) {
    const day = state.calDays.find((d) => d.date === date);
    if (!day) return;
    const rows = [['Date', date]];
    if (day.holiday) rows.push(['Public holiday', day.holiday]);
    if (day.schedule) {
      rows.push([t('status'), day.schedule.status]);
      if (day.schedule.shift_name) rows.push([t('shiftLabel'), `${day.schedule.shift_name} ${day.schedule.start_time}–${day.schedule.end_time}`]);
      if (day.schedule.project_name) rows.push([t('project'), day.schedule.project_name]);
      if (day.schedule.note) rows.push(['Note', day.schedule.note]);
    } else {
      rows.push([t('status'), '—']);
    }
    if (day.attendance) {
      const a = day.attendance;
      rows.push([t('in'), `${a.check_in_local} · ${metres(a.check_in_distance_m)}`]);
      rows.push([t('out'), a.check_out_local ? `${a.check_out_local} · ${metres(a.check_out_distance_m)}` : '—']);
      rows.push([t('worked'), durationText(a.worked_minutes)]);
      if (a.late_minutes) rows.push([t('late'), `${a.late_minutes} ${t('minutes')}`]);
      if (a.overtime_minutes) rows.push(['Overtime', `${a.overtime_minutes} ${t('minutes')}`]);
      if (a.flags.length) rows.push(['Flags', a.flags.join(', ')]);
    }
    $('#calDayBody').innerHTML = rows
      .map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    $('#calDayCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ----------------------------------------------------------------- history
  $('#hLoad').addEventListener('click', loadHistory);

  async function loadHistory() {
    try {
      const out = await api(`/me/attendance?from=${$('#hFrom').value}&to=${$('#hTo').value}`);
      $('#hTotals').innerHTML = [
        [t('totalDays'), out.totals.days],
        [t('totalWorked'), durationText(out.totals.worked_minutes)],
        [t('totalLate'), `${out.totals.late_minutes} ${t('minutes')}`],
        [t('totalOvertime'), durationText(out.totals.overtime_minutes)],
      ].map(([l, n]) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('');

      $('#hTable').innerHTML = `
        <thead><tr>
          <th>${t('date')}</th><th>${t('project')}</th><th>${t('in')}</th><th>${t('out')}</th>
          <th>${t('worked')}</th><th>${t('status')}</th>
        </tr></thead>
        <tbody>${out.records.map((r) => `<tr>
          <td class="mono">${esc(r.work_date)}</td>
          <td>${esc(r.project_name)}</td>
          <td class="mono">${esc(r.check_in_local)}</td>
          <td class="mono">${esc(r.check_out_local || '—')}</td>
          <td class="mono">${esc(HR.hm(r.worked_minutes))}</td>
          <td>${r.flags.map((f) => `<span class="pill ${FLAG_STYLE[f] || ''}">${esc(f.replace(/_/g, ' '))}</span>`).join(' ') || `<span class="pill ok">ok</span>`}</td>
        </tr>`).join('') || `<tr><td colspan="6" class="muted center">—</td></tr>`}</tbody>`;
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  // ------------------------------------------------------------------- leave
  const LEAVE_STATUS_STYLE = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: '' };

  $('#leaveForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#lvError');
    const btn = $('#leaveForm button[type=submit]');
    err.classList.add('hidden');
    busy(btn, true);
    try {
      await api('/me/leave', {
        method: 'POST',
        body: {
          leave_type: $('#lvType').value,
          from_date: $('#lvFrom').value,
          to_date: $('#lvTo').value,
          reason: $('#lvReason').value.trim() || undefined,
        },
      });
      $('#lvReason').value = '';
      toast(t('requestSent'), 'ok');
      await loadLeave();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    } finally { busy(btn, false); }
  });

  async function loadLeave() {
    try {
      const out = await api('/me/leave');
      const sel = $('#lvType');
      if (sel.options.length !== out.types.length) {
        sel.innerHTML = out.types.map((ty) => `<option value="${ty}">${esc(t(ty))}</option>`).join('');
      }
      if (!$('#lvFrom').value) {
        const tomorrow = new Date(Date.now() + 86400000 + state.tz.offset_min * 60000).toISOString().slice(0, 10);
        $('#lvFrom').value = tomorrow;
        $('#lvTo').value = tomorrow;
      }

      $('#lvList').innerHTML = out.requests.length ? out.requests.map((r) => `
        <div class="card" style="box-shadow:none;margin-bottom:.6rem">
          <div class="row" style="justify-content:space-between">
            <b>${esc(t(r.leave_type))}</b>
            <span class="pill ${LEAVE_STATUS_STYLE[r.status] ?? ''}">${esc(t(r.status))}</span>
          </div>
          <div class="small mono">${esc(r.from_date)} → ${esc(r.to_date)} · ${r.days} ${esc(t('days'))}</div>
          ${r.reason ? `<div class="small muted">${esc(r.reason)}</div>` : ''}
          ${r.decided_by_name ? `<div class="small muted">${esc(t('decidedBy'))}: ${esc(r.decided_by_name)}${
            r.decision_note ? ` — ${esc(r.decision_note)}` : ''}</div>` : ''}
          ${r.status === 'pending'
            ? `<button class="ghost slim" data-cancel-leave="${r.id}" style="margin-top:.5rem">${esc(t('withdraw'))}</button>`
            : ''}
        </div>`).join('') : `<p class="muted small">${esc(t('noRequests'))}</p>`;

      $$('[data-cancel-leave]').forEach((b) => b.onclick = async () => {
        if (!confirm(t('withdrawConfirm'))) return;
        try {
          await api(`/me/leave/${b.dataset.cancelLeave}/cancel`, { method: 'POST' });
          await loadLeave();
        } catch (ex) { toast(ex.message, 'bad'); }
      });
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  // ------------------------------------------------------------------- start
  I18N.apply();
  boot();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => { if (!document.hidden && store.token) refresh(); });
})();
