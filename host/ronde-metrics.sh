#!/usr/bin/env bash
# Mesures disque/Docker pour la tâche d'exemple de ronde.
# À lancer SUR L'HÔTE (cron), pas dans le conteneur : le conteneur ne reçoit
# que le résultat, en lecture seule, sans socket Docker ni privilège.
#
#   */15 * * * * /chemin/ronde/host/ronde-metrics.sh /chemin/ronde/host-metrics
#
# Écrit :
#   metrics.txt  : dernière mesure lisible (df, du /var/lib/docker, docker system df)
#   history.csv  : timestamp,root_used_pct,root_avail_gb,docker_bytes (7 jours glissants)
set -euo pipefail
export LC_ALL=C

OUT_DIR="${1:-$(dirname "$0")/../host-metrics}"
DOCKER_DIR="${DOCKER_DIR:-/var/lib/docker}"
mkdir -p "$OUT_DIR"
chmod 755 "$OUT_DIR"

now="$(date -Iseconds)"
docker_bytes="$(sudo -n du -sb "$DOCKER_DIR" 2>/dev/null | cut -f1 || true)"
read -r root_pct root_avail < <(df -BG --output=pcent,avail / | tail -1 | tr -d '%G')

tmp="$(mktemp "$OUT_DIR/.metrics.XXXXXX")"
{
  echo "Mesure du $now sur $(hostname)"
  echo
  echo "== df -h =="
  df -h -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null || df -h
  echo
  echo "== Taille de $DOCKER_DIR =="
  if [ -n "$docker_bytes" ]; then
    echo "$docker_bytes octets ($(numfmt --to=iec "$docker_bytes"))"
  else
    echo "indisponible (sudo -n du requis)"
  fi
  echo
  echo "== docker system df =="
  docker system df 2>&1 || echo "indisponible"
} > "$tmp"
chmod 644 "$tmp"
mv "$tmp" "$OUT_DIR/metrics.txt"

history="$OUT_DIR/history.csv"
[ -f "$history" ] || echo "timestamp,root_used_pct,root_avail_gb,docker_bytes" > "$history"
echo "$now,$root_pct,$root_avail,${docker_bytes:-}" >> "$history"
# 7 jours à une mesure / 15 min = 672 lignes + en-tête
{ head -1 "$history"; tail -n +2 "$history" | tail -672; } > "$history.tmp" && mv "$history.tmp" "$history"
chmod 644 "$history"
