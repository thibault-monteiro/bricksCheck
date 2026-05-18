# Bricks Check — Conventions projet

## Bump de version : SYSTÉMATIQUE

À chaque modification fonctionnelle de l'extension (code, manifest, contenu de
popup/options, fichiers chargés par Chrome), tu DOIS bumper `manifest.json`
ET `package.json` avant de commiter.

Règles SemVer appliquées :

| Type de changement                              | Bump            |
|------------------------------------------------|-----------------|
| Fix de bug, ajustement mineur, doc             | `patch` (0.5.0 → 0.5.1) |
| Nouvelle fonctionnalité visible, refactor      | `minor` (0.5.0 → 0.6.0) |
| Changement incompatible / refonte majeure       | `major` (0.5.0 → 1.0.0) |

Cas particulier : pendant la phase `0.x.y`, on reste indulgent — un refactor
pur peut rester en `patch` si l'API utilisateur ne change pas. Mais on bump
QUELQUE CHOSE, jamais "rien".

Avant le `git commit`, vérifier que `manifest.json` et `package.json` portent
**la même version**. Idéalement, le commit qui modifie le code et celui qui
bump la version sont **le même commit**.

## Workflow recommandé

1. Modifier le code.
2. Bumper `manifest.json` ET `package.json` (même version).
3. Lancer les tests : `npm test` (ou
   `node --test tests/projects.test.js tests/utils.test.js`).
4. Stager et committer avec un message en `type: description` (refactor, fix,
   feat, chore, docs).
5. Push.

Pour vérifier que Chrome a bien rechargé l'extension : la version visible dans
`chrome://extensions` doit correspondre à `manifest.json` après reload manuel.

## Structure

- `service_worker.js` — orchestration (alarmes, fetch API, notifications)
- `api_bridge.js` — extraction du JWT depuis `app.bricks.co` (MAIN world)
- `content_script.js` — pont MAIN → service worker (ISOLATED world)
- `popup.js`, `options.js` — UI
- `shared/constants.js`, `shared/utils.js`, `shared/projects.js` — code pur,
  partagé, testable hors Chrome
- `tests/` — tests Node natifs (`node --test`)

## Sécurité

- Le JWT Bricks est lu en local depuis `localStorage`/`sessionStorage` de
  `app.bricks.co` uniquement.
- `content_script.js` valide `event.origin === APP_ORIGIN` avant tout relais.
- `api_bridge.js` valide la forme JWT (`/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`)
  avant broadcast.
- Aucune donnée n'est exfiltrée vers un serveur tiers — toutes les requêtes
  vont sur `api.bricks.co` avec le jeton de l'utilisateur.
