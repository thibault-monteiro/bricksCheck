# Bricks Check

Bricks Check est une extension Chrome Manifest V3 qui surveille la page d'accueil de Bricks.co et envoie des notifications quand des projets en collecte correspondent à votre seuil de briques.

Elle est pensée pour un usage simple : garder un onglet `https://app.bricks.co` ouvert, laisser l'extension actualiser la page à intervalle régulier, puis recevoir une notification par projet quand le nombre de briques affiché sur la carte reste inférieur à votre objectif.

Bricks Check est une extension indépendante et non officielle. Elle n'est pas affiliée, associée, autorisée, approuvée ni sponsorisée par Bricks.co. Elle ne constitue pas un conseil en investissement.

## Fonctionnalités

- Surveillance des cartes `Collecte en cours` sur `app.bricks.co`.
- Seuil configurable, par défaut `100` briques.
- Vérification automatique toutes les minutes par défaut.
- Option pour actualiser l'onglet Bricks avant chaque vérification.
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
- `Actualiser l'onglet Bricks...` : recharge la page Bricks avant de lire les cartes.

## Fonctionnement technique

L'extension utilise un `content_script` injecté uniquement sur `https://app.bricks.co/*`. Ce script lit les cartes visibles dans la page, détecte les badges `Collecte en cours`, extrait le nom du projet et le nombre de briques affiché sur la carte.

Le `service_worker` planifie les vérifications avec `chrome.alarms`, déclenche les notifications avec `chrome.notifications`, et ouvre un nouvel onglet quand une notification est cliquée.

## Sécurité et confidentialité

- Aucun token GitHub, mot de passe, cookie, clé privée ou secret n'est stocké dans le dépôt.
- L'extension ne contient pas de serveur distant, pas de télémétrie et pas d'appel vers un service tiers.
- Les permissions sont limitées aux besoins de l'extension : alarmes, notifications, stockage local/sync, onglets, et accès à `https://app.bricks.co/*`.
- Les réglages sont stockés via l'API Chrome `storage`.
- L'extension lit uniquement le contenu visible de la page Bricks ouverte dans votre navigateur.
- Elle ne collecte pas volontairement de données personnelles et ne les transmet nulle part.

## Limites

- Bricks Check est un outil de notification personnel, pas un outil de conseil financier ou d'investissement.
- Un onglet `https://app.bricks.co` doit rester ouvert pour que l'extension puisse lire les projets.
- L'ouverture du projet au clic dépend de la structure HTML de Bricks.co. Si le site change fortement, l'extraction peut nécessiter une mise à jour.
- Les notifications sont envoyées à chaque vérification tant que les conditions sont remplies.

## Fichiers principaux

- `manifest.json` : configuration de l'extension Chrome.
- `content_script.js` : lecture des cartes projet dans Bricks.co.
- `service_worker.js` : planification, notifications et ouverture au clic.
- `popup.html`, `popup.css`, `popup.js` : interface de réglage.
