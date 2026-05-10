const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const { JSDOM } = require('jsdom');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ── Auth config ───────────────────────────────────────────────────────────────
// Set PASSWORD env var to require a password. Leave empty to disable.
// A random one is generated at startup if not set, printed to console.
let APP_PASSWORD = process.env.PASSWORD || null;
if (!APP_PASSWORD) {
  APP_PASSWORD = crypto.randomBytes(3).toString('hex'); // e.g. "a3f9c2"
  console.log(`🔑 Password: ${APP_PASSWORD}  (set PASSWORD env var to fix it)`);
}

app.get('/api/auth/check', (_, res) => {
  res.json({ required: true, hint: '' });
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (password === APP_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

// ── In-memory store ──────────────────────────────────────────────────────────
const store = {};

// ── WebSocket broadcast ──────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(eventId, payload) {
  const msg = JSON.stringify({ eventId, ...payload });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}
wss.on('connection', ws => ws.send(JSON.stringify({ type: 'connected' })));

// ── Ravensburger Play REST API ────────────────────────────────────────────────
const API_BASE = 'https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2';
const API_PAGE_SIZE = 200;

const API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Content-Type': 'application/json',
  'Origin': 'https://tcg.ravensburgerplay.com',
  'Referer': 'https://tcg.ravensburgerplay.com/',
};

async function apiGet(path) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, { headers: API_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function apiGetAll(path) {
  const sep = path.includes('?') ? '&' : '?';
  const first = await apiGet(`${path}${sep}page=1&page_size=${API_PAGE_SIZE}`);
  const results = [...(first.results ?? [])];
  const total = first.total ?? results.length;
  const totalPages = Math.ceil(total / (first.page_size ?? API_PAGE_SIZE));
  for (let p = 2; p <= totalPages; p++) {
    const data = await apiGet(`${path}${sep}page=${p}&page_size=${API_PAGE_SIZE}`);
    results.push(...(data.results ?? []));
  }
  console.log(`  [api] ${path} → ${results.length}/${total}`);
  return results;
}

// ── HTML fallback ─────────────────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': API_HEADERS['User-Agent'], 'Accept': 'text/html', 'Referer': 'https://tcg.ravensburgerplay.com/' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Parse event data ──────────────────────────────────────────────────────────
function parseEventData(ev) {
  const meta = {
    title: ev.name || ev.title || '',
    location: ev.event_address_override || ev.full_address || '',
    date: ev.start_datetime ? ev.start_datetime.slice(0, 10) : '',
    players: String(ev.starting_player_count || ev.registered_user_count || ''),
  };

  const roundDefs = (ev.tournament_phases ?? [])
    .flatMap(phase => phase.rounds ?? [])
    .filter(r => r.round_type !== 'PLAYER_MEETING')
    .sort((a, b) => a.round_number - b.round_number)
    .map(r => ({ num: r.round_number, roundId: r.id, status: r.status, pairingsStatus: r.pairings_status }));

  return { meta, roundDefs };
}

// ── Name helpers ──────────────────────────────────────────────────────────────
function playerNameFromRegistration(reg) {
  return reg?.best_identifier || reg?.special_user_identifier || reg?.user?.best_identifier || null;
}

// Real name = user.best_identifier (e.g. "Julien B") — first name only for display
function realNameFromRegistration(reg) {
  const raw = reg?.user?.best_identifier || '';
  // Take first word (first name) if it looks like "Firstname L"
  const parts = raw.trim().split(/\s+/);
  return parts.length >= 2 ? parts[0] : raw;
}

function nameFromRelationship(rel) {
  return rel?.user_event_status?.best_identifier || rel?.player?.best_identifier || null;
}

// ── Match → pairing with result ───────────────────────────────────────────────
function pairingFromMatch(match, idx) {
  const rels = match?.player_match_relationships ?? [];
  const p1 = nameFromRelationship(rels[0]) || '';
  const p2 = nameFromRelationship(rels[1]) || '';
  if (!p1 || !p2) return null;

  const table = match?.table_number ?? (idx + 1);
  const isComplete = match?.status === 'COMPLETE';
  const isDraw = match?.match_is_intentional_draw || match?.match_is_unintentional_draw;
  const winnerId = match?.winning_player;

  let winner = null;
  if (isComplete) {
    if (isDraw) {
      winner = 'draw';
    } else if (winnerId != null) {
      const winnerRel = rels.find(r => r.player?.id === winnerId);
      if (winnerRel) winner = nameFromRelationship(winnerRel) === p1 ? 'p1' : 'p2';
    }
  }

  const gWW = match?.games_won_by_winner ?? null;
  const gWL = match?.games_won_by_loser ?? null;

  return { table, p1, p2, winner, gWW, gWL, isComplete };
}

// ── Load rounds ───────────────────────────────────────────────────────────────
async function loadRounds(roundDefs) {
  const rounds = [];
  for (const { num, roundId, pairingsStatus } of roundDefs) {
    if (pairingsStatus !== 'GENERATED') continue;
    try {
      const matches = await apiGetAll(`/tournament-rounds/${roundId}/matches/paginated`);
      const pairings = matches.map(pairingFromMatch).filter(Boolean);
      if (pairings.length > 0) {
        rounds.push({ num, pairings });
        console.log(`  [round ${num}] ${pairings.length} pairings`);
      }
    } catch (e) {
      console.warn(`  [round ${num}] failed: ${e.message}`);
    }
  }
  return rounds;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Serve cached data immediately (rounds included)
    if (store[id] && !req.query.refresh) return res.json(store[id]);
    console.log(`\n[event] Loading ${id}`);

    const ev = await apiGet(`/events/${id}`);
    const { meta, roundDefs } = parseEventData(ev);
    console.log(`[event] Meta:`, meta);

    const registrations = await apiGetAll(`/events/${id}/registrations`);
    console.log(`[event] ${registrations.length} registrations`);
    meta.players = String(registrations.length);

    const existing = store[id]?.players || {};
    const players = {};
    const realNames = {};

    registrations.forEach(reg => {
      const name = playerNameFromRegistration(reg);
      if (!name) return;
      players[name] = {
        ...(existing[name] || {}),
        colors: existing[name]?.colors || [],
        wins: reg.matches_won ?? 0,
        losses: reg.matches_lost ?? 0,
        draws: reg.matches_drawn ?? 0,
        points: reg.total_match_points ?? 0,
        rank: reg.final_place_in_standings ?? null,
      };
      const rn = realNameFromRegistration(reg);
      if (rn && rn !== name) realNames[name] = rn;
    });

    // Respond immediately with roster + meta, rounds = [] for now
    store[id] = { meta, players, realNames, rounds: [], eventId: id, loadedAt: new Date().toISOString() };
    res.json(store[id]);

    // Stream rounds in background via WebSocket
    loadRoundsStreaming(id, roundDefs);

  } catch (err) {
    console.error('[event error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Load rounds one by one, pushing each via WS as it arrives
async function loadRoundsStreaming(eventId, roundDefs) {
  const generated = roundDefs.filter(r => r.pairingsStatus === 'GENERATED');
  console.log(`[rounds] Streaming ${generated.length} rounds for event ${eventId}`);

  for (const { num, roundId } of generated) {
    try {
      const matches = await apiGetAll(`/tournament-rounds/${roundId}/matches/paginated`);
      const pairings = matches.map(pairingFromMatch).filter(Boolean);
      if (!pairings.length) continue;

      const round = { num, pairings };
      // Add to store in order
      if (!store[eventId]) continue;
      const rounds = store[eventId].rounds;
      const idx = rounds.findIndex(r => r.num > num);
      if (idx === -1) rounds.push(round);
      else rounds.splice(idx, 0, round);

      // Push to all WS clients watching this event
      broadcast(eventId, { type: 'roundLoaded', round });
      console.log(`  [round ${num}] pushed (${pairings.length} pairings)`);
    } catch (e) {
      console.warn(`  [round ${num}] failed: ${e.message}`);
    }
  }

  broadcast(eventId, { type: 'roundsComplete', eventId });
  console.log(`[rounds] All rounds streamed for event ${eventId}`);
}

app.patch('/api/events/:id/players/:playerName', (req, res) => {
  const { id, playerName } = req.params;
  const { colors } = req.body;
  const name = decodeURIComponent(playerName);
  if (!store[id]) return res.status(404).json({ error: 'Event not found' });
  if (!Array.isArray(colors) || colors.length > 2)
    return res.status(400).json({ error: 'colors must be array of max 2' });
  if (!store[id].players[name]) store[id].players[name] = {};
  store[id].players[name].colors = colors;
  broadcast(id, { type: 'playerUpdate', player: name, colors });
  res.json({ ok: true, player: name, colors });
});

app.get('/api/events/:id/colors', (req, res) => {
  const { id } = req.params;
  if (!store[id]) return res.status(404).json({ error: 'Event not loaded' });
  const result = Object.entries(store[id].players)
    .filter(([, d]) => d.colors && d.colors.length > 0)
    .map(([name, d]) => ({ name, colors: d.colors }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(result);
});

app.get('/api/events/:id/standings', async (req, res) => {
  const { id } = req.params;
  try {
    const registrations = await apiGetAll(`/events/${id}/registrations`);
    const standings = registrations
      .map(reg => {
        const name = playerNameFromRegistration(reg);
        if (!name) return null;
        return {
          rank: reg.final_place_in_standings ?? null,
          name,
          points: reg.total_match_points ?? 0,
          wins: reg.matches_won ?? 0,
          losses: reg.matches_lost ?? 0,
          draws: reg.matches_drawn ?? 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.rank != null && b.rank != null) return a.rank - b.rank;
        if (a.rank != null) return -1;
        if (b.rank != null) return 1;
        return b.points - a.points;
      });

    if (store[id]) {
      registrations.forEach(reg => {
        const name = playerNameFromRegistration(reg);
        if (!name || !store[id].players[name]) return;
        Object.assign(store[id].players[name], {
          wins: reg.matches_won ?? 0,
          losses: reg.matches_lost ?? 0,
          draws: reg.matches_drawn ?? 0,
          points: reg.total_match_points ?? 0,
          rank: reg.final_place_in_standings ?? null,
        });
      });
    }

    res.json(standings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/:id', async (req, res) => {
  const { id } = req.params;
  const endpoint = req.query.endpoint || `/events/${id}`;
  try { res.json(await apiGet(endpoint)); }
  catch (e) { res.status(500).json({ error: e.message, endpoint }); }
});

app.get('/api/health', (_, res) => res.json({ ok: true, events: Object.keys(store) }));

// ── Static files ──────────────────────────────────────────────────────────────
// Serve JS files from same directory
app.use(express.static(__dirname));

// Catch-all: serve index.html
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🟢 Lorcana Scout running on port ${PORT}`));