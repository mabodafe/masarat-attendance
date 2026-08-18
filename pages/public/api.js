/* Shared API client + small DOM/format helpers used by both the employee app
   and the admin console. */
(function () {
  const TOKEN_KEY = 'hr_token';
  const USER_KEY = 'hr_user';

  const store = {
    get token() { return localStorage.getItem(TOKEN_KEY); },
    set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
    get user() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } },
    set user(v) { v ? localStorage.setItem(USER_KEY, JSON.stringify(v)) : localStorage.removeItem(USER_KEY); },
    clear() { this.token = null; this.user = null; },
  };

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }

  async function api(path, { method = 'GET', body, raw = false } = {}) {
    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(store.token ? { Authorization: `Bearer ${store.token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(window.I18N ? I18N.t('networkError') : 'Network error.', 0, 'network');
    }
    if (res.status === 401 && store.token) {
      store.clear();
      location.reload();
      throw new ApiError('Session expired.', 401, 'expired');
    }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`, res.status, data.code);
    return data;
  }

  // ---------- formatting ----------
  const pad = (n) => String(n).padStart(2, '0');

  function hm(minutes) {
    if (minutes == null) return '—';
    const sign = minutes < 0 ? '-' : '';
    const m = Math.abs(Math.round(minutes));
    return `${sign}${Math.floor(m / 60)}:${pad(m % 60)}`;
  }
  function durationText(minutes) {
    if (minutes == null) return '—';
    const m = Math.round(minutes);
    const h = Math.floor(m / 60);
    const t = window.I18N ? I18N.t : (k) => k;
    return h ? `${h}${t('hours')} ${pad(m % 60)}${t('minutes')}` : `${m}${t('minutes')}`;
  }
  const metres = (v) => (v == null ? '—' : `${Math.round(v)} m`);

  // ---------- tiny DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(message, kind = 'info', ms = 3800) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function busy(button, on, label) {
    if (!button) return;
    if (on) {
      button.dataset.label = button.innerHTML;
      button.innerHTML = `<span class="spin"></span> ${label || ''}`;
      button.disabled = true;
    } else {
      if (button.dataset.label) button.innerHTML = button.dataset.label;
      button.disabled = false;
    }
  }

  /**
   * One fresh, high-accuracy GPS reading. maximumAge is 0 so the browser is
   * never allowed to hand back a cached position - the server rejects stale
   * fixes anyway, and this is what forces the employee to actually open GPS.
   */
  function getFix({ timeout = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        return reject(new ApiError(I18N.t('unsupported'), 0, 'unsupported'));
      }
      if (!window.isSecureContext) {
        return reject(new ApiError(I18N.t('insecure'), 0, 'insecure'));
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          // The browser's own fix timestamp, so the server can measure staleness.
          captured_at: new Date(pos.timestamp).toISOString(),
          received_at: Date.now(),
        }),
        (err) => {
          const map = {
            1: I18N.t('locationDenied'),
            2: I18N.t('locationOff'),
            3: I18N.t('locationTimeout'),
          };
          reject(new ApiError(map[err.code] || err.message, 0, `geo_${err.code}`));
        },
        { enableHighAccuracy: true, timeout, maximumAge: 0 }
      );
    });
  }

  /** Company-local calendar date, independent of the phone's own timezone. */
  const todayLocal = (offsetMin = 0) =>
    new Date(Date.now() + offsetMin * 60000).toISOString().slice(0, 10);

  window.HR = { api, ApiError, store, $, $$, esc, toast, busy, getFix, hm, durationText, metres, pad, todayLocal };
})();
