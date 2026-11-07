/**
 * Tâche d'exemple : surveillance du disque et des données Docker.
 * Les mesures sont produites sur l'hôte par host/ronde-metrics.sh et montées
 * en lecture seule dans /host-metrics : Claude n'a besoin que de l'outil Read,
 * sans socket Docker ni privilège.
 */
export const DISK_TASK = {
  name: 'Surveillance disque et Docker',
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
};
