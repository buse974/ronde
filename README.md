# ronde

Planificateur de tâches Claude auto-hébergé, open source.

Une petite UI web pour créer des tâches récurrentes qui lancent `claude -p` sur ton serveur, avec l'historique des runs, la consommation (tokens, coût estimé) et une alerte par mail quand Claude signale un problème.

> Prototype. Hors périmètre pour l'instant : MCP, seuils de consommation.

## Principe

- Chaque tâche = un prompt, une planification cron, les outils autorisés, un nombre de tours max et un timeout.
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

## Sécurité

- `claude` tourne sous un utilisateur dédié (`runner`, uid 1001) avec un environnement construit de zéro : il ne reçoit que le token Claude. Il ne peut lire ni `/data` (base, secret), ni l'environnement du process app.
- Le conteneur n'a que les capacités `SETUID`, `SETGID` (changer d'uid) et `KILL` (arrêter un run expiré), avec `no-new-privileges`.
- Le token Claude est chiffré en base (AES-256-GCM). La clé dérive d'`APP_SECRET`, généré au premier démarrage dans `/data/secret.key` si la variable n'est pas fournie. **Sauvegarder `/data` revient à sauvegarder ce secret.**
- UI : un compte admin (argon2), cookie de session `HttpOnly` + `SameSite=Strict`, contrôle de l'origine sur les requêtes POST, limitation des tentatives de connexion.
- Un outil comme `Bash` donne à Claude un shell dans le conteneur (en tant que `runner`) : n'autorise que ce dont la tâche a besoin, de préférence avec des règles restreintes (`Bash(df:*)`).

## Tâche d'exemple : disque et Docker

La liste des tâches vide propose de créer « Surveillance disque et Docker ». Claude n'y a que l'outil `Read` : les mesures sont produites **sur l'hôte** par `host/ronde-metrics.sh` et montées en lecture seule dans `/host-metrics`. Pas de socket Docker dans le conteneur.

```bash
# Sur l'hôte (crontab de l'utilisateur qui lance docker compose) :
*/15 * * * * /chemin/ronde/host/ronde-metrics.sh /chemin/ronde/host-metrics
```

Le script a besoin de `sudo -n du` pour mesurer `/var/lib/docker`.

## Développement

```bash
npm install
npm run dev      # http://localhost:3000, données dans ./data
npm test
```

En dev, sans `RUNNER_UID`, `claude` tourne sous ton utilisateur.

Stack : Node 22, Express 5, SQLite (better-sqlite3), croner, Eta + htmx + Pico.css, argon2, nodemailer, zod, vitest.

## Licence

MIT
