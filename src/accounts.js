/* Contas do ILHA ZERO: cadastro, login, sessões, códigos de troca de nick e conta de desenvolvedor.
   Tudo roda no servidor. O cliente nunca recebe senha, hash nem a lista de códigos.
   Dados em DATA_DIR/accounts.json (padrão: ./data). */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'accounts.json');

/* ---------- conta de desenvolvedor (só existe no servidor, nunca no arquivo de dados) ---------- */
const ADMIN_NICK = 'IIBERTOX';
const ADMIN_PASS = process.env.ADMIN_PASS || '8865';   // defina ADMIN_PASS no servidor para não deixar a senha no código
const ADMIN_PASS_FROM_ENV = !!process.env.ADMIN_PASS;

const SESSION_MS = 30 * 24 * 3600 * 1000, ADMIN_SESSION_MS = 12 * 3600 * 1000;
const MAX_ACCOUNTS = 20000;

let db = { accounts: {}, codes: {}, sessions: {}, mail: {} };
const byEmail = new Map(), byNick = new Map();
const adminSessions = new Map();          // hash do token -> expira (só memória)
const fails = new Map();                  // chave -> {n, until}
const redeemTries = new Map();            // id -> {n, t}

/* ---------- utilidades ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const randHex = n => crypto.randomBytes(n).toString('hex');
const nickKey = n => String(n).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[-_]/g, '');
const lookKey = n => nickKey(n).replace(/[L1|!]/g, 'I').replace(/0/g, 'O');
const RES_EXACT = ['ADMIN', 'ADMINISTRADOR', 'DEV', 'DEVELOPER', 'DESENVOLVEDOR', 'MOD', 'MODERADOR', 'SUPORTE', 'SUPPORT', 'SYSTEM', 'SISTEMA', 'STAFF', 'OFICIAL', 'ROOT'].map(lookKey);
const RES_CONTAIN = [ADMIN_NICK, 'ILHAZERO'].map(lookKey);
const NICK_RE = /^[\p{L}\p{N}_-]{3,14}$/u;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const normEmail = e => String(e || '').trim().toLowerCase();

function nickProblem(n, ignoreId) {
  n = String(n || '').trim();
  if (!NICK_RE.test(n)) return 'Nick inválido: use de 3 a 14 letras, números, _ ou - (sem espaços).';
  const lk = lookKey(n);
  if (RES_EXACT.includes(lk) || RES_CONTAIN.some(r => lk.includes(r))) return 'Esse nick é reservado.';
  const id = byNick.get(nickKey(n));
  if (id && id !== ignoreId) return 'Esse nick já está em uso.';
  return '';
}

/* ---------- senha (scrypt) ---------- */
function hashPass(pass, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  return new Promise((res, rej) => crypto.scrypt(String(pass), salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res({ salt: salt.toString('hex'), hash: k.toString('hex') })));
}
async function checkPass(pass, salt, hash) {
  const h = await hashPass(pass, salt);
  const a = Buffer.from(h.hash, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
let adminCred = null, dummyCred = null;

/* ---------- persistência ---------- */
let saveT = null, saving = false, dirty = false;
function save() {
  dirty = true; if (saveT) return;
  saveT = setTimeout(() => { saveT = null; flush(); }, 400);
}
function flush() {
  if (!dirty || saving) return; dirty = false; saving = true;
  const tmp = FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), e => {
    if (e) { saving = false; console.error('[contas] erro ao salvar:', e.message); dirty = true; return; }
    fs.rename(tmp, FILE, e2 => { saving = false; if (e2) console.error('[contas] erro ao salvar:', e2.message); if (dirty) save(); });
  });
}
function flushSync() { try { if (saveT) clearTimeout(saveT); fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('[contas] erro ao salvar:', e.message); } }

async function init() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (d && d.accounts) db = { accounts: d.accounts, codes: d.codes || {}, sessions: d.sessions || {}, mail: d.mail || {}, inbox: d.inbox || {} }; } catch (e) { if (e.code !== 'ENOENT') console.error('[contas] arquivo de contas ilegível, começando vazio:', e.message); }
  for (const a of Object.values(db.accounts)) { byEmail.set(a.email, a.id); byNick.set(nickKey(a.nick), a.id); }
  // o nick do desenvolvedor nunca pode estar com outra conta
  const clash = byNick.get(nickKey(ADMIN_NICK)); if (clash) { const a = db.accounts[clash]; a.nick = 'Jogador' + randHex(2).toUpperCase(); byNick.delete(nickKey(ADMIN_NICK)); byNick.set(nickKey(a.nick), a.id); save(); }
  if (db.inbox && Object.keys(db.inbox).length) {
    for (const [id, box] of Object.entries(db.inbox)) for (const x of box) mailPush(id, { t: x.t, title: 'Código de troca de nick', body: 'Use este código em Ajustes > Conta > Trocar nick (ou toque em Usar). Ele vale uma única troca.', code: x.code });
  }
  delete db.inbox;
  adminCred = await hashPass(ADMIN_PASS);
  dummyCred = await hashPass(randHex(8));
  if (!ADMIN_PASS_FROM_ENV) console.warn('[contas] AVISO: usando a senha padrão do desenvolvedor. Defina a variável de ambiente ADMIN_PASS no servidor (e use uma senha mais longa que 4 dígitos).');
  setInterval(cleanup, 10 * 60 * 1000).unref();
  const bye = () => { flushSync(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  console.log('[contas] ' + Object.keys(db.accounts).length + ' conta(s) carregada(s).');
}
function cleanup() {
  const now = Date.now(); let ch = false;
  for (const [h, s] of Object.entries(db.sessions)) if (s.e < now) { delete db.sessions[h]; ch = true; }
  for (const [h, e] of adminSessions) if (e < now) adminSessions.delete(h);
  for (const [k, v] of fails) if (v.until < now && v.n < 5) fails.delete(k);
  for (const [k, v] of redeemTries) if (now - v.t > 3600e3) redeemTries.delete(k);
  if (ch) save();
}

/* ---------- códigos de troca de nick ---------- */
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCodeRaw() { const u = crypto.randomBytes(8); return Array.from(u, x => CODE_ALPHA[x % CODE_ALPHA.length]).join(''); }
const fmtCode = raw => 'ZERO-' + raw.slice(0, 4) + '-' + raw.slice(4);
function normCode(s) { let c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (c.length === 12 && c.startsWith('ZERO')) c = c.slice(4); return c; }
function issueCode(acctId) {
  const raw = newCodeRaw();
  db.codes[sha(raw)] = { a: acctId || null, t: Date.now(), u: 0 };
  save();
  return fmtCode(raw);
}

/* ---------- correio (cartas dentro do jogo; é por aqui que chegam os códigos de troca de nick) ---------- */
const MAIL_MAX = 30;
function mailPush(acctId, m) {
  if (!acctId || !db.accounts[acctId]) return false;
  const box = db.mail[acctId] || (db.mail[acctId] = []);
  box.unshift({ id: randHex(4), t: m.t || Date.now(), from: String(m.from || 'ILHA ZERO').slice(0, 30), title: String(m.title || '').slice(0, 60), body: String(m.body || '').slice(0, 500), code: m.code || null, read: false });
  while (box.length > MAIL_MAX) box.pop();
  save(); return true;
}
function deliver(acctId, code) {
  mailPush(acctId, { title: 'Código de troca de nick', body: 'Use este código em Ajustes > Conta > Trocar nick (ou toque em Usar). Ele vale uma única troca.', code });
}
const mailList = acct => acct && db.mail[acct.id] ? db.mail[acct.id].map(m => ({ id: m.id, t: m.t, from: m.from, title: m.title, body: m.body, code: m.code, used: !!m.used, read: !!m.read })) : [];
function mailRead(acct, id) { const box = db.mail[acct.id]; if (!box) return; let ch = false; for (const m of box) if ((id === '*' || m.id === id) && !m.read) { m.read = true; ch = true; } if (ch) save(); }
function mailDelete(acct, id) { const box = db.mail[acct.id]; if (!box) return; const rest = box.filter(m => m.id !== id); if (rest.length) db.mail[acct.id] = rest; else delete db.mail[acct.id]; save(); }
function mailCodeUsed(acctId, raw) { const box = db.mail[acctId]; if (!box) return; for (const m of box) if (m.code && normCode(m.code) === raw) { m.code = null; m.used = true; m.read = true; } }
function shopNickCode(acct) {
  if (acct.role === 'dev') throw new ApiError('O desenvolvedor não precisa comprar.', 403);
  const box = db.mail[acct.id] || [];
  if (box.some(m => m.code)) throw new ApiError('Você já tem um código de troca de nick no Correio. Use-o primeiro.', 409);
  const left = (acct.shopNickAt || 0) + 24 * 3600e3 - Date.now();
  if (left > 0) throw new ApiError('Você já comprou uma troca de nick hoje. Tente de novo em ' + Math.ceil(left / 3600e3) + ' h.', 429);
  const code = issueCode(acct.id);
  mailPush(acct.id, { title: 'Troca de nick comprada', body: 'Você comprou uma troca de nick na Loja. Toque em Usar (ou vá em Ajustes > Conta > Trocar nick). Vale uma única troca.', code });
  acct.shopNickAt = Date.now(); save();
}
function adminMail(nick, title, body) {
  title = String(title || '').trim(); body = String(body || '').trim();
  if (!title || !body) throw new ApiError('Preencha título e texto da carta.');
  if (title.length > 60 || body.length > 500) throw new ApiError('Título até 60 e texto até 500 caracteres.');
  let ids;
  if (String(nick).trim() === '*') ids = Object.keys(db.accounts);
  else { const id = byNick.get(nickKey(nick)); if (!id || !db.accounts[id]) throw new ApiError('Jogador não encontrado.', 404); ids = [id]; }
  let n = 0; for (const id of ids) if (mailPush(id, { from: 'DESENVOLVEDOR', title, body })) n++;
  return n;
}

/* ---------- sessões ---------- */
function newSession(id, isAdmin) {
  const token = randHex(32), h = sha(token);
  if (isAdmin) adminSessions.set(h, Date.now() + ADMIN_SESSION_MS);
  else {
    db.sessions[h] = { a: id, e: Date.now() + SESSION_MS };
    const mine = Object.entries(db.sessions).filter(([, s]) => s.a === id).sort((x, y) => x[1].e - y[1].e);
    while (mine.length > 5) delete db.sessions[mine.shift()[0]];
    save();
  }
  return token;
}
const adminAcct = () => ({ id: 'admin', email: '', nick: ADMIN_NICK, role: 'dev' });
function authToken(token) {
  if (typeof token !== 'string' || token.length !== 64) return null;
  const h = sha(token), now = Date.now();
  const ae = adminSessions.get(h); if (ae) { if (ae > now) return adminAcct(); adminSessions.delete(h); return null; }
  const s = db.sessions[h]; if (!s) return null;
  if (s.e < now) { delete db.sessions[h]; save(); return null; }
  return db.accounts[s.a] || null;
}
function logout(token) { if (typeof token !== 'string') return; const h = sha(token); adminSessions.delete(h); if (db.sessions[h]) { delete db.sessions[h]; save(); } }
const publicUser = a => ({ nick: a.nick, role: a.role === 'dev' ? 'dev' : 'player', email: a.role === 'dev' ? '' : maskEmail(a.email) });
function maskEmail(e) { const [u, d] = String(e).split('@'); return (u.slice(0, 2) + '***@' + (d || '')); }

/* ---------- cadastro / login ---------- */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status || 400; } }

async function register(email, password, nick) {
  email = normEmail(email); nick = String(nick || '').trim(); password = String(password || '');
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new ApiError('E-mail inválido.');
  if (password.length < 6 || password.length > 72) throw new ApiError('A senha precisa ter de 6 a 72 caracteres.');
  const np = nickProblem(nick); if (np) throw new ApiError(np);
  if (byEmail.has(email)) throw new ApiError('Esse e-mail já tem conta. Faça login.', 409);
  if (Object.keys(db.accounts).length >= MAX_ACCOUNTS) throw new ApiError('Servidor com limite de contas atingido.', 503);
  const cred = await hashPass(password);
  // revalida depois do await (outro cadastro pode ter entrado no meio)
  if (byEmail.has(email)) throw new ApiError('Esse e-mail já tem conta. Faça login.', 409);
  const np2 = nickProblem(nick); if (np2) throw new ApiError(np2);
  const a = { id: randHex(8), email, nick, salt: cred.salt, hash: cred.hash, role: 'player', created: Date.now(), nickChanges: 0 };
  db.accounts[a.id] = a; byEmail.set(email, a.id); byNick.set(nickKey(nick), a.id);
  const code = null;   // sem código grátis: o nick fica bloqueado e só troca comprando na Loja
  const token = newSession(a.id, false);
  save();
  return { acct: a, code, token };
}

function lockInfo(key) { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; }
function noteFail(key) { const f = fails.get(key) || { n: 0, until: 0 }; if (f.until && f.until < Date.now()) f.n = 0; f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60 * 1000; f.n = 5; } fails.set(key, f); }

async function login(ident, password) {
  ident = String(ident || '').trim(); password = String(password || '');
  if (!ident || ident.length > 254 || password.length > 72) throw new ApiError('Preencha usuário/e-mail e senha.');
  const isAdmin = nickKey(ident) === nickKey(ADMIN_NICK);
  const email = normEmail(ident);
  const key = isAdmin ? 'admin' : 'u:' + email;
  const mins = lockInfo(key);
  if (mins) throw new ApiError('Muitas tentativas erradas. Tente de novo em ' + mins + ' min.', 429);
  const acc = isAdmin ? adminAcct() : db.accounts[byEmail.get(email)];
  const cred = isAdmin ? adminCred : acc || dummyCred;
  const ok = await checkPass(password, cred.salt, cred.hash) && !!acc;
  if (!ok) { noteFail(key); if (isAdmin) await new Promise(r => setTimeout(r, 1000)); throw new ApiError('E-mail/usuário ou senha incorretos.', 401); }
  fails.delete(key);
  return { acct: acc, token: newSession(acc.id, isAdmin) };
}

/* ---------- troca de nick ---------- */
async function redeemNick(acct, codeStr, newNick) {
  if (acct.role === 'dev') throw new ApiError('O nick do desenvolvedor não pode ser trocado.', 403);
  const t = redeemTries.get(acct.id) || { n: 0, t: Date.now() };
  if (Date.now() - t.t > 3600e3) { t.n = 0; t.t = Date.now(); }
  if (t.n >= 10) throw new ApiError('Muitas tentativas. Tente de novo mais tarde.', 429);
  redeemTries.set(acct.id, t);
  newNick = String(newNick || '').trim();
  const raw = normCode(codeStr);
  const c = raw.length === 8 ? db.codes[sha(raw)] : null;
  if (!c || c.u || (c.a && c.a !== acct.id)) { t.n++; throw new ApiError('Código inválido ou já usado.'); }
  if (nickKey(newNick) === nickKey(acct.nick) && newNick === acct.nick) throw new ApiError('Esse já é o seu nick.');
  const np = nickProblem(newNick, acct.id); if (np) throw new ApiError(np);
  c.u = Date.now(); c.by = acct.id; mailCodeUsed(acct.id, raw);
  byNick.delete(nickKey(acct.nick)); acct.nick = newNick; byNick.set(nickKey(newNick), acct.id);
  acct.nickChanges = (acct.nickChanges || 0) + 1; acct.nickChanged = Date.now();
  save();
  return acct;
}

/* ---------- ferramentas do desenvolvedor ---------- */
function adminNewCode(targetEmail) {
  let acct = null;
  if (targetEmail) { acct = db.accounts[byEmail.get(normEmail(targetEmail))]; if (!acct) throw new ApiError('Não há conta com esse e-mail.', 404); }
  const code = issueCode(acct ? acct.id : null);
  if (acct) deliver(acct.id, code);
  return { code, acct };
}
function adminSetNick(current, next) {
  const id = byNick.get(nickKey(current)); const a = id && db.accounts[id];
  if (!a) throw new ApiError('Jogador não encontrado.', 404);
  const np = nickProblem(next, a.id); if (np) throw new ApiError(np);
  byNick.delete(nickKey(a.nick)); a.nick = String(next).trim(); byNick.set(nickKey(a.nick), a.id); save();
  return a;
}
function adminList() {
  return Object.values(db.accounts).sort((x, y) => y.created - x.created).slice(0, 200).map(a => ({ nick: a.nick, email: a.email, created: a.created, trocas: a.nickChanges || 0 }));
}
const accountCount = () => Object.keys(db.accounts).length;

module.exports = { init, ApiError, register, login, logout, authToken, publicUser, redeemNick, shopNickCode, mailList, mailRead, mailDelete, adminMail, adminNewCode, adminSetNick, adminList, accountCount, issueCode, ADMIN_NICK, nickProblem };
  
