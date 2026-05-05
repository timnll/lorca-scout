const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const { JSDOM } = require('jsdom');

const app = express();
app.use(cors());
app.use(express.json());

// ── In-memory store ──────────────────────────────────────────────────────────
// Structure: { [eventId]: { meta, players: { [name]: { colors: [] } }, rounds: [] } }
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

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'connected' }));
});

// ── Scraping helpers ─────────────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LorcanaScouter/1.0)',
      'Accept': 'text/html'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extractPlayersFromHTML(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const names = [];
  // Player names are in <h4> tags inside the roster/pairing cards
  doc.querySelectorAll('h4').forEach(h4 => {
    const name = h4.textContent.trim();
    if (name && !name.startsWith('User') || name.match(/User\d+/)) {
      // keep real names, skip generic User* if they have no real display
    }
    if (name) names.push(name);
  });
  return [...new Set(names)];
}

function extractPairings(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const pairings = [];
  // Pairings are typically in table rows or pairing cards
  const tables = doc.querySelectorAll('table tbody tr, [class*="pairing"]');
  tables.forEach((row, idx) => {
    const cells = row.querySelectorAll('td, [class*="player"]');
    if (cells.length >= 2) {
      const p1 = cells[0]?.textContent?.trim();
      const p2 = cells[1]?.textContent?.trim();
      if (p1 && p2) pairings.push({ table: idx + 1, p1, p2 });
    }
  });
  return pairings;
}

function extractTotalPages(html) {
  const match = html.match(/Page\s+\d+\s+of\s+(\d+)/i);
  return match ? parseInt(match[1]) : 1;
}

function extractEventMeta(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const title = doc.querySelector('title')?.textContent?.replace('Event Details | ', '') || '';
  // Look for date, location
  const h1 = doc.querySelector('h1')?.textContent?.trim() || '';
  const texts = [...doc.querySelectorAll('p, span, div')].map(el => el.textContent.trim()).filter(t => t.length > 3 && t.length < 100);
  const location = texts.find(t => t.includes('France') || t.includes('Paris') || t.includes('Bordeaux') || t.includes('Lyon')) || '';
  const date = texts.find(t => t.match(/\d{4}/) && t.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)) || '';
  const players = html.match(/(\d+)\s*(?:\/\d+\s*)?players?/i)?.[0] || '';
  return { title: h1 || title, location, date, players };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Load event: scrape all pages of roster + available pairings
app.get('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const baseUrl = `https://tcg.ravensburgerplay.com/events/${id}`;

  try {
    // If already loaded, return cached (but still allow refresh via query param)
    if (store[id] && !req.query.refresh) {
      return res.json(store[id]);
    }

    // Page 1
    const html1 = await fetchPage(baseUrl);
    const totalPages = extractTotalPages(html1);
    const meta = extractEventMeta(html1);
    let allPlayers = extractPlayersFromHTML(html1);

    // Remaining pages
    for (let p = 2; p <= Math.min(totalPages, 30); p++) {
      try {
        const html = await fetchPage(`${baseUrl}?page=${p}`);
        allPlayers = allPlayers.concat(extractPlayersFromHTML(html));
      } catch (e) {
        console.warn(`Page ${p} failed:`, e.message);
        break;
      }
    }
    allPlayers = [...new Set(allPlayers)].filter(n => n.length > 0);

    // Try to get pairings for rounds 1–9
    const rounds = [];
    for (let r = 1; r <= 9; r++) {
      try {
        const rHtml = await fetchPage(`${baseUrl}/rounds/${r}`);
        const pairings = extractPairings(rHtml);
        if (pairings.length > 0) {
          rounds.push({ num: r, pairings });
        }
      } catch (e) {
        // No more rounds
        break;
      }
    }

    // Initialize players (preserve existing color data)
    const existing = store[id]?.players || {};
    const players = {};
    allPlayers.forEach(name => {
      players[name] = existing[name] || { colors: [] };
    });

    store[id] = { meta, players, rounds, eventId: id, loadedAt: new Date().toISOString() };
    res.json(store[id]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Update colors for a player
app.patch('/api/events/:id/players/:playerName', (req, res) => {
  const { id, playerName } = req.params;
  const { colors } = req.body;
  const name = decodeURIComponent(playerName);

  if (!store[id]) return res.status(404).json({ error: 'Event not found' });
  if (!Array.isArray(colors) || colors.length > 2) {
    return res.status(400).json({ error: 'colors must be array of max 2' });
  }

  if (!store[id].players[name]) store[id].players[name] = {};
  store[id].players[name].colors = colors;

  // Broadcast to all WS clients
  broadcast(id, { type: 'playerUpdate', player: name, colors });

  res.json({ ok: true, player: name, colors });
});

// Get all color data (full listing)
app.get('/api/events/:id/colors', (req, res) => {
  const { id } = req.params;
  if (!store[id]) return res.status(404).json({ error: 'Event not loaded' });
  const result = Object.entries(store[id].players)
    .filter(([, d]) => d.colors && d.colors.length > 0)
    .map(([name, d]) => ({ name, colors: d.colors }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(result);
});

// Get standings (last available round)
app.get('/api/events/:id/standings', async (req, res) => {
  const { id } = req.params;
  const baseUrl = `https://tcg.ravensburgerplay.com/events/${id}`;

  try {
    // Try to find the latest standings page
    let standings = [];
    let latestRound = 0;

    for (let r = 1; r <= 12; r++) {
      try {
        const html = await fetchPage(`${baseUrl}/standings/${r}`);
        const parsed = parseStandings(html, r);
        if (parsed.length > 0) {
          standings = parsed;
          latestRound = r;
        } else {
          break;
        }
      } catch(e) {
        break;
      }
    }

    // Fallback: try /standings without round
    if (!standings.length) {
      try {
        const html = await fetchPage(`${baseUrl}/standings`);
        standings = parseStandings(html, null);
      } catch(e) {}
    }

    res.json(standings);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

function parseStandings(html, round) {
  const standings = [];

  // Next.js injects all page data in a <script id="__NEXT_DATA__"> tag
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      // Navigate the props tree — structure varies but standings are usually in pageProps
      const props = nextData?.props?.pageProps;
      const rawStandings =
        props?.standings ||
        props?.standingsData ||
        props?.event?.standings ||
        props?.data?.standings ||
        findDeep(props, 'standings');

      if (Array.isArray(rawStandings) && rawStandings.length > 0) {
        rawStandings.forEach((s, idx) => {
          const name = s.displayName || s.username || s.name || s.player?.displayName || s.player?.username || '';
          if (!name) return;
          standings.push({
            rank: s.rank ?? s.position ?? (idx + 1),
            name,
            points: s.points ?? s.matchPoints ?? s.score ?? null,
            wins: s.wins ?? s.matchWins ?? null,
            losses: s.losses ?? s.matchLosses ?? null,
            draws: s.draws ?? s.matchDraws ?? 0,
            round,
          });
        });
        if (standings.length > 0) return standings;
      }
    } catch(e) {
      console.warn('__NEXT_DATA__ parse error:', e.message);
    }
  }

  // Fallback: try standard HTML table parsing
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const rows = doc.querySelectorAll('table tbody tr');
  rows.forEach((row, idx) => {
    const cells = [...row.querySelectorAll('td')];
    if (cells.length < 2) return;
    const texts = cells.map(c => c.textContent.trim());
    const rankVal = parseInt(texts[0]);
    if (isNaN(rankVal)) return;
    const name = texts[1];
    const points = texts.slice(2).map(t => parseInt(t)).find(n => !isNaN(n) && n <= 100) ?? null;
    const recordText = texts.find(t => t.match(/^\d+-\d+/)) || '';
    const recMatch = recordText.match(/(\d+)-(\d+)(?:-(\d+))?/);
    if (name) {
      standings.push({
        rank: rankVal, name, points,
        wins: recMatch ? parseInt(recMatch[1]) : null,
        losses: recMatch ? parseInt(recMatch[2]) : null,
        draws: recMatch ? parseInt(recMatch[3]) || 0 : null,
        round,
      });
    }
  });

  return standings;
}

// Helper: recursively find a key in an object
function findDeep(obj, key, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findDeep(item, key, depth + 1);
      if (r) return r;
    }
  } else {
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
      const r = findDeep(v, key, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true, events: Object.keys(store) }));

// Sert le client HTML pour toutes les routes non-API
const path = require('path');
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🟢 Lorcana Scout running on port ${PORT}`));
