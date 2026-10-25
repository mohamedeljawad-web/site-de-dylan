// =========================================================
//  ⚽ FOOTBALL — serveur du jeu (comptes, salons, tournois, matchs 1v1 / 2v2)
//  Lancer :  node "final foot3.js"   (aucune installation nécessaire, juste Node.js)
//
//  Réglages facultatifs (variables d'environnement, sur Render : onglet "Environment") :
//    CREATEUR                  -> ton nom d'utilisateur : ce compte est le créateur du jeu 👑
//    UPSTASH_REDIS_REST_URL    -> pour garder les comptes pour toujours (base de données gratuite Upstash)
//    UPSTASH_REDIS_REST_TOKEN  -> le mot de passe de cette base de données
//  Sans Upstash, les comptes sont rangés dans le fichier comptes.json à côté de ce fichier.
// =========================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ---------- le "package.json" est rangé ici (plus besoin d'un 2e fichier) ----------
   Pour l'hébergement (Render) : Build Command = node "final foot3.js" --prepare */
const PACKAGE_JSON = {
  name: "football",
  version: "2.0.0",
  description: "Football : Coupe du Monde et Champions League, hors ligne et en ligne",
  main: path.basename(__filename),
  scripts: { start: "node " + path.basename(__filename) },
  engines: { node: ">=18" },
};
if (process.argv.includes("--prepare")) {
  fs.writeFileSync(path.join(__dirname, "package.json"), JSON.stringify(PACKAGE_JSON, null, 2) + "\n");
  console.log("✅ package.json créé : tout est prêt.");
  process.exit(0);
}

/* ---------- mini WebSocket (connexion en direct navigateur <-> serveur) ---------- */
class MiniSocket {
  constructor(socket) {
    this.socket = socket; this.readyState = 1; this.buf = Buffer.alloc(0); this.frags = [];
    this.handlers = { message: [], close: [] };
    socket.on("data", d => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this.parse(); });
    socket.on("close", () => this.closed());
    socket.on("error", () => this.closed());
  }
  on(ev, fn) { this.handlers[ev].push(fn); }
  closed() { if (this.readyState === 3) return; this.readyState = 3; this.handlers.close.forEach(f => f()); }
  parse() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1e6) return this.socket.destroy();
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let data = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4), out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3];
        data = out;
      }
      this.buf = this.buf.subarray(need);
      if (op === 8) { this.socket.end(); return this.closed(); }                 // fermeture
      if (op === 9) { this.frame(10, data); continue; }                           // ping -> pong
      if (op === 10) continue;                                                    // pong
      if (op === 1 || op === 2 || op === 0) {
        this.frags.push(data);
        if (fin) { const msg = Buffer.concat(this.frags).toString("utf8"); this.frags = []; this.handlers.message.forEach(f => f(msg)); }
      }
    }
  }
  frame(op, payload) {
    if (this.readyState !== 1) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([head, payload])); } catch (e) { this.closed(); }
  }
  send(str) { this.frame(1, Buffer.from(str, "utf8")); }
  ping() { this.frame(9, Buffer.alloc(0)); }
}

const PORT = process.env.PORT || 3000;

/* ---------- équipes (même ordre que TEAMS dans la page du jeu) ---------- */
const POOLS = {
  cdm: [...Array(32).keys()],                 // 0..31  : les 32 nations de la Coupe du monde 2026
  cl: [...Array(16).keys()].map(i => 32 + i),  // 32..47 : les 16 clubs des huitièmes de la Champions League
};
const SPECIALS = [48, 49];                     // 48 : Napoléon FC, 49 : Dylan FC (équipes spéciales du créateur)
const SPECIAL_NAMES = { 48: "Napoléon FC", 49: "Dylan FC" };
const NB_TEAMS = 50;
const STAGE_NAMES = ["Finale", "Demi-finales", "Quarts de finale", "Huitièmes de finale", "Seizièmes de finale"];

/* =========================================================
   COMPTES : nom d'utilisateur unique + mot de passe (chiffré)
   ========================================================= */
const CREATEUR = (process.env.CREATEUR || "").trim().toLowerCase();
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
const UP_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const USE_UPSTASH = !!(UP_URL && UP_TOKEN);
const DB_FILE = path.join(__dirname, "comptes.json");
const users = new Map();            // clé (nom en minuscules) -> compte
let dbReady = false;

async function upstash(cmd) {
  const r = await fetch(UP_URL, { method: "POST", headers: { Authorization: "Bearer " + UP_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function loadUsers() {
  if (USE_UPSTASH) {
    try {
      const arr = (await upstash(["HGETALL", "foot:users"])) || [];
      for (let i = 0; i + 1 < arr.length; i += 2) { try { const u = JSON.parse(arr[i + 1]); users.set(u.key, fixUser(u)); } catch (e) {} }
      dbReady = true;
      console.log(`💾 Comptes : base Upstash (${users.size} compte(s))`);
    } catch (e) {
      console.log("⚠️  Upstash injoignable (" + e.message + "), nouvel essai dans 10 s");
      setTimeout(loadUsers, 10000);
    }
    return;
  }
  try { for (const u of JSON.parse(fs.readFileSync(DB_FILE, "utf8"))) users.set(u.key, fixUser(u)); } catch (e) {}
  dbReady = true;
  console.log(`💾 Comptes : fichier comptes.json (${users.size} compte(s))`);
}
const newStats = () => ({ played: 0, won: 0, lost: 0, gf: 0, ga: 0, cdm: 0, cl: 0, online: 0, friendly: 0 });
function fixUser(u) {
  u.stats = Object.assign(newStats(), u.stats || {});
  u.specials = (u.specials || []).filter(t => SPECIALS.includes(t));
  u.tokens = u.tokens || [];
  u.role = u.role || "joueur";
  u.friends = u.friends || [];       // clés des amis
  u.reqIn = u.reqIn || [];           // demandes d'amis reçues
  u.reqOut = u.reqOut || [];         // demandes d'amis envoyées
  u.powers = !!u.powers;             // panneau de pouvoirs pendant les matchs (donné par le créateur)
  u.banned = !!u.banned;             // compte banni par le créateur
  return u;
}
// sauvegarde (regroupée pour ne pas écrire 50 fois par seconde)
const dirty = new Set();
let saveTimer = null;
function saveUser(u) {
  dirty.add(u.key);
  if (!saveTimer) saveTimer = setTimeout(flushSaves, 800);
}
async function flushSaves() {
  saveTimer = null;
  const keys = [...dirty]; dirty.clear();
  if (USE_UPSTASH) {
    const cmd = ["HSET", "foot:users"];
    for (const k of keys) { const u = users.get(k); if (u) cmd.push(k, JSON.stringify(u)); }
    if (cmd.length > 2) {
      try { await upstash(cmd); }
      catch (e) { console.log("⚠️  Sauvegarde Upstash ratée, nouvel essai :", e.message); keys.forEach(k => dirty.add(k)); if (!saveTimer) saveTimer = setTimeout(flushSaves, 5000); }
    }
  } else {
    try { fs.writeFileSync(DB_FILE, JSON.stringify([...users.values()])); } catch (e) { console.log("⚠️  Impossible d'écrire comptes.json :", e.message); }
  }
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const keyOf = n => String(n || "").normalize("NFC").trim().toLowerCase();
const NAME_RE = /^[A-Za-z0-9À-ÖØ-öø-ÿ_.-]{3,16}$/;

function checkCreator(u) {
  if (CREATEUR) {
    if (u.key === CREATEUR && u.role !== "createur") { u.role = "createur"; saveUser(u); }
    if (u.key !== CREATEUR && u.role === "createur") { u.role = "joueur"; saveUser(u); }
  }
}
const isCreator = u => !!u && u.role === "createur";
const isAdmin = u => !!u && (u.role === "createur" || u.role === "admin");
const ownedSpecials = u => !u ? [] : isCreator(u) ? SPECIALS.slice() : u.specials.slice();
const hasPowers = u => !!u && (u.role === "createur" || u.powers);
const publicUser = u => ({ name: u.name, role: u.role, specials: ownedSpecials(u), stats: u.stats, created: u.created, powers: hasPowers(u), banned: u.banned });
function newToken(u) {
  const tok = crypto.randomBytes(24).toString("hex");
  u.tokens.push(sha(tok));
  if (u.tokens.length > 8) u.tokens.splice(0, u.tokens.length - 8);
  saveUser(u);
  return tok;
}
function recordMatch(u, gf, ga, won, kind) {
  if (!u) return;
  const s = u.stats;
  s.played++; if (won) s.won++; else s.lost++;
  s.gf += gf; s.ga += ga;
  if (won && kind === "online") s.online++;
  if (won && kind === "friendly") { s.friendly++; s.online++; }
  saveUser(u); pushMe(u);
}
function recordTrophy(u, comp) {
  if (!u) return;
  if (comp === "cl") u.stats.cl++; else u.stats.cdm++;
  saveUser(u); pushMe(u);
}

/* ---------- serveur web : envoie la page du jeu ---------- */
const server = http.createServer((req, res) => {
  let p = "/";
  try { p = decodeURIComponent((req.url || "/").split("?")[0]); } catch (e) {}
  if (p === "/" || p === "/index.html" || p === "/jeu" || p === "/jeu/") {
    let page;
    try { page = typeof PAGE !== "undefined" ? PAGE : fs.readFileSync(path.join(__dirname, "index.html"), "utf8"); }
    catch (e) { res.writeHead(500); return res.end("Page du jeu introuvable"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(page);
  }
  if (p === "/accueil.jpg") {          // photo d'accueil facultative : accueil.jpg dans le même dossier
    return fs.readFile(path.join(__dirname, "accueil.jpg"), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(data);
    });
  }
  if (p === "/sante") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Page introuvable");
});

/* ---------- connexions ---------- */
const connectionHandlers = [];
const wss = { on: (ev, fn) => connectionHandlers.push(fn) };
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key || (req.headers.upgrade || "").toLowerCase() !== "websocket") return socket.destroy();
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
               `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const ws = new MiniSocket(socket);
  connectionHandlers.forEach(f => f(ws));
});
const clients = new Map();   // id -> { id, ws, name, user, room, watching }
const rooms = new Map();     // code -> salon
let nextId = 1;
// ping régulier : garde la connexion ouverte chez l'hébergeur
setInterval(() => { for (const c of clients.values()) c.ws.ping(); }, 25000);

const send = (c, msg) => { if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); };
const clean = (s, n) => String(s || "").replace(/[<>&"']/g, "").trim().slice(0, n);
function pushMe(u) {                       // envoie au joueur ses infos à jour (rôle, équipes, stats)
  for (const c of clients.values()) if (c.user === u) send(c, { t: "me", user: publicUser(u) });
}
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do { c = ""; for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)]; } while (rooms.has(c));
  return c;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function poisson(l) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; }
function simShootout() {
  let a = 0, b = 0;
  for (let i = 0; i < 5; i++) { if (Math.random() < .75) a++; if (Math.random() < .75) b++; }
  while (a === b) { if (Math.random() < .75) a++; if (Math.random() < .75) b++; }
  return [a, b];
}
function simMatch() {
  const a = poisson(1.3), b = poisson(1.3);
  if (a !== b) return { a, b };
  const [pa, pb] = simShootout();
  return { a, b, pa, pb, et: true };
}
const winsFirst = s => s.a > s.b || (s.a === s.b && s.pa > s.pb);
const validTeam = (c, team, mode) => (POOLS[mode] || []).includes(team) || ownedSpecials(c.user).includes(team);

/* ---------- salons ---------- */
const isMatchRoom = r => r.type === "1v1" || r.type === "2v2";
const perSide = r => r.type === "2v2" ? 2 : 1;
function roomView(r) {
  return {
    code: r.code, name: r.name, host: r.host, public: r.public, maxPlayers: r.maxPlayers, type: r.type, mode: r.mode,
    numTeams: r.numTeams, diff: r.diff, state: r.state, sideTeam: r.sideTeam,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, side: p.side, role: p.role })),
  };
}
function publicList() {
  return [...rooms.values()]
    .filter(r => r.public && r.state === "lobby" && r.players.size < r.maxPlayers)
    .map(r => ({ code: r.code, name: r.name, players: r.players.size, maxPlayers: r.maxPlayers, numTeams: r.numTeams, diff: r.diff, type: r.type, mode: r.mode }));
}
function broadcastList() {
  const list = publicList();
  for (const c of clients.values()) if (c.watching) send(c, { t: "rooms", rooms: list });
}
function broadcastRoom(r) {
  const v = roomView(r);
  for (const p of r.players.values()) send(clients.get(p.id), { t: "room", room: v });
}
function toRoom(r, msg) { for (const p of r.players.values()) send(clients.get(p.id), msg); }
function freeSide(r) {
  const n = { A: 0, B: 0 };
  for (const p of r.players.values()) if (p.side) n[p.side]++;
  return n.A <= n.B ? (n.A < perSide(r) ? "A" : n.B < perSide(r) ? "B" : null) : (n.B < perSide(r) ? "B" : n.A < perSide(r) ? "A" : null);
}

function leaveRoom(c) {
  const r = rooms.get(c.room);
  c.room = null;
  if (!r) return;
  const pl = r.players.get(c.id);
  r.players.delete(c.id);
  if (r.players.size === 0) { clearTimeout(r.roundTimer); rooms.delete(r.code); broadcastList(); return; }
  if (r.host === c.id) r.host = r.players.keys().next().value;           // nouvel hôte
  toRoom(r, { t: "left", id: c.id, name: pl ? pl.name : "" });
  if (r.state === "playing" && r.tour && pl && pl.team != null) playerGone(r, pl.team);
  if (r.match && r.match.hum.some(h => h.id === c.id)) {
    if (r.match.host === c.id || r.match.hum.filter(h => h.id !== c.id && h.team === r.match.hum.find(x => x.id === c.id).team).length === 0) {
      // l'hôte du match (ou toute une équipe) est parti : le match s'arrête
      r.match = null; r.state = "lobby";
      toRoom(r, { t: "fabort", msg: `${pl ? pl.name : "Un joueur"} a quitté le match.` });
    }
  }
  if (isMatchRoom(r) && r.state === "lobby") {
    for (const s of ["A", "B"]) if (![...r.players.values()].some(p => p.side === s)) r.sideTeam[s] = null;
  }
  broadcastRoom(r);
  broadcastList();
}

/* ---------- tournoi ---------- */
function ownerOf(r, team) {
  for (const p of r.players.values()) if (p.team === team) return p.id;
  return null;
}
function startTournament(r) {
  const humans = [...r.players.values()].map(p => p.team);
  const others = shuffle(POOLS[r.mode].filter(t => !humans.includes(t)));
  const teams = shuffle([...humans, ...others.slice(0, r.numTeams - humans.length)]);
  const nRounds = Math.round(Math.log2(r.numTeams));
  r.tour = {
    stages: STAGE_NAMES.slice(0, nRounds).reverse(),
    rounds: [teams], scores: [], stage: 0, matches: [], champion: null,
  };
  r.state = "playing";
  startRound(r);
  broadcastList();
}
function startRound(r) {
  const T = r.tour, teams = T.rounds[T.stage];
  T.scores[T.stage] = [];
  T.matches = [];
  for (let m = 0; m < teams.length / 2; m++) {
    const a = teams[2 * m], b = teams[2 * m + 1];
    const pa = ownerOf(r, a), pb = ownerOf(r, b);
    const mt = { a, b, pa, pb, type: pa && pb ? "live" : (pa || pb ? "bot" : "sim"), done: false };
    if (mt.type === "sim") { T.scores[T.stage][m] = simMatch(); mt.done = true; }
    T.matches.push(mt);
  }
  sendTour(r);
  checkRoundEnd(r);
}
function sendTour(r) {
  const T = r.tour;
  const humans = {};
  for (const p of r.players.values()) if (p.team != null) humans[p.team] = { id: p.id, name: p.name, role: p.role, pw: hasPowers(userOfId(p.id)) };
  toRoom(r, { t: "tour", tour: { stages: T.stages, rounds: T.rounds, scores: T.scores, stage: T.stage, matches: T.matches, champion: T.champion, humans, diff: r.diff, mode: r.mode } });
}
function userOfId(id) { const c = clients.get(id); return c ? c.user : null; }
function setResult(r, m, res) {
  const T = r.tour, mt = T.matches[m];
  if (!mt || mt.done) return;
  T.scores[T.stage][m] = res;
  mt.done = true;
  if (!res.ff) {                                        // statistiques des vrais joueurs
    const w = winsFirst(res);
    if (mt.pa) recordMatch(userOfId(mt.pa), res.a, res.b, w, mt.type === "live" ? "online" : "bot");
    if (mt.pb) recordMatch(userOfId(mt.pb), res.b, res.a, !w, mt.type === "live" ? "online" : "bot");
  }
  sendTour(r);
  checkRoundEnd(r);
}
function checkRoundEnd(r) {
  const T = r.tour;
  if (r.roundTimer || T.champion != null || !T.matches.every(m => m.done)) return;
  const teams = T.rounds[T.stage], next = [];
  for (let m = 0; m < teams.length / 2; m++) next.push(winsFirst(T.scores[T.stage][m]) ? teams[2 * m] : teams[2 * m + 1]);
  if (next.length === 1) {
    T.champion = next[0];
    const owner = ownerOf(r, T.champion);
    if (owner) recordTrophy(userOfId(owner), r.mode);
    sendTour(r);
    return;
  }
  // petite pause pour que tout le monde voie les résultats, puis tour suivant
  r.roundTimer = setTimeout(() => {
    r.roundTimer = null;
    if (!rooms.has(r.code)) return;
    T.rounds[T.stage + 1] = next;
    T.stage++;
    startRound(r);
  }, 4000);
}
// un joueur quitte pendant le tournoi : son match en cours est perdu par forfait ou simulé
function playerGone(r, team) {
  const T = r.tour;
  T.matches.forEach((mt, m) => {
    if (mt.done || (mt.a !== team && mt.b !== team)) return;
    if (mt.type === "live") setResult(r, m, mt.a === team ? { a: 0, b: 3, ff: true } : { a: 3, b: 0, ff: true });
    else setResult(r, m, simMatch());
  });
}

/* ---------- messages ---------- */
const AUTH_FREE = new Set(["register", "login", "resume", "logout", "profile"]);
wss.on("connection", ws => {
  const c = { id: "p" + (nextId++), ws, name: "Joueur", user: null, room: null, watching: false, fails: 0, lockUntil: 0, statT: 0, trophyT: 0, allow: new Set(), playing: false };
  clients.set(c.id, c);
  send(c, { t: "hello", id: c.id, store: USE_UPSTASH ? "upstash" : "fichier" });

  const login = (u, tok) => {
    checkCreator(u);
    c.user = u; c.name = u.name;
    send(c, { t: "auth", user: publicUser(u), token: tok || newToken(u) });
    sendFriends(c);
    notifyFriends(u);
  };

  ws.on("message", raw => {
    // relais rapide entre joueurs d'un même salon : "@id1,id2|données" (le serveur ne lit pas les données)
    if (raw.charCodeAt(0) === 64) {
      if (!c.user) return;
      const bar = raw.indexOf("|");
      if (bar < 0) return;
      const out = "@" + c.id + raw.slice(bar);
      const ids = raw.slice(1, bar).split(",");
      for (let i = 0; i < ids.length && i < 40; i++) {
        const to = clients.get(ids[i]);
        if (!to || to === c || to.ws.readyState !== 1) continue;
        // même salon, amis, ou spectateur autorisé
        if ((c.room && to.room === c.room) || c.allow.has(to.id) || to.allow.has(c.id) || areFriends(c.user, to.user)) to.ws.send(out);
      }
      return;
    }
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    if (!c.user && !AUTH_FREE.has(m.t)) return send(c, { t: "error", msg: "Connecte-toi d'abord à ton compte." });
    const r = c.room ? rooms.get(c.room) : null;
    switch (m.t) {
      /* ----- comptes ----- */
      case "register": {
        if (!dbReady) return send(c, { t: "authfail", msg: "Le serveur démarre, réessaie dans quelques secondes." });
        const name = String(m.name || "").normalize("NFC").trim();
        if (!NAME_RE.test(name)) return send(c, { t: "authfail", msg: "Nom : 3 à 16 lettres ou chiffres (sans espace)." });
        if (String(m.pw || "").length < 4) return send(c, { t: "authfail", msg: "Mot de passe : au moins 4 caractères." });
        const key = keyOf(name);
        if (users.has(key)) return send(c, { t: "authfail", msg: "Ce nom d'utilisateur est déjà pris, choisis-en un autre." });
        const salt = crypto.randomBytes(16).toString("hex");
        const first = users.size === 0;
        const u = fixUser({ key, name, salt, hash: hashPw(m.pw, salt), role: (CREATEUR ? key === CREATEUR : first) ? "createur" : "joueur", specials: [], created: Date.now(), tokens: [] });
        users.set(key, u);
        saveUser(u);
        console.log(`👤 Nouveau compte : ${name}${u.role === "createur" ? " (créateur 👑)" : ""}`);
        login(u);
        break;
      }
      case "login": {
        if (!dbReady) return send(c, { t: "authfail", msg: "Le serveur démarre, réessaie dans quelques secondes." });
        if (Date.now() < c.lockUntil) return send(c, { t: "authfail", msg: "Trop d'essais. Attends 30 secondes." });
        const u = users.get(keyOf(m.name));
        if (!u || hashPw(m.pw || "", u.salt) !== u.hash) {
          if (++c.fails >= 6) { c.fails = 0; c.lockUntil = Date.now() + 30000; }
          return send(c, { t: "authfail", msg: "Nom d'utilisateur ou mot de passe incorrect." });
        }
        c.fails = 0;
        if (u.banned) return send(c, { t: "authfail", msg: "🚫 Ce compte a été banni par le créateur du jeu." });
        login(u);
        break;
      }
      case "resume": {
        if (!dbReady) return send(c, { t: "authwait" });
        const h = sha(String(m.token || ""));
        const u = [...users.values()].find(x => x.tokens.includes(h));
        if (!u) return send(c, { t: "authfail", msg: "", silent: true });
        if (u.banned) return send(c, { t: "authfail", msg: "🚫 Ce compte a été banni par le créateur du jeu.", silent: true, banned: true });
        login(u, m.token);
        break;
      }
      case "logout": {
        if (c.user) { const h = sha(String(m.token || "")); c.user.tokens = c.user.tokens.filter(x => x !== h); saveUser(c.user); }
        if (c.room) leaveRoom(c);
        c.user = null; c.name = "Joueur";
        break;
      }
      case "profile": {
        const u = users.get(keyOf(m.name));
        if (!u) return send(c, { t: "error", msg: "Joueur introuvable." });
        const online = [...clients.values()].some(x => x.user === u);
        send(c, { t: "profile", p: Object.assign(publicUser(u), { online }) });
        break;
      }
      case "stat": {         // résultats des matchs hors ligne (contre les bots)
        const now = Date.now();
        const n = v => Math.max(0, Math.min(30, Math.floor(+v || 0)));
        if (m.k === "match" && now - c.statT > 15000) { c.statT = now; recordMatch(c.user, n(m.gf), n(m.ga), !!m.won, "bot"); }
        if (m.k === "trophy" && now - c.trophyT > 60000) { c.trophyT = now; recordTrophy(c.user, m.comp === "cl" ? "cl" : "cdm"); }
        break;
      }

      /* ----- amis ----- */
      case "friends": sendFriends(c); break;
      case "friend": {
        const me = c.user, other = users.get(keyOf(m.name));
        if (!other) return send(c, { t: "error", msg: "Aucun joueur avec ce nom." });
        if (other === me) return send(c, { t: "error", msg: "Tu ne peux pas être ton propre ami 😄" });
        const rm = (arr, k) => { const i = arr.indexOf(k); if (i >= 0) arr.splice(i, 1); };
        if (m.op === "add") {
          if (me.friends.includes(other.key)) return send(c, { t: "toast", msg: `${other.name} est déjà ton ami.` });
          if (me.reqIn.includes(other.key)) {           // il m'avait déjà demandé : on devient amis
            rm(me.reqIn, other.key); rm(other.reqOut, me.key);
            me.friends.push(other.key); other.friends.push(me.key);
            send(c, { t: "toast", msg: `🤝 Toi et ${other.name} êtes maintenant amis !` });
          } else if (!me.reqOut.includes(other.key)) {
            if (other.reqIn.length > 100) return send(c, { t: "error", msg: "Ce joueur a trop de demandes." });
            me.reqOut.push(other.key); other.reqIn.push(me.key);
            send(c, { t: "toast", msg: `Demande d'ami envoyée à ${other.name} 📨` });
            for (const x of clients.values()) if (x.user === other) send(x, { t: "toast", msg: `📨 ${me.name} veut être ton ami !` });
          } else send(c, { t: "toast", msg: "Demande déjà envoyée." });
        } else if (m.op === "accept") {
          if (!me.reqIn.includes(other.key)) return;
          rm(me.reqIn, other.key); rm(other.reqOut, me.key);
          if (!me.friends.includes(other.key)) me.friends.push(other.key);
          if (!other.friends.includes(me.key)) other.friends.push(me.key);
          for (const x of clients.values()) if (x.user === other) send(x, { t: "toast", msg: `🤝 ${me.name} a accepté ta demande d'ami !` });
        } else if (m.op === "refuse") { rm(me.reqIn, other.key); rm(other.reqOut, me.key); }
        else if (m.op === "remove") { rm(me.friends, other.key); rm(other.friends, me.key); rm(me.reqOut, other.key); rm(other.reqIn, me.key); }
        saveUser(me); saveUser(other);
        sendFriends(c);
        for (const x of clients.values()) if (x.user === other) sendFriends(x);
        break;
      }
      case "status": {         // en train de jouer un match (pour les amis et les spectateurs)
        const p = !!m.playing;
        if (p !== c.playing) { c.playing = p; notifyFriends(c.user); }
        break;
      }
      case "allow": { const id = String(m.id || ""); if (clients.has(id)) c.allow.add(id); break; }   // un spectateur peut recevoir mon match

      /* ----- commandes du créateur et des admins ----- */
      case "admin": {
        const me = c.user;
        if (!isAdmin(me)) return send(c, { t: "error", msg: "Réservé aux admins." });
        const target = m.name ? users.get(keyOf(m.name)) : null;
        const ok = msg => { send(c, { t: "toast", msg }); sendAdminList(c); };
        if (m.op === "list") return sendAdminList(c);
        if (m.op === "broadcast") {                 // message du créateur à tout le monde, même en plein match
          if (!isCreator(me)) return send(c, { t: "error", msg: "Seul le créateur peut faire ça." });
          const msg = String(m.msg || "").replace(/[<>]/g, "").trim().slice(0, 200);
          if (!msg) return;
          let n = 0;
          for (const x of clients.values()) { send(x, { t: "global", from: me.name, msg }); n++; }
          console.log(`📢 Message global de ${me.name} : ${msg}`);
          return send(c, { t: "toast", msg: `📢 Message envoyé à ${n} joueur(s) connecté(s)` });
        }
        if (!target) return send(c, { t: "error", msg: "Joueur introuvable." });
        if (m.op === "kick") {
          if (isCreator(target)) return send(c, { t: "error", msg: "On ne peut pas expulser le créateur 😉" });
          let n = 0;
          for (const x of clients.values()) if (x.user === target && x.room) { leaveRoom(x); send(x, { t: "kicked", msg: `Tu as été expulsé du salon par ${me.name}.` }); n++; }
          return ok(n ? `${target.name} a été expulsé de son salon.` : `${target.name} n'est dans aucun salon.`);
        }
        if (!isCreator(me)) return send(c, { t: "error", msg: "Seul le créateur peut faire ça." });
        if (m.op === "ban") {
          if (target === me || isCreator(target)) return send(c, { t: "error", msg: "Tu ne peux pas te bannir toi-même 😄" });
          target.banned = !!m.on;
          if (target.banned) {
            target.tokens = [];                     // plus de connexion automatique
            for (const x of clients.values()) if (x.user === target) {
              send(x, { t: "banned", msg: "🚫 Ton compte a été banni par le créateur du jeu." });
              if (x.room) leaveRoom(x);
              x.user = null; x.name = "Joueur";
            }
          }
          saveUser(target);
          return ok(target.banned ? `🚫 ${target.name} est banni.` : `✅ ${target.name} n'est plus banni.`);
        }
        if (m.op === "powers") {
          target.powers = !!m.on;
          saveUser(target); pushMe(target);
          return ok(target.powers ? `⚡ ${target.name} a maintenant le panneau de match.` : `${target.name} n'a plus le panneau de match.`);
        }
        if (m.op === "role") {
          if (target === me) return send(c, { t: "error", msg: "Tu restes le créateur 👑" });
          target.role = m.role === "admin" ? "admin" : "joueur";
          saveUser(target); pushMe(target);
          return ok(target.role === "admin" ? `🛡️ ${target.name} est maintenant admin.` : `${target.name} n'est plus admin.`);
        }
        const team = +m.team;
        if (!SPECIALS.includes(team)) return send(c, { t: "error", msg: "Équipe spéciale inconnue." });
        if (m.op === "give") {
          if (!target.specials.includes(team)) target.specials.push(team);
          saveUser(target); pushMe(target);
          return ok(`${SPECIAL_NAMES[team]} donnée à ${target.name} 🎁`);
        }
        if (m.op === "take") {
          target.specials = target.specials.filter(t => t !== team);
          saveUser(target); pushMe(target);
          return ok(`${SPECIAL_NAMES[team]} reprise à ${target.name}.`);
        }
        break;
      }

      /* ----- salons ----- */
      case "list": c.watching = !!m.on; if (c.watching) send(c, { t: "rooms", rooms: publicList() }); break;

      case "create": {
        if (c.room) leaveRoom(c);
        const type = ["tournoi", "1v1", "2v2"].includes(m.type) ? m.type : "tournoi";
        const mode = m.mode === "cl" ? "cl" : "cdm";
        const sizes = mode === "cl" ? [8, 16] : [8, 16, 32];
        const numTeams = sizes.includes(+m.numTeams) ? +m.numTeams : sizes[sizes.length - 1];
        const maxPlayers = type === "1v1" ? 2 : type === "2v2" ? 4 : Math.max(2, Math.min(32, +m.maxPlayers || 8, numTeams));
        const room = {
          code: makeCode(), name: `Salon de ${c.name}`, host: c.id, public: !!m.public, type, mode,
          maxPlayers, numTeams, diff: ["facile", "moyen", "difficile"].includes(m.diff) ? m.diff : "moyen",
          state: "lobby", players: new Map(), tour: null, roundTimer: null, sideTeam: { A: null, B: null }, match: null,
        };
        rooms.set(room.code, room);
        room.players.set(c.id, { id: c.id, name: c.name, role: c.user.role, team: null, side: isMatchRoom(room) ? "A" : null });
        c.room = room.code; c.watching = false;
        broadcastRoom(room);
        broadcastList();
        break;
      }

      case "join": {
        const room = rooms.get(clean(m.code, 8).toUpperCase());
        if (!room) return send(c, { t: "error", msg: "Aucun salon avec ce code." });
        if (room.state !== "lobby") return send(c, { t: "error", msg: "Ce salon a déjà commencé." });
        if (room.players.size >= room.maxPlayers) return send(c, { t: "error", msg: "Ce salon est complet." });
        if ([...room.players.values()].some(p => clients.get(p.id) && clients.get(p.id).user === c.user)) return send(c, { t: "error", msg: "Tu es déjà dans ce salon (autre onglet ?)." });
        if (c.room) leaveRoom(c);
        room.players.set(c.id, { id: c.id, name: c.name, role: c.user.role, team: null, side: isMatchRoom(room) ? freeSide(room) : null });
        c.room = room.code; c.watching = false;
        broadcastRoom(room);
        broadcastList();
        break;
      }

      case "leave": leaveRoom(c); break;

      case "pick": {   // choix de l'équipe : pas de doublon
        if (!r || r.state !== "lobby") return;
        const team = +m.team;
        if (!(team >= 0 && team < NB_TEAMS) || !validTeam(c, team, r.mode)) return send(c, { t: "error", msg: "Tu ne peux pas prendre cette équipe." });
        const me = r.players.get(c.id);
        if (isMatchRoom(r)) {
          if (!me.side) return;
          const other = me.side === "A" ? "B" : "A";
          if (r.sideTeam[other] === team) return send(c, { t: "error", msg: "L'autre équipe a déjà pris ce club / ce pays !" });
          r.sideTeam[me.side] = team;
        } else {
          for (const p of r.players.values()) if (p.team === team && p.id !== c.id) return send(c, { t: "error", msg: "Cette équipe est déjà prise !" });
          me.team = team;
        }
        broadcastRoom(r);
        break;
      }

      case "side": {   // match 1v1 / 2v2 : choisir son camp
        if (!r || r.state !== "lobby" || !isMatchRoom(r)) return;
        const s = m.side === "B" ? "B" : "A";
        const me = r.players.get(c.id);
        if (me.side === s) return;
        if ([...r.players.values()].filter(p => p.side === s).length >= perSide(r)) return send(c, { t: "error", msg: "Cette équipe est complète." });
        const old = me.side;
        me.side = s;
        if (old && ![...r.players.values()].some(p => p.side === old)) r.sideTeam[old] = null;
        broadcastRoom(r);
        break;
      }

      case "start": {
        if (!r || r.host !== c.id || r.state !== "lobby") return;
        const pl = [...r.players.values()];
        if (pl.length < 2) return send(c, { t: "error", msg: "Il faut au moins 2 joueurs." });
        if (isMatchRoom(r)) {
          const A = pl.filter(p => p.side === "A"), B = pl.filter(p => p.side === "B");
          if (!A.length || !B.length) return send(c, { t: "error", msg: "Il faut au moins un joueur dans chaque équipe." });
          if (r.sideTeam.A == null || r.sideTeam.B == null) return send(c, { t: "error", msg: "Chaque camp doit choisir son équipe." });
          const pw = p => hasPowers(userOfId(p.id));
          const hum = [...A.map(p => ({ id: p.id, name: p.name, role: p.role, pw: pw(p), team: 0 })), ...B.map(p => ({ id: p.id, name: p.name, role: p.role, pw: pw(p), team: 1 }))];
          r.match = { hum, host: A[0].id, tIdx: [r.sideTeam.A, r.sideTeam.B] };
          r.state = "playing";
          toRoom(r, { t: "fstart", match: r.match, mode: r.mode });
          broadcastRoom(r);
          broadcastList();
          return;
        }
        if (pl.some(p => p.team == null)) return send(c, { t: "error", msg: "Tout le monde doit choisir son équipe." });
        startTournament(r);
        broadcastRoom(r);
        break;
      }

      case "fresult": {  // fin d'un match 1v1 / 2v2 (envoyé par l'hôte du match)
        if (!r || !r.match || r.match.host !== c.id) return;
        const n = v => Math.max(0, Math.min(99, Math.floor(+v || 0)));
        const res = { a: n(m.res && m.res.a), b: n(m.res && m.res.b) };
        if (m.res && m.res.pa != null) { res.pa = n(m.res.pa); res.pb = n(m.res.pb); }
        const aWon = winsFirst(res);
        for (const h of r.match.hum) {
          const won = (h.team === 0) === aWon;
          recordMatch(userOfId(h.id), h.team === 0 ? res.a : res.b, h.team === 0 ? res.b : res.a, won, "friendly");
        }
        r.match = null; r.state = "lobby";
        toRoom(r, { t: "fend", res });
        broadcastRoom(r);
        broadcastList();
        break;
      }

      case "result": {   // résultat d'un match du tournoi (score dans l'ordre du tableau)
        if (!r || !r.tour) return;
        const mt = r.tour.matches[m.m];
        if (!mt || mt.done) return;
        const allowed = mt.type === "live" ? c.id === mt.pa : (c.id === mt.pa || c.id === mt.pb);
        if (!allowed || !m.res) return;
        const n = v => Math.max(0, Math.min(99, Math.floor(+v || 0)));
        const res = { a: n(m.res.a), b: n(m.res.b) };
        if (m.res.pa != null) { res.pa = n(m.res.pa); res.pb = n(m.res.pb); }
        if (res.a === res.b && (res.pa == null || res.pa === res.pb)) return;   // il faut un vainqueur
        if (m.res.et) res.et = true;
        setResult(r, m.m, res);
        break;
      }
    }
  });

  ws.on("close", () => { leaveRoom(c); clients.delete(c.id); if (c.user) notifyFriends(c.user); });
});

/* ---------- amis ---------- */
function areFriends(a, b) { return !!(a && b && a.friends.includes(b.key)); }
function statusOf(u) {          // en ligne ? dans un salon ? en match ?
  let best = null;
  for (const x of clients.values()) {
    if (x.user !== u) continue;
    const r = x.room ? rooms.get(x.room) : null;
    let st = { online: true, id: x.id, playing: x.playing, room: null };
    if (r) {
      st.room = { code: r.code, type: r.type, mode: r.mode, state: r.state };
      if (r.state === "playing") st.playing = st.playing || true;
    }
    if (!best || (st.playing && !best.playing)) best = st;
  }
  return best || { online: false };
}
function sendFriends(c) {
  const u = c.user;
  if (!u) return;
  const view = k => { const f = users.get(k); return f ? Object.assign({ name: f.name, role: f.role }, statusOf(f)) : null; };
  send(c, { t: "friends", friends: u.friends.map(view).filter(Boolean),
    reqIn: u.reqIn.map(k => users.get(k)).filter(Boolean).map(f => f.name), reqOut: u.reqOut.map(k => users.get(k)).filter(Boolean).map(f => f.name) });
}
function notifyFriends(u) {       // mes amis connectés voient mon nouveau statut
  if (!u) return;
  for (const x of clients.values()) if (x.user && x.user !== u && x.user.friends.includes(u.key)) sendFriends(x);
}

function sendAdminList(c) {
  const online = new Set([...clients.values()].filter(x => x.user).map(x => x.user.key));
  const list = [...users.values()].sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 300)
    .map(u => ({ name: u.name, role: u.role, specials: ownedSpecials(u), won: u.stats.won, played: u.stats.played, online: online.has(u.key), powers: hasPowers(u), banned: u.banned }));
  send(c, { t: "adminlist", list, total: users.size });
}

loadUsers();
server.listen(PORT, () => {
  console.log(`⚽ FOOTBALL : ouvre http://localhost:${PORT} dans ton navigateur`);
  if (CREATEUR) console.log(`👑 Créateur du jeu : ${CREATEUR}`);
  else console.log("👑 Pas de CREATEUR défini : le premier compte créé sera le créateur.");
  // adresses à donner aux amis connectés au même Wi-Fi
  const nets = require("os").networkInterfaces();
  for (const list of Object.values(nets)) for (const n of list || []) {
    if (n.family === "IPv4" && !n.internal) console.log(`   Tes amis sur le même Wi-Fi : http://${n.address}:${PORT}`);
  }
});


/* =========================================================
   LA PAGE DU JEU (HTML + CSS + JavaScript)
   ========================================================= */
function pageDuJeu() { return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, viewport-fit=cover">
<title>Football</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0b1d12;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #fff;
    min-height: 100vh; min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
    overscroll-behavior: none;
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
  button { touch-action: manipulation; }
  #wrap { position: relative; width: 100%; max-width: 960px; aspect-ratio: 8 / 5;
          max-width: min(960px, calc((100vh - 16px) * 1.6)); max-width: min(960px, calc((100dvh - 16px) * 1.6)); }
  /* téléphone tenu à la verticale : on demande de le tourner */
  #rotate { display: none; position: fixed; inset: 0; z-index: 100; background: #0b1d12; color: #fff;
            flex-direction: column; align-items: center; justify-content: center; gap: 14px; text-align: center; padding: 24px; }
  #rotate .phone { font-size: 64px; animation: turn 1.8s ease-in-out infinite; }
  @keyframes turn { 0%, 30% { transform: rotate(0); } 60%, 100% { transform: rotate(-90deg); } }
  #rotate p { font-size: 18px; font-weight: 800; }
  #rotate small { opacity: .7; }
  @media (orientation: portrait) and (pointer: coarse) { #rotate:not(.skip) { display: flex; } }
  #fsBtn { position: absolute; right: 1.2%; top: 14%; z-index: 40; display: none; width: 40px; height: 40px; border-radius: 10px;
           border: 0; background: rgba(0,0,0,.55); color: #fff; font-size: 20px; }
  @media (pointer: coarse) { #fsBtn.ok { display: block; } }
  canvas { width: 100%; height: 100%; display: block; border-radius: 12px; touch-action: none; cursor: crosshair; }
  .screen {
    position: absolute; inset: 0;
    background: rgba(5, 20, 10, .93);
    border-radius: 12px;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 16px; gap: 12px; text-align: center; overflow: auto;
    justify-content: safe center;
  }
  .hidden { display: none !important; }
  h1 { font-size: clamp(22px, 4.5vw, 42px); color: #ffd23f; }
  h2 { font-size: clamp(18px, 3vw, 28px); color: #ffd23f; }
  p  { opacity: .9; font-size: clamp(12px, 1.8vw, 16px); max-width: 620px; }
  .grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px; width: 100%; max-width: 900px; }
  @media (max-width: 700px) { .grid { grid-template-columns: repeat(4, 1fr); } }
  .team {
    background: #163a24; border: 2px solid transparent; border-radius: 10px;
    padding: 5px 3px; cursor: pointer; color: #fff;
    font-size: clamp(9px, 1.2vw, 12px);
    display: flex; flex-direction: column; align-items: center; gap: 5px;
    transition: transform .1s, border-color .1s;
  }
  .team:hover { border-color: #ffd23f; transform: translateY(-2px); }
  .jersey { width: 26px; height: 26px; border-radius: 50%; border: 3px solid #fff; }
  button.big {
    background: #ffd23f; color: #0b1d12; border: none; border-radius: 999px;
    padding: 12px 30px; font-weight: 800; font-size: clamp(14px, 2vw, 18px); cursor: pointer;
  }
  button.big:hover { filter: brightness(1.1); }
  .bracket { display: flex; gap: 6px; width: 100%; max-width: 920px; }
  .round { display: flex; flex-direction: column; gap: 3px; flex: 1; justify-content: space-around; min-width: 0; }
  .round-title { font-size: clamp(8px, 1.1vw, 11px); color: #ffd23f; text-transform: uppercase; letter-spacing: 1px; }
  .match { background: #163a24; border-radius: 6px; padding: 2px 5px; font-size: clamp(8px, 1.1vw, 11px); text-align: left; border: 1px solid transparent; }
  .match.mine { border-color: #ffd23f; }
  .match span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .match div { display: flex; justify-content: space-between; gap: 6px; padding: 1px 0; }
  .win { color: #ffd23f; font-weight: 700; }
  .me { text-decoration: underline; }
  .help { font-size: clamp(11px, 1.5vw, 13px); opacity: .75; line-height: 1.5; }
  /* ---------- Écran d'accueil ---------- */
  #title { position: absolute; inset: 0; border-radius: 12px; overflow: hidden; background: #040b1e; }
  #titleScene, #titleScene svg, #titlePhoto { position: absolute; inset: 0; width: 100%; height: 100%; }
  #titlePhoto { object-fit: cover; }
  .title-shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,.15) 55%, rgba(0,0,0,0) 100%); }
  .title-content {
    position: relative; z-index: 2; height: 100%;
    display: flex; flex-direction: column; align-items: flex-start; justify-content: center;
    padding: 0 0 4% 7%; gap: clamp(8px, 2vw, 18px); text-align: left;
  }
  .kicker { font-weight: 800; letter-spacing: 4px; font-size: clamp(10px, 1.6vw, 15px); color: #fff; opacity: .9;
            background: rgba(255,255,255,.12); padding: 6px 12px; border-radius: 999px; }
  .game-title {
    font-size: clamp(42px, 10vw, 104px); font-weight: 900; line-height: .9; font-style: italic; letter-spacing: 1px;
    background: linear-gradient(180deg, #fff8d6 0%, #ffd23f 45%, #e08e00 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    filter: drop-shadow(0 4px 0 #6b3f00) drop-shadow(0 10px 18px rgba(0,0,0,.6));
  }
  .play { font-size: clamp(16px, 2.6vw, 24px) !important; padding: 14px 44px !important; letter-spacing: 2px;
          box-shadow: 0 6px 0 #a87a00, 0 10px 24px rgba(0,0,0,.5); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { transform: scale(1.06); } }
  .title-ball { animation: bounce 1.8s ease-in-out infinite; }
  @keyframes bounce { 50% { transform: translateY(-14px) rotate(12deg); } }
  .confetti { transform-box: fill-box; transform-origin: center; animation: fall linear infinite; }
  @keyframes fall { from { transform: translateY(-40px) rotate(0deg); } to { transform: translateY(560px) rotate(540deg); } }
  .flash { animation: flash 3s steps(1) infinite; opacity: 0; }
  @keyframes flash { 0% { opacity: 1; } 4% { opacity: 0; } }
  /* ---------- Difficulté ---------- */
  .diffs { display: flex; gap: 14px; width: 100%; max-width: 760px; }
  .diff { flex: 1; background: #163a24; color: #fff; border: 3px solid transparent; border-radius: 14px; cursor: pointer;
          padding: 18px 12px; display: flex; flex-direction: column; gap: 8px; align-items: center; transition: transform .12s, border-color .12s; }
  .diff:hover { transform: translateY(-4px); }
  .diff .diff-name { font-size: clamp(18px, 3vw, 28px); font-weight: 900; }
  .diff .diff-desc { font-size: clamp(11px, 1.5vw, 14px); opacity: .85; }
  .diff .diff-stars { font-size: clamp(16px, 2.4vw, 22px); letter-spacing: 3px; }
  .diff.facile { border-top-color: #2ecc71; } .diff.facile:hover { border-color: #2ecc71; } .diff.facile .diff-name { color: #2ecc71; }
  .diff.moyen { border-top-color: #ffd23f; }  .diff.moyen:hover { border-color: #ffd23f; }  .diff.moyen .diff-name { color: #ffd23f; }
  .diff.difficile { border-top-color: #e74c3c; } .diff.difficile:hover { border-color: #e74c3c; } .diff.difficile .diff-name { color: #e74c3c; }
  .back { background: none; border: none; color: #fff; opacity: .7; cursor: pointer; font-size: 14px; text-decoration: underline; }
  .back:hover { opacity: 1; }
  /* ---------- Drapeaux ---------- */
  .flag { width: 46px; height: 31px; border-radius: 3px; box-shadow: 0 0 0 1px rgba(255,255,255,.35), 0 2px 6px rgba(0,0,0,.4); display: block; }
  .mini-flag { width: 15px; height: 10px; border-radius: 1px; vertical-align: -1px; margin-right: 4px; box-shadow: 0 0 0 1px rgba(255,255,255,.3); }
  .match span:first-child { display: flex; align-items: center; }
  /* ---------- Mode en ligne ---------- */
  .modes { display: flex; gap: 16px; width: 100%; max-width: 640px; }
  .mode-card { flex: 1; background: #163a24; color: #fff; border: 3px solid transparent; border-radius: 16px; cursor: pointer;
               padding: 22px 14px; display: flex; flex-direction: column; align-items: center; gap: 8px; transition: transform .12s, border-color .12s; }
  .mode-card:hover { transform: translateY(-4px); border-color: #ffd23f; }
  .mode-card .ico { font-size: clamp(34px, 6vw, 54px); }
  .mode-card .nm { font-size: clamp(18px, 3vw, 26px); font-weight: 900; color: #ffd23f; }
  .mode-card .ds { font-size: clamp(11px, 1.5vw, 14px); opacity: .85; }
  .net-status { font-size: 14px; padding: 8px 14px; border-radius: 10px; background: rgba(255,255,255,.08); max-width: 560px; line-height: 1.5; }
  .net-status.good { color: #2ecc71; } .net-status.bad { color: #ff8a80; }
  .field { display: flex; align-items: center; justify-content: space-between; gap: 14px; width: 100%; max-width: 420px;
           background: #163a24; padding: 10px 14px; border-radius: 10px; font-size: 15px; }
  .field select, .field input[type=text], #pseudo, #joinCode {
    background: #0b1d12; color: #fff; border: 2px solid #2b5a3c; border-radius: 8px; padding: 8px 10px; font-size: 15px; }
  #pseudo { width: 260px; text-align: center; }
  #joinCode { width: 150px; text-align: center; font-size: 22px; letter-spacing: 6px; font-weight: 800; text-transform: uppercase; }
  .row-btns { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; align-items: center; }
  .small-btn { background: #ffd23f; color: #0b1d12; border: none; border-radius: 999px; padding: 8px 16px; font-weight: 800; cursor: pointer; }
  .small-btn.ghost { background: transparent; color: #fff; border: 2px solid rgba(255,255,255,.4); }
  #roomList { width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: 8px; }
  .room-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; background: #163a24; padding: 10px 14px; border-radius: 10px; text-align: left; }
  .muted { opacity: .7; font-size: 13px; }
  .code-box { font-size: clamp(28px, 5vw, 44px); font-weight: 900; letter-spacing: 10px; color: #ffd23f; background: #0b1d12;
              border: 2px dashed #ffd23f; border-radius: 12px; padding: 4px 18px 4px 28px; }
  .players { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; max-width: 820px; }
  .pl-chip { background: #163a24; padding: 6px 12px; border-radius: 999px; font-size: 14px; display: flex; align-items: center; gap: 4px; }
  .pl-chip.me { outline: 2px solid #ffd23f; }
  .no-flag { display: inline-block; width: 15px; height: 10px; background: #555; border-radius: 1px; font-size: 8px; line-height: 10px; margin-right: 4px; }
  .team.taken { opacity: .35; cursor: not-allowed; } .team.taken:hover { transform: none; border-color: transparent; }
  .team.picked { border-color: #ffd23f; background: #2b5a3c; }
  .team small { font-size: 9px; color: #ffd23f; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  #toast { position: absolute; left: 50%; top: 14px; transform: translate(-50%, -80px); background: #111; color: #fff; padding: 10px 18px;
           border-radius: 999px; border: 2px solid #ffd23f; font-weight: 700; z-index: 50; transition: transform .25s; pointer-events: none; text-align: center; }
  #toast.on { transform: translate(-50%, 0); opacity: 1; }
  #toast { opacity: 0; }
  /* ---------- Comptes ---------- */
  .auth-box { background: rgba(0,0,0,.35); border: 2px solid rgba(255,210,63,.35); border-radius: 18px; padding: 18px 22px;
              display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 360px; }
  .auth-box input { background: #0b1d12; color: #fff; border: 2px solid #2b5a3c; border-radius: 10px; padding: 11px 12px; font-size: 16px; width: 100%; }
  .auth-box input:focus { outline: none; border-color: #ffd23f; }
  .auth-box label { text-align: left; font-size: 13px; opacity: .8; margin-bottom: -6px; }
  .auth-msg { min-height: 18px; font-size: 13px; color: #ff8a80; }
  .auth-msg.ok { color: #2ecc71; }
  .link-btn { background: none; border: none; color: #ffd23f; cursor: pointer; font-size: 15px; font-weight: 700; text-decoration: underline; }
  .logo { font-size: clamp(38px, 8vw, 74px); font-weight: 900; font-style: italic; line-height: 1;
          background: linear-gradient(180deg, #fff8d6 0%, #ffd23f 45%, #e08e00 100%); -webkit-background-clip: text; background-clip: text; color: transparent;
          filter: drop-shadow(0 3px 0 #6b3f00); }
  #userBar { position: absolute; left: 10px; top: 10px; z-index: 45; display: none; gap: 6px; align-items: center; }
  #userBar.on { display: flex; }
  #userBar button { background: rgba(0,0,0,.6); color: #fff; border: 1px solid rgba(255,255,255,.25); border-radius: 999px; padding: 6px 12px;
                    font-weight: 800; font-size: 13px; cursor: pointer; }
  #userBar button:hover { border-color: #ffd23f; }
  .uname { cursor: pointer; text-decoration: none; color: inherit; font-weight: 700; }
  .uname:hover { text-decoration: underline; color: #ffd23f; }
  .crown { display: inline-block; font-size: .95em; margin-right: 3px; filter: drop-shadow(0 0 3px rgba(255,210,63,.9)); }
  .shield { display: inline-block; font-size: .9em; margin-right: 3px; }
  /* fenêtre du profil */
  #profile { position: absolute; inset: 0; z-index: 60; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; border-radius: 12px; }
  #profile.hidden { display: none; }
  .pcard { background: #10301d; border: 2px solid #ffd23f; border-radius: 18px; padding: 18px 20px; width: min(520px, 94%); max-height: 94%; overflow: auto;
           display: flex; flex-direction: column; gap: 10px; text-align: center; position: relative; }
  .pcard h2 { margin: 0; }
  .pclose { position: absolute; right: 10px; top: 6px; background: none; border: none; color: #fff; font-size: 26px; cursor: pointer; }
  .prole { font-size: 13px; opacity: .85; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .stat { background: #163a24; border-radius: 12px; padding: 8px 4px; }
  .stat b { display: block; font-size: 22px; color: #ffd23f; }
  .stat span { font-size: 11px; opacity: .85; }
  .admin-zone { border-top: 1px dashed rgba(255,255,255,.3); padding-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
  .admin-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; background: #163a24; padding: 6px 10px; border-radius: 10px; font-size: 13px; text-align: left; }
  #adminList { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow: auto; }
  #adminSearch { background: #0b1d12; color: #fff; border: 2px solid #2b5a3c; border-radius: 8px; padding: 8px 10px; font-size: 14px; }
  .dot-on { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #2ecc71; margin-right: 5px; }
  .dot-off { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #666; margin-right: 5px; }
  /* compétition et équipes spéciales */
  .comp-cl .nm { color: #8fd3ff !important; }
  .grid.clubs { grid-template-columns: repeat(8, 1fr); }
  .special-title { color: #ff9ff3; font-weight: 900; letter-spacing: 1px; margin-top: 4px; }
  .team.special { background: linear-gradient(180deg, #3b1d5e, #1c1240); border-color: #b48cff; }
  .flag.badge { width: 34px; height: 40px; box-shadow: none; border-radius: 0; }
  .mini-flag.badge { width: 11px; height: 13px; box-shadow: none; border-radius: 0; vertical-align: -2px; }
  /* salon 1v1 / 2v2 */
  .sides { display: flex; gap: 12px; width: 100%; max-width: 640px; }
  .side-col { flex: 1; background: #163a24; border-radius: 14px; padding: 10px; display: flex; flex-direction: column; gap: 6px; align-items: center; border: 2px solid transparent; }
  .side-col.mine { border-color: #ffd23f; }
  .side-col h3 { font-size: 15px; color: #ffd23f; }
  .side-team { display: flex; align-items: center; gap: 6px; font-weight: 800; }
  .keys { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; text-align: left; font-size: clamp(11px, 1.5vw, 13px); max-width: 640px; opacity: .85; }
  @media (max-height: 520px) {
    .logo { font-size: 32px; } .auth-box { padding: 8px 14px; gap: 5px; } .auth-box h2 { font-size: 17px; }
    .auth-box input { padding: 6px 10px; font-size: 15px; } .auth-box button.big { padding: 8px 20px; }
    #loginScreen, #registerScreen { gap: 5px; padding: 8px; } #loginScreen > p, #registerScreen > p { font-size: 13px; }
  }
  /* panneau de pouvoirs pendant les matchs */
  #pwBtn { position: absolute; right: 1.2%; top: 25%; z-index: 41; width: 42px; height: 42px; border-radius: 12px; border: 2px solid #ffd23f;
           background: rgba(0,0,0,.6); color: #ffd23f; font-size: 22px; cursor: pointer; }
  #pwPanel { position: absolute; right: 1.2%; top: 34%; z-index: 41; background: rgba(10,20,14,.95); border: 2px solid #ffd23f; border-radius: 14px;
             padding: 10px; display: flex; flex-direction: column; gap: 6px; width: 250px; }
  #pwPanel b { color: #ffd23f; text-align: center; }
  #pwPanel button { background: #163a24; color: #fff; border: 1px solid rgba(255,255,255,.2); border-radius: 10px; padding: 8px; font-weight: 700; cursor: pointer; text-align: left; }
  #pwPanel button:hover { border-color: #ffd23f; }
  #pwPanel button:disabled { opacity: .4; }
  #pwPanel small { opacity: .7; text-align: center; }
  #scare { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 95; border-radius: 12px; pointer-events: none; }
  #blackout { position: absolute; inset: 0; z-index: 94; background: #000; border-radius: 12px; }
  #stopWatch { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 42; }
  #liveList { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .friend-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; background: #163a24; padding: 7px 10px; border-radius: 10px; font-size: 14px; text-align: left; }
  .friend-row .acts { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
  .friend-row .small-btn { padding: 5px 10px; font-size: 12px; }
  #friendAdd { display: flex; gap: 6px; }
  #friendName { flex: 1; background: #0b1d12; color: #fff; border: 2px solid #2b5a3c; border-radius: 8px; padding: 8px 10px; font-size: 14px; }
  .reqbadge { background: #e74c3c; color: #fff; border-radius: 999px; padding: 0 6px; font-size: 11px; margin-left: 4px; }
  #globalMsg { position: absolute; left: 50%; top: 13%; transform: translateX(-50%); z-index: 99; width: min(640px, 92%);
               background: linear-gradient(180deg, #2b1d00, #120c00); border: 3px solid #ffd23f; border-radius: 16px; padding: 12px 40px 12px 16px;
               box-shadow: 0 8px 30px rgba(0,0,0,.6); text-align: left; animation: gpop .35s ease-out; }
  #globalMsg .gfrom { color: #ffd23f; font-weight: 900; font-size: 13px; letter-spacing: 1px; }
  #globalMsg .gtext { font-size: clamp(15px, 2.2vw, 20px); font-weight: 800; margin-top: 4px; word-wrap: break-word; }
  #globalMsg button { position: absolute; right: 8px; top: 6px; background: none; border: none; color: #fff; font-size: 22px; cursor: pointer; }
  @keyframes gpop { from { transform: translate(-50%, -30px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
  #bcText { width: 100%; min-height: 60px; background: #0b1d12; color: #fff; border: 2px solid #ffd23f; border-radius: 10px; padding: 8px; font-size: 14px; resize: vertical; font-family: inherit; }
  kbd { background: #fff; color: #111; border-radius: 4px; padding: 0 5px; font-weight: 800; font-family: inherit; box-shadow: 0 2px 0 #999; }
</style>
</head>
<body>
<div id="wrap">
  <canvas id="game" width="1600" height="1000"></canvas>

  <!-- CONNEXION -->
  <div id="loginScreen" class="screen">
    <div class="logo">FOOTBALL</div>
    <p class="muted">Coupe du Monde · Champions League · en ligne avec tes amis</p>
    <form class="auth-box" id="loginForm" autocomplete="on">
      <h2>Se connecter</h2>
      <label for="lName">Nom d'utilisateur</label>
      <input id="lName" name="username" autocomplete="username" maxlength="16" placeholder="Ton nom d'utilisateur">
      <label for="lPw">Mot de passe</label>
      <input id="lPw" name="password" type="password" autocomplete="current-password" maxlength="64" placeholder="Ton mot de passe">
      <div class="auth-msg" id="lMsg"></div>
      <button class="big" type="submit" id="loginGo">Se connecter</button>
    </form>
    <p>Pas encore de compte ? <button class="link-btn" id="toRegister">Créer un compte</button></p>
    <div id="netState" class="net-status">Connexion au serveur...</div>
    <button class="small-btn ghost hidden" id="noAccount">Jouer hors ligne sans compte</button>
  </div>

  <!-- CRÉER UN COMPTE -->
  <div id="registerScreen" class="screen hidden">
    <div class="logo">FOOTBALL</div>
    <form class="auth-box" id="registerForm" autocomplete="on">
      <h2>Créer un compte</h2>
      <label for="rgName">Choisis ton nom d'utilisateur (unique)</label>
      <input id="rgName" name="username" autocomplete="username" maxlength="16" placeholder="3 à 16 lettres ou chiffres">
      <label for="rgPw">Mot de passe</label>
      <input id="rgPw" name="new-password" type="password" autocomplete="new-password" maxlength="64" placeholder="Au moins 4 caractères">
      <label for="rgPw2">Répète le mot de passe</label>
      <input id="rgPw2" type="password" autocomplete="new-password" maxlength="64" placeholder="Le même mot de passe">
      <div class="auth-msg" id="rgMsg"></div>
      <button class="big" type="submit" id="registerGo">Créer mon compte</button>
    </form>
    <p>Tu as déjà un compte ? <button class="link-btn" id="toLogin">Se connecter</button></p>
  </div>

  <!-- ÉCRAN D'ACCUEIL -->
  <div id="title" class="hidden">
    <div id="titleScene"></div>
    <!-- Tu peux mettre ta propre photo : enregistre-la sous le nom accueil.jpg à côté de index.html -->
    <img id="titlePhoto" src="accueil.jpg" alt="" onerror="this.remove()">
    <div class="title-shade"></div>
    <div class="title-content">
      <div class="kicker">COUPE DU MONDE 2026 · CHAMPIONS LEAGUE</div>
      <div class="game-title">FOOT<br>BALL</div>
      <button class="big play" id="startBtn">JOUER ▶</button>
    </div>
  </div>

  <!-- CHOIX DE LA COMPÉTITION -->
  <div id="compScreen" class="screen hidden">
    <h1>Choisis ta compétition</h1>
    <div class="modes">
      <button class="mode-card" id="goCdm"><span class="ico">🌍</span><span class="nm">COUPE DU MONDE</span><span class="ds">Les 32 nations des seizièmes de finale 2026</span></button>
      <button class="mode-card comp-cl" id="goCl"><span class="ico">⭐</span><span class="nm">CHAMPIONS LEAGUE</span><span class="ds">Les 16 clubs des huitièmes de finale 2025-2026</span></button>
    </div>
    <button class="back" id="compBack">← Retour</button>
  </div>

  <!-- EN LIGNE OU HORS LIGNE -->
  <div id="modeScreen" class="screen hidden">
    <h1 id="modeTitle">Comment veux-tu jouer ?</h1>
    <div class="modes">
      <button class="mode-card" id="goOnline"><span class="ico">🌍</span><span class="nm">EN LIGNE</span><span class="ds">Tournoi, match 1 contre 1 ou 2 contre 2 avec tes amis</span></button>
      <button class="mode-card" id="goOffline"><span class="ico">🤖</span><span class="nm">HORS LIGNE</span><span class="ds">Joue contre des bots</span></button>
    </div>
    <button class="back" id="modeBack">← Retour</button>
  </div>

  <!-- EN LIGNE : créer / rejoindre -->
  <div id="onlineScreen" class="screen hidden">
    <h1 id="onlineTitle">Jouer en ligne</h1>
    <div id="netStatus" class="net-status">Connexion au serveur...</div>
    <div class="modes">
      <button class="mode-card" id="createBtn"><span class="ico">🏟️</span><span class="nm">CRÉER UN SALON</span><span class="ds">Tournoi, 1 contre 1 ou 2 contre 2 : tu reçois un code à donner à tes amis</span></button>
      <button class="mode-card" id="joinBtn"><span class="ico">🤝</span><span class="nm">REJOINDRE UN SALON</span><span class="ds">Avec le code d'un ami ou un salon public</span></button>
    </div>
    <button class="back" id="onlineBack">← Retour</button>
  </div>

  <!-- CRÉER UN SALON -->
  <div id="createScreen" class="screen hidden">
    <h1>Créer un salon</h1>
    <label class="field">Type de partie
      <select id="cType"><option value="tournoi">🏆 Tournoi (jusqu'à 32 joueurs)</option><option value="1v1">⚔️ Match 1 contre 1</option><option value="2v2">🤝 Match 2 contre 2</option></select></label>
    <label class="field" id="cMaxRow">Nombre maximum de joueurs
      <select id="cMax"></select></label>
    <label class="field" id="cTeamsRow">Nombre d'équipes dans le tournoi
      <select id="cTeams"></select></label>
    <label class="field" id="cDiffRow">Niveau des bots
      <select id="cDiff"><option value="facile">Facile</option><option value="moyen" selected>Moyen</option><option value="difficile">Difficile</option></select></label>
    <label class="field">Salon public (visible par tout le monde)
      <input id="cPublic" type="checkbox" checked style="width:22px;height:22px"></label>
    <button class="big" id="createGo">Créer le salon 🏟️</button>
    <button class="back" id="createBack">← Retour</button>
  </div>

  <!-- REJOINDRE UN SALON -->
  <div id="joinScreen" class="screen hidden">
    <h1>Rejoindre un salon</h1>
    <div class="row-btns"><input id="joinCode" type="text" maxlength="5" placeholder="CODE"><button class="big" id="joinGo">Rejoindre</button></div>
    <h2>Salons publics</h2>
    <div id="roomList"><p class="muted">Chargement...</p></div>
    <button class="back" id="joinBack">← Retour</button>
  </div>

  <!-- SALLE D'ATTENTE DU SALON -->
  <div id="roomScreen" class="screen hidden">
    <h2 id="rName"></h2>
    <div class="row-btns"><span>Code du salon :</span><span class="code-box" id="rCode"></span><button class="small-btn ghost" id="rCopy">Copier</button></div>
    <p class="muted" id="rInfo"></p>
    <div class="players" id="rPlayers"></div>
    <div class="sides hidden" id="rSides"></div>
    <p id="rMsg"></p>
    <div class="grid" id="rGrid"></div>
    <div class="row-btns"><button class="big hidden" id="rStart">Lancer le tournoi 🏆</button><button class="small-btn ghost" id="rLeave">Quitter le salon</button></div>
  </div>

  <!-- CHOIX DE LA DIFFICULTÉ -->
  <div id="diffScreen" class="screen hidden">
    <h1>Choisis le mode</h1>
    <div class="diffs">
      <button class="diff facile" data-d="facile"><span class="diff-stars">⭐</span><span class="diff-name">FACILE</span><span class="diff-desc">Adversaires plus lents, gardiens moins forts</span></button>
      <button class="diff moyen" data-d="moyen"><span class="diff-stars">⭐⭐</span><span class="diff-name">MOYEN</span><span class="diff-desc">Un vrai match équilibré</span></button>
      <button class="diff difficile" data-d="difficile"><span class="diff-stars">⭐⭐⭐</span><span class="diff-name">DIFFICILE</span><span class="diff-desc">Adversaires rapides, gardiens redoutables</span></button>
    </div>
    <button class="back" id="diffBack">← Retour</button>
  </div>

  <!-- CHOIX DU PAYS -->
  <div id="menu" class="screen hidden">
    <h1 id="menuTitle">Choisis ton pays</h1>
    <p id="menuSub"></p>
    <div class="grid" id="teamGrid"></div>
    <div class="keys" id="keysHelp"></div>
    <button class="back" id="menuBack">← Changer de mode</button>
  </div>

  <!-- TABLEAU DU TOURNOI -->
  <div id="bracketScreen" class="screen hidden">
    <h2 id="bTitle"></h2>
    <p id="bSub"></p>
    <button class="big" id="playBtn">Jouer le match ⚽</button>
    <div id="liveList"></div>
    <div class="bracket" id="bGrid"></div>
    <button class="small-btn ghost hidden" id="leaveTour">Quitter le salon</button>
  </div>

  <!-- ÉGALITÉ -> TIRS AU BUT -->
  <div id="drawScreen" class="screen hidden">
    <h1>Égalité !</h1>
    <p id="dText"></p>
    <button class="big" id="penBtn">Place aux tirs au but 🥅</button>
  </div>

  <!-- FIN -->
  <div id="endScreen" class="screen hidden">
    <h1 id="eTitle"></h1>
    <p id="eText"></p>
    <button class="big" id="againBtn">Rejouer</button>
    <div class="bracket" id="eGrid"></div>
  </div>
  <!-- FENÊTRE DU PROFIL (statistiques) ET PANNEAU ADMIN -->
  <div id="profile" class="hidden">
    <div class="pcard" id="pcard"></div>
  </div>
  <button id="pwBtn" class="hidden" title="Panneau de match (touche P)">⚡</button>
  <div id="pwPanel" class="hidden">
    <b>⚡ Panneau de match</b>
    <button data-pw="plus">➕ Me rajouter un but</button>
    <button data-pw="minus">➖ Enlever un but à l'adversaire</button>
    <button data-pw="expel">🟥 Expulser un joueur adverse</button>
    <button data-pw="scream">😱 Screamer à l'adversaire</button>
    <button data-pw="black">⬛ Écran noir à l'adversaire (5 s)</button>
    <small id="pwNote">Touche P pour ouvrir / fermer</small>
  </div>
  <div id="blackout" class="hidden"></div>
  <div id="globalMsg" class="hidden"><div class="gfrom" id="gFrom"></div><div class="gtext" id="gText"></div><button onclick="$('globalMsg').classList.add('hidden')">×</button></div>
  <canvas id="scare" class="hidden" width="800" height="500"></canvas>
  <button id="stopWatch" class="small-btn hidden">👀 Arrêter de regarder</button>
  <div id="userBar">
    <button id="ubName"></button>
    <button id="ubFriends">👥 Amis</button>
    <button id="ubAdmin" class="hidden">⚙️ Admin</button>
    <button id="ubOut">Déconnexion</button>
  </div>
  <div id="toast"></div>
  <button id="fsBtn" aria-label="Plein écran">⛶</button>
</div>
<div id="rotate">
  <div class="phone">📱</div>
  <p>Tourne ton téléphone à l'horizontale pour jouer</p>
  <small>Le terrain est bien plus grand comme ça !</small>
  <button class="small-btn ghost" onclick="document.getElementById('rotate').classList.add('skip')">Continuer quand même</button>
</div>

<script>
/* =========================================================
   DONNÉES
   ========================================================= */
// Les 32 équipes qualifiées pour les seizièmes de finale de la Coupe du monde 2026,
// rangées par affiches réelles des seizièmes (équipe 0 contre 1, 2 contre 3, etc.)
const TEAMS = [
  { name: "Afrique du Sud",  c1: "#ffb612", c2: "#007749" },
  { name: "Canada",          c1: "#d80621", c2: "#ffffff" },
  { name: "Brésil",          c1: "#ffdf00", c2: "#009c3b" },
  { name: "Japon",           c1: "#0b2a6f", c2: "#ffffff" },
  { name: "Allemagne",       c1: "#ffffff", c2: "#111111" },
  { name: "Paraguay",        c1: "#d52b1e", c2: "#ffffff" },
  { name: "Pays-Bas",        c1: "#f36c21", c2: "#ffffff" },
  { name: "Maroc",           c1: "#c1272d", c2: "#006233" },
  { name: "Côte d'Ivoire",   c1: "#f77f00", c2: "#ffffff" },
  { name: "Norvège",         c1: "#ba0c2f", c2: "#ffffff" },
  { name: "France",          c1: "#1d3c8f", c2: "#ffffff" },
  { name: "Suède",           c1: "#fecc02", c2: "#006aa7" },
  { name: "Mexique",         c1: "#006847", c2: "#ffffff" },
  { name: "Équateur",        c1: "#ffdd00", c2: "#034ea2" },
  { name: "Angleterre",      c1: "#ffffff", c2: "#1d3c8f" },
  { name: "RD Congo",        c1: "#007fff", c2: "#f7d618" },
  { name: "Belgique",        c1: "#c8102e", c2: "#fdda24" },
  { name: "Sénégal",         c1: "#00853f", c2: "#fdef42" },
  { name: "États-Unis",      c1: "#0a3161", c2: "#ffffff" },
  { name: "Bosnie-Herzégovine", c1: "#002395", c2: "#fecb00" },
  { name: "Espagne",         c1: "#c60b1e", c2: "#ffc400" },
  { name: "Autriche",        c1: "#ed2939", c2: "#ffffff" },
  { name: "Portugal",        c1: "#a50021", c2: "#006600" },
  { name: "Croatie",         c1: "#ff0000", c2: "#ffffff" },
  { name: "Suisse",          c1: "#d52b1e", c2: "#ffffff" },
  { name: "Algérie",         c1: "#ffffff", c2: "#006233" },
  { name: "Australie",       c1: "#ffcd00", c2: "#00843d" },
  { name: "Égypte",          c1: "#ce1126", c2: "#111111" },
  { name: "Argentine",       c1: "#75aadb", c2: "#ffffff" },
  { name: "Cap-Vert",        c1: "#003893", c2: "#cf2027" },
  { name: "Colombie",        c1: "#fcd116", c2: "#003893" },
  { name: "Ghana",           c1: "#ffffff", c2: "#111111" },
  // Les 16 clubs des huitièmes de finale de la Champions League 2025-2026 (indices 32 à 47)
  // (écussons simples avec les initiales : ce ne sont pas les vrais logos)
  { name: "Arsenal",            c1: "#db0007", c2: "#ffffff", ab: "ARS", club: "en" },
  { name: "FC Barcelone",       c1: "#a50044", c2: "#004d98", ab: "FCB", club: "es", stripe: "#004d98" },
  { name: "Bayern Munich",      c1: "#dc052d", c2: "#ffffff", ab: "FCB", club: "de" },
  { name: "Chelsea",            c1: "#034694", c2: "#ffffff", ab: "CFC", club: "en" },
  { name: "Liverpool",          c1: "#c8102e", c2: "#f6eb61", ab: "LFC", club: "en" },
  { name: "Manchester City",    c1: "#6cabdd", c2: "#ffffff", ab: "MCI", club: "en" },
  { name: "Sporting Portugal",  c1: "#008057", c2: "#ffffff", ab: "SCP", club: "pt", hoops: "#ffffff" },
  { name: "Tottenham",          c1: "#ffffff", c2: "#132257", ab: "THF", club: "en" },
  { name: "Atalanta Bergame",   c1: "#1e71b8", c2: "#111111", ab: "ATA", club: "it", stripe: "#111111" },
  { name: "Atlético Madrid",    c1: "#cb3524", c2: "#272e61", ab: "ATM", club: "es", stripe: "#ffffff" },
  { name: "Bayer Leverkusen",   c1: "#e32221", c2: "#111111", ab: "B04", club: "de" },
  { name: "Bodø/Glimt",         c1: "#ffd700", c2: "#111111", ab: "BOD", club: "no" },
  { name: "Galatasaray",        c1: "#a90432", c2: "#fdb912", ab: "GS",  club: "tr", half: "#fdb912" },
  { name: "Newcastle",          c1: "#ffffff", c2: "#241f20", ab: "NUFC", club: "en", stripe: "#241f20" },
  { name: "Paris Saint-Germain", c1: "#004170", c2: "#da291c", ab: "PSG", club: "fr", band: "#da291c" },
  { name: "Real Madrid",        c1: "#ffffff", c2: "#febe10", ab: "RMA", club: "es" },
  // Équipe spéciale (indice 48) : seulement pour le créateur et ceux à qui il la donne
  { name: "Napoléon FC",        c1: "#1b2a6b", c2: "#ffffff", ab: "N", special: true, band: "#d81e2c", fast: true, ko: 3 },
  // Équipe spéciale (indice 49) : le Dylan FC, avec l'âne Dylan Lane en attaque
  { name: "Dylan FC",           c1: "#ff7a00", c2: "#111111", ab: "DFC", special: true, stripe: "#111111", ko: 9, donkey: true },
];
const NB_NATIONS = 32, CLUB0 = 32, NB_CLUBS = 16, NAPOLEON = 48, DYLANFC = 49;
const isClub = i => i >= CLUB0 && i < CLUB0 + NB_CLUBS;
const isSpecial = i => !!(TEAMS[i] && TEAMS[i].special);
// compétitions : la Coupe du monde (32 nations) et la Champions League (16 clubs)
const COMPS = {
  cdm: { name: "Coupe du Monde", pool: [...Array(32).keys()], stages: ["Seizièmes de finale", "Huitièmes de finale", "Quarts de finale", "Demi-finales", "Finale"],
         win: "REMPORTE LA COUPE DU MONDE !", podium: "CHAMPIONS DU MONDE", board: "COUPE DU MONDE", champ: "champion du monde" },
  cl:  { name: "Champions League", pool: [...Array(16).keys()].map(i => 32 + i), stages: ["Huitièmes de finale", "Quarts de finale", "Demi-finales", "Finale"],
         win: "REMPORTE LA CHAMPIONS LEAGUE !", podium: "CHAMPIONS D'EUROPE", board: "CHAMPIONS LEAGUE", champ: "champion d'Europe" },
};
let COMP = "cdm";
const compOf = () => COMPS[(T && T.comp) || COMP] || COMPS.cdm;
const STAGES = COMPS.cdm.stages;
const LAST = STAGES.length - 1;

/* =========================================================
   OUTILS
   ========================================================= */
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = 800, H = 500;
const GOAL  = { x1: 230, x2: 570, y1: 110, y2: 260 };   // but (vue tirs au but)
const SPOT  = { x: 400, y: 440 };
const KHOME = { x: 400, y: 212 };

const rand  = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const dist  = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const $ = id => document.getElementById(id);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
/* =========================================================
   DRAPEAUX (dessinés en SVG, aucun fichier ni internet nécessaire)
   ========================================================= */
const R_ = (x, y, w, h, f) => \`<rect x="\${x}" y="\${y}" width="\${w}" height="\${h}" fill="\${f}"/>\`;
const hS = cols => cols.map((c, i) => R_(0, i * 20 / cols.length, 30, 20 / cols.length + 0.05, c)).join("");
const vS = cols => cols.map((c, i) => R_(i * 30 / cols.length, 0, 30 / cols.length + 0.05, 20, c)).join("");
function starSvg(cx, cy, r, fill) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.4 : r;
    pts.push((cx + Math.cos(a) * rr).toFixed(2) + "," + (cy + Math.sin(a) * rr).toFixed(2));
  }
  return \`<polygon points="\${pts.join(" ")}" fill="\${fill}"/>\`;
}
function pentagram(cx, cy, r, stroke, w) {
  const v = [];
  for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; v.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  const o = [0, 2, 4, 1, 3].map(i => v[i].map(n => n.toFixed(2)).join(",")).join(" ");
  return \`<polygon points="\${o}" fill="none" stroke="\${stroke}" stroke-width="\${w}" stroke-linejoin="round"/>\`;
}
const nordic = (bg, c1, c2) => R_(0, 0, 30, 20, bg) + R_(8, 0, 6, 20, c1) + R_(0, 7, 30, 6, c1) +
  (c2 ? R_(9.5, 0, 3, 20, c2) + R_(0, 8.5, 30, 3, c2) : "");

const FLAG_BODY = {
  "Afrique du Sud": R_(0, 0, 30, 10, "#e03c31") + R_(0, 10, 30, 10, "#001489") +
    \`<path d="M-1,-1 L12,10 L-1,21 M12,10 L31,10" stroke="#fff" stroke-width="6.5" fill="none"/>\` +
    \`<path d="M-1,-1 L12,10 L-1,21 M12,10 L31,10" stroke="#007749" stroke-width="4" fill="none"/>\` +
    \`<polygon points="0,3.2 8.2,10 0,16.8" fill="#ffb612"/><polygon points="0,5 6,10 0,15" fill="#000"/>\`,
  "Canada": R_(0, 0, 30, 20, "#fff") + R_(0, 0, 7.5, 20, "#d80621") + R_(22.5, 0, 7.5, 20, "#d80621") +
    \`<polygon fill="#d80621" points="15,3.5 16.2,6 17.8,5.4 17.2,9 19.6,7.6 19.2,9.4 21,9.6 18.6,12 19.2,13 15.6,12.4 15.5,16 14.5,16 14.4,12.4 10.8,13 11.4,12 9,9.6 10.8,9.4 10.4,7.6 12.8,9 12.2,5.4 13.8,6"/>\`,
  "Brésil": R_(0, 0, 30, 20, "#009c3b") + \`<polygon points="3,10 15,2.5 27,10 15,17.5" fill="#ffdf00"/>\` +
    \`<circle cx="15" cy="10" r="5.2" fill="#002776"/><path d="M10,9 Q15,7.6 20.2,10.6" stroke="#fff" stroke-width="0.9" fill="none"/>\`,
  "Japon": R_(0, 0, 30, 20, "#fff") + \`<circle cx="15" cy="10" r="6" fill="#bc002d"/>\`,
  "Allemagne": hS(["#000", "#dd0000", "#ffce00"]),
  "Paraguay": hS(["#d52b1e", "#fff", "#0038a8"]) + \`<circle cx="15" cy="10" r="2.6" fill="none" stroke="#0038a8" stroke-width="0.6"/>\` + starSvg(15, 10, 1.2, "#fcd116"),
  "Pays-Bas": hS(["#ae1c28", "#fff", "#21468b"]),
  "Maroc": R_(0, 0, 30, 20, "#c1272d") + pentagram(15, 10.4, 4.6, "#006233", 0.9),
  "Côte d'Ivoire": vS(["#f77f00", "#fff", "#009e60"]),
  "Norvège": nordic("#ba0c2f", "#fff", "#00205b"),
  "France": vS(["#002395", "#fff", "#ed2939"]),
  "Suède": R_(0, 0, 30, 20, "#006aa7") + R_(8.5, 0, 4, 20, "#fecc02") + R_(0, 8, 30, 4, "#fecc02"),
  "Mexique": vS(["#006847", "#fff", "#ce1126"]) + \`<circle cx="15" cy="10.4" r="2.6" fill="none" stroke="#5a8f29" stroke-width="0.6"/><ellipse cx="15" cy="9.6" rx="1.4" ry="1.8" fill="#8b5a2b"/>\`,
  "Équateur": R_(0, 0, 30, 10, "#ffdd00") + R_(0, 10, 30, 5, "#034ea2") + R_(0, 15, 30, 5, "#ed1c24") +
    \`<ellipse cx="15" cy="10" rx="2.4" ry="3" fill="#6b4a2b" stroke="#ffdd00" stroke-width="0.5"/>\`,
  "Angleterre": R_(0, 0, 30, 20, "#fff") + R_(13, 0, 4, 20, "#ce1124") + R_(0, 8, 30, 4, "#ce1124"),
  "RD Congo": R_(0, 0, 30, 20, "#007fff") + \`<polygon points="0,15 24,0 30,0 30,5 6,20 0,20" fill="#f7d618"/>\` +
    \`<polygon points="0,16.6 26.6,0 30,0 30,3.4 3.4,20 0,20" fill="#ce1021"/>\` + starSvg(5, 4.5, 3.4, "#f7d618"),
  "Belgique": vS(["#000", "#fdda24", "#ef3340"]),
  "Sénégal": vS(["#00853f", "#fdef42", "#e31b23"]) + starSvg(15, 10.3, 3, "#00853f"),
  "États-Unis": (() => {
    let s = "";
    for (let i = 0; i < 13; i++) s += R_(0, i * 20 / 13, 30, 20 / 13 + 0.05, i % 2 ? "#fff" : "#b22234");
    s += R_(0, 0, 12, 7 * 20 / 13, "#3c3b6e");
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) s += \`<circle cx="\${1.4 + c * 2.3}" cy="\${1.4 + r * 2.5}" r="0.45" fill="#fff"/>\`;
    return s;
  })(),
  "Bosnie-Herzégovine": (() => {
    let s = R_(0, 0, 30, 20, "#002395") + \`<polygon points="8,0 26,0 26,20" fill="#fecb00"/>\`;
    for (let k = 0; k < 8; k++) { const t = (k + 0.5) / 8; s += starSvg(8 + 18 * t - 2.6, 20 * t, 1.1, "#fff"); }
    return s;
  })(),
  "Espagne": R_(0, 0, 30, 5, "#aa151b") + R_(0, 5, 30, 10, "#f1bf00") + R_(0, 15, 30, 5, "#aa151b") +
    \`<rect x="7" y="7.2" width="3.6" height="4.8" rx="0.8" fill="#aa151b" stroke="#c8b100" stroke-width="0.4"/>\`,
  "Autriche": hS(["#ed2939", "#fff", "#ed2939"]),
  "Portugal": R_(0, 0, 12, 20, "#006600") + R_(12, 0, 18, 20, "#ff0000") +
    \`<circle cx="12" cy="10" r="3.6" fill="#ffcc00"/><rect x="10.6" y="8.4" width="2.8" height="3.4" rx="0.5" fill="#fff" stroke="#ff0000" stroke-width="0.6"/>\`,
  "Croatie": hS(["#ff0000", "#fff", "#171796"]) + (() => {
    let s = "";
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) s += R_(12.5 + c, 6 + r, 1, 1, (r + c) % 2 ? "#fff" : "#ff0000");
    return s + \`<rect x="12.5" y="6" width="5" height="5" fill="none" stroke="#171796" stroke-width="0.3"/>\`;
  })(),
  "Suisse": R_(0, 0, 30, 20, "#d52b1e") + R_(13, 4, 4, 12, "#fff") + R_(9, 8, 12, 4, "#fff"),
  "Algérie": R_(0, 0, 15, 20, "#006233") + R_(15, 0, 15, 20, "#fff") +
    \`<path d="M19.11,7.15 A5,5 0 1,0 19.11,12.85 A4,4 0 1,1 19.11,7.15 Z" fill="#d21034"/>\` + starSvg(19.3, 10, 2, "#d21034"),
  "Australie": R_(0, 0, 30, 20, "#012169") +
    \`<svg x="0" y="0" width="15" height="10" viewBox="0 0 15 10"><rect width="15" height="10" fill="#012169"/>\` +
    \`<path d="M0,0 L15,10 M15,0 L0,10" stroke="#fff" stroke-width="2"/><path d="M0,0 L15,10 M15,0 L0,10" stroke="#c8102e" stroke-width="0.7"/>\` +
    \`<path d="M7.5,0 V10 M0,5 H15" stroke="#fff" stroke-width="3"/><path d="M7.5,0 V10 M0,5 H15" stroke="#c8102e" stroke-width="1.8"/></svg>\` +
    starSvg(7.5, 15, 2.4, "#fff") + starSvg(22.5, 16.5, 1.1, "#fff") + starSvg(22.5, 3.5, 1.1, "#fff") +
    starSvg(18.8, 8.5, 1.1, "#fff") + starSvg(26, 7.5, 1.1, "#fff") + starSvg(24.3, 11, 0.6, "#fff"),
  "Égypte": hS(["#ce1126", "#fff", "#000"]) + \`<path d="M13.2,8.2 L15,7.2 L16.8,8.2 L16.2,11.8 L13.8,11.8 Z" fill="#c09300"/>\`,
  "Argentine": hS(["#74acdf", "#fff", "#74acdf"]) + \`<circle cx="15" cy="10" r="1.8" fill="#f6b40e"/>\`,
  "Cap-Vert": (() => {
    let s = R_(0, 0, 30, 20, "#003893") + R_(0, 11, 30, 1.3, "#fff") + R_(0, 12.3, 30, 1.4, "#cf2027") + R_(0, 13.7, 30, 1.3, "#fff");
    for (let k = 0; k < 10; k++) { const a = k * Math.PI / 5; s += starSvg(11 + Math.cos(a) * 4.6, 12.3 + Math.sin(a) * 4.6, 0.75, "#f7d116"); }
    return s;
  })(),
  "Colombie": R_(0, 0, 30, 10, "#fcd116") + R_(0, 10, 30, 5, "#003893") + R_(0, 15, 30, 5, "#ce1126"),
  "Ghana": hS(["#ce1126", "#fcd116", "#006b3f"]) + starSvg(15, 10.3, 3, "#000"),
};
const flagSvg = name => \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20" width="60" height="40" preserveAspectRatio="none">\${FLAG_BODY[name] || R_(0, 0, 30, 20, "#888")}</svg>\`;
// Écusson simple pour les clubs (couleurs du club + initiales, ce n'est pas le vrai logo)
function badgeSvg(t) {
  const shield = "M15,1 L28,5 L28,17 C28,26 22,32 15,35 C8,32 2,26 2,17 L2,5 Z";
  const inner = "M15,3.6 L25.6,6.8 L25.6,17 C25.6,24.6 20.6,29.6 15,32.3 C9.4,29.6 4.4,24.6 4.4,17 L4.4,6.8 Z";
  let deco = "";
  if (t.stripe) deco = \`<clipPath id="k"><path d="\${inner}"/></clipPath><g clip-path="url(#k)">\${[0, 1, 2].map(i => R_(7.5 + i * 6.5, 0, 3.2, 36, t.stripe)).join("")}</g>\`;
  if (t.hoops) deco = \`<clipPath id="k"><path d="\${inner}"/></clipPath><g clip-path="url(#k)">\${[0, 1, 2, 3].map(i => R_(0, 6 + i * 7, 30, 3.2, t.hoops)).join("")}</g>\`;
  if (t.half) deco = \`<clipPath id="k"><path d="\${inner}"/></clipPath><g clip-path="url(#k)">\${R_(15, 0, 15, 36, t.half)}</g>\`;
  if (t.band) deco = \`<clipPath id="k"><path d="\${inner}"/></clipPath><g clip-path="url(#k)">\${R_(11.5, 0, 7, 36, t.band)}</g>\`;
  const txt = lumHex(t.c1) > 160 ? "#111" : "#fff";
  const fs = t.ab.length > 3 ? 6.4 : t.ab.length > 2 ? 7.6 : t.ab.length > 1 ? 10 : 15;
  let label = \`<text x="15" y="\${t.ab.length > 1 ? 21 : 24}" text-anchor="middle" font-family="Arial,sans-serif" font-weight="900" font-size="\${fs}" fill="\${txt}" stroke="\${lumHex(t.c1) > 160 ? "#fff" : "#000"}" stroke-width=".5" paint-order="stroke">\${t.ab}</text>\`;
  if (t.donkey) {           // Dylan FC : une tête d'âne et DFC
    label = \`<ellipse cx="11" cy="9" rx="1.6" ry="5" fill="#9b948c" stroke="#111" stroke-width=".4" transform="rotate(-18 11 9)"/><ellipse cx="19" cy="9" rx="1.6" ry="5" fill="#9b948c" stroke="#111" stroke-width=".4" transform="rotate(18 19 9)"/>\` +
      \`<ellipse cx="15" cy="17" rx="5" ry="6" fill="#9b948c" stroke="#111" stroke-width=".4"/><ellipse cx="15" cy="21" rx="3.4" ry="2.6" fill="#e9e4dc"/>\` +
      \`<circle cx="13" cy="15.5" r=".8" fill="#111"/><circle cx="17" cy="15.5" r=".8" fill="#111"/>\` +
      \`<text x="15" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-weight="900" font-size="6" fill="#fff" stroke="#000" stroke-width=".5" paint-order="stroke">DFC</text>\`;
  } else if (t.special) {   // Napoléon FC : un N doré entouré de lauriers, et un petit bicorne
    label = \`<path d="M8,26 Q5,18 9,10 M22,26 Q25,18 21,10" stroke="#e8c45a" stroke-width="1.6" fill="none"/>\` +
      [0, 1, 2, 3].map(i => \`<ellipse cx="\${7.3 + i * 0.4}" cy="\${23 - i * 4}" rx="1.6" ry=".8" fill="#e8c45a" transform="rotate(-50 \${7.3 + i * 0.4} \${23 - i * 4})"/><ellipse cx="\${22.7 - i * 0.4}" cy="\${23 - i * 4}" rx="1.6" ry=".8" fill="#e8c45a" transform="rotate(50 \${22.7 - i * 0.4} \${23 - i * 4})"/>\`).join("") +
      \`<text x="15" y="25" text-anchor="middle" font-family="Georgia,serif" font-weight="900" font-size="14" fill="#ffd23f" stroke="#5a3d00" stroke-width=".6" paint-order="stroke">N</text>\` +
      \`<path d="M9.5,10.5 Q15,4 20.5,10.5 Q15,8.6 9.5,10.5 Z" fill="#111"/>\`;
  }
  return \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 36" width="60" height="72"><path d="\${shield}" fill="\${t.c2 === t.c1 ? "#111" : t.c2}" stroke="#000" stroke-opacity=".35" stroke-width=".6"/><path d="\${inner}" fill="\${t.c1}"/>\${deco}\${label}</svg>\`;
}
function lumHex(h) { const n = parseInt(h.slice(1), 16); return 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255); }
const svgURL = s => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
const flagURL = name => svgURL(flagSvg(name));
// image d'une équipe : drapeau pour un pays, écusson pour un club
const TEAM_URL = TEAMS.map((t, i) => i < NB_NATIONS ? flagURL(t.name) : svgURL(badgeSvg(t)));
const teamImg = (i, cls = "flag") => \`<img class="\${cls}\${i >= NB_NATIONS ? " badge" : ""}" src="\${TEAM_URL[i]}" alt="">\`;
// images des drapeaux pour le dessin dans le jeu (tableau des scores)
const FLAG_IMG = TEAMS.map((t, i) => { const im = new Image(); im.src = TEAM_URL[i]; return im; });
function drawFlag(idx, x, y, w, h) {
  const im = FLAG_IMG[idx];
  if (idx >= NB_NATIONS) {                         // écusson : pas de cadre, on garde ses proportions
    const bw = h * 30 / 36 * 1.25, bh = h * 1.25;
    if (im && im.complete && im.naturalWidth !== 0) ctx.drawImage(im, x + (w - bw) / 2, y + (h - bh) / 2, bw, bh);
    return;
  }
  ctx.fillStyle = "rgba(255,255,255,.85)";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  if (im && im.complete && im.naturalWidth !== 0) ctx.drawImage(im, x, y, w, h);
}

/* =========================================================
   ÉCRAN D'ACCUEIL : stade de nuit, ballon et confettis
   ========================================================= */
function buildTitleScene() {
  let crowd = "";
  for (let i = 0; i < 1100; i++) {
    const x = Math.random() * 800, t = x / 800;
    const top = 180 - 96 * t * (1 - t) + 6;
    const y = top + Math.random() * (288 - top);
    const c = \`hsl(\${Math.floor(Math.random() * 360)},65%,\${45 + Math.random() * 30}%)\`;
    crowd += \`<circle cx="\${x.toFixed(1)}" cy="\${y.toFixed(1)}" r="1.7" fill="\${c}"/>\`;
  }
  let flashes = "";
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * 800, t = x / 800, top = 180 - 96 * t * (1 - t) + 8;
    flashes += \`<circle class="flash" style="animation-delay:\${(Math.random() * 3).toFixed(2)}s" cx="\${x.toFixed(1)}" cy="\${(top + Math.random() * 90).toFixed(1)}" r="2.4" fill="#fff"/>\`;
  }
  // ballon : pentagone central + 5 pentagones autour
  const pent = (cx, cy, r, rot) => {
    const p = [];
    for (let j = 0; j < 5; j++) { const a = (rot + j * 72) * Math.PI / 180; p.push((cx + Math.cos(a) * r).toFixed(1) + "," + (cy + Math.sin(a) * r).toFixed(1)); }
    return \`<polygon points="\${p.join(" ")}" fill="#111"/>\`;
  };
  let ball = pent(0, 0, 24, -90);
  for (let k = 0; k < 5; k++) {
    const a = -90 + 36 + 72 * k, ar = a * Math.PI / 180;
    ball += pent(Math.cos(ar) * 70, Math.sin(ar) * 70, 24, a + 180);
    const b = (-90 + 72 * k) * Math.PI / 180;
    ball += \`<line x1="\${(Math.cos(b) * 24).toFixed(1)}" y1="\${(Math.sin(b) * 24).toFixed(1)}" x2="\${(Math.cos(b) * 50).toFixed(1)}" y2="\${(Math.sin(b) * 50).toFixed(1)}" stroke="#333" stroke-width="2"/>\`;
  }
  let confetti = "";
  const cc = ["#ffd23f", "#f77f00", "#2ecc71", "#e74c3c", "#3498db", "#fff"];
  for (let i = 0; i < 46; i++) {
    confetti += \`<rect class="confetti" x="\${(Math.random() * 800).toFixed(0)}" y="\${(-Math.random() * 120).toFixed(0)}" width="6" height="10" fill="\${cc[i % cc.length]}" style="animation-duration:\${(4 + Math.random() * 5).toFixed(1)}s;animation-delay:\${(-Math.random() * 8).toFixed(1)}s"/>\`;
  }
  const tower = x => \`
    <polygon points="\${x - 70},44 \${x - 230},330 \${x + 90},330" fill="#fff8d0" opacity=".06"/>
    <rect x="\${x - 4}" y="44" width="8" height="140" fill="#1d2b44"/>
    <circle cx="\${x}" cy="38" r="95" fill="url(#glow)"/>
    <rect x="\${x - 26}" y="26" width="52" height="20" rx="3" fill="#2a3a58"/>
    \${[0, 1, 2, 3].map(i => \`<rect x="\${x - 23 + i * 12}" y="29" width="10" height="6" rx="1" fill="#fffbe0"/><rect x="\${x - 23 + i * 12}" y="37" width="10" height="6" rx="1" fill="#fffbe0"/>\`).join("")}\`;

  $("titleScene").innerHTML = \`
  <svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#040b1e"/><stop offset="1" stop-color="#11305a"/></linearGradient>
      <radialGradient id="glow"><stop offset="0" stop-color="#fffbe0" stop-opacity=".95"/><stop offset=".25" stop-color="#fff3b0" stop-opacity=".35"/><stop offset="1" stop-color="#fff3b0" stop-opacity="0"/></radialGradient>
      <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c6a2c"/><stop offset="1" stop-color="#33a84a"/></linearGradient>
      <radialGradient id="ballShade" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#fff"/><stop offset=".65" stop-color="#ececec"/><stop offset="1" stop-color="#8c8c8c"/></radialGradient>
      <radialGradient id="ballGloss" cx=".3" cy=".25" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <clipPath id="ballClip"><circle cx="0" cy="0" r="80"/></clipPath>
      <clipPath id="pitchClip"><polygon points="-100,500 900,500 650,306 150,306"/></clipPath>
      <pattern id="net" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0,0 L8,8 M8,0 L0,8" stroke="#ffffff" stroke-opacity=".35" stroke-width="1"/></pattern>
    </defs>
    <rect width="800" height="500" fill="url(#sky)"/>
    \${[...Array(40)].map(() => \`<circle cx="\${(Math.random() * 800).toFixed(0)}" cy="\${(Math.random() * 120).toFixed(0)}" r="\${(Math.random() * 1.2 + 0.3).toFixed(1)}" fill="#fff" opacity=".6"/>\`).join("")}
    <path d="M0,168 Q400,118 800,168 L800,300 L0,300 Z" fill="#101c30"/>
    <g opacity=".9">\${crowd}</g>
    \${flashes}
    <path d="M-10,168 Q400,118 810,168" stroke="#2b3d5c" stroke-width="8" fill="none"/>
    \${tower(110)}\${tower(690)}
    <rect x="0" y="288" width="800" height="18" fill="#0d4d8c"/>
    <text x="400" y="301" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="11" fill="#fff" letter-spacing="3">FOOTBALL · COUPE DU MONDE · CHAMPIONS LEAGUE · FOOTBALL · COUPE DU MONDE</text>
    <polygon points="-100,500 900,500 650,306 150,306" fill="url(#grass)"/>
    <g clip-path="url(#pitchClip)" fill="#000" opacity=".1">
      <rect x="0" y="306" width="800" height="22"/><rect x="0" y="352" width="800" height="30"/><rect x="0" y="414" width="800" height="40"/>
    </g>
    <g stroke="#fff" stroke-opacity=".85" stroke-width="2.5" fill="none">
      <polygon points="245,306 555,306 610,372 190,372"/>
      <polygon points="335,306 465,306 478,326 322,326"/>
      <path d="M330,372 Q400,400 470,372"/>
    </g>
    <rect x="340" y="258" width="120" height="48" fill="url(#net)"/>
    <path d="M340,306 V258 H460 V306" stroke="#fff" stroke-width="5" fill="none"/>
    <g opacity=".5" stroke="#fff" stroke-linecap="round">
      <line x1="380" y1="370" x2="500" y2="372" stroke-width="5"/><line x1="400" y1="400" x2="490" y2="402" stroke-width="4"/><line x1="410" y1="430" x2="495" y2="430" stroke-width="3"/>
    </g>
    <ellipse cx="610" cy="478" rx="78" ry="14" fill="#000" opacity=".35"/>
    <g transform="translate(610,392)">
      <g class="title-ball">
        <circle r="80" fill="url(#ballShade)"/>
        <g clip-path="url(#ballClip)">\${ball}</g>
        <circle r="80" fill="url(#ballGloss)"/>
        <circle r="80" fill="none" stroke="#555" stroke-width="2"/>
      </g>
    </g>
    \${confetti}
  </svg>\`;
}

function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function colorDist(a, b) { const A = hexRgb(a), B = hexRgb(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); }

/* =========================================================
   SON (petits effets générés, aucun fichier nécessaire)
   ========================================================= */
let AC = null;
function initAudio() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
}
function beep(freq, dur, type = "square", vol = 0.06) {
  if (!AC) return;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.value = vol;
  o.connect(g); g.connect(AC.destination);
  const t = AC.currentTime;
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t); o.stop(t + dur);
}
function crowdSound(vol = 0.15) {
  if (!AC) return;
  const len = AC.sampleRate * 1.4;
  const buf = AC.createBuffer(1, len, AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = AC.createBufferSource(); src.buffer = buf;
  const f = AC.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 900;
  const g = AC.createGain(); g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(AC.destination);
  src.start();
}
const whistle = () => beep(2300, 0.35, "sine", 0.05);

/* =========================================================
   TOURNOI
   ========================================================= */
let T = null;            // état du tournoi
let G = null;            // match complet en cours
let M = null;            // séance de tirs au but en cours
let pendingScore = null; // score du match nul avant les tirs au but
// Niveaux de difficulté
const DIFFS = {
  facile:    { label: "Facile",    spd: -16, tackle: 0.5, gkCatch: 0.7,  pen: -0.12, miss: 0.2,  reach: 82 },
  moyen:     { label: "Moyen",     spd: 0,   tackle: 1.0, gkCatch: 1.0,  pen: 0,     miss: 0.1,  reach: 70 },
  difficile: { label: "Difficile", spd: 16,  tackle: 1.7, gkCatch: 1.2,  pen: 0.12,  miss: 0.05, reach: 60 },
};
let chosenDiff = "moyen";
const D = () => DIFFS[(T && T.diff) || chosenDiff];

// équipes spéciales que le joueur connecté possède (Napoléon FC...)
const mySpecials = () => (ME && ME.specials) || [];
// remplit une grille d'équipes : celles de la compétition, puis les équipes spéciales
function fillTeamGrid(grid, comp, onPick, decorate) {
  grid.innerHTML = "";
  const add = (i, extra) => {
    const t = TEAMS[i], b = document.createElement("button");
    b.className = "team" + (extra || "");
    b.innerHTML = \`\${teamImg(i)}\${t.name}\`;
    if (decorate) decorate(b, i);
    b.onclick = () => onPick(i);
    grid.appendChild(b);
  };
  COMPS[comp].pool.slice().sort((x, y) => TEAMS[x].name.localeCompare(TEAMS[y].name, "fr")).forEach(i => add(i));
  const sp = mySpecials();
  if (sp.length) {
    const h = document.createElement("div");
    h.className = "special-title"; h.style.gridColumn = "1 / -1";
    h.textContent = "⭐ TES ÉQUIPES SPÉCIALES ⭐";
    grid.appendChild(h);
    sp.forEach(i => add(i, " special"));
  }
}
const KEYS_HTML = \`
  <span><b>Courir</b></span><span>maintiens le <b>clic gauche</b> et bouge la souris</span>
  <span><b>Tirer</b></span><span><b>lâche le clic gauche</b> (le tir part vers la souris)</span>
  <span><b>Passe</b></span><span><b>clic droit</b> ou <kbd>E</kbd> quand tu as le ballon : passe directe au coéquipier visé</span>
  <span><b>Tacle</b></span><span><b>clic droit</b> sans le ballon (touche le ballon d'abord, sinon carton !)</span>
  <span><b>Dribble</b></span><span><kbd>A</kbd> (clavier AZERTY) ou <kbd>Q</kbd> (QWERTY) : impossible de perdre le ballon pendant 1,5 s</span>
  <span><b>Changer</b></span><span><kbd>F</kbd> : tu prends le joueur le plus proche du ballon</span>
  <span><b>Sprint</b></span><span>maintiens <kbd>Maj</kbd> (Shift) en courant : plus rapide, mais ton joueur se fatigue (barre verte)</span>
  <span><b>Équipes spéciales</b></span><span><kbd>R</kbd> : charge à cheval du Napoléon FC (3 par match) ou ruade de l'âne du Dylan FC (9 par match)</span>
  <span><b>Téléphone</b></span><span>joystick à gauche (poussé à fond = sprint) · boutons TIR, PASSE, TACLE, DRIBBLE, CHANGER à droite</span>\`;
function buildMenu() {
  const c = COMPS[COMP];
  $("menuTitle").textContent = COMP === "cl" ? "Choisis ton club" : "Choisis ton pays";
  $("menuSub").textContent = COMP === "cl"
    ? "Les 16 clubs qualifiés pour les huitièmes de finale de la Champions League 2025-2026. Va jusqu'au titre !"
    : "Les 32 équipes qualifiées pour les seizièmes de finale de la Coupe du monde 2026. Va jusqu'au titre !";
  $("teamGrid").classList.toggle("clubs", COMP === "cl");
  fillTeamGrid($("teamGrid"), COMP, i => { initAudio(); startTournament(i); });
  $("keysHelp").innerHTML = KEYS_HTML;
}

function startTournament(myIdx) {
  const c = COMPS[COMP];
  let first = COMP === "cl" ? shuffle(c.pool.slice()) : c.pool.slice();   // Coupe du monde : vraies affiches des seizièmes
  if (!first.includes(myIdx)) first[Math.floor(Math.random() * first.length)] = myIdx;   // équipe spéciale : elle prend la place d'une équipe
  T = { me: myIdx, comp: COMP, rounds: [first], scores: [], stage: 0, diff: chosenDiff, stages: c.stages };
  showBracket();
}

// Mon match dans le tour r : numéro du match, ma place (1re ou 2e équipe) et mon adversaire
function myMatch(r) {
  const t = T.rounds[r], k = t.indexOf(T.me);
  return { m: Math.floor(k / 2), first: k % 2 === 0, opp: t[k ^ 1] };
}
const oppNow = () => myMatch(T.stage).opp;
const flipRes = s => ({ a: s.b, b: s.a, pa: s.pb, pb: s.pa, et: s.et });
// fin d'un match : tournoi hors ligne ou en ligne
const finishMatch = res => (T && T.online ? onlineFinish(res) : afterMatch(res));

function simShootout() {
  let a = 0, b = 0;
  for (let i = 0; i < 5; i++) {
    if (Math.random() < 0.75) a++;
    if (Math.random() < 0.75) b++;
  }
  while (a === b) {
    if (Math.random() < 0.75) a++;
    if (Math.random() < 0.75) b++;
  }
  return [a, b];
}
function poisson(l) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; }
function simMatch() {
  const a = poisson(1.3), b = poisson(1.3);
  if (a !== b) return { a, b };
  const [pa, pb] = simShootout();
  return { a, b, pa, pb };
}
const winsFirst = s => s.a > s.b || (s.a === s.b && s.pa > s.pb);
const fmtScore  = s => s.pa != null ? \`\${s.a}-\${s.b} a.p., \${s.pa}-\${s.pb} aux tirs au but\` : \`\${s.a}-\${s.b}\${s.et ? " après prolongations" : ""}\`;

// Joue un tour : mon match utilise mon vrai score, les autres sont simulés
function playRound(r, playerRes) {
  const teams = T.rounds[r];
  const mine = playerRes ? myMatch(r) : null;
  T.scores[r] = [];
  const next = [];
  for (let m = 0; m < teams.length / 2; m++) {
    let s;
    if (mine && m === mine.m) s = mine.first ? playerRes : flipRes(playerRes);
    else s = simMatch();
    T.scores[r].push(s);
    next.push(winsFirst(s) ? teams[2 * m] : teams[2 * m + 1]);
  }
  return next;
}

function renderBracket(el) {
  let html = "";
  for (let r = 0; r < T.stages.length; r++) {
    const teams = T.rounds[r];
    const n = (T.rounds[0].length / 2) >> r;
    html += \`<div class="round"><div class="round-title">\${T.stages[r]}</div>\`;
    for (let m = 0; m < n; m++) {
      const a = teams ? teams[2 * m] : null;
      const b = teams ? teams[2 * m + 1] : null;
      const sc = T.scores[r] && T.scores[r][m];
      const sa = sc ? sc.a + (sc.pa != null ? \` (\${sc.pa})\` : "") : "";
      const sb = sc ? sc.b + (sc.pb != null ? \` (\${sc.pb})\` : "") : "";
      const mineCls = (a === T.me || b === T.me) ? " mine" : "";
      html += \`<div class="match\${mineCls}">\${row(a, sa, sc && winsFirst(sc))}\${row(b, sb, sc && !winsFirst(sc))}</div>\`;
    }
    html += "</div>";
  }
  el.innerHTML = html;
}
function row(idx, score, win) {
  if (idx === null || idx === undefined) return \`<div><span>?</span><span></span></div>\`;
  const cls = (win ? "win " : "") + (idx === T.me ? "me" : "");
  const who = T.humans && T.humans[idx] ? \` <i style="opacity:.75">(\${nameTag(T.humans[idx].name, T.humans[idx].role)})</i>\` : "";
  return \`<div class="\${cls}"><span>\${teamImg(idx, "mini-flag")}\${TEAMS[idx].name}\${who}</span><span>\${score}</span></div>\`;
}

const SCREENS = ["loginScreen", "registerScreen", "title", "compScreen", "modeScreen", "onlineScreen", "createScreen", "joinScreen", "roomScreen", "diffScreen", "menu", "bracketScreen", "drawScreen", "endScreen"];
function hideScreens() { SCREENS.forEach(id => $(id).classList.add("hidden")); }

function showBracket() {
  hideScreens();
  const opp = oppNow();
  $("bTitle").textContent = T.stages[T.stage];
  $("playBtn").textContent = "Jouer le match ⚽"; $("playBtn").disabled = false; $("playBtn").classList.remove("hidden");
  $("leaveTour").classList.add("hidden");
  $("liveList").innerHTML = "";
  $("bSub").textContent = \`\${TEAMS[T.me].name}  vs  \${TEAMS[opp].name}  ·  Mode \${D().label}\`;
  renderBracket($("bGrid"));
  $("bracketScreen").classList.remove("hidden");
}

function showEnd(title, text) {
  hideScreens();
  $("eTitle").textContent = title;
  $("eText").textContent = text;
  renderBracket($("eGrid"));
  $("endScreen").classList.remove("hidden");
}

// statistiques du compte pour les matchs hors ligne
function reportStat(o) { if (ME) netSend(Object.assign({ t: "stat" }, o)); }
function afterMatch(res) {
  reportStat({ k: "match", gf: res.a, ga: res.b, won: winsFirst(res) });
  const r = T.stage;
  const myName = TEAMS[T.me].name;
  const won = winsFirst(res);
  let next = playRound(r, res);

  const LASTR = T.stages.length - 1;
  if (won && r < LASTR) {               // qualifié
    T.rounds[r + 1] = next;
    T.stage++;
    showBracket();
    return;
  }
  if (won) {                         // finale gagnée : on soulève la coupe !
    reportStat({ k: "trophy", comp: T.comp });
    startCeleb(T.me, () => showEnd("🏆 CHAMPION !", \`\${myName} remporte la \${compOf().name} ! (finale : \${fmtScore(res)})\`));
    return;
  }
  // éliminé : on simule la suite du tournoi pour connaître le vainqueur
  for (let k = r + 1; k < T.stages.length; k++) {
    T.rounds[k] = next;
    next = playRound(k, null);
  }
  const where = r === LASTR ? "perd la finale" : \`est éliminé en \${T.stages[r].toLowerCase()}\`;
  const champ = next[0];
  startCeleb(champ, () => showEnd("Éliminé...", \`\${myName} \${where} (\${fmtScore(res)}). Vainqueur du tournoi : \${TEAMS[champ].name}.\`));
}

$("playBtn").onclick  = () => { initAudio(); if (T.online) onlinePlay(); else startGame(oppNow()); };
$("penBtn").onclick   = () => { initAudio(); startMatch(oppNow()); };
$("againBtn").onclick = () => {
  $("againBtn").textContent = "Rejouer";
  if (T && T.online) return leaveOnline();
  hideScreens(); T = null; $("title").classList.remove("hidden");
};
// Accueil -> compétition -> en ligne / hors ligne -> difficulté -> choix de l'équipe
const show = id => { hideScreens(); $(id).classList.remove("hidden"); };
$("startBtn").onclick = () => { initAudio(); whistle(); show("compScreen"); };
function pickComp(c) {
  COMP = c;
  $("modeTitle").textContent = \`\${COMPS[c].name} : comment veux-tu jouer ?\`;
  show("modeScreen");
}
$("goCdm").onclick = () => pickComp("cdm");
$("goCl").onclick = () => pickComp("cl");
$("compBack").onclick = () => show("title");
document.querySelectorAll(".diff").forEach(b => b.onclick = () => { chosenDiff = b.dataset.d; buildMenu(); show("menu"); });
$("diffBack").onclick = () => show("modeScreen");
$("menuBack").onclick = () => show("diffScreen");

/* =========================================================
   MATCH COMPLET : 11 contre 11 sur un vrai terrain (105 m x 68 m)
   Mi-temps, prolongations, touches, corners, 6 mètres,
   arbitre, tacles, fautes, cartons, coups francs et penaltys
   ========================================================= */
const PX = 14.3;                                   // pixels par mètre
const F = { x1: 70, y1: 80 };
F.x2 = F.x1 + 105 * PX; F.y2 = F.y1 + 68 * PX;
F.cx = (F.x1 + F.x2) / 2; F.cy = (F.y1 + F.y2) / 2;
F.gh = 3.66 * PX;                                  // demi-largeur du but (7,32 m)
F.boxD = 16.5 * PX; F.boxW = 20.16 * PX;           // surface de réparation
F.sixD = 5.5 * PX;  F.sixW = 9.16 * PX;            // surface de but (6 mètres)
F.spot = 11 * PX;   F.circle = 9.15 * PX;          // point de penalty, rond central
const WORLD = { w: F.x2 + 70, h: F.y2 + 80 };
const CAM_Z = 0.9;                                 // zoom de la caméra
const MATCH_LEN = 180;                             // durée réelle des 90 minutes (en secondes)
const PERIOD_END = [45, 90, 105, 120];             // fin de chaque période (minutes)
const SHOT_SPEED = 820, THROW_SPEED = 420;
const DIST_MUR = 9.15 * PX;                        // distance à respecter sur coup franc / corner
const RESTART_LABEL = { throw: "TOUCHE", corner: "CORNER", goalkick: "6 MÈTRES", free: "COUP FRANC", penalty: "PENALTY !" };

// Système 4-4-2 : positions en mètres pour une équipe qui attaque vers la droite
const FORMATION = [
  { x: 2.5, y: 34, num: 1,  role: "gk"  },
  { x: 19,  y: 10, num: 3,  role: "def" },
  { x: 16,  y: 26, num: 4,  role: "def" },
  { x: 16,  y: 42, num: 5,  role: "def" },
  { x: 19,  y: 58, num: 2,  role: "def" },
  { x: 35,  y: 11, num: 11, role: "mid" },
  { x: 31,  y: 27, num: 6,  role: "mid" },
  { x: 31,  y: 41, num: 8,  role: "mid" },
  { x: 35,  y: 57, num: 7,  role: "mid" },
  { x: 43,  y: 27, num: 9,  role: "fwd" },
  { x: 43,  y: 41, num: 10, role: "fwd" },
];

/* ---------- noms des joueurs (inventés, typiques de chaque pays) ---------- */
// Tu peux changer les noms ici : il en faut au moins 11 par liste.
const NAME_POOLS = {
  ci: ["Koné", "Kouassi", "Traoré", "Bamba", "Yao", "Koffi", "Kouadio", "Diomandé", "Coulibaly", "Touré", "Konan", "N'Guessan", "Aka", "Séka", "Diabaté", "Fofana"],
  sn: ["Diallo", "Ndiaye", "Diop", "Faye", "Sarr", "Gueye", "Fall", "Sow", "Ba", "Cissé", "Mbaye", "Ndour", "Thiam", "Seck", "Diouf", "Niang"],
  cd: ["Mbala", "Kabongo", "Ilunga", "Mukendi", "Tshibangu", "Kalonji", "Mputu", "Nsimba", "Kasongo", "Mulumba", "Bokanga", "Ngoy", "Kanda", "Matondo"],
  ma: ["El Amrani", "Alaoui", "Idrissi", "Bennani", "Tazi", "Berrada", "Chraibi", "Lahlou", "El Fassi", "Ouahbi", "Bouzidi", "Naciri", "Sbai", "Kettani"],
  dz: ["Belkacem", "Bouzid", "Haddad", "Mansouri", "Saidi", "Cherif", "Rahmani", "Boudiaf", "Hamidi", "Kaci", "Zerrouki", "Larbi", "Amrouche", "Meziane"],
  eg: ["Hassan", "Mahmoud", "Ibrahim", "Mostafa", "Abdelaziz", "Farouk", "Shawky", "Gamal", "Fathy", "Saad", "Ashour", "Nabil", "Ragab", "Tawfik"],
  za: ["Mokoena", "Nkosi", "Dlamini", "Khumalo", "Ndlovu", "Mahlangu", "Zulu", "Botha", "Van Wyk", "Mathebula", "Sithole", "Mabaso", "Cele", "Molefe"],
  gh: ["Mensah", "Owusu", "Asante", "Osei", "Agyeman", "Addo", "Darko", "Amoah", "Boakye", "Acheampong", "Frimpong", "Opoku", "Badu", "Tetteh"],
  cv: ["Fortes", "Monteiro", "Tavares", "Lopes", "Semedo", "Varela", "Gomes", "Rocha", "Andrade", "Pina", "Furtado", "Moreira", "Delgado", "Brito"],
  br: ["Silva", "Santos", "Oliveira", "Souza", "Pereira", "Lima", "Costa", "Ferreira", "Almeida", "Ribeiro", "Carvalho", "Martins", "Barbosa", "Araújo"],
  pt: ["Sousa", "Martins", "Correia", "Mendes", "Nunes", "Marques", "Teixeira", "Antunes", "Pinto", "Rodrigues", "Fonseca", "Tavares", "Moura", "Matos"],
  es: ["García", "López", "Martínez", "Sánchez", "Romero", "Navarro", "Domínguez", "Gil", "Serrano", "Molina", "Ortega", "Castro", "Rubio", "Iglesias"],
  ar: ["González", "Rodríguez", "Gómez", "Díaz", "Pérez", "Sosa", "Acosta", "Benítez", "Medina", "Herrera", "Aguirre", "Luna", "Ríos", "Paz"],
  mx: ["Hernández", "Ramírez", "Flores", "Cruz", "Morales", "Reyes", "Jiménez", "Vargas", "Mendoza", "Ruiz", "Aguilar", "Castillo", "Salazar", "Ortiz"],
  co: ["Restrepo", "Muñoz", "Valencia", "Cardona", "Zapata", "Arango", "Mosquera", "Palacios", "Quintero", "Rentería", "Giraldo", "Osorio", "Mejía", "Rojas"],
  ec: ["Arboleda", "Quiñónez", "Cevallos", "Ayoví", "Mina", "Montaño", "Plata", "Angulo", "Bustos", "Vera", "Preciado", "León", "Cortez", "Chalá"],
  py: ["Giménez", "Cáceres", "Villalba", "Ayala", "Duarte", "Fretes", "Acuña", "Báez", "Florentín", "Galeano", "Ortiz", "Benítez", "Riveros", "Cardozo"],
  fr: ["Martin", "Bernard", "Dubois", "Thomas", "Robert", "Richard", "Petit", "Durand", "Leroy", "Moreau", "Simon", "Laurent", "Lefebvre", "Garnier"],
  be: ["Peeters", "Janssens", "Maes", "Jacobs", "Willems", "Claes", "Goossens", "Wouters", "De Smet", "Lambert", "Dupont", "Van Damme", "Hermans", "Leclercq"],
  de: ["Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Schulz", "Hoffmann", "Koch", "Richter", "Klein", "Wolf", "Neumann"],
  at: ["Gruber", "Huber", "Bauer", "Pichler", "Steiner", "Moser", "Mayer", "Hofer", "Leitner", "Berger", "Fuchs", "Eder", "Schwarz", "Winkler"],
  ch: ["Meier", "Keller", "Brunner", "Baumann", "Zimmermann", "Gerber", "Widmer", "Wyss", "Graf", "Roth", "Lüthi", "Bühler", "Studer", "Hess"],
  nl: ["Jansen", "De Vries", "Van den Berg", "Bakker", "Visser", "Smit", "Meijer", "De Boer", "Mulder", "De Groot", "Bos", "Vos", "Hendriks", "Dekker"],
  no: ["Hansen", "Johansen", "Olsen", "Larsen", "Andersen", "Pedersen", "Nilsen", "Kristiansen", "Jensen", "Karlsen", "Johnsen", "Pettersen", "Haugen", "Hagen"],
  se: ["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Olsson", "Persson", "Svensson", "Gustafsson", "Jonsson", "Lindberg", "Lindqvist", "Berg"],
  hr: ["Horvat", "Babić", "Marić", "Jurić", "Novak", "Knežević", "Vuković", "Marković", "Petrović", "Matić", "Tomić", "Pavlović", "Božić", "Blažević"],
  ba: ["Hodžić", "Begić", "Delić", "Hadžić", "Mehmedović", "Hasanović", "Smajić", "Mujić", "Halilović", "Omerović", "Suljić", "Zukić", "Salihović", "Kovačević"],
  en: ["Smith", "Jones", "Taylor", "Brown", "Williams", "Wilson", "Johnson", "Davies", "Robinson", "Wright", "Thompson", "Evans", "Green", "Hughes"],
  us: ["Miller", "Davis", "Anderson", "Moore", "Jackson", "White", "Harris", "Martin", "Clark", "Lewis", "Young", "Allen", "King", "Scott"],
  ca: ["Tremblay", "Roy", "Gagnon", "Campbell", "MacDonald", "Wilson", "Stewart", "Bouchard", "Côté", "Morin", "Mitchell", "Murray", "Lavoie", "Fraser"],
  au: ["Kelly", "Murphy", "Ryan", "O'Brien", "Nguyen", "Walsh", "McDonald", "Thompson", "Mitchell", "Collins", "Cooper", "Watson", "Bennett", "Doyle"],
  jp: ["Sato", "Suzuki", "Takahashi", "Tanaka", "Watanabe", "Ito", "Yamamoto", "Nakamura", "Kobayashi", "Kato", "Yamada", "Sasaki", "Matsumoto", "Inoue"],
  it: ["Rossi", "Russo", "Ferrari", "Esposito", "Bianchi", "Romano", "Colombo", "Ricci", "Marino", "Greco", "Bruno", "Gallo", "Conti", "De Luca"],
  tr: ["Yılmaz", "Kaya", "Demir", "Şahin", "Çelik", "Yıldız", "Aydın", "Öztürk", "Arslan", "Doğan", "Kılıç", "Aslan", "Çetin", "Koç"],
};
const TEAM_REGION = {
  "Afrique du Sud": "za", "Canada": "ca", "Brésil": "br", "Japon": "jp", "Allemagne": "de", "Paraguay": "py",
  "Pays-Bas": "nl", "Maroc": "ma", "Côte d'Ivoire": "ci", "Norvège": "no", "France": "fr", "Suède": "se",
  "Mexique": "mx", "Équateur": "ec", "Angleterre": "en", "RD Congo": "cd", "Belgique": "be", "Sénégal": "sn",
  "États-Unis": "us", "Bosnie-Herzégovine": "ba", "Espagne": "es", "Autriche": "at", "Portugal": "pt", "Croatie": "hr",
  "Suisse": "ch", "Algérie": "dz", "Australie": "au", "Égypte": "eg", "Argentine": "ar", "Cap-Vert": "cv",
  "Colombie": "co", "Ghana": "gh",
};
const SKINS = ["#f3cfae", "#e2b08a", "#c98d5f", "#a86d45", "#7d4c2d", "#5b3620"];
const HAIRS = ["#16100a", "#2c1b0f", "#4b2e17", "#7a5231", "#c79a52", "#e0c27d"];
function seeded(seed) { let s = (seed >>> 0) || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
// Composition de chaque équipe : nom, numéro, couleur de peau et de cheveux (toujours les mêmes)
const REGIONS = Object.keys(NAME_POOLS);
const LINEUPS = TEAMS.map((t, ti) => {
  const r = seeded(ti * 7919 + 17);
  if (t.donkey) {                        // Dylan FC : tous s'appellent Dylan, sauf l'avant-centre... qui est un âne !
    return FORMATION.map((f, i) => {
      const sk = Math.floor(r() * SKINS.length);
      return i === 9 ? { name: "DYLAN LANE", num: f.num, skin: "#9b948c", hair: "#111", bald: false, donkey: true }
                     : { name: "DYLAN", num: f.num, skin: SKINS[sk], hair: HAIRS[Math.floor(r() * 2)], bald: false };
    });
  }
  if (t.special) {                       // Napoléon FC : onze Napoléon à cheval !
    return FORMATION.map((f, i) => ({ name: "NAPOLÉON", num: f.num, skin: "#f3cfae", hair: "#2c1b0f", bald: false, napo: true }));
  }
  const shuf = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pool = shuf((NAME_POOLS[t.club || TEAM_REGION[t.name]] || NAME_POOLS.fr).slice());
  return FORMATION.map((f, i) => {
    let name = pool[i % pool.length];
    if (t.club && r() < 0.45) {                  // un club a aussi des joueurs étrangers
      const reg = REGIONS[Math.floor(r() * REGIONS.length)];
      name = NAME_POOLS[reg][Math.floor(r() * NAME_POOLS[reg].length)];
    }
    const sk = Math.floor(r() * SKINS.length);
    const hr = sk >= 3 ? Math.floor(r() * 2) : Math.floor(r() * HAIRS.length);
    return { name: name.toUpperCase(), num: f.num, skin: SKINS[sk], hair: HAIRS[hr], bald: r() < 0.08 };
  });
});

/* ---------- commandes ---------- */
const mouse = { x: 400, y: 280, down: false, downAt: 0 };
let touchMode = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);   // téléphone / tablette
let frameDT = 1 / 60;
const joy = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
const BTN = {
  shoot:  { x: 730, y: 418, r: 46, label: "TIR" },
  pass:   { x: 622, y: 448, r: 37, label: "PASSE" },
  tackle: { x: 738, y: 302, r: 37, label: "TACLE" },
  drib:   { x: 630, y: 352, r: 31, label: "DRIBBLE" },
  switch: { x: 744, y: 208, r: 28, label: "CHANGER" },
  charge: { x: 650, y: 262, r: 29, label: "CHARGE" },
};

/* ---------- couleurs ---------- */
const lum = h => { const [r, g, b] = hexRgb(h); return 0.299 * r + 0.587 * g + 0.114 * b; };
function teamColors(aIdx, bIdx) {
  const me = TEAMS[aIdx], op = TEAMS[bIdx];
  let oc = { fill: op.c1, line: op.c2 };
  if (colorDist(me.c1, op.c1) < 130) oc = { fill: op.c2, line: op.c1, alt: true };   // maillot extérieur si trop proche
  const pick = (list, avoid) => list.reduce((best, c) => {
    const d = Math.min(...avoid.map(a => colorDist(c, a)));
    return d > best.d ? { c, d } : best;
  }, { c: list[0], d: -1 }).c;
  const GKC = ["#8e44ad", "#f39c12", "#1abc9c", "#ff69b4", "#7f8c8d", "#00e5ff", "#c0ff00"];
  const gk0 = pick(GKC, [me.c1, me.c2, oc.fill, oc.line]);
  const gk1 = pick(GKC, [me.c1, me.c2, oc.fill, oc.line, gk0]);
  const ref = pick(["#111111", "#d4ff00", "#ff3fa4", "#00b8ff"], [me.c1, oc.fill, gk0, gk1]);
  return [{ fill: me.c1, line: me.c2, gk: gk0, team: me }, { ...oc, gk: gk1, team: op }, { ref }];
}
function kitOf(p) {
  const c = G.cols[p.team];
  if (p.gk) return { shirt: c.gk, shorts: "#1c1c1c", socks: c.gk, num: lum(c.gk) > 150 ? "#111" : "#fff" };
  const t = c.team || {};
  const deco = c.alt ? null : t.stripe ? { k: "v", c: t.stripe } : t.hoops ? { k: "h", c: t.hoops } : t.half ? { k: "half", c: t.half } : t.band ? { k: "band", c: t.band } : null;
  return { shirt: c.fill, shorts: c.line, socks: c.fill, num: lum(c.fill) > 150 ? "#111" : "#fff", deco };
}

/* ---------- sens de jeu (on change de côté à la mi-temps) ---------- */
const dirOf   = team => (team === 0 ? 1 : -1) * (G.flip ? -1 : 1);
const humanTeams = () => G.humTeams;                       // équipes jouées par de vrais joueurs
const teamHuman = team => G.humTeams.includes(team);
const goalXOf = team => dirOf(team) > 0 ? F.x2 : F.x1;    // but que l'équipe attaque
const ownXOf  = team => dirOf(team) > 0 ? F.x1 : F.x2;    // but que l'équipe défend
const inBox = (pt, goalX) => Math.abs(pt.x - goalX) < F.boxD && Math.abs(pt.y - F.cy) < F.boxW;

function setHomes() {
  for (const p of G.players) {
    const f = FORMATION[p.i];
    if (dirOf(p.team) > 0) { p.hx = F.x1 + f.x * PX; p.hy = F.y1 + f.y * PX; }
    else { p.hx = F.x2 - f.x * PX; p.hy = F.y2 - f.y * PX; }
  }
}

// vitesse : Napoléon FC est 40 % plus rapide que l'équipe adverse
const speedMul = (tIdx, team) => TEAMS[tIdx[team]].fast && !TEAMS[tIdx[1 - team]].fast ? 1.4 : 1;
function makePlayers(tIdx, humTeams) {
  const ps = [];
  const stage = T ? T.stage : 0;
  const base = team => humTeams.includes(team) ? (humTeams.length > 1 ? 196 : 192) : 186 + stage * 5 + D().spd * 1.2;   // le bot adverse est plus rapide à chaque tour
  for (let team = 0; team < 2; team++) FORMATION.forEach((f, i) => {
    const L = LINEUPS[tIdx[team]][i];
    const mul = speedMul(tIdx, team);
    ps.push({
      team, i, gk: f.role === "gk", role: f.role, num: L.num, name: L.name, skin: L.skin, hair: L.hair, bald: L.bald, napo: !!L.napo, donkey: !!L.donkey,
      hx: 0, hy: 0, x: F.cx, y: F.cy, fx: 1, fy: 0, tx: 0, ty: 0, init: false,
      speed: (mul > 1 ? base(1 - team) : base(team)) * mul, mul,
      dash: 0, holdT: 0, wob: Math.random() * 6, slide: 0, down: 0, stun: 0, slideCD: 0, yellow: 0, off: false, anim: 0,
      dribT: 0, dribCD: 0, hum: null, sta: 1, sprinting: false, diveT: 0, cele: false,
    });
  });
  return ps;
}
// météo du match : beau temps, pluie (le ballon glisse plus) ou nuit
const pickWeather = () => { const r = Math.random(); return r < 0.2 ? "rain" : r < 0.4 ? "night" : "clear"; };
const RAIN = [...Array(140)].map(() => ({ x: Math.random() * 800, y: Math.random() * 500, v: 500 + Math.random() * 300 }));
function drawWeather(dt) {
  if (G.weather === "night") {
    ctx.fillStyle = "rgba(2,5,25,.52)"; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (const [lx, ly] of [[0, 0], [800, 0], [0, 500], [800, 500]]) {
      const g = ctx.createRadialGradient(lx, ly, 10, lx, ly, 420);
      g.addColorStop(0, "rgba(255,250,220,.13)"); g.addColorStop(1, "rgba(255,250,220,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  } else if (G.weather === "rain") {
    ctx.fillStyle = "rgba(25,35,55,.22)"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(200,215,255,.45)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of RAIN) {
      d.y += d.v * dt; d.x -= d.v * 0.18 * dt;
      if (d.y > 510) { d.y = -10; d.x = Math.random() * 860; }
      if (d.x < -10) d.x += 820;
      ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + 3, d.y - 13);
    }
    ctx.stroke();
  }
}
// les joueurs humains du match : { id, name, role, team, ctrl, inp, local, lockT }
function makeHumans(list) {
  return list.map(h => ({ id: h.id || "local", name: h.name || (ME ? ME.name : ""), role: h.role || (ME ? ME.role : ""), team: h.team,
    local: !!h.local, pw: !!h.pw, ctrl: null, inp: { dx: 0, dy: 0, down: false }, lockT: 0, ack: 0 }));
}

function startGame(opp, opts = {}) {
  hideScreens();
  const tIdx = opts.tIdx || [T.me, opp];
  const hum = makeHumans(opts.humans || [{ team: 0, local: true, pw: hasPw() }]);
  const humTeams = [...new Set(hum.map(h => h.team))];
  const me = hum.find(h => h.local) || null;
  G = {
    opp, tIdx, side: me ? me.team : 0, remote: !!opts.remote, live: opts.live || null,
    hum, humTeams, me,
    score: [0, 0], min: 0, period: 0, flip: false, added: null,
    players: makePlayers(tIdx, humTeams), cols: teamColors(tIdx[0], tIdx[1]),
    ref: { x: F.cx, y: F.cy - 9 * PX, fx: 0, fy: 1, anim: 0 }, card: null, foul: null, penDive: null,
    lines: [{ x: F.cx + 20 * PX, y: F.y1 - 16, fx: 0, fy: 1, flagT: 0 }, { x: F.cx - 20 * PX, y: F.y2 + 16, fx: 0, fy: -1, flagT: 0 }],
    freeze: 0, waitT: 0, waitFn: null, restart: null, lastTouch: 0, hintT: 0,
    msg: "", msgT: 0, msgColor: "#fff", msgCard: null, cam: null, netHit: null, fx: [],
    charges: [0, 1].map(t => TEAMS[tIdx[t]].ko || 0),
    ctrl: null, cheer: 0, ended: false, endT: 0, excite: 0, comm: null, cel: null,
    weather: opts.weather || pickWeather(),
  };
  setHomes();
  kickoff(0);
  showGameMsg("COUP D'ENVOI", "#ffd23f", 1.2);
  comment(G.weather === "rain" ? "Il pleut ce soir : attention, le ballon glisse sur la pelouse !" : G.weather === "night" ? "Match en nocturne sous les projecteurs !" : "Coup d'envoi ! Le match commence.");
  whistle();
  startAmbience();
}

function kickoff(team) {
  G.restart = null; G.foul = null; G.card = null;
  for (const p of G.players) {
    p.x = p.hx; p.y = p.hy; p.fx = dirOf(p.team); p.fy = 0;
    p.slide = 0; p.down = 0; p.stun = 0; p.dash = 0;
  }
  const kicker = G.players.find(p => p.team === team && p.i === 9 && !p.off) || G.players.find(p => p.team === team && !p.gk && !p.off);
  kicker.x = F.cx - dirOf(team) * 12; kicker.y = F.cy; kicker.fx = dirOf(team); kicker.fy = 0;
  const mate = G.players.find(p => p.team === team && p.i === 10 && !p.off);
  if (mate) { mate.x = F.cx - dirOf(team) * 3 * PX; mate.y = F.cy + 4 * PX; }
  G.ball = { x: F.cx, y: F.cy, z: 0, vz: 0, vx: 0, vy: 0, owner: kicker, lockT: 0.6, lastKicker: null, kickT: 0, protectT: 0, protectTeam: 0, roll: 0 };
  G.ref.x = F.cx - 6 * PX; G.ref.y = F.cy - 10 * PX;
  G.lastTouch = team;
  G.freeze = 1.2;
  G.hintT = 3;
  for (const h of G.hum) { h.ctrl = null; h.lockT = 0; }
  for (const p of G.players) { p.charge = null; p.dribT = 0; p.cele = false; p.diveT = 0; }
  G.cel = null;
  updateControl();
}

function wait(t, fn) { G.waitT = t; G.waitFn = fn; }
// le commentateur (une phrase en bas de l'écran)
function comment(txt) { if (G) G.comm = { s: txt, t: 2.8 }; }
function showGameMsg(text, color, t = 1.8, card = null) { G.msg = text; G.msgColor = color; G.msgT = t; G.msgCard = card; }
function canAct() { return G && G.freeze <= 0 && G.waitT <= 0 && !G.ended && !G.foul; }
const active = p => p && !p.off && p.down <= 0 && p.slide <= 0 && !p.fly;
const humById = id => G.hum.find(h => h.id === id);

/* ---------- actions ---------- */
function kick(p, tx, ty, speed, loft) {
  const b = G.ball;
  const pen = G.restart && G.restart.taker === p && G.restart.type === "penalty";
  if (!G.passing && speed >= 650 && !loft && !p.gk) comment(pen ? \`\${p.name} s'élance pour le penalty...\` : [\`Frappe de \${p.name} !\`, \`\${p.name} tente sa chance !\`, \`Quelle frappe de \${p.name} !\`][Math.floor(Math.random() * 3)]);
  if (G.restart && G.restart.taker === p) {
    if (G.restart.type === "throw") speed = Math.min(speed, THROW_SPEED);   // une touche se joue à la main, moins fort
    G.restart = null;
  }
  const dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy) || 1;
  b.vx = dx / d * speed; b.vy = dy / d * speed;
  b.z = 0; b.vz = loft || 0;
  b.owner = null; b.lastKicker = p; b.kickT = 0.25; b.lockT = 0;
  b.freeT = 0.14;                                  // le ballon quitte le pied : personne ne peut le toucher tout de suite
  b.target = null; b.isPass = false; b.offs = null;
  G.lastTouch = p.team;
  p.dribT = 0;
  // relance du gardien protégée : l'adversaire ne peut pas l'intercepter tout de suite
  if (p.gk) { b.protectTeam = p.team; b.protectT = 0.5; } else b.protectT = 0;
  // penalty : le gardien choisit un côté au hasard
  if (pen) G.penDive = { team: 1 - p.team, y: F.cy + [-1, 0, 1][Math.floor(Math.random() * 3)] * F.gh * 0.72, t: 1.2 };
  beep(160, 0.06, "triangle", 0.12);
}
function take(p) {
  const b = G.ball;
  b.owner = p; b.vx = 0; b.vy = 0; b.z = 0; b.vz = 0; b.lockT = 0.4; b.target = null; b.isPass = false; b.offs = null;
  G.lastTouch = p.team;
}
// Hors-jeu : les coéquipiers plus près du but adverse que l'avant-dernier défenseur (et que le ballon) au moment de la passe
function offsideLine(team) {           // ligne du hors-jeu pour l'équipe qui attaque
  const d = dirOf(team);
  const xs = G.players.filter(q => q.team !== team && !q.off).map(q => q.x * d).sort((a, b) => b - a);
  return (xs.length > 1 ? xs[1] : xs[0] || 0) * d;
}
function offsideSet(p) {
  const d = dirOf(p.team), line = offsideLine(p.team) * d, bx = G.ball.x * d, half = F.cx * d;
  const set = new Set();
  for (const q of G.players) {
    if (q.team !== p.team || q === p || q.off || q.gk) continue;
    const x = q.x * d;
    if (x > line + 3 && x > bx + 3 && x > half) set.add(q);
  }
  return set;
}
// temps de vol du ballon : passe longue = ballon aérien
const GRAV = 900, AIR_K = 0.75, GROUND_K = 0.38;
function loftKick(p, tx, ty) {
  const d = Math.hypot(tx - G.ball.x, ty - G.ball.y);
  const tf = clamp(d / 620, 0.65, 1.25);
  const v0 = d * Math.log(1 / AIR_K) / (1 - Math.pow(AIR_K, tf)) * 0.93;
  kick(p, tx, ty, Math.min(v0, 1100), GRAV * tf / 2);
}
function passTo(p, q) {
  const d = dist(p, q);
  const human = !!p.hum;
  const rt = G.restart && G.restart.taker === p ? G.restart.type : null;
  const offs = ["throw", "corner", "goalkick"].includes(rt) ? null : offsideSet(p);
  const err = human ? 0 : d * 0.05;                // les bots ne font pas des passes parfaites
  // le receveur court : on vise un peu devant lui
  const lead = q.hum ? 0 : 0.08;
  const qx = q.x + (q.vx || 0) * lead, qy = q.y + (q.vy || 0) * lead;
  const tx = qx + rand(-err, err), ty = qy + rand(-err, err);
  G.passing = true;
  if (d > 330 && rt !== "throw") {                 // passe longue : lobée par-dessus les adversaires
    loftKick(p, tx, ty);
    if (Math.random() < 0.4) comment(\`Long ballon de \${p.name} vers \${q.name}...\`);
  } else {
    kick(p, tx, ty, human ? clamp(d * 1.6 + 220, 380, 900) : clamp(d * 1.25 + 140, 320, 760));
  }
  G.passing = false;
  const b = G.ball;
  b.target = q;                                    // le coéquipier visé vient chercher le ballon
  b.isPass = true; b.humanPass = human;
  b.offs = offs;
}
// le receveur court au-devant du ballon
function meetBall(p, dt, speed) {
  const b = G.ball;
  moveTo(p, b.x + b.vx * 0.12, b.y + b.vy * 0.12, speed, dt);
}

// Direction de déplacement : clic gauche maintenu = le joueur court vers la souris (joystick sur téléphone)
function mouseWorld() {
  const c = (G && G.cam) || { x: 0, y: 0 };
  return { x: c.x + mouse.x / CAM_Z, y: c.y + mouse.y / CAM_Z };
}
function inputDir(p) {
  if (touchMode) return { dx: joy.active ? joy.dx : 0, dy: joy.active ? joy.dy : 0 };
  if (!mouse.down || !p) return { dx: 0, dy: 0 };
  const m = mouseWorld();
  const dx = m.x - p.x, dy = m.y - p.y, d = Math.hypot(dx, dy);
  if (d < 6) return { dx: 0, dy: 0 };
  const s = Math.min(1, d / 30);                 // ralentit en arrivant sur la souris
  return { dx: dx / d * s, dy: dy / d * s };
}

// Tir vers un point (la souris) ; sans point, vers le but adverse. Sans ballon : tacle debout.
function humanShoot(target, noDash) { actShoot(G.me, target, noDash); }
function actShoot(h, target, noDash) {
  if (!canAct() || !h || !active(h.ctrl)) return;
  const p = h.ctrl, team = p.team, b = G.ball;
  if (b.owner === p) {
    const t = target || { x: goalXOf(team) + dirOf(team) * 10, y: F.cy + rand(-30, 30) };
    if (G.restart && G.restart.taker === p && G.restart.type === "corner" && target) { loftKick(p, t.x, t.y); return; }   // corner : centre aérien
    kick(p, t.x + rand(-10, 10), t.y + rand(-10, 10), SHOT_SPEED);
  } else if (b.owner && b.owner.team !== team && !b.owner.gk && !(b.owner.dribT > 0) && dist(p, b.owner) < 28 && b.lockT <= 0) {
    if (Math.random() < 0.55) take(p);          // tacle debout réussi
    else b.lockT = 0.3;
  } else if (!noDash) {
    p.dash = 0.3;                                // petit sprint
  }
}

// Passe directe : au coéquipier le plus proche du point visé, sinon dans la direction du regard (téléphone)
function humanPass(target) { return actPass(G.me, target); }
function actPass(h, target) {
  if (!canAct() || !h || !active(h.ctrl)) return false;
  const p = h.ctrl, team = p.team;
  if (G.ball.owner !== p) return false;
  let best = null, bs = -1e9;
  for (const q of G.players) {
    if (q.team !== team || q === p || q.off || q.fly) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    if (d < 30) continue;
    let score;
    if (target && dist(p, target) > 30) {
      // le coéquipier le plus proche de la direction visée (et du point visé)
      const tx = target.x - p.x, ty = target.y - p.y, tl = Math.hypot(tx, ty);
      const cos = (dx * tx + dy * ty) / (d * tl);
      score = cos * 260 - dist(q, target) * 0.5 - (q.gk ? 200 : 0);
    } else score = (dx * p.fx + dy * p.fy) / d * 100 - d * 0.06 - (q.gk ? 80 : 0);
    if (score > bs) { bs = score; best = q; }
  }
  if (best) { passTo(p, best); return true; }
  return false;
}

// Clic droit : passe si on a le ballon, sinon tacle glissé vers la souris
function actRight(h, target) {
  if (!h || !h.ctrl) return;
  if (G.ball.owner === h.ctrl) actPass(h, target);
  else actTackle(h, target);
}
function actTackle(h, target) {
  if (!canAct() || !h) return;
  const p = h.ctrl;
  if (!active(p) || p.slideCD > 0) return;
  startSlide(p, target || { x: G.ball.x, y: G.ball.y });
}
// Dribble (touche A en AZERTY / Q en QWERTY) : impossible de perdre le ballon pendant 1,5 seconde
function actDribble(h) {
  if (!canAct() || !h || !active(h.ctrl)) return;
  const p = h.ctrl;
  if (G.ball.owner !== p || p.dribCD > 0 || G.restart) return;
  startDribble(p);
}
function startDribble(p) {
  p.dribT = 1.5; p.dribCD = 4;
  G.ball.lockT = Math.max(G.ball.lockT, 0.2);
  G.fx.push({ k: "txt", x: p.x, y: p.y - 50, t: 0.9, s: "DRIBBLE !", c: "#7cf7ff" });
  if (Math.random() < 0.5) comment(\`Joli dribble de \${p.name} !\`);
  beep(620, 0.08, "triangle", 0.06); setTimeout(() => beep(820, 0.08, "triangle", 0.06), 80);
}
// Changer de joueur (touche F) : on prend le coéquipier le plus proche du ballon
function actSwitch(h) {
  if (!G || !h || G.ended) return;
  const b = G.ball, cur = h.ctrl;
  if (cur && b.owner === cur) return;            // on garde le joueur qui a le ballon
  const others = new Set(G.hum.filter(o => o !== h && o.ctrl).map(o => o.ctrl));
  const list = G.players.filter(q => q.team === h.team && !q.gk && !q.off && !q.fly && q !== cur && !others.has(q))
    .sort((a, c) => dist(a, b) - dist(c, b));
  if (!list.length) return;
  h.ctrl = list[0]; h.lockT = 1.3;
  for (const q of G.players) if (q.hum === h) q.hum = null;
  list[0].hum = h;
  beep(980, 0.05, "sine", 0.05);
}
// Napoléon FC : charge à cheval (touche R), 3 fois par match. L'adversaire touché est éjecté du match (pour de faux !)
function actCharge(h) {
  if (!canAct() || !h || !h.ctrl) return;
  let p = h.ctrl;
  const team = p.team;
  if (!(G.charges[team] > 0)) return;
  if (TEAMS[G.tIdx[team]].donkey) {              // Dylan FC : c'est l'âne Dylan Lane qui charge
    const dk = G.players.find(q => q.team === team && q.donkey && !q.off && !q.fly);
    if (!dk) return;
    if (dk.hum !== h) { for (const o of G.hum) if (o.ctrl === dk) o.ctrl = null; for (const q of G.players) if (q.hum === h) q.hum = null; h.ctrl = dk; dk.hum = h; h.lockT = 2; }
    p = dk;
    // il peut éliminer tout le monde... sauf un joueur et le gardien
    if (G.players.filter(q => q.team !== team && !q.gk && !q.off && !q.fly).length <= 1) { if (h.local) showGameMsg("Il ne reste qu'un joueur : l'âne le laisse tranquille !", "#fff", 1.4); return; }
  }
  if (!active(p) || p.charge) return;
  let best = null, bd = 520;
  for (const q of G.players) {
    if (q.team === team || q.off || q.gk || q.fly) continue;
    const d = dist(p, q);
    if (d < bd) { bd = d; best = q; }
  }
  if (!best) { if (h.local) showGameMsg("Aucun adversaire assez près !", "#fff", 1); return; }
  G.charges[team]--;
  p.charge = { tg: best, t: 1.6 };
  showGameMsg(p.donkey ? "💥 RUADE DE DYLAN LANE !" : "⚔ CHARGE DE NAPOLÉON !", "#ffd23f", 1.1);
  beep(330, 0.12, "sawtooth", 0.07); setTimeout(() => beep(440, 0.12, "sawtooth", 0.07), 120); setTimeout(() => beep(660, 0.25, "sawtooth", 0.07), 240);
}
function updateCharge(p, dt) {
  const c = p.charge, q = c.tg;
  c.t -= dt;
  if (q.off || q.fly) { p.charge = null; return; }
  moveTo(p, q.x, q.y, 560, dt);
  if (Math.random() < 0.6) G.fx.push({ k: "dust", x: p.x - p.fx * 14 + rand(-5, 5), y: p.y + rand(-3, 3), t: 0.5 });
  if (dist(p, q) < 24) { knockOut(q, p); p.charge = null; }
  else if (c.t <= 0) { p.charge = null; G.charges[p.team]++; }   // raté : la charge est rendue
}
function knockOut(q, by) {
  const b = G.ball;
  if (b.owner === q) { b.owner = null; b.vx = by.fx * 120; b.vy = by.fy * 120; b.lockT = 0; G.lastTouch = by.team; }
  if (b.target === q) b.target = null;
  const dx = q.x - by.x, dy = q.y - by.y, d = Math.hypot(dx, dy) || 1;
  q.fly = { t: 0, vx: dx / d * 260, vy: dy / d * 260 - 40 };
  q.slide = 0; q.down = 0; q.charge = null;
  for (const h of G.hum) if (h.ctrl === q) h.ctrl = null;
  q.hum = null;
  showGameMsg(\`💫 N°\${q.num} \${q.name} EST K.O. !\`, "#ff9ff3", 1.6);
  crowdSound(0.2);
  beep(200, 0.2, "square", 0.06);
}
function updateFly(q, dt) {
  const f = q.fly;
  f.t += dt;
  q.x += f.vx * dt; q.y += f.vy * dt;
  f.z = Math.sin(Math.min(1, f.t / 1.1) * Math.PI) * 70;
  if (f.t >= 1.1) {
    q.fly = null; q.off = true; q.ko = true;
    G.fx.push({ k: "puff", x: q.x, y: q.y, t: 0.7 });
  }
}

/* ---------- tacle glissé, fautes et cartons ---------- */
function startSlide(p, t) {
  if (!active(p) || p.gk || G.ball.owner === p) return;
  const dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy) || 1;
  p.sdx = dx / d; p.sdy = dy / d; p.fx = p.sdx; p.fy = p.sdy;
  p.slide = 0.42; p.slideV = 340; p.touchedBall = false; p.slideCD = 1.2;
  beep(90, 0.12, "sawtooth", 0.05);
}
function updateSlide(p, dt) {
  p.slide -= dt;
  p.x += p.sdx * p.slideV * dt; p.y += p.sdy * p.slideV * dt;
  p.slideV *= Math.pow(0.2, dt);
  clampPlayer(p);
  const b = G.ball;
  // 1) le ballon d'abord : tacle propre
  if (!p.touchedBall && !(b.owner && (b.owner.team === p.team || b.owner.gk || b.owner.dribT > 0)) && b.z < 12) {
    const foot = { x: p.x + p.sdx * 12, y: p.y + p.sdy * 12 };
    if (dist(foot, b) < 13 || dist(p, b) < 15) {
      p.touchedBall = true;
      const prev = b.owner;
      if (prev) { prev.stun = 0.6; showGameMsg("BEAU TACLE !", "#fff", 0.8); }
      b.owner = null; b.lockT = 0; b.protectT = 0;
      b.vx = p.sdx * 230 + rand(-70, 70); b.vy = p.sdy * 230 + rand(-70, 70);
      b.lastKicker = p; b.kickT = 0.35; G.lastTouch = p.team;
    }
  }
  // 2) un adversaire touché avant le ballon : FAUTE
  if (!p.touchedBall) {
    for (const q of G.players) {
      if (q.team === p.team || q.off || q.down > 0 || q.fly) continue;
      if (q.dribT > 0) continue;                 // le dribbleur saute par-dessus le tacle !
      if (dist(p, q) < 21) { foul(p, q); return; }
    }
  }
  if (p.slide <= 0) { p.slide = 0; p.down = 0.45; }
}
function foul(tackler, victim) {
  const b = G.ball;
  tackler.slide = 0; tackler.down = 0.8;
  victim.down = 9; victim.fx = tackler.sdx || 1; victim.fy = tackler.sdy || 0;
  if (b.owner && b.owner !== victim) { b.owner.stun = 0; }
  b.owner = null; b.vx = 0; b.vy = 0;
  G.restart = null;
  G.foul = {
    t: 0, stage: 0, tackler, victim, team: victim.team, pos: { x: victim.x, y: victim.y },
    penalty: inBox(victim, ownXOf(tackler.team)), red: tackler.yellow + 1 >= 2,
  };
  whistle();
  showGameMsg("FAUTE !", "#fff", 1);
  comment(\`Faute de \${tackler.name} sur \${victim.name}.\`);
}
function sendOff(p) {
  p.off = true; p.slide = 0; p.down = 0;
  for (const h of G.hum) if (h.ctrl === p) h.ctrl = null;
  p.hum = null;
}
function updateFoul(dt) {
  const f = G.foul, r = G.ref, k = f.tackler;
  f.t += dt;
  if (f.t < 1.0) moveTo(r, k.x + 26, k.y + 4, 270, dt);       // l'arbitre court vers le fautif
  else { r.fx = k.x < r.x ? -1 : 1; r.fy = 0.15; }
  for (const p of G.players) if (p !== f.victim && p.down > 0) p.down -= dt;
  const who = \`N°\${k.num} \${k.name} (\${TEAMS[G.tIdx[k.team]].name})\`;
  if (f.stage === 0 && f.t >= 1.0) {
    f.stage = 1; k.yellow++;
    G.card = "yellow";
    showGameMsg(\`CARTON JAUNE · \${who}\`, "#ffd23f", 1.5, "yellow");
    beep(1500, 0.15, "sine", 0.05);
  }
  if (f.red && f.stage === 1 && f.t >= 2.1) {
    f.stage = 2;
    G.card = "red";
    showGameMsg(\`CARTON ROUGE ! \${who} EXPULSÉ\`, "#ff5252", 1.9, "red");
    whistle();
  }
  if (f.t >= (f.red ? 3.6 : 2.5)) {
    if (f.red) sendOff(k);
    G.card = null; G.foul = null;
    f.victim.down = 0;
    startRestart(f.penalty ? "penalty" : "free", f.team, f.pos.x, f.pos.y, f.victim);
  }
}

/* ---------- touches, corners, 6 mètres, coups francs, penaltys ---------- */
function startRestart(type, team, x, y, prefer) {
  const b = G.ball;
  if (type === "penalty") { x = goalXOf(team) - dirOf(team) * F.spot; y = F.cy; }
  if (type === "free") { x = clamp(x, F.x1 + 4, F.x2 - 4); y = clamp(y, F.y1 + 4, F.y2 - 4); }
  let taker = null;
  if (type === "goalkick") taker = G.players.find(p => p.team === team && p.gk);
  else if (prefer && !prefer.off && prefer.team === team && !prefer.gk) taker = prefer;
  else {
    let bd = 1e9;
    for (const p of G.players) if (p.team === team && !p.gk && !p.off) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; taker = p; }
    }
  }
  // le tireur se place derrière le ballon, tourné vers le but (coup franc, penalty) ou vers le terrain
  let nx = (type === "free" || type === "penalty") ? goalXOf(team) - x : F.cx - x;
  let ny = F.cy - y;
  const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
  taker.x = x - nx * 13; taker.y = y - ny * 13; taker.fx = nx; taker.fy = ny;
  taker.down = 0; taker.slide = 0; taker.stun = 0;
  b.x = x; b.y = y; b.vx = 0; b.vy = 0;
  b.owner = taker; b.lockT = 99; b.kickT = 0; b.protectT = 0;
  G.restart = { type, team, taker, t: 0 };
  G.lastTouch = team;
  if (!taker.gk) {                               // un joueur humain de cette équipe joue la remise en jeu
    const hs = G.hum.filter(h => h.team === team);
    if (hs.length) {
      const h = hs.find(h => h.ctrl === taker) || hs.slice().sort((a, c) => (a.ctrl ? dist(a.ctrl, taker) : 1e9) - (c.ctrl ? dist(c.ctrl, taker) : 1e9))[0];
      for (const o of hs) if (o !== h && o.ctrl === taker) o.ctrl = null;
      h.ctrl = taker; h.lockT = 0.3;
    }
  }
  if (type === "penalty") {                      // tout le monde hors de la surface, gardien sur sa ligne
    const gx = goalXOf(team), d = dirOf(team);
    for (const p of G.players) {
      if (p.off || p === taker) continue;
      if (p.gk && p.team !== team) { p.x = gx - d * 4; p.y = F.cy; continue; }
      if (Math.abs(p.x - gx) < F.boxD + 15) p.x = gx - d * (F.boxD + 18 + Math.random() * 50);
    }
  }
  showGameMsg(RESTART_LABEL[type], "#fff", 1.2);
  if (type === "corner") comment(\`Corner pour \${TEAMS[G.tIdx[team]].name}.\`);
  else if (type === "penalty") comment(\`Penalty pour \${TEAMS[G.tIdx[team]].name} ! Le stade retient son souffle...\`);
  beep(1800, 0.15, "sine", 0.04);
}

// L'IA joue la remise en jeu
function restartKick(p) {
  const r = G.restart, gx = goalXOf(p.team), d = dirOf(p.team);
  if (r.type === "penalty") {
    const side = Math.random() < 0.5 ? -1 : 1;
    kick(p, gx + d * 10, F.cy + side * rand(F.gh * 0.35, F.gh - 6), 800);
  } else if (r.type === "corner") {
    let best = null, bd = 1e9;
    for (const q of G.players) if (q.team === p.team && q !== p && !q.gk && !q.off) {
      const dd = Math.abs(gx - q.x) + Math.abs(q.y - F.cy) * 0.5;
      if (dd < bd) { bd = dd; best = q; }
    }
    const tx = best ? best.x : gx - d * 8 * PX, ty = best ? best.y : F.cy + rand(-60, 60);
    loftKick(p, tx + rand(-20, 20), ty + rand(-20, 20));
  } else if (r.type === "free" && Math.hypot(gx - G.ball.x, F.cy - G.ball.y) < 30 * PX && Math.random() < 0.6) {
    kick(p, gx + d * 10, F.cy + rand(-F.gh + 6, F.gh - 6), SHOT_SPEED);     // coup franc direct
  } else {
    const q = bestPassTarget(p) || G.players.find(m => m.team === p.team && m !== p && !m.gk && !m.off && !m.fly) || G.players.find(m => m.team === p.team && m !== p && !m.off);
    if (q) passTo(p, q); else loftKick(p, F.cx + dirOf(p.team) * 25 * PX, F.cy);   // plus de coéquipier : long ballon devant
  }
}

/* ---------- intelligence artificielle ---------- */
function moveTo(p, tx, ty, speed, dt) {
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
  if (d > 2) {
    const step = Math.min(d, speed * dt);
    p.x += dx / d * step; p.y += dy / d * step;
    p.fx = dx / d; p.fy = dy / d;
  }
  clampPlayer(p);
}
function clampPlayer(p) {
  p.x = clamp(p.x, F.x1 - 25, F.x2 + 25);
  p.y = clamp(p.y, F.y1 - 25, F.y2 + 25);
}
function nearestOpp(p) {
  let best = null, bd = 1e9;
  for (const q of G.players) if (q.team !== p.team && !q.off && !q.fly) { const d = dist(p, q); if (d < bd) { bd = d; best = q; } }
  return { q: best, d: bd };
}
function chasers(team) {           // les 2 joueurs de champ les plus proches du ballon
  const list = G.players.filter(q => q.team === team && !q.gk && !q.off && !q.fly && q.down <= 0);
  list.sort((a, b) => dist(a, G.ball) - dist(b, G.ball));
  return list;
}
const closestToBall = team => chasers(team)[0] || null;
function bestPassTarget(p) {
  const dir = dirOf(p.team);
  const offs = Math.random() < 0.9 ? offsideSet(p) : null;
  let best = null, bs = -1e9;
  for (const q of G.players) {
    if (q.team !== p.team || q === p || q.gk || q.off) continue;
    const d = dist(p, q);
    if (d < 50 || d > 520) continue;
    const free = nearestOpp(q).d;
    let score = (q.x - p.x) * dir * 0.8 + Math.min(free, 130) - d * 0.1;
    if (offs && offs.has(q)) score -= 400;             // il est hors-jeu : on évite
    // un adversaire sur la trajectoire de la passe ?
    for (const o of G.players) {
      if (o.team === p.team || o.off) continue;
      const ux = q.x - p.x, uy = q.y - p.y, t = clamp(((o.x - p.x) * ux + (o.y - p.y) * uy) / (d * d), 0, 1);
      if (t > 0.05 && t < 0.95 && Math.hypot(p.x + ux * t - o.x, p.y + uy * t - o.y) < 28) { score -= 220; break; }
    }
    if (score > bs) { bs = score; best = q; }
  }
  return best;
}
function homeTarget(p, attacking) {
  const b = G.ball, dir = dirOf(p.team);
  const k = p.role === "def" ? 0.42 : p.role === "mid" ? 0.55 : 0.6;
  let tx = p.hx + (b.x - F.cx) * k + (attacking ? dir * (p.role === "fwd" ? 9 : 7) * PX : -dir * 3 * PX);
  let ty = p.hy + (b.y - F.cy) * 0.32;
  if (p.role === "def") tx = dir > 0 ? Math.min(tx, F.cx + 15 * PX) : Math.max(tx, F.cx - 15 * PX);
  else if (G.offLine) {                              // les attaquants restent en jeu (ligne du hors-jeu)
    const lim = G.offLine[p.team];
    tx = dir > 0 ? Math.min(tx, Math.max(lim, b.x) - 8) : Math.max(tx, Math.min(lim, b.x) + 8);
  }
  return { tx: clamp(tx, F.x1 + 30, F.x2 - 30), ty: clamp(ty, F.y1 + 20, F.y2 - 20) };
}

// Quel joueur chaque humain contrôle (le porteur du ballon, le receveur d'une passe, ou le plus proche du ballon)
function updateControl() {
  const b = G.ball;
  for (const team of G.humTeams) {
    const hs = G.hum.filter(h => h.team === team);
    const taken = new Set();
    let special = null;
    if (b.owner && b.owner.team === team && !b.owner.gk) special = b.owner;
    else if (!b.owner && b.target && b.target.team === team && !b.target.off && !b.target.gk && !b.target.fly) special = b.target;
    let sh = null;
    if (special) {
      sh = hs.find(h => h.ctrl === special)
        || (b.lastKicker && b.lastKicker.team === team ? hs.find(h => h.ctrl === b.lastKicker) : null)
        || hs.slice().sort((x, y) => (x.ctrl ? dist(x.ctrl, special) : 1e9) - (y.ctrl ? dist(y.ctrl, special) : 1e9))[0];
      sh.ctrl = special; taken.add(special);
    }
    for (const h of hs) {
      if (h === sh) continue;
      let cur = h.ctrl;
      if (cur && (cur.off || cur.gk || cur.fly || taken.has(cur) || cur.team !== team)) cur = null;
      if (cur && (cur.slide > 0 || cur.down > 0 || cur.charge || h.lockT > 0 || special)) { h.ctrl = cur; taken.add(cur); continue; }
      const best = chasers(team).find(q => !taken.has(q) && !q.fly);
      if (!best) { h.ctrl = cur; if (cur) taken.add(cur); continue; }
      // changement automatique : seulement si un coéquipier est nettement plus près du ballon
      // (beaucoup plus près si le joueur est en train de courir où il veut)
      const margin = humInputLen(h) > 0.2 ? 160 : 45;
      if (!cur || (best !== cur && dist(best, b) < dist(cur, b) - margin)) { if (cur) h.lockT = 0.7; cur = best; }
      h.ctrl = cur; taken.add(cur);
    }
  }
  for (const p of G.players) p.hum = null;
  for (const h of G.hum) if (h.ctrl) h.ctrl.hum = h;
  G.ctrl = G.me ? G.me.ctrl : null;
}

function humanMove(h, p, dt) {
  if (G.restart && G.restart.taker === p) {       // le tireur ne bouge pas pendant une remise en jeu
    if (G.restart.t > 6) restartKick(p);          // trop long : on joue automatiquement
    return;
  }
  const { dx, dy } = h.local ? inputDir(p) : h.inp;
  const len = Math.hypot(dx, dy);
  updateStamina(p, h.local ? sprintHeld() : !!h.inp.sp, len, dt);
  if (len < 0.05 && !G.ball.owner && G.ball.target === p) { meetBall(p, dt, 190 * p.mul); return; }   // aide à la réception
  if (len > 0.1) { p.fx = dx / len; p.fy = dy / len; }
  const sp = humanSpeed(p);
  p.x += dx * sp * dt; p.y += dy * sp * dt;
  clampPlayer(p);
}
const humInputLen = h => { const d = h.local ? inputDir(h.ctrl) : h.inp; return Math.hypot(d.dx, d.dy); };
// vitesse d'un joueur contrôlé (la même chez l'hôte et chez l'invité, pour que ce soit fluide en ligne)
const humanSpeed = (p, hasBall = G.ball.owner === p) => (hasBall ? 185 : 200) * (p.dash > 0 ? 1.5 : 1) * (p.stun > 0 ? 0.5 : 1) * (p.dribT > 0 ? 1.1 : 1) * (p.sprinting ? 1.3 : 1) * (p.mul || 1);
// Sprint (touche Maj, ou joystick poussé à fond) : plus rapide, mais ça fatigue
const KEYS = { shift: false };
window.addEventListener("keydown", e => { if (e.key === "Shift") KEYS.shift = true; });
window.addEventListener("keyup", e => { if (e.key === "Shift") KEYS.shift = false; });
window.addEventListener("blur", () => { KEYS.shift = false; });
const sprintHeld = () => touchMode ? (joy.active && Math.hypot(joy.dx, joy.dy) > 0.95) : KEYS.shift;
function updateStamina(p, want, len, dt) {
  p.sprinting = want && len > 0.3 && p.sta > 0.04;
  if (p.sprinting) p.sta = Math.max(0, p.sta - dt * 0.22);
  else p.sta = Math.min(1, p.sta + dt * (len > 0.3 ? 0.07 : 0.15));
}

function gkAI(p, dt) {
  const b = G.ball;
  const own = ownXOf(p.team), dir = dirOf(p.team);
  if (b.owner === p) {
    if (G.restart) { if (G.restart.t > 1.2) restartKick(p); return; }   // 6 mètres
    p.holdT -= dt;
    if (p.holdT <= 0) {
      const q = bestPassTarget(p) || G.players.find(m => m.team === p.team && !m.gk && !m.off && !m.fly);
      if (q) passTo(p, q); else loftKick(p, F.cx, F.cy);
    }
    return;
  }
  // penalty : plonge du côté choisi
  if (G.penDive && G.penDive.team === p.team && G.penDive.t > 0) { moveTo(p, own + dir * 4, G.penDive.y, 260, dt); return; }
  if (G.restart && G.restart.type === "penalty") { moveTo(p, own + dir * 4, F.cy, 120, dt); return; }
  let tx = own + dir * 2.2 * PX, ty = F.cy + (b.y - F.cy) * 0.45, sp = 150;
  const towardGoal = !b.owner && (b.vx * dir < -350);
  if (towardGoal) {                                // tir vers le but : il plonge sur la trajectoire
    if (!p.diving) {                               // temps de réaction du gardien
      p.diving = true;
      const bot = !teamHuman(p.team);
      p.reactT = rand(0.13, 0.27) / (bot ? D().gkCatch : 1);
    }
    if (p.reactT > 0) { p.reactT -= dt; return; }
    const t = (tx - b.x) / (b.vx || 1);
    ty = b.y + b.vy * Math.max(0, t); sp = 185;
    if (!(p.diveT > 0) && Math.abs(clamp(ty, F.cy - F.gh - 8, F.cy + F.gh + 8) - p.y) > 22 && dist(p, b) < 26 * PX) {   // il plonge !
      p.diveT = 0.6; p.diveDir = ty > p.y ? 1 : -1;
    }
    if (p.diveT > 0) sp = 250;
  } else p.diving = false;
  ty = clamp(ty, F.cy - F.gh - 8, F.cy + F.gh + 8);
  const dBall = Math.abs(b.x - own);
  if (!b.owner && !towardGoal && !G.restart && dBall < 9 * PX && Math.abs(b.y - F.cy) < F.boxW) {   // sort sur un ballon libre
    tx = b.x; ty = b.y; sp = 180;
  }
  // va au contact d'un attaquant qui entre dans la surface de but
  const o = b.owner;
  if (o && o.team !== p.team && Math.abs(o.x - own) < F.boxD * 0.7 && Math.abs(o.y - F.cy) < F.boxW * 0.8) {
    tx = (o.x + b.x) / 2; ty = (o.y + b.y) / 2; sp = 175;
    if (dist(p, b) < 20 && b.lockT <= 0 && !(o.dribT > 0) && Math.random() < 2.2 * dt) take(p), p.holdT = 1;
  }
  moveTo(p, tx, ty, sp, dt);
}

function outfieldAI(p, dt) {
  const b = G.ball, team = p.team, dir = dirOf(team);
  const oppGoalX = goalXOf(team);
  const r = G.restart;
  const sp = p.speed * (p.stun > 0 ? 0.5 : 1) * (1 - 0.07 * Math.min(1, G.min / 120));   // les joueurs se fatiguent en fin de match

  // Remise en jeu en cours
  if (r) {
    if (r.taker === p) { if (r.t > (r.type === "penalty" ? 1.6 : 1.1)) restartKick(p); return; }
    let { tx, ty } = homeTarget(p, team === r.team);
    if (r.type === "corner") {
      const gx = goalXOf(r.team), d = dirOf(r.team);
      if (team === r.team && p.role !== "def") {
        const S = [[6, -5], [6.5, 4], [10, 0], [12, -7], [12, 8], [19, 0]][p.i - 5] || [20, 0];
        tx = gx - d * S[0] * PX; ty = F.cy + S[1] * PX;
      } else if (team !== r.team && p.role !== "fwd") {
        const k = p.i - 1;
        tx = gx - d * (2.5 + (k % 4) * 2.3) * PX; ty = F.cy + ((k % 2) ? -1 : 1) * (2 + Math.floor(k / 2) * 2.2) * PX;
      }
    }
    if (r.type === "penalty") {                      // tout le monde hors de la surface
      const gx = goalXOf(r.team), d = dirOf(r.team);
      if (Math.abs(tx - gx) < F.boxD + 15 && Math.abs(ty - F.cy) < F.boxW + 15) tx = gx - d * (F.boxD + 20);
    } else if (team !== r.team) {                    // l'adversaire doit rester à distance du ballon
      const keep = r.type === "throw" ? 2.5 * PX : DIST_MUR;
      const dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy);
      if (d < keep) { tx = b.x + dx / (d || 1) * keep; ty = b.y + dy / (d || 1) * keep; }
    }
    moveTo(p, tx, ty, sp * 0.9, dt);
    return;
  }

  // Joueur IA avec le ballon
  if (b.owner === p) {
    const dg = Math.hypot(oppGoalX - p.x, F.cy - p.y);
    if (dg < 32 * PX && (Math.random() < 2.0 * dt || dg < 19 * PX)) {
      const err = dg * 0.07;
      kick(p, oppGoalX + dir * 10, F.cy + rand(-(F.gh - 6), F.gh - 6) + rand(-err, err), SHOT_SPEED * rand(0.85, 1));
      return;
    }
    const n = nearestOpp(p);
    if (n.d < 36 && p.dribCD <= 0 && Math.random() < 0.25 * dt * (teamHuman(p.team) ? 1 : D().tackle)) startDribble(p);   // l'IA dribble aussi
    const passRate = n.d < 50 ? 1.6 : p.role === "def" ? 0.9 : p.role === "mid" ? 0.45 : 0.15;
    if (Math.random() < passRate * dt) {
      const q = bestPassTarget(p);
      if (q && (n.d < 50 || (q.x - p.x) * dir > 0)) { passTo(p, q); return; }
    }
    // dribble vers le but en évitant le défenseur le plus proche
    p.wob += dt;
    let tx = oppGoalX, ty = F.cy + Math.sin(p.wob * 1.2) * Math.min(14 * PX, Math.abs(oppGoalX - p.x) * 0.5);
    if (n.q && n.d < 90) {
      const ax = p.x - n.q.x, ay = p.y - n.q.y, al = Math.hypot(ax, ay) || 1;
      tx = p.x + dir * 120 + ax / al * 90; ty = p.y + ay / al * 110;
    }
    moveTo(p, tx, clamp(ty, F.y1 + 15, F.y2 - 15), sp * 0.92, dt);
    return;
  }

  const teamHas = b.owner && b.owner.team === team;
  // Le gardien adverse a le ballon : interdit de le prendre, on recule
  if (b.owner && b.owner.gk && b.owner.team !== team) {
    const k = b.owner, d = dist(p, k);
    if (d < 120) {
      const ax = (p.x - k.x) / (d || 1), ay = (p.y - k.y) / (d || 1);
      moveTo(p, k.x + ax * 130, k.y + ay * 130, sp, dt);
    } else {
      const h = homeTarget(p, false);
      moveTo(p, h.tx, h.ty, sp * 0.8, dt);
    }
    return;
  }
  if (!b.owner && b.target && b.target.team === team) {        // passe en cours vers un coéquipier
    if (p === b.target) { meetBall(p, dt, sp); return; }
    const h = homeTarget(p, true);
    moveTo(p, h.tx, h.ty, sp * 0.8, dt);
    return;
  }
  if (!teamHas) {
    const ch = chasers(team);
    // Le plus proche presse le porteur ou va chercher le ballon
    if (p === ch[0]) {
      moveTo(p, b.x + b.vx * 0.15, b.y + b.vy * 0.15, sp, dt);
      const o = b.owner;
      if (o && o.team !== team && !o.gk) {
        const d = dist(p, o);
        const bot = !teamHuman(team);
        if (d < 70 && d > 22 && p.slideCD <= 0 && p.yellow === 0) {   // tacle glissé (prudent s'il a déjà un jaune)
          const rate = bot ? (0.3 + T.stage * 0.05) * D().tackle : 0.3;
          if (Math.random() < rate * dt) {
            const aimBall = Math.random() < (bot ? 0.75 + D().tackle * 0.06 : 0.8);
            startSlide(p, aimBall ? { x: b.x + o.fx * 6, y: b.y + o.fy * 6 } : { x: o.x, y: o.y });
            p.slideCD = 2.5;
          }
        }
        if (d < 24 && b.lockT <= 0 && p.slide <= 0 && !(o.dribT > 0)) {   // tacle debout (impossible pendant un dribble)
          const rate = bot ? (0.6 + T.stage * 0.15) * D().tackle : 0.6;
          if (Math.random() < rate * dt) take(p);
        }
      }
      return;
    }
    // Le deuxième couvre entre le ballon et son but
    if (p === ch[1] && b.owner) {
      const ox = ownXOf(team), dx = ox - b.x, dy = F.cy - b.y, d = Math.hypot(dx, dy) || 1;
      moveTo(p, b.x + dx / d * 75, b.y + dy / d * 75, sp * 0.9, dt);
      return;
    }
  }
  // Les autres se placent selon le ballon
  const h = homeTarget(p, teamHas);
  moveTo(p, h.tx, h.ty, sp * 0.8, dt);
}

function separate() {
  const ps = G.players;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i], c = ps[j];
    if (a.off || c.off || a.slide > 0 || c.slide > 0 || a.fly || c.fly) continue;
    if (G.restart && (a === G.restart.taker || c === G.restart.taker)) continue;
    const dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy);
    if (d > 0 && d < 18) {
      const push = (18 - d) / 2;
      a.x -= dx / d * push; a.y -= dy / d * push;
      c.x += dx / d * push; c.y += dy / d * push;
    }
  }
}

/* ---------- arbitre ---------- */
function updateRef(dt) {
  const r = G.ref, b = G.ball;
  let tx = b.x - Math.sign((b.x - F.cx) || 1) * 7 * PX, ty = b.y + (b.y < F.cy ? 9 : -9) * PX;
  tx = clamp(tx, F.x1 + 25, F.x2 - 25); ty = clamp(ty, F.y1 + 25, F.y2 - 25);
  const d = Math.hypot(tx - r.x, ty - r.y);
  if (d > 30) moveTo(r, tx, ty, Math.min(195, 60 + d * 0.7), dt);
  else { const lx = b.x - r.x, ly = b.y - r.y, ll = Math.hypot(lx, ly) || 1; r.fx = lx / ll; r.fy = ly / ll; }
}

/* ---------- ballon, buts et sorties ---------- */
function updateBall(dt) {
  const b = G.ball;
  const attRight = dirOf(0) > 0 ? 0 : 1;          // équipe qui attaque le but de droite

  if (b.owner) {
    const o = b.owner;
    b.z = 0; b.vz = 0;
    // ballon collé au pied ; pendant un dribble il tourne autour des pieds
    const wig = o.dribT > 0 ? Math.sin(o.dribT * 16) * 6 : 0;
    const nx = o.x + o.fx * 12 - o.fy * wig, ny = o.y + o.fy * 12 + o.fx * wig;
    b.roll += Math.hypot(nx - b.x, ny - b.y) / 4.5;
    b.x = nx; b.y = ny;
    if (G.restart) return;
    const inMouth = Math.abs(b.y - F.cy) < F.gh;
    if (b.x > F.x2 && inMouth) return goal(attRight);
    if (b.x < F.x1 && inMouth) return goal(1 - attRight);
    if (b.y < F.y1 || b.y > F.y2 || b.x < F.x1 || b.x > F.x2) {   // le porteur sort le ballon du terrain
      b.owner = null; b.vx = o.fx * 30; b.vy = o.fy * 30; G.lastTouch = o.team;
      return;
    }
    // un joueur contrôlé par un humain touche le ballon d'un adversaire (pas du gardien, pas pendant un dribble) = il le récupère
    if (!o.gk && b.lockT <= 0 && !(o.dribT > 0)) {
      for (const q of G.players) {
        if (q.team !== o.team && q.hum && active(q) && q.stun <= 0 && dist(q, b) < 14) { take(q); break; }
      }
    }
    return;
  }

  // ballon libre : il roule (ou vole s'il a été lobé)
  b.x += b.vx * dt; b.y += b.vy * dt;
  b.roll += Math.hypot(b.vx, b.vy) * dt / 4.5;
  if (b.z > 0 || b.vz > 0) {
    b.vz -= GRAV * dt; b.z += b.vz * dt;
    if (b.z <= 0) { b.z = 0; b.vz = b.vz < -160 ? -b.vz * 0.3 : 0; }   // petit rebond
  }
  const f = Math.pow(b.z > 2 ? AIR_K : (G.weather === "rain" ? 0.47 : GROUND_K), dt);   // sous la pluie, le ballon glisse plus loin
  b.vx *= f; b.vy *= f;

  // Sortie sur le côté = touche pour l'équipe qui n'a pas touché le ballon en dernier
  if (b.y < F.y1 || b.y > F.y2) {
    return startRestart("throw", 1 - G.lastTouch, clamp(b.x, F.x1 + 10, F.x2 - 10), b.y < F.y1 ? F.y1 : F.y2);
  }
  // Ligne de but : but, corner ou 6 mètres
  if (b.x > F.x2 || b.x < F.x1) {
    const right = b.x > F.x2;
    const scorer = right ? attRight : 1 - attRight;
    const defender = 1 - scorer;
    if (Math.abs(b.y - F.cy) < F.gh && b.z < 34) return goal(scorer);   // sous la barre (2,44 m)
    const lineX = right ? F.x2 : F.x1;
    if (Math.abs(b.y - F.cy) < F.gh + 30 && Math.abs(b.y - F.cy) > F.gh - 4 && b.z < 34) beep(900, 0.06, "square", 0.04);   // poteau !
    if (G.lastTouch === defender) return startRestart("corner", scorer, lineX, b.y < F.cy ? F.y1 : F.y2);
    if (Math.abs(b.y - F.cy) < F.boxW) G.excite = Math.max(G.excite, 0.7);              // "ooooh" du public
    return startRestart("goalkick", defender, lineX + (right ? -F.sixD : F.sixD), F.cy + (b.y < F.cy ? -1 : 1) * F.sixW * 0.6);
  }

  const speed = Math.hypot(b.vx, b.vy);
  if (b.freeT > 0) return;
  const lk = b.lastKicker;
  const tgt = b.isPass && b.target && !b.target.off && !b.target.fly ? b.target : null;
  // passe directe : quand le ballon arrive près du coéquipier visé, il le contrôle
  if (tgt && b.z < 16 && tgt.down <= 0 && tgt.slide <= 0 && dist(tgt, b) < 30) return receive(tgt);
  // le joueur le plus proche du ballon le prend (en cas d'égalité, un vrai joueur est prioritaire)
  let p = null, pd = 1e9;
  for (const q of G.players) {
    if (q.off || q.fly || q.down > 0 || q.slide > 0 || q.stun > 0 || q.charge) continue;
    if (q === lk && b.kickT > 0) continue;
    if (b.protectT > 0 && q.team !== b.protectTeam) continue;
    if (q.missT > 0) continue;
    const hi = q.gk ? 30 : 13;                     // ballon trop haut : seul le gardien peut l'attraper
    if (b.z > hi) continue;
    if (!b.isPass && lk && q.team === lk.team && !q.gk && speed > 450) continue;   // un tir passe entre ses coéquipiers
    const mate = b.isPass && lk && lk.team === q.team && !q.gk;   // coéquipier de celui qui a passé
    if (mate && tgt && q !== tgt && b.humanPass) continue;           // passe d'un humain : seul le coéquipier visé la reçoit
    const opp = b.isPass && lk && lk.team !== q.team;
    const reach = mate ? 17 : q.gk ? 19 : opp ? 11 : 13;
    const d = dist(q, b) - (teamHuman(q.team) ? 2 : 0);
    if (d < reach && d < pd) { pd = d; p = q; }
  }
  if (p && !p.gk && lk && lk.team !== p.team && p.slide <= 0 &&
      ((speed > 420 && Math.random() < 0.5) || (b.isPass && b.humanPass && tgt && Math.random() < 0.55))) {
    p.missT = 0.35; p = null;                      // l'adversaire rate l'interception, le ballon passe
  }
  if (p) {
    if (p.gk && speed > 300) {
      let catchChance = speed > 650 ? 0.33 : 0.55;
      if (!teamHuman(p.team)) catchChance = Math.min(0.95, catchChance * D().gkCatch);   // gardien du bot selon la difficulté
      if (Math.random() < catchChance) { take(p); p.holdT = 1; G.excite = Math.max(G.excite, 0.6); comment(\`Arrêt de \${p.name} ! Il capte le ballon.\`); showGameMsg("ARRÊT !", G.me && G.me.team === p.team && !G.remote ? "#2ecc71" : "#fff", 1); }
      else {                                       // il repousse le ballon sur le côté
        b.lastKicker = p; b.kickT = 0.3; p.missT = 0.5; G.lastTouch = p.team; b.isPass = false; b.target = null;
        b.vx *= -0.25; b.vy = (Math.random() < 0.5 ? -1 : 1) * rand(220, 360); b.z = 0; b.vz = 120;
        G.excite = Math.max(G.excite, 0.8);
        showGameMsg("PARADE !", "#fff", 0.8);
        comment(\`Superbe parade de \${p.name} !\`);
      }
    } else if (!p.gk && speed > 520 && !(b.isPass && lk && lk.team === p.team) && Math.random() < 0.7) {
      // ballon trop rapide : il touche le joueur et est dévié
      b.lastKicker = p; b.kickT = 0.25; G.lastTouch = p.team; b.isPass = false; b.target = null;
      b.vx = b.vx * 0.55 + rand(-120, 120); b.vy = b.vy * 0.55 + rand(-120, 120);
    } else {
      receive(p);
    }
  }
}
// un joueur reçoit le ballon (avec la règle du hors-jeu)
function receive(p) {
  const b = G.ball;
  if (b.offs && b.offs.has(p) && b.lastKicker && b.lastKicker.team === p.team) return offside(p);
  if (b.isPass && b.lastKicker && b.lastKicker.team !== p.team && !p.gk && Math.random() < 0.6) comment(\`Interception de \${p.name} !\`);
  take(p);
  if (p.gk) p.holdT = 1;
}
function offside(p) {
  const b = G.ball;
  b.owner = null; b.vx = 0; b.vy = 0; b.z = 0; b.vz = 0; b.offs = null;
  whistle();
  const ln = G.lines[(p.x > F.cx) ? 0 : 1];      // le juge de touche lève son drapeau
  ln.flagT = 2.2;
  showGameMsg("🚩 HORS-JEU !", "#ffd23f", 1.6);
  comment(\`\${p.name} était hors-jeu, le drapeau se lève.\`);
  wait(1.1, () => startRestart("free", 1 - p.team, p.x, p.y));
}

function goal(team) {
  G.score[team]++;
  const b = G.ball;
  const lk = b.lastKicker;
  G.netHit = { right: b.x > F.cx, y: clamp(b.y, F.cy - F.gh + 4, F.cy + F.gh - 4), t: 1 };
  b.owner = null; b.vx = 0; b.vy = 0; b.z = 0; b.vz = 0;
  b.x = b.x > F.cx ? F.x2 + 14 : F.x1 - 14;
  G.restart = null;
  G.cheer = 2.5; G.excite = 1;
  const who = lk && lk.team === team && !lk.off ? \` \${lk.name}\` : lk && lk.team !== team ? " (contre son camp)" : "";
  // célébration : le buteur court vers le poteau de corner, ses coéquipiers le rejoignent
  const sc = lk && lk.team === team && !lk.off && !lk.gk ? lk : G.players.find(q => q.team === team && !q.off && !q.gk);
  G.cel = { sc, team, cx: b.x > F.cx ? F.x2 - 12 : F.x1 + 12, cy: sc && sc.y < F.cy ? F.y1 + 12 : F.y2 - 12 };
  for (const q of G.players) q.cele = q.team === team && !q.off;
  comment(lk && lk.team === team ? \`BUUUUT ! \${lk.name} fait trembler les filets !\` : "Oh non ! Un but contre son camp !");
  const mine = G.me && G.me.team === team;
  if (G.remote || !G.me) { showGameMsg(\`⚽ BUT \${TEAMS[G.tIdx[team]].name.toUpperCase()} !\${who}\`, "#ffd23f", 2.2); crowdSound(0.3); }
  else if (mine) { showGameMsg(\`⚽ BUT !!!\${who}\`, "#2ecc71", 2.2); crowdSound(0.3); }
  else { showGameMsg(\`But adverse...\${who}\`, "#e74c3c", 2); beep(120, 0.3, "sawtooth", 0.04); }
  wait(2.2, () => kickoff(1 - team));
}

function periodEnd() {
  const p = G.period;
  G.min = PERIOD_END[p] + (G.added || 0);
  G.added = null;
  G.restart = null; G.foul = null; G.card = null;
  G.ball.owner = null; G.ball.vx = 0; G.ball.vy = 0;
  whistle(); setTimeout(whistle, 300);
  const draw = G.score[0] === G.score[1];
  if (p === 3 || (p === 1 && !draw)) {           // fin du match
    G.ended = true; G.endT = 2.5;
    showGameMsg("FIN DU MATCH", "#ffd23f", 2.5);
    setTimeout(whistle, 650);
    return;
  }
  showGameMsg(["MI-TEMPS", "PROLONGATIONS !", "MI-TEMPS (PROL.)"][p], "#ffd23f", 2.6);
  G.period++;
  wait(2.6, () => {
    G.min = PERIOD_END[G.period - 1];
    G.flip = !G.flip;                            // changement de côté
    setHomes();
    kickoff(G.period % 2 === 1 ? 1 : 0);
  });
}
function updateCelebration(dt) {
  const c = G.cel;
  for (const p of G.players) {
    if (p.off || p.fly) continue;
    stepFree(p);
    if (p === c.sc) moveTo(p, c.cx, c.cy, 220, dt);
    else if (p.team === c.team && !p.gk && c.sc) {
      const d = dist(p, c.sc);
      if (d > 30) moveTo(p, c.sc.x, c.sc.y, 200, dt);
    } else if (p.team !== c.team && !p.gk) {                       // l'équipe qui a encaissé repart déçue vers son camp
      moveTo(p, p.hx, p.hy, 55, dt);
    }
  }
  separate();
  if (c.sc) { G.ball.x = c.cx > F.cx ? F.x2 + 14 : F.x1 - 14; }
}
const stepFree = p => { p.down = 0; p.slide = 0; };
// minute affichée : 45+2' pendant le temps additionnel
function clockText(min, period) {
  const end = PERIOD_END[period];
  return min > end + 0.01 ? \`\${end}+\${Math.ceil(min - end)}'\` : \`\${Math.floor(min)}'\`;
}

/* ---------- boucle du match ---------- */
function updateGame(dt) {
  if (G.msgT > 0) G.msgT -= dt;
  if (G.cheer > 0) G.cheer -= dt;
  if (G.comm && G.comm.t > 0) G.comm.t -= dt;
  if (G.hintT > 0 && canAct()) G.hintT -= dt;
  if (G.netHit) { G.netHit.t -= dt * 0.8; if (G.netHit.t <= 0) G.netHit = null; }
  for (const l of G.lines) if (l.flagT > 0) l.flagT -= dt;
  updateFx(dt);
  updateAmbience(dt);

  if (G.ended) { G.endT -= dt; if (G.endT <= 0) endGame(); return; }
  if (G.waitT > 0) {
    if (G.cel) updateCelebration(dt);
    G.waitT -= dt;
    if (G.waitT <= 0) { const f = G.waitFn; G.waitFn = null; if (f) f(); }
    return;
  }
  if (G.foul) { updateFoul(dt); return; }
  if (G.freeze > 0) { G.freeze -= dt; return; }

  G.min += dt * 90 / MATCH_LEN;
  const end = PERIOD_END[G.period];
  if (G.added == null && G.min >= end - 1) {       // temps additionnel annoncé à la dernière minute
    G.added = G.period < 2 ? 1 + Math.floor(Math.random() * 3) : Math.floor(Math.random() * 2);
    if (G.added > 0) G.fx.push({ k: "board", t: 3.5, n: G.added });
  }
  if (G.min >= end + (G.added || 0)) { periodEnd(); return; }

  const b = G.ball;
  if (b.lockT > 0) b.lockT -= dt;
  if (b.kickT > 0) b.kickT -= dt;
  if (b.protectT > 0) b.protectT -= dt;
  if (b.freeT > 0) b.freeT -= dt;
  if (G.penDive) { G.penDive.t -= dt; if (G.penDive.t <= 0) G.penDive = null; }
  if (G.restart) G.restart.t += dt;
  for (const h of G.hum) if (h.lockT > 0) h.lockT -= dt;
  G.offLine = [offsideLine(0), offsideLine(1)];
  updateControl();
  for (const p of G.players) {
    if (p.off) continue;
    if (p.fly) { updateFly(p, dt); continue; }
    if (p.dash > 0) p.dash -= dt;
    if (p.stun > 0) p.stun -= dt;
    if (p.missT > 0) p.missT -= dt;
    if (p.slideCD > 0) p.slideCD -= dt;
    if (p.dribCD > 0) p.dribCD -= dt;
    if (p.diveT > 0) p.diveT -= dt;
    if (p.dribT > 0) { p.dribT -= dt; if (b.owner !== p) p.dribT = 0; }
    if (p.slide > 0) { updateSlide(p, dt); if (G.foul) return; continue; }
    if (p.down > 0) { p.down -= dt; continue; }
    if (p.charge) { updateCharge(p, dt); continue; }
    const ox = p.x, oy = p.y;
    if (p.hum) humanMove(p.hum, p, dt);
    else if (p.gk) gkAI(p, dt);
    else outfieldAI(p, dt);
    p.vx = (p.x - ox) / dt; p.vy = (p.y - oy) / dt;
  }
  separate();
  updateBall(dt);
  updateRef(dt);
  updateLinesmen(dt);
}
// les juges de touche suivent la ligne du hors-jeu, chacun dans sa moitié de terrain
function updateLinesmen(dt) {
  const attR = dirOf(0) > 0 ? 0 : 1;               // équipe qui attaque vers la droite
  const top = G.lines[0], bot = G.lines[1];
  const xr = clamp(Math.max(G.offLine[attR], G.ball.x), F.cx, F.x2), xl = clamp(Math.min(G.offLine[1 - attR], G.ball.x), F.x1, F.cx);
  if (top.flagT <= 0) moveTo(top, xr, F.y1 - 16, 210, dt);
  if (bot.flagT <= 0) moveTo(bot, xl, F.y2 + 16, 210, dt);
  top.fx = 0; top.fy = 1; bot.fx = 0; bot.fy = -1;
}

function endGame() {
  const [a, b] = G.score;
  const et = G.period >= 2;
  const live = G.remote, tIdx = G.tIdx, L = G.live;
  stopAmbience();
  G = null;
  if (live) return liveGameOver(a, b, et, tIdx, L);   // match en direct : l'hôte envoie le résultat
  if (a !== b) { endWatchers(); finishMatch({ a, b, et }); return; }
  pendingScore = { a, b };
  hideScreens();
  $("dText").textContent = \`\${TEAMS[T.me].name} \${a} - \${b} \${TEAMS[oppNow()].name} après prolongations.\`;
  $("drawScreen").classList.remove("hidden");
}

/* =========================================================
   DESSIN DU MATCH : terrain, joueurs, arbitre, caméra
   ========================================================= */
function updateCam() {
  const vw = W / CAM_Z, vh = H / CAM_Z, b = G.ball;
  const tx = clamp(b.x - vw / 2, F.x1 - 150, F.x2 + 150 - vw);
  const ty = clamp(b.y - vh / 2 - 15, F.y1 - 150, F.y2 + 140 - vh);
  if (!G.cam) G.cam = { x: tx, y: ty };
  const k = Math.min(1, frameDT * 3.5);
  G.cam.x += (tx - G.cam.x) * k; G.cam.y += (ty - G.cam.y) * k;
}

// tribunes : un motif de supporters (dessiné une seule fois) répété tout autour du terrain
let CROWD_PAT = null;
function crowdPattern() {
  if (CROWD_PAT) return CROWD_PAT;
  const c = document.createElement("canvas"); c.width = 240; c.height = 72;
  const g = c.getContext("2d");
  g.fillStyle = "#1a2433"; g.fillRect(0, 0, 240, 72);
  for (let row = 0; row < 6; row++) {
    g.fillStyle = row % 2 ? "#222e40" : "#1d283a"; g.fillRect(0, row * 12, 240, 12);
    for (let i = 0; i < 24; i++) {
      const x = i * 10 + (row % 2) * 5 + Math.random() * 2, y = row * 12 + 6;
      g.fillStyle = \`hsl(\${Math.floor(Math.random() * 360)},\${50 + Math.random() * 30}%,\${35 + Math.random() * 30}%)\`;
      g.fillRect(x - 3, y - 1, 6, 6);                                  // maillot du supporter
      g.fillStyle = SKINS[Math.floor(Math.random() * SKINS.length)];
      g.beginPath(); g.arc(x, y - 3, 2.6, 0, Math.PI * 2); g.fill();  // tête
    }
  }
  CROWD_PAT = ctx.createPattern(c, "repeat");
  return CROWD_PAT;
}
function drawStands() {
  const pat = crowdPattern();
  const jump = G.cheer > 0 ? Math.abs(Math.sin(performance.now() / 90)) * 3 : 0;
  ctx.save();
  ctx.translate(0, -jump);
  ctx.fillStyle = pat;
  ctx.fillRect(F.x1 - 400, F.y1 - 420, F.x2 - F.x1 + 800, 350);          // tribune du haut
  ctx.fillRect(F.x1 - 400, F.y2 + 72, F.x2 - F.x1 + 800, 380);           // tribune du bas
  ctx.fillRect(F.x1 - 420, F.y1 - 70, 350, F.y2 - F.y1 + 142);           // derrière les buts
  ctx.fillRect(F.x2 + 70, F.y1 - 70, 350, F.y2 - F.y1 + 142);
  ctx.restore();
  // bordure en béton entre le public et le terrain
  ctx.fillStyle = "#3a4250";
  ctx.fillRect(F.x1 - 72, F.y1 - 72, F.x2 - F.x1 + 144, 6); ctx.fillRect(F.x1 - 72, F.y2 + 66, F.x2 - F.x1 + 144, 6);
  ctx.fillRect(F.x1 - 72, F.y1 - 72, 6, F.y2 - F.y1 + 144); ctx.fillRect(F.x2 + 66, F.y1 - 72, 6, F.y2 - F.y1 + 144);
}
function drawPitch() {
  // tribunes, puis pelouse et bandes de tonte
  drawStands();
  ctx.fillStyle = "#246b31"; ctx.fillRect(F.x1 - 66, F.y1 - 66, F.x2 - F.x1 + 132, F.y2 - F.y1 + 132);
  const n = 20, sw = (F.x2 - F.x1) / n;
  for (let i = -2; i < n + 2; i++) {
    ctx.fillStyle = (i + 20) % 2 ? "#2e8a3e" : "#35984a";
    ctx.fillRect(F.x1 + i * sw, F.y1 - 45, sw + 0.5, F.y2 - F.y1 + 90);
  }
  // panneaux publicitaires
  const boards = (x, y, w, h, vertical) => {
    const seg = 150;
    const len = vertical ? h : w;
    for (let s = 0; s < len; s += seg) {
      ctx.fillStyle = (s / seg) % 2 ? "#0d4d8c" : (compOf() === COMPS.cl ? "#0a1a4a" : "#b8001f");
      if (vertical) ctx.fillRect(x, y + s, w, Math.min(seg, len - s)); else ctx.fillRect(x + s, y, Math.min(seg, len - s), h);
    }
    ctx.save();
    ctx.fillStyle = "#fff"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const txt = compOf().board;
    for (let s = seg / 2; s < len; s += seg) {
      if (vertical) { ctx.save(); ctx.translate(x + w / 2, y + s); ctx.rotate(-Math.PI / 2); ctx.fillText(txt, 0, 0); ctx.restore(); }
      else ctx.fillText(txt, x + s, y + h / 2);
    }
    ctx.restore();
  };
  boards(F.x1 - 40, F.y1 - 62, F.x2 - F.x1 + 80, 16, false);
  boards(F.x1 - 40, F.y2 + 46, F.x2 - F.x1 + 80, 16, false);
  boards(F.x1 - 62, F.y1 - 30, 16, F.y2 - F.y1 + 60, true);
  boards(F.x2 + 46, F.y1 - 30, 16, F.y2 - F.y1 + 60, true);

  // lignes
  ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2.2;
  ctx.strokeRect(F.x1, F.y1, F.x2 - F.x1, F.y2 - F.y1);
  ctx.beginPath(); ctx.moveTo(F.cx, F.y1); ctx.lineTo(F.cx, F.y2); ctx.stroke();
  ctx.beginPath(); ctx.arc(F.cx, F.cy, F.circle, 0, Math.PI * 2); ctx.stroke();
  const a = Math.acos((F.boxD - F.spot) / F.circle);
  for (const side of [1, -1]) {
    const gx = side > 0 ? F.x1 : F.x2;
    ctx.strokeRect(side > 0 ? gx : gx - F.boxD, F.cy - F.boxW, F.boxD, F.boxW * 2);
    ctx.strokeRect(side > 0 ? gx : gx - F.sixD, F.cy - F.sixW, F.sixD, F.sixW * 2);
    const sx = gx + side * F.spot;
    ctx.beginPath();
    if (side > 0) ctx.arc(sx, F.cy, F.circle, -a, a); else ctx.arc(sx, F.cy, F.circle, Math.PI - a, Math.PI + a);
    ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(sx, F.cy, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(F.cx, F.cy, 3, 0, Math.PI * 2); ctx.fill();
  // arcs et drapeaux de corner
  for (const cx of [F.x1, F.x2]) for (const cy of [F.y1, F.y2]) {
    const a0 = cx === F.x1 ? (cy === F.y1 ? 0 : -Math.PI / 2) : (cy === F.y1 ? Math.PI / 2 : Math.PI);
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, PX, a0, a0 + Math.PI / 2); ctx.stroke();
    ctx.strokeStyle = "#eee"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 22); ctx.stroke();
    ctx.fillStyle = "#ffd23f";
    ctx.beginPath(); ctx.moveTo(cx, cy - 22); ctx.lineTo(cx + (cx === F.x1 ? 11 : -11), cy - 18); ctx.lineTo(cx, cy - 14); ctx.fill();
  }
}

function drawGoals(front) {
  // les buts (filets derrière la ligne)
  const depth = 2.4 * PX;
  for (const side of [1, -1]) {
    const gx = side > 0 ? F.x1 : F.x2, bx = gx - side * depth;
    const x0 = Math.min(gx, bx);
    if (!front) {
      // le filet se gonfle quand le ballon y entre
      const nh = G.netHit && G.netHit.right === (side < 0) ? G.netHit : null;
      const bulge = y => nh ? Math.exp(-((y - nh.y) ** 2) / 500) * 14 * nh.t * (0.6 + 0.4 * Math.sin(nh.t * 18)) : 0;
      const back = y => bx - side * bulge(y);
      ctx.fillStyle = "rgba(255,255,255,.18)";
      ctx.beginPath(); ctx.moveTo(gx, F.cy - F.gh);
      for (let y = F.cy - F.gh; y <= F.cy + F.gh + 0.1; y += 4) ctx.lineTo(back(y), y);
      ctx.lineTo(gx, F.cy + F.gh); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let y = F.cy - F.gh; y <= F.cy + F.gh; y += 7) { ctx.moveTo(gx, y); ctx.lineTo(back(y), y); }
      for (let k = 0; k <= 1.001; k += 7 / depth) {
        ctx.moveTo(gx + (bx - gx) * k, F.cy - F.gh);
        for (let y = F.cy - F.gh; y <= F.cy + F.gh + 0.1; y += 4) ctx.lineTo(gx + (back(y) - gx) * k, y);
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 4; ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(gx, F.cy - F.gh); ctx.lineTo(bx, F.cy - F.gh); ctx.lineTo(bx, F.cy + F.gh); ctx.lineTo(gx, F.cy + F.gh);
      ctx.stroke();
      ctx.lineCap = "butt";
    }
  }
}

// Un joueur dessiné comme une personne (vue de 3/4 : on voit la tête, le maillot, le short et les jambes)
function drawPerson(o) {
  const { x, y } = o;
  const side = Math.abs(o.fx) > Math.abs(o.fy) * 0.9;
  const back = !side && o.fy < 0;               // vu de dos
  const dirX = o.fx >= 0 ? 1 : -1;
  const sw = o.mv * Math.sin(o.anim);
  ctx.lineCap = "round";
  // ombre
  if (!o.noShadow) {
    ctx.fillStyle = "rgba(0,0,0,.3)";
    ctx.beginPath(); ctx.ellipse(x, y + 1, 9, 3.5, 0, 0, Math.PI * 2); ctx.fill();
  }
  // jambes
  const leg = (hx, fx, fy) => {
    ctx.strokeStyle = o.skin; ctx.lineWidth = 3.4;
    ctx.beginPath(); ctx.moveTo(hx, y - 13); ctx.lineTo(fx, fy - 1); ctx.stroke();
    ctx.strokeStyle = o.kit.socks; ctx.lineWidth = 3.6;
    ctx.beginPath(); ctx.moveTo(hx + (fx - hx) * 0.5, y - 13 + (fy - y + 12) * 0.5); ctx.lineTo(fx, fy - 1); ctx.stroke();
    ctx.fillStyle = "#151515";
    ctx.beginPath(); ctx.ellipse(fx + (side ? dirX * 1.2 : 0), fy - 0.5, side ? 2.8 : 2.1, 1.6, 0, 0, Math.PI * 2); ctx.fill();
  };
  if (side) {
    leg(x - dirX * 1, x - dirX * sw * 5, y - Math.max(0, -sw) * 2);
    leg(x + dirX * 1, x + dirX * sw * 5, y - Math.max(0, sw) * 2);
  } else {
    leg(x - 3, x - 3.2, y - Math.max(0, sw) * 3);
    leg(x + 3, x + 3.2, y - Math.max(0, -sw) * 3);
  }
  // short
  ctx.fillStyle = o.kit.shorts;
  rr(x - (side ? 5 : 6.5), y - 17.5, side ? 10 : 13, 6, 2); ctx.fill();
  // bras (derrière le corps quand on est de profil)
  const arm = (sx, hx, hy) => {
    ctx.strokeStyle = o.kit.shirt; ctx.lineWidth = 3.4;
    ctx.beginPath(); ctx.moveTo(sx, y - 26); ctx.lineTo(sx + (hx - sx) * 0.45, y - 26 + (hy - y + 26) * 0.45); ctx.stroke();
    ctx.strokeStyle = o.skin; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(sx + (hx - sx) * 0.45, y - 26 + (hy - y + 26) * 0.45); ctx.lineTo(hx, hy); ctx.stroke();
    if (o.gloves) { ctx.fillStyle = "#f5f5f5"; ctx.beginPath(); ctx.arc(hx, hy, 2.2, 0, Math.PI * 2); ctx.fill(); }
  };
  if (side) arm(x, x - dirX * sw * 5, y - 17);
  // maillot
  ctx.fillStyle = o.kit.shirt;
  rr(x - (side ? 5.5 : 7.5), y - 29, side ? 11 : 15, 13, 4); ctx.fill();
  if (o.kit.deco) {                              // rayures, cerceaux ou bande du maillot
    const d = o.kit.deco, sx = x - (side ? 5.5 : 7.5), sw2 = side ? 11 : 15;
    ctx.save(); rr(sx, y - 29, sw2, 13, 4); ctx.clip();
    ctx.fillStyle = d.c;
    if (d.k === "v") for (let k = 1.5; k < sw2; k += 4) ctx.fillRect(sx + k, y - 29, 1.8, 13);
    else if (d.k === "h") for (let k = 2; k < 13; k += 4) ctx.fillRect(sx, y - 29 + k, sw2, 1.8);
    else if (d.k === "half") ctx.fillRect(x, y - 29, sw2, 13);
    else if (d.k === "band") ctx.fillRect(x - 2, y - 29, 4, 13);
    ctx.restore();
  }
  ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.lineWidth = 0.8;
  rr(x - (side ? 5.5 : 7.5), y - 29, side ? 11 : 15, 13, 4); ctx.stroke();
  if (!side && o.armsUp) {                       // bras levés (célébration)
    arm(x - 7, x - 6, y - 45);
    arm(x + 7, x + 6, y - 45);
  } else if (!side) {
    arm(x - 7, x - 8.5, y - 17.5 - sw * 1.5);
    arm(x + 7, x + 8.5, y - 17.5 + sw * 1.5);
  } else if (o.card) {
    arm(x + dirX * 2, x + dirX * 4, y - 41);                // l'arbitre lève le bras
  }
  // numéro sur le maillot
  if (o.num != null) {
    ctx.fillStyle = o.kit.num; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = \`bold \${back ? 9 : 6}px sans-serif\`;
    ctx.fillText(String(o.num), x + (side ? dirX * 0.5 : 0), y - (back ? 22 : 23));
    ctx.textBaseline = "alphabetic";
  }
  // tête et cheveux
  const hy = y - 33.5;
  ctx.fillStyle = o.skin;
  ctx.beginPath(); ctx.arc(x, hy, 5.2, 0, Math.PI * 2); ctx.fill();
  if (!o.bald) {
    ctx.fillStyle = o.hair;
    if (back) { ctx.beginPath(); ctx.arc(x, hy - 0.3, 5.3, 0, Math.PI * 2); ctx.fill(); }
    else if (side) {
      ctx.beginPath(); ctx.arc(x, hy - 0.8, 5.4, Math.PI, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x - dirX * 1.8, hy, 4, 0, Math.PI * 2); ctx.fill();
    } else { ctx.beginPath(); ctx.arc(x, hy - 1.2, 5.4, Math.PI * 1.02, Math.PI * 1.98); ctx.fill(); }
  }
  if (!back) {                                   // yeux
    ctx.fillStyle = "#1a1a1a";
    if (side) { ctx.beginPath(); ctx.arc(x + dirX * 2.6, hy + 0.3, 0.75, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(x - 1.9, hy + 0.4, 0.75, 0, Math.PI * 2); ctx.arc(x + 1.9, hy + 0.4, 0.75, 0, Math.PI * 2); ctx.fill(); }
  }
  // carton de l'arbitre
  if (o.card) {
    ctx.fillStyle = o.card === "red" ? "#e52521" : "#ffd400";
    ctx.save(); ctx.translate(x + (side ? dirX * 4 : 9), y - 47); ctx.rotate(0.15);
    ctx.fillRect(-3, -4.5, 6, 9); ctx.strokeStyle = "rgba(0,0,0,.4)"; ctx.lineWidth = 0.6; ctx.strokeRect(-3, -4.5, 6, 9);
    ctx.restore();
  }
  ctx.lineCap = "butt";
}

// Un joueur au sol (tacle glissé ou faute subie)
function drawLying(o, ang) {
  ctx.save();
  ctx.translate(o.x, o.y); ctx.rotate(ang);
  ctx.lineCap = "round";
  ctx.fillStyle = "rgba(0,0,0,.3)";
  ctx.beginPath(); ctx.ellipse(0, 3, 19, 6, 0, 0, Math.PI * 2); ctx.fill();
  for (const s of [-1, 1]) {                     // jambes tendues vers l'avant
    ctx.strokeStyle = o.skin; ctx.lineWidth = 3.4;
    ctx.beginPath(); ctx.moveTo(0, s * 2.5); ctx.lineTo(13, s * 3.5 + (s > 0 ? 2 : 0)); ctx.stroke();
    ctx.strokeStyle = o.kit.socks; ctx.lineWidth = 3.6;
    ctx.beginPath(); ctx.moveTo(7, s * 3); ctx.lineTo(13, s * 3.5 + (s > 0 ? 2 : 0)); ctx.stroke();
    ctx.fillStyle = "#151515"; ctx.beginPath(); ctx.ellipse(15, s * 3.5 + (s > 0 ? 2 : 0), 2.4, 1.7, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = o.kit.shorts; rr(-5, -6, 7, 12, 2); ctx.fill();
  ctx.fillStyle = o.kit.shirt; rr(-17, -7, 13, 14, 4); ctx.fill();
  ctx.strokeStyle = o.kit.shirt; ctx.lineWidth = 3.2;
  ctx.beginPath(); ctx.moveTo(-14, -6); ctx.lineTo(-20, -11); ctx.moveTo(-14, 6); ctx.lineTo(-19, 11); ctx.stroke();
  ctx.fillStyle = o.skin; ctx.beginPath(); ctx.arc(-22, 0, 5, 0, Math.PI * 2); ctx.fill();
  if (!o.bald) { ctx.fillStyle = o.hair; ctx.beginPath(); ctx.arc(-23.5, 0, 4.4, Math.PI * 0.5, Math.PI * 1.5); ctx.fill(); }
  ctx.restore();
  ctx.lineCap = "butt";
}

function stepAnim(e) {
  const dx = e.x - (e.px ?? e.x), dy = e.y - (e.py ?? e.y), d = Math.hypot(dx, dy);
  e.px = e.x; e.py = e.y;
  e.anim = (e.anim || 0) + Math.min(d, 8) * 0.33;
  e.mv = d > 0.15 ? Math.min(1, (e.mv || 0) + 0.25) : Math.max(0, (e.mv || 0) - 0.12);
}

// couleur de l'anneau sous un joueur contrôlé par un humain
function humColor(h) {
  if (!h) return "#fff";
  if (G.me && h === G.me) return "#ffd23f";
  if (G.me && h.team === G.me.team) return "#5ce1ff";
  return "#ff7aa8";
}
const roleIcon = r => r === "createur" ? "👑 " : r === "admin" ? "🛡️ " : "";

function drawPlayer(p) {
  stepAnim(p);
  const kit = kitOf(p);
  const look = { x: p.x, y: p.y, fx: p.fx, fy: p.fy, anim: p.anim, mv: p.mv, kit, skin: p.skin, hair: p.hair, bald: p.bald, num: p.num, gloves: p.gk, hi: p.i };
  // anneau sous le joueur contrôlé (jaune = toi, bleu = ton coéquipier humain, rose = l'adversaire)
  if (p.hum && !p.fly) {
    ctx.strokeStyle = humColor(p.hum); ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, p.napo || p.donkey ? 18 : 13, p.napo || p.donkey ? 6 : 5, 0, 0, Math.PI * 2); ctx.stroke();
  }
  if (p.dribT > 0 && !p.fly) {                   // dribble : tourbillon autour du joueur
    ctx.strokeStyle = "rgba(124,247,255,.8)"; ctx.lineWidth = 1.6;
    const a0 = performance.now() / 90;
    for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(p.x, p.y - 4, 15 + k * 2, a0 + k * 2, a0 + k * 2 + 1.2); ctx.stroke(); }
  }
  if (p === G.ctrl && G.me && p.sta < 0.99 && !p.fly) {     // barre d'endurance (sprint)
    ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(p.x - 12, p.y + 7, 24, 4);
    ctx.fillStyle = p.sta > 0.35 ? "#2ecc71" : p.sta > 0.15 ? "#f1c40f" : "#e74c3c"; ctx.fillRect(p.x - 12, p.y + 7, 24 * p.sta, 4);
  }
  if (p.fly) return drawFlying(p, look);
  if (p.napo && p.slide <= 0 && p.down <= 0) return drawRider(look, p.gk);
  if (p.donkey && p.slide <= 0 && p.down <= 0) return drawDonkey(look);
  if (p.gk && p.diveT > 0 && !p.napo && !p.donkey) return drawLying(look, -(p.diveDir || 1) * Math.PI / 2);   // plongeon du gardien
  if (p.cele && !p.napo && !p.donkey && p.slide <= 0 && p.down <= 0) look.armsUp = true;                      // joie après un but
  if (p.slide > 0) drawLying(look, Math.atan2(p.fy, p.fx));
  else if (p.down > 0) drawLying(look, Math.atan2(p.fy, p.fx) + Math.PI / 2);
  else drawPerson(look);
}
// joueur éjecté par une charge de Napoléon (il s'envole avec des étoiles, comme dans un dessin animé)
function drawFlying(p, look) {
  const f = p.fly, z = f.z || 0, t = f.t || 0;
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, 9 * (1 - z / 140), 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.translate(p.x, p.y - z - 18); ctx.rotate(t * 11);
  drawPerson(Object.assign({}, look, { x: 0, y: 18, noShadow: true, armsUp: true, fx: 0, fy: 1 }));
  ctx.restore();
  ctx.fillStyle = "#ffe14d"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
  for (let k = 0; k < 3; k++) { const a = t * 8 + k * 2.1; ctx.fillText("★", p.x + Math.cos(a) * 14, p.y - z - 40 + Math.sin(a) * 5); }
}

// Napoléon à cheval (avec son célèbre chapeau, le bicorne)
const HORSES = ["#7a4a25", "#5a3418", "#2b1d14", "#a0673a", "#8a5a33", "#6b4226"];
function drawBicorne(x, y, side, dirX) {
  const w = side ? 6.5 : 9.5;
  ctx.fillStyle = "#121212";
  ctx.beginPath();
  ctx.moveTo(x - w, y + 1.5); ctx.quadraticCurveTo(x, y - 9, x + w, y + 1.5); ctx.quadraticCurveTo(x, y - 1.2, x - w, y + 1.5);
  ctx.fill();
  ctx.strokeStyle = "#c9a227"; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(x - w, y + 1.5); ctx.quadraticCurveTo(x, y - 9, x + w, y + 1.5); ctx.stroke();
  const cx = x + (side ? dirX * 1.5 : 3), cy = y - 2.6;          // cocarde bleu blanc rouge
  ctx.fillStyle = "#1d3c8f"; ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(cx, cy, 1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#d81e2c"; ctx.beginPath(); ctx.arc(cx, cy, 0.5, 0, Math.PI * 2); ctx.fill();
}
function drawRider(o, gk) {
  const { x, y } = o;
  const side = Math.abs(o.fx) > Math.abs(o.fy) * 0.6;
  const dirX = o.fx >= 0 ? 1 : -1;
  const back = !side && o.fy < 0;
  const sw = (o.mv || 0) * Math.sin((o.anim || 0) * 1.3);
  const coat = o.kit.shirt, horse = gk ? "#e9e4dc" : HORSES[(o.hi || 0) % HORSES.length];
  const mane = gk ? "#9a948a" : "#1a1008";
  ctx.lineCap = "round";
  ctx.fillStyle = "rgba(0,0,0,.3)";
  ctx.beginPath(); ctx.ellipse(x, y + 1, side ? 17 : 9, side ? 4 : 6, 0, 0, Math.PI * 2); ctx.fill();
  if (side) {
    const legs = [[8, 1], [5, -1], [-7, -1], [-10, 1]];
    ctx.strokeStyle = horse; ctx.lineWidth = 2.6;
    for (const [lx, ph] of legs) { ctx.beginPath(); ctx.moveTo(x + dirX * lx, y - 12); ctx.lineTo(x + dirX * (lx + sw * ph * 4.5), y - 1.5); ctx.stroke(); }
    ctx.fillStyle = "#1b1b1b";
    for (const [lx, ph] of legs) ctx.fillRect(x + dirX * (lx + sw * ph * 4.5) - 1.4, y - 2.2, 2.8, 2);
    ctx.strokeStyle = mane; ctx.lineWidth = 2.6;                                      // queue
    ctx.beginPath(); ctx.moveTo(x - dirX * 12, y - 17); ctx.quadraticCurveTo(x - dirX * 19, y - 14 + sw * 2, x - dirX * 16, y - 6); ctx.stroke();
    ctx.fillStyle = horse;                                                             // corps
    ctx.beginPath(); ctx.ellipse(x - dirX, y - 15.5, 13, 6.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + dirX * 6, y - 20); ctx.lineTo(x + dirX * 13, y - 29); ctx.lineTo(x + dirX * 17, y - 27); ctx.lineTo(x + dirX * 12, y - 13); ctx.closePath(); ctx.fill();   // cou
    ctx.save(); ctx.translate(x + dirX * 17, y - 27); ctx.rotate(dirX * 0.55);
    ctx.beginPath(); ctx.ellipse(dirX * 2.5, 0, 5.4, 2.7, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();          // tête
    ctx.beginPath(); ctx.moveTo(x + dirX * 13.5, y - 29); ctx.lineTo(x + dirX * 14.2, y - 33.5); ctx.lineTo(x + dirX * 15.8, y - 29.6); ctx.fill();   // oreille
    ctx.strokeStyle = mane; ctx.lineWidth = 2.2;                                     // crinière
    ctx.beginPath(); ctx.moveTo(x + dirX * 6, y - 22); ctx.lineTo(x + dirX * 13, y - 30); ctx.stroke();
    ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(x + dirX * 17.6, y - 28.4, 0.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#8b0000"; ctx.fillRect(x - 5.5, y - 22, 10, 3.2);              // tapis de selle
    ctx.fillStyle = "#e8c45a"; ctx.fillRect(x - 5.5, y - 19.3, 10, 0.8);
    ctx.strokeStyle = "#f4f4f4"; ctx.lineWidth = 3;                                   // jambe du cavalier
    ctx.beginPath(); ctx.moveTo(x, y - 23); ctx.lineTo(x + dirX * 2, y - 17); ctx.stroke();
    ctx.strokeStyle = "#111"; ctx.beginPath(); ctx.moveTo(x + dirX * 2, y - 17); ctx.lineTo(x + dirX * 2.6, y - 12.5); ctx.stroke();
    ctx.fillStyle = coat; rr(x - 4.6, y - 35, 9.2, 13.5, 3); ctx.fill();            // manteau
    ctx.fillStyle = "#f4f4f4"; ctx.fillRect(x + (dirX > 0 ? 1.4 : -3.4), y - 34, 2, 9.5);
    ctx.strokeStyle = coat; ctx.lineWidth = 2.6;                                      // la main dans le manteau !
    ctx.beginPath(); ctx.moveTo(x, y - 32); ctx.lineTo(x + dirX * 3, y - 28); ctx.stroke();
    ctx.fillStyle = o.skin; ctx.beginPath(); ctx.arc(x + dirX * 0.6, y - 38.5, 4.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1a1a1a"; ctx.beginPath(); ctx.arc(x + dirX * 2.5, y - 38.3, 0.65, 0, Math.PI * 2); ctx.fill();
    drawBicorne(x + dirX * 0.4, y - 42, true, dirX);
  } else {
    // vu de face ou de dos
    ctx.strokeStyle = horse; ctx.lineWidth = 2.8;
    for (const lx of [-4, 4]) for (const k of [0, 1]) {
      const yy = k ? y - 3 : y;
      ctx.beginPath(); ctx.moveTo(x + lx * 0.9, yy - 13); ctx.lineTo(x + lx, yy - 1 - Math.max(0, (k ? sw : -sw)) * 3); ctx.stroke();
    }
    ctx.fillStyle = horse; ctx.beginPath(); ctx.ellipse(x, y - 15, 7, 9, 0, 0, Math.PI * 2); ctx.fill();
    if (back) {
      ctx.strokeStyle = mane; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.quadraticCurveTo(x + sw * 3, y - 6, x, y - 3); ctx.stroke();
    } else {
      ctx.fillStyle = horse; ctx.beginPath(); ctx.ellipse(x, y - 9, 3.4, 6.5, 0, 0, Math.PI * 2); ctx.fill();   // tête vers nous
      ctx.fillStyle = "#f4f4f4"; ctx.fillRect(x - 0.8, y - 13, 1.6, 7);                                       // liste blanche
      ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(x - 2.4, y - 12, 0.7, 0, Math.PI * 2); ctx.arc(x + 2.4, y - 12, 0.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#8b0000"; ctx.fillRect(x - 6, y - 23, 12, 3);
    ctx.strokeStyle = "#111"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x - 6, y - 21); ctx.lineTo(x - 7, y - 14); ctx.moveTo(x + 6, y - 21); ctx.lineTo(x + 7, y - 14); ctx.stroke();
    ctx.fillStyle = coat; rr(x - 5.5, y - 35.5, 11, 14, 3.5); ctx.fill();
    if (!back) { ctx.fillStyle = "#f4f4f4"; ctx.fillRect(x - 1.6, y - 35, 3.2, 10); }
    ctx.strokeStyle = coat; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(x - 5, y - 33); ctx.lineTo(x - 6.5, y - 26); ctx.moveTo(x + 5, y - 33); ctx.lineTo(x + 2, y - 29); ctx.stroke();
    ctx.fillStyle = o.skin; ctx.beginPath(); ctx.arc(x, y - 39, 4.4, 0, Math.PI * 2); ctx.fill();
    if (!back) { ctx.fillStyle = "#1a1a1a"; ctx.beginPath(); ctx.arc(x - 1.6, y - 38.8, 0.65, 0, Math.PI * 2); ctx.arc(x + 1.6, y - 38.8, 0.65, 0, Math.PI * 2); ctx.fill(); }
    drawBicorne(x, y - 42.5, false, dirX);
  }
  ctx.lineCap = "butt";
}

// Dylan Lane, l'âne avant-centre du Dylan FC (avec son maillot n°9 sur le dos)
function drawDonkey(o) {
  const { x, y } = o;
  const side = Math.abs(o.fx) > Math.abs(o.fy) * 0.6;
  const dirX = o.fx >= 0 ? 1 : -1;
  const back = !side && o.fy < 0;
  const sw = (o.mv || 0) * Math.sin((o.anim || 0) * 1.4);
  const fur = "#9b948c", dark = "#5f5953", belly = "#e9e4dc", shirt = o.kit.shirt;
  ctx.lineCap = "round";
  ctx.fillStyle = "rgba(0,0,0,.3)";
  ctx.beginPath(); ctx.ellipse(x, y + 1, side ? 15 : 8, side ? 4 : 5.5, 0, 0, Math.PI * 2); ctx.fill();
  if (side) {
    const legs = [[7, 1], [4.5, -1], [-6, -1], [-8.5, 1]];
    ctx.strokeStyle = fur; ctx.lineWidth = 2.6;
    for (const [lx, ph] of legs) { ctx.beginPath(); ctx.moveTo(x + dirX * lx, y - 10); ctx.lineTo(x + dirX * (lx + sw * ph * 4), y - 1.5); ctx.stroke(); }
    ctx.fillStyle = "#222";
    for (const [lx, ph] of legs) ctx.fillRect(x + dirX * (lx + sw * ph * 4) - 1.4, y - 2.2, 2.8, 2);
    ctx.strokeStyle = dark; ctx.lineWidth = 1.6;                                     // queue avec son pompon
    ctx.beginPath(); ctx.moveTo(x - dirX * 11, y - 15); ctx.quadraticCurveTo(x - dirX * 15, y - 12 + sw * 2, x - dirX * 14, y - 7); ctx.stroke();
    ctx.fillStyle = "#2b2622"; ctx.beginPath(); ctx.ellipse(x - dirX * 14, y - 6, 1.8, 2.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(x, y - 14, 11.5, 5.6, 0, 0, Math.PI * 2); ctx.fill();   // corps
    ctx.fillStyle = belly; ctx.beginPath(); ctx.ellipse(x, y - 11, 8, 2.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = shirt; rr(x - 6, y - 19.5, 12, 7, 2.5); ctx.fill();               // maillot sur le dos
    ctx.fillStyle = o.kit.num; ctx.font = "bold 5.5px sans-serif"; ctx.textAlign = "center"; ctx.fillText("9", x, y - 14);
    ctx.fillStyle = fur;                                                               // cou et grosse tête
    ctx.beginPath(); ctx.moveTo(x + dirX * 6, y - 18); ctx.lineTo(x + dirX * 11, y - 26); ctx.lineTo(x + dirX * 15, y - 24); ctx.lineTo(x + dirX * 11, y - 13); ctx.closePath(); ctx.fill();
    ctx.save(); ctx.translate(x + dirX * 15, y - 24); ctx.rotate(dirX * 0.6);
    ctx.beginPath(); ctx.ellipse(dirX * 2.5, 0, 6, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = belly; ctx.beginPath(); ctx.ellipse(dirX * 6.5, 0.5, 2.6, 2.6, 0, 0, Math.PI * 2); ctx.fill();   // museau blanc
    ctx.restore();
    ctx.fillStyle = fur; ctx.strokeStyle = dark; ctx.lineWidth = 0.6;                 // les grandes oreilles
    for (const k of [0, 1]) {
      ctx.save(); ctx.translate(x + dirX * (11.5 + k * 1.5), y - 28); ctx.rotate(dirX * (-0.35 + k * 0.3) + Math.sin((o.anim || 0) * 0.7) * 0.08);
      ctx.beginPath(); ctx.ellipse(0, -5, 1.6, 5.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
    }
    ctx.strokeStyle = "#2b2622"; ctx.lineWidth = 2;                                    // crinière
    ctx.beginPath(); ctx.moveTo(x + dirX * 6, y - 20); ctx.lineTo(x + dirX * 11, y - 27); ctx.stroke();
    ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(x + dirX * 16, y - 25.6, 0.85, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.strokeStyle = fur; ctx.lineWidth = 2.6;
    for (const lx of [-3.5, 3.5]) for (const k of [0, 1]) {
      const yy = k ? y - 3 : y;
      ctx.beginPath(); ctx.moveTo(x + lx * 0.9, yy - 11); ctx.lineTo(x + lx, yy - 1 - Math.max(0, (k ? sw : -sw)) * 3); ctx.stroke();
    }
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(x, y - 14, 6.5, 8.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = shirt; rr(x - 5.5, y - 20, 11, 9, 3); ctx.fill();
    if (back) {
      ctx.fillStyle = o.kit.num; ctx.font = "bold 7px sans-serif"; ctx.textAlign = "center"; ctx.fillText("9", x, y - 13);
      ctx.strokeStyle = "#2b2622"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + sw * 2, y - 2); ctx.stroke();
    }
    const hy = back ? y - 25 : y - 22;
    ctx.fillStyle = fur; ctx.strokeStyle = dark; ctx.lineWidth = 0.6;
    for (const s2 of [-1, 1]) { ctx.save(); ctx.translate(x + s2 * 3, hy - 6); ctx.rotate(s2 * 0.35); ctx.beginPath(); ctx.ellipse(0, -5, 1.8, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore(); }
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(x, hy, 4.8, 6, 0, 0, Math.PI * 2); ctx.fill();
    if (!back) {
      ctx.fillStyle = belly; ctx.beginPath(); ctx.ellipse(x, hy + 4, 3.4, 2.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(x - 2, hy - 1.5, 0.8, 0, Math.PI * 2); ctx.arc(x + 2, hy - 1.5, 0.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x - 1, hy + 4.4, 0.45, 0, Math.PI * 2); ctx.arc(x + 1, hy + 4.4, 0.45, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.lineCap = "butt";
}

function drawLabel(p) {
  if (p.fly) return;
  const lying = p.slide > 0 || p.down > 0;
  const y = p.y - (lying ? 20 : p.napo ? 52 : p.donkey ? 44 : 45);
  const me = p === G.ctrl;
  const txt = \`\${p.num} \${p.name}\`;
  ctx.font = \`bold \${me ? 8 : 7}px sans-serif\`; ctx.textAlign = "center";
  ctx.lineWidth = 2.6; ctx.strokeStyle = "rgba(0,0,0,.75)";
  ctx.strokeText(txt, p.x, y);
  ctx.fillStyle = p.hum ? humColor(p.hum) : "#fff";
  if (p.hum && !me) ctx.fillStyle = p.hum.team === (G.me ? G.me.team : -1) ? "#b8f2ff" : "#ffb3cd";
  ctx.fillText(txt, p.x, y);
  if (p.yellow > 0) {                            // carton jaune reçu
    const w = ctx.measureText(txt).width;
    ctx.fillStyle = "#ffd400"; ctx.fillRect(p.x + w / 2 + 2, y - 6, 3.5, 5);
  }
  // le nom du vrai joueur au-dessus de celui qu'il contrôle
  if (p.hum && p.hum.name && (G.hum.length > 1 || G.view)) {
    const nm = roleIcon(p.hum.role) + p.hum.name;
    ctx.font = "bold 8px sans-serif";
    const w = ctx.measureText(nm).width + 8;
    ctx.fillStyle = "rgba(0,0,0,.6)"; rr(p.x - w / 2, y - 21, w, 11, 5); ctx.fill();
    ctx.fillStyle = humColor(p.hum); ctx.fillText(nm, p.x, y - 12.5);
  } else if (me) {
    ctx.fillStyle = "#ffd23f";
    ctx.beginPath(); ctx.moveTo(p.x - 4, y - 13); ctx.lineTo(p.x + 4, y - 13); ctx.lineTo(p.x, y - 8); ctx.fill();
  }
}

function drawBallW() {
  const b = G.ball;
  const sp = b.owner ? 0 : Math.hypot(b.vx, b.vy);
  const air = b.z || 0;
  const z = air > 0 ? air : clamp((sp - 380) / 35, 0, 11);   // un tir puissant décolle un peu
  const r = 4.5 + Math.min(2.5, air / 30);                    // un ballon haut paraît plus gros
  const sh = 1 - Math.min(0.5, z / 90);
  ctx.fillStyle = \`rgba(0,0,0,\${0.32 * sh})\`;
  ctx.beginPath(); ctx.ellipse(b.x + 1 + z * 0.3, b.y + 2, 4.5 * sh, 2.2 * sh, 0, 0, Math.PI * 2); ctx.fill();
  const by = b.y - z - 3;
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(b.x, by, r, 0, Math.PI * 2); ctx.fill();
  // le ballon tourne sur lui-même quand il roule
  const o = b.owner;
  const ang = o ? Math.atan2(o.fy, o.fx) : Math.atan2(b.vy, b.vx);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  ctx.save(); ctx.beginPath(); ctx.arc(b.x, by, r, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = "#222";
  const roll = (b.roll || 0) / (Math.PI * 2);
  for (let k = 0; k < 4; k++) {
    const u = (roll + k / 4 + (k % 2) * 0.12) % 1;
    const s = (u * 2 - 1) * r * 1.3, perp = (k % 2 ? 1 : -1) * r * (k > 1 ? 0.15 : 0.6);
    ctx.beginPath(); ctx.arc(b.x + ca * s - sa * perp, by + sa * s + ca * perp, r * 0.34, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = "#333"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(b.x, by, r, 0, Math.PI * 2); ctx.stroke();
}

/* ---------- petits effets : poussière, nuage, textes ---------- */
function updateFx(dt) {
  if (!G.fx.length) return;
  for (const f of G.fx) { f.t -= dt; if (f.k === "txt") f.y -= 25 * dt; }
  G.fx = G.fx.filter(f => f.t > 0);
}
function drawFxWorld() {
  for (const f of G.fx) {
    if (f.k === "dust") { ctx.fillStyle = \`rgba(150,115,70,\${f.t})\`; ctx.beginPath(); ctx.arc(f.x, f.y, 4 + (0.5 - f.t) * 10, 0, Math.PI * 2); ctx.fill(); }
    else if (f.k === "puff") {
      ctx.fillStyle = \`rgba(255,255,255,\${Math.min(1, f.t * 1.6)})\`;
      for (let k = 0; k < 6; k++) { const a = k * 1.05; ctx.beginPath(); ctx.arc(f.x + Math.cos(a) * (0.7 - f.t) * 30, f.y - 12 + Math.sin(a) * (0.7 - f.t) * 20, 7, 0, Math.PI * 2); ctx.fill(); }
    } else if (f.k === "txt") {
      ctx.font = "900 11px sans-serif"; ctx.textAlign = "center"; ctx.globalAlpha = Math.min(1, f.t * 2);
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.strokeText(f.s, f.x, f.y);
      ctx.fillStyle = f.c; ctx.fillText(f.s, f.x, f.y); ctx.globalAlpha = 1;
    }
  }
}
function drawFxScreen() {
  for (const f of G.fx) if (f.k === "board") {      // panneau du temps additionnel
    ctx.fillStyle = "#111"; rr(358, 70, 84, 40, 6); ctx.fill();
    ctx.strokeStyle = "#555"; ctx.lineWidth = 2; rr(358, 70, 84, 40, 6); ctx.stroke();
    ctx.fillStyle = "#3dff6e"; ctx.font = "900 28px monospace"; ctx.textAlign = "center";
    ctx.fillText("+" + f.n, 400, 100);
  }
}

/* ---------- ambiance du stade (bruit de foule qui monte près des buts) ---------- */
let AMB = null;
function startAmbience() {
  if (!AC || AMB) return;
  try {
    const len = AC.sampleRate * 3, buf = AC.createBuffer(1, len, AC.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.04 * (Math.random() * 2 - 1)) / 1.04; d[i] = last * 3.2 + (Math.random() * 2 - 1) * 0.08; }
    const src = AC.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = AC.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 520; f.Q.value = 0.6;
    const g = AC.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(AC.destination); src.start();
    AMB = { src, g };
  } catch (e) { AMB = null; }
}
function updateAmbience(dt) {
  if (!G) return;
  G.excite = Math.max(0, (G.excite || 0) - dt * 0.45);
  if (!AMB) return;
  const b = G.ball, dg = Math.min(Math.abs(b.x - F.x1), Math.abs(b.x - F.x2));
  const near = clamp(1 - dg / (28 * PX), 0, 1);
  AMB.g.gain.setTargetAtTime(0.05 + near * 0.05 + G.excite * 0.12, AC.currentTime, 0.35);
}
function stopAmbience() {
  if (!AMB) return;
  const a = AMB; AMB = null;
  try { a.g.gain.setTargetAtTime(0, AC.currentTime, 0.15); setTimeout(() => { try { a.src.stop(); } catch (e) {} }, 700); } catch (e) {}
}

function drawMinimap() {
  const mw = 170, mh = mw * (F.y2 - F.y1) / (F.x2 - F.x1), mx = 400 - mw / 2, my = H - mh - 8;
  const sx = v => mx + (v - F.x1) / (F.x2 - F.x1) * mw, sy = v => my + (v - F.y1) / (F.y2 - F.y1) * mh;
  ctx.fillStyle = "rgba(0,0,0,.45)"; rr(mx - 4, my - 4, mw + 8, mh + 8, 6); ctx.fill();
  ctx.fillStyle = "rgba(46,138,62,.85)"; ctx.fillRect(mx, my, mw, mh);
  ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.lineWidth = 1;
  ctx.strokeRect(mx, my, mw, mh);
  ctx.beginPath(); ctx.moveTo(mx + mw / 2, my); ctx.lineTo(mx + mw / 2, my + mh); ctx.stroke();
  ctx.strokeRect(mx, sy(F.cy - F.boxW), F.boxD / (F.x2 - F.x1) * mw, F.boxW * 2 / (F.y2 - F.y1) * mh);
  ctx.strokeRect(mx + mw - F.boxD / (F.x2 - F.x1) * mw, sy(F.cy - F.boxW), F.boxD / (F.x2 - F.x1) * mw, F.boxW * 2 / (F.y2 - F.y1) * mh);
  for (const p of G.players) {
    if (p.off) continue;
    ctx.fillStyle = p.gk ? G.cols[p.team].gk : G.cols[p.team].fill;
    ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), p.hum ? 3 : 2.2, 0, Math.PI * 2); ctx.fill();
    if (p.hum) { ctx.strokeStyle = humColor(p.hum); ctx.lineWidth = 1.2; ctx.stroke(); }
  }
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(sx(G.ball.x), sy(G.ball.y), 2, 0, Math.PI * 2); ctx.fill();
  if (G.cam) {
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1;
    ctx.strokeRect(sx(G.cam.x), sy(G.cam.y), (W / CAM_Z) / (F.x2 - F.x1) * mw, (H / CAM_Z) / (F.y2 - F.y1) * mh);
  }
}

function drawGame() {
  updateCam();
  ctx.fillStyle = "#1a2433"; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.scale(CAM_Z, CAM_Z);
  ctx.translate(-G.cam.x, -G.cam.y);
  drawPitch();
  drawGoals(false);

  // zone à respecter pendant une remise en jeu
  const r = G.restart;
  if (r && r.type !== "penalty" && r.type !== "goalkick") {
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(G.ball.x, G.ball.y, r.type === "throw" ? 2.5 * PX : DIST_MUR, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  // joueurs, arbitres et ballon dessinés du fond vers l'avant
  const ents = [];
  for (const p of G.players) if (!p.off) ents.push({ y: p.y, p });
  ents.push({ y: G.ref.y, ref: true });
  for (const l of G.lines) ents.push({ y: l.y, line: l });
  ents.push({ y: G.ball.y + 0.5, ball: true });
  ents.sort((a, b) => a.y - b.y);
  const rc = G.cols[2].ref;
  for (const e of ents) {
    if (e.ball) drawBallW();
    else if (e.ref) {
      const rf = G.ref; stepAnim(rf);
      drawPerson({ x: rf.x, y: rf.y, fx: rf.fx, fy: rf.fy, anim: rf.anim, mv: rf.mv, skin: "#c98d5f", hair: "#16100a", bald: true,
        kit: { shirt: rc, shorts: "#111", socks: "#111", num: "#fff" }, num: null, card: G.card });
    } else if (e.line) {
      const l = e.line; stepAnim(l);
      drawPerson({ x: l.x, y: l.y, fx: l.fx, fy: l.fy, anim: l.anim, mv: l.mv, skin: "#e2b08a", hair: "#2c1b0f", bald: false,
        kit: { shirt: rc, shorts: "#111", socks: "#111", num: "#fff" }, num: null, armsUp: l.flagT > 0 });
      // drapeau du juge de touche (levé en cas de hors-jeu)
      const up = l.flagT > 0, fxp = l.x + 8, fy0 = up ? l.y - 52 : l.y - 18;
      ctx.strokeStyle = "#333"; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(fxp - (up ? 2 : 0), up ? l.y - 42 : l.y - 17); ctx.lineTo(fxp, fy0 - (up ? 4 : 8)); ctx.stroke();
      ctx.fillStyle = up ? "#ff3b3b" : "#ffd400";
      ctx.fillRect(fxp, fy0 - (up ? 12 : 9), 7, 5); ctx.fillStyle = up ? "#ffd400" : "#ff3b3b"; ctx.fillRect(fxp + 3.5, fy0 - (up ? 12 : 9), 3.5, 2.5);
    } else drawPlayer(e.p);
  }
  drawGoals(true);
  drawFxWorld();
  for (const p of G.players) if (!p.off) drawLabel(p);
  // ligne de visée quand tu as le ballon
  if (!touchMode && G.ctrl && G.ball.owner === G.ctrl) {
    const m = mouseWorld();
    ctx.setLineDash([5, 6]);
    ctx.strokeStyle = "rgba(255,210,63,.6)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(G.ctrl.x, G.ctrl.y); ctx.lineTo(m.x, m.y); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  drawWeather(frameDT);
  drawGameHUD();
  drawMinimap();
  drawFxScreen();
  if (G.comm && G.comm.t > 0) {                    // le commentateur
    ctx.font = "italic bold 11px sans-serif";
    let txt = "🎙️ " + G.comm.s;
    while (ctx.measureText(txt).width > 280 && txt.length > 10) txt = txt.slice(0, -2);
    const w = ctx.measureText(txt).width + 18;
    ctx.globalAlpha = Math.min(1, G.comm.t * 2);
    ctx.fillStyle = "rgba(0,0,0,.6)"; rr(10, 470, w, 22, 11); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.fillText(txt, 19, 485);
    ctx.globalAlpha = 1;
  }

  // consignes
  const mine = G.restart && G.restart.taker === G.ctrl && G.ctrl && canAct();
  if (G.watch) drawInstruction(\`👀 Tu regardes le match\${NET.watch ? " de " + NET.watch.name : ""}\`);
  else if (mine) {
    const tt = { corner: "Corner : clique et lâche vers la surface pour centrer (clic droit = passe)",
                 throw: "Touche : clique et lâche vers un coéquipier (clic droit = passe)",
                 free: "Coup franc : clique et lâche pour tirer (clic droit = passe)",
                 penalty: "Penalty : vise un coin du but, clique et lâche !" };
    drawInstruction(tt[G.restart.type] || "Clique et lâche pour jouer");
  } else if (G.period === 0 && G.min < 7 && canAct()) {
    drawInstruction(touchMode ? "Doigt à gauche : courir · TIR · PASSE · TACLE · DRIBBLE · CHANGER (boutons à droite)"
                              : "Clic gauche : courir/tirer · Clic droit : passe ou tacle · A/Q : dribble · F : changer de joueur");
  } else if (G.hintT > 0) {
    drawInstruction(dirOf(G.side) > 0 ? "Tu attaques vers la droite  →" : "←  Tu attaques vers la gauche");
  }
  if (touchMode && !G.watch) drawTouchControls();
  if (G.view && G.lagWarn > 0) {
    ctx.fillStyle = "rgba(0,0,0,.6)"; rr(300, 470, 200, 22, 11); ctx.fill();
    ctx.fillStyle = "#ffb3b3"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.fillText("📶 connexion lente...", 400, 485);
  }

  // message (but, carton, etc.)
  if (G.msgT > 0) {
    ctx.save();
    let size = 46;
    ctx.font = \`900 \${size}px sans-serif\`;
    const extra = G.msgCard ? 44 : 0;
    while (ctx.measureText(G.msg).width + extra > 740 && size > 16) { size -= 2; ctx.font = \`900 \${size}px sans-serif\`; }
    const w = ctx.measureText(G.msg).width;
    ctx.textAlign = "center";
    const cx = 400 + extra / 2, cy = 250;
    if (G.msgCard) {
      ctx.fillStyle = G.msgCard === "red" ? "#e52521" : "#ffd400";
      ctx.save(); ctx.translate(cx - w / 2 - 26, cy - size * 0.35); ctx.rotate(-0.12);
      ctx.fillRect(-11, -16, 22, 32); ctx.strokeStyle = "#000"; ctx.lineWidth = 2; ctx.strokeRect(-11, -16, 22, 32);
      ctx.restore();
    }
    ctx.lineWidth = 7; ctx.strokeStyle = "rgba(0,0,0,.75)";
    ctx.strokeText(G.msg, cx, cy);
    ctx.fillStyle = G.msgColor; ctx.fillText(G.msg, cx, cy);
    ctx.restore();
  }
}

function drawGameHUD() {
  const me = TEAMS[G.tIdx[0]], op = TEAMS[G.tIdx[1]];
  ctx.fillStyle = "rgba(0,0,0,.65)";
  rr(10, 6, 780, 54, 10); ctx.fill();
  ctx.font = "bold 16px sans-serif";
  drawFlag(G.tIdx[0], 22, 22, 27, 18);
  ctx.fillStyle = "#fff"; ctx.textAlign = "left";
  ctx.fillText(me.name, 58, 34);
  drawFlag(G.tIdx[1], 751, 22, 27, 18);
  ctx.fillStyle = "#fff"; ctx.textAlign = "right";
  ctx.fillText(op.name, 742, 34);
  for (const t of [0, 1]) {
    const x0 = t === 0 ? 64 : 736, s = t === 0 ? 1 : -1;
    // couleur du maillot, cartons rouges et joueurs K.O.
    ctx.fillStyle = G.cols[t].fill; ctx.strokeStyle = G.cols[t].line; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x0, 50, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    let xx = x0 + s * 10;
    const reds = G.players.filter(p => p.team === t && p.off && !p.ko).length;
    for (let k = 0; k < reds; k++) { ctx.fillStyle = "#e52521"; ctx.fillRect(t === 0 ? xx : xx - 5, 45, 5, 8); xx += s * 7; }
    // noms des vrais joueurs de l'équipe
    const names = G.hum.filter(h => h.team === t).map(h => roleIcon(h.role) + h.name).join(" + ");
    ctx.font = "bold 10px sans-serif"; ctx.textAlign = t === 0 ? "left" : "right";
    if (names) { ctx.fillStyle = t === (G.me ? G.me.team : 0) ? "#ffd23f" : "#ffb3cd"; ctx.fillText(names, xx + s * 2, 53); xx += s * (ctx.measureText(names).width + 8); }
    if (G.charges && (G.charges[t] > 0 || isSpecial(G.tIdx[t]))) {
      ctx.fillStyle = "#ff9ff3"; ctx.fillText(\`\${TEAMS[G.tIdx[t]].donkey ? "💥 Ruades" : "🐎"} ×\${G.charges[t]}\`, xx + s * 2, 53);
    }
  }
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd23f"; ctx.font = "bold 12px sans-serif";
  const label = G.period >= 2 ? "PROLONGATIONS" : (G.label || (T && T.stages ? T.stages[T.stage].toUpperCase() : "MATCH"));
  ctx.fillText(\`\${label} · \${clockText(G.min, G.period)}\`, 400, 22);
  ctx.fillStyle = "#fff"; ctx.font = "bold 26px sans-serif";
  ctx.fillText(\`\${G.score[0]} - \${G.score[1]}\`, 400, 50);
}

// boutons tactiles (téléphone)
const myCharges = () => G && G.me ? (G.charges ? G.charges[G.me.team] : 0) : 0;
function touchButtons() {
  const list = ["shoot", "pass", "tackle", "drib", "switch"];
  if (myCharges() > 0) list.push("charge");
  return list;
}
function drawTouchControls() {
  if (joy.active) {
    ctx.fillStyle = "rgba(255,255,255,.15)";
    ctx.beginPath(); ctx.arc(joy.ox, joy.oy, 58, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.beginPath(); ctx.arc(joy.ox + joy.dx * 50, joy.oy + joy.dy * 50, 26, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = "rgba(255,255,255,.13)";
    ctx.beginPath(); ctx.arc(95, 410, 58, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.65)"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("POSE TON DOIGT", 95, 406); ctx.fillText("ICI POUR COURIR", 95, 421);
  }
  const COL = { shoot: "rgba(231,76,60,.75)", pass: "rgba(52,152,219,.75)", tackle: "rgba(243,156,18,.8)", drib: "rgba(26,188,156,.8)", switch: "rgba(155,89,182,.8)", charge: "rgba(255,105,180,.85)" };
  for (const k of touchButtons()) {
    const bt = BTN[k];
    ctx.fillStyle = COL[k];
    ctx.beginPath(); ctx.arc(bt.x, bt.y, bt.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = \`bold \${k === "shoot" ? 16 : bt.r < 32 ? 10 : 13}px sans-serif\`; ctx.textAlign = "center";
    ctx.fillText(k === "charge" ? \`\${bt.label} ×\${myCharges()}\` : bt.label, bt.x, bt.y + 4);
  }
}

/* =========================================================
   SÉANCE DE TIRS AU BUT (en cas d'égalité)
   ========================================================= */
function startMatch(opp, opts = {}) {
  hideScreens();
  stopAmbience();
  const stage = T ? T.stage : 0;
  M = {
    opp, tIdx: opts.tIdx || [T.me, opp], local: "me", remote: !!opts.remote, rdive: null, live: opts.live || null, peer: opts.peer || null,
    shots: { me: [], opp: [] },
    turn: "me",
    difficulty: Math.max(0.05, 0.2 + stage * 0.07 + D().pen),   // le gardien adverse devine mieux à chaque tour
    msg: "", msgT: 0, msgColor: "#fff",
    cheer: 0,
    aim: { x: 400, y: 185 },
  };
  whistle();
  setupTurn();
  if (NET.watchers.length) relay(NET.watchers, { k: "pens", watch: true, a: pendingScore.a, b: pendingScore.b, tIdx: M.tIdx, shooter: null });
}

const goals = w => M.shots[w].filter(Boolean).length;

function setupTurn() {
  M.ball = { x: SPOT.x, y: SPOT.y, r: 14, sy: SPOT.y + 12 };
  M.keeper = { x: KHOME.x, y: KHOME.y, angle: 0 };
  M.dive = null; M.rdive = null;
  M.anim = null;
  if (M.remote && M.turn === "opp") {          // en ligne : c'est l'autre joueur qui vise et frappe
    M.phase = "raim"; M.aim = { x: 400, y: 185 };
    M.power = 0; M.powerDir = 1;
    M.shooter = { x: 368, y: 500 };
  } else if (M.turn === "me") {
    M.phase = "aim";
    M.power = 0; M.powerDir = 1;
    M.shooter = { x: 368, y: 500 };
  } else {
    M.phase = "defend";
    M.runT = 0; M.runDur = 1.5;
    M.shooter = { x: 318, y: 500 };
    let tx = rand(GOAL.x1 + 12, GOAL.x2 - 12);
    let ty = rand(GOAL.y1 + 12, GOAL.y2 - 10);
    if (Math.random() < D().miss) {   // l'adversaire rate parfois (plus souvent en facile)
      if (Math.random() < 0.5) tx = Math.random() < 0.5 ? GOAL.x1 - rand(15, 50) : GOAL.x2 + rand(15, 50);
      else ty = GOAL.y1 - rand(15, 40);
    }
    M.cpuTarget = { x: tx, y: ty };
  }
}

function clampAim(p)    { return { x: clamp(p.x, 190, 610), y: clamp(p.y, 75, GOAL.y2 - 8) }; }
function clampKeeper(p) { return { x: clamp(p.x, GOAL.x1 + 40, GOAL.x2 - 40), y: clamp(p.y, GOAL.y1 + 35, 235) }; }

// Tir du joueur
function shoot() {
  const p = M.power;
  const spread = 8 + Math.abs(p - 0.72) * 90;          // plus on s'éloigne de la zone dorée, moins c'est précis
  let tx = M.aim.x + rand(-spread, spread);
  let ty = M.aim.y + rand(-spread, spread);
  if (p > 0.9) ty -= (p - 0.9) * 600;                 // trop fort : ça part au-dessus
  ty = Math.min(ty, GOAL.y2 - 8);

  // Le gardien adverse : il devine parfois, sinon il choisit une zone au hasard
  let k;
  const guess = M.difficulty + (p < 0.45 ? 0.35 : 0);  // tir trop mou = plus facile à lire
  if (M.remote) {
    k = M.rdive || { ...KHOME };                      // en ligne : le gardien plonge là où l'autre joueur a cliqué
  } else if (Math.random() < guess) {
    k = { x: tx + rand(-35, 35), y: ty + rand(-30, 30) };
  } else {
    k = { x: [300, 400, 500][Math.floor(Math.random() * 3)], y: Math.random() < 0.5 ? 160 : 225 };
  }
  launch({ x: tx, y: ty }, clampKeeper(k), 0.35 + (1 - p) * 0.4, "me");
}

function launch(target, keeperTarget, dur, who) {
  M.anim = {
    t: 0, dur, who,
    from: { x: M.ball.x, y: M.ball.y },
    to: target,
    kfrom: { x: KHOME.x, y: KHOME.y },
    kto: keeperTarget,
    curve: rand(-30, 30),
  };
  M.phase = "flight";
  beep(160, 0.08, "triangle", 0.15);
}

function resolve() {
  const a = M.anim, t = a.to, who = a.who;
  const reach = M.remote ? 64 : (who === "me" ? 55 : D().reach);
  const nearPost =
    ((Math.abs(t.x - GOAL.x1) < 7 || Math.abs(t.x - GOAL.x2) < 7) && t.y > GOAL.y1 - 7) ||
    (Math.abs(t.y - GOAL.y1) < 7 && t.x > GOAL.x1 - 7 && t.x < GOAL.x2 + 7);

  let res;
  if (nearPost) res = "post";
  else if (t.x < GOAL.x1 || t.x > GOAL.x2) res = "wide";
  else if (t.y < GOAL.y1) res = "over";
  else if (dist(M.keeper, t) < reach) res = "save";
  else res = "goal";

  M.shots[who].push(res === "goal");

  const mine = who === "me";
  if (M.remote) {                                     // messages neutres pour les deux joueurs
    const nm = TEAMS[M.tIdx[mine ? 0 : 1]].name;
    const tx = { goal: \`BUT ! (\${nm})\`, save: "ARRÊT !", post: "Poteau !", wide: "À côté !", over: "Au-dessus !" };
    showMsg(tx[res], res === "goal" ? "#ffd23f" : "#fff");
    if (res === "goal") { M.cheer = 1.6; crowdSound(); } else beep(120, 0.3, "sawtooth", 0.04);
  }
  const texts = {
    goal: mine ? ["BUT !!!", "#2ecc71"] : ["But adverse...", "#e74c3c"],
    save: mine ? ["Arrêté !", "#e74c3c"] : ["ARRÊT DE FOLIE !", "#2ecc71"],
    post: ["Poteau !", mine ? "#e74c3c" : "#2ecc71"],
    wide: ["À côté !", mine ? "#e74c3c" : "#2ecc71"],
    over: ["Au-dessus !", mine ? "#e74c3c" : "#2ecc71"],
  };
  if (!M.remote) {
    showMsg(texts[res][0], texts[res][1]);
    const good = (mine && res === "goal") || (!mine && res !== "goal");
    if (good) { M.cheer = 1.6; crowdSound(); }
    else beep(120, 0.3, "sawtooth", 0.04);
  }

  if (res === "goal") M.after = { vx: 0, vy: 25 };
  else if (res === "save") M.after = { vx: (t.x < M.keeper.x ? -1 : 1) * 250, vy: 220 };
  else if (res === "post") M.after = { vx: t.x < 400 ? 200 : -200, vy: 230 };
  else M.after = { vx: (a.to.x - a.from.x) * 0.6, vy: (a.to.y - a.from.y) * 0.6 };

  M.phase = "result";
  M.resT = 1.6;
}

function showMsg(text, color) { M.msg = text; M.msgColor = color; M.msgT = 1.6; }

function isOver() {
  const a = goals("me"), b = goals("opp");
  const na = M.shots.me.length, nb = M.shots.opp.length;
  if (na <= 5 && nb <= 5) {
    if (a + (5 - na) < b || b + (5 - nb) < a) return true;   // plus possible de revenir
    if (na === 5 && nb === 5) return a !== b;
    return false;
  }
  return na === nb && a !== b;                                 // mort subite
}

function nextTurn() {
  if (isOver()) {
    const win = goals("me") > goals("opp");
    if (M.remote) showMsg(\`\${TEAMS[M.tIdx[win ? 0 : 1]].name.toUpperCase()} GAGNE !\`, "#ffd23f");
    else showMsg(win ? (T && T.stage === T.stages.length - 1 ? "CHAMPION !" : "QUALIFIÉ !") : "DÉFAITE...", win ? "#ffd23f" : "#e74c3c");
    M.msgT = 2;
    M.phase = "over";
    M.resT = 2;
    whistle();
    return;
  }
  M.turn = M.turn === "me" ? "opp" : "me";
  setupTurn();
}

function update(dt) {
  if (M.cheer > 0) M.cheer -= dt;
  if (M.msgT > 0) M.msgT -= dt;

  switch (M.phase) {
    case "power":
    case "rpower":
      M.power += M.powerDir * dt * 1.3;
      if (M.power >= 1) { M.power = 1; M.powerDir = -1; }
      if (M.power <= 0) { M.power = 0; M.powerDir = 1; }
      break;

    case "defend": {
      M.runT += dt;
      const k = Math.min(1, M.runT / M.runDur);
      M.shooter.x = lerp(318, 378, k);
      M.shooter.y = lerp(500, 494, k);
      if (M.runT >= M.runDur) launch(M.cpuTarget, M.dive || { ...KHOME }, 0.45, "opp");
      break;
    }

    case "flight": {
      const a = M.anim;
      a.t += dt;
      const u = Math.min(1, a.t / a.dur);
      M.ball.x = lerp(a.from.x, a.to.x, u) + Math.sin(u * Math.PI) * a.curve;
      M.ball.y = lerp(a.from.y, a.to.y, u) - Math.sin(u * Math.PI) * 20;
      M.ball.r = 14 - 7 * u;
      M.ball.sy = lerp(SPOT.y + 12, GOAL.y2 + 4, u);
      const ku = clamp((a.t - 0.06) / (a.dur * 0.85), 0, 1);
      const e = 1 - (1 - ku) * (1 - ku);
      M.keeper.x = lerp(a.kfrom.x, a.kto.x, e);
      M.keeper.y = lerp(a.kfrom.y, a.kto.y, e);
      M.keeper.angle = clamp((a.kto.x - KHOME.x) / 170, -1, 1) * 1.25 * e;
      if (u >= 1) resolve();
      break;
    }

    case "result":
      M.ball.x += M.after.vx * dt;
      M.ball.y += M.after.vy * dt;
      if (M.anim.who && M.shots[M.anim.who].slice(-1)[0]) {
        M.ball.y = Math.min(M.ball.y, GOAL.y2 - M.ball.r);
      }
      M.resT -= dt;
      if (M.resT <= 0) nextTurn();
      break;

    case "over":
      M.resT -= dt;
      if (M.resT <= 0) {
        const pa = goals("me"), pb = goals("opp");
        const live = M.remote, L = M.live;
        M = null;
        const res = { a: pendingScore.a, b: pendingScore.b, pa, pb, et: true };
        if (live) liveFinish(L, res); else { endWatchers(); finishMatch(res); }
      }
      break;
  }
}

/* ---------- dessin des tirs au but ---------- */
const crowd = [];
for (let i = 0; i < 700; i++) {
  crowd.push({ x: Math.random() * W, y: Math.random() * 92, c: \`hsl(\${Math.floor(Math.random() * 360)},60%,\${40 + Math.random() * 30}%)\`, s: Math.random() < 0.5 ? 1 : -1 });
}

function drawField() {
  ctx.fillStyle = "#1b2a3a";
  ctx.fillRect(0, 0, W, 100);
  const jump = M && M.cheer > 0 ? Math.sin(performance.now() / 60) * 3 : 0;
  for (const d of crowd) {
    ctx.fillStyle = d.c;
    ctx.fillRect(d.x, d.y + jump * d.s, 3, 3);
  }
  ctx.fillStyle = "#0d4d8c";
  ctx.fillRect(0, 95, W, 15);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  for (let x = 80; x < W; x += 160) ctx.fillText("COUPE DU MONDE", x, 106);

  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 ? "#2e8b3e" : "#34a047";
    ctx.fillRect(0, 110 + i * 50, W, 50);
  }

  ctx.strokeStyle = "rgba(255,255,255,.85)";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, GOAL.y2); ctx.lineTo(W, GOAL.y2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(170, GOAL.y2); ctx.lineTo(150, 305); ctx.lineTo(650, 305); ctx.lineTo(630, GOAL.y2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(90, GOAL.y2); ctx.lineTo(-20, 485); ctx.lineTo(820, 485); ctx.lineTo(710, GOAL.y2); ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.ellipse(SPOT.x, SPOT.y + 12, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
}

function drawGoal() {
  ctx.fillStyle = "rgba(255,255,255,.12)";
  ctx.fillRect(GOAL.x1, GOAL.y1, GOAL.x2 - GOAL.x1, GOAL.y2 - GOAL.y1);
  ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = GOAL.x1; x <= GOAL.x2; x += 14) { ctx.moveTo(x, GOAL.y1); ctx.lineTo(x, GOAL.y2); }
  for (let y = GOAL.y1; y <= GOAL.y2; y += 14) { ctx.moveTo(GOAL.x1, y); ctx.lineTo(GOAL.x2, y); }
  ctx.stroke();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(GOAL.x1, GOAL.y2); ctx.lineTo(GOAL.x1, GOAL.y1);
  ctx.lineTo(GOAL.x2, GOAL.y1); ctx.lineTo(GOAL.x2, GOAL.y2);
  ctx.stroke();
  ctx.lineCap = "butt";
}

function drawKeeper(k, team) {
  const shirt = team.c2, accent = team.c1;
  ctx.save();
  ctx.translate(k.x, k.y);
  ctx.rotate(k.angle);
  ctx.fillStyle = "#222";
  ctx.fillRect(-14, 20, 10, 26);
  ctx.fillRect(4, 20, 10, 26);
  ctx.strokeStyle = shirt;
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-14, -14); ctx.lineTo(-30, -42);
  ctx.moveTo(14, -14);  ctx.lineTo(30, -42);
  ctx.stroke();
  ctx.lineCap = "butt";
  ctx.fillStyle = "#f5f5f5";
  ctx.beginPath(); ctx.arc(-31, -45, 7, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(31, -45, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = shirt;
  rr(-17, -22, 34, 44, 8); ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(-17, -4, 34, 7);
  ctx.strokeStyle = "rgba(0,0,0,.4)"; ctx.lineWidth = 1.5;
  rr(-17, -22, 34, 44, 8); ctx.stroke();
  ctx.fillStyle = "#6b4226";
  ctx.beginPath(); ctx.arc(0, -32, 10, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawShooter(s, team, info) {
  info = info || { num: 10, name: "" };
  const { x, y } = s;
  ctx.fillStyle = "#6b4226";
  ctx.fillRect(x - 12, y - 32, 9, 32);
  ctx.fillRect(x + 3, y - 32, 9, 32);
  ctx.fillStyle = team.c2;
  ctx.fillRect(x - 15, y - 48, 30, 18);
  ctx.fillStyle = team.c1;
  rr(x - 18, y - 90, 36, 44, 8); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 1.5;
  rr(x - 18, y - 90, 36, 44, 8); ctx.stroke();
  ctx.fillStyle = team.c2;
  ctx.font = "bold 18px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(String(info.num), x, y - 58);
  if (info.name) { ctx.font = "bold 8px sans-serif"; ctx.fillText(info.name, x, y - 79); }
  ctx.fillStyle = "#3b2414";
  ctx.beginPath(); ctx.arc(x, y - 100, 11, 0, Math.PI * 2); ctx.fill();
}

function drawBall(b) {
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.beginPath(); ctx.ellipse(b.x, b.sy, b.r, b.r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#333"; ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#222";
  ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.33, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 5; i++) {
    const a = i * Math.PI * 2 / 5 - Math.PI / 2;
    ctx.beginPath(); ctx.arc(b.x + Math.cos(a) * b.r * 0.75, b.y + Math.sin(a) * b.r * 0.75, b.r * 0.18, 0, Math.PI * 2); ctx.fill();
  }
}

function drawDots(arr, x, y) {
  const n = Math.max(5, arr.length);
  for (let i = 0; i < n; i++) {
    ctx.beginPath(); ctx.arc(x + i * 16, y, 6, 0, Math.PI * 2);
    if (i < arr.length) { ctx.fillStyle = arr[i] ? "#2ecc71" : "#e74c3c"; ctx.fill(); }
    else { ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.lineWidth = 2; ctx.stroke(); }
  }
}

function drawHUD() {
  const me = TEAMS[M.tIdx[0]], op = TEAMS[M.tIdx[1]];
  ctx.fillStyle = "rgba(0,0,0,.65)";
  rr(10, 6, 780, 56, 10); ctx.fill();

  ctx.font = "bold 15px sans-serif";
  drawFlag(M.tIdx[0], 20, 15, 22, 15);
  ctx.fillStyle = "#fff"; ctx.textAlign = "left";
  ctx.fillText(me.name, 50, 28);
  drawDots(M.shots.me, 34, 46);
  drawFlag(M.tIdx[1], 758, 15, 22, 15);
  ctx.fillStyle = "#fff"; ctx.textAlign = "right";
  ctx.fillText(op.name, 750, 28);
  const n = Math.max(5, M.shots.opp.length);
  drawDots(M.shots.opp, 766 - (n - 1) * 16, 46);
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd23f";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText(\`TIRS AU BUT · \${pendingScore.a}-\${pendingScore.b} après prolongations\`, 400, 22);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 24px sans-serif";
  ctx.fillText(\`\${goals("me")} - \${goals("opp")}\`, 400, 50);
}

function drawInstruction(text) {
  ctx.font = "bold 14px sans-serif";
  const w = ctx.measureText(text).width + 30;
  ctx.fillStyle = "rgba(0,0,0,.6)";
  rr(400 - w / 2, 66, w, 26, 13); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textAlign = "center";
  ctx.fillText(text, 400, 84);
}

function drawPowerBar() {
  const x = 730, y = 300, w = 24, h = 150;
  ctx.fillStyle = "rgba(0,0,0,.5)";
  rr(x - 6, y - 26, w + 12, h + 32, 8); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("PUISSANCE", x + w / 2, y - 12);
  const g = ctx.createLinearGradient(0, y + h, 0, y);
  g.addColorStop(0, "#2ecc71"); g.addColorStop(0.6, "#f1c40f"); g.addColorStop(1, "#e74c3c");
  const fill = h * M.power;
  ctx.fillStyle = g;
  ctx.fillRect(x, y + h - fill, w, fill);
  ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 2;
  ctx.strokeRect(x - 3, y + h - h * 0.85, w + 6, h * 0.25);
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}

function drawCrosshair(p, locked) {
  const pulse = locked ? 2 + Math.sin(performance.now() / 80) * 2 : 0;
  ctx.strokeStyle = locked ? "#ffd23f" : "#fff";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(p.x, p.y, 14 + pulse, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - 22, p.y); ctx.lineTo(p.x - 8, p.y);
  ctx.moveTo(p.x + 8, p.y);  ctx.lineTo(p.x + 22, p.y);
  ctx.moveTo(p.x, p.y - 22); ctx.lineTo(p.x, p.y - 8);
  ctx.moveTo(p.x, p.y + 8);  ctx.lineTo(p.x, p.y + 22);
  ctx.stroke();
}

function drawMessage() {
  if (M.msgT <= 0) return;
  const s = 1 + Math.max(0, M.msgT - 1.3) * 1.5;
  ctx.save();
  ctx.translate(400, 340);
  ctx.scale(s, s);
  ctx.font = "900 52px sans-serif";
  ctx.textAlign = "center";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(0,0,0,.7)";
  ctx.strokeText(M.msg, 0, 0);
  ctx.fillStyle = M.msgColor;
  ctx.fillText(M.msg, 0, 0);
  ctx.restore();
}

function drawShootout() {
  drawField();
  drawGoal();
  if (!M) return;

  const me = TEAMS[M.tIdx[0]], op = TEAMS[M.tIdx[1]];
  const shooterTeam = M.turn === "me" ? me : op;
  const keeperTeam  = M.turn === "me" ? op : me;

  drawKeeper(M.keeper, keeperTeam);
  const shIdx = M.turn === "me" ? M.tIdx[0] : M.tIdx[1];
  const shN = (M.turn === "me" ? M.shots.me : M.shots.opp).length;
  const ORDER = [9, 10, 8, 5, 6, 7, 2, 3, 1, 4];       // ordre des tireurs (attaquants d'abord)
  drawShooter(M.shooter, shooterTeam, LINEUPS[shIdx][ORDER[shN % ORDER.length]]);
  drawBall(M.ball);

  const aiming = ["aim", "power", "raim", "rpower"].includes(M.phase);
  const iShoot = M.turn === (M.local || "me");
  if (M.spec) {
    if (aiming) drawInstruction("Tirs au but : ton coéquipier et l'adversaire s'affrontent 👀");
  } else if (aiming && iShoot) {
    drawCrosshair(M.aim, M.phase === "power" || M.phase === "rpower");
    drawPowerBar();
    drawInstruction(M.phase === "aim" || M.phase === "raim" ? "Vise dans le but puis clique" : "Clique pour frapper (vise la zone dorée)");
  } else if (aiming) {                              // en ligne : l'autre joueur tire, je choisis mon plongeon
    const dv = M.view ? M.dive : M.dive;
    drawInstruction(dv ? "Plongeon choisi !" : "Clique dans le but pour plonger !");
    if (dv) {
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(dv.x, dv.y, 26, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  if (M.phase === "defend") {
    drawInstruction(M.dive ? "Plongeon choisi !" : "Clique dans le but pour plonger !");
    if (M.dive) {
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(M.dive.x, M.dive.y, 26, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    const left = 1 - M.runT / M.runDur;
    ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(300, 270, 200, 8);
    ctx.fillStyle = "#ffd23f"; ctx.fillRect(300, 270, 200 * left, 8);
  }

  drawHUD();
  drawMessage();
}

/* =========================================================
   CONTRÔLES (souris, tactile, clavier)
   ========================================================= */
function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
}

// Tirs au but
function action(p) {
  if (!M) return;
  if (M.view) {                                      // invité en ligne : on envoie ses actions à l'hôte
    if (M.spec) return;                              // spectateur (2 contre 2) : il regarde
    const host = NET.live && NET.live.hostId;
    if (!host || !p) return;
    if (M.turn === "opp") {
      if (M.phase === "raim") { M.aim = clampAim(p); relay(host, { k: "plock", x: M.aim.x, y: M.aim.y }); }
      else if (M.phase === "rpower") relay(host, { k: "pshoot" });
    } else if ((M.phase === "aim" || M.phase === "power") && !M.dive) {
      M.dive = clampKeeper(p); relay(host, { k: "pdive", x: M.dive.x, y: M.dive.y });
    }
    return;
  }
  if (M.remote && M.turn === "opp") {               // hôte en ligne : je choisis mon plongeon
    if ((M.phase === "raim" || M.phase === "rpower") && !M.dive && p) M.dive = clampKeeper(p);
    return;
  }
  if (M.phase === "aim") {
    if (p) M.aim = clampAim(p);
    M.phase = "power"; M.power = 0; M.powerDir = 1;
  } else if (M.phase === "power") {
    shoot();
  } else if (M.phase === "defend" && !M.dive && p) {
    M.dive = clampKeeper(p);
  }
}

// Une action du joueur local : jouée tout de suite (hors ligne / hôte) ou envoyée à l'hôte (invité en ligne)
function act(kind, d = {}) {
  if (!G) return;
  if (G.view) {
    if (!NET.live) return;
    relay(NET.live.hostId, Object.assign({ k: kind }, d));
    if (kind === "rel" && G.ctrl && G.ball.owner !== G.ctrl && !d.touch) G.ctrl.dash = 0.3;   // le petit sprint, tout de suite
    return;
  }
  const h = G.me;
  if (!h) return;
  doAct(h, kind, d);
}
function doAct(h, kind, d) {
  const pt = d && d.x != null ? { x: d.x, y: d.y } : null;
  switch (kind) {
    case "rel": releaseShot(h, d); break;
    case "right": actRight(h, pt); break;
    case "pass": actPass(h, pt); break;
    case "tackle": actTackle(h, pt); break;
    case "drib": actDribble(h); break;
    case "sw": actSwitch(h); break;
    case "chg": actCharge(h); break;
  }
}
// lâcher le clic gauche = tirer vers la souris (ou petit sprint si on n'a pas le ballon)
function releaseShot(h, d) {
  if (!canAct() || !h.ctrl) return;
  const c = h.ctrl;
  if (G.ball.owner === c) {
    if (d.goal) return actShoot(h, { x: goalXOf(c.team) + dirOf(c.team) * 10, y: F.cy + (d.gy || 0) * F.gh * 0.85 });
    const close = d.x == null || dist(c, d) < 25;   // souris collée au joueur : on tire vers le but
    actShoot(h, close ? null : { x: d.x, y: d.y });
  } else actShoot(h, null, !d.touch);
}

canvas.addEventListener("pointerdown", e => {
  e.preventDefault();
  initAudio();
  if (CELEB) { if (CELEB.t > 1.5) endCeleb(); return; }   // fin de la célébration
  if (e.pointerType === "touch") touchMode = true;
  else if (e.pointerType === "mouse") touchMode = false;
  const p = toCanvas(e);
  mouse.x = p.x; mouse.y = p.y;
  if (G) {
    if (!touchMode) { mouseButtons(e); return; }    // souris : géré par mouseButtons (plusieurs boutons à la fois)
    for (const k of touchButtons()) {
      const bt = BTN[k];
      if (dist(p, bt) < bt.r + 8) {
        if (k === "shoot") act("rel", { touch: true, goal: true, gy: joy.active ? +joy.dy.toFixed(2) : 0 });
        else if (k === "pass") act("pass");
        else if (k === "tackle") act("tackle");
        else if (k === "drib") act("drib");
        else if (k === "switch") act("sw");
        else if (k === "charge") act("chg");
        return;
      }
    }
    if (p.x < 520 && !joy.active) {
      joy.active = true; joy.id = e.pointerId; joy.ox = p.x; joy.oy = p.y; joy.dx = 0; joy.dy = 0;
    }
    return;
  }
  if (e.button !== 0) return;
  action(p);
});
canvas.addEventListener("contextmenu", e => e.preventDefault());
/* Souris : on suit l'état de TOUS les boutons (e.buttons), car quand on maintient le clic gauche,
   le navigateur ne renvoie pas de nouveau "pointerdown" pour le clic droit. */
let lastButtons = 0;
function mouseButtons(e) {
  if (e.pointerType && e.pointerType !== "mouse") return;
  const b = e.buttons || 0, pressed = b & ~lastButtons, released = lastButtons & ~b;
  lastButtons = b;
  if (!G || touchMode) return;
  if (pressed & 1) leftDown();
  if (pressed & 2) rightDown();
  if (released & 1) leftUp();
}
function leftDown() { mouse.down = true; mouse.downAt = performance.now(); }   // clic gauche maintenu = courir
function rightDown() {                             // clic droit = passe (si on a le ballon) ou tacle, même en courant
  const w = mouseWorld();
  act("right", { x: Math.round(w.x), y: Math.round(w.y) });
}
function leftUp() {
  if (!mouse.down) return;
  mouse.down = false;
  if (!G) return;
  const w = mouseWorld();
  act("rel", { x: Math.round(w.x), y: Math.round(w.y) });
}
window.addEventListener("pointermove", mouseButtons);
window.addEventListener("pointerup", mouseButtons);
window.addEventListener("pointerdown", e => { if (e.target !== canvas) mouseButtons(e); });
// Clavier : A (AZERTY) / Q (QWERTY) = dribble, F = changer de joueur, R = charge de Napoléon, E = passe
window.addEventListener("keydown", e => {
  if (!G || e.repeat || G.ended) return;
  const tg = e.target && e.target.tagName;
  if (tg === "INPUT" || tg === "SELECT" || tg === "TEXTAREA") return;
  const k = (e.key || "").toLowerCase();
  if (e.code === "KeyQ" || k === "a" || k === "q") { e.preventDefault(); act("drib"); }
  else if (e.code === "KeyF" || k === "f") { e.preventDefault(); act("sw"); }
  else if (e.code === "KeyR" || k === "r") { e.preventDefault(); act("chg"); }
  else if (e.code === "KeyE" || k === "e") { e.preventDefault(); const w = mouseWorld(); act("pass", touchMode ? {} : { x: Math.round(w.x), y: Math.round(w.y) }); }
});
canvas.addEventListener("pointermove", e => {
  const p = toCanvas(e);
  mouse.x = p.x; mouse.y = p.y;
  if (G) {
    if (joy.active && e.pointerId === joy.id) {
      let dx = (p.x - joy.ox) / 50, dy = (p.y - joy.oy) / 50;
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      joy.dx = dx; joy.dy = dy;
    }
    return;
  }
  if (M && M.view) {
    if (!M.spec && M.turn === "opp" && M.phase === "raim") {
      M.aim = clampAim(p);
      const now = performance.now();
      if (NET.live && now - NET.inT > 60) { NET.inT = now; relay(NET.live.hostId, { k: "paim", x: M.aim.x, y: M.aim.y }); }
    }
    return;
  }
  if (M && M.phase === "aim" && M.turn === "me") M.aim = clampAim(p);
});
function endJoy(e) { if (e.pointerId === joy.id) { joy.active = false; joy.id = null; joy.dx = 0; joy.dy = 0; } }
canvas.addEventListener("pointerup", endJoy);
canvas.addEventListener("pointercancel", endJoy);

window.addEventListener("blur", () => { mouse.down = false; });

/* =========================================================
   CONNEXION AU SERVEUR, COMPTES, PROFILS ET ADMIN
   ========================================================= */
const NET = {
  ws: null, id: null, room: null, ok: false, retry: 0,
  live: null,                  // match en direct : { kind, host, hostId, peers, m, stage, readyMe, hum, tIdx }
  readyFrom: new Set(),        // joueurs prêts (id:tour)
  sendT: 0, inT: 0, seq: 0,
};
let ME = null;                 // le joueur connecté : { name, role, specials, stats }
let TOKEN = null;
try { TOKEN = localStorage.getItem("foot_token"); } catch (e) {}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toast.tm); toast.tm = setTimeout(() => t.classList.remove("on"), 3200);
}
function netSend(o) { if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(o)); }
// relais rapide vers un ou plusieurs joueurs : "@id1,id2|données"
function relay(to, d) {
  if (!NET.ws || NET.ws.readyState !== 1 || !to) return;
  const ids = Array.isArray(to) ? to : [to];
  if (!ids.length) return;
  NET.ws.send("@" + ids.join(",") + "|" + JSON.stringify(d));
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const badgeHtml = role => role === "createur" ? \`<span class="crown" title="Créateur du jeu">👑</span>\` : role === "admin" ? \`<span class="shield" title="Admin">🛡️</span>\` : "";
const nameTag = (name, role) => \`<a class="uname" data-u="\${esc(name)}">\${badgeHtml(role)}\${esc(name)}</a>\`;
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest(".uname");
  if (a) { e.preventDefault(); e.stopPropagation(); openProfile(a.dataset.u); }
});

function setNetState(txt, cls) {
  for (const id of ["netState", "netStatus"]) { const el = $(id); if (el) { el.innerHTML = txt; el.className = "net-status " + (cls || ""); } }
}
function netConnect() {
  if (location.protocol === "file:") {
    NET.ok = false;
    setNetState("⚠️ Le jeu a besoin du serveur pour les comptes et le mode en ligne.<br>Dans le dossier du jeu, ouvre un terminal et tape <b>node &quot;final foot3.js&quot;</b>, puis ouvre <b>http://localhost:3000</b>", "bad");
    $("noAccount").classList.remove("hidden");
    return;
  }
  if (NET.ws && NET.ws.readyState <= 1) return;
  setNetState(NET.retry ? "Reconnexion au serveur..." : "Connexion au serveur...", "");
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
  NET.ws = ws;
  const slow = setTimeout(() => { if (!NET.ok) { setNetState("Le serveur se réveille (ça peut prendre 1 minute)...", ""); $("noAccount").classList.remove("hidden"); } }, 6000);
  ws.onopen = () => {
    clearTimeout(slow);
    NET.ok = true; NET.retry = 0;
    setNetState("✅ Connecté au serveur", "good");
    if (TOKEN) netSend({ t: "resume", token: TOKEN });
  };
  ws.onclose = () => {
    clearTimeout(slow);
    const was = NET.ok;
    NET.ok = false; NET.room = null;
    setNetState("❌ Pas de connexion au serveur... nouvel essai", "bad");
    if (T && T.online || NET.live) { G = null; M = null; T = null; NET.live = null; stopAmbience(); toast("Connexion perdue"); show(ME ? "title" : "loginScreen"); }
    NET.retry++;
    setTimeout(netConnect, Math.min(10000, 1000 * NET.retry));
    if (was) $("noAccount").classList.remove("hidden");
  };
  ws.onmessage = e => {
    const data = e.data;
    if (data.charCodeAt(0) === 64) {                 // message relayé d'un autre joueur
      const bar = data.indexOf("|");
      let d; try { d = JSON.parse(data.slice(bar + 1)); } catch (er) { return; }
      return onRelay(data.slice(1, bar), d);
    }
    let m; try { m = JSON.parse(data); } catch (er) { return; }
    onNet(m);
  };
}

function onNet(m) {
  switch (m.t) {
    case "hello": NET.id = m.id; break;
    case "auth": onAuth(m); break;
    case "authwait": setTimeout(() => TOKEN && netSend({ t: "resume", token: TOKEN }), 1500); break;
    case "authfail":
      if (m.silent) { TOKEN = null; try { localStorage.removeItem("foot_token"); } catch (e) {} if (m.banned) $("lMsg").textContent = m.msg; return; }
      $(!$("registerScreen").classList.contains("hidden") ? "rgMsg" : "lMsg").textContent = m.msg;
      break;
    case "me": ME = m.user; updateUserBar(); if (!$("menu").classList.contains("hidden")) buildMenu(); if (NET.room && !$("roomScreen").classList.contains("hidden")) renderRoom(); break;
    case "profile": renderProfile(m.p); break;
    case "friends": onFriends(m); break;
    case "global": showGlobal(m.from, m.msg); break;
    case "banned":
      ME = null; TOKEN = null; try { localStorage.removeItem("foot_token"); } catch (e) {}
      G = null; M = null; T = null; NET.live = null; NET.room = null; stopAmbience(); closePanel(); updateUserBar();
      show("loginScreen"); $("lMsg").textContent = m.msg;
      break;
    case "adminlist": renderAdmin(m.list, m.total); break;
    case "toast": toast(m.msg); if (PANEL.kind === "profile") setTimeout(() => openProfile(PANEL.name), 250); break;
    case "kicked": NET.room = null; G = null; M = null; T = null; NET.live = null; stopAmbience(); show("title"); toast(m.msg); break;
    case "rooms": renderRoomList(m.rooms); break;
    case "error": toast(m.msg); break;
    case "left":
      NET.watchers = NET.watchers.filter(x => x !== m.id);
      toast(\`\${m.name} a quitté le salon\`);
      if (NET.live && NET.live.host) liveGuestGone(m.id);
      break;
    case "room":
      NET.room = m.room;
      COMP = m.room.mode || COMP;
      if (m.room.state === "lobby") {
        if (["roomScreen", "createScreen", "joinScreen"].some(id => !$(id).classList.contains("hidden"))) show("roomScreen");
        renderRoom();
      }
      break;
    case "tour": onTour(m.tour); break;
    case "fstart": onFriendlyStart(m.match); break;
    case "fend": onFriendlyEnd(m.res); break;
    case "fabort":
      if (NET.live && NET.live.kind === "friendly") { G = null; M = null; NET.live = null; stopAmbience(); }
      toast(m.msg); show("roomScreen"); renderRoom();
      break;
  }
}

/* ---------- connexion / création de compte ---------- */
function onAuth(m) {
  ME = m.user; TOKEN = m.token;
  try { localStorage.setItem("foot_token", TOKEN); } catch (e) {}
  $("lMsg").textContent = ""; $("rgMsg").textContent = "";
  $("lPw").value = ""; $("rgPw").value = ""; $("rgPw2").value = "";
  updateUserBar();
  if (!$("loginScreen").classList.contains("hidden") || !$("registerScreen").classList.contains("hidden")) {
    show("title");
    toast(\`Salut \${ME.name} ! \${ME.role === "createur" ? "👑 Bienvenue, créateur du jeu !" : ME.role === "admin" ? "🛡️ Tu es admin." : "⚽"}\`);
  }
}
$("loginForm").onsubmit = e => {
  e.preventDefault(); initAudio();
  const name = $("lName").value.trim(), pw = $("lPw").value;
  if (!name || !pw) { $("lMsg").textContent = "Écris ton nom d'utilisateur et ton mot de passe."; return; }
  if (!NET.ok) { $("lMsg").textContent = "Pas encore connecté au serveur, attends un peu..."; return; }
  $("lMsg").textContent = "";
  netSend({ t: "login", name, pw });
};
$("registerForm").onsubmit = e => {
  e.preventDefault(); initAudio();
  const name = $("rgName").value.trim(), pw = $("rgPw").value, pw2 = $("rgPw2").value;
  if (!/^[A-Za-z0-9À-ÖØ-öø-ÿ_.-]{3,16}$/.test(name)) { $("rgMsg").textContent = "Nom : 3 à 16 lettres ou chiffres, sans espace."; return; }
  if (pw.length < 4) { $("rgMsg").textContent = "Mot de passe : au moins 4 caractères."; return; }
  if (pw !== pw2) { $("rgMsg").textContent = "Les deux mots de passe ne sont pas pareils."; return; }
  if (!NET.ok) { $("rgMsg").textContent = "Pas encore connecté au serveur, attends un peu..."; return; }
  $("rgMsg").textContent = "";
  netSend({ t: "register", name, pw });
};
$("toRegister").onclick = () => { show("registerScreen"); $("rgName").value = $("lName").value; };
$("toLogin").onclick = () => show("loginScreen");
$("noAccount").onclick = () => { ME = null; updateUserBar(); show("title"); toast("Mode hors ligne sans compte : tes statistiques ne sont pas gardées."); };

/* ---------- barre du joueur (en haut à gauche) ---------- */
function updateUserBar() {
  $("ubName").innerHTML = ME ? \`\${badgeHtml(ME.role)}\${esc(ME.name)} ▾\` : "";
  $("ubAdmin").classList.toggle("hidden", !(ME && (ME.role === "admin" || ME.role === "createur")));
}
let userBarOn = null;
function userBarTick() {
  const on = !!ME && !G && !M && !CELEB && $("loginScreen").classList.contains("hidden") && $("registerScreen").classList.contains("hidden");
  if (on !== userBarOn) { userBarOn = on; $("userBar").classList.toggle("on", on); }
}
$("ubName").onclick = () => ME && openProfile(ME.name);
$("ubAdmin").onclick = () => openAdmin();
$("ubOut").onclick = () => {
  netSend({ t: "logout", token: TOKEN });
  TOKEN = null; ME = null; NET.room = null; T = null;
  try { localStorage.removeItem("foot_token"); } catch (e) {}
  updateUserBar(); show("loginScreen");
};

/* ---------- profil (statistiques) et commandes admin ---------- */
const PANEL = { kind: null, name: null, list: [] };
function closePanel() { PANEL.kind = null; $("profile").classList.add("hidden"); }
$("profile").addEventListener("click", e => { if (e.target.id === "profile") closePanel(); });
function openProfile(name) {
  if (!NET.ok) return toast("Pas de connexion au serveur");
  PANEL.kind = "profile"; PANEL.name = name;
  $("pcard").innerHTML = \`<button class="pclose" onclick="closePanel()">×</button><p>Chargement du profil de \${esc(name)}...</p>\`;
  $("profile").classList.remove("hidden");
  netSend({ t: "profile", name });
}
const ROLE_TXT = { createur: "👑 Créateur du jeu", admin: "🛡️ Admin", joueur: "⚽ Joueur" };
function renderProfile(p) {
  if (PANEL.kind !== "profile") return;
  PANEL.name = p.name;
  const s = p.stats, pct = s.played ? Math.round(s.won * 100 / s.played) : 0;
  const st = (v, l) => \`<div class="stat"><b>\${v}</b><span>\${l}</span></div>\`;
  const isMe = ME && ME.name.toLowerCase() === p.name.toLowerCase();
  let html = \`<button class="pclose" onclick="closePanel()">×</button>
    <h2>\${badgeHtml(p.role)}\${esc(p.name)}</h2>
    <div class="prole">\${p.banned ? "🚫 BANNI · " : ""}\${ROLE_TXT[p.role] || ""}\${p.powers && p.role !== "createur" ? " · ⚡ panneau de match" : ""} · \${p.online ? \`<span class="dot-on"></span>en ligne\` : \`<span class="dot-off"></span>hors ligne\`}\${p.created ? " · inscrit le " + new Date(p.created).toLocaleDateString("fr-FR") : ""}</div>
    <div class="stats">
      \${st(s.cdm, "🏆 Coupes du Monde")}\${st(s.cl, "⭐ Champions League")}\${st(s.played, "Matchs joués")}
      \${st(s.won, "Victoires")}\${st(s.lost, "Défaites")}\${st(pct + " %", "de victoires")}
      \${st(s.gf, "Buts marqués")}\${st(s.ga, "Buts encaissés")}\${st(s.online, "Victoires en ligne")}
    </div>\`;
  if (p.specials && p.specials.length) html += \`<p>Équipes spéciales : \${p.specials.map(i => \`\${teamImg(i, "mini-flag")}<b>\${TEAMS[i].name}</b>\`).join(", ")}</p>\`;
  if (ME && !isMe && (ME.role === "admin" || ME.role === "createur")) {
    const n = esc(p.name).replace(/'/g, "\\\\'");
    html += \`<div class="admin-zone"><b style="width:100%">Commandes \${ME.role === "createur" ? "du créateur 👑" : "admin 🛡️"}</b>\`;
    if (ME.role === "createur") {
      html += p.role === "admin"
        ? \`<button class="small-btn ghost" onclick="adminOp('role','\${n}',{role:'joueur'})">Retirer admin</button>\`
        : \`<button class="small-btn" onclick="adminOp('role','\${n}',{role:'admin'})">🛡️ Nommer admin</button>\`;
      for (const sp of [NAPOLEON, DYLANFC]) {
        const has = (p.specials || []).includes(sp);
        html += has ? \`<button class="small-btn ghost" onclick="adminOp('take','\${n}',{team:\${sp}})">Reprendre \${TEAMS[sp].name}</button>\`
                    : \`<button class="small-btn" onclick="adminOp('give','\${n}',{team:\${sp}})">🎁 Donner \${TEAMS[sp].name}</button>\`;
      }
      html += p.powers ? \`<button class="small-btn ghost" onclick="adminOp('powers','\${n}',{on:false})">Retirer le panneau de match ⚡</button>\`
                       : \`<button class="small-btn" onclick="adminOp('powers','\${n}',{on:true})">⚡ Donner le panneau de match</button>\`;
      html += p.banned ? \`<button class="small-btn" onclick="adminOp('ban','\${n}',{on:false})">✅ Débannir</button>\`
                       : \`<button class="small-btn ghost" style="border-color:#e74c3c;color:#ff8a80" onclick="if(confirm('Bannir \${n} ? Il ne pourra plus se connecter.'))adminOp('ban','\${n}',{on:true})">🚫 Bannir ce compte</button>\`;
    }
    if (p.role !== "createur") html += \`<button class="small-btn ghost" onclick="adminOp('kick','\${n}',{})">Expulser de son salon</button>\`;
    html += \`</div>\`;
  }
  if (isMe && (ME.role === "admin" || ME.role === "createur")) html += \`<button class="small-btn" onclick="openAdmin()">⚙️ Panneau admin</button>\`;
  $("pcard").innerHTML = html;
}
// message du créateur affiché chez tout le monde
function sendGlobal() {
  const t = ($("bcText").value || "").trim();
  if (!t) return toast("Écris un message d'abord");
  netSend({ t: "admin", op: "broadcast", msg: t });
  $("bcText").value = "";
}
function showGlobal(from, msg) {
  $("gFrom").textContent = \`📢 MESSAGE DE 👑 \${from}\`;
  $("gText").textContent = msg;
  const el = $("globalMsg");
  el.classList.add("hidden"); void el.offsetWidth; el.classList.remove("hidden");
  [[784, 0], [988, 140], [1175, 280]].forEach(([f, d]) => setTimeout(() => beep(f, 0.18, "triangle", 0.08), d));
  clearTimeout(showGlobal.t); showGlobal.t = setTimeout(() => el.classList.add("hidden"), 12000);
}
function adminOp(op, name, extra) { netSend(Object.assign({ t: "admin", op, name }, extra)); }
function openAdmin() {
  PANEL.kind = "admin";
  $("pcard").innerHTML = \`<button class="pclose" onclick="closePanel()">×</button><p>Chargement des joueurs...</p>\`;
  $("profile").classList.remove("hidden");
  netSend({ t: "admin", op: "list" });
}
function renderAdmin(list, total) {
  if (PANEL.kind !== "admin") return;
  PANEL.list = list;
  $("pcard").innerHTML = \`<button class="pclose" onclick="closePanel()">×</button>
    <h2>⚙️ Panneau \${ME && ME.role === "createur" ? "du créateur" : "admin"}</h2>
    \${ME && ME.role === "createur" ? \`<div style="display:flex;flex-direction:column;gap:6px;text-align:left"><b>📢 Message à tout le monde</b>
      <textarea id="bcText" maxlength="200" placeholder="Écris ton message : tous les joueurs connectés le verront, même en plein match"></textarea>
      <button class="small-btn" onclick="sendGlobal()">📢 Envoyer à tout le monde</button></div>\` : ""}
    <p class="muted">\${total} compte(s). Clique sur un joueur pour voir ses stats\${ME && ME.role === "createur" ? ", le nommer admin, lui donner une équipe spéciale ou le bannir" : " ou l'expulser d'un salon"}.</p>
    <input id="adminSearch" placeholder="Chercher un joueur..." oninput="filterAdmin()">
    <div id="adminList"></div>\`;
  filterAdmin();
}
function filterAdmin() {
  const q = ($("adminSearch") ? $("adminSearch").value : "").trim().toLowerCase();
  $("adminList").innerHTML = PANEL.list.filter(u => !q || u.name.toLowerCase().includes(q)).slice(0, 120).map(u => \`
    <div class="admin-row"><span><span class="\${u.online ? "dot-on" : "dot-off"}"></span>\${nameTag(u.name, u.role)}
      \${u.specials.map(i => teamImg(i, "mini-flag")).join("")}\${u.banned ? " 🚫 banni" : ""}</span><span class="muted">\${u.won} V / \${u.played} matchs</span></div>\`).join("") || \`<p class="muted">Aucun joueur trouvé.</p>\`;
}

/* ---------- écrans : créer / rejoindre / salon ---------- */
const TYPE_TXT = { tournoi: "🏆 Tournoi", "1v1": "⚔️ 1 contre 1", "2v2": "🤝 2 contre 2" };
function renderRoomList(list) {
  const el = $("roomList");
  if (!list.length) { el.innerHTML = \`<p class="muted">Aucun salon public pour l'instant. Crée le tien !</p>\`; return; }
  el.innerHTML = list.map(r => \`
    <div class="room-row">
      <div><b>\${esc(r.name)}</b><br><span class="muted">\${TYPE_TXT[r.type] || ""} · \${COMPS[r.mode].name} · \${r.players}/\${r.maxPlayers} joueurs\${r.type === "tournoi" ? \` · \${r.numTeams} équipes · bots \${DIFFS[r.diff].label}\` : ""}</span></div>
      <button class="small-btn" data-code="\${r.code}">Rejoindre</button>
    </div>\`).join("");
  el.querySelectorAll("button").forEach(b => b.onclick = () => netSend({ t: "join", code: b.dataset.code }));
}

function renderRoom() {
  const r = NET.room; if (!r) return;
  const meP = r.players.find(p => p.id === NET.id);
  const isHost = r.host === NET.id;
  const match = r.type === "1v1" || r.type === "2v2";
  $("rName").textContent = r.name;
  $("rCode").textContent = r.code;
  $("rInfo").textContent = \`\${TYPE_TXT[r.type]} · \${COMPS[r.mode].name} · \${r.players.length}/\${r.maxPlayers} joueurs\${match ? "" : \` · \${r.numTeams} équipes · bots \${DIFFS[r.diff].label}\`} · \${r.public ? "salon public" : "salon privé"}\`;
  $("rPlayers").classList.toggle("hidden", match);
  $("rSides").classList.toggle("hidden", !match);
  const chip = p => \`<div class="pl-chip\${p.id === NET.id ? " me" : ""}">
      \${!match ? (p.team != null ? teamImg(p.team, "mini-flag") : \`<span class="no-flag">?</span>\`) : ""}
      \${nameTag(p.name, p.role)}\${p.id === r.host ? " 🎮" : ""}\${p.id === NET.id ? " (toi)" : ""}
    </div>\`;
  if (!match) $("rPlayers").innerHTML = r.players.map(chip).join("");
  const grid = $("rGrid");
  grid.classList.toggle("clubs", r.mode === "cl");
  if (match) {
    const per = r.type === "2v2" ? 2 : 1;
    $("rSides").innerHTML = ["A", "B"].map(sd => {
      const ps = r.players.filter(p => p.side === sd), tm = r.sideTeam[sd];
      const mine = meP && meP.side === sd;
      return \`<div class="side-col\${mine ? " mine" : ""}">
        <h3>\${sd === "A" ? "Équipe 1 (à gauche)" : "Équipe 2 (à droite)"}</h3>
        <div class="side-team">\${tm != null ? teamImg(tm, "mini-flag") + esc(TEAMS[tm].name) : \`<span class="muted">Équipe pas encore choisie</span>\`}</div>
        \${ps.map(chip).join("") || \`<span class="muted">Personne</span>\`}
        \${!mine && ps.length < per ? \`<button class="small-btn ghost" onclick="netSend({t:'side',side:'\${sd}'})">Jouer dans cette équipe</button>\` : ""}
      </div>\`;
    }).join("");
    const mySide = meP && meP.side, other = mySide === "A" ? "B" : "A";
    fillTeamGrid(grid, r.mode, i => netSend({ t: "pick", team: i }), (b, i) => {
      if (r.sideTeam[mySide] === i) b.classList.add("picked");
      if (r.sideTeam[other] === i) { b.classList.add("taken"); b.disabled = true; b.insertAdjacentHTML("beforeend", "<small>adversaire</small>"); }
    });
    const A = r.players.filter(p => p.side === "A").length, B = r.players.filter(p => p.side === "B").length;
    const ready = A > 0 && B > 0 && r.sideTeam.A != null && r.sideTeam.B != null;
    $("rStart").textContent = "Lancer le match ⚽";
    $("rStart").classList.toggle("hidden", !isHost);
    $("rStart").disabled = !ready;
    $("rMsg").textContent = (A === 0 || B === 0) ? "En attente d'un adversaire... Donne le code à ton ami !"
      : (r.sideTeam.A == null || r.sideTeam.B == null) ? \`👇 Chaque équipe choisit \${r.mode === "cl" ? "son club" : "son pays"} (un joueur de l'équipe suffit).\`
      : r.type === "2v2" && (A < 2 || B < 2) ? (isHost ? "Tu peux lancer maintenant, ou attendre d'être 2 contre 2." : "En attente du lancement par l'hôte 🎮")
      : isHost ? "Tout le monde est prêt : lance le match !" : "En attente du lancement par l'hôte 🎮";
    return;
  }
  const taken = {};
  r.players.forEach(p => { if (p.team != null) taken[p.team] = p; });
  fillTeamGrid(grid, r.mode, i => netSend({ t: "pick", team: i }), (b, i) => {
    const owner = taken[i], mine = owner && owner.id === NET.id;
    if (mine) b.classList.add("picked");
    if (owner && !mine) { b.classList.add("taken"); b.disabled = true; b.insertAdjacentHTML("beforeend", \`<small>\${esc(owner.name)}</small>\`); }
  });
  const allPicked = r.players.every(p => p.team != null);
  $("rStart").textContent = "Lancer le tournoi 🏆";
  $("rStart").classList.toggle("hidden", !isHost);
  $("rStart").disabled = !(r.players.length >= 2 && allPicked);
  $("rMsg").textContent = r.players.length < 2 ? "En attente d'autres joueurs... Partage le code !"
    : !allPicked ? "Chaque joueur doit choisir une équipe (pas de doublon)."
    : isHost ? "Tout le monde est prêt : lance le tournoi !" : "En attente du lancement par l'hôte 🎮";
  if (!meP || meP.team == null) $("rMsg").textContent = "👇 Choisis ton équipe ! " + $("rMsg").textContent;
}

function leaveOnline() {
  endWatchers();
  netSend({ t: "leave" });
  NET.room = null; NET.live = null; NET.readyFrom.clear();
  G = null; M = null; T = null;
  stopAmbience();
  show("title");
}

/* ---------- tournoi en ligne ---------- */
function myTeamOnline() {
  const r = NET.room;
  const p = r && r.players.find(x => x.id === NET.id);
  return p ? p.team : (T ? T.me : null);
}
function myOnlineMatch() {
  if (!T || !T.online) return null;
  const t = T.rounds[T.stage];
  if (!t || t.indexOf(T.me) < 0) return null;
  const mm = myMatch(T.stage);
  mm.mt = T.matches[mm.m];
  return mm;
}
function onTour(tour) {
  const me = myTeamOnline();
  const old = T;
  T = { online: true, me, comp: tour.mode || COMP, rounds: tour.rounds, scores: tour.scores, stage: tour.stage, stages: tour.stages,
        matches: tour.matches, champion: tour.champion, humans: tour.humans, diff: tour.diff };
  if (!old || old.stage !== T.stage) NET.readyFrom.clear();
  if (G || M) {
    const mm = myOnlineMatch();
    const sc = mm && T.scores[T.stage] && T.scores[T.stage][mm.m];
    if (NET.live && mm && mm.mt.done && sc && sc.ff) { // l'adversaire est parti : victoire par forfait
      G = null; M = null; NET.live = null; stopAmbience();
      toast("Ton adversaire a quitté le match : victoire par forfait !");
      showOnlineBracket();
    }
    return;
  }
  showOnlineBracket();
}
function showOnlineBracket() {
  if (!T || !T.online || CELEB) return;
  if (T.champion != null) {
    const key = T.rounds[0].join(",") + ":" + T.champion;
    if (celebShownFor !== key) { celebShownFor = key; return startCeleb(T.champion, showOnlineBracket); }
    const champ = TEAMS[T.champion].name;
    const owner = T.humans[T.champion];
    showEnd(T.champion === T.me ? "🏆 CHAMPION !" : \`🏆 \${champ} champion !\`,
      T.champion === T.me ? \`Bravo ! \${champ} remporte la \${compOf().name} !\`
        : \`\${champ}\${owner ? " (" + owner.name + ")" : " (bot)"} remporte la \${compOf().name}.\`);
    $("againBtn").textContent = "Retour à l'accueil";
    return;
  }
  hideScreens();
  $("bTitle").textContent = T.stages[T.stage];
  const mm = myOnlineMatch();
  const btn = $("playBtn");
  btn.disabled = false;
  btn.classList.remove("hidden");
  if (!mm) {
    $("bSub").textContent = "Tu es éliminé · tu peux suivre la suite du tournoi ici";
    btn.classList.add("hidden");
  } else if (mm.mt.done) {
    $("bSub").textContent = "Match terminé ! En attente des autres matchs...";
    btn.classList.add("hidden");
  } else if (mm.mt.type === "bot") {
    $("bSub").textContent = \`\${TEAMS[T.me].name} (toi)  vs  \${TEAMS[mm.opp].name} (bot) · \${D().label}\`;
    btn.textContent = "Jouer le match ⚽";
  } else {
    const peer = T.humans[mm.opp];
    $("bSub").textContent = \`\${TEAMS[T.me].name} (toi)  vs  \${TEAMS[mm.opp].name} (\${peer.name}) · EN DIRECT\`;
    const ready = NET.live && NET.live.readyMe && NET.live.stage === T.stage;
    btn.textContent = ready ? \`En attente de \${peer.name}...\` : "Je suis prêt ✅";
    btn.disabled = !!ready;
  }
  $("leaveTour").classList.remove("hidden");
  renderLiveList();
  renderBracket($("bGrid"));
  $("bracketScreen").classList.remove("hidden");
}
function onlinePlay() {
  const mm = myOnlineMatch();
  if (!mm || mm.mt.done) return;
  if (mm.mt.type === "bot") { COMP = T.comp; startGame(mm.opp); return; }
  const peer = T.humans[mm.opp].id;
  NET.live = { kind: "tour", host: mm.first, hostId: mm.first ? NET.id : peer, peers: [peer], m: mm.m, stage: T.stage, readyMe: true };
  relay(peer, { k: "ready", stage: T.stage });
  if (mm.first && NET.readyFrom.has(peer + ":" + T.stage)) startLiveHost();
  else showOnlineBracket();
}
// fin d'un match contre un bot : on envoie le score au serveur
function onlineFinish(res) {
  const mm = myOnlineMatch();
  if (mm) netSend({ t: "result", m: mm.m, res: mm.first ? res : flipRes(res) });
  showOnlineBracket();
}

/* =========================================================
   MATCH EN DIRECT (tournoi, 1 contre 1, 2 contre 2)
   L'hôte calcule le match. Les autres joueurs envoient leurs commandes
   et voient le match en douceur : leur propre joueur bouge tout de suite
   chez eux (prédiction), les autres sont lissés entre deux images reçues.
   ========================================================= */
const SNAP_MS = 50;            // l'hôte envoie l'état du match 20 fois par seconde
const INTERP_MS = 110;         // les invités affichent le match avec 0,11 s de retard pour qu'il soit fluide

function startLiveHost() {
  const mm = myOnlineMatch();
  const L = NET.live;
  const opp = T.humans[mm.opp];
  L.hum = [{ id: NET.id, name: ME.name, role: ME.role, pw: hasPw(), team: 0 }, { id: opp.id, name: opp.name, role: opp.role, pw: !!opp.pw, team: 1 }];
  L.tIdx = [T.me, mm.opp];
  L.label = T.stages[T.stage].toUpperCase();
  hostStartLive(L);
}
function hostStartLive(L) {
  const weather = pickWeather();
  relay(L.peers, { k: "start", tIdx: L.tIdx, hum: L.hum, label: L.label, comp: COMP, flip: false, weather });
  startGame(L.tIdx[1], { remote: true, tIdx: L.tIdx, live: L, weather, humans: L.hum.map(h => Object.assign({}, h, { local: h.id === NET.id })) });
  G.label = L.label;
  showGameMsg("COUP D'ENVOI", "#ffd23f", 1.2);
}
// match 1 contre 1 / 2 contre 2 : le serveur annonce le début
function onFriendlyStart(match) {
  const host = match.host === NET.id;
  NET.live = { kind: "friendly", host, hostId: match.host, peers: host ? match.hum.map(h => h.id).filter(id => id !== NET.id) : [match.host],
    hum: match.hum, tIdx: match.tIdx, label: match.hum.length > 2 ? "MATCH 2 CONTRE 2" : "MATCH 1 CONTRE 1" };
  initAudio();
  if (host) hostStartLive(NET.live);
  else { hideScreens(); toast("Le match commence !"); }
}
function onFriendlyEnd(res) {
  if (NET.live && NET.live.kind === "friendly") { G = null; M = null; NET.live = null; stopAmbience(); }
  const r = NET.room;
  const tA = r && r.sideTeam.A != null ? TEAMS[r.sideTeam.A].name : "Équipe 1", tB = r && r.sideTeam.B != null ? TEAMS[r.sideTeam.B].name : "Équipe 2";
  toast(\`Fin du match : \${tA} \${res.a} - \${res.b} \${tB}\${res.pa != null ? \` (tirs au but \${res.pa}-\${res.pb})\` : ""}\`);
  if (!CELEB) { show("roomScreen"); renderRoom(); }
}
// fin du temps réglementaire chez l'hôte
function liveGameOver(a, b, et, tIdx, L) {
  if (!L) return;
  if (a !== b) return liveFinish(L, { a, b, et });
  pendingScore = { a, b };
  const shooter = (L.hum.find(h => h.team === 1) || {}).id;
  relay(L.peers, { k: "pens", a, b, tIdx, shooter });
  startMatch(tIdx[1], { remote: true, tIdx, live: L, peer: shooter });
}
function liveFinish(L, res) {        // l'hôte termine le match (score dans l'ordre du tableau)
  endWatchers();
  if (L) {
    if (L.kind === "friendly") netSend({ t: "fresult", res });
    else { const mm = myOnlineMatch(); if (mm) netSend({ t: "result", m: L.m, res }); }
    relay(L.peers, { k: "end", res });
  }
  G = null; M = null; NET.live = null;
  stopAmbience();
  if (L && L.kind === "friendly") { show("roomScreen"); renderRoom(); }
  else showOnlineBracket();
}
// un invité quitte pendant le match : son joueur est joué par l'ordinateur
function liveGuestGone(id) {
  const L = NET.live;
  L.peers = L.peers.filter(x => x !== id);
  if (G && G.remote) {
    const h = G.hum.find(x => x.id === id);
    if (h) {
      if (h.ctrl) h.ctrl.hum = null;
      G.hum = G.hum.filter(x => x !== h);
      G.humTeams = [...new Set(G.hum.map(x => x.team))];
    }
  }
}

/* ---------- côté invité ---------- */
function startViewG(d) {
  hideScreens();
  COMP = d.comp || COMP;
  const hum = makeHumans(d.hum.map(h => Object.assign({}, h, { local: h.id === NET.id })));
  const me = hum.find(h => h.local) || null;
  const humTeams = [...new Set(hum.map(h => h.team))];
  G = {
    view: true, tIdx: d.tIdx, hum, me, humTeams, side: me ? me.team : 1, label: d.label, weather: d.weather || "clear", comm: null,
    cols: teamColors(d.tIdx[0], d.tIdx[1]), players: makePlayers(d.tIdx, humTeams),
    ref: { x: F.cx, y: F.cy - 9 * PX, fx: 0, fy: 1 },
    lines: [{ x: F.cx + 20 * PX, y: F.y1 - 16, fx: 0, fy: 1, flagT: 0 }, { x: F.cx - 20 * PX, y: F.y2 + 16, fx: 0, fy: -1, flagT: 0 }],
    card: null, foul: null, charges: [0, 0], fx: [], netHit: null, excite: 0,
    ball: { x: F.cx, y: F.cy, z: 0, vx: 0, vy: 0, owner: null, roll: 0 }, score: [0, 0], min: 0, period: 0, flip: false,
    restart: null, msg: "", msgT: 0, msgColor: "#fff", msgCard: null, ctrl: null, cheer: 0, freeze: 1, waitT: 0, ended: false, hintT: 4, cam: null,
    snaps: [], lastSnapAt: performance.now(), lagWarn: 0,
    pred: { hist: [], sent: new Map(), lastSend: 0, lastDx: 9, lastDy: 9, p: null, pendX: 0, pendY: 0, rtt: null, since: 0 },
  };
  whistle();
  startAmbience();
}
// état du match envoyé par l'hôte (tableaux de nombres, le plus léger possible)
function snapG() {
  const ix = p => p ? G.players.indexOf(p) : -1;
  const b = G.ball, r = G.ref, now = performance.now();
  const fl = p => (p.slide > 0 ? 1 : 0) | (p.down > 0 ? 2 : 0) | (p.off ? 4 : 0) | (p.dribT > 0 ? 8 : 0) | (p.charge ? 16 : 0) | (p.fly ? 32 : 0) | (p.ko ? 64 : 0) | (p.stun > 0 ? 128 : 0) | (p.dash > 0 ? 256 : 0) | (p.cele ? 512 : 0) | (p.diveT > 0 ? 1024 : 0) | (p.diveDir > 0 ? 2048 : 0) | (p.sprinting ? 4096 : 0);
  const board = G.fx.find(f => f.k === "board");
  return {
    k: "sg",
    P: G.players.map(p => [Math.round(p.x), Math.round(p.y), Math.round(Math.atan2(p.fy, p.fx) * 100), fl(p), p.yellow, p.fly ? Math.round(p.fly.z || 0) : 0]),
    B: [Math.round(b.x), Math.round(b.y), ix(b.owner), Math.round(b.vx), Math.round(b.vy), Math.round(b.z || 0)],
    H: G.hum.map(h => [h.id === "local" ? NET.id : h.id, ix(h.ctrl), h.ack || 0, h.ackAt ? Math.round(now - h.ackAt) : 0, h.ctrl ? Math.round(h.ctrl.sta * 100) : 100]),
    Cm: G.comm && G.comm.t > 0 ? [G.comm.s, +G.comm.t.toFixed(1)] : null,
    S: G.score, Mi: +G.min.toFixed(2), Pe: G.period, F: G.flip,
    Rf: [Math.round(r.x), Math.round(r.y), Math.round(Math.atan2(r.fy, r.fx) * 100)],
    Ln: G.lines.map(l => [Math.round(l.x), l.flagT > 0 ? 1 : 0]),
    Cd: G.card, Fo: !!G.foul, Cg: G.charges, Ex: Math.round(G.excite * 10),
    R: G.restart ? [G.restart.type, G.restart.team, ix(G.restart.taker)] : null,
    Msg: G.msgT > 0 ? [G.msg, G.msgColor, +G.msgT.toFixed(2), G.msgCard] : null, Ch: G.cheer > 0,
    Nh: G.netHit ? [G.netHit.right ? 1 : 0, Math.round(G.netHit.y), +G.netHit.t.toFixed(2)] : null, Bd: board ? [board.n, +board.t.toFixed(1)] : null,
    W: G.waitT > 0, Fr: G.freeze > 0, E: G.ended,
  };
}
function applySnapG(s) {
  if (!G || !G.view) return;
  const now = performance.now();
  G.lagWarn = 0; G.lastSnapAt = now;
  G.snaps.push({ t: now, P: s.P, B: s.B, Rf: s.Rf, Ln: s.Ln });
  while (G.snaps.length > 2 && G.snaps[1].t < now - 1000) G.snaps.shift();
  // changements visibles tout de suite (sons, cartons, buts...)
  s.P.forEach((a, i) => {
    const p = G.players[i];
    const f = a[3];
    if (!p.init) { p.x = a[0]; p.y = a[1]; p.init = true; }
    if ((f & 8) && !(p.dribT > 0)) G.fx.push({ k: "txt", x: a[0], y: a[1] - 50, t: 0.9, s: "DRIBBLE !", c: "#7cf7ff" });
    if (p.fly && !(f & 32) && (f & 4)) G.fx.push({ k: "puff", x: a[0], y: a[1], t: 0.7 });
    if (a[4] > p.yellow) beep(1500, 0.15, "sine", 0.05);
    p.slide = f & 1 ? 1 : 0; p.down = f & 2 ? 1 : 0; p.off = !!(f & 4); p.dribT = f & 8 ? 1 : 0;
    p.charge = f & 16 ? {} : null; p.ko = !!(f & 64); p.stun = f & 128 ? 0.3 : 0;
    if (!(G.me && G.me.ctrl === p)) { p.dash = f & 256 ? 0.2 : 0; p.sprinting = !!(f & 4096); }
    p.cele = !!(f & 512); p.diveT = f & 1024 ? 0.3 : 0; p.diveDir = f & 2048 ? 1 : -1;
    p.fly = f & 32 ? Object.assign(p.fly || { t: 0 }, { z: a[5] }) : null;
    p.yellow = a[4];
  });
  if (s.Fo && !G.foul) whistle();
  G.card = s.Cd; G.foul = s.Fo; G.charges = s.Cg || [0, 0];
  G.excite = Math.max(G.excite, (s.Ex || 0) / 10);
  if (s.S[0] !== G.score[0] || s.S[1] !== G.score[1]) {
    const myTeam = G.me ? G.me.team : 1;
    if (s.S[myTeam] > G.score[myTeam]) crowdSound(0.3); else beep(120, 0.3, "sawtooth", 0.04);
    G.cheer = 2.5;
  }
  if (s.Pe !== G.period) { whistle(); G.hintT = 3; }
  if (s.R && !G.restart) beep(1800, 0.15, "sine", 0.04);
  if (s.E && !G.ended) { whistle(); setTimeout(whistle, 400); }
  G.score = s.S; G.min = s.Mi; G.period = s.Pe; G.flip = s.F;
  G.restart = s.R ? { type: s.R[0], team: s.R[1], taker: G.players[s.R[2]], t: 0 } : null;
  if (s.Msg) { G.msg = s.Msg[0]; G.msgColor = s.Msg[1]; G.msgT = s.Msg[2]; G.msgCard = s.Msg[3] || null; }
  if (s.Ch) G.cheer = Math.max(G.cheer, 0.3);
  G.netHit = s.Nh ? { right: !!s.Nh[0], y: s.Nh[1], t: s.Nh[2] } : null;
  const bd = G.fx.find(f => f.k === "board");
  if (s.Bd) { if (bd) bd.t = s.Bd[1]; else G.fx.push({ k: "board", n: s.Bd[0], t: s.Bd[1] }); } else if (bd) bd.t = 0;
  G.lines.forEach((l, i) => { if (s.Ln && s.Ln[i]) l.flagT = s.Ln[i][1] ? 1 : 0; });
  G.waitT = s.W ? 1 : 0; G.freeze = s.Fr ? 1 : 0; G.ended = s.E;
  // qui contrôle quel joueur + correction de mon joueur (prédiction)
  for (const p of G.players) p.hum = null;
  if (s.Cm) G.comm = { s: s.Cm[0], t: s.Cm[1] }; else if (G.comm && G.comm.t > 1) G.comm.t = 0.5;
  for (const [id, ci, ack, el, sta] of s.H) {
    const h = G.hum.find(x => x.id === id);
    if (!h) continue;
    const p = ci >= 0 ? G.players[ci] : null;
    if (p && sta != null && h !== G.me) p.sta = sta / 100;
    if (p && sta != null && h === G.me && Math.abs(p.sta - sta / 100) > 0.15) p.sta = sta / 100;   // garde mon endurance proche de celle de l'hôte
    if (h === G.me) reconcile(p, s.P[ci], ack, el, now);
    h.ctrl = p;
    if (p) p.hum = h;
  }
  G.ctrl = G.me ? G.me.ctrl : null;
}
// mon joueur peut-il bouger tout seul chez moi (prédiction) ?
const predictable = p => p && !p.off && !p.fly && !p.slide && !p.down && !p.charge && !(G.restart && G.restart.taker === p) && !G.foul && G.waitT <= 0 && G.freeze <= 0 && !G.ended;
function reconcile(p, a, ack, el, now) {
  const P = G.pred;
  if (!p || !a) { P.p = null; P.hist = []; return; }
  const sentAt = P.sent.get(ack);
  if (sentAt != null) {                          // temps d'aller-retour (pour compenser le retard)
    const rtt = clamp(now - sentAt - el, 0, 1500);
    P.rtt = P.rtt == null ? rtt : P.rtt * 0.85 + rtt * 0.15;
  }
  if (P.p !== p) {                               // nouveau joueur contrôlé : on part de la position de l'hôte, avancée du retard
    const prev = G.snaps.length > 1 ? G.snaps[G.snaps.length - 2] : null;
    let vx = 0, vy = 0;
    if (prev && prev.P[G.players.indexOf(p)]) {
      const o = prev.P[G.players.indexOf(p)], dtS = Math.max(20, now - prev.t) / 1000;
      vx = (a[0] - o[0]) / dtS; vy = (a[1] - o[1]) / dtS;
    }
    const lead = Math.min(0.25, (P.rtt || 150) / 2000);
    P.p = p; P.hist = []; P.pendX = 0; P.pendY = 0; P.since = NET.seq + 1;
    p.x = a[0] + vx * lead; p.y = a[1] + vy * lead;
    return;
  }
  if (!predictable(p) || ack < (P.since || 0) || sentAt == null || !P.hist.length) return;
  // où était mon joueur (chez moi) au moment qui correspond à cette image de l'hôte ?
  const tRef = sentAt + el;
  let ref = P.hist[0];
  for (let i = P.hist.length - 1; i >= 0; i--) if (P.hist[i].t <= tRef) { ref = P.hist[i]; break; }
  const ex = a[0] - ref.x - P.pendX, ey = a[1] - ref.y - P.pendY;
  if (Math.hypot(ex, ey) > 90) {                 // trop loin : on recale d'un coup
    const tx = ex + P.pendX, ty = ey + P.pendY;
    p.x += tx; p.y += ty; for (const h of P.hist) { h.x += tx; h.y += ty; }
    P.pendX = 0; P.pendY = 0;
  } else { P.pendX += ex; P.pendY += ey; }        // sinon on corrige en douceur, image après image
  for (const [n] of P.sent) if (n < ack - 60) P.sent.delete(n);
}
// image du match chez l'invité : interpolation entre deux états reçus + prédiction de mon joueur
function viewUpdateG(dt) {
  const now = performance.now();
  const snaps = G.snaps;
  if (now - G.lastSnapAt > 450) G.lagWarn = 1;
  let a = null, b = null, u = 0;
  if (snaps.length) {
    const rt = now - INTERP_MS, last = snaps[snaps.length - 1];
    if (rt <= snaps[0].t) a = b = snaps[0];
    else if (rt >= last.t) a = b = last;
    else {
      let i = 1;
      while (snaps[i].t < rt) i++;
      a = snaps[i - 1]; b = snaps[i]; u = clamp((rt - a.t) / ((b.t - a.t) || 1), 0, 1);
    }
  }
  const mine = G.ctrl, P = G.pred;
  const usePred = mine && P.p === mine && predictable(mine);
  if (a) {
    G.players.forEach((p, i) => {
      if (usePred && p === mine) return;
      const pa = a.P[i], pb = b.P[i];
      if (!pa || !pb) return;
      p.x = lerp(pa[0], pb[0], u); p.y = lerp(pa[1], pb[1], u);
      let an = pb[2] / 100;
      p.fx = Math.cos(an); p.fy = Math.sin(an);
      if (p.fly) p.fly.t += dt;
    });
    const r = G.ref; r.x = lerp(a.Rf[0], b.Rf[0], u); r.y = lerp(a.Rf[1], b.Rf[1], u);
    const ra = b.Rf[2] / 100; r.fx = Math.cos(ra); r.fy = Math.sin(ra);
    if (a.Ln) G.lines.forEach((l, i) => { if (a.Ln[i] && b.Ln[i]) l.x = lerp(a.Ln[i][0], b.Ln[i][0], u); });
  }
  // mon joueur : il bouge tout de suite avec ma souris / mon joystick
  if (G.me && mine) {
    const d = inputDir(mine);
    d.sp = sprintHeld();
    sendGuestInput(d, now);
    if (usePred) {
      const hasBall = G.ball.owner === mine;
      const len = Math.hypot(d.dx, d.dy);
      updateStamina(mine, d.sp, len, dt);
      if (len > 0.1) { mine.fx = d.dx / len; mine.fy = d.dy / len; }
      if (mine.dash > 0) mine.dash -= dt;
      const sp = humanSpeed(mine, hasBall);
      mine.x += d.dx * sp * dt; mine.y += d.dy * sp * dt;
      // correction douce venant de l'hôte
      const k = Math.min(1, dt * 7), cx = (P.pendX || 0) * k, cy = (P.pendY || 0) * k;
      if (cx || cy) { mine.x += cx; mine.y += cy; for (const h of P.hist) { h.x += cx; h.y += cy; } P.pendX -= cx; P.pendY -= cy; }
      clampPlayer(mine);
      P.hist.push({ t: now, x: mine.x, y: mine.y });
      while (P.hist.length > 90) P.hist.shift();
    } else P.hist = [];
  }
  // ballon
  const B = G.ball;
  const ox = B.x, oy = B.y;
  if (a) {
    const ba = a.B, bb = b.B;
    B.owner = bb[2] >= 0 ? G.players[bb[2]] : null;
    B.vx = bb[3]; B.vy = bb[4];
    let tx, ty;
    if (B.owner) {
      const o = B.owner, wig = o.dribT > 0 ? Math.sin(now / 1000 * 16) * 6 : 0;
      tx = o.x + o.fx * 12 - o.fy * wig; ty = o.y + o.fy * 12 + o.fx * wig; B.z = 0;
    } else { tx = lerp(ba[0], bb[0], u); ty = lerp(ba[1], bb[1], u); B.z = lerp(ba[5] || 0, bb[5] || 0, u); }
    // si le ballon "saute" (il change de joueur), on le fait glisser au lieu de le téléporter
    const jump = Math.hypot(tx - B.x, ty - B.y);
    if (jump > 25 && jump < 400) { const k = Math.min(1, dt * 16); B.x += (tx - B.x) * k; B.y += (ty - B.y) * k; }
    else { B.x = tx; B.y = ty; }
  }
  B.roll = (B.roll || 0) + Math.hypot(B.x - ox, B.y - oy) / 4.5;
  for (const p of G.players) if (p.charge && Math.random() < 0.5) G.fx.push({ k: "dust", x: p.x - p.fx * 14 + rand(-5, 5), y: p.y + rand(-3, 3), t: 0.5 });
  if (G.msgT > 0) G.msgT -= dt;
  if (G.cheer > 0) G.cheer -= dt;
  if (G.comm && G.comm.t > 0) G.comm.t -= dt;
  if (G.hintT > 0 && canAct()) G.hintT -= dt;
  updateFx(dt);
  updateAmbience(dt);
}
// mes commandes envoyées à l'hôte : la direction de course (numérotée pour la prédiction)
function sendGuestInput(d, now) {
  const P = G.pred, L = NET.live;
  if (!L) return;
  const dx = +d.dx.toFixed(2), dy = +d.dy.toFixed(2);
  const sp = d.sp ? 1 : 0;
  const changed = Math.abs(dx - P.lastDx) > 0.04 || Math.abs(dy - P.lastDy) > 0.04 || sp !== P.lastSp;
  if (!changed && now - P.lastSend < 200) return;
  if (changed && now - P.lastSend < 33) return;      // au plus 30 fois par seconde
  P.lastSend = now; P.lastDx = dx; P.lastDy = dy; P.lastSp = sp;
  const n = ++NET.seq;
  P.sent.set(n, now);
  relay(L.hostId, { k: "in", n, dx, dy, sp });
}

/* ---------- tirs au but en direct ---------- */
function startViewM(tIdx, spec) {
  hideScreens();
  stopAmbience();
  M = {
    view: true, spec: !!spec, local: "opp", tIdx, shots: { me: [], opp: [] }, turn: "me", phase: "aim", power: 0,
    ball: { x: SPOT.x, y: SPOT.y, r: 14, sy: SPOT.y + 12 }, keeper: { x: KHOME.x, y: KHOME.y, angle: 0 },
    shooter: { x: 368, y: 500 }, aim: { x: 400, y: 185 }, dive: null, msg: "", msgT: 0, msgColor: "#fff", cheer: 0, key: "",
  };
  whistle();
}
function snapM() {
  return {
    k: "sm", tu: M.turn, ph: M.phase, pw: +M.power.toFixed(3),
    bl: [Math.round(M.ball.x), Math.round(M.ball.y), +M.ball.r.toFixed(1), Math.round(M.ball.sy)],
    kp: [Math.round(M.keeper.x), Math.round(M.keeper.y), +M.keeper.angle.toFixed(2)],
    sh: [Math.round(M.shooter.x), Math.round(M.shooter.y)], s: M.shots,
    am: M.turn === "opp" ? [Math.round(M.aim.x), Math.round(M.aim.y)] : null,
    msg: M.msgT > 0 ? [M.msg, M.msgColor, +M.msgT.toFixed(2)] : null, ch: M.cheer > 0,
  };
}
function applySnapM(s) {
  if (!M || !M.view) return;
  const key = s.tu + s.s.me.length + "-" + s.s.opp.length;
  if (key !== M.key) { M.key = key; M.dive = null; M.aim = { x: 400, y: 185 }; }
  if (s.s.me.length + s.s.opp.length > M.shots.me.length + M.shots.opp.length) {
    const last = s.s.me.length > M.shots.me.length ? s.s.me[s.s.me.length - 1] : s.s.opp[s.s.opp.length - 1];
    if (last) crowdSound(); else beep(120, 0.3, "sawtooth", 0.04);
  }
  if (s.ph === "flight" && M.phase !== "flight") beep(160, 0.08, "triangle", 0.15);
  M.turn = s.tu; M.phase = s.ph; M.power = s.pw; M.shots = s.s;
  if (M.spec && s.am) M.aim = { x: s.am[0], y: s.am[1] };
  M.ball.x = s.bl[0]; M.ball.y = s.bl[1]; M.ball.r = s.bl[2]; M.ball.sy = s.bl[3];
  M.keeper.x = s.kp[0]; M.keeper.y = s.kp[1]; M.keeper.angle = s.kp[2];
  M.shooter.x = s.sh[0]; M.shooter.y = s.sh[1];
  if (s.msg) { M.msg = s.msg[0]; M.msgColor = s.msg[1]; M.msgT = s.msg[2]; }
  if (s.ch) M.cheer = 0.3;
}
function remoteShoot() {         // l'invité frappe : l'hôte calcule le tir
  const p = M.power;
  const spread = 8 + Math.abs(p - 0.72) * 90;
  let tx = M.aim.x + rand(-spread, spread), ty = M.aim.y + rand(-spread, spread);
  if (p > 0.9) ty -= (p - 0.9) * 600;
  ty = Math.min(ty, GOAL.y2 - 8);
  launch({ x: tx, y: ty }, M.dive || { ...KHOME }, 0.35 + (1 - p) * 0.4, "opp");
}

/* ---------- messages entre les joueurs ---------- */
function onRelay(from, d) {
  const L = NET.live;
  switch (d.k) {
    case "ready":
      NET.readyFrom.add(from + ":" + d.stage);
      if (L && L.kind === "tour" && L.readyMe && L.host && L.peers[0] === from && !G && !M && T && d.stage === T.stage) startLiveHost();
      break;
    case "start":
      if (d.watch) {                                   // je regarde le match de quelqu'un
        if (!NET.watch || G || M) return relay(from, { k: "unwatch" });
        NET.watch.hostId = from;
        startViewG(d); G.watch = true; G.hintT = 0;
        $("stopWatch").classList.remove("hidden");
        return;
      }
      if (!L) { const mm = myOnlineMatch(); NET.live = { kind: "tour", host: false, hostId: from, peers: [from], m: mm ? mm.m : -1, stage: T ? T.stage : 0, readyMe: true }; }
      else if (L.hostId !== from) return;
      NET.live.hum = d.hum; NET.live.tIdx = d.tIdx;
      startViewG(d);
      break;
    case "sg": if ((L && from === L.hostId) || (NET.watch && from === NET.watch.hostId)) applySnapG(d); break;
    case "watch": onWatchRequest(from); break;
    case "watchreq": if (L && L.host && L.peers.includes(from) && d.spec) addWatcher(d.spec); break;
    case "unwatch": NET.watchers = NET.watchers.filter(x => x !== from); break;
    case "nowatch": if (NET.watch && !G && !M) { NET.watch = null; toast("Ce joueur n'est pas en train de jouer un match."); } break;
    case "pw": if (G && G.remote) { const h = humById(from); if (h && h.pw) applyPower(h, d.kind); } break;
    case "fx": if (L && from === L.hostId && (d.fx === "scream" || d.fx === "black")) showFx(d.fx); break;
    case "pwok": if (L && from === L.hostId) toast(d.msg); break;
    case "in": if (G && G.remote) { const h = humById(from); if (h && d.n > h.ack) { h.inp.dx = clamp(+d.dx || 0, -1, 1); h.inp.dy = clamp(+d.dy || 0, -1, 1); h.inp.sp = !!d.sp; h.ack = d.n; h.ackAt = performance.now(); } } break;
    case "rel": case "right": case "pass": case "tackle": case "drib": case "sw": case "chg":
      if (G && G.remote) { const h = humById(from); if (h) doAct(h, d.k, d); }
      break;
    case "pens":
      if (NET.watch && from === NET.watch.hostId) {     // le match que je regarde va aux tirs au but
        G = null; pendingScore = { a: d.a, b: d.b };
        startViewM(d.tIdx, true); M.watch = true;
        $("stopWatch").classList.remove("hidden");
        return;
      }
      if (!L || from !== L.hostId) return;
      G = null; pendingScore = { a: d.a, b: d.b };
      startViewM(d.tIdx, d.shooter !== NET.id);
      break;
    case "sm": if ((L && from === L.hostId) || (NET.watch && from === NET.watch.hostId)) applySnapM(d); break;
    case "paim": if (M && M.remote && M.peer === from && M.turn === "opp" && M.phase === "raim") M.aim = clampAim(d); break;
    case "plock": if (M && M.remote && M.peer === from && M.turn === "opp" && M.phase === "raim") { M.aim = clampAim(d); M.phase = "rpower"; M.power = 0; M.powerDir = 1; } break;
    case "pshoot": if (M && M.remote && M.peer === from && M.turn === "opp" && M.phase === "rpower") remoteShoot(); break;
    case "pdive": if (M && M.remote && M.peer === from && M.turn === "me" && (M.phase === "aim" || M.phase === "power") && !M.rdive) M.rdive = clampKeeper(d); break;
    case "end":
      if (NET.watch && from === NET.watch.hostId) return stopWatching("Le match est terminé !");
      if (!L || from !== L.hostId) return;
      G = null; M = null; NET.live = null; stopAmbience();
      if (L.kind === "friendly") { show("roomScreen"); renderRoom(); }
      else showOnlineBracket();
      break;
  }
}

// envoi régulier de l'état du match par l'hôte (20 fois par seconde)
function netTick() {
  const L = NET.live;
  if (L && !L.host) return;
  const to = (L ? L.peers : []).concat(NET.watchers);
  if (!to.length) return;
  const now = performance.now();
  if (now - NET.sendT < SNAP_MS - 2) return;
  NET.sendT = now;
  if (G && !G.view) relay(to, snapG());
  else if (M && !M.view) relay(to, snapM());
}
// si l'hôte change d'onglet, le navigateur ralentit la page : un "minuteur" séparé garde le match en marche
let BG_TICK = null;
try {
  const src = "setInterval(()=>postMessage(0),33)";
  BG_TICK = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  let bgLast = performance.now();
  BG_TICK.onmessage = () => {
    const now = performance.now();
    if (!document.hidden) { bgLast = now; return; }
    const dt = Math.min(0.05, (now - bgLast) / 1000); bgLast = now;
    if ((NET.live && NET.live.host) || NET.watchers.length) {
      if (G && !G.view) updateGame(dt);
      else if (M && !M.view) update(dt);
      netTick();
    }
  };
} catch (e) { BG_TICK = null; }

/* =========================================================
   PANNEAU DE MATCH (créateur 👑 et joueurs à qui il l'a donné)
   ========================================================= */
const hasPw = () => !!(ME && (ME.role === "createur" || ME.powers));
let pwOn = null;
function pwTick() {
  const on = hasPw() && !!G && !!G.me && !G.ended;
  if (on !== pwOn) { pwOn = on; $("pwBtn").classList.toggle("hidden", !on); if (!on) $("pwPanel").classList.add("hidden"); }
  if (on && !$("pwPanel").classList.contains("hidden")) {
    const humOpp = G.hum.some(h => h.team !== G.me.team);
    $("pwPanel").querySelectorAll("[data-pw=scream],[data-pw=black]").forEach(b => b.disabled = !humOpp);
    $("pwNote").textContent = humOpp ? "Touche P pour ouvrir / fermer" : "Screamer et écran noir : seulement contre un vrai joueur";
  }
}
$("pwBtn").onclick = () => $("pwPanel").classList.toggle("hidden");
$("pwPanel").querySelectorAll("button").forEach(b => b.onclick = e => { e.stopPropagation(); usePower(b.dataset.pw); });
window.addEventListener("keydown", e => {
  if ((e.code === "KeyP" || (e.key || "").toLowerCase() === "p") && pwOn && !/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || "")) $("pwPanel").classList.toggle("hidden");
});
function usePower(kind) {
  if (!G || !G.me || !hasPw()) return;
  if (G.view) { if (NET.live) relay(NET.live.hostId, { k: "pw", kind }); return; }
  applyPower(G.me, kind);
}
// appliqué par l'ordinateur qui calcule le match
function applyPower(h, kind) {
  if (!G || G.view || G.ended || !h) return;
  const me = h.team, opp = 1 - me, now = performance.now();
  h.cd = h.cd || {};
  const tell = msg => { if (h.local) toast(msg); else relay(h.id, { k: "pwok", msg }); };
  if (h.cd[kind] && now < h.cd[kind]) return tell("⏳ Attends un peu avant de recommencer");
  if (kind === "plus") { G.score[me]++; G.cheer = 1.5; showGameMsg(\`⚡ BUT POUR \${TEAMS[G.tIdx[me]].name.toUpperCase()} !\`, "#ffd23f", 1.6); crowdSound(0.25); h.cd[kind] = now + 800; }
  else if (kind === "minus") {
    if (G.score[opp] <= 0) return tell("L'adversaire n'a aucun but à enlever");
    G.score[opp]--; showGameMsg("⚡ BUT ANNULÉ !", "#ff8a80", 1.6); whistle(); h.cd[kind] = now + 800;
  } else if (kind === "expel") {
    const list = G.players.filter(q => q.team === opp && !q.gk && !q.off && !q.fly);
    if (list.length <= 1) return tell("Il ne reste qu'un seul joueur adverse !");
    const q = list[Math.floor(Math.random() * list.length)];
    if (G.ball.owner === q) { G.ball.owner = null; G.ball.vx = 0; G.ball.vy = 0; }
    if (G.ball.target === q) G.ball.target = null;
    sendOff(q); whistle();
    showGameMsg(\`🟥 N°\${q.num} \${q.name} EXPULSÉ !\`, "#ff5252", 1.8, "red");
    h.cd[kind] = now + 1000;
  } else if (kind === "scream" || kind === "black") {
    const targets = G.hum.filter(o => o.team !== me);
    if (!targets.length) return tell("Pas de vrai joueur en face !");
    for (const o of targets) { if (o.local) showFx(kind); else relay(o.id, { k: "fx", fx: kind }); }
    tell(kind === "scream" ? "😱 Screamer envoyé !" : "⬛ Écran noir envoyé (5 s) !");
    h.cd[kind] = now + (kind === "scream" ? 8000 : 10000);
  }
}
function showFx(kind) { if (kind === "scream") startScare(); else blackout(5000); }
function blackout(ms) {
  $("blackout").classList.remove("hidden");
  clearTimeout(blackout.t); blackout.t = setTimeout(() => $("blackout").classList.add("hidden"), ms);
}
// Le screamer : un visage de monstre qui surgit avec un cri
let SCARE = null;
function startScare() {
  initAudio();
  SCARE = { t: 0 };
  $("scare").classList.remove("hidden");
  if (AC) {
    try {
      const t0 = AC.currentTime, dur = 1.5;
      const g = AC.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.55, t0 + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      const dist = AC.createWaveShaper(); const curve = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 6); } dist.curve = curve;
      dist.connect(g); g.connect(AC.destination);
      for (const [f, type] of [[620, "sawtooth"], [910, "square"], [455, "sawtooth"]]) {
        const o = AC.createOscillator(); o.type = type;
        o.frequency.setValueAtTime(f, t0); o.frequency.exponentialRampToValueAtTime(f * 0.35, t0 + dur);
        const lfo = AC.createOscillator(), lg = AC.createGain(); lfo.frequency.value = 23; lg.gain.value = f * 0.08; lfo.connect(lg); lg.connect(o.frequency);
        o.connect(dist); o.start(t0); o.stop(t0 + dur); lfo.start(t0); lfo.stop(t0 + dur);
      }
      const len = AC.sampleRate * dur, buf = AC.createBuffer(1, len, AC.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const n = AC.createBufferSource(); n.buffer = buf; const bp = AC.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1800; n.connect(bp); bp.connect(dist); n.start(t0);
    } catch (e) {}
  }
}
function drawScare(dt) {
  if (!SCARE) return;
  SCARE.t += dt;
  const t = SCARE.t, c = $("scare"), g = c.getContext("2d");
  if (t > 1.7) { SCARE = null; c.classList.add("hidden"); return; }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = Math.random() < 0.25 ? "#300" : "#000"; g.fillRect(0, 0, 800, 500);
  const sc = 0.7 + Math.min(1, t * 5) * 0.55, sh = 10 * Math.min(1, t * 3);
  g.translate(400 + (Math.random() - 0.5) * sh, 250 + (Math.random() - 0.5) * sh); g.scale(sc, sc);
  const vg = g.createRadialGradient(0, 0, 40, 0, 0, 330); vg.addColorStop(0, "rgba(140,0,0,.0)"); vg.addColorStop(1, "rgba(120,0,0,.6)");
  // visage pâle et déformé
  const fg = g.createRadialGradient(-30, -60, 20, 0, 0, 230); fg.addColorStop(0, "#d9dccf"); fg.addColorStop(0.6, "#9aa391"); fg.addColorStop(1, "#3c4436");
  g.fillStyle = fg;
  g.beginPath(); g.moveTo(0, -230); g.bezierCurveTo(170, -225, 190, -40, 150, 90); g.bezierCurveTo(120, 200, 60, 250, 0, 255); g.bezierCurveTo(-60, 250, -125, 195, -152, 85); g.bezierCurveTo(-195, -50, -165, -228, 0, -230); g.fill();
  // fissures
  g.strokeStyle = "rgba(30,20,20,.55)"; g.lineWidth = 3;
  g.beginPath(); g.moveTo(-40, -228); g.lineTo(-55, -170); g.lineTo(-30, -140); g.moveTo(90, -200); g.lineTo(70, -150); g.lineTo(95, -120); g.stroke();
  // yeux creux avec pupilles rouges
  for (const s of [-1, 1]) {
    g.fillStyle = "#050505"; g.beginPath(); g.ellipse(s * 62, -55, 46, 58, s * 0.25, 0, Math.PI * 2); g.fill();
    const pr = 7 + Math.sin(t * 40) * 2;
    const eg = g.createRadialGradient(s * 58, -48, 1, s * 58, -48, pr * 3); eg.addColorStop(0, "#fff"); eg.addColorStop(0.25, "#ff2020"); eg.addColorStop(1, "rgba(255,0,0,0)");
    g.fillStyle = eg; g.beginPath(); g.arc(s * 58, -48, pr * 3, 0, Math.PI * 2); g.fill();
  }
  // bouche grande ouverte avec des dents pointues
  const open = 90 + Math.min(1, t * 6) * 40;
  g.fillStyle = "#0a0000"; g.beginPath(); g.ellipse(0, 125, 92, open / 2 + 25, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#e8e2c8";
  for (let i = -5; i <= 5; i++) {
    const x = i * 16;
    g.beginPath(); g.moveTo(x - 8, 125 - open / 2 - 18); g.lineTo(x + 8, 125 - open / 2 - 18); g.lineTo(x, 125 - open / 2 + 14); g.fill();
    g.beginPath(); g.moveTo(x - 8, 125 + open / 2 + 18); g.lineTo(x + 8, 125 + open / 2 + 18); g.lineTo(x, 125 + open / 2 - 12); g.fill();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = vg; g.translate(400, 250); g.fillRect(-400, -250, 800, 500); g.setTransform(1, 0, 0, 1, 0, 0);
  if (Math.random() < 0.15) { g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(0, Math.random() * 500, 800, 6 + Math.random() * 20); }
}

/* =========================================================
   AMIS
   ========================================================= */
let FRIENDS = { friends: [], reqIn: [], reqOut: [] };
function onFriends(m) {
  FRIENDS = m;
  $("ubFriends").innerHTML = "👥 Amis" + (m.reqIn.length ? \`<span class="reqbadge">\${m.reqIn.length}</span>\` : "");
  if (PANEL.kind === "friends") renderFriends();
}
$("ubFriends").onclick = () => openFriends();
function openFriends() {
  if (!NET.ok || !ME) return toast("Pas de connexion au serveur");
  PANEL.kind = "friends";
  $("profile").classList.remove("hidden");
  renderFriends();
  netSend({ t: "friends" });
}
function friendStatus(f) {
  if (!f.online) return \`<span class="dot-off"></span>hors ligne\`;
  if (f.playing) return \`<span class="dot-on"></span>⚽ en match\`;
  if (f.room) return \`<span class="dot-on"></span>dans un salon (\${TYPE_TXT[f.room.type] || ""} · \${COMPS[f.room.mode] ? COMPS[f.room.mode].name : ""})\`;
  return \`<span class="dot-on"></span>en ligne\`;
}
function renderFriends() {
  const F = FRIENDS;
  const q = s => esc(s).replace(/'/g, "\\\\'");
  let html = \`<button class="pclose" onclick="closePanel()">×</button><h2>👥 Mes amis</h2>
    <div id="friendAdd"><input id="friendName" maxlength="16" placeholder="Nom d'utilisateur de ton ami"><button class="small-btn" onclick="addFriend()">Ajouter</button></div>\`;
  if (F.reqIn.length) html += \`<b>📨 Demandes reçues</b>\` + F.reqIn.map(n => \`<div class="friend-row"><span>\${nameTag(n, "")}</span><span class="acts">
      <button class="small-btn" onclick="friendOp('accept','\${q(n)}')">Accepter</button><button class="small-btn ghost" onclick="friendOp('refuse','\${q(n)}')">Refuser</button></span></div>\`).join("");
  html += F.friends.length ? F.friends.slice().sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0)).map(f => \`<div class="friend-row">
      <span>\${nameTag(f.name, f.role)}<br><span class="muted">\${friendStatus(f)}</span></span><span class="acts">
      \${f.online && f.playing ? \`<button class="small-btn" onclick="watchPlayer('\${f.id}','\${q(f.name)}')">👀 Regarder</button>\` : ""}
      \${f.online && f.room && f.room.state === "lobby" ? \`<button class="small-btn" onclick="netSend({t:'join',code:'\${f.room.code}'});closePanel()">Rejoindre</button>\` : ""}
      <button class="small-btn ghost" onclick="if(confirm('Retirer \${q(f.name)} de tes amis ?'))friendOp('remove','\${q(f.name)}')">Retirer</button></span></div>\`).join("")
    : \`<p class="muted">Pas encore d'amis. Écris le nom d'utilisateur d'un ami et clique sur Ajouter !</p>\`;
  if (F.reqOut.length) html += \`<p class="muted">En attente de réponse : \${F.reqOut.map(esc).join(", ")}</p>\`;
  const keep = $("friendName") ? $("friendName").value : "";
  $("pcard").innerHTML = html;
  $("friendName").value = keep;
  $("friendName").onkeydown = e => { if (e.key === "Enter") addFriend(); };
}
function addFriend() { const n = $("friendName").value.trim(); if (!n) return; $("friendName").value = ""; friendOp("add", n); }
function friendOp(op, name) { netSend({ t: "friend", op, name }); }
// ma liste d'amis se met à jour toute seule quand la fenêtre est ouverte
setInterval(() => { if (PANEL.kind === "friends" && NET.ok) netSend({ t: "friends" }); }, 6000);
// je préviens le serveur quand je joue un match (mes amis voient « en match » et peuvent regarder)
let lastPlaying = null;
function statusTick() {
  const playing = !!ME && ((!!G && !G.view) || (!!M && !M.view) || (!!G && G.view && !!G.me) || (!!M && M.view && !M.watch));
  if (playing !== lastPlaying && NET.ok) { lastPlaying = playing; netSend({ t: "status", playing }); }
}

/* =========================================================
   SPECTATEURS : regarder le match d'un autre joueur
   ========================================================= */
// NET.watchers : les spectateurs de MON match ; NET.watch : le match que JE regarde
NET.watchers = []; NET.watch = null;
function watchPlayer(id, name) {
  if (G || M) return toast("Termine ton match d'abord !");
  closePanel();
  NET.watch = { hostId: id, name, back: !$("bracketScreen").classList.contains("hidden") ? "bracket" : "title" };
  relay(id, { k: "watch" });
  toast(\`👀 Connexion au match de \${name}...\`);
  clearTimeout(watchPlayer.t);
  watchPlayer.t = setTimeout(() => { if (NET.watch && !G && !M) { NET.watch = null; toast("Impossible de regarder ce match"); } }, 6000);
}
// quelqu'un veut regarder mon match
function onWatchRequest(spec) {
  const L = NET.live;
  if (L && !L.host) return relay(L.hostId, { k: "watchreq", spec });          // c'est l'autre joueur qui calcule le match
  if (!(G && !G.view) && !(M && !M.view)) return relay(spec, { k: "nowatch" });
  addWatcher(spec);
}
function addWatcher(spec) {
  netSend({ t: "allow", id: spec });
  if (!NET.watchers.includes(spec)) NET.watchers.push(spec);
  if (G && !G.view) relay(spec, { k: "start", watch: true, weather: G.weather, tIdx: G.tIdx, label: G.label || (T && T.stages ? T.stages[T.stage].toUpperCase() : "MATCH"), comp: COMP,
    hum: G.hum.map(h => ({ id: h.id === "local" ? NET.id : h.id, name: h.name, role: h.role, team: h.team })) });
  else if (M && !M.view) relay(spec, { k: "pens", watch: true, a: pendingScore.a, b: pendingScore.b, tIdx: M.tIdx, shooter: null });
}
function endWatchers() {
  if (NET.watchers.length) relay(NET.watchers, { k: "end" });
  NET.watchers = [];
}
function stopWatching(msg) {
  if (NET.watch) relay(NET.watch.hostId, { k: "unwatch" });
  const back = NET.watch ? NET.watch.back : "title";
  NET.watch = null; G = null; M = null; stopAmbience();
  $("stopWatch").classList.add("hidden");
  if (msg) toast(msg);
  if (back === "bracket" && T && T.online) showOnlineBracket(); else show(ME ? "title" : "loginScreen");
}
$("stopWatch").onclick = () => stopWatching();
// matchs en cours dans mon tournoi en ligne (pour les regarder)
function renderLiveList() {
  const el = $("liveList");
  if (!T || !T.online || !T.matches) { el.innerHTML = ""; return; }
  const items = [];
  T.matches.forEach(mt => {
    if (mt.done || mt.type === "sim" || mt.a === T.me || mt.b === T.me) return;
    const ha = T.humans[mt.a], hb = T.humans[mt.b], who = ha || hb;
    if (!who) return;
    const label = \`\${TEAMS[mt.a].name} - \${TEAMS[mt.b].name}\`;
    items.push(\`<button class="small-btn ghost" onclick="watchPlayer('\${who.id}','\${esc(who.name).replace(/'/g, "\\\\'")}')">👀 \${esc(label)}</button>\`);
  });
  el.innerHTML = items.length ? \`<span class="muted" style="width:100%">Matchs en cours avec de vrais joueurs :</span>\` + items.join("") : "";
}

/* ---------- boutons des écrans en ligne ---------- */
for (let n = 2; n <= 32; n++) {                 // un salon peut accueillir jusqu'à 32 joueurs
  const o = document.createElement("option"); o.value = n; o.textContent = n + " joueurs";
  if (n === 8) o.selected = true;
  $("cMax").appendChild(o);
}
function setupCreate() {
  const sizes = COMP === "cl" ? [8, 16] : [8, 16, 32];
  const word = COMP === "cl" ? "clubs" : "pays";
  const lbl = { 8: "quarts", 16: "huitièmes", 32: "seizièmes" };
  $("cTeams").innerHTML = sizes.map(n => \`<option value="\${n}"\${n === sizes[sizes.length - 1] ? " selected" : ""}>\${n} \${word} (\${lbl[n]})</option>\`).join("");
  const t = $("cType").value, tour = t === "tournoi";
  ["cMaxRow", "cTeamsRow", "cDiffRow"].forEach(id => $(id).classList.toggle("hidden", !tour));
  if (+$("cMax").value > +$("cTeams").value) $("cMax").value = $("cTeams").value;
}
$("cType").onchange = setupCreate;
$("goOnline").onclick = () => {
  if (!ME) { toast("Connecte-toi à ton compte pour jouer en ligne"); return show("loginScreen"); }
  $("onlineTitle").textContent = \`\${COMPS[COMP].name} en ligne\`;
  show("onlineScreen"); netConnect();
  if (NET.ok) setNetState(\`✅ Connecté en tant que \${badgeHtml(ME.role)}<b>\${esc(ME.name)}</b>\`, "good");
};
$("goOffline").onclick = () => show("diffScreen");
$("modeBack").onclick = () => show("compScreen");
$("onlineBack").onclick = () => show("modeScreen");
$("createBtn").onclick = () => { if (!NET.ok || !ME) return toast("Pas de connexion au serveur"); setupCreate(); show("createScreen"); };
$("joinBtn").onclick = () => {
  if (!NET.ok || !ME) return toast("Pas de connexion au serveur");
  show("joinScreen"); netSend({ t: "list", on: true });
};
$("createBack").onclick = () => show("onlineScreen");
$("joinBack").onclick = () => { netSend({ t: "list", on: false }); show("onlineScreen"); };
$("cMax").onchange = $("cTeams").onchange = () => {
  if (+$("cMax").value > +$("cTeams").value) $("cMax").value = $("cTeams").value;
};
$("createGo").onclick = () => {
  netSend({ t: "create", type: $("cType").value, mode: COMP, maxPlayers: +$("cMax").value, numTeams: +$("cTeams").value, diff: $("cDiff").value, public: $("cPublic").checked });
};
$("joinCode").oninput = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); };
$("joinGo").onclick = () => {
  const code = $("joinCode").value.trim();
  if (code.length < 5) return toast("Entre le code à 5 caractères de ton ami");
  netSend({ t: "join", code });
};
$("rCopy").onclick = () => {
  const code = $("rCode").textContent;
  try { navigator.clipboard.writeText(code); toast("Code copié : " + code); } catch (e) { toast("Code : " + code); }
};
$("rStart").onclick = () => netSend({ t: "start" });
$("rLeave").onclick = leaveOnline;
$("leaveTour").onclick = leaveOnline;

/* =========================================================
   CÉLÉBRATION : les champions soulèvent le trophée
   ========================================================= */
let CELEB = null;
let celebShownFor = "";
const CELEB_CROWD = [];
for (let i = 0; i < 900; i++) {
  const x = Math.random() * 800, t = x / 800;
  const top = 150 - 70 * t * (1 - t) * 4 * 0.5;
  CELEB_CROWD.push({ x, y: top + Math.random() * (285 - top), c: \`hsl(\${Math.floor(Math.random() * 360)},65%,\${40 + Math.random() * 30}%)\`, ph: Math.random() * 6 });
}

function startCeleb(teamIdx, onDone) {
  hideScreens(); G = null; M = null;
  const t = TEAMS[teamIdx];
  CELEB = { team: teamIdx, comp: compOf() === COMPS.cl ? "cl" : "cdm", t: 0, onDone, fw: [], fwT: 0, conf: [] };
  stopAmbience();
  const cols = [t.c1, t.c2, "#ffd23f", "#ffffff", "#ffd23f"];
  for (let i = 0; i < 140; i++) CELEB.conf.push({
    x: Math.random() * 800, y: -Math.random() * 520, vy: 45 + Math.random() * 70, vx: rand(-25, 25),
    a: Math.random() * 6, va: rand(-5, 5), c: cols[i % cols.length], w: 4 + Math.random() * 4,
  });
  crowdSound(0.3);
  // petite fanfare
  [[523, 0], [659, 160], [784, 320], [1047, 480], [784, 760], [1047, 900]].forEach(([f, d]) => setTimeout(() => beep(f, 0.28, "triangle", 0.09), d));
  setTimeout(() => crowdSound(0.25), 1200);
}
function endCeleb() {
  if (!CELEB) return;
  const f = CELEB.onDone;
  CELEB = null;
  if (f) f();
}

// Un trophée doré (coupe à deux anses sur un socle)
function drawTrophy(x, y, s) {
  ctx.save();
  ctx.translate(x, y); ctx.scale(s, s);
  // socle
  ctx.fillStyle = "#1f2a24"; rr(-11, -8, 22, 8, 1.5); ctx.fill();
  ctx.fillStyle = "#2c3a32"; rr(-9, -14, 18, 7, 1.5); ctx.fill();
  ctx.fillStyle = "#d4a017"; ctx.fillRect(-9, -11.5, 18, 1.6);
  // pied
  const gold = ctx.createLinearGradient(-12, 0, 12, 0);
  gold.addColorStop(0, "#9c6b00"); gold.addColorStop(0.35, "#ffe27a"); gold.addColorStop(0.55, "#ffd23f"); gold.addColorStop(1, "#a87400");
  ctx.fillStyle = gold;
  ctx.beginPath(); ctx.moveTo(-6, -14); ctx.lineTo(6, -14); ctx.lineTo(2.2, -22); ctx.lineTo(-2.2, -22); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, -23, 4.5, 1.8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(-1.6, -30, 3.2, 8);
  // coupe
  ctx.beginPath();
  ctx.moveTo(-13, -50); ctx.quadraticCurveTo(-13, -31, 0, -29); ctx.quadraticCurveTo(13, -31, 13, -50); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#fff3b8"; ctx.beginPath(); ctx.ellipse(0, -50, 13, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#b07a00"; ctx.beginPath(); ctx.ellipse(0, -50, 10.5, 1.8, 0, 0, Math.PI * 2); ctx.fill();
  // anses
  ctx.strokeStyle = gold; ctx.lineWidth = 2.6;
  ctx.beginPath(); ctx.arc(-14, -42, 5, Math.PI * 0.45, Math.PI * 1.55); ctx.stroke();
  ctx.beginPath(); ctx.arc(14, -42, 5, -Math.PI * 0.55, Math.PI * 0.55); ctx.stroke();
  // reflet et étoile
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.beginPath(); ctx.ellipse(-6, -41, 1.6, 6, 0.15, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff8d0";
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 1.6 : 4; ctx.lineTo(3 + Math.cos(a) * r, -40 + Math.sin(a) * r); }
  ctx.fill();
  ctx.restore();
}

function drawCeleb(dt) {
  const C = CELEB;
  C.t += dt;
  const t = TEAMS[C.team];
  // ciel et projecteurs
  const sky = ctx.createLinearGradient(0, 0, 0, 500);
  sky.addColorStop(0, "#040b1e"); sky.addColorStop(1, "#13284a");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  for (const bx of [90, 710]) {
    ctx.fillStyle = "rgba(255,248,208,.07)";
    ctx.beginPath(); ctx.moveTo(bx, 30); ctx.lineTo(bx - 160 + (bx > 400 ? 240 : 0), 500); ctx.lineTo(bx + 80 + (bx > 400 ? 160 : 0) - 160, 500); ctx.fill();
    const g = ctx.createRadialGradient(bx, 30, 2, bx, 30, 70);
    g.addColorStop(0, "rgba(255,251,224,.95)"); g.addColorStop(1, "rgba(255,243,176,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, 30, 70, 0, Math.PI * 2); ctx.fill();
  }
  // tribunes et public qui saute
  ctx.fillStyle = "#101c30";
  ctx.beginPath(); ctx.moveTo(0, 150); ctx.quadraticCurveTo(400, 80, 800, 150); ctx.lineTo(800, 290); ctx.lineTo(0, 290); ctx.fill();
  for (const d of CELEB_CROWD) {
    ctx.fillStyle = d.c;
    ctx.fillRect(d.x, d.y - Math.abs(Math.sin(C.t * 7 + d.ph)) * 3, 3, 3);
  }
  // pelouse et podium
  ctx.fillStyle = "#2e8a3e"; ctx.fillRect(0, 285, W, 215);
  for (let i = 0; i < 6; i++) { ctx.fillStyle = "rgba(0,0,0,.06)"; ctx.fillRect(0, 300 + i * 36, W, 18); }
  const halo = ctx.createRadialGradient(400, 360, 20, 400, 360, 330);
  halo.addColorStop(0, "rgba(255,210,63,.35)"); halo.addColorStop(1, "rgba(255,210,63,0)");
  ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1b1b1b"; rr(120, 458, 560, 34, 6); ctx.fill();
  ctx.fillStyle = "#ffd23f"; ctx.fillRect(120, 458, 560, 4);
  ctx.fillStyle = "#ffd23f"; ctx.font = "900 17px sans-serif"; ctx.textAlign = "center";
  ctx.fillText(COMPS[C.comp].podium, 400, 483);

  // les 11 joueurs qui sautent de joie, le capitaine soulève la coupe
  const L = LINEUPS[C.team];
  const shorts = colorDist(t.c1, t.c2) < 90 ? (lum(t.c1) > 140 ? "#111" : "#fff") : t.c2;
  const kit = { shirt: t.c1, shorts, socks: t.c1, num: lum(t.c1) > 150 ? "#111" : "#fff" };
  const capIdx = 10;
  const spots = [];
  [215, 305, 495, 585].forEach((x, k) => spots.push({ x, y: 345, s: 2.3, i: [1, 2, 3, 4][k], back: true }));
  [140, 228, 572, 660].forEach((x, k) => spots.push({ x, y: 418, s: 2.6, i: [5, 6, 7, 8][k] }));
  spots.push({ x: 316, y: 426, s: 2.7, i: 9 });
  spots.push({ x: 484, y: 426, s: 2.7, i: 0 });            // le gardien
  spots.push({ x: 400, y: 432, s: 3.0, i: capIdx });
  spots.sort((a, b) => a.y - b.y);
  for (const sp of spots) {
    const pl = L[sp.i];
    const cap = sp.i === capIdx;
    const jump = cap ? Math.abs(Math.sin(C.t * 3.2)) * 9 : Math.abs(Math.sin(C.t * 5 + sp.x * 0.05)) * 12;
    ctx.save();
    ctx.translate(sp.x, sp.y); ctx.scale(sp.s, sp.s);
    ctx.fillStyle = "rgba(0,0,0,.3)";
    ctx.beginPath(); ctx.ellipse(0, 1, 9, 3.5, 0, 0, Math.PI * 2); ctx.fill();
    const lk = { x: 0, y: -jump / sp.s, fx: 0, fy: 1, anim: C.t * 8, mv: cap ? 0 : 0.4, kit, skin: pl.skin, hair: pl.hair, bald: pl.bald,
                 num: pl.num, armsUp: true, noShadow: true, hi: sp.i };
    if (pl.donkey) drawDonkey(lk); else if (pl.napo) drawRider(lk, sp.i === 0); else drawPerson(lk);
    if (cap) drawTrophy(0, -jump / sp.s - 45, 0.62);
    ctx.restore();
    const ny = sp.back ? sp.y - 112 : sp.y + 15;          // nom au-dessus (2e rang) ou sous les pieds
    ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.strokeText(pl.name, sp.x, ny);
    ctx.fillStyle = cap ? "#ffd23f" : "#fff"; ctx.fillText(pl.name, sp.x, ny);
  }

  // feux d'artifice
  C.fwT -= dt;
  if (C.fwT <= 0) {
    C.fwT = 0.45 + Math.random() * 0.4;
    const fx = 80 + Math.random() * 640, fy = 50 + Math.random() * 130;
    const col = [t.c1, t.c2, "#ffd23f", "#ffffff"][Math.floor(Math.random() * 4)];
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * 110;
      C.fw.push({ x: fx, y: fy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1.3, c: col });
    }
    beep(180 + Math.random() * 120, 0.18, "sawtooth", 0.025);
  }
  for (const p of C.fw) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 70 * dt; p.vx *= 0.985; p.life -= dt;
    if (p.life > 0) { ctx.globalAlpha = Math.min(1, p.life); ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, 2.4, 2.4); }
  }
  ctx.globalAlpha = 1;
  C.fw = C.fw.filter(p => p.life > 0);
  // confettis
  for (const c of C.conf) {
    c.y += c.vy * dt; c.x += c.vx * dt + Math.sin(C.t * 2 + c.a) * 0.3; c.a += c.va * dt;
    if (c.y > 510) { c.y = -10; c.x = Math.random() * 800; }
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.a);
    ctx.fillStyle = c.c; ctx.fillRect(-c.w / 2, -2, c.w, 4);
    ctx.restore();
  }
  // titre
  const pop = Math.min(1, C.t * 2.5);
  ctx.save();
  ctx.translate(400, 74); ctx.scale(0.6 + pop * 0.4, 0.6 + pop * 0.4);
  ctx.font = "900 40px sans-serif"; ctx.textAlign = "center";
  ctx.lineWidth = 8; ctx.strokeStyle = "rgba(0,0,0,.65)";
  ctx.strokeText(t.name.toUpperCase(), 0, 0);
  const gold = ctx.createLinearGradient(0, -34, 0, 4);
  gold.addColorStop(0, "#fff8d6"); gold.addColorStop(0.5, "#ffd23f"); gold.addColorStop(1, "#e08e00");
  ctx.fillStyle = gold; ctx.fillText(t.name.toUpperCase(), 0, 0);
  ctx.font = "900 18px sans-serif"; ctx.lineWidth = 5;
  ctx.strokeText(COMPS[C.comp].win, 0, 30);
  ctx.fillStyle = "#fff"; ctx.fillText(COMPS[C.comp].win, 0, 30);
  ctx.restore();
  drawFlag(C.team, 400 - 21, 112, 42, 28);
  if (C.t > 2) {
    ctx.font = "bold 13px sans-serif"; ctx.textAlign = "center";
    ctx.fillStyle = \`rgba(255,255,255,\${0.55 + Math.sin(C.t * 4) * 0.35})\`;
    ctx.textAlign = "right"; ctx.fillText("Clique pour continuer ▶", 785, 22);
  }
  if (C.t > 12) endCeleb();
}

/* ---------- plein écran sur téléphone ---------- */
(() => {
  const el = document.documentElement, btn = $("fsBtn");
  if (!(el.requestFullscreen || el.webkitRequestFullscreen)) return;   // iPhone : pas de plein écran pour les pages
  btn.classList.add("ok");
  btn.onclick = async () => {
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return; }
      await (el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen());
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock("landscape").catch(() => {});
    } catch (e) {}
  };
})();

/* =========================================================
   BOUCLE DE JEU
   ========================================================= */
let last = performance.now();
// qualité d'image : 2x plus de pixels (net) ; si l'appareil rame pendant un match, on passe en 1,25x (plus fluide)
let RES = 2, slowT = 0, fastT = 0;
function adaptRes(dt) {
  if (!G || document.hidden) { slowT = fastT = 0; return; }
  if (dt > 0.026) { slowT += dt; fastT = 0; } else { fastT += dt; slowT = Math.max(0, slowT - dt * 0.5); }
  if (RES > 1.25 && slowT > 2) { RES = 1.25; slowT = 0; canvas.width = W * RES; canvas.height = H * RES; CROWD_PAT = null; }
}
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frameDT = dt;
  adaptRes(dt);
  ctx.setTransform(RES, 0, 0, RES, 0, 0);          // dessin net (2x plus de pixels)
  ctx.lineJoin = "round"; ctx.miterLimit = 2;        // contours de texte propres
  ctx.clearRect(0, 0, W, H);
  if (CELEB) drawCeleb(dt);
  else if (G) { if (G.view) viewUpdateG(dt); else updateGame(dt); if (G) drawGame(); else drawShootout(); }
  else { if (M) { if (M.view) { if (M.msgT > 0) M.msgT -= dt; if (M.cheer > 0) M.cheer -= dt; } else update(dt); } drawShootout(); }
  netTick();
  userBarTick();
  pwTick();
  statusTick();
  drawScare(dt);
  requestAnimationFrame(loop);
}

buildTitleScene();
$("keysHelp").innerHTML = KEYS_HTML;
netConnect();
if (TOKEN) setNetState("Connexion automatique à ton compte...", "");
requestAnimationFrame(loop);
</script>
</body>
</html>
`; }
var PAGE = pageDuJeu();
