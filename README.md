<p align="center"><img src="server/public/logo.svg" width="96" alt="ronde"></p>

# ronde

Planificateur de tâches Claude auto-hébergé, open source.

**→ [ronde.altstud.io](https://ronde.altstud.io)**

Tu décris à Claude ce qu'il doit surveiller ; il en fait une « ronde » : un prompt que `claude -p` exécute sur ton serveur, à heure fixe ou à la demande. ronde garde l'historique des passages, leur coût, et t'envoie un mail quand Claude signale un problème.

> Prototype. Hors périmètre pour l'instant : connecteurs MCP dans les rondes, seuils de consommation.

## Principe

- **Tout part d'une conversation avec Claude.** Tu poses une question ou décris ce qui t'inquiète ; Claude répond, puis t'aide à en faire une **ronde** (planifiée) ou un **oneshot** (relancé à la main). Il la crée quand tu lui dis « ok ».
- **Une ronde garde sa conversation.** Elle reste à côté de la ronde et de chacun de ses passages : « pourquoi cette alerte ? », « ignore /boot », « mets-la en pause ». Claude agit uniquement sur ton accord explicite, et répond en une phrase ce qu'il a fait.
- **Historique.** Chaque création, modification (prompt avant / après), pause ou archivage est noté dans la conversation par ronde, pas par Claude. Claude le relit à chaque message ; tu le vois avec **Réglages > Mode debug**.
- **Rien n'est supprimé.** Une ronde s'archive avec sa conversation et ses passages ; depuis les archives, « remets-la active » suffit.
- Une ronde = un prompt, une planification cron (ou aucune : lancée à la demande), les outils autorisés, un nombre de tours max et un timeout.
- **Convention RAS** : le prompt demande à Claude de répondre exactement `RAS` s'il n'y a rien à signaler. Toute autre réponse est une **alerte** (mail envoyé).
- Un run est en **échec** si le code de sortie est différent de 0 **ou** si `is_error` vaut `true` (le champ `subtype` est ignoré), ainsi qu'en cas de timeout ou de sortie illisible. Un échec envoie aussi un mail.
- Un run n'est jamais lancé si le précédent de la même tâche tourne encore.

## Installation

> Guide complet (HTTPS, mails, MCP, données hôte, mises à jour, sauvegardes, dépannage) : **[INSTALL.md](INSTALL.md)**.

Deux façons, au choix. Dans les deux cas, `claude` tourne sous un compte dédié qui ne peut lire ni la base ni les secrets de ronde.

### Avec Docker

L'image est construite sur ton serveur depuis les sources ([`Dockerfile`](Dockerfile)).

```bash
git clone https://github.com/buse974/ronde.git && cd ronde
docker compose up -d --build
docker compose logs ronde      # affiche le code d'installation
```

### Sans Docker (Node + systemd)

Prérequis : Node.js 22, git, `python3`, `make` et `g++`. En root :

```bash
git clone https://github.com/buse974/ronde.git /opt/ronde && cd /opt/ronde
npm ci --omit=dev
npm install -g @anthropic-ai/claude-code

useradd --system --home-dir /var/lib/ronde-runner --create-home --shell /usr/sbin/nologin ronde-runner
install -d -o ronde-runner -g ronde-runner -m 711 /var/lib/ronde-runner/work
chmod 711 /var/lib/ronde-runner
install -d -m 755 /opt/ronde/host-metrics
install -d -m 755 /etc/ronde && install -m 600 .env.example /etc/ronde/ronde.env

cp systemd/ronde.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now ronde
journalctl -u ronde | grep -A1 "Code d'installation"
```

Le détail de chaque étape, la mise à jour et la sauvegarde : [INSTALL.md § 2.B](INSTALL.md#2b-sans-docker-node--systemd).

### Premier accès

Ouvre `http://<serveur>:3000/setup`, saisis le code, crée le compte admin. Le token Claude et l'email d'alerte peuvent être renseignés tout de suite ou plus tard dans **Réglages**.

### Token Claude

Sur ta machine :

```bash
claude setup-token
```

Colle le token (`sk-ant-oat…`) dans **Réglages**. Il utilise ton abonnement Pro/Max : pas de facturation à part, les runs sont pris sur ton quota (partagé avec ton usage habituel de Claude). Une clé API (`sk-ant-api…`) est aussi acceptée, mais elle est facturée à l'usage.

Le « coût estimé » affiché est l'équivalent API renvoyé par Claude : indicatif avec un abonnement.

### Mails d'alerte

Renseigne un relais SMTP dans `.env`, ou `/etc/ronde/ronde.env` sans Docker (voir `.env.example`), puis l'email destinataire dans **Réglages** (bouton « Envoyer un mail de test »).

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

- `claude` tourne sous un utilisateur dédié (`runner` dans le conteneur, `ronde-runner` sans Docker) avec un environnement construit de zéro : il ne reçoit que le token Claude. Il ne peut lire ni le dossier de données (base, secret), ni l'environnement du process app.
- Le process app n'a que les capacités `SETUID`, `SETGID` (changer d'uid) et `KILL` (arrêter un run expiré), avec `no-new-privileges` : via `docker-compose.yml`, ou via [`systemd/ronde.service`](systemd/ronde.service), qui met en plus le système en lecture seule.
- Le token Claude est chiffré en base (AES-256-GCM). La clé dérive d'`APP_SECRET`, généré au premier démarrage dans `secret.key` (à côté de la base) si la variable n'est pas fournie. **Sauvegarder le dossier de données revient à sauvegarder ce secret.**
- UI : un compte admin (argon2), cookie de session `HttpOnly` + `SameSite=Strict`, contrôle de l'origine sur les requêtes POST, limitation des tentatives de connexion.
- Un outil comme `Bash` donne à Claude un shell (dans le conteneur, ou sur le serveur sans Docker, toujours sous le compte dédié) : n'autorise que ce dont la tâche a besoin, de préférence avec des règles restreintes (`Bash(df:*)`).

## Modèles et données de l'hôte

Claude connaît des modèles de rondes (outil MCP `list_templates`) qui n'utilisent que l'outil `Read` : les données sont produites **sur l'hôte** par des scripts, et Claude les lit en lecture seule : dans `/host-metrics` avec Docker, dans `/opt/ronde/host-metrics` sans Docker. Claude n'a ni socket Docker ni privilège. Un timer systemd prêt à l'emploi est dans [`systemd/`](systemd/).

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

En dev, sans `RUNNER_USER` ni `RUNNER_UID`, `claude` tourne sous ton utilisateur.

Stack : Node 22, Express 5, SQLite (better-sqlite3), croner, Eta + htmx + Pico.css, argon2, nodemailer, zod, SDK MCP officiel, vitest.

## Landing page

La page de présentation, [ronde.altstud.io](https://ronde.altstud.io), est dans `docs/` : HTML et CSS statiques, sans JavaScript ni build. Elle reprend la police, le logo et les couleurs de l'app. Le dossier `docs/` n'entre pas dans l'image Docker de l'app.

Aperçu en local : ouvre `docs/index.html` dans un navigateur.

## Licence

MIT
