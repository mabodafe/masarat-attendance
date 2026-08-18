/* HR admin console: accounts, sites, shifts, working calendar, reports, audit. */
(function () {
  const { api, store, $, $$, esc, toast, busy, hm, durationText, metres, pad } = HR;

  const state = {
    me: null, tz: { offset_min: 0, label: '' },
    users: [], projects: [], shifts: [], holidays: [],
    canEdit: false,
  };

  const localNow = () => new Date(Date.now() + state.tz.offset_min * 60000);
  const today = () => localNow().toISOString().slice(0, 10);
  const monthStart = () => `${today().slice(0, 7)}-01`;
  const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const FLAG_STYLE = {
    late: 'warn', overtime: 'info', early_out: 'warn', out_of_fence: 'bad',
    no_schedule: 'warn', holiday_work: 'info', site_differs_from_roster: 'warn',
    checked_out_at_other_site: 'warn', missing_checkout: 'bad', auto_closed: 'bad',
    manually_adjusted: 'info', clock_skew: 'warn', mock_location_suspected: 'bad',
  };
  const pills = (flags) => (flags || []).map((f) =>
    `<span class="pill ${FLAG_STYLE[f] || ''}">${esc(f.replace(/_/g, ' '))}</span>`).join(' ');

  const table = (headers, rows) =>
    `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
     <tbody>${rows.join('') || `<tr><td colspan="${headers.length}" class="center muted">No records</td></tr>`}</tbody>`;

  // ------------------------------------------------------------------- modal
  function modal(title, bodyHtml, onSubmit, submitLabel = 'Save') {
    const host = $('#modalHost');
    // The body scrolls on its own (#modalScroll); the Save/Cancel row is
    // sticky to the bottom of the modal panel. This keeps the buttons on
    // screen even when: the form is taller than the viewport, or a mobile
    // on-screen keyboard has shrunk the visible area while a field is
    // focused — both cases where a plain scrolling backdrop previously let
    // the action row scroll out of view.
    host.innerHTML = `<div class="modal-back"><form class="modal">
      <div id="modalScroll">
        <h2>${esc(title)}</h2>
        <div id="modalBody">${bodyHtml}</div>
        <div id="modalErr" class="notice bad hidden" style="margin:.6rem 0"></div>
      </div>
      <div class="row modal-actions">
        <button type="submit" class="primary grow">${esc(submitLabel)}</button>
        <button type="button" class="ghost grow" id="modalCancel">Cancel</button>
      </div></form></div>`;
    const form = $('.modal', host);
    const close = () => { host.innerHTML = ''; };
    $('#modalCancel', host).onclick = close;
    $('.modal-back', host).onclick = (e) => { if (e.target === $('.modal-back', host)) close(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#modalErr', host);
      err.classList.add('hidden');
      const btn = $('button[type=submit]', form);
      busy(btn, true, 'Saving');
      try {
        const data = {};
        $$('[name]', form).forEach((el) => {
          data[el.name] = el.type === 'checkbox' ? el.checked
            : el.multiple ? [...el.selectedOptions].map((o) => o.value)
            : el.value;
        });
        await onSubmit(data);
        close();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      } finally { busy(btn, false); }
    };
    return { close };
  }

  const fieldRow = (fields) => `<div class="row">${fields.map((f) => `
    <div class="grow"><label>${esc(f.label)}</label>${
      f.type === 'select'
        ? `<select name="${f.name}" ${f.multiple ? 'multiple size="6"' : ''}>${f.options}</select>`
        : f.type === 'checkbox'
          ? `<input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}>`
          : `<input type="${f.type || 'text'}" name="${f.name}" value="${esc(f.value ?? '')}"
               ${f.step ? `step="${f.step}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`
    }${f.hint ? `<div class="small muted">${esc(f.hint)}</div>` : ''}</div>`).join('')}</div>`;

  // ------------------------------------------------------------------- start
  async function boot() {
    if (!store.token) return gate();
    let me;
    try { me = await api('/auth/me'); } catch { return gate(); }
    if (!['admin', 'supervisor'].includes(me.user.role)) return gate();

    state.me = me.user;
    state.tz = me.tz;
    state.canEdit = me.user.role === 'admin';
    $('#gate').classList.add('hidden');
    $('#console').classList.remove('hidden');
    $('#waName').textContent = `${me.user.full_name} · ${me.user.role}`;
    $('#waTz').textContent = me.tz.label;
    if (!state.canEdit) {
      $$('#empNew, #projNew, #shiftNew').forEach((b) => b && b.classList.add('hidden'));
    }
    tick(); setInterval(tick, 1000);

    // Default date ranges
    $('#repFrom').value = monthStart(); $('#repTo').value = today();
    $('#rosFrom').value = today(); $('#rosTo').value = addDays(today(), 13);
    $('#genFrom').value = today(); $('#genTo').value = addDays(today(), 29);
    $('#genRest').innerHTML = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .map((d, i) => `<label class="field inline small" style="margin:0">
        <input type="checkbox" class="restDay" value="${i}" ${i >= 5 ? 'checked' : ''}> ${d}</label>`).join('');

    await Promise.all([loadUsers(), loadProjects(), loadShifts()]);
    fillPickers();
    loadDash();
  }
  const gate = () => { $('#gate').classList.remove('hidden'); $('#console').classList.add('hidden'); };

  function tick() {
    const n = localNow();
    $('#waClock').textContent = `${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}:${pad(n.getUTCSeconds())}`;
  }

  $('#waLogout').onclick = () => { store.clear(); location.href = 'index.html'; };
  $('#langBtn').onclick = () => I18N.toggle();
  window.addEventListener('langchange', () => { I18N.apply(); });

  $$('#nav button').forEach((b) => b.onclick = () => {
    $$('#nav button').forEach((x) => x.classList.toggle('active', x === b));
    const pages = { dash: 'Dash', employees: 'Employees', projects: 'Projects', shifts: 'Shifts',
                    roster: 'Roster', reports: 'Reports', timesheet: 'Timesheet', leave: 'Leave',
                    holidays: 'Holidays', audit: 'Audit' };
    Object.entries(pages).forEach(([key, id]) =>
      $(`#page${id}`).classList.toggle('hidden', key !== b.dataset.page));
    ({ dash: loadDash, employees: renderUsers, projects: renderProjects, shifts: renderShifts,
       roster: loadRoster, reports: loadReport, timesheet: loadTimesheet, leave: loadLeaveQueue,
       holidays: loadHolidays, audit: loadAudit }[b.dataset.page])();
  });

  // --------------------------------------------------------------- reference
  async function loadUsers() { state.users = (await api('/admin/users')).users; }
  async function loadProjects() { state.projects = (await api('/admin/projects')).projects; }
  async function loadShifts() { state.shifts = (await api('/admin/shifts')).shifts; }

  const opts = (items, { value = 'id', label = 'name', selected = null, blank = null } = {}) =>
    (blank !== null ? `<option value="">${esc(blank)}</option>` : '') +
    items.map((i) => `<option value="${i[value]}" ${String(i[value]) === String(selected) ? 'selected' : ''}>${esc(i[label])}</option>`).join('');

  function fillPickers() {
    const employees = state.users.filter((u) => u.active);
    const userOpts = employees.map((u) => `<option value="${u.id}">${esc(u.full_name)} (${esc(u.employee_code)})</option>`).join('');
    $('#genUsers').innerHTML = userOpts;
    $('#repUser').innerHTML = `<option value="">All employees</option>${userOpts}`;
    $('#audUser').innerHTML = `<option value="">All employees</option>${userOpts}`;
    $('#tsUser').innerHTML = `<option value="">All employees</option>${userOpts}`;
    $('#alUser').innerHTML = userOpts;
    $('#alType').innerHTML = ['annual', 'sick', 'unpaid', 'emergency']
      .map((ty) => `<option value="${ty}">${ty[0].toUpperCase() + ty.slice(1)}</option>`).join('');
    const activeShifts = state.shifts.filter((s) => s.active);
    $('#genShift').innerHTML = opts(activeShifts, { label: 'name' });
    $('#genProject').innerHTML = opts(state.projects.filter((p) => p.active), { blank: 'No default site' });
    $('#repProject').innerHTML = opts(state.projects, { blank: 'All projects' });
  }

  // --------------------------------------------------------------- dashboard
  async function loadDash() {
    try {
      const d = await api('/admin/dashboard');
      const c = d.counts;
      $('#dashStats').innerHTML = [
        ['On site now', c.on_site_now], ['Scheduled today', c.scheduled_today],
        ['No punch yet', c.absent_today], ['Late today', c.late_today],
        ['Hours today', hm(c.worked_minutes_today)], ['Overtime today', hm(c.overtime_minutes_today)],
        ['Leave to approve', c.pending_leave], ['Active employees', c.employees], ['Active sites', c.projects],
      ].map(([l, n]) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('');

      const badge = $('#leaveBadge');
      badge.textContent = c.pending_leave;
      badge.classList.toggle('hidden', !c.pending_leave);

      $('#pendingLeaveCard').classList.toggle('hidden', !d.pending_leave.length);
      $('#pendingLeaveTable').innerHTML = table(
        ['Employee', 'Type', 'From', 'To', 'Days', 'Requested', ''],
        d.pending_leave.map((r) => `<tr>
          <td>${esc(r.full_name)}<div class="small muted mono">${esc(r.employee_code)}</div></td>
          <td>${esc(r.leave_type)}</td>
          <td class="mono">${esc(r.from_date)}</td>
          <td class="mono">${esc(r.to_date)}</td>
          <td class="mono">${r.days}</td>
          <td class="small mono">${esc(r.created_at)}</td>
          <td class="row tight">
            <button class="ok slim" data-dash-approve="${r.id}">Approve</button>
            <button class="bad slim" data-dash-reject="${r.id}">Reject</button></td>
        </tr>`));
      $$('[data-dash-approve]').forEach((b) => b.onclick = () => decide(b.dataset.dashApprove, true));
      $$('[data-dash-reject]').forEach((b) => b.onclick = () => decide(b.dataset.dashReject, false));

      $('#onSiteTable').innerHTML = table(
        ['Employee', 'ID', 'Project', 'Shift', 'Checked in', 'On site for', 'Distance', 'Late'],
        d.on_site.map((r) => `<tr>
          <td>${esc(r.full_name)}</td><td class="mono">${esc(r.employee_code)}</td>
          <td>${esc(r.project_name)}</td><td>${esc(r.shift_name || '—')}</td>
          <td class="mono">${esc(r.check_in_local)}</td>
          <td class="mono">${esc(hm(r.elapsed_minutes))}</td>
          <td class="mono">${esc(metres(r.check_in_distance_m))}</td>
          <td>${r.late_minutes ? `<span class="pill warn">${r.late_minutes} min</span>` : ''}</td></tr>`));

      $('#absentTable').innerHTML = table(
        ['Employee', 'ID', 'Shift', 'Starts', 'Site'],
        d.absent.map((r) => `<tr>
          <td>${esc(r.full_name)}</td><td class="mono">${esc(r.employee_code)}</td>
          <td>${esc(r.shift_name || '—')}</td><td class="mono">${esc(r.start_time || '—')}</td>
          <td>${esc(r.project_name || '—')}</td></tr>`));

      $('#flaggedTable').innerHTML = table(
        ['Date', 'Employee', 'Project', 'Status', 'Flags'],
        d.flagged.map((r) => `<tr>
          <td class="mono">${esc(r.work_date)}</td><td>${esc(r.full_name)}</td>
          <td>${esc(r.project_name)}</td><td>${esc(r.status)}</td>
          <td>${pills(r.flags)}</td></tr>`));
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  // --------------------------------------------------------------- employees
  $('#empSearch').oninput = () => renderUsers();
  $('#empNew').onclick = () => employeeModal(null);

  function renderUsers() {
    const q = $('#empSearch').value.trim().toLowerCase();
    const rows = state.users.filter((u) => !q ||
      [u.full_name, u.employee_code, u.email].join(' ').toLowerCase().includes(q));
    $('#empTable').innerHTML = table(
      ['Employee ID', 'Name', 'Email', 'Job title', 'Department', 'Direct manager', 'Role', 'Sites', 'Status', ''],
      rows.map((u) => `<tr>
        <td class="mono">${esc(u.employee_code)}</td>
        <td>${esc(u.full_name)}</td>
        <td class="small">${esc(u.email)}</td>
        <td>${esc(u.job_title || '—')}</td>
        <td>${esc(u.department || '—')}</td>
        <td>${esc(u.manager_name || '—')}${u.reports_count
          ? `<div class="small muted">${u.reports_count} report${u.reports_count > 1 ? 's' : ''}</div>` : ''}</td>
        <td><span class="pill ${u.role === 'admin' ? 'info' : ''}">${esc(u.role)}</span></td>
        <td class="mono">${u.project_count || 'all'}</td>
        <td>${u.active ? '<span class="pill ok">active</span>' : '<span class="pill bad">inactive</span>'}
            ${u.must_change_password ? '<span class="pill warn">new password</span>' : ''}
            ${u.flexible_punch ? '<span class="pill info">flexible</span>' : ''}
            ${u.photo_policy ? `<span class="pill">photo: ${esc(u.photo_policy)}</span>` : ''}</td>
        <td>${state.canEdit ? `<button class="ghost slim" data-edit-user="${u.id}">Edit</button>` : ''}</td>
      </tr>`));
    $$('[data-edit-user]').forEach((b) => b.onclick = () =>
      employeeModal(state.users.find((u) => u.id === Number(b.dataset.editUser))));
  }

  async function employeeModal(user) {
    const assigned = user ? (await api(`/admin/users/${user.id}/projects`)).project_ids : [];
    const projectOptions = state.projects.filter((p) => p.active).map((p) =>
      `<option value="${p.id}" ${assigned.includes(p.id) ? 'selected' : ''}>${esc(p.name)} (${esc(p.code)})</option>`).join('');

    const body = [
      fieldRow([
        { label: 'Employee ID', name: 'employee_code', value: user?.employee_code, placeholder: 'EMP-001' },
        { label: 'Full name', name: 'full_name', value: user?.full_name },
      ]),
      fieldRow([
        { label: 'Email (used to sign in)', name: 'email', type: 'email', value: user?.email },
        { label: 'Phone', name: 'phone', value: user?.phone },
      ]),
      fieldRow([
        { label: 'Job title', name: 'job_title', value: user?.job_title },
        { label: 'Department', name: 'department', value: user?.department },
        { label: 'Role', name: 'role', type: 'select',
          options: opts([{ id: 'employee', name: 'Employee' }, { id: 'supervisor', name: 'Supervisor (read-only admin)' }, { id: 'admin', name: 'Administrator' }],
            { selected: user?.role || 'employee' }) },
      ]),
      fieldRow([
        { label: 'Direct manager', name: 'manager_id', type: 'select',
          options: opts(state.users.filter((u) => u.active && u.id !== user?.id),
            { label: 'full_name', selected: user?.manager_id, blank: 'No direct manager' }) },
      ]),
      fieldRow([
        { label: user ? 'Reset password (leave blank to keep)' : 'Temporary password', name: 'password',
          type: 'text', hint: 'At least 8 characters. The employee must change it at first sign-in.' },
      ]),
      fieldRow([
        { label: 'Sites this employee may punch into (none selected = all sites)', name: 'project_ids',
          type: 'select', multiple: true, options: projectOptions },
      ]),
      fieldRow([
        { label: 'Photo before check-in/out', name: 'photo_policy', type: 'select',
          options: opts(
            [{ id: '', name: 'Use app default' }, { id: 'off', name: 'Off' },
             { id: 'optional', name: 'Optional' }, { id: 'required', name: 'Required' }],
            { selected: user?.photo_policy || '' }) },
        { label: 'Flexible punching', name: 'flexible_punch', type: 'checkbox', value: user?.flexible_punch,
          hint: "Lets this employee check in/out at any time, instead of only inside their shift's time window." },
      ]),
      user ? fieldRow([{ label: 'Account active', name: 'active', type: 'checkbox', value: user.active }]) : '',
    ].join('');

    modal(user ? `Edit ${user.full_name}` : 'New employee account', body, async (data) => {
      const payload = {
        employee_code: data.employee_code, full_name: data.full_name, email: data.email,
        phone: data.phone || null, job_title: data.job_title || null, department: data.department || null,
        role: data.role, manager_id: Number(data.manager_id) || null,
        project_ids: data.project_ids.map(Number),
        photo_policy: data.photo_policy || '', flexible_punch: !!data.flexible_punch,
      };
      if (data.password) payload.password = data.password;
      if (user) {
        payload.active = data.active;
        delete payload.employee_code;
        await api(`/admin/users/${user.id}`, { method: 'PATCH', body: payload });
        toast('Employee updated.', 'ok');
      } else {
        if (!data.password) throw new HR.ApiError('Set a temporary password.', 400);
        await api('/admin/users', { method: 'POST', body: payload });
        toast('Account created. Give the employee their ID and temporary password.', 'ok');
      }
      await loadUsers(); fillPickers(); renderUsers();
    }, user ? 'Save changes' : 'Create account');
  }

  // ---------------------------------------------------------------- projects
  $('#projNew').onclick = () => projectModal(null);

  function renderProjects() {
    $('#projTable').innerHTML = table(
      ['Code', 'Project / site', 'Client', 'Latitude', 'Longitude', 'Geofence', 'Assigned', 'Status', ''],
      state.projects.map((p) => `<tr>
        <td class="mono">${esc(p.code)}</td>
        <td>${esc(p.name)}<div class="small muted">${esc(p.address || '')}</div></td>
        <td>${esc(p.client || '—')}</td>
        <td class="mono">${p.lat.toFixed(5)}</td>
        <td class="mono">${p.lng.toFixed(5)}</td>
        <td class="mono">${p.radius_m} m</td>
        <td class="mono">${p.member_count || 'all'}</td>
        <td>${p.active ? '<span class="pill ok">active</span>' : '<span class="pill bad">closed</span>'}</td>
        <td class="row tight">
          <a href="https://www.google.com/maps?q=${p.lat},${p.lng}" target="_blank" rel="noopener">
            <button class="ghost slim">Map</button></a>
          ${state.canEdit ? `<button class="ghost slim" data-edit-proj="${p.id}">Edit</button>` : ''}
        </td></tr>`));
    $$('[data-edit-proj]').forEach((b) => b.onclick = () =>
      projectModal(state.projects.find((p) => p.id === Number(b.dataset.editProj))));
  }

  function projectModal(p) {
    const body = [
      fieldRow([
        { label: 'Project code', name: 'code', value: p?.code, placeholder: 'SITE-002' },
        { label: 'Project / site name', name: 'name', value: p?.name },
      ]),
      fieldRow([
        { label: 'Client', name: 'client', value: p?.client },
        { label: 'Address', name: 'address', value: p?.address },
      ]),
      fieldRow([
        { label: 'Latitude', name: 'lat', type: 'number', step: 'any', value: p?.lat,
          hint: 'Open the site in Google Maps, long-press the gate, copy the two numbers.' },
        { label: 'Longitude', name: 'lng', type: 'number', step: 'any', value: p?.lng },
        { label: 'Geofence radius (m)', name: 'radius_m', type: 'number', value: p?.radius_m ?? 150,
          hint: 'How far from the centre a punch is accepted. 100–300 m suits most sites.' },
      ]),
      `<div class="row"><button type="button" class="ghost slim" id="useMyPos">Use my current position</button></div>`,
      p ? fieldRow([{ label: 'Site active', name: 'active', type: 'checkbox', value: p.active }]) : '',
    ].join('');

    modal(p ? `Edit ${p.name}` : 'New project / site', body, async (data) => {
      const payload = {
        code: data.code, name: data.name, client: data.client || null, address: data.address || null,
        lat: Number(data.lat), lng: Number(data.lng), radius_m: Number(data.radius_m),
      };
      if (p) {
        payload.active = data.active;
        await api(`/admin/projects/${p.id}`, { method: 'PATCH', body: payload });
      } else {
        await api('/admin/projects', { method: 'POST', body: payload });
      }
      toast('Site saved.', 'ok');
      await loadProjects(); fillPickers(); renderProjects();
    }, p ? 'Save changes' : 'Create site');

    $('#useMyPos').onclick = async (e) => {
      busy(e.target, true, 'Locating');
      try {
        const fix = await HR.getFix();
        $('[name=lat]').value = fix.lat.toFixed(6);
        $('[name=lng]').value = fix.lng.toFixed(6);
        toast(`Captured ±${Math.round(fix.accuracy)} m`, 'ok');
      } catch (ex) { toast(ex.message, 'bad'); } finally { busy(e.target, false); }
    };
  }

  // ------------------------------------------------------------------ shifts
  $('#shiftNew').onclick = () => shiftModal(null);

  function renderShifts() {
    $('#shiftTable').innerHTML = table(
      ['Code', 'Shift', 'Start', 'End', 'Crosses midnight', 'Late after', 'Early check-in', 'Break', 'Status', ''],
      state.shifts.map((s) => `<tr>
        <td class="mono">${esc(s.code)}</td><td>${esc(s.name)}</td>
        <td class="mono">${esc(s.start_time)}</td><td class="mono">${esc(s.end_time)}</td>
        <td>${s.crosses_midnight ? 'yes' : 'no'}</td>
        <td class="mono">+${s.grace_in_min} min</td>
        <td class="mono">−${s.early_in_min} min</td>
        <td class="mono">${s.break_min} min</td>
        <td>${s.active ? '<span class="pill ok">active</span>' : '<span class="pill bad">off</span>'}</td>
        <td>${state.canEdit ? `<button class="ghost slim" data-edit-shift="${s.id}">Edit</button>` : ''}</td>
      </tr>`));
    $$('[data-edit-shift]').forEach((b) => b.onclick = () =>
      shiftModal(state.shifts.find((s) => s.id === Number(b.dataset.editShift))));
  }

  function shiftModal(s) {
    const body = [
      fieldRow([
        { label: 'Shift code', name: 'code', value: s?.code, placeholder: 'MORNING' },
        { label: 'Shift name', name: 'name', value: s?.name, placeholder: 'Morning shift' },
      ]),
      fieldRow([
        { label: 'Start time', name: 'start_time', type: 'time', value: s?.start_time || '06:00' },
        { label: 'End time', name: 'end_time', type: 'time', value: s?.end_time || '15:00',
          hint: 'An end earlier than the start is treated as a night shift crossing midnight.' },
      ]),
      fieldRow([
        { label: 'Grace after start (min)', name: 'grace_in_min', type: 'number', value: s?.grace_in_min ?? 15,
          hint: 'Arriving within this window is still on time.' },
        { label: 'Grace before end (min)', name: 'grace_out_min', type: 'number', value: s?.grace_out_min ?? 10 },
      ]),
      fieldRow([
        { label: 'Check-in opens early (min)', name: 'early_in_min', type: 'number', value: s?.early_in_min ?? 60 },
        { label: 'Unpaid break (min)', name: 'break_min', type: 'number', value: s?.break_min ?? 30 },
      ]),
      s ? fieldRow([{ label: 'Shift active', name: 'active', type: 'checkbox', value: s.active }]) : '',
    ].join('');

    modal(s ? `Edit ${s.name}` : 'New shift', body, async (data) => {
      const payload = {
        code: data.code, name: data.name, start_time: data.start_time, end_time: data.end_time,
        grace_in_min: Number(data.grace_in_min), grace_out_min: Number(data.grace_out_min),
        early_in_min: Number(data.early_in_min), break_min: Number(data.break_min),
      };
      if (s) { payload.active = data.active; await api(`/admin/shifts/${s.id}`, { method: 'PATCH', body: payload }); }
      else await api('/admin/shifts', { method: 'POST', body: payload });
      toast('Shift saved.', 'ok');
      await loadShifts(); fillPickers(); renderShifts();
    }, s ? 'Save changes' : 'Create shift');
  }

  // ------------------------------------------------------------------ roster
  $('#rosLoad').onclick = loadRoster;
  $('#genRun').onclick = generateRoster;

  async function generateRoster() {
    const userIds = [...$('#genUsers').selectedOptions].map((o) => Number(o.value));
    if (!userIds.length) return toast('Select at least one employee.', 'bad');
    const btn = $('#genRun');
    busy(btn, true, 'Generating');
    try {
      const out = await api('/admin/schedules/generate', {
        method: 'POST',
        body: {
          user_ids: userIds, from: $('#genFrom').value, to: $('#genTo').value,
          shift_id: Number($('#genShift').value),
          project_id: Number($('#genProject').value) || null,
          rest_weekdays: $$('.restDay:checked').map((c) => Number(c.value)),
          skip_holidays: $('#genSkipHoliday').checked,
          overwrite: $('#genOverwrite').checked,
        },
      });
      toast(`${out.written} day(s) written, ${out.skipped} left untouched.`, 'ok');
      $('#rosFrom').value = $('#genFrom').value;
      $('#rosTo').value = $('#genTo').value < addDays($('#genFrom').value, 30)
        ? $('#genTo').value : addDays($('#genFrom').value, 13);
      loadRoster();
    } catch (ex) { toast(ex.message, 'bad'); } finally { busy(btn, false); }
  }

  async function loadRoster() {
    try {
      const r = await api(`/admin/roster?from=${$('#rosFrom').value}&to=${$('#rosTo').value}`);
      const holidaySet = new Set(r.holidays.map((h) => h.holiday_date));
      const head = ['Employee', ...r.dates.map((d) => {
        const wd = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][new Date(`${d}T00:00:00Z`).getUTCDay()];
        return `<span class="small">${wd}<br>${d.slice(5)}</span>${holidaySet.has(d) ? '<br><span class="pill bad">H</span>' : ''}`;
      })];
      const rows = r.users.map((u) => {
        const cells = r.dates.map((d) => {
          const c = r.cells[u.id]?.[d];
          const label = !c ? '·'
            : c.status === 'work' ? esc(c.shift_code || 'W')
            : c.status === 'off' ? 'OFF' : c.status === 'leave' ? 'LV' : 'HOL';
          const cls = !c ? '' : c.status === 'work' ? 'info' : c.status === 'leave' ? 'warn' : c.status === 'holiday' ? 'bad' : '';
          return `<td><button class="ghost slim" data-cell="${u.id}|${d}" title="${esc(c?.project_name || '')}">
            <span class="pill ${cls}">${label}</span></button></td>`;
        });
        return `<tr><td>${esc(u.full_name)}<div class="small muted mono">${esc(u.employee_code)}</div></td>${cells.join('')}</tr>`;
      });
      $('#rosTable').innerHTML = table(head, rows);
      $$('[data-cell]').forEach((b) => b.onclick = () => {
        const [uid, date] = b.dataset.cell.split('|');
        dayModal(Number(uid), date, r.cells[uid]?.[date]);
      });
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  function dayModal(userId, date, cell) {
    const user = state.users.find((u) => u.id === userId);
    const body = [
      `<p class="muted small">${esc(user?.full_name || '')} · ${esc(date)}</p>`,
      fieldRow([
        { label: 'Day type', name: 'status', type: 'select',
          options: opts([{ id: 'work', name: 'Working day' }, { id: 'off', name: 'Rest day' },
                         { id: 'leave', name: 'Leave' }, { id: 'holiday', name: 'Public holiday' }],
            { selected: cell?.status || 'work' }) },
        { label: 'Shift', name: 'shift_id', type: 'select',
          options: opts(state.shifts.filter((s) => s.active), { selected: cell?.shift_id, blank: '—' }) },
        { label: 'Site', name: 'project_id', type: 'select',
          options: opts(state.projects.filter((p) => p.active), { selected: cell?.project_id, blank: 'Employee chooses' }) },
      ]),
      fieldRow([{ label: 'Note', name: 'note', value: cell?.note }]),
      cell ? `<div class="row" style="margin-top:.5rem"><button type="button" class="bad slim" id="clearDay">Clear this day</button></div>` : '',
    ].join('');

    const m = modal('Working calendar day', body, async (data) => {
      await api('/admin/schedules', {
        method: 'POST',
        body: {
          user_id: userId, work_date: date, status: data.status,
          shift_id: Number(data.shift_id) || null,
          project_id: Number(data.project_id) || null,
          note: data.note || null,
        },
      });
      toast('Calendar updated.', 'ok');
      loadRoster();
    });

    const clear = $('#clearDay');
    if (clear) clear.onclick = async () => {
      await api(`/admin/schedules?user_id=${userId}&work_date=${date}`, { method: 'DELETE' });
      m.close(); toast('Day cleared.', 'ok'); loadRoster();
    };
  }

  // ----------------------------------------------------------------- reports
  $('#repLoad').onclick = loadReport;
  $('#repCsv').onclick = () => downloadCsv();

  function reportQuery() {
    const p = new URLSearchParams({ from: $('#repFrom').value, to: $('#repTo').value });
    if ($('#repUser').value) p.set('user_id', $('#repUser').value);
    if ($('#repProject').value) p.set('project_id', $('#repProject').value);
    const f = $('#repFilter').value;
    if (f === 'flagged') p.set('flagged', 'true');
    if (f === 'late') p.set('late', 'true');
    if (f === 'open') p.set('status', 'open');
    return p.toString();
  }

  async function loadReport() {
    try {
      const out = await api(`/admin/attendance?${reportQuery()}`);
      $('#repTotals').innerHTML = [
        ['Records', out.totals.records], ['Total hours', hm(out.totals.worked_minutes)],
        ['Late minutes', out.totals.late_minutes], ['Overtime', hm(out.totals.overtime_minutes)],
        ['Needs review', out.totals.flagged],
      ].map(([l, n]) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('');

      // A day with more than one check-in/out pair (the employee checked
      // out and came back) still shows as ONE row with the day's total —
      // the individual sessions are a small expandable detail underneath,
      // not extra top-level rows.
      $('#repTable').innerHTML = table(
        ['', 'Date', 'Employee', 'Shift', 'Project', 'In', 'Out', 'Worked', 'Late', 'OT', 'In dist.', 'Acc.', 'Photo', 'Flags', ''],
        out.records.flatMap((r) => {
          const sessions = Array.isArray(r.sessions) ? r.sessions : [];
          const multi = sessions.length > 1;
          const mainRow = `<tr>
          <td>${multi ? `<button class="ghost slim" data-toggle-sessions="${r.id}" title="Show individual sessions">▾ ${sessions.length}</button>` : ''}</td>
          <td class="mono">${esc(r.work_date)}</td>
          <td>${esc(r.full_name)}<div class="small muted mono">${esc(r.employee_code)}</div></td>
          <td>${esc(r.shift_name || '—')}</td>
          <td>${esc(r.project_name)}</td>
          <td class="mono">${esc(r.check_in_local)}</td>
          <td class="mono">${esc(r.check_out_local || '—')}</td>
          <td class="mono">${esc(hm(r.worked_minutes))}</td>
          <td class="mono">${r.late_minutes || ''}</td>
          <td class="mono">${r.overtime_minutes || ''}</td>
          <td class="mono">${esc(metres(r.check_in_distance_m))}</td>
          <td class="mono">±${Math.round(r.check_in_accuracy || 0)}</td>
          <td class="row tight">
            ${r.has_in_photo ? `<button class="ghost slim" data-photo="${r.id}|in">In</button>` : ''}
            ${r.has_out_photo ? `<button class="ghost slim" data-photo="${r.id}|out">Out</button>` : ''}
            ${!r.has_in_photo && !r.has_out_photo ? '<span class="muted">—</span>' : ''}
          </td>
          <td>${pills(r.flags)}</td>
          <td>${state.canEdit ? `<button class="ghost slim" data-fix="${r.id}">Correct</button>` : ''}</td>
        </tr>`;
          const detailRow = multi ? `<tr class="hidden" data-sessions-row="${r.id}">
          <td></td>
          <td colspan="13">
            <div class="tablewrap"><table><thead><tr>
              <th>#</th><th>In</th><th>Out</th><th>Worked</th>
            </tr></thead><tbody>${sessions.map((s) => `<tr>
              <td>${esc(s.seq)}</td>
              <td class="mono">${esc(s.check_in_local)}</td>
              <td class="mono">${esc(s.check_out_local || '—')}</td>
              <td class="mono">${esc(hm(s.worked_minutes))}</td>
            </tr>`).join('')}</tbody></table></div>
          </td>
        </tr>` : '';
          return [mainRow, detailRow].filter(Boolean);
        }));
      $$('[data-fix]').forEach((b) => b.onclick = () =>
        correctionModal(out.records.find((r) => r.id === Number(b.dataset.fix))));
      $$('[data-photo]').forEach((b) => b.onclick = () => {
        const [id, kind] = b.dataset.photo.split('|');
        showPhoto(id, kind, out.records.find((r) => r.id === Number(id)));
      });
      $$('[data-toggle-sessions]').forEach((b) => b.onclick = () => {
        const row = $(`[data-sessions-row="${b.dataset.toggleSessions}"]`);
        if (row) row.classList.toggle('hidden');
      });
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  function correctionModal(rec) {
    const body = [
      `<p class="muted small">${esc(rec.full_name)} · ${esc(rec.work_date)} · ${esc(rec.project_name)}</p>`,
      fieldRow([
        { label: 'Check-in time (HH:MM)', name: 'check_in_local', type: 'time', value: rec.check_in_local },
        { label: 'Check-out time (HH:MM)', name: 'check_out_local', type: 'time', value: rec.check_out_local || '' },
      ]),
      fieldRow([
        { label: 'Project', name: 'project_id', type: 'select',
          options: opts(state.projects, { selected: state.projects.find((p) => p.name === rec.project_name)?.id }) },
      ]),
      fieldRow([{ label: 'Reason for the correction', name: 'admin_note', value: '' }]),
      `<p class="small muted">Corrected records are permanently marked “manually adjusted”. The original GPS
       readings and the punch audit trail are never overwritten.</p>`,
    ].join('');

    modal('Correct attendance record', body, async (data) => {
      await api(`/admin/attendance/${rec.id}`, {
        method: 'PATCH',
        body: {
          check_in_local: data.check_in_local || undefined,
          check_out_local: data.check_out_local || null,
          project_id: Number(data.project_id),
          admin_note: data.admin_note || undefined,
        },
      });
      toast('Record corrected.', 'ok');
      loadReport();
    }, 'Save correction');
  }

  const downloadCsv = () => downloadFile(`/admin/attendance.csv?${reportQuery()}`,
    `attendance_${$('#repFrom').value}_to_${$('#repTo').value}.csv`);

  /** The punch photo needs the auth header, so it is fetched then shown as a blob. */
  async function showPhoto(id, kind, rec) {
    const host = $('#modalHost');
    host.innerHTML = `<div class="modal-back"><div class="modal">
      <h2>Photo at check-${esc(kind)}</h2>
      <p class="muted small">${esc(rec?.full_name || '')} · ${esc(rec?.work_date || '')} ·
         ${esc(kind === 'out' ? rec?.check_out_local || '' : rec?.check_in_local || '')} ·
         ${esc(rec?.project_name || '')}</p>
      <div id="photoHost" class="center muted small">Loading…</div>
      <button class="ghost" id="photoClose" style="margin-top:.8rem">Close</button>
    </div></div>`;
    const close = () => { host.innerHTML = ''; };
    $('#photoClose', host).onclick = close;
    $('.modal-back', host).onclick = (e) => { if (e.target === $('.modal-back', host)) close(); };
    try {
      const res = await api(`/admin/attendance/${id}/photo/${kind}`, { raw: true });
      if (!res.ok) throw new HR.ApiError('No photo stored for this punch.', res.status);
      const url = URL.createObjectURL(await res.blob());
      $('#photoHost', host).innerHTML =
        `<img src="${url}" alt="" style="width:100%;border-radius:12px;border:1px solid var(--line)">`;
    } catch (ex) {
      $('#photoHost', host).textContent = ex.message;
    }
  }

  // --------------------------------------------------------------- timesheet
  $('#tsLoad').onclick = loadTimesheet;
  $('#tsCsv').onclick = () => downloadFile(`/admin/timesheet.csv?${timesheetQuery()}`,
    `timesheet_${$('#tsFrom').value}_to_${$('#tsTo').value}.csv`);
  $('#tsThisMonth').onclick = () => { setTsMonth(0); loadTimesheet(); };
  $('#tsLastMonth').onclick = () => { setTsMonth(-1); loadTimesheet(); };

  function setTsMonth(delta) {
    const n = localNow();
    const first = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + delta, 1));
    const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + delta + 1, 0));
    $('#tsFrom').value = first.toISOString().slice(0, 10);
    $('#tsTo').value = last.toISOString().slice(0, 10);
  }

  function timesheetQuery() {
    const p = new URLSearchParams({ from: $('#tsFrom').value, to: $('#tsTo').value });
    if ($('#tsUser').value) p.set('user_id', $('#tsUser').value);
    if ($('#tsInactive').checked) p.set('include_inactive', 'true');
    return p.toString();
  }

  async function loadTimesheet() {
    if (!$('#tsFrom').value) setTsMonth(0);
    try {
      const out = await api(`/admin/timesheet?${timesheetQuery()}`);
      const tt = out.totals;
      $('#tsTotals').innerHTML = [
        ['Employees', tt.employees], ['Paid hours', tt.paid_hours],
        ['Scheduled days', tt.scheduled_days], ['Worked days', tt.worked_days],
        ['Absences', tt.absent_days], ['Leave days', tt.leave_days],
        ['Late arrivals', tt.late_count], ['Overtime', hm(tt.overtime_minutes)],
        ['Missing check-outs', tt.missing_checkout],
      ].map(([l, n]) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('');

      $('#tsTable').innerHTML = table(
        ['Employee', 'Job title', 'Sched.', 'Worked', 'Absent', 'Leave', 'Rest', 'Attend. %',
         'Paid hours', 'Late', 'Late min', 'Overtime', 'No check-out', 'Review'],
        out.rows.map((r) => {
          const rate = r.attendance_rate;
          const rateCls = rate == null ? '' : rate >= 95 ? 'ok' : rate >= 80 ? 'warn' : 'bad';
          return `<tr>
            <td>${esc(r.full_name)}<div class="small muted mono">${esc(r.employee_code)}</div></td>
            <td class="small">${esc(r.job_title || '—')}</td>
            <td class="mono">${r.scheduled_days}</td>
            <td class="mono">${r.worked_days}</td>
            <td class="mono">${r.absent_days ? `<span class="pill bad">${r.absent_days}</span>` : '0'}</td>
            <td class="mono">${r.leave_days || ''}</td>
            <td class="mono">${r.off_days || ''}</td>
            <td>${rate == null ? '—' : `<span class="pill ${rateCls}">${rate}%</span>`}</td>
            <td class="mono"><b>${r.paid_hours}</b></td>
            <td class="mono">${r.late_count || ''}</td>
            <td class="mono">${r.late_minutes || ''}</td>
            <td class="mono">${r.overtime_minutes ? hm(r.overtime_minutes) : ''}</td>
            <td class="mono">${r.missing_checkout ? `<span class="pill warn">${r.missing_checkout}</span>` : ''}</td>
            <td class="mono">${r.flagged_days || ''}</td>
          </tr>`;
        }));

      $('#tsProjTable').innerHTML = table(
        ['Code', 'Project', 'Client', 'Employees', 'Records', 'Paid hours', 'Overtime'],
        out.by_project.map((p) => `<tr>
          <td class="mono">${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.client || '—')}</td>
          <td class="mono">${p.employees}</td><td class="mono">${p.records}</td>
          <td class="mono"><b>${p.paid_hours}</b></td>
          <td class="mono">${p.overtime_minutes ? hm(p.overtime_minutes) : ''}</td></tr>`));
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  // ------------------------------------------------------------------- leave
  const LEAVE_STYLE = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: '' };

  $('#lqLoad').onclick = loadLeaveQueue;
  $('#lqFilter').onchange = loadLeaveQueue;

  $('#alAdd').onclick = async (e) => {
    busy(e.target, true, 'Saving');
    try {
      await api('/admin/leave', {
        method: 'POST',
        body: {
          user_id: Number($('#alUser').value),
          leave_type: $('#alType').value,
          from_date: $('#alFrom').value,
          to_date: $('#alTo').value,
          reason: $('#alReason').value.trim() || undefined,
        },
      });
      $('#alReason').value = '';
      toast('Leave added and written onto the calendar.', 'ok');
      loadLeaveQueue();
    } catch (ex) { toast(ex.message, 'bad'); } finally { busy(e.target, false); }
  };

  async function loadLeaveQueue() {
    if (!$('#alFrom').value) {
      const tomorrow = new Date(localNow().getTime() + 86400000).toISOString().slice(0, 10);
      $('#alFrom').value = tomorrow;
      $('#alTo').value = tomorrow;
    }
    try {
      const status = $('#lqFilter').value;
      const out = await api(`/admin/leave${status ? `?status=${status}` : ''}`);
      $('#lqTable').innerHTML = table(
        ['Employee', 'Type', 'From', 'To', 'Days', 'Reason', 'Status', 'Decision', ''],
        out.requests.map((r) => `<tr>
          <td>${esc(r.full_name)}<div class="small muted mono">${esc(r.employee_code)}</div></td>
          <td>${esc(r.leave_type)}</td>
          <td class="mono">${esc(r.from_date)}</td>
          <td class="mono">${esc(r.to_date)}</td>
          <td class="mono">${r.days}</td>
          <td class="small" style="white-space:normal;max-width:220px">${esc(r.reason || '—')}</td>
          <td><span class="pill ${LEAVE_STYLE[r.status] ?? ''}">${esc(r.status)}</span></td>
          <td class="small">${r.decided_by_name
            ? `${esc(r.decided_by_name)}<div class="muted mono">${esc(r.decided_at || '')}</div>${
                r.decision_note ? `<div class="muted" style="white-space:normal">${esc(r.decision_note)}</div>` : ''}`
            : '—'}</td>
          <td class="row tight">${r.status === 'pending' ? `
            <button class="ok slim" data-approve="${r.id}">Approve</button>
            <button class="bad slim" data-reject="${r.id}">Reject</button>` : ''}</td>
        </tr>`));

      $$('[data-approve]').forEach((b) => b.onclick = () => decide(b.dataset.approve, true));
      $$('[data-reject]').forEach((b) => b.onclick = () => decide(b.dataset.reject, false));
      refreshLeaveBadge();
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  function decide(id, approve) {
    const body = `<p class="muted small">${approve
      ? 'Approving writes leave days onto the working calendar. Rest days and public holidays inside the range are left as they are.'
      : 'The employee will see the request as rejected, together with your note.'}</p>` +
      fieldRow([{ label: 'Note to the employee', name: 'note', value: '' }]);
    modal(approve ? 'Approve leave request' : 'Reject leave request', body, async (data) => {
      const out = await api(`/admin/leave/${id}/decide`, { method: 'POST', body: { approve, note: data.note || undefined } });
      toast(approve ? `Approved — ${out.days_applied} day(s) written to the calendar.` : 'Request rejected.', 'ok');
      loadLeaveQueue();
    }, approve ? 'Approve' : 'Reject');
  }

  async function refreshLeaveBadge() {
    try {
      const n = (await api('/admin/leave?status=pending')).requests.length;
      const badge = $('#leaveBadge');
      badge.textContent = n;
      badge.classList.toggle('hidden', n === 0);
    } catch { /* the badge is cosmetic */ }
  }

  async function downloadFile(path, filename) {
    try {
      const res = await api(path, { raw: true });
      if (!res.ok) throw new HR.ApiError('The export failed.', res.status);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  // ---------------------------------------------------------------- holidays
  $('#holAdd').onclick = async () => {
    try {
      await api('/admin/holidays', { method: 'POST',
        body: { holiday_date: $('#holDate').value, name: $('#holName').value } });
      $('#holName').value = '';
      toast('Holiday added.', 'ok');
      loadHolidays();
    } catch (ex) { toast(ex.message, 'bad'); }
  };

  async function loadHolidays() {
    try {
      state.holidays = (await api('/admin/holidays')).holidays;
      $('#holTable').innerHTML = table(['Date', 'Holiday', ''], state.holidays.map((h) => `<tr>
        <td class="mono">${esc(h.holiday_date)}</td><td>${esc(h.name)}</td>
        <td>${state.canEdit ? `<button class="ghost slim" data-del-hol="${esc(h.holiday_date)}">Remove</button>` : ''}</td>
      </tr>`));
      $$('[data-del-hol]').forEach((b) => b.onclick = async () => {
        await api(`/admin/holidays/${b.dataset.delHol}`, { method: 'DELETE' });
        loadHolidays();
      });
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  // ------------------------------------------------------------------- audit
  $('#audLoad').onclick = loadAudit;

  async function loadAudit() {
    try {
      const q = $('#audUser').value ? `?user_id=${$('#audUser').value}` : '';
      const out = await api(`/admin/punch-log${q}`);
      $('#audTable').innerHTML = table(
        ['Time', 'Employee', 'Type', 'Outcome', 'Reason', 'Project', 'Distance', 'Accuracy', 'Coordinates'],
        out.log.map((l) => `<tr>
          <td class="mono small">${esc(l.server_local)}</td>
          <td>${esc(l.full_name || '—')}<div class="small muted mono">${esc(l.employee_code || '')}</div></td>
          <td>${esc(l.kind)}</td>
          <td>${l.outcome === 'accepted' ? '<span class="pill ok">accepted</span>' : '<span class="pill bad">rejected</span>'}</td>
          <td class="small">${esc((l.reason || '').replace(/_/g, ' '))}</td>
          <td>${esc(l.project_name || '—')}</td>
          <td class="mono">${esc(metres(l.distance_m))}</td>
          <td class="mono">${l.accuracy == null ? '—' : `±${Math.round(l.accuracy)} m`}</td>
          <td class="mono small">${l.lat == null ? '—' :
            `<a href="https://www.google.com/maps?q=${l.lat},${l.lng}" target="_blank" rel="noopener">${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}</a>`}</td>
        </tr>`));
    } catch (ex) { toast(ex.message, 'bad'); }
  }

  I18N.apply();
  boot();
})();
