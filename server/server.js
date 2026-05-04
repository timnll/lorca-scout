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

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true, events: Object.keys(store) }));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🟢 Lorcana Scout server running on http://localhost:${PORT}`));
