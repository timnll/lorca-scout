// ── Config ────────────────────────────────────────────────────────────────────
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const SERVER   = IS_LOCAL ? 'http://localhost:3001' : `${location.protocol}//${location.host}`;
const WS_URL   = IS_LOCAL ? 'ws://localhost:3001'
               : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

const COLORS = [
  { id:'amber',     label:'Ambre',      hex:'#E9A326' },
  { id:'amethyst',  label:'Améthyste',  hex:'#9B59B6' },
  { id:'emerald',   label:'Émeraude',   hex:'#27AE60' },
  { id:'ruby',      label:'Rubis',      hex:'#C0392B' },
  { id:'sapphire',  label:'Saphir',     hex:'#2980B9' },
  { id:'steel',     label:'Acier',      hex:'#7F8C8D' },
];

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  eventId: null, meta: null,
  players: {}, rounds: [],
  currentRound: 0,
  sheetPlayer: null, sheetColors: [],
  activeScreen: 'pairings',
  // Real names: { [displayName]: realName }
  realNames: {},
};

// ── Offline queue ─────────────────────────────────────────────────────────────
// Patches that failed due to no network are queued and retried.
const QUEUE_KEY = 'lorcana-patch-queue';

function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]'); } catch { return []; } }
function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }

function enqueue(eventId, playerName, colors) {
  const q = getQueue().filter(x => !(x.eventId===eventId && x.player===playerName));
  q.push({ eventId, player: playerName, colors, ts: Date.now() });
  saveQueue(q);
  updateQueueBadge();
}

function dequeue(eventId, playerName) {
  const q = getQueue().filter(x => !(x.eventId===eventId && x.player===playerName));
  saveQueue(q);
  updateQueueBadge();
}

function updateQueueBadge() {
  const q = getQueue();
  const badge = document.getElementById('queueBadge');
  if (!badge) return;
  if (q.length > 0) {
    badge.textContent = `⏳ ${q.length}`;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}

async function flushQueue() {
  const q = getQueue();
  if (!q.length) return;
  let flushed = 0;
  for (const item of [...q]) {
    try {
      const res = await fetch(`${SERVER}/api/events/${item.eventId}/players/${encodeURIComponent(item.player)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ colors: item.colors }),
      });
      if (res.ok) { dequeue(item.eventId, item.player); flushed++; }
    } catch(e) { /* still offline */ }
  }
  if (flushed > 0) showToast(`${flushed} scouting(s) synchronisé(s) ✓`);
}

// Retry queue when connection is restored
window.addEventListener('online', () => {
  showToast('Connexion rétablie — synchronisation…');
  setTimeout(flushQueue, 1000);
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws = null;
let wsRetries = 0;

function connectWS() {
  if (ws && ws.readyState < 2) ws.close();
  ws = new WebSocket(WS_URL);
  ws.onopen  = () => { setPill(true); wsRetries = 0; flushQueue(); };
  ws.onclose = () => {
    setPill(false);
    wsRetries++;
    const delay = Math.min(1000 * Math.pow(1.5, wsRetries), 30000);
    setTimeout(connectWS, delay);
  };
  ws.onerror = () => {};
  ws.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'playerUpdate' && d.eventId === S.eventId) {
        if (!S.players[d.player]) S.players[d.player] = {};
        S.players[d.player].colors = d.colors;
        renderAll();
      }
      // Round streamed in from server background loader
      if (d.type === 'roundLoaded' && d.eventId === S.eventId) {
        const round = d.round;
        const idx = S.rounds.findIndex(r => r.num > round.num);
        if (idx === -1) S.rounds.push(round);
        else S.rounds.splice(idx, 0, round);
        // Auto-select first round when it arrives
        if (S.rounds.length === 1) S.currentRound = 0;
        renderPairings();
        showToast(`R${round.num} chargé — ${round.pairings.length} tables`);
      }
      if (d.type === 'roundsComplete' && d.eventId === S.eventId) {
        showToast('Tous les rounds chargés ✓');
      }
    } catch(err) {}
  };
}

function setPill(on) {
  const p = document.getElementById('wsPill');
  p.textContent = on ? '● live' : '●';
  p.className = 'ws-pill' + (on ? ' on' : '');
}

// ── Load event ────────────────────────────────────────────────────────────────
async function loadEvent(idOverride) {
  const raw = idOverride || document.getElementById('idInput').value.trim();
  const match = String(raw).match(/(\d{4,8})/);
  if (!match) return showToast('ID invalide', true);
  const id = match[1];
  S.eventId = id;
  document.getElementById('idInput').value = id;
  document.getElementById('idInput').blur();

  setScroll('pairings', `<div class="state-box"><div class="spinner"></div><span>Chargement…</span></div>`);
  switchScreen('pairings', document.querySelector('[data-screen="pairings"]'));

  try {
    const res = await fetch(`${SERVER}/api/events/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyData(await res.json());
  } catch(err) {
    setScroll('pairings', `<div class="err-box">Erreur: ${err.message}<br>Le serveur tourne-t-il ?</div>`);
  }
}

function applyData(data) {
  S.meta    = data.meta;
  S.players = data.players || {};
  S.rounds  = data.rounds  || [];
  S.currentRound = 0;
  // Build realNames map: displayName → real name (first name only for readability)
  S.realNames = {};
  if (data.realNames) {
    Object.assign(S.realNames, data.realNames);
  }
  standingsData = [];
  const pc = Object.keys(S.players).length;
  const sc = Object.values(S.players).filter(p=>p.colors?.length>0).length;
  localStorage.setItem('lorcana-last-event', S.eventId);
  addHistory(S.eventId, data.meta, pc, sc);
  renderAll();
  connectWS();
  flushQueue();
}

// ── Patch colors (with offline queue) ────────────────────────────────────────
async function patchColors(name, colors) {
  if (!S.players[name]) S.players[name] = {};
  S.players[name].colors = colors;
  renderAll();

  if (S.eventId) enqueue(S.eventId, name, colors);

  try {
    const res = await fetch(`${SERVER}/api/events/${S.eventId}/players/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ colors }),
    });
    if (res.ok) dequeue(S.eventId, name);
    else throw new Error('server error');
  } catch(e) {
    showToast('Hors ligne — scouting mis en attente ⏳');
  }

  // Tenter de résoudre les observations de table non identifiées
  if (colors.length > 0) {
    await tryResolveObsForPlayer(name);
  }
}

// ── Render all ────────────────────────────────────────────────────────────────
function renderAll() {
  renderPairings();
  renderRoster();
  if (S.activeScreen === 'colors') renderColors();
  renderStandings();
  if (S.eventId) {
    const sc = Object.values(S.players).filter(p=>p.colors?.length>0).length;
    updateHistoryScout(S.eventId, sc);
  }
}

// ── Screens ───────────────────────────────────────────────────────────────────
function switchScreen(name, btn) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  if (btn) btn.classList.add('active');
  S.activeScreen = name;
  if (name==='colors') renderColors();
  if (name==='history') renderHistory();
  if (name==='standings') {
    renderStandings();
    if (!standingsData.length && S.eventId) loadStandings();
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function setScroll(screen, html) {
  const map = {
    pairings:'pairingsScroll', roster:'rosterScroll',
    colors:'colorsScroll', history:'historyScroll', standings:'standingsScroll'
  };
  const el = document.getElementById(map[screen]);
  if (el) el.innerHTML = html;
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, err=false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err?' err':'');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2800);
}

// ── Init ──────────────────────────────────────────────────────────────────────
function initApp() {
  updateQueueBadge();
  renderHistory();
  // Delegation for sheet opening
  document.addEventListener('click', e => {
    const slotEl = e.target.closest('[data-open-sheet]');
    if (slotEl) { openSheet(slotEl.dataset.openSheet); return; }
    const row = e.target.closest('.roster-row');
    if (!row) return;
    const name = row.dataset.player;
    if (!name) return;
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    e.stopPropagation();
    if (action === 'open-sheet') openSheet(name);
    if (action === 'fav') toggleFav(name);
  });
  const lastEvent = localStorage.getItem('lorcana-last-event');
  if (lastEvent) {
    document.getElementById('idInput').value = lastEvent;
    loadEvent(lastEvent);
  }
}