# ronde

Planificateur de tâches Claude auto-hébergé, open source.

Une petite UI web pour créer des tâches récurrentes qui lancent `claude -p` sur ton serveur, avec l'historique des runs, la consommation (tokens, coût estimé) et une alerte par mail quand Claude signale un problème.

> Prototype. Hors périmètre pour l'instant : connecteurs MCP dans les rondes, seuils de consommation.

## Principe

- Chaque tâche (« ronde ») = un prompt, une planification cron (ou aucune : tâche **manuelle**, lancée à la demande), les outils autorisés, un nombre de tours max et un timeout.
- **Convention RAS** : le prompt demande à Claude de répondre exactement `RAS` s'il n'y a rien à signaler. Toute autre réponse est une **alerte** (mail envoyé).
- Un run est en **échec** si le code de sortie est différent de 0 **ou** si `is_error` vaut `true` (le champ `subtype` est ignoré), ainsi qu'en cas de timeout ou de sortie illisible. Un échec envoie aussi un mail.
- Un run n'est jamais lancé si le précédent de la même tâche tourne encore.

## Installation

```bash
git clone https://github.com/buse974/ronde.git && cd ronde
docker compose up -d
docker compose logs ronde      # affiche le code d'installation
```

Ouvre `http://<serveur>:3000/setup`, saisis le code, crée le compte admin. Le token Claude et l'email d'alerte peuvent être renseignés tout de suite ou plus tard dans **Réglages**.

### Token Claude

Sur ta machine :

```bash
claude setup-token
```

Colle le token (`sk-ant-oat…`) dans **Réglages**. Il utilise ton abonnement Pro/Max : pas de facturation à part, les runs sont pris sur ton quota (partagé avec ton usage habituel de Claude). Une clé API (`sk-ant-api…`) est aussi acceptée, mais elle est facturée à l'usage.

Le « coût estimé » affiché est l'équivalent API renvoyé par Claude : indicatif avec un abonnement.

### Mails d'alerte

Renseigne un relais SMTP dans `.env` (voir `.env.example`), puis l'email destinataire dans **Réglages** (bouton « Envoyer un mail de test »).

## Piloter ronde depuis Claude (MCP)

ronde expose un serveur MCP sur `/mcp`. Claude peut alors concevoir une ronde avec toi : regarder les données disponibles, te poser les questions utiles, **essayer** le prompt sur le serveur (statut, réponse, coût), puis la créer quand tu valides.

```bash
claude mcp add --scope user --transport http ronde https://ton-serveur/mcp
```

Dans Claude Code : `/mcp` → ronde → s'authentifier. Le navigateur s'ouvre sur ronde : identifiant + mot de passe, puis « Autoriser ». Aucun token à copier ; l'accès se révoque dans **Réglages > Accès MCP**.

Outils : `list_rondes`, `get_ronde`, `list_templates`, `preview_cron`, `list_host_data`, `test_prompt`, `create_ronde`, `update_ronde`, `set_active`, `run_ronde`, `get_run`, `list_runs`. Pas de suppression via MCP.

- OAuth 2.1 (PKCE, enregistrement dynamique limité aux redirections locales et claude.ai) : exige une `PUBLIC_URL` en **HTTPS** (ou localhost).
- Une ronde créée ou essayée via MCP ne peut utiliser que les outils autorisés dans **Réglages > Accès MCP** (par défaut `Read`, `Grep`, `Glob`).

## Sécurité

- `claude` tourne sous un utilisateur dédié (`runner`, uid 1001) avec un environnement construit de zéro : il ne reçoit que le token Claude. Il ne peut lire ni `/data` (base, secret), ni l'environnement du process app.
- Le conteneur n'a que les capacités `SETUID`, `SETGID` (changer d'uid) et `KILL` (arrêter un run expiré), avec `no-new-privileges`.
- Le token Claude est chiffré en base (AES-256-GCM). La clé dérive d'`APP_SECRET`, généré au premier démarrage dans `/data/secret.key` si la variable n'est pas fournie. **Sauvegarder `/data` revient à sauvegarder ce secret.**
- UI : un compte admin (argon2), cookie de session `HttpOnly` + `SameSite=Strict`, contrôle de l'origine sur les requêtes POST, limitation des tentatives de connexion.
- Un outil comme `Bash` donne à Claude un shell dans le conteneur (en tant que `runner`) : n'autorise que ce dont la tâche a besoin, de préférence avec des règles restreintes (`Bash(df:*)`).

## Modèles et données de l'hôte

La page des tâches propose des modèles. Claude n'y a que l'outil `Read` : les données sont produites **sur l'hôte** par des scripts et montées en lecture seule dans `/host-metrics`. Pas de socket Docker ni de privilège dans le conteneur.

| Modèle | Script hôte | Contenu |
|---|---|---|
| Surveillance disque et Docker | `host/ronde-metrics.sh` | `df`, taille de `/var/lib/docker`, `docker system df`, historique 7 j |
| Sécurité SSH et fail2ban | `host/ronde-fail2ban.sh` | état des jails, bans et échecs SSH 24 h, top IP, connexions SSH réussies avec la clé reconnue (`authorized_keys`), historique 7 j |

```bash
# Sur l'hôte, toutes les 15 min (cron ou timer systemd), avec sudo -n disponible :
/chemin/ronde/host/ronde-metrics.sh  /chemin/ronde/host-metrics
/chemin/ronde/host/ronde-fail2ban.sh /chemin/ronde/host-metrics
```

## Développement

```bash
npm install
npm run dev      # http://localhost:3000, données dans ./data
npm test
```

En dev, sans `RUNNER_UID`, `claude` tourne sous ton utilisateur.

Stack : Node 22, Express 5, SQLite (better-sqlite3), croner, Eta + htmx + Pico.css, argon2, nodemailer, zod, SDK MCP officiel, vitest.

## Licence

MIT
