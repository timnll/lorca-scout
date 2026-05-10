// ── Roster ────────────────────────────────────────────────────────────────────
function favsKey() { return `lorcana-favs-${S.eventId||'_'}`; }
function getFavs() { try { return JSON.parse(localStorage.getItem(favsKey())||'[]'); } catch { return []; } }
function saveFavs(f) { localStorage.setItem(favsKey(), JSON.stringify(f)); }
function isFav(name) { return getFavs().includes(name); }
function toggleFav(name) {
  const favs = getFavs();
  const idx = favs.indexOf(name);
  if (idx>=0) favs.splice(idx,1); else favs.push(name);
  saveFavs(favs);
  renderRoster();
  renderStandings();
}

function renderRoster() {
  const pc = Object.keys(S.players).length;
  const sc = Object.values(S.players).filter(p=>p.colors?.length>0).length;
  document.getElementById('rosterCount').textContent = pc ? `${pc} joueurs · ${sc} scouttés` : '—';

  const q = (document.getElementById('searchInput')?.value||'').toLowerCase();
  const entries = Object.entries(S.players)
    .filter(([n])=>n.toLowerCase().includes(q)||(S.realNames[n]||'').toLowerCase().includes(q))
    .sort(([a],[b])=>a.localeCompare(b));

  if (!entries.length) { setScroll('roster', '<div class="state-box">Aucun joueur</div>'); return; }

  const html = entries.map(([name, data]) => {
    const colors = data.colors||[];
    const sc = colors.length > 0;
    const fav = isFav(name);
    const realName = S.realNames[name] || '';
    const dots = colors.map(cid=>{
      const c=COLORS.find(x=>x.id===cid);
      return c?`<div class="rc-dot" style="background:${c.hex}"></div>`:'';
    }).join('');
    const starSvg = fav
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="1.5"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>`;
    return `<div class="roster-row${sc?' scouted':''}" data-player="${esc(name)}">
      <div class="roster-top" data-action="open-sheet">
        <button class="fav-btn${fav?' on':''}" title="Favori" onclick="event.stopPropagation();toggleFav(this.closest('.roster-row').dataset.player)">${starSvg}</button>
        <div class="rn-wrap">
          <div class="rn">${esc(name)}</div>
          ${realName ? `<div class="rn-real">${esc(realName)}</div>` : ''}
        </div>
        <div class="rc">${dots}</div>
      </div>
    </div>`;
  }).join('');
  setScroll('roster', html);
}

// ── Colors ────────────────────────────────────────────────────────────────────
function renderColors() {
  const allPlayers = Object.entries(S.players);
  const total = allPlayers.length;
  const withColors = allPlayers.filter(([,d])=>d.colors&&d.colors.length>0);
  const sc = withColors.length;
  const unknown = total - sc;
  document.getElementById('colorsCount').textContent = sc ? `${sc} / ${total} scouttés` : '—';

  if (!withColors.length) {
    setScroll('colors', '<div class="state-box">Aucune couleur renseignée</div>');
    return;
  }

  const groups = {};
  withColors.forEach(([name, data]) => {
    const key = [...data.colors].sort().join('+');
    if (!groups[key]) groups[key] = { colors: data.colors, players: [] };
    groups[key].players.push(name);
  });

  const allPairings = S.rounds.flatMap(r => r.pairings || []);
  const completedPairings = allPairings.filter(p => p.isComplete && p.winner && p.winner !== 'draw');
  const drawnPairings = allPairings.filter(p => p.isComplete && p.winner === 'draw');

  const playerColorKey = {};
  withColors.forEach(([name, data]) => { playerColorKey[name] = [...data.colors].sort().join('+'); });

  const groupStats = {};
  Object.keys(groups).forEach(k => { groupStats[k] = { w: 0, l: 0, d: 0 }; });

  completedPairings.forEach(p => {
    const k1 = playerColorKey[p.p1], k2 = playerColorKey[p.p2];
    if (p.winner === 'p1') { if (k1 && groupStats[k1]) groupStats[k1].w++; if (k2 && groupStats[k2]) groupStats[k2].l++; }
    else if (p.winner === 'p2') { if (k2 && groupStats[k2]) groupStats[k2].w++; if (k1 && groupStats[k1]) groupStats[k1].l++; }
  });
  drawnPairings.forEach(p => {
    const k1 = playerColorKey[p.p1], k2 = playerColorKey[p.p2];
    if (k1 && groupStats[k1]) groupStats[k1].d++;
    if (k2 && groupStats[k2]) groupStats[k2].d++;
  });

  const sorted = Object.entries(groups).sort(([ka,a],[kb,b]) => {
    const sa=groupStats[ka], sb=groupStats[kb];
    const tA=sa.w+sa.l+sa.d, tB=sb.w+sb.l+sb.d;
    const wrA=tA?sa.w/tA:-1, wrB=tB?sb.w/tB:-1;
    if (wrA!==wrB) return wrB-wrA;
    return b.players.length-a.players.length;
  });

  const maxWR = Math.max(...sorted.map(([k])=>{const s=groupStats[k];const t=s.w+s.l+s.d;return t?s.w/t:0;}),0.01);
  const pct = v => total ? Math.round(v/total*100) : 0;
  const unknownPill = unknown>0?`<div class="colors-summary-pill unknown">❓ ${unknown} non renseignés (${pct(unknown)}%)</div>`:'';

  function barColor(wr) { return wr>=0.6?'var(--success)':wr>=0.45?'var(--accent)':'var(--danger)'; }

  const html = sorted.map(([key,g]) => {
    const dots = g.colors.map(cid=>{const c=COLORS.find(x=>x.id===cid);return c?`<div class="cdot" style="background:${c.hex};width:14px;height:14px"></div>`:''}).join('');
    const labels = g.colors.map(cid=>COLORS.find(x=>x.id===cid)?.label||cid).join(' + ');
    const groupPct = pct(g.players.length);
    const st=groupStats[key], totalM=st.w+st.l+st.d;
    const wr=totalM?st.w/totalM:null, wrPct=wr!=null?Math.round(wr*100):null;
    const barW=wr!=null?Math.round((wr/maxWR)*100):0;

    const winbarHtml = totalM>0
      ? `<div class="combo-winbar-wrap">
          <div class="combo-winbar-label">
            <span class="combo-winbar-record">${st.w}V · ${st.l}D · ${st.d}N sur ${totalM} matchs</span>
            <span class="combo-winrate-val">${wrPct}% victoires</span>
          </div>
          <div class="combo-winbar-track"><div class="combo-winbar-fill" style="width:${barW}%;background:${barColor(wr)}"></div></div>
        </div>`
      : `<div class="combo-winbar-wrap"><div class="combo-winbar-label"><span class="combo-winbar-record">Aucun match terminé renseigné</span></div></div>`;

    const players = g.players.map(n=>{
      const pd=S.players[n]||{};
      const rec=pd.wins!=null?`${pd.wins}V-${pd.losses}D`:'';
      return `<div class="combo-player" data-open-sheet="${esc(n)}">
        <span class="combo-player-name">${esc(n)}</span>
        ${rec?`<span class="combo-player-rec">${rec}</span>`:''}
      </div>`;
    }).join('');

    return `<div class="combo-group">
      <div class="combo-header"><div class="combo-header-left">${dots}<span class="combo-label">${labels}</span></div><span class="combo-count">${g.players.length}× · ${groupPct}%</span></div>
      ${winbarHtml}
      <div class="combo-players">${players}</div>
    </div>`;
  }).join('');

  const summaryHtml = `<div class="colors-summary">${unknownPill}${sorted.map(([key,g])=>{
    const st=groupStats[key],tm=st.w+st.l+st.d,wr=tm?Math.round(st.w/tm*100):null;
    const dots=g.colors.map(cid=>{const c=COLORS.find(x=>x.id===cid);return c?`<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.hex};margin-right:2px"></span>`:''}).join('');
    return `<div class="colors-summary-pill">${dots}${wr!=null?wr+'%':'?'}</div>`;
  }).join('')}</div>`;

  setScroll('colors', summaryHtml+html);
}

// ── Standings ─────────────────────────────────────────────────────────────────
let standingsData = [];
let standingsFilter = 'favs';

async function loadStandings() {
  if (!S.eventId) return;
  setScroll('standings', `<div class="state-box"><div class="spinner"></div><span>Chargement standings…</span></div>`);
  try {
    const res = await fetch(`${SERVER}/api/events/${S.eventId}/standings`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    standingsData = Array.isArray(raw) ? raw : (raw.standings||[]);
    renderStandings();
  } catch(err) {
    setScroll('standings', `<div class="err-box">Impossible de charger les standings.<br>${err.message}</div>`);
  }
}

function setStandingsFilter(f, el) {
  standingsFilter = f;
  document.querySelectorAll('.filter-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  renderStandings();
}

function renderStandings() {
  if (!S.eventId) { setScroll('standings', `<div class="state-box">Charge un événement pour commencer</div>`); return; }
  const favs = getFavs();
  let data = standingsData;
  const sub = data.length ? `${data.length} joueurs` : (S.eventId?`Tournoi #${S.eventId}`:'—');
  document.getElementById('standingsSub').textContent = sub;

  if (standingsFilter==='favs') {
    if (!favs.length) { setScroll('standings', `<div class="standings-no-favs">Aucun favori.<br>Ajoute des joueurs en favori<br>depuis l'onglet <b>Roster</b> avec ⭐</div>`); return; }
    if (!data.length) { setScroll('standings', favs.map(name=>standingCard(name,null,favs)).join('')); return; }
    data = data.filter(s=>favs.includes(s.name));
    if (!data.length) { setScroll('standings', `<div class="standings-no-favs">Aucun de tes favoris<br>n'apparaît dans ce standings.</div>`); return; }
  }
  if (!data.length) { setScroll('standings', `<div class="state-box">Pas de standings disponibles.<br><span style="font-size:11px;line-height:1.8">Appuie sur ↻ Refresh en cours de ronde.</span></div>`); return; }
  setScroll('standings', data.map(s=>standingCard(s.name,s,favs)).join(''));
}

function standingCard(name, s, favs) {
  const isFavPlayer = favs.includes(name);
  const p = S.players[name]||{colors:[]};
  const realName = S.realNames[name]||'';
  const dots=(p.colors||[]).map(cid=>{const c=COLORS.find(x=>x.id===cid);return c?`<div class="cdot" style="background:${c.hex};width:11px;height:11px"></div>`:''}).join('');
  const rank=s?.rank??'—', pts=s?.points??'—';
  const rec=s?`${s.wins||0}W-${s.losses||0}L${s.draws?'-'+s.draws+'D':''}`: '';
  const rankClass=rank===1?'rank-top1':rank===2?'rank-top2':rank===3?'rank-top3':'';
  return `<div class="standing-card${isFavPlayer?' fav':''}" data-open-sheet="${esc(name)}">
    <div class="standing-rank"><div class="rank-num ${rankClass}">${rank}</div></div>
    <div class="standing-body">
      <div class="standing-name">${esc(name)}</div>
      ${realName?`<div class="standing-realname">${esc(realName)}</div>`:''}
      <div class="standing-stats">${rec?`<span>${rec}</span>`:''} ${dots?`<div class="standing-colors">${dots}</div>`:''}</div>
    </div>
    <div class="standing-right"><div class="standing-pts">${pts}</div><div class="standing-pts-label">pts</div></div>
  </div>`;
}

// ── Sheet ─────────────────────────────────────────────────────────────────────
function openSheet(name) {
  S.sheetPlayer = name;
  S.sheetColors = [...(S.players[name]?.colors||[])];
  const realName = S.realNames[name]||'';
  document.getElementById('sheetName').textContent = name;
  document.getElementById('sheetRealName').textContent = realName;
  document.getElementById('sheetRealName').style.display = realName ? 'block' : 'none';
  renderSheet();
  document.getElementById('sheetOverlay').classList.add('open');
}

function renderSheet() {
  document.getElementById('sheetHint').textContent =
    S.sheetColors.length ? `Sélectionné: ${S.sheetColors.map(id=>COLORS.find(c=>c.id===id)?.label||id).join(' + ')}` :
    'Sélectionne jusqu\'à 2 couleurs';

  const p = S.players[S.sheetPlayer]||{};
  const statsEl = document.getElementById('sheetStats');
  if (statsEl) {
    const hasStats = p.wins!=null||p.points!=null;
    if (hasStats) {
      const w=p.wins??0,l=p.losses??0,d=p.draws??0,pts=p.points??0;
      const rankStr=p.rank!=null?`<div class="sheet-stat">🏆 <strong>#${p.rank}</strong></div>`:'';
      statsEl.innerHTML=`${rankStr}<div class="sheet-stat"><strong>${w}W-${l}L${d>0?'-'+d+'D':''}</strong></div><div class="sheet-stat"><strong>${pts}</strong> pts</div>`;
      statsEl.style.display='flex';
    } else { statsEl.style.display='none'; }
  }

  document.getElementById('sheetColors').innerHTML = COLORS.map(c=>{
    const sel=S.sheetColors.includes(c.id);
    return `<div class="sheet-color-btn${sel?' sel':''}" style="--c:${c.hex}" onclick="toggleSheet('${c.id}')">
      <div class="sc-circle" style="background:${c.hex}"></div>
      <div class="sc-label">${c.label}</div>
    </div>`;
  }).join('');
}

function toggleSheet(id) {
  const idx=S.sheetColors.indexOf(id);
  if(idx>=0) S.sheetColors.splice(idx,1);
  else if(S.sheetColors.length<2) S.sheetColors.push(id);
  else { S.sheetColors.shift(); S.sheetColors.push(id); }
  renderSheet();
}

function clearSheet() { S.sheetColors=[]; saveSheet(); }

async function saveSheet() {
  document.getElementById('sheetOverlay').classList.remove('open');
  if (!S.sheetPlayer||!S.eventId) return;
  await patchColors(S.sheetPlayer, [...S.sheetColors]);
}

function closeSheet(e) {
  if (e.target===document.getElementById('sheetOverlay'))
    document.getElementById('sheetOverlay').classList.remove('open');
}

// ── History ───────────────────────────────────────────────────────────────────
const HKEY = 'lorcana-scout-history';
function getHistory() { try { return JSON.parse(localStorage.getItem(HKEY)||'[]'); } catch { return []; } }
function saveHistory(h) { localStorage.setItem(HKEY, JSON.stringify(h)); }

function addHistory(id, meta, pc, sc) {
  const h = getHistory().filter(e=>e.id!==id);
  h.unshift({ id, name:meta?.title||`Tournoi #${id}`, location:meta?.location||'', players:pc, scouted:sc, at:Date.now() });
  saveHistory(h.slice(0,20));
  renderHistory();
}

function updateHistoryScout(id, sc) {
  const h=getHistory(); const e=h.find(x=>x.id===id);
  if(e){e.scouted=sc;saveHistory(h);renderHistory();}
}

function renderHistory() {
  const h=getHistory();
  const el=document.getElementById('historyScroll');
  if(!h.length){el.innerHTML='<div class="state-box">Aucun tournoi chargé</div>';return;}
  el.innerHTML=h.map(e=>`
    <div class="history-item${S.eventId===e.id?' current':''}" onclick="loadEvent('${e.id}')">
      <div class="hi-id">#${e.id}</div>
      <div class="hi-name">${esc(e.name)}</div>
      <div class="hi-meta">
        <span>${e.players||0} joueurs</span>
        ${e.scouted?`<span class="hi-scouted">↳ ${e.scouted} scouttés</span>`:''}
      </div>
    </div>`).join('')
  +`<button class="hi-clear-btn" onclick="clearHistory()">🗑 Vider l'historique</button>`;
}

function clearHistory() {
  if(confirm('Vider l\'historique ?')){localStorage.removeItem(HKEY);renderHistory();}
}