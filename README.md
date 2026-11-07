# ronde

Planificateur de tâches Claude auto-hébergé (open source).

Une petite UI web pour créer des tâches récurrentes qui lancent `claude -p` sur le serveur, avec historique des runs, consommation et alertes mail.

> Prototype en cours de développement.

## Lancer

```bash
cp .env.example .env
docker compose up -d
```

## Développement

```bash
npm install
npm run dev
```

## Licence

MIT
