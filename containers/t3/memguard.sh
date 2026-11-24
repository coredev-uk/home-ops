#!/usr/bin/env bash
# t3-memguard: kills the process using the most anonymous memory once the container's anonymous
# memory reaches 80% of its limit, so one runaway command costs that command and not the whole
# environment. At the limit itself the kernel kills every process in the container at once: the
# kubelet sets memory.oom.group on cgroup v2 (singleProcessOOMKill is node-wide, and off), and the
# container cannot change that (its /sys/fs/cgroup is read-only). The T3 server, the other
# threads' agents and the terminals are all in this one container.
#
# Anonymous memory (memory.stat "anon") is what killing a process gives back; the page cache that
# git and builds leave in memory.current is reclaimed by the kernel on its own and is not counted.
# The entrypoint starts it in the background. It reads memory.stat every 100 ms and walks /proc
# only when over the line; it never kills PID 1 (tini) or itself. What allocates faster than the
# margin (20% of the limit) per 100 ms still reaches the limit, and the kernel then kills all.
set -uo pipefail

cg=/sys/fs/cgroup
percent=80
cooldown=2 # seconds after a kill, so the freed memory shows before the next look

limit=$(<"$cg/memory.max")
if [[ $limit == max ]]; then
  echo "t3-memguard: the container has no memory limit; not watching" >&2
  exit 0
fi
line=$((limit * percent / 100))

gib() { printf '%d.%dGiB' $(($1 / 1073741824)) $(($1 % 1073741824 * 10 / 1073741824)); }

# A wait without a fork: read with a timeout from a pipe that never gets data.
exec {never}<> <(:)
nap() { read -r -t "$1" -u "$never" _ || true; }

anon=0
read_anon() {
  local k v
  anon=0
  while read -r k v; do
    if [[ $k == anon ]]; then
      anon=$v
      return
    fi
  done <"$cg/memory.stat"
}

victim=0
victim_kb=0
biggest() {
  local status pid k v kb
  victim=0
  victim_kb=0
  for status in /proc/[0-9]*/status; do
    pid=${status#/proc/}
    pid=${pid%/status}
    ((pid == 1 || pid == $$)) && continue
    kb=0
    # A process may exit between the glob and the read: it is skipped.
    while read -r k v _; do
      if [[ $k == RssAnon: ]]; then
        kb=$v
        break
      fi
    done 2>/dev/null <"$status" || continue
    if ((kb > victim_kb)); then
      victim=$pid
      victim_kb=$kb
    fi
  done
}

echo "t3-memguard: watching; kills the biggest process when anonymous memory reaches $(gib "$line") ($percent% of $(gib "$limit"))" >&2
while :; do
  read_anon
  if ((anon >= line)); then
    biggest
    if ((victim > 0)); then
      cmd=$(tr '\0' ' ' 2>/dev/null <"/proc/$victim/cmdline" | cut -c1-200)
      if kill -KILL "$victim" 2>/dev/null; then
        echo "t3-memguard: anonymous memory $(gib "$anon") is over $(gib "$line"): killed pid $victim, $(gib $((victim_kb * 1024))) anonymous: ${cmd:-?}" >&2
      fi
    fi
    nap "$cooldown"
    continue
  fi
  nap 0.1
done
