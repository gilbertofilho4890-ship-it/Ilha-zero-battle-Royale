/* Ilha Zero - servidor multiplayer (sem dependências). Node 16+.
   Serve o jogo (public/index.html) em "/", contas/login em "/api" e o multiplayer + sinalização de voz em "/ws". */
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const A = require('./accounts'), mailer = require('./mailer');
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10, MAX_ROOMS = 200;
const rooms = new Map();
const online = new Map();   // fid -> conexão (amizades)
const pend = new Map();     // fid -> {reqs:Map, accs:Map} entregues quando ficar online
let nextId = 0;

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

/* ---------- motor 3D servido pelo próprio servidor (sem depender de CDN no celular) ---------- */
const THREE_SRCS = [['cdnjs.cloudflare.com', '/ajax/libs/three.js/r128/three.min.js'], ['cdn.jsdelivr.net', '/npm/three@0.128.0/build/three.min.js'], ['unpkg.com', '/three@0.128.0/build/three.min.js']];
const THREE_PATHS = [path.join(PUBLIC, 'three.min.js'), path.join(DATA_DIR, 'three.min.js')];
let threeBuf = null;
function loadThreeLocal() { for (const f of THREE_PATHS) { try { const b = fs.readFileSync(f); if (b.length > 300000 && b.includes('REVISION')) { threeBuf = b; return true; } } catch (e) {} } return false; }
function dl(host, p, hops) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, path: p, timeout: 20000, headers: { 'User-Agent': 'ilha-zero-server' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 3) { res.resume(); const u = new URL(res.headers.location, 'https://' + host + p); return dl(u.host, u.pathname + u.search, (hops || 0) + 1).then(resolve, reject); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const ch = []; let n = 0; res.on('data', d => { n += d.length; if (n > 5e6) res.destroy(); else ch.push(d); }); res.on('end', () => resolve(Buffer.concat(ch)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
async function ensureThree() {
  if (threeBuf || loadThreeLocal()) return;
  for (const [h, p] of THREE_SRCS) {
    try {
      const b = await dl(h, p);
      if (b.length < 300000 || !b.includes('REVISION')) throw new Error('arquivo inesperado');
      threeBuf = b;
      for (const f of THREE_PATHS) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); break; } catch (e) {} }
      console.log('[three] motor 3D baixado de ' + h + ' e guardado no servidor.'); return;
    } catch (e) { console.warn('[three] falhou em ' + h + ': ' + e.message); }
  }
  console.warn('[three] não consegui baixar o three.js agora; tentarei de novo em 2 min. (ou coloque three.min.js r128 em public/)');
  setTimeout(ensureThree, 120000).unref();
}

/* ---------- API de contas ---------- */
const rl = new Map();
function hit(ip, bucket, max, ms) {
  const k = bucket + '|' + ip, now = Date.now(); let e = rl.get(k);
  if (!e || now - e.t > ms) { e = { n: 0, t: now }; rl.set(k, e); }
  return ++e.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of rl) if (now - e.t > 3600e3) rl.delete(k); }, 600000).unref();
const clientIp = req => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?');
function readJson(req) {
  return new Promise((resolve, reject) => {
    const ch = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > 4096) { reject(new A.ApiError('Pedido grande demais.', 413)); req.destroy(); } else ch.push(d); });
    req.on('end', () => { try { const o = JSON.parse(Buffer.concat(ch).toString('utf8') || '{}'); resolve(o && typeof o === 'object' ? o : {}); } catch (e) { reject(new A.ApiError('JSON inválido.')); } });
    req.on('error', reject);
  });
}
function json(res, status, obj) { const b = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }); res.end(b); }
const bearer = req => { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };
const devMode = () => process.env.DEV_SHOW_CODES === '1';

function refreshNames(acct) {
  for (const c of online.values()) if (c.acct && c.acct.id === acct.id) { c.name = acct.nick; if (c.room) bcast(c.room, roomInfo(c.room)); }
  for (const r of rooms.values()) for (const p of r.players.values()) if (p.acct && p.acct.id === acct.id && p.name !== acct.nick) { p.name = acct.nick; bcast(r, roomInfo(r)); }
}

async function api(req, res, p) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' }); return res.end(); }
  const ip = clientIp(req);
  try {
    if (!hit(ip, 'all', 120, 60000)) throw new A.ApiError('Muitos pedidos. Espere um pouco.', 429);
    if (p === '/api/status' && req.method === 'GET') return json(res, 200, { ok: true, mail: mailer.mailConfigured() });
    if (req.method === 'GET' && p === '/api/me') {
      const a = A.authToken(bearer(req)); if (!a) throw new A.ApiError('Sessão expirada.', 401);
      return json(res, 200, { user: A.publicUser(a) });
    }
    if (req.method !== 'POST') throw new A.ApiError('Não encontrado.', 404);
    const body = await readJson(req);

    if (p === '/api/register') {
      if (!hit(ip, 'reg', 6, 3600e3)) throw new A.ApiError('Muitos cadastros deste aparelho/rede. Tente mais tarde.', 429);
      const r = await A.register(body.email, body.password, body.nick);
      const out = { token: r.token, user: A.publicUser(r.acct) };
      return json(res, 200, out);
    }
    if (p === '/api/login') {
      if (!hit(ip, 'login', 30, 600e3)) throw new A.ApiError('Muitas tentativas. Espere alguns minutos.', 429);
      const r = await A.login(body.id, body.password);
      return json(res, 200, { token: r.token, user: A.publicUser(r.acct) });
    }
    if (p === '/api/logout') { A.logout(bearer(req)); return json(res, 200, { ok: true }); }

    const acct = A.authToken(bearer(req)); if (!acct) throw new A.ApiError('Sessão expirada. Faça login de novo.', 401);

    if (p === '/api/mail') return json(res, 200, { mail: A.mailList(acct) });
    if (p === '/api/mail/read') { A.mailRead(acct, String(body.id || '')); return json(res, 200, { ok: true }); }
    if (p === '/api/mail/del') { A.mailDelete(acct, String(body.id || '')); return json(res, 200, { ok: true }); }

    if (p === '/api/nick/buy') { A.shopNickCode(acct); return json(res, 200, { ok: true }); }

    if (p === '/api/nick') {
      const a = await A.redeemNick(acct, body.code, body.nick);
      refreshNames(a);
      return json(res, 200, { user: A.publicUser(a) });
    }
    if (p.startsWith('/api/admin/')) {
      if (acct.role !== 'dev') throw new A.ApiError('Sem permissão.', 403);
      if (p === '/api/admin/code') {
        const r = A.adminNewCode(body.email);
        let mailed = false;
        if (r.acct) { const m = mailer.codeMail(r.acct.nick, r.code); try { mailed = await mailer.sendMail({ to: r.acct.email, subject: m.subject, text: m.text, html: m.html }); } catch (e) { console.error('[mail] ' + e.message); } }
        return json(res, 200, { code: r.code, forNick: r.acct ? r.acct.nick : null, mailed, inbox: !!r.acct });
      }
      if (p === '/api/admin/mail') return json(res, 200, { ok: true, sent: A.adminMail(String(body.nick || ''), body.title, body.body) });
      if (p === '/api/admin/setnick') { const a = A.adminSetNick(String(body.nick || ''), String(body.newNick || '')); refreshNames(a); return json(res, 200, { ok: true, nick: a.nick }); }
      if (p === '/api/admin/accounts') return json(res, 200, { total: A.accountCount(), list: A.adminList() });
    }
    throw new A.ApiError('Não encontrado.', 404);
  } catch (e) {
    if (e instanceof A.ApiError) return json(res, e.status, { error: e.message });
    console.error('[api] erro:', e); return json(res, 500, { error: 'Erro interno do servidor.' });
  }
}

const server = http.createServer((req, res) => {
  let p; try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); res.end('400'); return; }
  if (p === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (p.startsWith('/api/')) { api(req, res, p); return; }
  if (p === '/three.min.js') {
    const send = b => { res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'public, max-age=86400' }); res.end(b); };
    if (threeBuf || loadThreeLocal()) return send(threeBuf);
    ensureThree().then(() => threeBuf ? send(threeBuf) : (res.writeHead(404), res.end('404')));
    return;
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end('403'); return; }
  fs.readFile(file, (e, d) => {
    if (e) { res.writeHead(404); res.end(p === '/index.html' ? 'public/index.html nao encontrado' : '404'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.end(d);
  });
});

/* ---------- WebSocket mínimo ---------- */
function frame(op, payload) {
  const n = payload.length;
  let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  return Buffer.concat([h, payload]);
}
function sendRaw(c, str) { if (c.sock.destroyed || !c.open) return; try { c.sock.write(frame(1, Buffer.from(str))); } catch (e) {} }
function send(c, obj) { sendRaw(c, JSON.stringify(obj)); }

function parse(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2) !== 0) { c.sock.destroy(); return; } len = b.readUInt32BE(6); off = 10; }
    if (len > 16384) { c.sock.destroy(); return; }
    if (!masked) { c.sock.destroy(); return; }
    if (b.length < off + 4 + len) return;
    const mask = b.slice(off, off + 4), data = Buffer.from(b.slice(off + 4, off + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    c.buf = b.slice(off + 4 + len);
    if (op === 8) { try { c.sock.write(frame(8, Buffer.alloc(0))); } catch (e) {} c.sock.end(); return; }
    if (op === 9) { try { c.sock.write(frame(10, data)); } catch (e) {} continue; }
    if (op === 1 || op === 0) {
      c.msg = (op === 1 ? '' : (c.msg || '')) + data.toString('utf8');
      if (c.msg.length > 16384) { c.sock.destroy(); return; }
      if (fin) { const m = c.msg; c.msg = ''; onMessage(c, m); }
    }
  }
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!/^\/ws/.test(req.url) || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, id: ++nextId, buf: Buffer.alloc(0), room: null, name: 'Jogador', open: true, playing: false, cnt: 0, cntT: Date.now() };
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > 65536) { sock.destroy(); return; } parse(c); });
  sock.on('close', () => { c.open = false; if (c.fid && online.get(c.fid) === c) online.delete(c.fid); leave(c); });
  sock.on('error', () => {});
});

/* ---------- salas ---------- */
const clean = (s, n) => String(s || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, n);
function listPlayers(r) { return [...r.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, dev: p.acct && p.acct.role === 'dev' ? 1 : 0 })); }
function balance(r) { let i = 0; for (const p of r.players.values()) p.team = i++ % 2; }
function smallerTeam(r) { let a = 0, b = 0; for (const p of r.players.values()) { if (p.team === 0) a++; else b++; } return a <= b ? 0 : 1; }
const okFid = f => typeof f === 'string' && /^[A-Z0-9]{6,12}$/.test(f);
function pendFor(f) { let p = pend.get(f); if (!p) { p = { reqs: new Map(), accs: new Map() }; pend.set(f, p); } return p; }
function bcast(r, obj, except) { const s = JSON.stringify(obj); for (const p of r.players.values()) if (p !== except) sendRaw(p, s); }
function roomInfo(r) { return { t: 'pl', host: r.host, mode: r.mode, players: listPlayers(r), started: [...r.players.values()].some(p => p.playing) }; }

function leave(c) {
  const r = c.room; if (!r) return;
  r.players.delete(c.id); c.room = null; c.playing = false;
  if (!r.players.size) { rooms.delete(r.name); return; }
  if (r.host === c.id) r.host = Math.min(...r.players.keys());
  bcast(r, { t: 'left', id: c.id });
  bcast(r, roomInfo(r));
}

function onMessage(c, raw) {
  const now = Date.now();
  if (now - c.cntT > 1000) { c.cntT = now; c.cnt = 0; }
  if (++c.cnt > 150) return;
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') {
    const a = A.authToken(m.token);
    c.acct = a || { id: 'g' + c.id, nick: clean(m.name, 14) || 'Jogador', role: 'player', guest: true };   // sem conta: entra como convidado com o nick do lobby
  }
  if (!c.acct) { if (m.t === 'join') send(c, { t: 'err', m: 'Faça login para jogar online.' }); return; }
  if (m.t === 'join') {
    if (c.room) return;
    const name = clean(m.room, 16).toUpperCase() || 'PUBLICA';
    let r = rooms.get(name);
    if (!r) {
      if (rooms.size >= MAX_ROOMS) return send(c, { t: 'err', m: 'Servidor cheio de salas.' });
      r = { name, players: new Map(), host: c.id, mode: m.mode === 'team' ? 'team' : 'solo' }; rooms.set(name, r);
    }
    if (r.players.size >= (r.mode === 'team' ? 6 : MAX_PLAYERS)) return send(c, { t: 'err', m: 'Sala cheia (máx. ' + (r.mode === 'team' ? 6 : MAX_PLAYERS) + ').' });
    if ([...r.players.values()].some(p => p.playing)) return send(c, { t: 'err', m: 'Partida em andamento nessa sala. Espere acabar.' });
    c.name = c.acct.nick; c.team = smallerTeam(r); c.room = r; r.players.set(c.id, c);
    send(c, { t: 'welcome', id: c.id, room: r.name });
    bcast(r, roomInfo(r));
    return;
  }
  if (m.t === 'hello') {
    if (!okFid(m.fid)) return;
    const old = online.get(m.fid); if (old && old !== c) { try { old.sock.destroy(); } catch (e) {} }
    c.fid = m.fid; c.name = c.acct.nick; online.set(c.fid, c);
    const p = pend.get(c.fid);
    if (p) { for (const [f, n] of p.reqs) send(c, { t: 'freq', from: f, name: n }); for (const [f, n] of p.accs) send(c, { t: 'facc', from: f, name: n }); pend.delete(c.fid); }
    return;
  }
  if (m.t === 'freq' || m.t === 'facc' || m.t === 'fdel' || m.t === 'fq' || m.t === 'inv') {
    if (!c.fid) return;
    if (m.t === 'fq') {
      const on = [], rooms2 = {};
      for (const f of (Array.isArray(m.list) ? m.list.slice(0, 100) : [])) { const o = okFid(f) && online.get(f); if (o) { on.push(f); if (o.room) rooms2[f] = o.room.name; } }
      return send(c, { t: 'fst', on, rooms: rooms2 });
    }
    if (!okFid(m.to) || m.to === c.fid) return send(c, { t: 'fres', m: 'Código inválido.' });
    const o = online.get(m.to);
    if (m.t === 'freq') {
      if (o) send(o, { t: 'freq', from: c.fid, name: c.name });
      else { const p = pendFor(m.to); if (p.reqs.size < 50) p.reqs.set(c.fid, c.name); if (pend.size > 5000) pend.delete(pend.keys().next().value); }
      return send(c, { t: 'fres', m: o ? 'Pedido enviado!' : 'Pedido enviado. Será entregue quando esse jogador entrar online.' });
    }
    if (m.t === 'facc') { if (o) send(o, { t: 'facc', from: c.fid, name: c.name }); else pendFor(m.to).accs.set(c.fid, c.name); return; }
    if (m.t === 'fdel') { if (o) send(o, { t: 'fdel', from: c.fid }); return; }
    if (m.t === 'inv') { if (o && c.room) send(o, { t: 'inv', from: c.fid, name: c.name, room: c.room.name, mode: c.room.mode }); return; }
  }
  const r = c.room; if (!r) return;
  switch (m.t) {
    case 'leave': leave(c); break;
    case 'mode': {
      if (r.host !== c.id || [...r.players.values()].some(p => p.playing)) return;
      const nm = m.m === 'team' ? 'team' : 'solo';
      if (nm === 'team' && r.players.size > 6) return send(c, { t: 'err2', m: 'Máximo de 6 jogadores no 3 contra 3.' });
      r.mode = nm; balance(r); bcast(r, roomInfo(r)); break;
    }
    case 'team': {
      if (r.mode !== 'team' || c.playing) return;
      const t = m.team ? 1 : 0; let n = 0; for (const p of r.players.values()) if (p !== c && p.team === t) n++;
      if (n >= 3) return send(c, { t: 'err2', m: 'Esse time já tem 3 jogadores.' });
      c.team = t; bcast(r, roomInfo(r)); break;
    }
    case 's': { m.id = c.id; bcast(r, m, c); break; }
    case 'hit': { const to = r.players.get(m.to); if (to) send(to, { t: 'hit', from: c.id, d: Math.max(0, Math.min(200, +m.d || 0)), h: m.h ? 1 : 0 }); break; }
    case 'dead': bcast(r, { t: 'dead', id: c.id, by: m.by | 0 }, c); break;
    case 'pk': bcast(r, { t: 'pk', x: +m.x || 0, z: +m.z || 0 }, c); break;
    case 'sig': { const to = r.players.get(m.to); if (to && m.d) send(to, { t: 'sig', from: c.id, d: m.d }); break; }
    case 'start': {
      if (r.host !== c.id) return;
      if ([...r.players.values()].some(p => p.playing)) return;
      if (r.mode === 'team') { let a = 0, b = 0; for (const p of r.players.values()) { if (p.team === 0) a++; else b++; } if (!a || !b) return send(c, { t: 'err2', m: 'Precisa de pelo menos 1 jogador em cada time.' }); }
      const seed = Math.floor(Math.random() * 2147483647);
      for (const p of r.players.values()) p.playing = true;
      const teams = {}; for (const p of r.players.values()) teams[p.id] = p.team;
      bcast(r, { t: 'start', seed, ids: [...r.players.keys()], mode: r.mode, teams });
      break;
    }
    case 'end': c.playing = false; bcast(r, roomInfo(r)); break;
  }
}

/* mantém conexões vivas em hospedagens com timeout de ociosidade */
setInterval(() => { for (const r of rooms.values()) for (const p of r.players.values()) { try { p.sock.write(frame(9, Buffer.alloc(0))); } catch (e) {} } }, 25000);

A.init().then(() => {
  server.listen(PORT, () => console.log('Ilha Zero online na porta ' + PORT));
  if (!mailer.mailConfigured()) console.warn('[mail] Nenhum provedor de e-mail configurado (RESEND_API_KEY, BREVO_API_KEY ou SMTP_HOST + MAIL_FROM). Os códigos serão apenas escritos no log do servidor.');
  ensureThree();
}).catch(e => { console.error('Falha ao iniciar:', e); process.exit(1); });
  
