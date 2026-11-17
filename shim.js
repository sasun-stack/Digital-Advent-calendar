// Stands in for claude.ai's window.claude on the self-hosted page: the same db / assets / user / mcp calls,
// served by this app's own server. The kiosk page itself is unchanged.
(function () {
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };
  // The kiosk opens the page once as /?key=XXXX; the key is kept on that device and taken out of the address.
  var qs = new URLSearchParams(location.search);
  if (qs.get('key')) {
    LS.set('advent.token', 'k:' + qs.get('key')); qs.delete('key');
    history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '') + location.hash);
  }
  var token = function () { return LS.get('advent.token') || ''; };
  var noop = function () {};
  function err(code) { var e = new Error(code); e.code = code; return e; }
  async function api(method, url, body, raw) {
    var h = {}, t = token(), opt = { method: method, headers: h };
    if (t) h.Authorization = 'Bearer ' + t;
    if (raw) { opt.body = raw; h['Content-Type'] = raw.type || 'application/octet-stream'; }
    else if (body !== undefined) { opt.body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    var r; try { r = await fetch(url, opt); } catch (e) { throw err('unavailable'); }
    var j = null; try { j = await r.json(); } catch (e) { /* empty body */ }
    if (!r.ok) throw err((j && j.code) || (r.status === 401 || r.status === 403 ? 'permission_denied' : r.status === 404 ? 'not_found' : 'unavailable'));
    return j;
  }
  var enc = encodeURIComponent;
  var clone = function (v) { return v == null ? v : JSON.parse(JSON.stringify(v)); };

  /* live updates: the server names the collection that changed; listeners on it fetch again */
  var listeners = [];
  function refresh(col) {
    listeners.forEach(function (l) {
      if (col && l.col !== col) return;
      clearTimeout(l.timer); l.timer = setTimeout(l.run, 40);
    });
  }
  var es = null, wasDown = false;
  function openEvents() {
    if (es || typeof EventSource === 'undefined') return;
    es = new EventSource('/api/events');
    es.onmessage = function (ev) { try { refresh(JSON.parse(ev.data).col); } catch (e) { /* ignore */ } };
    es.onerror = function () { wasDown = true; };
    es.onopen = function () { if (wasDown) { wasDown = false; refresh(null); } };
  }
  setInterval(function () { refresh(null); }, 60000);        // safety net if an event was missed
  function listen(col, run) {
    var l = { col: col, run: run, timer: 0 }; listeners.push(l); openEvents(); run();
    return function () { var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); clearTimeout(l.timer); };
  }

  var docSnap = function (id, data) { return { id: id, exists: data != null, data: function () { return data != null ? clone(data) : undefined; } }; };
  var colSnap = function (list) { return { empty: !list.length, size: list.length, docs: list.map(function (d) { return { id: d.id, exists: true, data: function () { return clone(d.data); } }; }) }; };
  function query(col, ord, lim) {
    return {
      orderBy: function (f, dir) { return query(col, { f: f, dir: dir || 'asc' }, lim); },
      limit: function (n) { return query(col, ord, n); },
      get: async function () {
        var p = new URLSearchParams();
        if (ord) { p.set('orderBy', ord.f); p.set('dir', ord.dir); }
        if (lim) p.set('limit', lim);
        return colSnap(await api('GET', '/api/col/' + enc(col) + '?' + p));
      },
      onSnapshot: function (next, onErr) { var q = this; return listen(col, function () { q.get().then(next, onErr || noop); }); }
    };
  }
  function docRef(p) {
    var i = p.indexOf('/'), col = p.slice(0, i), id = p.slice(i + 1), u = '/api/doc/' + enc(col) + '/' + enc(id);
    return {
      id: id,
      get: async function () { var j = await api('GET', u); return docSnap(id, j.exists ? j.data : null); },
      set: function (d) { return api('PUT', u, d).then(noop); },
      update: function (d) { return api('PATCH', u, d).then(noop); },
      delete: function () { return api('DELETE', u).then(noop); },
      onSnapshot: function (next, onErr) { var r = this; return listen(col, function () { r.get().then(next, onErr || noop); }); }
    };
  }
  var dbNs = Object.freeze({ collection: function (c) { return query(c, null, 0); }, doc: docRef });
  var assetsNs = Object.freeze({
    upload: async function (blob, opts) {
      var b = (opts && opts.type && blob.type !== opts.type) ? new Blob([blob], { type: opts.type }) : blob;
      return api('POST', '/api/assets', undefined, b);
    },
    delete: function (id) { return api('DELETE', '/api/assets/' + enc(id)).then(noop); }
  });
  var me = null;
  function whoami() { if (!me) me = api('GET', '/api/me').catch(function () { return { role: 'viewer' }; }); return me; }
  var userNs = Object.freeze({
    isOwner: async function () { return (await whoami()).role === 'admin'; },
    canEdit: async function () { return (await whoami()).role === 'admin'; },
    canSync: async function () { var r = (await whoami()).role; return r === 'admin' || r === 'kiosk'; },
    can: async function () { return null; }
  });
  var mcpNs = Object.freeze({
    callTool: function (server, tool, args) { return api('POST', '/api/mcp', { server: server, tool: tool, args: args || {} }); }
  });
  var NS = { db: dbNs, assets: assetsNs, user: userNs, mcp: mcpNs };
  window.claude = Object.freeze({ use: function (n) { return Promise.resolve(NS[n] || null); } });

  /* admin sign-in: opening #admin on a device that is not signed in asks for the password */
  function loginBox() {
    if (document.getElementById('adv-login')) return;
    var box = document.createElement('div'); box.id = 'adv-login';
    box.innerHTML = '<form><h2>Կառավարում</h2><p>Մուտքագրեք ադմինիստրատորի գաղտնաբառը</p>' +
      '<input type="password" autocomplete="current-password" required><button type="submit">Մուտք</button><p class="e" hidden>Սխալ գաղտնաբառ</p>' +
      '<a href="#">← Օրացույց</a></form>';
    var css = document.createElement('style');
    css.textContent = '#adv-login{position:fixed;inset:0;z-index:99;display:grid;place-items:center;background:rgba(20,22,32,.92);font-family:"Noto Sans Armenian",system-ui,sans-serif}' +
      '#adv-login form{background:#fff;color:#222;border-radius:18px;padding:28px;width:min(360px,90vw);display:grid;gap:12px;text-align:center}' +
      '#adv-login h2{margin:0;font-size:22px}#adv-login p{margin:0;color:#666;font-size:14px}#adv-login .e{color:#c0264f}' +
      '#adv-login input{font:inherit;font-size:17px;padding:12px;border:1px solid #ccc;border-radius:10px}' +
      '#adv-login button{font:inherit;font-weight:600;font-size:16px;padding:12px;border:0;border-radius:10px;background:#D93E83;color:#fff;cursor:pointer}' +
      '#adv-login a{color:#666;font-size:14px}';
    box.appendChild(css); document.body.appendChild(box);
    var f = box.querySelector('form'), inp = box.querySelector('input'), e = box.querySelector('.e');
    inp.focus();
    box.querySelector('a').addEventListener('click', function (ev) { ev.preventDefault(); location.hash = ''; box.remove(); });
    f.addEventListener('submit', async function (ev) {
      ev.preventDefault(); e.hidden = true;
      try { var j = await api('POST', '/api/login', { password: inp.value }); LS.set('advent.token', j.token); location.reload(); }
      catch (x) { e.hidden = false; inp.select(); }
    });
  }
  async function checkAdmin() {
    if (location.hash !== '#admin') { var b = document.getElementById('adv-login'); if (b) b.remove(); return; }
    if ((await whoami()).role !== 'admin') loginBox();
  }
  addEventListener('hashchange', checkAdmin);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkAdmin); else checkAdmin();
})();
