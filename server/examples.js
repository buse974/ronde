/**
 * Modèles de rondes. Les données sont produites sur l'hôte par les scripts de
 * host/ et montées en lecture seule dans /host-metrics : Claude n'a besoin que
 * de l'outil Read, sans socket Docker ni privilège.
 */
export const TEMPLATES = {
  disk: {
    name: 'Surveillance disque et Docker',
    summary: 'Espace disque, taille de /var/lib/docker et dérive sur 24 h / 7 j.',
    requires: 'host/ronde-metrics.sh',
    cron: '0 * * * *',
    allowed_tools: ['Read'],
    max_turns: 4,
    timeout_sec: 300,
    active: true,
    prompt: `Tu surveilles l'espace disque d'un serveur. Lis ces deux fichiers :
- /host-metrics/metrics.txt : dernière mesure (df, taille de /var/lib/docker, docker system df) avec sa date ;
- /host-metrics/history.csv : historique (timestamp, % utilisé de /, Go libres sur /, octets de /var/lib/docker).

Signale un problème si au moins une condition est vraie :
1. une partition est utilisée à 85 % ou plus ;
2. il reste moins de 10 Go libres sur / ;
3. /var/lib/docker a grossi de plus de 3 Go en 24 h, ou de plus de 10 % en 7 jours ;
4. la dernière mesure date de plus de 2 heures, ou un fichier est absent ou illisible.

S'il n'y a rien à signaler, réponds exactement « RAS » et rien d'autre.
Sinon, réponds en 5 lignes maximum : chaque problème avec les chiffres et une piste d'action (ex : docker image prune).`,
  },

  fail2ban: {
    name: 'Sécurité SSH et fail2ban',
    summary: 'État de fail2ban, pics de bannissements et d’échecs SSH, connexions SSH réussies inattendues.',
    requires: 'host/ronde-fail2ban.sh',
    cron: '5 * * * *',
    allowed_tools: ['Read'],
    max_turns: 4,
    timeout_sec: 300,
    active: true,
    prompt: `Tu surveilles la sécurité SSH d'un serveur. Lis ces deux fichiers :
- /host-metrics/fail2ban.txt : état de fail2ban et de ses jails, bannissements et échecs SSH des dernières 24 h, connexions SSH réussies (utilisateur, IP, méthode, clé reconnue ou non) ;
- /host-metrics/fail2ban-history.csv : historique (timestamp, bans_24h, echecs_ssh_24h, bannies_actuellement, connexions_24h).

Les déploiements GitHub Actions se connectent souvent en clé publique avec la clé de déploiement depuis des IP variables : c'est normal.

Signale un problème si au moins une condition est vraie :
1. fail2ban n'est pas actif, ou une jail (dont sshd) manque ;
2. une connexion SSH a réussi par mot de passe, avec une clé non reconnue, ou pour un autre utilisateur que fedora ;
3. les bannissements ou les échecs SSH sur 24 h dépassent 3 fois leur moyenne des 7 derniers jours ;
4. la dernière mesure date de plus de 2 heures, ou un fichier est absent ou illisible.

S'il n'y a rien à signaler, réponds exactement « RAS » et rien d'autre.
Sinon, réponds en 6 lignes maximum : chaque problème avec les chiffres (IP, utilisateur, heure) et une action recommandée.`,
  },
};

/** Champs d'une tâche créée à partir d'un modèle. */
export function templateTask(key) {
  const t = TEMPLATES[key];
  if (!t) return null;
  const { summary, requires, ...task } = t;
  return { ...task, created_via: 'template' };
}

// Compatibilité : ancien nom utilisé par scripts/seed-example.js.
export const DISK_TASK = templateTask('disk');
