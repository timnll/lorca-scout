const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const { JSDOM } = require('jsdom');

const app = express();
app.use(cors());
app.use(express.json());

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

// ── HTML fallback for metadata ────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': API_HEADERS['User-Agent'], 'Accept': 'text/html', 'Referer': 'https://tcg.ravensburgerplay.com/' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function extractTitleFromHTML(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  return doc.querySelector('h1')?.textContent?.trim() ||
    doc.querySelector('title')?.textContent?.replace(/Event Details?\s*\|\s*/i, '').trim() || '';
}

// ── Parse event data ──────────────────────────────────────────────────────────

/**
 * Extract metadata + round definitions from GET /events/:id
 * Rounds come from tournament_phases[].rounds[], skipping round_type=PLAYER_MEETING
 */
function parseEventData(ev) {
  const meta = {
    title: ev.name || ev.title || '',
    location: ev.event_address_override || ev.full_address || '',
    date: ev.start_datetime ? ev.start_datetime.slice(0, 10) : '',
    players: String(ev.starting_player_count || ev.registered_user_count || ''),
  };

  // Flatten all rounds from all phases, sorted by round_number, skip PLAYER_MEETING
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

function nameFromRelationship(rel) {
  // user_event_status.best_identifier = in-game pseudo (e.g. "TacPlay", "[EC] KaraNyyan")
  return rel?.user_event_status?.best_identifier || rel?.player?.best_identifier || null;
}

function pairingFromMatch(match, idx) {
  const rels = match?.player_match_relationships ?? [];
  const p1 = nameFromRelationship(rels[0]) || '';
  const p2 = nameFromRelationship(rels[1]) || '';
  if (!p1 || !p2) return null; // skip byes
  return { table: match?.table_number ?? (idx + 1), p1, p2 };
}

function standingFromRegistration(reg, idx) {
  const name = reg?.best_identifier || reg?.user?.best_identifier || '';
  if (!name) return null;
  if (reg.total_match_points === 0 && reg.matches_won === 0 && reg.matches_lost === 0) return null;
  return {
    rank: reg.final_place_in_standings ?? (idx + 1),
    name,
    points: reg.total_match_points ?? null,
    wins: reg.matches_won ?? null,
    losses: reg.matches_lost ?? null,
    draws: reg.matches_drawn ?? 0,
  };
}

// ── Load rounds ───────────────────────────────────────────────────────────────
async function loadRounds(roundDefs) {
  const rounds = [];

  for (const { num, roundId, status, pairingsStatus } of roundDefs) {
    // Skip rounds with no pairings yet
    if (pairingsStatus !== 'GENERATED') {
      console.log(`  [round ${num}] pairings not generated yet (${pairingsStatus}), skipping`);
      continue;
    }

    try {
      const matches = await apiGetAll(`/tournament-rounds/${roundId}/matches/paginated`);
      const pairings = matches.map(pairingFromMatch).filter(Boolean);
      if (pairings.length > 0) {
        rounds.push({ num, pairings });
        console.log(`  [round ${num}] ${pairings.length} pairings (roundId=${roundId})`);
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
    if (store[id] && !req.query.refresh) return res.json(store[id]);
    console.log(`\n[event] Loading ${id}`);

    // 1. Event data (meta + round definitions)
    const ev = await apiGet(`/events/${id}`);
    const { meta, roundDefs } = parseEventData(ev);
    console.log(`[event] Meta:`, meta);
    console.log(`[event] ${roundDefs.length} rounds defined:`, roundDefs.map(r => `R${r.num}(${r.roundId})`).join(', '));

    // 2. Registrations (full roster)
    const registrations = await apiGetAll(`/events/${id}/registrations`);
    const playerNames = [...new Set(registrations.map(playerNameFromRegistration).filter(Boolean))];
    console.log(`[event] ${playerNames.length} players`);
    meta.players = String(playerNames.length);

    // 3. Rounds with pairings
    const rounds = await loadRounds(roundDefs);
    console.log(`[event] ${rounds.length} rounds loaded`);

    // 4. Players map (preserve existing colors)
    const existing = store[id]?.players || {};
    const players = {};
    playerNames.forEach(name => { players[name] = existing[name] || { colors: [] }; });

    store[id] = { meta, players, rounds, eventId: id, loadedAt: new Date().toISOString() };
    res.json(store[id]);
  } catch (err) {
    console.error('[event error]', err);
    res.status(500).json({ error: err.message });
  }
});

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

// Standings: derived from registrations (has final_place_in_standings + stats)
app.get('/api/events/:id/standings', async (req, res) => {
  const { id } = req.params;
  try {
    const registrations = await apiGetAll(`/events/${id}/registrations`);
    const standings = registrations
      .map(standingFromRegistration)
      .filter(Boolean)
      .sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
    res.json({ standings, latestRound: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: inspect any API endpoint
app.get('/api/debug/:id', async (req, res) => {
  const { id } = req.params;
  const endpoint = req.query.endpoint || `/events/${id}`;
  try {
    res.json(await apiGet(endpoint));
  } catch (e) {
    res.status(500).json({ error: e.message, endpoint });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true, events: Object.keys(store) }));

const path = require('path');
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🟢 Lorcana Scout running on port ${PORT}`));
