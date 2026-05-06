# Lorcana Scout

Application mobile de scouting pour tournois Lorcana. Charge le roster d'un événement depuis [tcg.ravensburgerplay.com](https://tcg.ravensburgerplay.com), affiche les pairings ronde par ronde, et permet de noter les bicolorités des joueurs adverses en temps réel — partagé entre tous les appareils connectés via WebSocket.

---

## Fonctionnalités

- **Roster complet** — charge tous les joueurs inscrits via l'API Ravensburger Play (pas de limite de pagination)
- **Pairings par ronde** — affichage mobile-first avec résultats (W/L/D), scores et statut de chaque match
- **Scouting de bicolorité** — note jusqu'à 2 couleurs par joueur, synchronisé en temps réel entre appareils
- **Standings** — classement avec points, record W/L/D et rang final
- **Onglet Couleurs** — répartition des bicolorités avec pourcentage du tournoi, taux de victoire par combo et barre de performance visuelle
- **Favoris** — marque des joueurs pour les suivre dans les standings
- **Historique** — retrouve rapidement les tournois chargés précédemment

---

## Stack

- **Backend** : Node.js + Express + WebSocket (`ws`)
- **Données** : API REST `api.cloudflare.ravensburgerplay.com` (publique, sans auth)
- **Frontend** : HTML/CSS/JS vanilla, optimisé mobile
- **Hébergement** : Railway (ou local)

---

## Déploiement Railway (gratuit)

### 1. Créer un repo GitHub
- Aller sur [github.com/new](https://github.com/new)
- Créer un repo public ou privé (ex: `lorcana-scout`)
- Uploader les trois fichiers : `index.html`, `server.js`, `package.json`

### 2. Déployer sur Railway
- Aller sur [railway.app](https://railway.app) → se connecter avec GitHub
- **New Project** → **Deploy from GitHub repo** → sélectionner `lorcana-scout`
- Railway détecte automatiquement Node.js et lance `npm start`
- En 2 minutes, une URL publique est générée (ex: `lorcana-scout-production.up.railway.app`)

### 3. C'est tout ✅
L'app détecte automatiquement si elle tourne en local ou en prod — pas de config à changer.

---

## Usage local

```bash
npm install
npm start
# Ouvrir http://localhost:3001 dans le navigateur
```

---

## Utilisation

1. Saisir l'ID de l'événement dans la barre en haut (ex: `492131`) et appuyer sur **Go**
2. Le roster complet et les pairings disponibles se chargent automatiquement
3. Dans **Pairings**, naviguer entre les rondes avec les chips en haut ; cliquer sur un joueur pour noter sa bicolorité
4. Dans **Roster**, rechercher un joueur, l'ajouter en favori ⭐ ou lui assigner ses couleurs
5. Dans **Couleurs**, consulter la répartition des decks scouttés et leur taux de victoire
6. Dans **Standings**, filtrer sur les favoris pour suivre les joueurs clés ; rafraîchir en cours de ronde

---

## API interne (debug)

Le serveur expose une route de debug pour inspecter n'importe quel endpoint Ravensburger Play :

```
GET /api/debug/:eventId?endpoint=/events/:id/tournament-rounds
```

---

## Notes

- Les données sont **en mémoire** : les couleurs scouttées se réinitialisent au redémarrage du serveur
- Le plan gratuit Railway = 500h/mois, largement suffisant pour des tournois ponctuels
- Les stats de winrate dans l'onglet Couleurs n'utilisent que les matchs où **les deux joueurs sont scouttés** — plus tu renseignes de bicolorités, plus les stats sont précises
- Pour persister les données entre redémarrages, Railway propose PostgreSQL gratuit
