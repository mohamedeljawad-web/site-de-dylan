// =========================================================
//  🌐 LE SITE DE DYLAN — le site + le jeu Coupe du Monde, tout dans un seul fichier
//
//  Pour l'ouvrir :
//    1. Installe Node.js (gratuit) : https://nodejs.org
//    2. Dans VS Code, ouvre un terminal et tape :
//          node server.js
//    3. Ouvre http://localhost:3000 dans ton navigateur
//
//  Les images de tes films : mets-les dans le dossier "films" (à côté de ce fichier,
//  il est créé tout seul). Elles s'affichent dans l'onglet Films et dans le diaporama.
//
//  Le code du site est en bas (SITE), puis celui du jeu (PAGE).
// =========================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ---------- le "package.json" est rangé ici (plus besoin d'un 2e fichier) ----------
   Pour l'hébergement (Render) : Build Command = node server.js --prepare
   Cette commande recrée le fichier package.json toute seule, puis s'arrête. */
const PACKAGE_JSON = {
  name: "site-de-dylan",
  version: "1.0.0",
  description: "Le site de Dylan et le jeu Coupe du Monde (hors ligne et en ligne)",
  main: "server.js",
  scripts: { start: "node server.js" },
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
    socket.on("data", d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
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
}

const PORT = process.env.PORT || 3000;
const NB_TEAMS_TOTAL = 32;                       // nombre de pays dans le jeu (même ordre que TEAMS dans index.html)
const STAGE_NAMES = ["Finale", "Demi-finales", "Quarts de finale", "Huitièmes de finale", "Seizièmes de finale"];

/* ---------- serveur web ----------
   /            -> le site de Dylan (accueil, jeux, films)
   /jeu         -> le jeu Coupe du Monde
   /films/...   -> les images que tu mets dans le dossier "films" (à côté de ce fichier)
*/
const FILMS_DIR = path.join(__dirname, "films");
try { fs.mkdirSync(FILMS_DIR, { recursive: true }); } catch (e) {}
const IMG_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" };
const server = http.createServer((req, res) => {
  let p = "/";
  try { p = decodeURIComponent((req.url || "/").split("?")[0]); } catch (e) {}
  const html = page => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(page); };
  if (p === "/" || p === "/index.html" || p === "/site") return html(SITE);
  if (p === "/jeu" || p === "/jeu/") return html(PAGE);
  // liste des images du dossier films (triées par nom)
  if (p === "/films-list") {
    let list = [];
    try { list = fs.readdirSync(FILMS_DIR).filter(f => IMG_TYPES[path.extname(f).toLowerCase()]).sort((a, b) => a.localeCompare(b, "fr", { numeric: true })); } catch (e) {}
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(list));
  }
  if (p.startsWith("/films/")) {
    const name = path.basename(p.slice(7));
    const type = IMG_TYPES[path.extname(name).toLowerCase()];
    if (!type) { res.writeHead(404); return res.end(); }
    return fs.readFile(path.join(FILMS_DIR, name), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": type }); res.end(data);
    });
  }
  // photo d'accueil facultative du jeu : accueil.jpg dans le même dossier
  if (p === "/accueil.jpg") {
    return fs.readFile(path.join(__dirname, "accueil.jpg"), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(data);
    });
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Page introuvable");
});

/* ---------- état ---------- */
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
const clients = new Map();   // id -> { id, ws, name, room, watching }
const rooms = new Map();     // code -> salon
let nextId = 1;

const send = (c, msg) => { if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); };
const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);
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

/* ---------- salons ---------- */
function roomView(r) {
  return {
    code: r.code, name: r.name, host: r.host, public: r.public, maxPlayers: r.maxPlayers,
    numTeams: r.numTeams, diff: r.diff, state: r.state,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team })),
  };
}
function publicList() {
  return [...rooms.values()]
    .filter(r => r.public && r.state === "lobby" && r.players.size < r.maxPlayers)
    .map(r => ({ code: r.code, name: r.name, players: r.players.size, maxPlayers: r.maxPlayers, numTeams: r.numTeams, diff: r.diff }));
}
function broadcastList() {
  const list = publicList();
  for (const c of clients.values()) if (c.watching) send(c, { t: "rooms", rooms: list });
}
function broadcastRoom(r) {
  const v = roomView(r);
  for (const p of r.players.values()) send(clients.get(p.id), { t: "room", room: v });
}

function leaveRoom(c) {
  const r = rooms.get(c.room);
  c.room = null;
  if (!r) return;
  const pl = r.players.get(c.id);
  r.players.delete(c.id);
  if (r.players.size === 0) { rooms.delete(r.code); broadcastList(); return; }
  if (r.host === c.id) r.host = r.players.keys().next().value;           // nouvel hôte
  for (const p of r.players.values()) send(clients.get(p.id), { t: "left", id: c.id, name: pl ? pl.name : "" });
  if (r.state === "playing" && r.tour && pl && pl.team != null) playerGone(r, pl.team);
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
  const others = shuffle([...Array(NB_TEAMS_TOTAL).keys()].filter(t => !humans.includes(t)));
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
  for (const p of r.players.values()) if (p.team != null) humans[p.team] = { id: p.id, name: p.name };
  const msg = { t: "tour", tour: { stages: T.stages, rounds: T.rounds, scores: T.scores, stage: T.stage, matches: T.matches, champion: T.champion, humans, diff: r.diff } };
  for (const p of r.players.values()) send(clients.get(p.id), msg);
}
function setResult(r, m, res) {
  const T = r.tour, mt = T.matches[m];
  if (!mt || mt.done) return;
  T.scores[T.stage][m] = res;
  mt.done = true;
  sendTour(r);
  checkRoundEnd(r);
}
function checkRoundEnd(r) {
  const T = r.tour;
  if (r.roundTimer || T.champion != null || !T.matches.every(m => m.done)) return;
  const teams = T.rounds[T.stage], next = [];
  for (let m = 0; m < teams.length / 2; m++) next.push(winsFirst(T.scores[T.stage][m]) ? teams[2 * m] : teams[2 * m + 1]);
  if (next.length === 1) { T.champion = next[0]; sendTour(r); return; }
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
wss.on("connection", ws => {
  const c = { id: "p" + (nextId++), ws, name: "Joueur", room: null, watching: false };
  clients.set(c.id, c);
  send(c, { t: "hello", id: c.id });

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const r = c.room ? rooms.get(c.room) : null;
    switch (m.t) {
      case "name": c.name = clean(m.name, 16) || "Joueur"; break;

      case "list": c.watching = !!m.on; if (c.watching) send(c, { t: "rooms", rooms: publicList() }); break;

      case "create": {
        if (c.room) leaveRoom(c);
        const numTeams = [8, 16, 32].includes(+m.numTeams) ? +m.numTeams : 32;
        const maxPlayers = Math.max(2, Math.min(32, +m.maxPlayers || 8, numTeams));   // jusqu'à 32 joueurs (1 pays chacun)
        const room = {
          code: makeCode(), name: `Salon de ${c.name}`, host: c.id, public: !!m.public,
          maxPlayers, numTeams, diff: ["facile", "moyen", "difficile"].includes(m.diff) ? m.diff : "moyen",
          state: "lobby", players: new Map(), tour: null, roundTimer: null,
        };
        room.players.set(c.id, { id: c.id, name: c.name, team: null });
        rooms.set(room.code, room);
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
        if (c.room) leaveRoom(c);
        room.players.set(c.id, { id: c.id, name: c.name, team: null });
        c.room = room.code; c.watching = false;
        broadcastRoom(room);
        broadcastList();
        break;
      }

      case "leave": leaveRoom(c); break;

      case "pick": {   // choix du pays : pas de doublon
        if (!r || r.state !== "lobby") return;
        const team = +m.team;
        if (!(team >= 0 && team < NB_TEAMS_TOTAL)) return;
        for (const p of r.players.values()) if (p.team === team && p.id !== c.id) return send(c, { t: "error", msg: "Ce pays est déjà pris !" });
        r.players.get(c.id).team = team;
        broadcastRoom(r);
        break;
      }

      case "start": {
        if (!r || r.host !== c.id || r.state !== "lobby") return;
        const pl = [...r.players.values()];
        if (pl.length < 2) return send(c, { t: "error", msg: "Il faut au moins 2 joueurs." });
        if (pl.some(p => p.team == null)) return send(c, { t: "error", msg: "Tout le monde doit choisir son pays." });
        startTournament(r);
        broadcastRoom(r);
        break;
      }

      case "result": {   // résultat d'un match (score dans l'ordre du tableau)
        if (!r || !r.tour) return;
        const mt = r.tour.matches[m.m];
        if (!mt || mt.done) return;
        const allowed = mt.type === "live" ? c.id === mt.pa : (c.id === mt.pa || c.id === mt.pb);
        if (!allowed) return;
        const n = v => Math.max(0, Math.min(99, Math.floor(+v || 0)));
        const res = { a: n(m.res.a), b: n(m.res.b) };
        if (m.res.pa != null) { res.pa = n(m.res.pa); res.pb = n(m.res.pb); }
        if (res.a === res.b && (res.pa == null || res.pa === res.pb)) return;   // il faut un vainqueur
        if (m.res.et) res.et = true;
        setResult(r, m.m, res);
        break;
      }

      case "relay": {   // messages directs entre deux joueurs du même salon (match en direct)
        if (!r) return;
        const to = clients.get(m.to);
        if (to && to.room === r.code) send(to, { t: "relay", from: c.id, d: m.d });
        break;
      }
    }
  });

  ws.on("close", () => { leaveRoom(c); clients.delete(c.id); });
});

server.listen(PORT, () => {
  console.log(`🌐 Le site de Dylan : ouvre http://localhost:${PORT} dans ton navigateur`);
  console.log(`⚽ Le jeu directement : http://localhost:${PORT}/jeu`);
  console.log(`🎬 Mets les images de tes films dans : ${FILMS_DIR}`);
  // adresses à donner aux amis connectés au même Wi-Fi
  const nets = require("os").networkInterfaces();
  for (const list of Object.values(nets)) for (const n of list || []) {
    if (n.family === "IPv4" && !n.internal) console.log(`   Tes amis sur le même Wi-Fi : http://${n.address}:${PORT}`);
  }
});


/* =========================================================
   LE SITE DE DYLAN (HTML + CSS + JavaScript)
   ========================================================= */
function pageDuSite() { return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Le site de Dylan</title>
<style>
  :root {
    --bg: #0a0f1c;
    --panel: #121a2e;
    --panel2: #19233c;
    --line: rgba(255,255,255,.08);
    --text: #f2f4f8;
    --muted: #9aa6bf;
    --gold: #ffc93c;
    --orange: #ff7a1a;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: radial-gradient(1200px 600px at 80% -10%, rgba(255,122,26,.12), transparent 60%),
                radial-gradient(900px 500px at -10% 10%, rgba(80,120,255,.12), transparent 60%), var(--bg);
    color: var(--text);
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    min-height: 100vh;
  }
  a { color: inherit; }

  /* ---------- en-tête ---------- */
  header {
    position: sticky; top: 0; z-index: 20;
    background: rgba(10,15,28,.82); backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--line);
  }
  .bar { max-width: 1160px; margin: 0 auto; padding: 12px 16px; display: flex; align-items: center; gap: 16px; }
  .logo { display: flex; align-items: center; gap: 10px; font-weight: 900; font-size: 22px; letter-spacing: .3px; white-space: nowrap; cursor: pointer; }
  .logo .badge {
    width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; font-size: 20px;
    background: linear-gradient(135deg, var(--gold), var(--orange)); color: #1a1000; box-shadow: 0 6px 18px rgba(255,122,26,.35);
  }
  .logo span b { background: linear-gradient(90deg, var(--gold), var(--orange)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  nav { display: flex; gap: 6px; margin-left: auto; }
  nav button {
    background: transparent; border: 0; color: var(--muted); font: inherit; font-weight: 700; font-size: 15px;
    padding: 10px 16px; border-radius: 999px; cursor: pointer; transition: .15s;
  }
  nav button:hover { color: var(--text); background: var(--panel2); }
  nav button.on { color: #1a1000; background: linear-gradient(135deg, var(--gold), var(--orange)); }

  main { max-width: 1160px; margin: 0 auto; padding: 24px 16px 60px; }
  section.tab { display: none; animation: fade .35s ease; }
  section.tab.on { display: block; }
  @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  h1 { font-size: clamp(26px, 4vw, 40px); font-weight: 900; margin-bottom: 6px; }
  h2 { font-size: clamp(20px, 3vw, 28px); font-weight: 900; margin-bottom: 14px; }
  .sub { color: var(--muted); margin-bottom: 20px; }

  /* ---------- diaporama ---------- */
  .slider {
    position: relative; border-radius: 22px; overflow: hidden; aspect-ratio: 16 / 9; background: #000;
    box-shadow: 0 30px 70px rgba(0,0,0,.5); border: 1px solid var(--line);
  }
  .slide { position: absolute; inset: 0; opacity: 0; transition: opacity .9s ease; }
  .slide.on { opacity: 1; }
  .slide .bgblur { position: absolute; inset: -20px; background-size: cover; background-position: center; filter: blur(22px) brightness(.45); }
  .slide img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .slide.cover img { object-fit: cover; }
  .slide .cap {
    position: absolute; left: 0; right: 0; bottom: 0; padding: 60px 26px 22px;
    background: linear-gradient(transparent, rgba(0,0,0,.85));
  }
  .cap .tag { display: inline-block; font-size: 12px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase;
              background: var(--gold); color: #1a1000; padding: 4px 10px; border-radius: 999px; margin-bottom: 8px; }
  .cap .title { font-size: clamp(20px, 3.4vw, 34px); font-weight: 900; text-shadow: 0 2px 10px rgba(0,0,0,.6); }
  .arrow {
    position: absolute; top: 50%; transform: translateY(-50%); width: 46px; height: 46px; border-radius: 50%;
    border: 0; background: rgba(0,0,0,.45); color: #fff; font-size: 22px; cursor: pointer; z-index: 3; transition: .15s;
  }
  .arrow:hover { background: rgba(0,0,0,.75); }
  .arrow.l { left: 14px; } .arrow.r { right: 14px; }
  .dots { position: absolute; right: 20px; bottom: 22px; display: flex; gap: 8px; z-index: 3; }
  .dots button { width: 10px; height: 10px; border-radius: 999px; border: 0; background: rgba(255,255,255,.45); cursor: pointer; transition: .25s; }
  .dots button.on { width: 28px; background: var(--gold); }
  .progress { position: absolute; left: 0; top: 0; height: 4px; background: linear-gradient(90deg, var(--gold), var(--orange)); z-index: 3; width: 0; }

  /* placeholder quand le dossier films est vide */
  .empty-slide {
    position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 30px;
    background: repeating-linear-gradient(90deg, #111 0 26px, #1c1c1c 26px 52px);
  }
  .empty-slide .box { background: rgba(10,15,28,.9); border: 2px dashed var(--gold); border-radius: 18px; padding: 26px 30px; max-width: 520px; }
  .empty-slide .big { font-size: 56px; margin-bottom: 8px; }

  /* ---------- cartes ---------- */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-top: 22px; }
  .card {
    background: linear-gradient(160deg, var(--panel2), var(--panel)); border: 1px solid var(--line); border-radius: 18px;
    padding: 22px; cursor: pointer; transition: .18s; display: flex; gap: 16px; align-items: center;
  }
  .card:hover { transform: translateY(-3px); border-color: rgba(255,201,60,.5); }
  .card .ico { font-size: 38px; }
  .card h3 { font-size: 19px; margin-bottom: 4px; }
  .card p { color: var(--muted); font-size: 14px; }

  /* ---------- jeu ---------- */
  .game-wrap { background: #000; border-radius: 20px; overflow: hidden; border: 1px solid var(--line); box-shadow: 0 30px 70px rgba(0,0,0,.5); aspect-ratio: 8 / 5; }
  .game-wrap iframe { width: 100%; height: 100%; border: 0; display: block; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; align-items: center; }
  .btn {
    background: linear-gradient(135deg, var(--gold), var(--orange)); color: #1a1000; border: 0; border-radius: 999px;
    padding: 11px 20px; font-weight: 800; font-size: 15px; cursor: pointer; text-decoration: none; display: inline-flex; gap: 8px; align-items: center;
  }
  .btn.ghost { background: transparent; color: var(--text); border: 2px solid var(--line); }
  .hint { color: var(--muted); font-size: 14px; }

  /* ---------- films ---------- */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 18px; }
  .film { cursor: pointer; }
  .film .poster { aspect-ratio: 2 / 3; border-radius: 14px; overflow: hidden; background: var(--panel2); border: 1px solid var(--line); transition: .18s; }
  .film .poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .film:hover .poster { transform: translateY(-4px) scale(1.02); box-shadow: 0 16px 34px rgba(0,0,0,.45); }
  .film .name { margin-top: 8px; font-weight: 700; font-size: 15px; }
  .howto { background: var(--panel); border: 1px dashed rgba(255,201,60,.5); border-radius: 18px; padding: 22px; line-height: 1.7; }
  .howto code { background: #000; padding: 2px 8px; border-radius: 6px; color: var(--gold); }
  .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.88); display: none; place-items: center; z-index: 50; padding: 20px; cursor: zoom-out; }
  .lightbox.on { display: grid; }
  .lightbox img { max-width: 100%; max-height: 82vh; border-radius: 12px; }
  .lightbox p { text-align: center; font-weight: 800; font-size: 20px; margin-top: 12px; }

  footer { text-align: center; color: var(--muted); font-size: 13px; padding: 26px 16px; border-top: 1px solid var(--line); }

  @media (max-width: 640px) {
    .bar { flex-wrap: wrap; }
    nav { margin-left: 0; width: 100%; justify-content: space-between; }
    nav button { padding: 9px 12px; font-size: 14px; }
    .arrow { width: 38px; height: 38px; font-size: 18px; }
    .slide .cap { padding: 40px 16px 16px; }
  }
</style>
</head>
<body>
<header>
  <div class="bar">
    <div class="logo" onclick="go('accueil')"><div class="badge">D</div><span>Le site de <b>Dylan</b></span></div>
    <nav>
      <button data-tab="accueil">🏠 Accueil</button>
      <button data-tab="jeux">🎮 Jeux</button>
      <button data-tab="films">🎬 Films</button>
    </nav>
  </div>
</header>

<main>
  <!-- ACCUEIL -->
  <section class="tab" id="tab-accueil">
    <h1>Bienvenue sur le site de Dylan 👋</h1>
    <p class="sub">Mes jeux, mes films préférés, et plein d'autres choses à venir.</p>
    <div class="slider" id="slider">
      <div class="progress" id="progress"></div>
      <button class="arrow l" id="prev" aria-label="Image précédente">‹</button>
      <button class="arrow r" id="next" aria-label="Image suivante">›</button>
      <div class="dots" id="dots"></div>
    </div>
    <div class="cards">
      <div class="card" onclick="go('jeux')"><div class="ico">⚽</div><div><h3>Jouer à Coupe du Monde</h3><p>Mon jeu de foot : contre des bots ou en ligne avec tes amis.</p></div></div>
      <div class="card" onclick="go('films')"><div class="ico">🎬</div><div><h3>Mes films</h3><p>La liste de mes films préférés.</p></div></div>
    </div>
  </section>

  <!-- JEUX -->
  <section class="tab" id="tab-jeux">
    <h1>🎮 Jeux</h1>
    <p class="sub">Coupe du Monde — le jeu de foot de Dylan. 11 contre 11, tournoi de 32 pays, mode en ligne.</p>
    <div class="game-wrap"><iframe id="gameFrame" title="Coupe du Monde" allow="fullscreen"></iframe></div>
    <div class="row">
      <button class="btn" id="fullBtn">⛶ Plein écran</button>
      <a class="btn ghost" href="/jeu" target="_blank">Ouvrir dans un nouvel onglet ↗</a>
      <span class="hint">Clic gauche maintenu : courir · Lâche : tirer · Clic droit : tacle ou passe</span>
    </div>
  </section>

  <!-- FILMS -->
  <section class="tab" id="tab-films">
    <h1>🎬 Films</h1>
    <p class="sub">Mes films préférés.</p>
    <div class="grid" id="filmGrid"></div>
    <div class="howto" id="howto">
      <b>Comment ajouter tes films :</b><br>
      1. Dans le dossier où se trouve <code>server.js</code>, ouvre le dossier <code>films</code> (il est créé tout seul au lancement).<br>
      2. Mets-y les images de tes films (<code>.jpg</code>, <code>.png</code> ou <code>.webp</code>). Le nom du fichier devient le titre : <code>Sonic 1.jpg</code> → « Sonic 1 ».<br>
      3. Pour choisir l'ordre, commence les noms par un numéro : <code>1 Sonic 1.jpg</code>, <code>2 Sonic 2.jpg</code>…<br>
      4. Recharge la page (F5) : les films apparaissent ici et dans le diaporama de l'accueil.
    </div>
  </section>
</main>

<div class="lightbox" id="lightbox"><div><img id="lbImg" alt=""><p id="lbName"></p></div></div>

<footer>© Le site de Dylan · Fait avec VS Code</footer>

<script>
const $ = id => document.getElementById(id);
const JEU_IMG = "data:image/jpeg;base64,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";

/* ---------- onglets ---------- */
function go(tab) {
  if (!["accueil", "jeux", "films"].includes(tab)) tab = "accueil";
  document.querySelectorAll("section.tab").forEach(s => s.classList.toggle("on", s.id === "tab-" + tab));
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
  if (tab === "jeux" && !$("gameFrame").src) $("gameFrame").src = "/jeu";   // le jeu se charge à la première visite
  window.scrollTo({ top: 0 });
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => go(b.dataset.tab));
window.addEventListener("hashchange", () => go(location.hash.slice(1)));

$("fullBtn").onclick = () => {
  const f = $("gameFrame");
  if (!f.src) f.src = "/jeu";
  (f.requestFullscreen || f.webkitRequestFullscreen || (() => {})).call(f);
};

/* ---------- films (images du dossier "films") ---------- */
const nameOf = file => file.replace(/\\.[^.]+$/, "").replace(/^\\d+\\s*[-_.]?\\s*/, "").replace(/[_]+/g, " ").trim() || file;
let FILMS = [];

function renderFilms() {
  const grid = $("filmGrid");
  grid.innerHTML = "";
  FILMS.forEach(f => {
    const d = document.createElement("div");
    d.className = "film";
    d.innerHTML = \`<div class="poster"><img loading="lazy" alt=""></div><div class="name"></div>\`;
    d.querySelector("img").src = f.url;
    d.querySelector(".name").textContent = f.name;
    d.onclick = () => { $("lbImg").src = f.url; $("lbName").textContent = f.name; $("lightbox").classList.add("on"); };
    grid.appendChild(d);
  });
  $("howto").style.marginTop = FILMS.length ? "26px" : "0";
}
$("lightbox").onclick = () => $("lightbox").classList.remove("on");

/* ---------- diaporama : change toutes les 5 secondes ---------- */
const DELAY = 5000;
let slides = [], cur = 0, timer = null, start = 0;

function buildSlider() {
  const sl = $("slider");
  sl.querySelectorAll(".slide").forEach(e => e.remove());
  slides = [{ url: JEU_IMG, tag: "Jeu", title: "Coupe du Monde — le jeu de foot de Dylan", cover: true }];
  FILMS.forEach(f => slides.push({ url: f.url, tag: "Film", title: f.name }));
  if (!FILMS.length) slides.push({ empty: true });
  slides.forEach((s, i) => {
    const d = document.createElement("div");
    d.className = "slide" + (s.cover ? " cover" : "");
    if (s.empty) {
      d.innerHTML = \`<div class="empty-slide"><div class="box"><div class="big">🎬</div>
        <h2>Tes films arrivent ici !</h2><p class="hint">Mets les images de tes films dans le dossier <b>films</b> à côté de server.js,
        puis recharge la page. Elles défileront ici toutes les 5 secondes.</p></div></div>\`;
    } else {
      d.innerHTML = \`<div class="bgblur"></div><img alt=""><div class="cap"><span class="tag"></span><div class="title"></div></div>\`;
      d.querySelector(".bgblur").style.backgroundImage = \`url("\${s.url}")\`;
      d.querySelector("img").src = s.url;
      d.querySelector(".tag").textContent = s.tag;
      d.querySelector(".title").textContent = s.title;
    }
    sl.insertBefore(d, $("dots"));
  });
  const dots = $("dots");
  dots.innerHTML = "";
  slides.forEach((_, i) => {
    const b = document.createElement("button");
    b.setAttribute("aria-label", "Image " + (i + 1));
    b.onclick = () => show(i);
    dots.appendChild(b);
  });
  show(0);
}
function show(i) {
  cur = (i + slides.length) % slides.length;
  document.querySelectorAll("#slider .slide").forEach((s, k) => s.classList.toggle("on", k === cur));
  document.querySelectorAll("#dots button").forEach((b, k) => b.classList.toggle("on", k === cur));
  start = performance.now();
}
$("prev").onclick = () => show(cur - 1);
$("next").onclick = () => show(cur + 1);
function tick(now) {
  const p = Math.min(1, (now - start) / DELAY);
  $("progress").style.width = (p * 100) + "%";
  if (p >= 1) show(cur + 1);
  requestAnimationFrame(tick);
}

async function loadFilms() {
  try {
    const r = await fetch("/films-list", { cache: "no-store" });
    const list = await r.json();
    FILMS = list.map(f => ({ url: "/films/" + encodeURIComponent(f), name: nameOf(f) }));
  } catch (e) { FILMS = []; }
  renderFilms();
  buildSlider();
}

go(location.hash.slice(1) || "accueil");
loadFilms();
requestAnimationFrame(tick);
</script>
</body>
</html>
`; }
var SITE = pageDuSite();


/* =========================================================
   LE JEU COUPE DU MONDE (HTML + CSS + JavaScript)
   ========================================================= */
function pageDuJeu() { return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, viewport-fit=cover">
<title>Coupe du Monde</title>
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
</style>
</head>
<body>
<div id="wrap">
  <canvas id="game" width="1600" height="1000"></canvas>

  <!-- ÉCRAN D'ACCUEIL -->
  <div id="title">
    <div id="titleScene"></div>
    <!-- Tu peux mettre ta propre photo : enregistre-la sous le nom accueil.jpg à côté de index.html -->
    <img id="titlePhoto" src="accueil.jpg" alt="" onerror="this.remove()">
    <div class="title-shade"></div>
    <div class="title-content">
      <div class="kicker">ÉDITION 2026 · 32 NATIONS</div>
      <div class="game-title">COUPE<br>DU MONDE</div>
      <button class="big play" id="startBtn">JOUER ▶</button>
    </div>
  </div>

  <!-- EN LIGNE OU HORS LIGNE -->
  <div id="modeScreen" class="screen hidden">
    <h1>Comment veux-tu jouer ?</h1>
    <div class="modes">
      <button class="mode-card" id="goOnline"><span class="ico">🌍</span><span class="nm">EN LIGNE</span><span class="ds">Joue contre de vraies personnes</span></button>
      <button class="mode-card" id="goOffline"><span class="ico">🤖</span><span class="nm">HORS LIGNE</span><span class="ds">Joue contre des bots</span></button>
    </div>
    <button class="back" id="modeBack">← Retour</button>
  </div>

  <!-- EN LIGNE : pseudo + créer / rejoindre -->
  <div id="onlineScreen" class="screen hidden">
    <h1>Jouer en ligne</h1>
    <div id="netStatus" class="net-status">Connexion au serveur...</div>
    <input id="pseudo" type="text" maxlength="16" placeholder="Ton pseudo">
    <div class="modes">
      <button class="mode-card" id="createBtn"><span class="ico">🏟️</span><span class="nm">CRÉER UN SALON</span><span class="ds">Tu reçois un code à donner à tes amis</span></button>
      <button class="mode-card" id="joinBtn"><span class="ico">🤝</span><span class="nm">REJOINDRE UN SALON</span><span class="ds">Avec le code d'un ami ou un salon public</span></button>
    </div>
    <button class="back" id="onlineBack">← Retour</button>
  </div>

  <!-- CRÉER UN SALON -->
  <div id="createScreen" class="screen hidden">
    <h1>Créer un salon</h1>
    <label class="field">Nombre maximum de joueurs
      <select id="cMax"></select></label>
    <label class="field">Nombre de pays dans le tournoi
      <select id="cTeams"><option value="8">8 pays (quarts)</option><option value="16">16 pays (huitièmes)</option><option value="32" selected>32 pays (seizièmes)</option></select></label>
    <label class="field">Niveau des bots
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
    <h1>Choisis ton pays</h1>
    <p>Choisis une des 32 équipes qualifiées pour les seizièmes de finale de la Coupe du monde 2026, et va jusqu'au titre !</p>
    <div class="grid" id="teamGrid"></div>
    <p class="help">
      <b>Match 11 contre 11 (tout à la souris) :</b> <b>maintiens le clic gauche</b> et bouge la souris pour courir ·
      <b>lâche le clic</b> pour tirer vers la souris · <b>clic droit</b> : <b>TACLE GLISSÉ</b> vers la souris (ou passe si tu as le ballon).<br>
      Tacle : touche le ballon en premier, sinon c'est faute et <b>carton jaune</b> · 2 jaunes = <b>carton rouge</b> et le joueur sort.<br>
      Sur téléphone : joystick à gauche, boutons TIR, PASSE et TACLE à droite.<br>
      <b>Règles :</b> arbitre · 2 mi-temps · touches, corners, 6 mètres, coups francs, penaltys · égalité après 90' = prolongations (2 × 15').<br>
      <b>Toujours égalité ?</b> Tirs au but : vise, clique, reclique pour la puissance. Pour arrêter, clique où ton gardien doit plonger.
    </p>
    <button class="back" id="menuBack">← Changer de mode</button>
  </div>

  <!-- TABLEAU DU TOURNOI -->
  <div id="bracketScreen" class="screen hidden">
    <h2 id="bTitle"></h2>
    <p id="bSub"></p>
    <button class="big" id="playBtn">Jouer le match ⚽</button>
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
];
// 32 équipes : seizièmes (32), huitièmes (16), quarts (8), demies (4), finale (2)
const STAGES = ["Seizièmes de finale", "Huitièmes de finale", "Quarts de finale", "Demi-finales", "Finale"];
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
const flagURL = name => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(flagSvg(name));
// images des drapeaux pour le dessin dans le jeu (tableau des scores)
const FLAG_IMG = TEAMS.map(t => { const im = new Image(); im.src = flagURL(t.name); return im; });
function drawFlag(idx, x, y, w, h) {
  const im = FLAG_IMG[idx];
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
    <text x="400" y="301" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="11" fill="#fff" letter-spacing="3">COUPE DU MONDE · COUPE DU MONDE · COUPE DU MONDE · COUPE DU MONDE · COUPE DU MONDE</text>
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

function buildMenu() {
  const grid = $("teamGrid");
  grid.innerHTML = "";
  TEAMS.map((t, i) => ({ t, i }))
    .sort((x, y) => x.t.name.localeCompare(y.t.name, "fr"))
    .forEach(({ t, i }) => {
      const b = document.createElement("button");
      b.className = "team";
      b.innerHTML = \`<img class="flag" src="\${flagURL(t.name)}" alt="">\${t.name}\`;
      b.onclick = () => { initAudio(); startTournament(i); };
      grid.appendChild(b);
    });
}

function startTournament(myIdx) {
  T = { me: myIdx, rounds: [TEAMS.map((_, i) => i)], scores: [], stage: 0, diff: chosenDiff, stages: STAGES };
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
  const who = T.humans && T.humans[idx] ? \` <i style="opacity:.75">(\${T.humans[idx].name})</i>\` : "";
  return \`<div class="\${cls}"><span><img class="mini-flag" src="\${flagURL(TEAMS[idx].name)}" alt="">\${TEAMS[idx].name}\${who}</span><span>\${score}</span></div>\`;
}

function hideScreens() {
  ["title", "modeScreen", "onlineScreen", "createScreen", "joinScreen", "roomScreen", "diffScreen", "menu", "bracketScreen", "drawScreen", "endScreen"].forEach(id => $(id).classList.add("hidden"));
}

function showBracket() {
  hideScreens();
  const opp = oppNow();
  $("bTitle").textContent = T.stages[T.stage];
  $("playBtn").textContent = "Jouer le match ⚽"; $("playBtn").disabled = false; $("playBtn").classList.remove("hidden");
  $("leaveTour").classList.add("hidden");
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

function afterMatch(res) {
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
    startCeleb(T.me, () => showEnd("🏆 CHAMPION !", \`\${myName} remporte la Coupe du monde ! (finale : \${fmtScore(res)})\`));
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
// Accueil -> difficulté -> choix du pays
const show = id => { hideScreens(); $(id).classList.remove("hidden"); };
$("startBtn").onclick = () => { initAudio(); whistle(); show("modeScreen"); };
document.querySelectorAll(".diff").forEach(b => b.onclick = () => { chosenDiff = b.dataset.d; show("menu"); });
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
const LINEUPS = TEAMS.map((t, ti) => {
  const r = seeded(ti * 7919 + 17);
  const pool = (NAME_POOLS[TEAM_REGION[t.name]] || NAME_POOLS.fr).slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return FORMATION.map((f, i) => {
    const sk = Math.floor(r() * SKINS.length);
    const hr = sk >= 3 ? Math.floor(r() * 2) : Math.floor(r() * HAIRS.length);
    return { name: pool[i % pool.length].toUpperCase(), num: f.num, skin: SKINS[sk], hair: HAIRS[hr], bald: r() < 0.08 };
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
};

/* ---------- couleurs ---------- */
const lum = h => { const [r, g, b] = hexRgb(h); return 0.299 * r + 0.587 * g + 0.114 * b; };
function teamColors(aIdx, bIdx) {
  const me = TEAMS[aIdx], op = TEAMS[bIdx];
  let oc = { fill: op.c1, line: op.c2 };
  if (colorDist(me.c1, op.c1) < 130) oc = { fill: op.c2, line: op.c1 };   // maillot extérieur si trop proche
  const pick = (list, avoid) => list.reduce((best, c) => {
    const d = Math.min(...avoid.map(a => colorDist(c, a)));
    return d > best.d ? { c, d } : best;
  }, { c: list[0], d: -1 }).c;
  const GKC = ["#8e44ad", "#f39c12", "#1abc9c", "#ff69b4", "#7f8c8d", "#00e5ff", "#c0ff00"];
  const gk0 = pick(GKC, [me.c1, me.c2, oc.fill, oc.line]);
  const gk1 = pick(GKC, [me.c1, me.c2, oc.fill, oc.line, gk0]);
  const ref = pick(["#111111", "#d4ff00", "#ff3fa4", "#00b8ff"], [me.c1, oc.fill, gk0, gk1]);
  return [{ fill: me.c1, line: me.c2, gk: gk0 }, { ...oc, gk: gk1 }, { ref }];
}
function kitOf(p) {
  const c = G.cols[p.team];
  if (p.gk) return { shirt: c.gk, shorts: "#1c1c1c", socks: c.gk, num: lum(c.gk) > 150 ? "#111" : "#fff" };
  return { shirt: c.fill, shorts: c.line, socks: c.fill, num: lum(c.fill) > 150 ? "#111" : "#fff" };
}

/* ---------- sens de jeu (on change de côté à la mi-temps) ---------- */
const dirOf   = team => (team === 0 ? 1 : -1) * (G.flip ? -1 : 1);
const humanTeams = () => (G.remote ? [0, 1] : [0]);       // équipes jouées par de vrais joueurs
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

function makePlayers(tIdx, remote) {
  const ps = [];
  for (let team = 0; team < 2; team++) FORMATION.forEach((f, i) => {
    const L = LINEUPS[tIdx[team]][i];
    ps.push({
      team, i, gk: f.role === "gk", role: f.role, num: L.num, name: L.name, skin: L.skin, hair: L.hair, bald: L.bald,
      hx: 0, hy: 0, x: F.cx, y: F.cy, fx: 1, fy: 0, tx: 0, ty: 0, init: false,
      speed: remote ? 196 : team === 0 ? 192 : 186 + T.stage * 5 + D().spd * 1.2,   // le bot adverse est plus rapide à chaque tour
      dash: 0, holdT: 0, wob: Math.random() * 6, slide: 0, down: 0, stun: 0, slideCD: 0, yellow: 0, off: false, anim: 0,
    });
  });
  return ps;
}

function startGame(opp, opts = {}) {
  hideScreens();
  const tIdx = [T.me, opp];
  G = {
    opp, tIdx, side: 0, remote: !!opts.remote, rin: null, ctrl1: null,
    score: [0, 0], min: 0, period: 0, flip: false,
    players: makePlayers(tIdx, !!opts.remote), cols: teamColors(T.me, opp),
    ref: { x: F.cx, y: F.cy - 9 * PX, fx: 0, fy: 1, anim: 0 }, card: null, foul: null, penDive: null,
    freeze: 0, waitT: 0, waitFn: null, restart: null, lastTouch: 0, hintT: 0,
    msg: "", msgT: 0, msgColor: "#fff", msgCard: null, cam: null,
    ctrl: null, cheer: 0, ended: false, endT: 0,
  };
  setHomes();
  kickoff(0);
  showGameMsg("COUP D'ENVOI", "#ffd23f", 1.2);
  whistle();
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
  G.ball = { x: F.cx, y: F.cy, vx: 0, vy: 0, owner: kicker, lockT: 0.6, lastKicker: null, kickT: 0, protectT: 0, protectTeam: 0 };
  G.ref.x = F.cx - 6 * PX; G.ref.y = F.cy - 10 * PX;
  G.lastTouch = team;
  G.freeze = 1.2;
  G.hintT = 3;
  G.ctrl = null; G.ctrl1 = null;
  updateControl();
}

function wait(t, fn) { G.waitT = t; G.waitFn = fn; }
function showGameMsg(text, color, t = 1.8, card = null) { G.msg = text; G.msgColor = color; G.msgT = t; G.msgCard = card; }
function canAct() { return G && G.freeze <= 0 && G.waitT <= 0 && !G.ended && !G.foul; }
const ctrlOf = team => (team === 0 ? G.ctrl : G.ctrl1);
const active = p => p && !p.off && p.down <= 0 && p.slide <= 0;

/* ---------- actions ---------- */
function kick(p, tx, ty, speed) {
  const b = G.ball;
  const pen = G.restart && G.restart.taker === p && G.restart.type === "penalty";
  if (G.restart && G.restart.taker === p) {
    if (G.restart.type === "throw") speed = Math.min(speed, THROW_SPEED);   // une touche se joue à la main, moins fort
    G.restart = null;
  }
  const dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy) || 1;
  b.vx = dx / d * speed; b.vy = dy / d * speed;
  b.owner = null; b.lastKicker = p; b.kickT = 0.25; b.lockT = 0;
  b.freeT = 0.14;                                  // le ballon quitte le pied : personne ne peut le toucher tout de suite
  b.target = null; b.isPass = false;
  G.lastTouch = p.team;
  // relance du gardien protégée : l'adversaire ne peut pas l'intercepter tout de suite
  if (p.gk) { b.protectTeam = p.team; b.protectT = 0.5; } else b.protectT = 0;
  // penalty : le gardien choisit un côté au hasard
  if (pen) G.penDive = { team: 1 - p.team, y: F.cy + [-1, 0, 1][Math.floor(Math.random() * 3)] * F.gh * 0.72, t: 1.2 };
  beep(160, 0.06, "triangle", 0.12);
}
function take(p) {
  const b = G.ball;
  b.owner = p; b.vx = 0; b.vy = 0; b.lockT = 0.4; b.target = null;
  G.lastTouch = p.team;
}
function passTo(p, q) {
  const d = dist(p, q);
  const human = p === G.ctrl || (G.remote && p === G.ctrl1);
  const err = human ? 0 : d * 0.05;                // les bots ne font pas des passes parfaites
  kick(p, q.x + rand(-err, err), q.y + rand(-err, err), clamp(d * 1.25 + 140, 320, 760));
  G.ball.target = q;                               // le coéquipier visé vient chercher le ballon
  G.ball.isPass = true;
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
  if (!mouse.down) return { dx: 0, dy: 0 };
  const m = mouseWorld();
  const dx = m.x - p.x, dy = m.y - p.y, d = Math.hypot(dx, dy);
  if (d < 6) return { dx: 0, dy: 0 };
  const s = Math.min(1, d / 30);                 // ralentit en arrivant sur la souris
  return { dx: dx / d * s, dy: dy / d * s };
}

// Tir vers un point (la souris) ; sans point, vers le but adverse. Sans ballon : tacle debout.
function humanShoot(target, noDash) { actShoot(0, target, noDash); }
function actShoot(team, target, noDash) {
  if (!canAct() || !active(ctrlOf(team))) return;
  const p = ctrlOf(team), b = G.ball;
  if (b.owner === p) {
    const t = target || { x: goalXOf(team) + dirOf(team) * 10, y: F.cy + rand(-30, 30) };
    kick(p, t.x + rand(-10, 10), t.y + rand(-10, 10), SHOT_SPEED);
  } else if (b.owner && b.owner.team !== team && !b.owner.gk && dist(p, b.owner) < 28 && b.lockT <= 0) {
    if (Math.random() < 0.55) take(p);          // tacle debout réussi
    else b.lockT = 0.3;
  } else if (!noDash) {
    p.dash = 0.3;                                // petit sprint
  }
}

// Passe : au coéquipier le plus proche du point visé, sinon dans la direction du regard (téléphone)
function humanPass(target) { return actPass(0, target); }
function actPass(team, target) {
  if (!canAct() || !active(ctrlOf(team))) return false;
  const p = ctrlOf(team);
  if (G.ball.owner !== p) return false;
  let best = null, bs = -1e9;
  for (const q of G.players) {
    if (q.team !== team || q === p || q.off) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    if (d < 30) continue;
    let score;
    if (target) score = -dist(q, target) - (q.gk ? 200 : 0);
    else score = (dx * p.fx + dy * p.fy) / d * 100 - d * 0.06 - (q.gk ? 80 : 0);
    if (score > bs) { bs = score; best = q; }
  }
  if (best) { passTo(p, best); return true; }
  return false;
}

// Clic droit : passe si on a le ballon, sinon tacle glissé vers la souris
function actRight(team, target) {
  const p = ctrlOf(team);
  if (!p) return;
  if (G.ball.owner === p) actPass(team, target);
  else actTackle(team, target);
}
function actTackle(team, target) {
  if (!canAct()) return;
  const p = ctrlOf(team);
  if (!active(p) || p.slideCD > 0) return;
  startSlide(p, target || { x: G.ball.x, y: G.ball.y });
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
  if (!p.touchedBall && !(b.owner && (b.owner.team === p.team || b.owner.gk))) {
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
      if (q.team === p.team || q.off || q.down > 0) continue;
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
}
function sendOff(p) {
  p.off = true; p.slide = 0; p.down = 0;
  if (G.ctrl === p) G.ctrl = null;
  if (G.ctrl1 === p) G.ctrl1 = null;
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
  if (taker.team === 0 && !taker.gk) G.ctrl = taker;
  if (G.remote && taker.team === 1 && !taker.gk) G.ctrl1 = taker;
  if (type === "penalty") {                      // tout le monde hors de la surface, gardien sur sa ligne
    const gx = goalXOf(team), d = dirOf(team);
    for (const p of G.players) {
      if (p.off || p === taker) continue;
      if (p.gk && p.team !== team) { p.x = gx - d * 4; p.y = F.cy; continue; }
      if (Math.abs(p.x - gx) < F.boxD + 15) p.x = gx - d * (F.boxD + 18 + Math.random() * 50);
    }
  }
  showGameMsg(RESTART_LABEL[type], "#fff", 1.2);
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
    kick(p, tx + rand(-20, 20), ty + rand(-20, 20), 620);
  } else if (r.type === "free" && Math.hypot(gx - G.ball.x, F.cy - G.ball.y) < 30 * PX && Math.random() < 0.6) {
    kick(p, gx + d * 10, F.cy + rand(-F.gh + 6, F.gh - 6), SHOT_SPEED);     // coup franc direct
  } else {
    const q = bestPassTarget(p) || G.players.find(m => m.team === p.team && m !== p && !m.gk && !m.off);
    passTo(p, q);
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
  for (const q of G.players) if (q.team !== p.team && !q.off) { const d = dist(p, q); if (d < bd) { bd = d; best = q; } }
  return { q: best, d: bd };
}
function chasers(team) {           // les 2 joueurs de champ les plus proches du ballon
  const list = G.players.filter(q => q.team === team && !q.gk && !q.off && q.down <= 0);
  list.sort((a, b) => dist(a, G.ball) - dist(b, G.ball));
  return list;
}
const closestToBall = team => chasers(team)[0] || null;
function bestPassTarget(p) {
  const dir = dirOf(p.team);
  let best = null, bs = -1e9;
  for (const q of G.players) {
    if (q.team !== p.team || q === p || q.gk || q.off) continue;
    const d = dist(p, q);
    if (d < 50 || d > 520) continue;
    const free = nearestOpp(q).d;
    let score = (q.x - p.x) * dir * 0.8 + Math.min(free, 130) - d * 0.1;
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
  return { tx: clamp(tx, F.x1 + 30, F.x2 - 30), ty: clamp(ty, F.y1 + 20, F.y2 - 20) };
}

function updateControl() {
  const b = G.ball;
  for (const team of humanTeams()) {
    const key = team === 0 ? "ctrl" : "ctrl1";
    const cur = G[key];
    if (b.owner && b.owner.team === team && !b.owner.gk) { G[key] = b.owner; continue; }
    if (!b.owner && b.target && b.target.team === team && !b.target.off && !b.target.gk) { G[key] = b.target; continue; }
    if (cur && !cur.off && !cur.gk && (cur.slide > 0 || cur.down > 0)) continue;   // on garde le joueur qui tacle
    const best = closestToBall(team);
    if (!best) continue;
    if (!cur || cur.off || cur.gk || (best !== cur && dist(best, b) < dist(cur, b) - 40)) G[key] = best;
  }
}

function humanMove(p, dt) {
  if (G.restart && G.restart.taker === p) {       // le tireur ne bouge pas pendant une remise en jeu
    if (G.restart.t > 6) restartKick(p);          // trop long : on joue automatiquement
    return;
  }
  const { dx, dy } = p.team === 1 && G.remote ? remoteDir(p) : inputDir(p);
  const len = Math.hypot(dx, dy);
  if (len < 0.05 && !G.ball.owner && G.ball.target === p) { meetBall(p, dt, 190); return; }   // aide à la réception
  if (len > 0.1) { p.fx = dx / len; p.fy = dy / len; }
  const sp = (G.ball.owner === p ? 185 : 200) * (p.dash > 0 ? 1.5 : 1) * (p.stun > 0 ? 0.5 : 1);
  p.x += dx * sp * dt; p.y += dy * sp * dt;
  clampPlayer(p);
}

function gkAI(p, dt) {
  const b = G.ball;
  const own = ownXOf(p.team), dir = dirOf(p.team);
  if (b.owner === p) {
    if (G.restart) { if (G.restart.t > 1.2) restartKick(p); return; }   // 6 mètres
    p.holdT -= dt;
    if (p.holdT <= 0) {
      const q = bestPassTarget(p) || G.players.find(m => m.team === p.team && !m.gk && !m.off);
      passTo(p, q);
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
      const bot = p.team === 1 && !G.remote;
      p.reactT = rand(0.13, 0.27) / (bot ? D().gkCatch : 1);
    }
    if (p.reactT > 0) { p.reactT -= dt; return; }
    const t = (tx - b.x) / (b.vx || 1);
    ty = b.y + b.vy * Math.max(0, t); sp = 185;
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
    if (dist(p, b) < 20 && b.lockT <= 0 && Math.random() < 2.2 * dt) take(p), p.holdT = 1;
  }
  moveTo(p, tx, ty, sp, dt);
}

function outfieldAI(p, dt) {
  const b = G.ball, team = p.team, dir = dirOf(team);
  const oppGoalX = goalXOf(team);
  const r = G.restart;
  const sp = p.speed * (p.stun > 0 ? 0.5 : 1);

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
    if (dg < 30 * PX && (Math.random() < 1.7 * dt || dg < 18 * PX)) {
      const err = dg * 0.07;
      kick(p, oppGoalX + dir * 10, F.cy + rand(-(F.gh - 6), F.gh - 6) + rand(-err, err), SHOT_SPEED * rand(0.85, 1));
      return;
    }
    const n = nearestOpp(p);
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
        const bot = team === 1 && !G.remote;
        if (d < 70 && d > 22 && p.slideCD <= 0 && p.yellow === 0) {   // tacle glissé (prudent s'il a déjà un jaune)
          const rate = bot ? (0.3 + T.stage * 0.05) * D().tackle : 0.3;
          if (Math.random() < rate * dt) {
            const aimBall = Math.random() < (bot ? 0.75 + D().tackle * 0.06 : 0.8);
            startSlide(p, aimBall ? { x: b.x + o.fx * 6, y: b.y + o.fy * 6 } : { x: o.x, y: o.y });
            p.slideCD = 2.5;
          }
        }
        if (d < 24 && b.lockT <= 0 && p.slide <= 0) {           // tacle debout
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
    if (a.off || c.off || a.slide > 0 || c.slide > 0) continue;
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
    b.x = o.x + o.fx * 12; b.y = o.y + o.fy * 12;
    if (G.restart) return;
    const inMouth = Math.abs(b.y - F.cy) < F.gh;
    if (b.x > F.x2 && inMouth) return goal(attRight);
    if (b.x < F.x1 && inMouth) return goal(1 - attRight);
    if (b.y < F.y1 || b.y > F.y2 || b.x < F.x1 || b.x > F.x2) {   // le porteur sort le ballon du terrain
      b.owner = null; b.vx = o.fx * 30; b.vy = o.fy * 30; G.lastTouch = o.team;
      return;
    }
    // un de mes joueurs touche le ballon d'un adversaire (pas du gardien) = il le récupère automatiquement
    if (!o.gk && b.lockT <= 0) {
      for (const q of G.players) {
        if (q.team !== o.team && (q === G.ctrl || (G.remote && q === G.ctrl1)) && active(q) && q.stun <= 0 && dist(q, b) < 14) { take(q); break; }
      }
    }
    return;
  }

  b.x += b.vx * dt; b.y += b.vy * dt;
  const f = Math.pow(0.38, dt);
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
    if (Math.abs(b.y - F.cy) < F.gh) return goal(scorer);
    const lineX = right ? F.x2 : F.x1;
    if (G.lastTouch === defender) return startRestart("corner", scorer, lineX, b.y < F.cy ? F.y1 : F.y2);
    return startRestart("goalkick", defender, lineX + (right ? -F.sixD : F.sixD), F.cy + (b.y < F.cy ? -1 : 1) * F.sixW * 0.6);
  }

  const speed = Math.hypot(b.vx, b.vy);
  if (b.freeT > 0) return;
  // le joueur le plus proche du ballon le prend (en cas d'égalité, un vrai joueur est prioritaire)
  let p = null, pd = 1e9;
  for (const q of G.players) {
    if (q.off || q.down > 0 || q.slide > 0 || q.stun > 0) continue;
    if (q === b.lastKicker && b.kickT > 0) continue;
    if (b.protectT > 0 && q.team !== b.protectTeam) continue;
    if (q.missT > 0) continue;
    if (!b.isPass && b.lastKicker && q.team === b.lastKicker.team && !q.gk && speed > 450) continue;   // un tir passe entre ses coéquipiers
    const mate = b.isPass && b.lastKicker && b.lastKicker.team === q.team && !q.gk;   // coéquipier de celui qui a passé
    const reach = q === b.target ? 22 : mate ? 17 : q.gk ? 19 : 13;
    const d = dist(q, b) - (humanTeams().includes(q.team) ? 2 : 0);
    if (d < reach && d < pd) { pd = d; p = q; }
  }
  if (p && !p.gk && b.lastKicker && b.lastKicker.team !== p.team && speed > 420 && p.slide <= 0 && Math.random() < 0.5) {
    p.missT = 0.35; p = null;                      // l'adversaire rate l'interception, le ballon passe
  }
  if (p) {
    if (p.gk && speed > 300) {
      let catchChance = speed > 650 ? 0.33 : 0.55;
      if (p.team === 1 && !G.remote) catchChance = Math.min(0.95, catchChance * D().gkCatch);   // gardien du bot selon la difficulté
      if (Math.random() < catchChance) { take(p); p.holdT = 1; showGameMsg("ARRÊT !", humanTeams().includes(p.team) && !G.remote ? "#2ecc71" : "#fff", 1); }
      else {                                       // il repousse le ballon sur le côté
        b.lastKicker = p; b.kickT = 0.3; p.missT = 0.5; G.lastTouch = p.team;
        b.vx *= -0.25; b.vy = (Math.random() < 0.5 ? -1 : 1) * rand(220, 360);
        showGameMsg("PARADE !", "#fff", 0.8);
      }
    } else if (!p.gk && speed > 520 && !(b.isPass && b.lastKicker && b.lastKicker.team === p.team) && Math.random() < 0.7) {
      // ballon trop rapide : il touche le joueur et est dévié
      b.lastKicker = p; b.kickT = 0.25; G.lastTouch = p.team;
      b.vx = b.vx * 0.55 + rand(-120, 120); b.vy = b.vy * 0.55 + rand(-120, 120);
    } else {
      take(p);
      if (p.gk) p.holdT = 1;
    }
  }
}

function goal(team) {
  G.score[team]++;
  const b = G.ball;
  b.owner = null; b.vx = 0; b.vy = 0;
  b.x = b.x > F.cx ? F.x2 + 14 : F.x1 - 14;
  G.restart = null;
  if (G.remote) { showGameMsg(\`BUT \${TEAMS[G.tIdx[team]].name.toUpperCase()} !\`, "#ffd23f", 2); G.cheer = 2; if (team === 0) crowdSound(); else beep(120, 0.3, "sawtooth", 0.04); }
  else if (team === 0) { showGameMsg("BUT !!!", "#2ecc71", 2); G.cheer = 2; crowdSound(); }
  else { showGameMsg("But adverse...", "#e74c3c", 2); beep(120, 0.3, "sawtooth", 0.04); }
  wait(2, () => kickoff(1 - team));
}

function periodEnd() {
  const p = G.period;
  G.min = PERIOD_END[p];
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
    G.flip = !G.flip;                            // changement de côté
    setHomes();
    kickoff(G.period % 2 === 1 ? 1 : 0);
  });
}

/* ---------- boucle du match ---------- */
function updateGame(dt) {
  if (G.msgT > 0) G.msgT -= dt;
  if (G.cheer > 0) G.cheer -= dt;
  if (G.hintT > 0 && canAct()) G.hintT -= dt;

  if (G.ended) { G.endT -= dt; if (G.endT <= 0) endGame(); return; }
  if (G.waitT > 0) {
    G.waitT -= dt;
    if (G.waitT <= 0) { const f = G.waitFn; G.waitFn = null; if (f) f(); }
    return;
  }
  if (G.foul) { updateFoul(dt); return; }
  if (G.freeze > 0) { G.freeze -= dt; return; }

  G.min += dt * 90 / MATCH_LEN;
  if (G.min >= PERIOD_END[G.period]) { periodEnd(); return; }

  const b = G.ball;
  if (b.lockT > 0) b.lockT -= dt;
  if (b.kickT > 0) b.kickT -= dt;
  if (b.protectT > 0) b.protectT -= dt;
  if (b.freeT > 0) b.freeT -= dt;
  if (G.penDive) { G.penDive.t -= dt; if (G.penDive.t <= 0) G.penDive = null; }
  if (G.restart) G.restart.t += dt;
  updateControl();
  for (const p of G.players) {
    if (p.off) continue;
    if (p.dash > 0) p.dash -= dt;
    if (p.stun > 0) p.stun -= dt;
    if (p.missT > 0) p.missT -= dt;
    if (p.slideCD > 0) p.slideCD -= dt;
    if (p.slide > 0) { updateSlide(p, dt); if (G.foul) return; continue; }
    if (p.down > 0) { p.down -= dt; continue; }
    if (p === G.ctrl || (G.remote && p === G.ctrl1)) humanMove(p, dt);
    else if (p.gk) gkAI(p, dt);
    else outfieldAI(p, dt);
  }
  separate();
  updateBall(dt);
  updateRef(dt);
}

function endGame() {
  const [a, b] = G.score;
  const et = G.period >= 2;
  const live = G.remote, tIdx = G.tIdx;
  G = null;
  if (live) {                                   // match en direct : l'hôte envoie le résultat
    if (a !== b) return liveFinish({ a, b, et });
    pendingScore = { a, b };
    relay(NET.live.peer, { k: "pens", a, b, tIdx });
    return startMatch(tIdx[1], { remote: true });
  }
  if (a !== b) { finishMatch({ a, b, et }); return; }
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
  const tx = clamp(b.x - vw / 2, 0, WORLD.w - vw);
  const ty = clamp(b.y - vh / 2 - 15, -15, WORLD.h - vh);
  if (!G.cam) G.cam = { x: tx, y: ty };
  const k = Math.min(1, frameDT * 3.5);
  G.cam.x += (tx - G.cam.x) * k; G.cam.y += (ty - G.cam.y) * k;
}

function drawPitch() {
  // pelouse et bandes de tonte
  ctx.fillStyle = "#246b31"; ctx.fillRect(0, 0, WORLD.w, WORLD.h);
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
      ctx.fillStyle = (s / seg) % 2 ? "#0d4d8c" : "#b8001f";
      if (vertical) ctx.fillRect(x, y + s, w, Math.min(seg, len - s)); else ctx.fillRect(x + s, y, Math.min(seg, len - s), h);
    }
    ctx.save();
    ctx.fillStyle = "#fff"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let s = seg / 2; s < len; s += seg) {
      if (vertical) { ctx.save(); ctx.translate(x + w / 2, y + s); ctx.rotate(-Math.PI / 2); ctx.fillText("COUPE DU MONDE", 0, 0); ctx.restore(); }
      else ctx.fillText("COUPE DU MONDE", x + s, y + h / 2);
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
      ctx.fillStyle = "rgba(255,255,255,.18)";
      ctx.fillRect(x0, F.cy - F.gh, depth, F.gh * 2);
      ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let y = F.cy - F.gh; y <= F.cy + F.gh; y += 7) { ctx.moveTo(x0, y); ctx.lineTo(x0 + depth, y); }
      for (let x = x0; x <= x0 + depth; x += 7) { ctx.moveTo(x, F.cy - F.gh); ctx.lineTo(x, F.cy + F.gh); }
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

function drawPlayer(p) {
  stepAnim(p);
  const kit = kitOf(p);
  const look = { x: p.x, y: p.y, fx: p.fx, fy: p.fy, anim: p.anim, mv: p.mv, kit, skin: p.skin, hair: p.hair, bald: p.bald, num: p.num, gloves: p.gk };
  // cercle sous le joueur contrôlé
  if (p === G.ctrl || (G.remote && p === G.ctrl1)) {
    ctx.strokeStyle = p === G.ctrl ? "#ffd23f" : "#ff7aa8"; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, 13, 5, 0, 0, Math.PI * 2); ctx.stroke();
  }
  if (p.slide > 0) drawLying(look, Math.atan2(p.fy, p.fx));
  else if (p.down > 0) drawLying(look, Math.atan2(p.fy, p.fx) + Math.PI / 2);
  else drawPerson(look);
}

function drawLabel(p) {
  const lying = p.slide > 0 || p.down > 0;
  const y = p.y - (lying ? 20 : 45);
  const me = p === G.ctrl;
  const txt = \`\${p.num} \${p.name}\`;
  ctx.font = \`bold \${me ? 8 : 7}px sans-serif\`; ctx.textAlign = "center";
  ctx.lineWidth = 2.6; ctx.strokeStyle = "rgba(0,0,0,.75)";
  ctx.strokeText(txt, p.x, y);
  ctx.fillStyle = me ? "#ffd23f" : (G.remote && p === G.ctrl1) ? "#ffb3cd" : "#fff";
  ctx.fillText(txt, p.x, y);
  if (p.yellow > 0) {                            // carton jaune reçu
    const w = ctx.measureText(txt).width;
    ctx.fillStyle = "#ffd400"; ctx.fillRect(p.x + w / 2 + 2, y - 6, 3.5, 5);
  }
  if (me) {
    ctx.fillStyle = "#ffd23f";
    ctx.beginPath(); ctx.moveTo(p.x - 4, y - 13); ctx.lineTo(p.x + 4, y - 13); ctx.lineTo(p.x, y - 8); ctx.fill();
  }
}

function drawBallW() {
  const b = G.ball;
  const sp = b.owner ? 0 : Math.hypot(b.vx, b.vy);
  const z = clamp((sp - 380) / 35, 0, 11);       // un tir puissant décolle un peu
  ctx.fillStyle = "rgba(0,0,0,.32)";
  ctx.beginPath(); ctx.ellipse(b.x + 1 + z * 0.3, b.y + 2, 4.5, 2.2, 0, 0, Math.PI * 2); ctx.fill();
  const by = b.y - z - 3;
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#333"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(b.x, by, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#222";
  ctx.beginPath(); ctx.arc(b.x, by, 1.5, 0, Math.PI * 2); ctx.fill();
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
    ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), p === G.ctrl ? 3 : 2.2, 0, Math.PI * 2); ctx.fill();
    if (p === G.ctrl) { ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 1.2; ctx.stroke(); }
  }
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(sx(G.ball.x), sy(G.ball.y), 2, 0, Math.PI * 2); ctx.fill();
  if (G.cam) {
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1;
    ctx.strokeRect(sx(G.cam.x), sy(G.cam.y), (W / CAM_Z) / (F.x2 - F.x1) * mw, (H / CAM_Z) / (F.y2 - F.y1) * mh);
  }
}

function drawGame() {
  updateCam();
  ctx.fillStyle = "#1d5a2a"; ctx.fillRect(0, 0, W, H);
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

  // joueurs, arbitre et ballon dessinés du fond vers l'avant
  const ents = [];
  for (const p of G.players) if (!p.off) ents.push({ y: p.y, p });
  ents.push({ y: G.ref.y, ref: true });
  ents.push({ y: G.ball.y + 0.5, ball: true });
  ents.sort((a, b) => a.y - b.y);
  for (const e of ents) {
    if (e.ball) drawBallW();
    else if (e.ref) {
      const rf = G.ref; stepAnim(rf);
      const c = G.cols[2].ref;
      drawPerson({ x: rf.x, y: rf.y, fx: rf.fx, fy: rf.fy, anim: rf.anim, mv: rf.mv, skin: "#c98d5f", hair: "#16100a", bald: true,
        kit: { shirt: c, shorts: "#111", socks: "#111", num: "#fff" }, num: null, card: G.card });
    } else drawPlayer(e.p);
  }
  drawGoals(true);
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

  drawGameHUD();
  drawMinimap();

  // consignes
  const mine = G.restart && G.restart.taker === G.ctrl && canAct();
  if (mine) {
    const tt = { corner: "Corner : clique et lâche vers la surface (clic droit = passe)",
                 throw: "Touche : clique et lâche vers un coéquipier (clic droit = passe)",
                 free: "Coup franc : clique et lâche pour tirer (clic droit = passe)",
                 penalty: "Penalty : vise un coin du but, clique et lâche !" };
    drawInstruction(tt[G.restart.type] || "Clique et lâche pour jouer");
  } else if (G.period === 0 && G.min < 7 && canAct()) {
    drawInstruction(touchMode ? "Doigt à gauche : courir · TIR · PASSE · TACLE (boutons à droite)"
                              : "Clic gauche maintenu : courir · Lâche : tirer · Clic droit : TACLE (ou passe si tu as le ballon)");
  } else if (G.hintT > 0) {
    drawInstruction(dirOf(G.side) > 0 ? "Tu attaques vers la droite  →" : "←  Tu attaques vers la gauche");
  }
  if (touchMode) drawTouchControls();

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
  ctx.fillText(me.name, 58, 37);
  drawFlag(G.tIdx[1], 751, 22, 27, 18);
  ctx.fillStyle = "#fff"; ctx.textAlign = "right";
  ctx.fillText(op.name, 742, 37);
  // couleur du maillot + cartons rouges de chaque équipe
  for (const t of [0, 1]) {
    const x0 = t === 0 ? 64 : 736;
    ctx.fillStyle = G.cols[t].fill; ctx.strokeStyle = G.cols[t].line; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x0, 50, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    const reds = G.players.filter(p => p.team === t && p.off).length;
    for (let k = 0; k < reds; k++) {
      ctx.fillStyle = "#e52521";
      ctx.fillRect(t === 0 ? x0 + 10 + k * 7 : x0 - 15 - k * 7, 45, 5, 8);
    }
  }
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd23f"; ctx.font = "bold 12px sans-serif";
  const label = G.period >= 2 ? "PROLONGATIONS" : T.stages[T.stage].toUpperCase();
  ctx.fillText(\`\${label} · \${Math.floor(G.min)}'\`, 400, 22);
  ctx.fillStyle = "#fff"; ctx.font = "bold 26px sans-serif";
  ctx.fillText(\`\${G.score[0]} - \${G.score[1]}\`, 400, 50);
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
  for (const k of ["shoot", "pass", "tackle"]) {
    const bt = BTN[k];
    ctx.fillStyle = k === "shoot" ? "rgba(231,76,60,.75)" : k === "pass" ? "rgba(52,152,219,.75)" : "rgba(243,156,18,.8)";
    ctx.beginPath(); ctx.arc(bt.x, bt.y, bt.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = \`bold \${k === "shoot" ? 16 : 13}px sans-serif\`; ctx.textAlign = "center";
    ctx.fillText(bt.label, bt.x, bt.y + 5);
  }
}

/* =========================================================
   SÉANCE DE TIRS AU BUT (en cas d'égalité)
   ========================================================= */
function startMatch(opp, opts = {}) {
  hideScreens();
  M = {
    opp, tIdx: [T.me, opp], local: "me", remote: !!opts.remote, rdive: null,
    shots: { me: [], opp: [] },
    turn: "me",
    difficulty: Math.max(0.05, 0.2 + T.stage * 0.07 + D().pen),   // le gardien adverse devine mieux à chaque tour
    msg: "", msgT: 0, msgColor: "#fff",
    cheer: 0,
    aim: { x: 400, y: 185 },
  };
  whistle();
  setupTurn();
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
    else showMsg(win ? (T.stage === T.stages.length - 1 ? "CHAMPION !" : "QUALIFIÉ !") : "DÉFAITE...", win ? "#ffd23f" : "#e74c3c");
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
        const live = M.remote;
        M = null;
        const res = { a: pendingScore.a, b: pendingScore.b, pa, pb, et: true };
        if (live) liveFinish(res); else finishMatch(res);
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
  if (aiming && iShoot) {
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
    const peer = NET.live && NET.live.peer;
    if (!peer || !p) return;
    if (M.turn === "opp") {
      if (M.phase === "raim") { M.aim = clampAim(p); relay(peer, { k: "plock", x: M.aim.x, y: M.aim.y }); }
      else if (M.phase === "rpower") relay(peer, { k: "pshoot" });
    } else if ((M.phase === "aim" || M.phase === "power") && !M.dive) {
      M.dive = clampKeeper(p); relay(peer, { k: "pdive", x: M.dive.x, y: M.dive.y });
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

canvas.addEventListener("pointerdown", e => {
  e.preventDefault();
  initAudio();
  if (CELEB) { if (CELEB.t > 1.5) endCeleb(); return; }   // fin de la célébration
  if (e.pointerType === "touch") touchMode = true;
  else if (e.pointerType === "mouse") touchMode = false;
  const p = toCanvas(e);
  mouse.x = p.x; mouse.y = p.y;
  if (G) {
    const peer = G.view && NET.live ? NET.live.peer : null;
    if (!touchMode) { mouseButtons(e); return; }    // souris : géré par mouseButtons (plusieurs boutons à la fois)
    if (dist(p, BTN.shoot) < BTN.shoot.r + 10) {
      if (peer) relay(peer, { k: "rel", x: null, touch: true });
      else humanShoot(G.ctrl && G.ball.owner === G.ctrl ? { x: goalXOf(0) + dirOf(0) * 10, y: F.cy + (joy.active ? joy.dy : 0) * F.gh * 0.85 } : null);
    }
    else if (dist(p, BTN.pass) < BTN.pass.r + 10) { if (peer) relay(peer, { k: "pass", x: null }); else humanPass(); }
    else if (dist(p, BTN.tackle) < BTN.tackle.r + 10) { if (peer) relay(peer, { k: "tackle", x: null }); else actTackle(0, null); }
    else if (p.x < 520 && !joy.active) {
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
function leftDown() {                              // clic gauche maintenu = courir
  mouse.down = true; mouse.downAt = performance.now();
  if (G.view && NET.live) sendGuestInput(true);
}
function rightDown() {                             // clic droit = tacle (ou passe si on a le ballon), même en courant
  const w = mouseWorld();
  if (G.view) { if (NET.live) relay(NET.live.peer, { k: "right", x: Math.round(w.x), y: Math.round(w.y) }); }
  else actRight(0, w);
}
window.addEventListener("pointermove", mouseButtons);
window.addEventListener("pointerup", mouseButtons);
window.addEventListener("pointerdown", e => { if (e.target !== canvas) mouseButtons(e); });
function leftUp() {
  if (!mouse.down) return;
  mouse.down = false;
  if (G && G.view) {                                 // invité en ligne
    if (NET.live) { const w = mouseWorld(); sendGuestInput(true); relay(NET.live.peer, { k: "rel", x: Math.round(w.x), y: Math.round(w.y) }); }
    return;
  }
  if (!G || !G.ctrl) return;
  // lâcher le clic gauche = tirer vers la souris (ou tacler si on n'a pas le ballon)
  const c = G.ctrl, w = mouseWorld();
  if (G.ball.owner === c) {
    const close = dist(c, w) < 25;               // souris collée au joueur : on tire vers le but
    humanShoot(close ? null : w);
  } else {
    humanShoot(null, true);
  }
}
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
    if (G.view && mouse.down) sendGuestInput();
    return;
  }
  if (M && M.view) {
    if (M.turn === "opp" && M.phase === "raim") {
      M.aim = clampAim(p);
      const now = performance.now();
      if (NET.live && now - NET.inT > 60) { NET.inT = now; relay(NET.live.peer, { k: "paim", x: M.aim.x, y: M.aim.y }); }
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
   MODE EN LIGNE : salons, tournoi partagé et matchs en direct
   (nécessite le serveur : node server.js)
   ========================================================= */
const NET = {
  ws: null, id: null, room: null, ok: false,
  live: null,                  // match en direct : { peer, host, m, stage, readyMe }
  readyFrom: new Set(),        // joueurs prêts (id:tour)
  sendT: 0, inT: 0,
};
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toast.tm); toast.tm = setTimeout(() => t.classList.remove("on"), 3200);
}
function netSend(o) { if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(o)); }
const relay = (to, d) => netSend({ t: "relay", to, d });

function getName() {
  let n = ($("pseudo").value || "").trim().slice(0, 16);
  if (!n) n = "Joueur" + Math.floor(Math.random() * 900 + 100);
  $("pseudo").value = n;
  try { localStorage.setItem("cdm_pseudo", n); } catch (e) {}
  netSend({ t: "name", name: n });
  return n;
}

function netConnect() {
  const st = $("netStatus");
  if (location.protocol === "file:") {
    NET.ok = false;
    st.innerHTML = "⚠️ Le mode en ligne a besoin du serveur.<br>Dans le dossier du jeu, ouvre un terminal et tape <b>node server.js</b>, puis ouvre <b>http://localhost:3000</b>";
    st.className = "net-status bad";
    return;
  }
  if (NET.ws && NET.ws.readyState <= 1) return;
  st.textContent = "Connexion au serveur..."; st.className = "net-status";
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
  NET.ws = ws;
  ws.onopen = () => { NET.ok = true; st.textContent = "✅ Connecté au serveur"; st.className = "net-status good"; };
  ws.onclose = () => {
    NET.ok = false; NET.room = null;
    st.textContent = "❌ Pas de connexion au serveur"; st.className = "net-status bad";
    if (T && T.online) { G = null; M = null; T = null; NET.live = null; toast("Connexion perdue"); show("title"); }
  };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (er) { return; } onNet(m); };
}

function onNet(m) {
  switch (m.t) {
    case "hello": NET.id = m.id; break;
    case "rooms": renderRoomList(m.rooms); break;
    case "error": toast(m.msg); break;
    case "left": toast(\`\${m.name} a quitté le salon\`); break;
    case "room":
      NET.room = m.room;
      if (m.room.state === "lobby") {
        if (!$("roomScreen").classList.contains("hidden") || !$("createScreen").classList.contains("hidden") || !$("joinScreen").classList.contains("hidden")) show("roomScreen");
        renderRoom();
      }
      break;
    case "tour": onTour(m.tour); break;
    case "relay": onRelay(m.from, m.d); break;
  }
}

/* ---------- écrans : créer / rejoindre / salon ---------- */
function renderRoomList(list) {
  const el = $("roomList");
  if (!list.length) { el.innerHTML = \`<p class="muted">Aucun salon public pour l'instant. Crée le tien !</p>\`; return; }
  el.innerHTML = list.map(r => \`
    <div class="room-row">
      <div><b>\${r.name}</b><br><span class="muted">\${r.players}/\${r.maxPlayers} joueurs · \${r.numTeams} pays · bots \${DIFFS[r.diff].label}</span></div>
      <button class="small-btn" data-code="\${r.code}">Rejoindre</button>
    </div>\`).join("");
  el.querySelectorAll("button").forEach(b => b.onclick = () => { getName(); netSend({ t: "join", code: b.dataset.code }); });
}

function renderRoom() {
  const r = NET.room; if (!r) return;
  const meP = r.players.find(p => p.id === NET.id);
  const isHost = r.host === NET.id;
  $("rName").textContent = r.name;
  $("rCode").textContent = r.code;
  $("rInfo").textContent = \`\${r.players.length}/\${r.maxPlayers} joueurs · \${r.numTeams} pays · bots \${DIFFS[r.diff].label} · \${r.public ? "salon public" : "salon privé"}\`;
  $("rPlayers").innerHTML = r.players.map(p => \`
    <div class="pl-chip\${p.id === NET.id ? " me" : ""}">
      \${p.team != null ? \`<img class="mini-flag" src="\${flagURL(TEAMS[p.team].name)}" alt="">\` : \`<span class="no-flag">?</span>\`}
      \${p.name}\${p.id === r.host ? " 👑" : ""}\${p.id === NET.id ? " (toi)" : ""}
    </div>\`).join("");
  const taken = {};
  r.players.forEach(p => { if (p.team != null) taken[p.team] = p; });
  const grid = $("rGrid");
  grid.innerHTML = "";
  TEAMS.map((t, i) => ({ t, i })).sort((x, y) => x.t.name.localeCompare(y.t.name, "fr")).forEach(({ t, i }) => {
    const b = document.createElement("button");
    const owner = taken[i];
    const mine = owner && owner.id === NET.id;
    b.className = "team" + (mine ? " picked" : "") + (owner && !mine ? " taken" : "");
    b.innerHTML = \`<img class="flag" src="\${flagURL(t.name)}" alt="">\${t.name}\${owner && !mine ? \`<small>\${owner.name}</small>\` : ""}\`;
    if (owner && !mine) b.disabled = true;
    b.onclick = () => netSend({ t: "pick", team: i });
    grid.appendChild(b);
  });
  const allPicked = r.players.every(p => p.team != null);
  $("rStart").classList.toggle("hidden", !isHost);
  $("rStart").disabled = !(r.players.length >= 2 && allPicked);
  $("rMsg").textContent = r.players.length < 2 ? "En attente d'autres joueurs... Partage le code !"
    : !allPicked ? "Chaque joueur doit choisir un pays (pas de doublon)."
    : isHost ? "Tout le monde est prêt : lance le tournoi !" : "En attente du lancement par l'hôte 👑";
  if (!meP || meP.team == null) $("rMsg").textContent = "👇 Choisis ton pays ! " + $("rMsg").textContent;
}

function leaveOnline() {
  netSend({ t: "leave" });
  NET.room = null; NET.live = null; NET.readyFrom.clear();
  G = null; M = null; T = null;
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
  T = { online: true, me, rounds: tour.rounds, scores: tour.scores, stage: tour.stage, stages: tour.stages,
        matches: tour.matches, champion: tour.champion, humans: tour.humans, diff: tour.diff };
  if (!old || old.stage !== T.stage) NET.readyFrom.clear();
  if (G || M) {
    const mm = myOnlineMatch();
    const sc = mm && T.scores[T.stage] && T.scores[T.stage][mm.m];
    if (NET.live && mm && mm.mt.done && sc && sc.ff) { // l'adversaire est parti : victoire par forfait
      G = null; M = null; NET.live = null;
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
    showEnd(T.champion === T.me ? "🏆 CHAMPION DU MONDE !" : \`🏆 \${champ} champion !\`,
      T.champion === T.me ? \`Bravo ! \${champ} remporte la Coupe du monde !\`
        : \`\${champ}\${owner ? " (" + owner.name + ")" : " (bot)"} remporte la Coupe du monde.\`);
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
  renderBracket($("bGrid"));
  $("bracketScreen").classList.remove("hidden");
}
function onlinePlay() {
  const mm = myOnlineMatch();
  if (!mm || mm.mt.done) return;
  if (mm.mt.type === "bot") { startGame(mm.opp); return; }
  const peer = T.humans[mm.opp].id;
  NET.live = { peer, host: mm.first, m: mm.m, stage: T.stage, readyMe: true };
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

/* ---------- match en direct : l'hôte calcule, l'invité affiche ---------- */
function startLiveHost() {
  const mm = myOnlineMatch();
  relay(NET.live.peer, { k: "start", tIdx: [T.me, mm.opp] });
  startGame(mm.opp, { remote: true });
  showGameMsg("COUP D'ENVOI", "#ffd23f", 1.2);
}
function liveFinish(res) {       // l'hôte termine le match (score dans l'ordre du tableau)
  const mm = myOnlineMatch();
  if (mm && NET.live) {
    netSend({ t: "result", m: mm.m, res });
    relay(NET.live.peer, { k: "end" });
  }
  G = null; M = null; NET.live = null;
  showOnlineBracket();
}
function startViewG(tIdx) {
  hideScreens();
  G = {
    view: true, side: 1, tIdx, cols: teamColors(tIdx[0], tIdx[1]), players: makePlayers(tIdx, true),
    ref: { x: F.cx, y: F.cy - 9 * PX, fx: 0, fy: 1, tx: F.cx, ty: F.cy - 9 * PX }, card: null, foul: null,
    ball: { x: F.cx, y: F.cy, tx: F.cx, ty: F.cy, vx: 0, vy: 0, owner: null }, score: [0, 0], min: 0, period: 0, flip: false,
    restart: null, msg: "", msgT: 0, msgColor: "#fff", msgCard: null, ctrl: null, cheer: 0, freeze: 1, waitT: 0, ended: false, hintT: 4, cam: null,
  };
  whistle();
}
function snapG() {
  const ix = p => p ? G.players.indexOf(p) : -1;
  const b = G.ball, r = G.ref;
  return {
    k: "sg",
    P: G.players.map(p => [Math.round(p.x), Math.round(p.y), +p.fx.toFixed(2), +p.fy.toFixed(2),
      (p.slide > 0 ? 1 : 0) | (p.down > 0 ? 2 : 0) | (p.off ? 4 : 0), p.yellow]),
    B: [Math.round(b.x), Math.round(b.y), ix(b.owner), Math.round(b.vx), Math.round(b.vy)], S: G.score, Mi: +G.min.toFixed(2), Pe: G.period, F: G.flip,
    Rf: [Math.round(r.x), Math.round(r.y), +r.fx.toFixed(2), +r.fy.toFixed(2)], Cd: G.card, Fo: !!G.foul,
    R: G.restart ? [G.restart.type, G.restart.team, ix(G.restart.taker)] : null, C1: ix(G.ctrl1),
    Msg: G.msgT > 0 ? [G.msg, G.msgColor, +G.msgT.toFixed(2), G.msgCard] : null, Ch: G.cheer > 0,
    W: G.waitT > 0, Fr: G.freeze > 0, E: G.ended,
  };
}
function applySnapG(s) {
  if (!G || !G.view) return;
  s.P.forEach((a, i) => {
    const p = G.players[i];
    p.tx = a[0]; p.ty = a[1]; p.fx = a[2]; p.fy = a[3];
    p.slide = a[4] & 1 ? 1 : 0; p.down = a[4] & 2 ? 1 : 0; p.off = !!(a[4] & 4);
    if (a[5] > p.yellow) beep(1500, 0.15, "sine", 0.05);
    p.yellow = a[5];
    if (!p.init) { p.x = a[0]; p.y = a[1]; p.init = true; }
  });
  const b = G.ball;
  b.tx = s.B[0]; b.ty = s.B[1]; b.owner = s.B[2] >= 0 ? G.players[s.B[2]] : null; b.vx = s.B[3]; b.vy = s.B[4];
  const r = G.ref; r.tx = s.Rf[0]; r.ty = s.Rf[1]; r.fx = s.Rf[2]; r.fy = s.Rf[3];
  if (s.Fo && !G.foul) whistle();
  G.card = s.Cd; G.foul = s.Fo;
  if (s.S[0] !== G.score[0] || s.S[1] !== G.score[1]) {
    if (s.S[1] > G.score[1]) { G.cheer = 2; crowdSound(); } else beep(120, 0.3, "sawtooth", 0.04);
  }
  if (s.Pe !== G.period) { whistle(); G.hintT = 3; }
  if (s.R && !G.restart) beep(1800, 0.15, "sine", 0.04);
  if (s.E && !G.ended) { whistle(); setTimeout(whistle, 400); }
  G.score = s.S; G.min = s.Mi; G.period = s.Pe; G.flip = s.F;
  G.restart = s.R ? { type: s.R[0], team: s.R[1], taker: G.players[s.R[2]], t: 0 } : null;
  G.ctrl = s.C1 >= 0 ? G.players[s.C1] : null;
  if (s.Msg) { G.msg = s.Msg[0]; G.msgColor = s.Msg[1]; G.msgT = s.Msg[2]; G.msgCard = s.Msg[3] || null; }
  if (s.Ch) G.cheer = Math.max(G.cheer, 0.3);
  G.waitT = s.W ? 1 : 0; G.freeze = s.Fr ? 1 : 0; G.ended = s.E;
}
function viewUpdateG(dt) {
  const k = Math.min(1, dt * 18);
  for (const p of G.players) { p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k; }
  const r = G.ref; r.x += (r.tx - r.x) * k; r.y += (r.ty - r.y) * k;
  const b = G.ball;
  if (b.owner) { b.x = b.owner.x + b.owner.fx * 12; b.y = b.owner.y + b.owner.fy * 12; }
  else { b.x += (b.tx - b.x) * k; b.y += (b.ty - b.y) * k; }
  if (G.msgT > 0) G.msgT -= dt;
  if (G.cheer > 0) G.cheer -= dt;
  if (G.hintT > 0 && canAct()) G.hintT -= dt;
}
// commandes de l'invité, appliquées par l'hôte
function remoteRelease(d) {
  if (!canAct() || !G.ctrl1) return;
  const c = G.ctrl1;
  if (G.ball.owner === c) {
    const close = d.x == null || dist(c, d) < 25;
    actShoot(1, close ? null : { x: d.x, y: d.y });
  } else actShoot(1, null, !d.touch);
}
function remoteDir(p) {
  const r = G.rin;
  if (!r || !r.down) return { dx: 0, dy: 0 };
  const dx = r.x - p.x, dy = r.y - p.y, d = Math.hypot(dx, dy);
  if (d < 6) return { dx: 0, dy: 0 };
  const s = Math.min(1, d / 30);
  return { dx: dx / d * s, dy: dy / d * s };
}
function sendGuestInput(force) {
  if (!NET.live || !G || !G.view) return;
  const now = performance.now();
  if (!force && now - NET.inT < 40) return;
  NET.inT = now;
  if (touchMode) {
    const c = G.ctrl || { x: F.cx, y: F.cy };
    relay(NET.live.peer, { k: "in", x: c.x + joy.dx * 80, y: c.y + joy.dy * 80, down: joy.active });
  } else { const w = mouseWorld(); relay(NET.live.peer, { k: "in", x: Math.round(w.x), y: Math.round(w.y), down: mouse.down }); }
}

/* ---------- tirs au but en direct ---------- */
function startViewM(tIdx) {
  hideScreens();
  M = {
    view: true, local: "opp", tIdx, shots: { me: [], opp: [] }, turn: "me", phase: "aim", power: 0,
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

/* ---------- messages entre les deux joueurs ---------- */
function onRelay(from, d) {
  switch (d.k) {
    case "ready":
      NET.readyFrom.add(from + ":" + d.stage);
      if (NET.live && NET.live.readyMe && NET.live.host && NET.live.peer === from && !G && !M && d.stage === T.stage) startLiveHost();
      break;
    case "start":
      if (!NET.live) { const mm = myOnlineMatch(); NET.live = { peer: from, host: false, m: mm ? mm.m : -1, stage: T.stage, readyMe: true }; }
      startViewG(d.tIdx);
      break;
    case "sg": if (NET.live && from === NET.live.peer) applySnapG(d); break;
    case "in": if (G && G.remote && from === NET.live.peer) G.rin = d; break;
    case "rel": if (G && G.remote && from === NET.live.peer) remoteRelease(d); break;
    case "pass": if (G && G.remote && from === NET.live.peer) actPass(1, d.x == null ? null : { x: d.x, y: d.y }); break;
    case "right": if (G && G.remote && from === NET.live.peer) actRight(1, { x: d.x, y: d.y }); break;
    case "tackle": if (G && G.remote && from === NET.live.peer) actTackle(1, d.x == null ? null : { x: d.x, y: d.y }); break;
    case "pens":
      G = null; pendingScore = { a: d.a, b: d.b };
      startViewM(d.tIdx);
      break;
    case "sm": if (NET.live && from === NET.live.peer) applySnapM(d); break;
    case "paim": if (M && M.remote && M.turn === "opp" && M.phase === "raim") M.aim = clampAim(d); break;
    case "plock": if (M && M.remote && M.turn === "opp" && M.phase === "raim") { M.aim = clampAim(d); M.phase = "rpower"; M.power = 0; M.powerDir = 1; } break;
    case "pshoot": if (M && M.remote && M.turn === "opp" && M.phase === "rpower") remoteShoot(); break;
    case "pdive": if (M && M.remote && M.turn === "me" && (M.phase === "aim" || M.phase === "power") && !M.rdive) M.rdive = clampKeeper(d); break;
    case "end":
      G = null; M = null; NET.live = null;
      showOnlineBracket();
      break;
  }
}

// envoi régulier de l'état du match par l'hôte (30 fois par seconde)
function netTick() {
  if (!NET.live) return;
  const now = performance.now();
  if (G && G.view && touchMode) sendGuestInput();
  if (now - NET.sendT < 33) return;
  NET.sendT = now;
  if (G && G.remote) relay(NET.live.peer, snapG());
  else if (M && M.remote) relay(NET.live.peer, snapM());
}

/* ---------- boutons des écrans en ligne ---------- */
try { $("pseudo").value = localStorage.getItem("cdm_pseudo") || ""; } catch (e) {}
for (let n = 2; n <= 32; n++) {                 // un salon peut accueillir jusqu'à 32 joueurs
  const o = document.createElement("option"); o.value = n; o.textContent = n + " joueurs";
  if (n === 8) o.selected = true;
  $("cMax").appendChild(o);
}
$("goOnline").onclick = () => { show("onlineScreen"); netConnect(); };
$("goOffline").onclick = () => show("diffScreen");
$("modeBack").onclick = () => show("title");
$("onlineBack").onclick = () => show("modeScreen");
$("createBtn").onclick = () => { if (!NET.ok) return toast("Pas de connexion au serveur"); getName(); show("createScreen"); };
$("joinBtn").onclick = () => {
  if (!NET.ok) return toast("Pas de connexion au serveur");
  getName(); show("joinScreen"); netSend({ t: "list", on: true });
};
$("createBack").onclick = () => show("onlineScreen");
$("joinBack").onclick = () => { netSend({ t: "list", on: false }); show("onlineScreen"); };
$("cMax").onchange = $("cTeams").onchange = () => {
  if (+$("cMax").value > +$("cTeams").value) $("cMax").value = $("cTeams").value;
};
$("createGo").onclick = () => {
  getName();
  netSend({ t: "create", maxPlayers: +$("cMax").value, numTeams: +$("cTeams").value, diff: $("cDiff").value, public: $("cPublic").checked });
};
$("joinCode").oninput = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); };
$("joinGo").onclick = () => {
  const code = $("joinCode").value.trim();
  if (code.length < 5) return toast("Entre le code à 5 caractères de ton ami");
  getName(); netSend({ t: "join", code });
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
  CELEB = { team: teamIdx, t: 0, onDone, fw: [], fwT: 0, conf: [] };
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
  ctx.fillText("CHAMPIONS DU MONDE", 400, 483);

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
    drawPerson({ x: 0, y: -jump / sp.s, fx: 0, fy: 1, anim: C.t * 8, mv: cap ? 0 : 0.4, kit, skin: pl.skin, hair: pl.hair, bald: pl.bald,
                 num: pl.num, armsUp: true, noShadow: true });
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
  ctx.strokeText("REMPORTE LA COUPE DU MONDE !", 0, 30);
  ctx.fillStyle = "#fff"; ctx.fillText("REMPORTE LA COUPE DU MONDE !", 0, 30);
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
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frameDT = dt;
  ctx.setTransform(2, 0, 0, 2, 0, 0);              // dessin net (2x plus de pixels)
  ctx.lineJoin = "round"; ctx.miterLimit = 2;        // contours de texte propres
  ctx.clearRect(0, 0, W, H);
  if (CELEB) drawCeleb(dt);
  else if (G) { if (G.view) viewUpdateG(dt); else updateGame(dt); if (G) drawGame(); else drawShootout(); }
  else { if (M) { if (M.view) { if (M.msgT > 0) M.msgT -= dt; if (M.cheer > 0) M.cheer -= dt; } else update(dt); } drawShootout(); }
  netTick();
  requestAnimationFrame(loop);
}

buildMenu();
buildTitleScene();
requestAnimationFrame(loop);
</script>
</body>
</html>
`; }
var PAGE = pageDuJeu();
