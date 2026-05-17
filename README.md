# Bricks Check

Bricks Check est une extension Chrome Manifest V3 qui surveille les projets en collecte sur Bricks.co et envoie des notifications quand le nombre de briques disponibles correspond à votre seuil.

Elle est pensée pour un usage simple : garder un onglet `https://app.bricks.co` ouvert, laisser l'extension interroger l'API Bricks à intervalle régulier, puis recevoir une notification par projet quand votre nombre de briques reste inférieur à votre objectif.

Bricks Check est une extension indépendante et non officielle. Elle n'est pas affiliée, associée, autorisée, approuvée ni sponsorisée par Bricks.co. Elle ne constitue pas un conseil en investissement.

## Fonctionnalités

- Récupération des projets via l'API Bricks (`api.bricks.co`).
- Calcul des briques disponibles à partir du catalogue et du portefeuille investisseur.
- Cache local des briques possédées (TTL 6 h) pour éviter les fausses notifications quand le nombre de briques est temporairement inconnu.
- Notification d'erreur et réouverture automatique d'un onglet Bricks si l'API échoue (token expiré, problème réseau...).
- Seuil configurable, par défaut `100` briques.
- Vérification automatique toutes les minutes par défaut.
- Une notification Chrome par projet correspondant.
- Le clic sur une notification ouvre un nouvel onglet Bricks et tente d'ouvrir le projet concerné.
- Compteur dans le popup pour voir la prochaine vérification.

## Installation locale

1. Ouvrir `chrome://extensions`.
2. Activer le `Mode développeur`.
3. Cliquer sur `Charger l'extension non empaquetée`.
4. Sélectionner ce dossier.
5. Ouvrir `https://app.bricks.co` dans un onglet, idéalement épinglé.
6. Ouvrir le popup Bricks Check, activer la surveillance, puis cliquer sur `Enregistrer`.

## Réglages

- `Seuil personnel` : nombre de briques à atteindre sur chaque projet.
- `Intervalle` : fréquence de vérification.
- `Notifier si...` : déclenche les notifications quand un projet a des briques disponibles et que votre nombre de briques est inférieur au seuil.

## Fonctionnement technique

L'extension injecte deux scripts sur `https://app.bricks.co/*` :

1. **`api_bridge.js`** (monde `MAIN`, `document_start`) — lit le token d'authentification Bricks depuis le `localStorage`/`sessionStorage` du site et interroge l'API Bricks (`/projects` et `/investor/portfolio/properties`) pour obtenir le catalogue de projets et le portefeuille de l'investisseur. La communication avec le content script se fait par `window.postMessage`.
2. **`content_script.js`** (monde isolé) — transmet les résultats de l'API au service worker.

Le `service_worker` planifie les vérifications avec `chrome.alarms`, interroge l'API via le content script, maintient un cache local des briques possédées, déclenche les notifications avec `chrome.notifications`, et ouvre un nouvel onglet quand une notification est cliquée. Si l'API échoue (token expiré, problème réseau), l'extension affiche une notification d'erreur et tente de recharger ou ouvrir un onglet Bricks pour rafraîchir la session.

## Sécurité et confidentialité

- Aucun token GitHub, mot de passe, cookie, clé privée ou secret n'est stocké dans le dépôt.
- L'extension communique uniquement avec les domaines Bricks (`app.bricks.co` et `api.bricks.co`). Elle ne contient pas de télémétrie et n'appelle aucun service tiers.
- Les appels à l'API Bricks réutilisent le token d'authentification déjà présent dans le navigateur de l'utilisateur (session Bricks active). Aucun identifiant n'est stocké par l'extension.
- Les permissions sont limitées aux besoins de l'extension : alarmes, notifications, stockage local/sync, onglets, et accès à `https://app.bricks.co/*` et `https://api.bricks.co/*`.
- Les réglages et le cache des briques possédées sont stockés via l'API Chrome `storage`.
- Elle ne collecte pas volontairement de données personnelles et ne les transmet nulle part.

## Limites

- Bricks Check est un outil de notification personnel, pas un outil de conseil financier ou d'investissement.
- Un onglet `https://app.bricks.co` doit rester ouvert (et l'utilisateur connecté) pour que l'extension puisse interroger l'API.
- Si l'API Bricks change ou devient inaccessible, l'extension affiche une notification d'erreur et recharge l'onglet Bricks.
- Les notifications sont envoyées à chaque vérification tant que les conditions sont remplies.

## Fichiers principaux

- `manifest.json` : configuration de l'extension Chrome.
- `api_bridge.js` : script injecté dans le monde `MAIN` pour interroger l'API Bricks.
- `content_script.js` : pont entre l'API bridge et le service worker.
- `service_worker.js` : planification, scan API/DOM, cache, notifications et ouverture au clic.
- `popup.html`, `popup.css`, `popup.js` : interface de réglage.
