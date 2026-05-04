# Lorcana Scout 🎴

Application de scouting collaboratif pour tournois Disney Lorcana.

## Fonctionnalités
- Scraping automatique du roster d'un événement depuis `tcg.ravensburgerplay.com`
- Navigation par rondes (si pairings disponibles)
- Attribution de 2 couleurs de deck par joueur (Ambre, Améthyste, Émeraude, Rubis, Saphir, Acier)
- **Listing complet par bicolorité** (onglet "Couleurs")
- **Temps réel multi-joueurs** via WebSocket : tous les membres du groupe voient les mises à jour instantanément
- N'importe qui peut modifier/corriger les couleurs d'un joueur

---

## Installation rapide

### Prérequis
- [Node.js](https://nodejs.org) v18 ou supérieur

### 1. Installer le serveur

```bash
cd server
npm install
```

### 2. Lancer le serveur

```bash
npm start
```

Le serveur démarre sur **http://localhost:3001**

### 3. Ouvrir le client

Ouvrir le fichier `client/index.html` directement dans un navigateur.

> **Important** : le client se connecte à `localhost:3001`. Tous les membres du groupe doivent utiliser le **même réseau local** ou le serveur doit être accessible publiquement (voir ci-dessous).

---

## Utilisation

1. Coller le lien d'un événement Ravensburger Play dans la barre en haut
2. Cliquer sur **Charger**
3. Le roster est récupéré automatiquement (toutes les pages)
4. Dans les **Pairings** ou le **Roster**, cliquer sur un joueur pour renseigner ses 2 couleurs
5. L'onglet **Couleurs** affiche le listing complet groupé par bicolorité

---

## Accès multi-joueurs en réseau local

Si plusieurs personnes sont sur le même Wi-Fi :

1. Récupérer l'IP locale de la machine qui fait tourner le serveur :
   ```bash
   # macOS/Linux
   ifconfig | grep "inet "
   # Windows
   ipconfig
   ```
2. Dans `client/index.html`, modifier les 2 lignes de config (vers le haut du `<script>`) :
   ```js
   const SERVER = 'http://192.168.X.X:3001';  // IP locale
   const WS_URL = 'ws://192.168.X.X:3001';
   ```
3. Chaque membre ouvre `index.html` dans son navigateur — les mises à jour sont synchronisées en temps réel.

---

## Accès public (optionnel)

Pour exposer le serveur sur internet (ex: depuis un téléphone 4G), utiliser [ngrok](https://ngrok.com) :

```bash
ngrok http 3001
```

Ngrok fournit une URL publique. Mettre à jour `SERVER` et `WS_URL` dans le client avec cette URL (en remplaçant `http` par `https` et `ws` par `wss`).

---

## Structure du projet

```
lorcana-scout/
├── server/
│   ├── server.js      # Backend Express + WebSocket
│   └── package.json
└── client/
    └── index.html     # App complète en un fichier
```

---

## API du serveur

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/events/:id` | Charge/retourne les données d'un événement |
| GET | `/api/events/:id?refresh=1` | Force le re-scraping |
| PATCH | `/api/events/:id/players/:name` | Met à jour les couleurs d'un joueur |
| GET | `/api/events/:id/colors` | Listing complet bicolorité |
| GET | `/api/health` | Statut du serveur |

Les données sont conservées **en mémoire** pendant la session du serveur. Pour une persistance entre redémarrages, il suffirait d'ajouter une écriture JSON dans un fichier (prévu comme évolution simple).
