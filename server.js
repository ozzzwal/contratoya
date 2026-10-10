'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const docs = require('./docs');

const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, JWT_SECRET, BASE_URL = 'http://localhost:3000', PORT = 3000, DB_PATH = './contratoya.db', NODE_ENV } = process.env;
if (!JWT_SECRET || JWT_SECRET.length < 32) { console.error('Define JWT_SECRET en .env (mínimo 32 caracteres aleatorios).'); process.exit(1); }
const prod = NODE_ENV === 'production';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
const stripeReady = Boolean(stripe && STRIPE_WEBHOOK_SECRET);
const TOPUPS = [5, 10, 20, 50]; // USD

// ---------- Base de datos ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), cents INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), template_id TEXT NOT NULL, data TEXT NOT NULL, price_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft', folio TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, paid_at TEXT);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_docs_user ON documents(user_id);
`);
const balance = uid => db.prepare('SELECT COALESCE(SUM(cents),0) AS b FROM ledger WHERE user_id=?').get(uid).b;
const newFolio = () => 'CY-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
const today = iso => new Date(iso || Date.now()).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

// ---------- App y seguridad ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ['https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
    frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], upgradeInsecureRequests: prod ? [] : null
  } },
  hsts: prod ? { maxAge: 31536000, includeSubDomains: true } : false
}));

// ---------- Webhook de Stripe (cuerpo crudo, ANTES de express.json) ----------
function settle(s) {
  const m = s.metadata || {}, uid = Number(m.user_id);
  if (!uid || s.payment_status !== 'paid') return;
  if (m.kind === 'topup') {
    db.prepare('INSERT OR IGNORE INTO ledger(user_id,cents,kind,ref) VALUES(?,?,?,?)').run(uid, s.amount_total, 'topup', 'stripe:' + s.id);
  } else if (m.kind === 'doc') {
    const d = db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(m.doc_id, uid);
    if (d && d.status === 'draft' && s.amount_total === d.price_cents && s.currency === 'usd')
      db.prepare("UPDATE documents SET status='paid', paid_at=CURRENT_TIMESTAMP, folio=? WHERE id=? AND status='draft'").run(newFolio(), d.id);
  }
}
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.sendStatus(503);
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).send('Firma inválida'); }
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') settle(ev.data.object);
  res.json({ received: true });
});

app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
// Defensa CSRF adicional (además de cookie SameSite=Lax): las mutaciones exigen cabecera personalizada
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Requested-With') !== 'contratoya') return res.status(403).json({ error: 'Solicitud no permitida' });
  next();
});

// ---------- Autenticación ----------
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos. Espera unos minutos.' } });
const DUMMY = bcrypt.hashSync('dummy-password', 12); // iguala tiempos para no revelar si el correo existe
const sign = id => jwt.sign({ uid: id }, JWT_SECRET, { expiresIn: '7d' });
const setCookie = (res, token) => res.cookie('cy', token, { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 7 * 864e5, path: '/' });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const emailOk = e => e.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);

function auth(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.cy, JWT_SECRET);
    const u = db.prepare('SELECT id,email,name FROM users WHERE id=?').get(p.uid);
    if (!u) throw new Error('no user');
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Inicia sesión para continuar' }); }
}

app.post('/api/register', authLimit, async (req, res) => {
  const { email = '', password = '', name = '' } = req.body || {};
  const e = String(email).trim().toLowerCase(), n = String(name).trim().replace(/\s+/g, ' ').slice(0, 80), p = String(password);
  if (!emailOk(e)) return bad(res, 'Correo electrónico no válido');
  if (n.length < 2) return bad(res, 'Escribe tu nombre completo');
  if (p.length < 10 || p.length > 128) return bad(res, 'La contraseña debe tener entre 10 y 128 caracteres');
  try {
    const r = db.prepare('INSERT INTO users(email,name,pass_hash) VALUES(?,?,?)').run(e, n, await bcrypt.hash(p, 12));
    setCookie(res, sign(r.lastInsertRowid));
    res.json({ user: { email: e, name: n }, balance: 0 });
  } catch { bad(res, 'No se pudo crear la cuenta. Si ya tienes una, inicia sesión.'); }
});

app.post('/api/login', authLimit, async (req, res) => {
  const e = String(req.body?.email || '').trim().toLowerCase(), p = String(req.body?.password || '').slice(0, 128);
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(e);
  const ok = await bcrypt.compare(p, u ? u.pass_hash : DUMMY);
  if (!u || !ok) return bad(res, 'Correo o contraseña incorrectos', 401);
  setCookie(res, sign(u.id));
  res.json({ user: { email: u.email, name: u.name }, balance: balance(u.id) });
});

app.post('/api/logout', (req, res) => { res.clearCookie('cy', { path: '/' }); res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  try {
    const p = jwt.verify(req.cookies.cy, JWT_SECRET);
    const u = db.prepare('SELECT id,email,name FROM users WHERE id=?').get(p.uid);
    if (!u) throw new Error('no user');
    res.json({ user: { email: u.email, name: u.name }, balance: balance(u.id) });
  } catch { res.json({ user: null, balance: 0 }); }
});

// ---------- Catálogo y vista previa ----------
app.get('/api/templates', (req, res) => res.json({ templates: docs.T.map(({ b, ...t }) => t) }));

app.post('/api/preview', rateLimit({ windowMs: 60_000, limit: 90 }), (req, res) => {
  const t = docs.BY[String(req.body?.template)];
  if (!t) return bad(res, 'Plantilla no encontrada', 404);
  const { o } = docs.clean(t, req.body.data, false);
  res.json({ blocks: docs.build(t, o, { folio: 'BORRADOR', date: today() }).out });
});

// ---------- Documentos ----------
app.post('/api/documents', auth, (req, res) => {
  const t = docs.BY[String(req.body?.template)];
  if (!t) return bad(res, 'Plantilla no encontrada', 404);
  const { o, err } = docs.clean(t, req.body.data, true);
  if (err.length) return bad(res, 'Completa estos campos: ' + err.slice(0, 4).join(', ') + (err.length > 4 ? '…' : ''));
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO documents(id,user_id,template_id,data,price_cents) VALUES(?,?,?,?,?)').run(id, req.user.id, t.id, JSON.stringify(o), t.cents); // precio SIEMPRE del servidor
  res.json({ id, cents: t.cents });
});

app.get('/api/documents', auth, (req, res) => {
  const rows = db.prepare('SELECT id,template_id,price_cents,status,folio,created_at FROM documents WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ docs: rows.map(r => ({ id: r.id, n: docs.BY[r.template_id]?.n || r.template_id, cents: r.price_cents, status: r.status, folio: r.folio, at: r.created_at })) });
});

app.post('/api/documents/:id/pay', auth, async (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!d) return bad(res, 'Documento no encontrado', 404);
  if (d.status === 'paid') return res.json({ ok: true });
  const t = docs.BY[d.template_id];
  if (req.body?.method === 'wallet') {
    try {
      db.transaction(() => {
        if (balance(req.user.id) < d.price_cents) throw new Error('SALDO');
        db.prepare('INSERT INTO ledger(user_id,cents,kind,ref) VALUES(?,?,?,?)').run(req.user.id, -d.price_cents, 'doc', 'doc:' + d.id); // ref única: evita doble cobro
        db.prepare("UPDATE documents SET status='paid', paid_at=CURRENT_TIMESTAMP, folio=? WHERE id=? AND status='draft'").run(newFolio(), d.id);
      })();
      return res.json({ ok: true, balance: balance(req.user.id) });
    } catch (e) { return bad(res, e.message === 'SALDO' ? 'Saldo insuficiente. Recarga tu billetera.' : 'No se pudo completar el pago', 402); }
  }
  if (req.body?.method === 'card') {
    if (!stripeReady) return bad(res, 'Pagos no disponibles: configura la clave de Stripe y el secreto del webhook.', 503);
    try {
      const s = await stripe.checkout.sessions.create({
        mode: 'payment', customer_email: req.user.email,
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: d.price_cents, product_data: { name: t.n + ' · ContratoYa' } } }],
        metadata: { kind: 'doc', doc_id: d.id, user_id: String(req.user.id) },
        success_url: `${BASE_URL}/?doc=${d.id}`, cancel_url: `${BASE_URL}/?cancel=1`
      });
      return res.json({ url: s.url });
    } catch { return bad(res, 'No se pudo iniciar el pago con tarjeta', 502); }
  }
  bad(res, 'Método de pago no válido');
});

app.get('/api/documents/:id/download', auth, async (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!d) return bad(res, 'Documento no encontrado', 404);
  if (d.status !== 'paid') return bad(res, 'Documento pendiente de pago', 402);
  const t = docs.BY[d.template_id], { out } = docs.build(t, JSON.parse(d.data), { folio: d.folio, date: today(d.paid_at + 'Z') });
  const base = `${d.folio}-${t.id}`;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.query.format === 'docx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.docx"`);
    return res.send(await docs.docx(out));
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
  docs.pdf(out, res);
});

// ---------- Billetera ----------
app.post('/api/wallet/topup', auth, async (req, res) => {
  const v = Number(req.body?.amount);
  if (!TOPUPS.includes(v)) return bad(res, 'Monto no válido');
  if (!stripeReady) return bad(res, 'Pagos no disponibles: configura la clave de Stripe y el secreto del webhook.', 503);
  try {
    const s = await stripe.checkout.sessions.create({
      mode: 'payment', customer_email: req.user.email,
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: v * 100, product_data: { name: `Recarga de saldo ContratoYa $${v}` } } }],
      metadata: { kind: 'topup', user_id: String(req.user.id) },
      success_url: `${BASE_URL}/?topup=ok`, cancel_url: `${BASE_URL}/?cancel=1`
    });
    res.json({ url: s.url });
  } catch { bad(res, 'No se pudo iniciar la recarga', 502); }
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.toLowerCase().endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Error interno' }); }); // eslint-disable-line

app.listen(PORT, () => console.log(`ContratoYa en ${BASE_URL} (puerto ${PORT}) · Stripe: ${stripeReady ? 'activo' : 'NO configurado (clave y webhook requeridos)'}`));
