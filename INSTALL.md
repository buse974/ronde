# Installer ronde

Ce guide couvre l'installation sur un serveur Linux, de la première commande jusqu'à l'exploitation : HTTPS, mails, MCP, données de l'hôte, mises à jour, sauvegardes et dépannage.

Deux façons d'installer ronde, au choix :

- **[Avec Docker](#2a-avec-docker)** : tout est dans un conteneur, construit sur ton serveur depuis les sources.
- **[Sans Docker](#2b-sans-docker-node--systemd)** : Node.js et un service systemd. Claude tourne alors directement sur le serveur, sous un compte dédié sans privilège.

Les deux ont le même modèle de sécurité : le process `claude` tourne sous un utilisateur qui ne peut lire ni la base ni le secret de ronde. Dans la suite du guide, quand une commande diffère, les deux variantes sont données.

Pour une présentation de l'outil, voir le [README](README.md).

## Sommaire

1. [Prérequis](#1-prérequis)
2. [Installation](#2-installation) : [avec Docker](#2a-avec-docker) ou [sans Docker](#2b-sans-docker-node--systemd)
3. [Premier démarrage](#3-premier-démarrage)
4. [Token Claude](#4-token-claude)
5. [Configuration (`.env`)](#5-configuration-env)
6. [Mails d'alerte](#6-mails-dalerte)
7. [HTTPS derrière un reverse proxy](#7-https-derrière-un-reverse-proxy)
8. [Piloter ronde depuis Claude (MCP)](#8-piloter-ronde-depuis-claude-mcp)
9. [Données de l'hôte (modèles disque et SSH)](#9-données-de-lhôte-modèles-disque-et-ssh)
10. [Mise à jour](#10-mise-à-jour)
11. [Sauvegarde et restauration](#11-sauvegarde-et-restauration)
12. [Réinitialiser le compte admin](#12-réinitialiser-le-compte-admin)
13. [Dépannage](#13-dépannage)
14. [Désinstallation](#14-désinstallation)
15. [Développement local](#15-développement-local)

---

## 1. Prérequis

| Élément | Requis | Remarque |
|---|---|---|
| Serveur Linux x86_64 | oui | 1 vCPU et 1 Go de RAM suffisent ; chaque run lance un process `claude`. |
| **Avec Docker :** Docker Engine + plugin Compose v2 | oui | `docker compose version` doit répondre. |
| **Sans Docker :** Node.js 22, npm, git, systemd, `python3`, `make` et `g++` | oui | `better-sqlite3` se compile à l'installation. Node 22 via les paquets de ta distribution ou [NodeSource](https://github.com/nodesource/distributions). |
| Abonnement Claude Pro/Max **ou** clé API Anthropic | oui | Voir [Token Claude](#4-token-claude). |
| Claude Code sur ton poste | pour le token d'abonnement | Sert uniquement à générer le token (`claude setup-token`). |
| Relais SMTP | pour les alertes | Sans SMTP, ronde fonctionne mais n'envoie aucun mail. |
| Nom de domaine + HTTPS | pour le MCP | Le serveur MCP exige une `PUBLIC_URL` en HTTPS (ou `localhost`). |

Le port **3000** doit être libre, ou il faut le changer (`ports` dans `docker-compose.yml`, ou `PORT` sans Docker).

## 2. Installation

### 2.A Avec Docker

```bash
git clone https://github.com/buse974/ronde.git
cd ronde
cp .env.example .env        # facultatif : ronde démarre sans .env
docker compose up -d --build
```

L'image est construite sur ton serveur depuis les sources : aucune image n'est publiée sur un registre. La version du CLI Claude Code embarqué est fixée par l'argument `CLAUDE_CODE_VERSION` (`latest` par défaut) :

  ```bash
  docker compose build --build-arg CLAUDE_CODE_VERSION=2.1.0
  ```

Vérifier que le conteneur est sain :

```bash
docker compose ps                      # STATUS doit finir par « (healthy) »
curl -s http://localhost:3000/health   # {"status":"ok","service":"ronde","type":"app"}
```

Ce que crée `docker-compose.yml` :

- **le conteneur `ronde`**, sur le port 3000, avec `restart: unless-stopped` ;
- **le volume nommé `ronde-data`**, monté sur `/data`, qui contient la base SQLite et le secret applicatif ;
- **le montage `./host-metrics`** en lecture seule sur `/host-metrics`, pour les données de l'hôte (voir [§9](#9-données-de-lhôte-modèles-disque-et-ssh)) ;
- **des capacités réduites** : `cap_drop: ALL`, puis seulement `SETUID`, `SETGID` et `KILL`, avec `no-new-privileges`.

### 2.B Sans Docker (Node + systemd)

Les commandes suivantes sont à lancer en root (ou avec `sudo`). Les chemins sont ceux de l'unité fournie : code dans `/opt/ronde`, base dans `/var/lib/ronde`, configuration dans `/etc/ronde/ronde.env`.

**1. Le code et le CLI Claude Code**

```bash
git clone https://github.com/buse974/ronde.git /opt/ronde
cd /opt/ronde
npm ci --omit=dev
npm install -g @anthropic-ai/claude-code     # claude dans /usr/local/bin ou /usr/bin
```

**2. Le compte qui exécute Claude**

```bash
useradd --system --home-dir /var/lib/ronde-runner --create-home --shell /usr/sbin/nologin ronde-runner
install -d -o ronde-runner -g ronde-runner -m 711 /var/lib/ronde-runner/work
chmod 711 /var/lib/ronde-runner
install -d -m 755 /opt/ronde/host-metrics
```

Le mode `711` est nécessaire : ronde entre dans le dossier de travail juste avant de passer sous `ronde-runner`, et il n'a pas le droit de lire les fichiers des autres.

**3. La configuration**

```bash
install -d -m 755 /etc/ronde
install -m 600 .env.example /etc/ronde/ronde.env
```

Édite `/etc/ronde/ronde.env` (voir [§5](#5-configuration-env)). Tout est facultatif pour un premier essai.

**4. Le service**

```bash
cp systemd/ronde.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ronde
systemctl status ronde                 # active (running)
curl -s http://localhost:3000/health   # {"status":"ok","service":"ronde","type":"app"}
```

Ce que fait [`systemd/ronde.service`](systemd/ronde.service) :

- **il lance `node server/index.js`** depuis `/opt/ronde`, et le relance en cas d'échec ;
- **il garde la base dans `/var/lib/ronde`** (mode `700`), avec le secret applicatif ;
- **il lance `claude` sous `ronde-runner`**, sans aucune capacité. Ce compte ne peut lire ni `/var/lib/ronde` ni `/etc/ronde/ronde.env` ;
- **il réduit les droits du process** comme le conteneur : root sans autre capacité que `SETUID`, `SETGID` et `KILL`, `NoNewPrivileges`, système de fichiers en lecture seule sauf `/var/lib/ronde` et `/var/lib/ronde-runner`, `/home` et `/root` masqués.

Node n'est pas dans `/usr/bin/node` (installation via nvm, par exemple) ? Adapte `ExecStart` avec `systemctl edit --full ronde`. Le binaire `claude` doit être dans `/usr/local/bin` ou `/usr/bin`, sinon fixe `CLAUDE_BIN` dans `/etc/ronde/ronde.env`.

## 3. Premier démarrage

Au premier lancement, tant qu'aucun admin n'existe, ronde affiche un **code d'installation** dans ses logs :

```bash
docker compose logs ronde | grep -A1 "Code d'installation"   # avec Docker
journalctl -u ronde | grep -A1 "Code d'installation"         # sans Docker
```

```
  │  Code d'installation ronde : 7F3A2-C91BE  │
  │  À saisir sur /setup pour créer le compte admin.  │
```

1. Ouvre `http://<serveur>:3000/setup`.
2. Saisis le code, puis crée le compte admin (identifiant + mot de passe).
3. Le token Claude et l'email d'alerte peuvent être renseignés tout de suite ou plus tard dans **Réglages**.
4. Ensuite, tout part de l'encart **« Que doit surveiller Claude ? »** sur l'accueil : décris ce qui t'inquiète, Claude te répond et t'aide à en faire une ronde.

Le code change à chaque redémarrage tant que l'installation n'est pas terminée. Il n'est plus généré une fois l'admin créé.

> Si le serveur est exposé sur Internet, fais le setup immédiatement après le démarrage, ou passe d'abord par le reverse proxy HTTPS du [§7](#7-https-derrière-un-reverse-proxy). Le code d'installation protège cette étape, mais le port 3000 est en HTTP clair.

## 4. Token Claude

ronde lance `claude -p` avec **un seul** jeton, sous l'utilisateur dédié (`runner` dans le conteneur, `ronde-runner` sans Docker).

### Option A : abonnement Pro/Max (recommandé)

Sur ton poste, là où Claude Code est installé et connecté :

```bash
claude setup-token
```

Copie le token `sk-ant-oat…` et colle-le dans **Réglages > Token Claude**, puis clique sur « Tester ». Les runs sont pris sur ton quota d'abonnement, partagé avec ton usage habituel de Claude. Il n'y a pas de facturation à part.

### Option B : clé API

Une clé `sk-ant-api…` est acceptée au même endroit. Elle est **facturée à l'usage**.

### Token imposé par l'environnement

`CLAUDE_CODE_OAUTH_TOKEN` (ou `ANTHROPIC_API_KEY`) dans `.env` (ou `/etc/ronde/ronde.env`) est **prioritaire** sur le token saisi dans l'UI. C'est utile pour un déploiement automatisé, mais le token se retrouve alors en clair dans ce fichier. Le token saisi dans l'UI est, lui, chiffré en base (AES-256-GCM).

Le « coût estimé » affiché pour chaque run est l'équivalent API renvoyé par Claude. Avec un abonnement, il est indicatif.

## 5. Configuration (`.env`)

Avec Docker, les variables vont dans `.env`, à côté de `docker-compose.yml`. Sans Docker, dans `/etc/ronde/ronde.env`. Toutes sont facultatives. Le compte admin, le token Claude, l'email destinataire et les outils MCP se règlent dans l'UI et sont stockés en base.

| Variable | Défaut | Rôle |
|---|---|---|
| `PUBLIC_URL` | *(vide)* | URL publique de ronde, sans `/` final. Sert aux liens des mails et à l'émetteur OAuth du MCP. **Obligatoire en HTTPS pour le MCP.** |
| `TZ` | `Europe/Paris` | Fuseau des expressions cron et des dates affichées. |
| `PORT` | `3000` | Port d'écoute (dans le conteneur, avec Docker). |
| `COOKIE_SECURE` | `false` | `true` derrière HTTPS : cookie de session `Secure`. |
| `TRUST_PROXY` | `0` | `1` derrière un reverse proxy : IP client réelle (limitation des tentatives de connexion). |
| `SMTP_HOST` | *(vide)* | Relais SMTP. Vide = alertes mail désactivées. |
| `SMTP_PORT` | `25` | Port du relais. |
| `SMTP_SECURE` | `false` | `true` pour du TLS implicite (port 465). Avec `false`, STARTTLS est utilisé si le serveur le propose. |
| `SMTP_USER` / `SMTP_PASS` | *(vide)* | Identifiants SMTP, si le relais en demande. |
| `SMTP_FROM` | `ronde@localhost` | Expéditeur des alertes. Doit être autorisé par le SPF du domaine. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | `false` pour accepter un certificat auto-signé (relais local). |
| `APP_SECRET` | *(généré)* | Secret de chiffrement du token Claude. Sinon généré dans `secret.key`, à côté de la base, au premier démarrage. |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | *(vide)* | Token imposé, prioritaire sur l'UI (voir [§4](#4-token-claude)). |
| `HOST_DATA_DIR` | `/host-metrics` | Dossier des données de l'hôte. Sans Docker, l'unité systemd le fixe à `/opt/ronde/host-metrics`. |
| `CLAUDE_BIN` | `claude` | Chemin du CLI Claude Code, s'il n'est pas dans `/usr/local/bin` ou `/usr/bin`. |
| `RUNNER_MAX_STDOUT` | `2097152` | Taille max de la sortie de `claude` (octets) ; au-delà, le run échoue. |
| `RUNNER_KILL_GRACE_MS` | `10000` | Délai entre `SIGTERM` et `SIGKILL` à l'arrêt d'un run. |
| `MAX_PARALLEL_ASKS` | `3` | Conversations avec Claude simultanées (chacune lance un `claude -p` d'environ 200 à 400 Mo). Les passages planifiés ne sont pas comptés. |

Les variables `RUNNER_USER` (ou `RUNNER_UID` et `RUNNER_GID`), `RUNNER_HOME`, `RUNNER_CWD`, `DATA_DIR` et `NODE_ENV` sont fixées par l'image Docker ou par l'unité systemd : ne les change pas sans raison.

Après toute modification de la configuration :

```bash
docker compose up -d          # avec Docker : recrée le conteneur
systemctl restart ronde       # sans Docker
```

> **`APP_SECRET` :** si tu le définis après coup, ou si tu le changes, le token Claude déjà enregistré devient illisible. Il faut alors le ressaisir dans **Réglages**.

## 6. Mails d'alerte

Par défaut, un mail part quand un run est en **alerte** (réponse autre que `RAS`) ou en **échec**. Pour envoyer ailleurs (Slack, Teams, webhook, d'autres adresses), ou à chaque passage, crée des **canaux** dans **Réglages > Canaux** et branche-les sur les rondes (voir le [README](README.md#canaux-et-mails-dalerte)). Les canaux mail utilisent ce même relais SMTP ; un canal **SMTP** porte sa propre connexion (un compte Office 365, par exemple) et n'a besoin d'aucune variable `SMTP_*`. Sur un canal Mail ou SMTP, chaque ronde peut donner ses propres destinataires.

1. Renseigne le relais dans `.env`. Exemple avec un relais authentifié en STARTTLS :

   ```dotenv
   SMTP_HOST=smtp.example.com
   SMTP_PORT=587
   SMTP_USER=ronde@example.com
   SMTP_PASS=********
   SMTP_FROM=ronde@example.com
   ```

2. `docker compose up -d`
3. Dans **Réglages > Alertes**, saisis l'email destinataire et clique sur « Envoyer un mail de test ».

Sans `SMTP_HOST`, les logs affichent `SMTP_HOST absent : les alertes mail sont désactivées`.

Office 365, en relais global comme en canal SMTP : `smtp.office365.com`, port 587 (STARTTLS), identifiant = adresse de la boîte. Active **SMTP authentifié** sur la boîte, sinon l'envoi est refusé (`535 5.7.139`) ; une boîte partagée ne peut pas s'authentifier tant que sa connexion n'est pas débloquée.

Si le mail de test part mais n'arrive pas, vérifie que le SPF du domaine de `SMTP_FROM` autorise le relais (un SPF en `-all` qui ne liste pas le relais fait rejeter les mails), et regarde les indésirables.

## 7. HTTPS derrière un reverse proxy

En production, place ronde derrière un reverse proxy HTTPS. Dans tous les cas, ajoute dans `.env` :

```dotenv
PUBLIC_URL=https://ronde.example.com
COOKIE_SECURE=true
TRUST_PROXY=1
```

Une fois le proxy en place, retire le mapping `ports: - "3000:3000"` de `docker-compose.yml`, ou limite-le à `127.0.0.1:3000:3000`, pour ne plus exposer le HTTP clair.

### Traefik (labels Docker)

À ajouter au service `ronde`, avec le réseau externe de Traefik (ici `traefik-public`) :

```yaml
services:
  ronde:
    # … configuration existante …
    networks:
      - traefik-public
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.ronde.rule=Host(`ronde.example.com`)"
      - "traefik.http.routers.ronde.entrypoints=websecure"
      - "traefik.http.routers.ronde.tls=true"
      - "traefik.http.routers.ronde.tls.certresolver=letsencrypt"
      - "traefik.http.services.ronde.loadbalancer.server.port=3000"

networks:
  traefik-public:
    external: true
```

### Caddy

```caddyfile
ronde.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name ronde.example.com;
    # ssl_certificate … ; ssl_certificate_key … ;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Le proxy doit transmettre l'en-tête `Host` d'origine (Traefik et Caddy le font par défaut ; pour nginx, `proxy_set_header Host $host`). ronde refuse toute requête POST dont l'`Origin` ne correspond pas au `Host` reçu : sans cet en-tête, les formulaires répondent « Requête refusée : origine invalide ».

## 8. Piloter ronde depuis Claude (MCP)

ronde expose un serveur MCP sur `/mcp`. Claude peut y consulter les rondes, essayer un prompt sur le serveur et créer une ronde après ton accord.

**Prérequis :** `PUBLIC_URL` en **HTTPS** (ou `localhost`). Sinon le MCP est désactivé.

Depuis Claude Code, sur ton poste :

```bash
claude mcp add --scope user --transport http ronde https://ronde.example.com/mcp
```

Puis dans Claude Code : `/mcp` → `ronde` → « Authenticate ». Le navigateur s'ouvre sur ronde : connecte-toi avec le compte admin, puis clique sur « Autoriser ». Aucun token n'est à copier.

- **Révoquer un accès :** **Réglages > Accès MCP**.
- **Outils autorisés** pour une ronde créée ou essayée via MCP : **Réglages > Outils proposables** (par défaut `Read`, `Grep`, `Glob`). C'est la liste unique des outils que Claude peut proposer, aussi utilisée par l'assistant de conception de l'interface. L'élargir vaut pour le MCP, **y compris `test_prompt`, qui exécute tout de suite sans validation dans l'interface**, et déverrouille la modification par MCP des rondes qui utilisent ces outils.
- **Sécurité :** préfère des règles étroites (`Bash(php -v)`, `Bash(dpkg -l:*)`, `WebFetch(domain:php.net)`). Un nom d'outil seul (`Bash`, `WebFetch`) autorise toutes les règles de cet outil ; `Bash` donne un shell sous le compte dédié. Quand l'assistant signale une règle manquante, un bouton permet de l'ajouter d'un clic (règles étroites seulement) ; relis-la avant : `Bash(php:*)` autorise aussi `php -r`. Une ronde qui a besoin d'un outil hors liste peut toujours être créée dans le formulaire manuel.
- **Clients acceptés :** l'enregistrement dynamique OAuth n'accepte que des redirections locales (`localhost`, `127.0.0.1`) et `https://claude.ai` / `https://claude.com`.

## 9. Données de l'hôte (modèles disque et SSH)

Les modèles « Surveillance disque et Docker » et « Sécurité SSH et fail2ban » lisent des fichiers produits **sur l'hôte** par les scripts de `host/`. Claude ne reçoit que le résultat, en lecture seule : dans `/host-metrics` avec Docker, dans `/opt/ronde/host-metrics` sans Docker. Il n'a ni socket Docker ni privilège.

Sans Docker, Claude tourne déjà sur l'hôte, mais sous un compte sans privilège : il ne peut lire ni les journaux système ni l'état de fail2ban. Les scripts restent donc utiles.

| Script | Fichiers produits | Commandes lancées avec `sudo -n` |
|---|---|---|
| `host/ronde-metrics.sh` | `metrics.txt`, `history.csv` (7 jours) | `du` (taille de `/var/lib/docker`) |
| `host/ronde-fail2ban.sh` | `fail2ban.txt`, `fail2ban-history.csv` (7 jours) | `test`, `ssh-keygen`, `journalctl`, `awk`, `fail2ban-client` |

### Prérequis sur l'hôte

- **Le dossier de sortie** est le `host-metrics/` du dépôt : celui monté dans le conteneur avec Docker, `/opt/ronde/host-metrics` sans Docker.
- **L'utilisateur** qui lance les scripts doit pouvoir faire `sudo -n` sans mot de passe, et appartenir au groupe `docker` pour `docker system df`.
- **Pour le modèle SSH**, il faut fail2ban, sshd journalisé par systemd (unité `sshd`, modifiable via `SSH_UNIT`) et le log `/var/log/fail2ban.log` (modifiable via `F2B_LOG`).

Les scripts dégradent proprement : une mesure indisponible est notée « indisponible » au lieu de faire échouer le script.

> Avec `sudo -n` sur `awk` ou `journalctl`, l'utilisateur est en pratique root. Lance les scripts avec un compte d'administration qui a déjà ces droits, pas avec un compte de service créé pour l'occasion.

### Test manuel

```bash
cd /chemin/vers/ronde
./host/ronde-metrics.sh  "$PWD/host-metrics"
./host/ronde-fail2ban.sh "$PWD/host-metrics"
ls -l host-metrics/      # metrics.txt, history.csv, fail2ban.txt, fail2ban-history.csv
```

Dans ronde, l'outil MCP `list_host_data` (ou un run d'essai du modèle) doit maintenant voir ces fichiers.

### Planification avec un timer systemd (toutes les 15 minutes)

Les deux fichiers sont dans [`systemd/`](systemd/). Remplace `admin` par l'utilisateur, et `/opt/ronde` par le chemin du dépôt s'il est ailleurs.

`/etc/systemd/system/ronde-metrics.service` :

```ini
[Unit]
Description=ronde : données hôte (disque, Docker, fail2ban)

[Service]
Type=oneshot
User=admin
ExecStart=/opt/ronde/host/ronde-metrics.sh /opt/ronde/host-metrics
ExecStart=/opt/ronde/host/ronde-fail2ban.sh /opt/ronde/host-metrics
```

`/etc/systemd/system/ronde-metrics.timer` :

```ini
[Unit]
Description=ronde : mesures toutes les 15 minutes

[Timer]
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ronde-metrics.timer
systemctl list-timers ronde-metrics.timer     # prochaine exécution
journalctl -u ronde-metrics.service -n 20     # dernières exécutions
```

### Alternative : cron

```cron
*/15 * * * * /opt/ronde/host/ronde-metrics.sh  /opt/ronde/host-metrics
*/15 * * * * /opt/ronde/host/ronde-fail2ban.sh /opt/ronde/host-metrics
```

## 10. Mise à jour

Avec Docker :

```bash
cd /chemin/vers/ronde
git pull
docker compose up -d --build
docker image prune -f
```

Sans Docker :

```bash
cd /opt/ronde
git pull
npm ci --omit=dev
systemctl restart ronde
```

- **Migrations :** elles s'appliquent toutes seules au démarrage (`server/migrations/`, version suivie par `PRAGMA user_version`). Fais une [sauvegarde](#11-sauvegarde-et-restauration) avant une mise à jour.
- **Runs interrompus :** un run en cours pendant le redémarrage est marqué en échec au démarrage suivant (« run(s) interrompu(s) » dans les logs).
- **Version de Claude Code :** avec Docker, le CLI est figé dans l'image : reconstruis-la (`docker compose build --no-cache`). Sans Docker : `npm install -g @anthropic-ai/claude-code@latest`. Les mises à jour automatiques du CLI sont désactivées pendant les runs.

## 11. Sauvegarde et restauration

Tout l'état de ronde est dans un seul dossier : `/data` dans le conteneur, `/var/lib/ronde` sans Docker.

| Fichier | Contenu |
|---|---|
| `ronde.db` (+ `-wal`, `-shm`) | Rondes, historique des runs, réglages, compte admin, accès MCP, token Claude chiffré. |
| `secret.key` | Clé de chiffrement du token Claude (absent si `APP_SECRET` est fourni). |

**Sauvegarder ce dossier revient à sauvegarder ce secret.** Garde la sauvegarde aussi protégée que le serveur. Sans `secret.key` (ou sans le même `APP_SECRET`), la base restaurée est lisible mais le token Claude devra être ressaisi.

### Sauvegarder

Avec Docker :

```bash
cd /chemin/vers/ronde
docker compose stop ronde                       # base cohérente (pas d'écriture en cours)
docker compose cp ronde:/data ./sauvegarde-$(date +%F)
docker compose start ronde
tar czf ronde-$(date +%F).tar.gz sauvegarde-$(date +%F) && rm -rf sauvegarde-$(date +%F)
```

Sans Docker :

```bash
systemctl stop ronde
tar czf ronde-$(date +%F).tar.gz -C /var/lib ronde
systemctl start ronde
```

L'arrêt ne dure que quelques secondes. Un passage cron qui tombe pendant cette fenêtre est manqué : il n'est pas rattrapé. Une ronde « une seule fois » dont l'heure est passée est, elle, lancée au redémarrage.

### Restaurer

Avec Docker :

```bash
cd /chemin/vers/ronde
tar xzf ronde-AAAA-MM-JJ.tar.gz
docker compose stop ronde
docker compose cp ./sauvegarde-AAAA-MM-JJ/. ronde:/data/
docker compose start ronde
docker compose logs --tail 20 ronde
```

Pour restaurer sur un nouveau serveur, fais d'abord un `docker compose up -d` pour créer le volume, puis suis la procédure ci-dessus.

Sans Docker :

```bash
systemctl stop ronde
rm -rf /var/lib/ronde && tar xzf ronde-AAAA-MM-JJ.tar.gz -C /var/lib
chmod 700 /var/lib/ronde
systemctl start ronde
journalctl -u ronde -n 20
```

## 12. Réinitialiser le compte admin

Il n'y a pas de « mot de passe oublié ». En accès au serveur, efface l'admin : les rondes, l'historique et le token sont conservés.

Avec Docker :

```bash
cd /chemin/vers/ronde
docker compose exec -T ronde node -e '
const db = new (require("better-sqlite3"))("/data/ronde.db");
db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run("admin_user", "admin_password_hash");
db.prepare("DELETE FROM sessions").run();
'
docker compose restart ronde
docker compose logs ronde | grep -A1 "Code d'installation"
```

Sans Docker :

```bash
cd /opt/ronde
node -e '
const db = new (require("better-sqlite3"))("/var/lib/ronde/ronde.db");
db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run("admin_user", "admin_password_hash");
db.prepare("DELETE FROM sessions").run();
'
systemctl restart ronde
journalctl -u ronde | grep -A1 "Code d'installation"
```

Puis retourne sur `/setup` avec le nouveau code et recrée le compte.

## 13. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Pas de code d'installation dans les logs | L'admin existe déjà | Connecte-toi sur `/login`, ou [réinitialise l'admin](#12-réinitialiser-le-compte-admin). |
| Les runs échouent immédiatement | Pas de token Claude, ou token expiré ou révoqué | **Réglages > Token Claude > Tester** ; régénère-le avec `claude setup-token`. |
| Run en échec « timeout » | Délai maximum de la ronde trop court | Augmente le timeout de la ronde, ou réduis le nombre de tours. |
| Le modèle disque ou SSH répond « données indisponibles » | Scripts hôte pas lancés, ou mauvais dossier | `ls host-metrics/` à côté de `docker-compose.yml` ; vérifie le timer (`systemctl list-timers`). |
| « indisponible (sudo -n du requis) » dans `metrics.txt` | `sudo` demande un mot de passe | Donne `sudo` sans mot de passe à l'utilisateur du timer. |
| Pas de mail d'alerte | `SMTP_HOST` absent, ou mail rejeté | Logs au démarrage ; « Envoyer un mail de test » ; SPF du domaine de `SMTP_FROM`. |
| « Requête refusée : origine invalide » sur les formulaires | Le proxy ne transmet pas le `Host` d'origine | Transmets `Host` (voir [§7](#7-https-derrière-un-reverse-proxy)). |
| Déconnecté en boucle | `COOKIE_SECURE=true` alors que l'accès est en HTTP | Accède en HTTPS, ou retire `COOKIE_SECURE`. |
| `/mcp` indisponible, ou erreur OAuth dans Claude Code | `PUBLIC_URL` absente ou en HTTP | `PUBLIC_URL=https://…`, puis `docker compose up -d` ou `systemctl restart ronde`. |
| Token Claude « illisible » après une restauration | `secret.key` ou `APP_SECRET` différent | Restaure `secret.key` avec la base, ou ressaisis le token. |
| Conteneur `unhealthy` | L'app ne répond pas sur `/health` | `docker compose logs --tail 100 ronde`. |
| Sans Docker : run en échec « spawn … EACCES » | Dossier de travail de `ronde-runner` pas en `711` | `chmod 711 /var/lib/ronde-runner /var/lib/ronde-runner/work`. |
| Sans Docker : « Impossible de lancer claude : spawn claude ENOENT » | CLI hors de `/usr/local/bin` et `/usr/bin` | `CLAUDE_BIN=/chemin/vers/claude` dans `/etc/ronde/ronde.env`. |
| Sans Docker : le service ne démarre pas | Dépendances non compilées, ou mauvais chemin de `node` | `journalctl -u ronde -n 50` ; relance `npm ci --omit=dev` dans `/opt/ronde`. |

Commandes utiles :

```bash
# Avec Docker
docker compose logs -f ronde              # logs en direct
docker compose exec ronde claude --version
docker compose ps

# Sans Docker
journalctl -u ronde -f                    # logs en direct
claude --version
systemctl status ronde
```

## 14. Désinstallation

Avec Docker :

```bash
cd /chemin/vers/ronde
docker compose down          # arrête et supprime le conteneur, garde les données
docker compose down -v       # supprime AUSSI le volume /data : base et secret perdus
```

Sans Docker :

```bash
systemctl disable --now ronde
rm /etc/systemd/system/ronde.service && systemctl daemon-reload
rm -rf /var/lib/ronde            # base et secret : perdus
rm -rf /etc/ronde /opt/ronde
userdel -r ronde-runner
npm uninstall -g @anthropic-ai/claude-code
```

Si tu as installé le timer systemd :

```bash
sudo systemctl disable --now ronde-metrics.timer
sudo rm /etc/systemd/system/ronde-metrics.{service,timer}
sudo systemctl daemon-reload
```

Pense aussi au token Claude : `claude setup-token` génère un token longue durée qui reste valide après la désinstallation. Révoque-le depuis ton compte Claude si tu ne t'en sers plus ailleurs, et supprime la clé API si c'est une clé `sk-ant-api…`.

## 15. Développement local

Prérequis : Node 22 (`.nvmrc`) et Claude Code installé (`claude` dans le `PATH`).

```bash
npm install
npm run dev      # http://localhost:3000, données dans ./data, recharge à chaque modification
npm test         # vitest, avec un faux binaire claude (test/fixtures/fake-claude.js)
npm run seed:example
```

En dev, sans `RUNNER_USER` ni `RUNNER_UID`, `claude` tourne sous ton propre utilisateur, avec tes droits : n'autorise pas `Bash` sur une ronde de test sans y réfléchir.
