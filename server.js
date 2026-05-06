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

// ── HTML fallback ─────────────────────────────────────────────────────────────
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
  const isBye = match?.match_is_bye === true;
  const isDraw = match?.match_is_intentional_draw || match?.match_is_unintentional_draw;
  const winnerId = match?.winning_player; // user id of winner

  // Find which rel corresponds to winner
  let winner = null; // 'p1' | 'p2' | 'draw' | null
  if (isComplete) {
    if (isDraw) {
      winner = 'draw';
    } else if (winnerId != null) {
      const winnerRel = rels.find(r => r.player?.id === winnerId);
      if (winnerRel) {
        winner = nameFromRelationship(winnerRel) === p1 ? 'p1' : 'p2';
      }
    }
  }

  // Game scores
  const gWW = match?.games_won_by_winner ?? null;
  const gWL = match?.games_won_by_loser ?? null;

  return { table, p1, p2, winner, gWW, gWL, isComplete, isBye };
}

// ── Load rounds ───────────────────────────────────────────────────────────────
async function loadRounds(roundDefs) {
  const rounds = [];
  for (const { num, roundId, pairingsStatus } of roundDefs) {
    if (pairingsStatus !== 'GENERATED') {
      console.log(`  [round ${num}] pairings not generated yet, skipping`);
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

    const ev = await apiGet(`/events/${id}`);
    const { meta, roundDefs } = parseEventData(ev);
    console.log(`[event] Meta:`, meta);
    console.log(`[event] ${roundDefs.length} rounds defined`);

    const registrations = await apiGetAll(`/events/${id}/registrations`);
    const playerNames = [...new Set(registrations.map(playerNameFromRegistration).filter(Boolean))];
    console.log(`[event] ${playerNames.length} players`);
    meta.players = String(playerNames.length);

    // Build player map with stats from registrations
    const existing = store[id]?.players || {};
    const players = {};
    registrations.forEach(reg => {
      const name = playerNameFromRegistration(reg);
      if (!name) return;
      players[name] = {
        ...(existing[name] || {}),
        colors: existing[name]?.colors || [],
        // Store stats for display in the sheet
        wins: reg.matches_won ?? 0,
        losses: reg.matches_lost ?? 0,
        draws: reg.matches_drawn ?? 0,
        points: reg.total_match_points ?? 0,
        rank: reg.final_place_in_standings ?? null,
      };
    });

    const rounds = await loadRounds(roundDefs);
    console.log(`[event] ${rounds.length} rounds loaded`);

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

// Standings: built from player data already in store (populated at load time)
app.get('/api/events/:id/standings', async (req, res) => {
  const { id } = req.params;
  try {
    // Refresh from API to get latest stats
    const registrations = await apiGetAll(`/events/${id}/registrations`);
    const standings = registrations
      .map((reg, idx) => {
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
        // Sort by rank if available, else by points desc
        if (a.rank != null && b.rank != null) return a.rank - b.rank;
        if (a.rank != null) return -1;
        if (b.rank != null) return 1;
        return b.points - a.points;
      });

    // Also update the in-memory store with fresh stats
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

const path = require('path');
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🟢 Lorcana Scout running on port ${PORT}`));
