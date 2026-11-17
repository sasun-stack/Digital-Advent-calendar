// Yerevan Mall advent calendar — self-hosted server (Railway).
// Serves the kiosk page, keeps gifts/draws in a JSON file on a volume, stores gift photos,
// pushes live updates over Server-Sent Events, and talks to Google Sheets / Drive with a service account.
'use strict';
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { JWT } = require('google-auth-library');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const KIOSK_KEY = process.env.KIOSK_KEY || '';
const SHEET_ID = process.env.SHEET_ID || '';            // optional: only this spreadsheet may be used

/* ---------------- storage: one JSON file + a folder of photos ---------------- */
const BLOBS = path.join(DATA, 'blobs');
fs.mkdirSync(BLOBS, { recursive: true });
const DBF = path.join(DATA, 'db.json');
let db = { docs: {}, blobs: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8'))); } catch (e) { /* first start */ }

let chain = Promise.resolve(), pending = null;
function save() {                                       // coalesces bursts; resolves once the change is on disk
  if (pending) return pending;
  pending = chain = chain.then(() => new Promise(r => setTimeout(r, 30))).then(async () => {
    pending = null;
    const tmp = DBF + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(db));
    await fsp.rename(tmp, DBF);
  }).catch(e => { pending = null; console.error('save failed', e); throw e; });
  return pending;
}

/* ---------------- who is calling ---------------- */
const adminToken = () => crypto.createHmac('sha256', ADMIN_PASSWORD).update('advent-admin-v1').digest('hex');
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function role(req) {
  const h = req.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (ADMIN_PASSWORD && t.startsWith('a:') && safeEq(t.slice(2), adminToken())) return 'admin';
  if (KIOSK_KEY && t.startsWith('k:') && safeEq(t.slice(2), KIOSK_KEY)) return 'kiosk';
  return 'viewer';
}
const canRead = (col, r) => col === 'draws' ? r !== 'viewer' : true;
const canWrite = (col, r) => r === 'admin' || (r === 'kiosk' && (col === 'gifts' || col === 'draws'));
const fail = (res, status, code) => res.status(status).json({ code });
const okName = (v) => /^[A-Za-z0-9_.-]{1,128}$/.test(v || '');

/* ---------------- live updates ---------------- */
const clients = new Set();
function broadcast(col) { const msg = 'data: ' + JSON.stringify({ col }) + '\n\n'; clients.forEach(c => c.write(msg)); }
setInterval(() => clients.forEach(c => c.write(': ping\n\n')), 25000);

const app = express();
app.disable('x-powered-by');
app.use('/api', express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/api/me', (req, res) => res.json({ role: role(req), google: !!loadServiceAccount() }));
app.post('/api/login', async (req, res) => {
  const pw = req.body && req.body.password;
  if (!ADMIN_PASSWORD || !pw || !safeEq(pw, ADMIN_PASSWORD)) { await new Promise(r => setTimeout(r, 700)); return fail(res, 403, 'permission_denied'); }
  res.json({ token: 'a:' + adminToken() });
});

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/col/:col', (req, res) => {
  const col = req.params.col, r = role(req);
  if (!okName(col)) return fail(res, 400, 'invalid_argument');
  if (!canRead(col, r)) return res.json([]);
  let list = Object.keys(db.docs).filter(k => k.startsWith(col + '/')).map(k => ({ id: k.slice(col.length + 1), data: db.docs[k] }));
  const by = req.query.orderBy, desc = req.query.dir === 'desc';
  if (by) list.sort((a, b) => { const x = a.data[by], y = b.data[by]; const c = x === y ? 0 : x == null ? -1 : y == null ? 1 : x < y ? -1 : 1; return desc ? -c : c; });
  const lim = parseInt(req.query.limit, 10);
  if (lim > 0) list = list.slice(0, lim);
  res.json(list);
});

app.get('/api/doc/:col/:id', (req, res) => {
  const { col, id } = req.params, r = role(req);
  if (!okName(col) || !okName(id)) return fail(res, 400, 'invalid_argument');
  const d = canRead(col, r) ? db.docs[col + '/' + id] : undefined;
  res.json(d ? { exists: true, data: d } : { exists: false });
});

async function write(req, res, fn) {
  const { col, id } = req.params, r = role(req);
  if (!okName(col) || !okName(id)) return fail(res, 400, 'invalid_argument');
  if (!canWrite(col, r)) return fail(res, 403, 'permission_denied');
  const key = col + '/' + id;
  const out = fn(key, req.body);
  if (out) return fail(res, out[0], out[1]);
  try { await save(); } catch (e) { return fail(res, 503, 'unavailable'); }
  broadcast(col);
  res.json({ ok: true });
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
app.put('/api/doc/:col/:id', (req, res) => write(req, res, (key, body) => { if (!isObj(body)) return [400, 'invalid_argument']; db.docs[key] = body; }));
app.patch('/api/doc/:col/:id', (req, res) => write(req, res, (key, body) => {
  if (!isObj(body)) return [400, 'invalid_argument'];
  if (!db.docs[key]) return [404, 'not_found'];
  db.docs[key] = Object.assign({}, db.docs[key], body);
}));
app.delete('/api/doc/:col/:id', (req, res) => write(req, res, (key) => { delete db.docs[key]; }));

/* ---------------- gift photos ---------------- */
const IMG = { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1, 'image/gif': 1, 'image/svg+xml': 1 };
app.post('/api/assets', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  const r = role(req);
  if (r === 'viewer') return fail(res, 403, 'permission_denied');
  const type = (req.get('content-type') || '').split(';')[0].trim();
  if (!IMG[type]) return fail(res, 400, 'unsupported_type');
  if (!req.body || !req.body.length) return fail(res, 400, 'invalid_argument');
  const id = crypto.randomBytes(12).toString('hex');
  await fsp.writeFile(path.join(BLOBS, id), req.body);
  db.blobs[id] = { type, size: req.body.length, at: Date.now() };
  try { await save(); } catch (e) { return fail(res, 503, 'unavailable'); }
  res.json({ id, url: '/_blob/' + id });
});
app.delete('/api/assets/:id', async (req, res) => {
  const id = req.params.id;
  if (role(req) === 'viewer') return fail(res, 403, 'permission_denied');
  if (!/^[a-f0-9]{24}$/.test(id) || !db.blobs[id]) return res.json({ ok: true });
  delete db.blobs[id];
  await fsp.unlink(path.join(BLOBS, id)).catch(() => {});
  await save().catch(() => {});
  res.json({ ok: true });
});
app.get('/_blob/:id', (req, res) => {
  const id = req.params.id, meta = db.blobs[id];
  if (!/^[a-f0-9]{24}$/.test(id) || !meta) return res.status(404).end();
  res.set({ 'Content-Type': meta.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
  fs.createReadStream(path.join(BLOBS, id)).on('error', () => res.status(404).end()).pipe(res);
});

/* ---------------- Google Sheets / Drive, in the shape the page expects ---------------- */
let sa = undefined, jwt = null;
function loadServiceAccount() {
  if (sa !== undefined) return sa;
  sa = null;
  let raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return sa;
  if (!raw.startsWith('{')) { try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { /* ignore */ } }
  try {
    const j = JSON.parse(raw);
    if (j.client_email && j.private_key) {
      sa = j;
      jwt = new JWT({ email: j.client_email, key: j.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'] });
    }
  } catch (e) { console.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  return sa;
}
class ToolError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
async function google(url, opts = {}) {
  const { token } = await jwt.getAccessToken();
  const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {}) }));
  if (r.ok) return r;
  const text = await r.text().catch(() => '');
  console.error('google', r.status, url, text.slice(0, 300));
  throw new ToolError(r.status === 429 || r.status >= 500 ? 'upstream_error' : 'tool_error', text.slice(0, 200));
}
const sheetUrl = (id, range) => 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(id) + '/values/' + encodeURIComponent(range);
const TOOLS = {
  'Google Sheets/get_values': async (a) => {
    const r = await google(sheetUrl(a.spreadsheetId, a.range) + '?valueRenderOption=FORMATTED_VALUE');
    const j = await r.json();
    return { range: j.range, values: j.values || [] };
  },
  'Google Sheets/update_values': async (a) => {
    const r = await google(sheetUrl(a.spreadsheetId, a.range) + '?valueInputOption=USER_ENTERED', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: a.range, majorDimension: 'ROWS', values: a.values })
    });
    return await r.json();
  },
  'Google Drive/download_file_content': async (a) => {
    const id = String(a.fileId || '');
    if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new ToolError('tool_error');
    let buf = null;
    try {
      const r = await google('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media&supportsAllDrives=true');
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      // a file shared as "anyone with the link" can still be fetched without the service account
      const r = await fetch('https://drive.google.com/uc?export=download&id=' + id, { redirect: 'follow' });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || type.startsWith('text/html')) throw new ToolError('tool_error');
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (buf.length > 15 * 1024 * 1024) throw new ToolError('too_large');
    return { content: buf.toString('base64') };
  }
};
app.post('/api/mcp', async (req, res) => {
  if (role(req) === 'viewer') return fail(res, 403, 'permission_denied');
  const { server, tool, args } = req.body || {};
  const fn = TOOLS[server + '/' + tool];
  if (!fn) return fail(res, 400, 'not_in_manifest');
  if (!loadServiceAccount()) return fail(res, 503, 'server_not_connected');
  const a = args || {};
  if (server === 'Google Sheets' && SHEET_ID && a.spreadsheetId !== SHEET_ID) return fail(res, 403, 'blocked_by_policy');
  try { res.json({ payload: await fn(a) }); }
  catch (e) { res.status(502).json({ code: e.code || 'upstream_error', message: String(e.message || '').slice(0, 200) }); }
});

/* ---------------- the page ---------------- */
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => { if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache'); else res.set('Cache-Control', 'public, max-age=86400'); }
}));

app.listen(PORT, () => {
  console.log('Advent calendar on port ' + PORT + ', data in ' + DATA);
  if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set: the admin page cannot be opened');
  if (!KIOSK_KEY) console.warn('KIOSK_KEY is not set: the kiosk cannot record prizes');
  if (!loadServiceAccount()) console.warn('GOOGLE_SERVICE_ACCOUNT_JSON is not set: Google Sheet sync is off');
});
