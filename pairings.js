// ── Pairings ──────────────────────────────────────────────────────────────────

let pairingsSearch = '';

// ── Table observations store ──────────────────────────────────────────────────
// Stocke les couleurs *observées sur la table*, sans les associer aux pseudos.
// { [obsKey]: { roundNum, table, p1, p2, c1: [], c2: [], resolved: false } }
// c1/c2 = couleurs du "joueur A" / "joueur B" (côtés arbitraires)
//
// La déduction se fait en croisant ces obs avec les scoutings directs :
// Si p1 est scouttée ambre+rubis dans un autre round, et qu'on voit ambre+rubis
// en c1 sur cette table → p1=c1, p2=c2, on scoutte automatiquement.

const OBS_KEY = 'lorcana-obs';
function getObs()   { try { return JSON.parse(localStorage.getItem(OBS_KEY)||'{}'); } catch { return {}; } }
function saveObs(d) { localStorage.setItem(OBS_KEY, JSON.stringify(d)); }
function obsKey(roundNum, table) { return `${S.eventId}-R${roundNum}-T${table}`; }

function getTableObs(roundNum, table) {
  return getObs()[obsKey(roundNum, table)] || { c1: [], c2: [], resolved: false };
}
function saveTableObs(roundNum, table, data) {
  const all = getObs();
  all[obsKey(roundNum, table)] = { ...data, roundNum, table };
  saveObs(all);
}

// ── Déduction ─────────────────────────────────────────────────────────────────
// known = couleurs scouttées du joueur, observed = couleurs vues sur la table
// Match si toutes les couleurs connues sont dans l'observation (scout peut être partiel)
function colorsMatch(known, observed) {
  if (!known.length || !observed.length) return false;
  return known.every(c => observed.includes(c));
}

/**
 * Tente de résoudre qui joue quoi pour un pairing donné.
 * Retourne { p1: {name, colors}|null, p2: {name, colors}|null, confidence } ou null.
 */
function tryResolve(p1name, p2name, obs) {
  const { c1, c2 } = obs;
  const p1col = S.players[p1name]?.colors || [];
  const p2col = S.players[p2name]?.colors || [];

  // Les deux slots renseignés
  if (c1.length && c2.length) {
    if (colorsMatch(p1col, c1) && colorsMatch(p2col, c2))
      return { p1: {name:p1name, colors:c1}, p2: {name:p2name, colors:c2}, confidence:'high' };
    if (colorsMatch(p1col, c2) && colorsMatch(p2col, c1))
      return { p1: {name:p1name, colors:c2}, p2: {name:p2name, colors:c1}, confidence:'high' };
    // Un seul joueur connu
    if (colorsMatch(p1col, c1) && !p2col.length)
      return { p1: {name:p1name, colors:c1}, p2: {name:p2name, colors:c2}, confidence:'medium' };
    if (colorsMatch(p1col, c2) && !p2col.length)
      return { p1: {name:p1name, colors:c2}, p2: {name:p2name, colors:c1}, confidence:'medium' };
    if (colorsMatch(p2col, c2) && !p1col.length)
      return { p1: {name:p1name, colors:c1}, p2: {name:p2name, colors:c2}, confidence:'medium' };
    if (colorsMatch(p2col, c1) && !p1col.length)
      return { p1: {name:p1name, colors:c2}, p2: {name:p2name, colors:c1}, confidence:'medium' };
  }

  // Un seul slot renseigné
  if (c1.length && !c2.length) {
    if (colorsMatch(p1col, c1)) return { p1: {name:p1name, colors:c1}, p2: null, confidence:'medium' };
    if (colorsMatch(p2col, c1)) return { p1: null, p2: {name:p2name, colors:c1}, confidence:'medium' };
  }
  if (!c1.length && c2.length) {
    if (colorsMatch(p2col, c2)) return { p1: null, p2: {name:p2name, colors:c2}, confidence:'medium' };
    if (colorsMatch(p1col, c2)) return { p1: null, p2: {name:p1name, colors:c2}, confidence:'medium' };
  }

  return null;
}

/**
 * Appelée après chaque scouting direct d'un joueur.
 * Parcourt toutes les observations non résolues pour voir si ce nouveau
 * scouting permet d'identifier les joueurs d'une table précédente.
 */
async function tryResolveObsForPlayer(playerName) {
  const obs = getObs();

  for (const [key, o] of Object.entries(obs)) {
    if (o.resolved) continue;
    if (!key.startsWith(S.eventId + '-')) continue;
    if (!o.roundNum || !o.table) continue;

    // Ce joueur est-il dans ce pairing ?
    const round = S.rounds.find(r => r.num === o.roundNum);
    if (!round) continue;
    const pairing = round.pairings.find(p => p.table === o.table);
    if (!pairing) continue;
    if (pairing.p1 !== playerName && pairing.p2 !== playerName) continue;

    const resolved = tryResolve(pairing.p1, pairing.p2, o);
    if (!resolved) continue;

    let applied = false;
    // N'appliquer que si le joueur n'a pas encore de couleurs
    if (resolved.p1?.colors?.length && !(S.players[resolved.p1.name]?.colors?.length)) {
      await patchColors(resolved.p1.name, resolved.p1.colors);
      applied = true;
    }
    if (resolved.p2?.colors?.length && !(S.players[resolved.p2.name]?.colors?.length)) {
      await patchColors(resolved.p2.name, resolved.p2.colors);
      applied = true;
    }

    if (applied) {
      o.resolved = true;
      saveObs(obs);
      showToast(`Table R${o.roundNum}/T${o.table} ${resolved.confidence === 'high' ? 'identifiée ✓' : 'identification probable'}`);
    }
  }
}

/**
 * Déduction inter-observations.
 *
 * Scénario : R1 T5 tu notes vert+jaune (c1) sans savoir qui est qui.
 *            R2 T3 tu notes vert+jaune (c1) avec le même joueur.
 *
 * Algorithme :
 * Pour chaque paire d'observations non résolues partageant un joueur commun,
 * si les couleurs observées pour ce joueur sont identiques dans les deux obs,
 * on peut en déduire son identité et scoutterle.
 *
 * Appelée après chaque saveTableObs (confirmation de table).
 */
async function tryResolveObsCrossMatch() {
  const allObs = getObs();
  const eventPrefix = S.eventId + '-';

  // Collecter toutes les obs non résolues de cet event
  const pending = Object.entries(allObs)
    .filter(([k, o]) => k.startsWith(eventPrefix) && !o.resolved && (o.c1?.length || o.c2?.length))
    .map(([k, o]) => {
      // Retrouver les noms des joueurs depuis les pairings
      const round = S.rounds.find(r => r.num === o.roundNum);
      const pairing = round?.pairings.find(p => p.table === o.table);
      return { key: k, obs: o, p1: pairing?.p1 || null, p2: pairing?.p2 || null };
    })
    .filter(e => e.p1 && e.p2);

  if (pending.length < 2) return;

  // Pour chaque obs, construire un map : joueur -> [liste de sets de couleurs observées pour lui]
  // Si un joueur apparaît dans deux obs avec les mêmes couleurs dans les deux → c'est sa bicolorité

  for (let i = 0; i < pending.length; i++) {
    for (let j = i + 1; j < pending.length; j++) {
      const A = pending[i];
      const B = pending[j];

      // Trouver le joueur commun entre les deux tables
      const commonPlayers = [A.p1, A.p2].filter(p => p === B.p1 || p === B.p2);
      if (!commonPlayers.length) continue;

      for (const commonPlayer of commonPlayers) {
        // Déjà scouttée ? Skip
        if (S.players[commonPlayer]?.colors?.length) continue;

        // Couleurs observées pour ce joueur dans obs A
        // On ne sait pas si c'est c1 ou c2 — on essaie les deux
        const slotsA = [];
        if (A.obs.c1?.length) slotsA.push(A.obs.c1);
        if (A.obs.c2?.length) slotsA.push(A.obs.c2);

        const slotsB = [];
        if (B.obs.c1?.length) slotsB.push(B.obs.c1);
        if (B.obs.c2?.length) slotsB.push(B.obs.c2);

        // Chercher une paire (sA, sB) avec les mêmes couleurs
        for (const sA of slotsA) {
          for (const sB of slotsB) {
            if (sA.length === sB.length && sA.every(c => sB.includes(c))) {
              // Même set de couleurs pour ce joueur dans les deux obs → c'est sa bicolorité
              console.log(`[deduction] ${commonPlayer} joue ${sA.join('+')} (cross-obs R${A.obs.roundNum}T${A.obs.table} + R${B.obs.roundNum}T${B.obs.table})`);

              await patchColors(commonPlayer, sA);

              // Maintenant qu'on connaît commonPlayer, essayer de résoudre l'adversaire dans A et B
              // En obs A : si commonPlayer = sA, l'autre slot c'est l'adversaire
              const otherInA = commonPlayer === A.p1 ? A.p2 : A.p1;
              const otherColorsA = slotsA.find(s => !s.every(c => sA.includes(c)));
              if (otherColorsA && otherInA && !S.players[otherInA]?.colors?.length) {
                await patchColors(otherInA, otherColorsA);
              }

              const otherInB = commonPlayer === B.p1 ? B.p2 : B.p1;
              const otherColorsB = slotsB.find(s => !s.every(c => sB.includes(c)));
              if (otherColorsB && otherInB && !S.players[otherInB]?.colors?.length) {
                await patchColors(otherInB, otherColorsB);
              }

              showToast(`${commonPlayer} identifié par recoupement ✓`);
              return; // Un seul match suffit par passe, on relancera si besoin
            }
          }
        }
      }
    }
  }
}

// Appelée par le bouton 🎯 — lit les données depuis les data-* attributes
// pour éviter tout problème d'échappement avec JSON.stringify dans le HTML.
function openTableScoutFromBtn(btn) {
  const roundNum = parseInt(btn.dataset.round);
  const table    = parseInt(btn.dataset.table);
  const p1       = btn.dataset.p1 || '';
  const p2       = btn.dataset.p2 || '';
  openTableScout(roundNum, table, p1, p2);
}

function openTableScout(roundNum, table, p1, p2) {
  tableScoutState = { roundNum, table, p1, p2 };
  document.getElementById('tableScoutOverlay').style.display = 'flex';
  document.getElementById('tsTitle').textContent = `Table ${table} · R${roundNum}`;
  renderTableScoutSheet();
}

function renderTableScoutSheet() {
  if (!tableScoutState) return;
  const { roundNum, table, p1, p2 } = tableScoutState;
  const obs = getTableObs(roundNum, table);
  const resolved = tryResolve(p1, p2, obs);
  const hintEl = document.getElementById('tsHint');

  // Status hint
  if (resolved?.confidence === 'high') {
    const fmt = slot => slot ? slot.colors.map(id => COLORS.find(c=>c.id===id)?.label||id).join(' + ') : '?';
    hintEl.innerHTML = `✓ <b>${esc(resolved.p1?.name||p1)}</b> joue ${fmt(resolved.p1)}<br>✓ <b>${esc(resolved.p2?.name||p2)}</b> joue ${fmt(resolved.p2)}`;
    hintEl.className = 'ts-hint success';
  } else if (resolved?.confidence === 'medium') {
    hintEl.textContent = '⚠ Identification probable — continue à scoutter pour confirmer';
    hintEl.className = 'ts-hint warn';
  } else if (obs.c1.length || obs.c2.length) {
    hintEl.textContent = '💾 Couleurs notées — scoutte un joueur de cette table pour identifier';
    hintEl.className = 'ts-hint muted';
  } else {
    hintEl.textContent = '';
    hintEl.className = 'ts-hint muted';
  }

  // Color grid for one slot
  function colorGrid(slotId, colorArr) {
    return COLORS.map(c => {
      const sel = colorArr.includes(c.id);
      return `<div class="ts-color-btn${sel?' sel':''}" style="--c:${c.hex}"
        onclick="toggleTableColor('${slotId}','${c.id}')">
        <div class="ts-dot" style="background:${c.hex}"></div>
        <div class="ts-clabel">${c.label}</div>
      </div>`;
    }).join('');
  }

  function selectedDots(colorArr) {
    if (!colorArr.length) return '<span style="color:var(--muted);font-size:11px;font-family:var(--mono)">—</span>';
    return colorArr.map(id => {
      const c = COLORS.find(x=>x.id===id);
      return c ? `<div class="ts-slot-dot" style="background:${c.hex}" title="${c.label}"></div>` : '';
    }).join('');
  }

  function slotCard(slotId, colorArr) {
    const label = slotId === 'c1' ? 'Joueur A' : 'Joueur B';
    const selText = colorArr.map(id => COLORS.find(c=>c.id===id)?.label||id).join(' + ');
    return `<div class="ts-slot${colorArr.length?' has-colors':''}">
      <div class="ts-slot-label">${label}</div>
      <div class="ts-slot-dots">${selectedDots(colorArr)}</div>
      ${selText ? `<div class="ts-slot-sel">${selText}</div>` : ''}
      <div class="ts-color-grid">${colorGrid(slotId, colorArr)}</div>
    </div>`;
  }

  const bodyEl = document.getElementById('tsBody');
  if (bodyEl) bodyEl.innerHTML =
    `<div class="ts-slots">${slotCard('c1', obs.c1)}${slotCard('c2', obs.c2)}</div>`;

  // Player reference strip — show the two players with their known colors
  function playerRefCard(name) {
    const p = S.players[name] || {};
    const realName = S.realNames[name] || '';
    const knownDots = (p.colors||[]).map(id => {
      const c = COLORS.find(x=>x.id===id);
      return c ? `<div class="ts-player-ref-dot" style="background:${c.hex}" title="${c.label}"></div>` : '';
    }).join('');
    return `<div class="ts-player-ref">
      <div class="ts-player-ref-label">Au pairing</div>
      <div class="ts-player-ref-name">${esc(name)}</div>
      ${realName ? `<div class="ts-player-ref-real">${esc(realName)}</div>` : ''}
      ${knownDots ? `<div class="ts-player-ref-colors">${knownDots}</div>` : `<div class="ts-player-ref-real" style="color:var(--muted)">Non scouttée</div>`}
    </div>`;
  }

  const refEl = document.getElementById('tsPlayersRef');
  if (refEl) {
    if (p1 && p2) {
      refEl.innerHTML = playerRefCard(p1) + playerRefCard(p2);
      refEl.style.display = 'flex';
    } else {
      refEl.style.display = 'none';
    }
  }
}

function toggleTableColor(slotId, colorId) {
  if (!tableScoutState) return;
  const { roundNum, table } = tableScoutState;
  const obs = getTableObs(roundNum, table);
  const arr = obs[slotId];
  const idx = arr.indexOf(colorId);
  if (idx >= 0) arr.splice(idx, 1);
  else if (arr.length < 2) arr.push(colorId);
  else { arr.shift(); arr.push(colorId); }
  saveTableObs(roundNum, table, obs);
  renderTableScoutSheet();
  // Tenter le recoupement inter-observations en temps réel
  tryResolveObsCrossMatch();
}

function closeTableScout() {
  tableScoutState = null;
  document.getElementById('tableScoutOverlay').style.display = 'none';
}

async function confirmTableScout() {
  if (!tableScoutState) return;
  const { roundNum, table, p1, p2 } = tableScoutState;
  const obs = getTableObs(roundNum, table);

  // Essayer d'abord la résolution directe (obs vs scoutings connus)
  const resolved = tryResolve(p1, p2, obs);
  if (resolved) {
    let applied = false;
    if (resolved.p1?.colors?.length && !(S.players[resolved.p1.name]?.colors?.length)) {
      await patchColors(resolved.p1.name, resolved.p1.colors); applied = true;
    }
    if (resolved.p2?.colors?.length && !(S.players[resolved.p2.name]?.colors?.length)) {
      await patchColors(resolved.p2.name, resolved.p2.colors); applied = true;
    }
    if (applied) {
      const all = getObs(); const k = obsKey(roundNum, table);
      if (all[k]) { all[k].resolved = true; saveObs(all); }
      showToast(resolved.confidence === 'high' ? 'Joueurs identifiés ✓' : 'Identification probable ✓');
    }
  }

  // Toujours tenter le recoupement inter-observations
  await tryResolveObsCrossMatch();

  if (!resolved) {
    showToast('Couleurs notées · Recoupement en cours…');
  }

  closeTableScout();
  renderPairings();
}

// ── Render pairings ───────────────────────────────────────────────────────────
function renderPairings() {
  const name = S.meta?.title || (S.eventId ? `Tournoi #${S.eventId}` : '—');
  document.getElementById('pairingsEventName').textContent = name;

  const strip = document.getElementById('roundStrip');
  strip.innerHTML = S.rounds.length
    ? S.rounds.map((r,i) =>
        `<div class="round-chip${i===S.currentRound?' active':''}" onclick="setRound(${i})">R${r.num}</div>`
      ).join('')
    : '';

  const round = S.rounds[S.currentRound];
  if (!round) {
    setScroll('pairings', `<div class="state-box">Pas de pairings disponibles<br>pour ce tournoi</div>`);
    return;
  }

  const q = pairingsSearch.toLowerCase();
  const pairings = q
    ? round.pairings.filter(p =>
        p.p1?.toLowerCase().includes(q) || p.p2?.toLowerCase().includes(q) ||
        (S.realNames[p.p1]||'').toLowerCase().includes(q) ||
        (S.realNames[p.p2]||'').toLowerCase().includes(q)
      )
    : round.pairings;

  if (!pairings.length) {
    setScroll('pairings', q
      ? `<div class="state-box">Aucun résultat pour "${esc(q)}"</div>`
      : `<div class="state-box">Aucun pairing</div>`);
    return;
  }

  const CHUNK = 40;
  const html = pairings.slice(0, CHUNK).map(p => pairingCardHtml(p, round.num)).join('')
    + (pairings.length > CHUNK
        ? `<div class="load-more-btn" onclick="loadMorePairings(this)" data-offset="${CHUNK}">
            Voir ${pairings.length - CHUNK} tables de plus ↓
           </div>`
        : '');

  setScroll('pairings', html);
}

function loadMorePairings(btn) {
  const round = S.rounds[S.currentRound];
  if (!round) return;
  const offset = parseInt(btn.dataset.offset);
  const q = pairingsSearch.toLowerCase();
  const pairings = q
    ? round.pairings.filter(p => p.p1?.toLowerCase().includes(q) || p.p2?.toLowerCase().includes(q))
    : round.pairings;
  const CHUNK = 40;
  const next = pairings.slice(offset, offset + CHUNK);
  const rest = pairings.length - offset - CHUNK;
  btn.insertAdjacentHTML('beforebegin', next.map(p => pairingCardHtml(p, round.num)).join(''));
  if (rest > 0) { btn.textContent = `Voir ${rest} tables de plus ↓`; btn.dataset.offset = offset + CHUNK; }
  else btn.remove();
}

function pairingCardHtml(p, roundNum) {
  const bye2 = !p.p2 || p.p2 === 'BYE';
  const r1 = p.winner === 'p1' ? 'win' : p.winner === 'p2' ? 'loss' : p.winner === 'draw' ? 'draw' : null;
  const r2 = p.winner === 'p2' ? 'win' : p.winner === 'p1' ? 'loss' : p.winner === 'draw' ? 'draw' : null;
  const statusBadge = p.isComplete
    ? `<span class="pairing-status-badge done">✓ Terminé</span>`
    : `<span class="pairing-status-badge live">En cours</span>`;
  const obs = getTableObs(roundNum, p.table);
  const hasObs = obs.c1.length > 0 || obs.c2.length > 0;
  const p2val = bye2 ? '' : p.p2;
  const scoutBtn = `<button class="table-scout-btn${hasObs?' has-data':''}"
    data-round="${roundNum}" data-table="${p.table}"
    data-p1="${esc(p.p1)}" data-p2="${esc(p2val)}"
    onclick="event.stopPropagation();openTableScoutFromBtn(this)"
    title="Scout par table">🎯</button>`;

  return `<div class="pairing-card">
    <div class="pairing-table-bar">
      <span class="table-n">Table ${p.table}</span>
      <div style="display:flex;align-items:center;gap:8px">${scoutBtn}${statusBadge}</div>
    </div>
    <div class="pairing-players">
      ${playerSlot(p.p1, r1, p.gWW, p.gWL)}
      ${bye2
        ? `<div class="player-slot"><div class="ps-main"><div class="ps-name bye">BYE</div></div></div>`
        : playerSlot(p.p2, r2, p.winner==='p2'?p.gWW:p.gWL, p.winner==='p2'?p.gWL:p.gWW)}
    </div>
  </div>`;
}

function playerSlot(name, result, gW, gL) {
  const p = S.players[name] || { colors:[] };
  const sc = p.colors?.length > 0;
  const realName = S.realNames[name] || '';
  const dots = (p.colors||[]).map(cid => {
    const c = COLORS.find(x=>x.id===cid);
    return c ? `<div class="cdot" style="background:${c.hex}" title="${c.label}"></div>` : '';
  }).join('');
  const winCls = result === 'win' ? ' winner' : result === 'loss' ? ' loser' : '';
  const scoutCls = sc ? ' scouted' : '';
  let resultHtml = '';
  if (result) {
    const label = result === 'win' ? 'W' : result === 'loss' ? 'L' : 'D';
    const score = (gW != null && gL != null) ? `<div class="ps-score">${gW}-${gL}</div>` : '';
    resultHtml = `<div class="ps-result-wrap"><div class="ps-result ${result}">${label}</div>${score}</div>`;
  }
  return `<div class="player-slot${winCls}${scoutCls}" data-open-sheet="${esc(name)}">
    <div class="ps-main">
      <div class="ps-name">${esc(name)}</div>
      ${realName ? `<div class="ps-realname">${esc(realName)}</div>` : ''}
      ${dots ? `<div class="ps-colors">${dots}</div>` : ''}
    </div>
    ${resultHtml}
  </div>`;
}

function setRound(i) {
  S.currentRound = i;
  pairingsSearch = '';
  document.getElementById('pairingsSearch').value = '';
  renderPairings();
  document.getElementById('roundStrip').children[i]
    ?.scrollIntoView({ block:'nearest', inline:'center', behavior:'smooth' });
}

function onPairingsSearch(val) {
  pairingsSearch = val;
  renderPairings();
}