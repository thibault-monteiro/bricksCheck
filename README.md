# Bricks Check

Bricks Check est une extension Chrome Manifest V3 qui surveille les projets en collecte sur Bricks.co et envoie des notifications quand le nombre de briques disponibles correspond à votre seuil.

Elle est pensée pour un usage simple : se connecter une fois sur `https://app.bricks.co`, laisser l'extension interroger l'API Bricks à intervalle régulier, puis recevoir une notification par projet quand votre nombre de briques reste inférieur à votre objectif. Aucun onglet Bricks n'a besoin de rester ouvert.

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
5. Ouvrir `https://app.bricks.co` dans un onglet pour que l'extension capte le token d'authentification.
6. Ouvrir le popup Bricks Check, activer la surveillance, puis cliquer sur `Enregistrer`.
7. L'onglet Bricks peut ensuite être fermé — l'extension fonctionne en arrière-plan.

## Réglages

- `Seuil personnel` : nombre de briques à atteindre sur chaque projet.
- `Intervalle` : fréquence de vérification.
- `Notifier si...` : déclenche les notifications quand un projet a des briques disponibles et que votre nombre de briques est inférieur au seuil.

## Fonctionnement technique

L'extension injecte deux scripts sur `https://app.bricks.co/*` :

1. **`api_bridge.js`** (monde `MAIN`, `document_start`) — lit le token d'authentification Bricks depuis le `localStorage`/`sessionStorage` du site et le transmet au content script via `window.postMessage`.
2. **`content_script.js`** (monde isolé) — reçoit le token et le transmet au service worker pour mise en cache.

Le `service_worker` stocke le token dans `chrome.storage.local` et appelle directement l'API Bricks (`/projects` et `/investor/portfolio/properties`) sans onglet ouvert. Si le token expire (401/403), l'extension ouvre ou recharge automatiquement un onglet Bricks pour récupérer un nouveau token, puis retente l'appel. En cas d'échec persistant, une notification d'erreur est affichée.

## Sécurité et confidentialité

- Aucun token GitHub, mot de passe, cookie, clé privée ou secret n'est stocké dans le dépôt.
- L'extension communique uniquement avec les domaines Bricks (`app.bricks.co` et `api.bricks.co`). Elle ne contient pas de télémétrie et n'appelle aucun service tiers.
- Les appels à l'API Bricks réutilisent le token d'authentification déjà présent dans le navigateur de l'utilisateur (session Bricks active). Le token est mis en cache dans `chrome.storage.local` et rafraîchi automatiquement quand il expire.
- Les permissions sont limitées aux besoins de l'extension : alarmes, notifications, stockage local/sync, onglets, et accès à `https://app.bricks.co/*` et `https://api.bricks.co/*`.
- Les réglages et le cache des briques possédées sont stockés via l'API Chrome `storage`.
- Elle ne collecte pas volontairement de données personnelles et ne les transmet nulle part.

## Limites

- Bricks Check est un outil de notification personnel, pas un outil de conseil financier ou d'investissement.
- L'utilisateur doit être connecté sur Bricks.co au moins une fois pour que l'extension puisse capter le token d'authentification.
- Si le token expire et que la session Bricks n'est plus active, l'extension tente d'ouvrir un onglet Bricks et affiche une notification d'erreur.
- Si l'API Bricks change ou devient inaccessible, l'extension affiche une notification d'erreur.
- Les notifications sont envoyées à chaque vérification tant que les conditions sont remplies.

## Fichiers principaux

- `manifest.json` : configuration de l'extension Chrome.
- `api_bridge.js` : script injecté dans le monde `MAIN` pour lire le token Bricks.
- `content_script.js` : relais du token vers le service worker, navigation au clic sur notification.
- `service_worker.js` : appels API directs, cache token et briques, notifications et planification.
- `popup.html`, `popup.css`, `popup.js` : interface de réglage.
