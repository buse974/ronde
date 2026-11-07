#!/usr/bin/env bash
# Rapport fail2ban / SSH pour le modèle « Sécurité SSH et fail2ban » de ronde.
# À lancer SUR L'HÔTE (timer systemd ou cron), avec sudo -n disponible :
#
#   ronde-fail2ban.sh /chemin/ronde/host-metrics
#
# Écrit :
#   fail2ban.txt          : état, jails, bans 24 h, échecs SSH 24 h, connexions SSH réussies
#   fail2ban-history.csv  : timestamp,bans_24h,echecs_ssh_24h,bannies_actuellement,connexions_24h (7 jours)
set -euo pipefail
export LC_ALL=C

OUT_DIR="${1:-$(dirname "$0")/../host-metrics}"
F2B_LOG="${F2B_LOG:-/var/log/fail2ban.log}"
SSH_UNIT="${SSH_UNIT:-sshd}"
mkdir -p "$OUT_DIR"
chmod 755 "$OUT_DIR"

now="$(date -Iseconds)"
since_log="$(date -d '24 hours ago' '+%Y-%m-%d %H:%M:%S')"

# Empreintes des clés autorisées → commentaire, pour reconnaître les connexions.
declare -A KEYS=()
for home in /root /home/*; do
  ak="$home/.ssh/authorized_keys"
  sudo -n test -f "$ak" 2>/dev/null || continue
  while read -r bits fp comment _; do
    [ -n "${fp:-}" ] && KEYS["$fp"]="${comment:-sans commentaire} ($(basename "$home"))"
  done < <(sudo -n ssh-keygen -lf "$ak" 2>/dev/null || true)
done

ssh_journal="$(sudo -n journalctl -u "$SSH_UNIT" --since '24 hours ago' --no-pager -o short-iso 2>/dev/null || true)"

# Les noms d'utilisateur invalides sont journalisés tels quels (espaces compris) :
# on n'analyse que des lignes entièrement ancrées sur le format de sshd, et l'IP
# est la DERNIÈRE occurrence « from X port N » de la ligne.
PREFIX='^[^ ]+ [^ ]+ sshd(-session)?\[[0-9]+\]: '
fail_ips="$(sed -nE "s/${PREFIX}(Failed password for .* from ([0-9a-fA-F:.]+) port [0-9]+ ssh2|Invalid user .* from ([0-9a-fA-F:.]+) port [0-9]+)\$/\3\4/p" <<<"$ssh_journal")"
failures="$(grep -c . <<<"$fail_ips" || true)"
# Connexions réussies : date, méthode, utilisateur, IP, empreinte (séparés par des tabulations).
accepted="$(sed -nE "s/^([^ ]+) [^ ]+ sshd(-session)?\[[0-9]+\]: Accepted ([a-z-]+) for ([A-Za-z0-9._-]+) from ([0-9a-fA-F:.]+) port [0-9]+ ssh2(: [A-Z0-9-]+ (SHA256:[A-Za-z0-9+\/=]+))?\$/\1\t\3\t\4\t\5\t\7/p" <<<"$ssh_journal")"
accepted_count="$(grep -c . <<<"$accepted" || true)"

bans_24h=0
if sudo -n test -r "$F2B_LOG" 2>/dev/null; then
  bans_24h="$(sudo -n awk -v s="$since_log" '($1" "substr($2,1,8)) >= s && / Ban /' "$F2B_LOG" | grep -c . || true)"
fi

active="$(systemctl is-active fail2ban 2>/dev/null || true)"
jails="$(sudo -n fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:\s*//p' | tr -d ' ' | tr ',' ' ')"
banned_now=0

tmp="$(mktemp "$OUT_DIR/.fail2ban.XXXXXX")"
{
  echo "Mesure du $now sur $(hostname)"
  echo
  echo "== Service fail2ban =="
  echo "état : ${active:-inconnu}"
  echo "jails : ${jails:-aucune}"
  for j in $jails; do
    st="$(sudo -n fail2ban-client status "$j" 2>/dev/null || true)"
    cur_failed="$(sed -n 's/.*Currently failed:\s*//p' <<<"$st")"
    tot_failed="$(sed -n 's/.*Total failed:\s*//p' <<<"$st")"
    cur_banned="$(sed -n 's/.*Currently banned:\s*//p' <<<"$st")"
    tot_banned="$(sed -n 's/.*Total banned:\s*//p' <<<"$st")"
    banned_now=$((banned_now + ${cur_banned:-0}))
    echo "- $j : bannies actuellement ${cur_banned:-?} (total ${tot_banned:-?}), échecs en cours ${cur_failed:-?} (total ${tot_failed:-?})"
  done
  echo
  echo "== Dernières 24 h =="
  echo "bannissements : $bans_24h"
  echo "échecs SSH : $failures"
  echo
  echo "Top 10 des IP en échec SSH :"
  grep . <<<"$fail_ips" | sort | uniq -c | sort -rn | head -10 || true
  echo
  echo "== Connexions SSH réussies (24 h) : $accepted_count =="
  if [ "$accepted_count" -gt 0 ]; then
    suspicious=""
    normal=""
    while IFS=$'\t' read -r date method user ip fp; do
      key="—"
      flag=""
      if [ "$method" = "publickey" ]; then
        if [ -n "$fp" ] && [ -n "${KEYS[$fp]+x}" ]; then
          key="${KEYS[$fp]}"
        else
          key="CLÉ NON RECONNUE (${fp:-empreinte absente})"
          flag=1
        fi
      else
        flag=1
      fi
      [ "$user" != "fedora" ] && flag=1
      row="$date | $user | $ip | $method | $key"
      if [ -n "$flag" ]; then suspicious+="$row"$'\n'; else normal+="$row"$'\n'; fi
    done <<<"$accepted"
    echo
    echo "-- À examiner (mot de passe, clé inconnue ou autre utilisateur que fedora) : $(grep -c . <<<"$suspicious" || true)"
    echo "date | utilisateur | IP | méthode | clé"
    printf '%s' "$suspicious" | head -50
    echo
    echo "-- Clés reconnues, par clé :"
    printf '%s' "$normal" | awk -F' [|] ' 'NF { n[$5]++ } END { for (k in n) printf "%5d  %s\n", n[k], k }' | sort -rn
    echo
    echo "-- 20 dernières connexions avec clé reconnue :"
    printf '%s' "$normal" | tail -20
  fi
} > "$tmp"
chmod 644 "$tmp"
mv "$tmp" "$OUT_DIR/fail2ban.txt"

history="$OUT_DIR/fail2ban-history.csv"
[ -f "$history" ] || echo "timestamp,bans_24h,echecs_ssh_24h,bannies_actuellement,connexions_24h" > "$history"
echo "$now,$bans_24h,$failures,$banned_now,$accepted_count" >> "$history"
{ head -1 "$history"; tail -n +2 "$history" | tail -672; } > "$history.tmp" && mv "$history.tmp" "$history"
chmod 644 "$history"
