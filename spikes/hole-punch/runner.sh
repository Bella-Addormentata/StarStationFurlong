#!/usr/bin/env bash
# 🧪 The GitHub machine's side of the hole-punch test (probe branch, never to
# merge). GitHub's machines sit behind a NAT that gives every destination its
# own outside port, the case the DHT knock has not met yet (TODO "🚪 The DHT
# knock, follow-ups" point 1). One run is one side of one test:
#
#   ROLE=guest  the owner's computer holds a room; this machine opens the
#               invite and dials, knocking through the DHT when nobody answers.
#   ROLE=host   this machine holds a room; the owner's computer dials it.
#
# The run's log is public, so:
#   - every line of the node, the page script and the dev server passes `mask`,
#     which blanks IPv4 and IPv6 addresses, long hex and long base64;
#   - an invite crosses only sealed: RSA-OAEP over a fresh AES-256 key. A guest
#     publishes its public key on the io branch and waits there for its sealed
#     invite; a host seals its invite to GUEST_PUB from config.env.
#   - the plain invite stays in $RUNNER_TEMP and is never printed.
set -uo pipefail

# shellcheck source=/dev/null
source spikes/hole-punch/config.env
APP=prototypes/0.29.0-core-loop-demo
IO_BRANCH=claude/hole-punch-io
RUN="run-${GITHUB_RUN_ID}"
OUT="$RUNNER_TEMP/hp"
mkdir -p "$OUT"
say() { echo "[$(date -u +%H:%M:%S)Z] $*"; }

mask() {
  sed -u -E \
    -e 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<v4>/g' \
    -e 's/([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}/<v6>/g' \
    -e 's/[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{1,4})*::([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{0,4}/<v6>/g' \
    -e 's/[0-9a-fA-F]{40,}/<hex>/g' \
    -e 's/[A-Za-z0-9+\/_-]{43,}={0,2}/<b64>/g'
}

# --- the io branch: small files under run-<id>/ -----------------------------
io_put() { # name file
  local wt="$OUT/io"
  for i in 1 2 3 4 5; do
    rm -rf "$wt"; git worktree prune
    git fetch -q origin "+refs/heads/$IO_BRANCH:refs/remotes/origin/$IO_BRANCH" && git worktree add -q --detach "$wt" "origin/$IO_BRANCH" || { sleep 3; continue; }
    mkdir -p "$wt/$RUN" && cp "$2" "$wt/$RUN/$1"
    if (cd "$wt" && git add -A && git -c user.name=hole-punch-probe -c user.email=noreply@github.com commit -q -m "$RUN: $1" && git push -q origin "HEAD:$IO_BRANCH"); then
      git worktree remove --force "$wt"; return 0
    fi
    sleep 3
  done
  return 1
}
io_get() { # name dest
  git fetch -q origin "+refs/heads/$IO_BRANCH:refs/remotes/origin/$IO_BRANCH" 2>/dev/null && git show "origin/$IO_BRANCH:$RUN/$1" > "$2" 2>/dev/null
}

# --- sealing -----------------------------------------------------------------
seal() { # pubkey plain prefix
  openssl rand -hex 32 > "$OUT/k"
  openssl pkeyutl -encrypt -pubin -inkey "$1" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -in "$OUT/k" | base64 -w0 > "$3.key.b64"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$2" -pass "file:$OUT/k" | base64 -w0 > "$3.data.b64"
  rm -f "$OUT/k"
}
unseal() { # key.b64 data.b64 out
  # A key sealed on Windows ends "\r\n" (its openssl writes text mode); the
  # password is the hex alone, so the "\r" goes before it is used.
  base64 -d "$1" | openssl pkeyutl -decrypt -inkey "$OUT/me.key" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 | tr -d '\r' > "$OUT/k" &&
    base64 -d "$2" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$OUT/k" > "$3"
  local ok=$?
  rm -f "$OUT/k"
  return $ok
}

cleanup() {
  [ -n "${DRILL_PID:-}" ] && kill "$DRILL_PID" 2>/dev/null
  [ -n "${VITE_PID:-}" ] && kill "$VITE_PID" 2>/dev/null
  [ -n "${NODE_PID:-}" ] && kill "$NODE_PID" 2>/dev/null
  rm -f "$OUT/invite.txt" "$OUT/me.key"
}
trap cleanup EXIT

say "role=$ROLE knock=$KNOCK minutes=$MINUTES run=$RUN"

# --- the node: as the knock proof ran it (no chain lane, no mDNS, no relay) --
export SSF_NO_CHIA_LANE=1 SSF_NO_MDNS=1 SSF_IROH_PORT=44452
unset SSF_EXTERNAL_ADDRS
[ "$KNOCK" = off ] && export SSF_DHT_KNOCK=0
mkdir -p "$OUT/node"
( cd "$OUT/node" && exec stdbuf -oL -eL "$GITHUB_WORKSPACE/$APP/ssf-p2p-node/target/release/ssf-p2p-node" ) > >(mask > "$OUT/node.log") 2>&1 &
NODE_PID=$!
for _ in $(seq 1 120); do curl -sf -o /dev/null http://127.0.0.1:8080/api/fingerprint && break; sleep 1; done
curl -sf -o /dev/null http://127.0.0.1:8080/api/fingerprint || { say "the node did not answer on 8080"; tail -40 "$OUT/node.log"; exit 1; }
say "node up"

# --- the page's dev server ---------------------------------------------------
( cd "$APP" && exec npx vite --port 5173 --strictPort ) > >(mask > "$OUT/vite.log") 2>&1 &
VITE_PID=$!
for _ in $(seq 1 120); do curl -sf -o /dev/null http://localhost:5173/ && break; sleep 1; done
curl -sf -o /dev/null http://localhost:5173/ || { say "the dev server did not answer"; tail -20 "$OUT/vite.log"; exit 1; }
say "dev server up"

drill() { ( cd "$APP" && exec node scripts/drill-link.mjs --channel chrome --status-every 15 --minutes "$MINUTES" --profile "$OUT/profile-$ROLE" "$@" ) > >(mask | tee "$OUT/drill.log") 2>&1; }

if [ "$ROLE" = guest ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$OUT/me.key" 2>/dev/null
  openssl pkey -in "$OUT/me.key" -pubout | base64 -w0 > "$OUT/runner.pub.b64"
  io_put runner.pub.b64 "$OUT/runner.pub.b64" || { say "could not write the public key to $IO_BRANCH"; exit 1; }
  say "public key on $IO_BRANCH at $RUN/runner.pub.b64; waiting up to $WAIT_MINUTES min for $RUN/invite.key.b64 + invite.data.b64"
  deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
  until io_get invite.key.b64 "$OUT/invite.key.b64" && io_get invite.data.b64 "$OUT/invite.data.b64"; do
    [ "$(date +%s)" -ge "$deadline" ] && { say "no invite came"; exit 1; }
    sleep 10
  done
  unseal "$OUT/invite.key.b64" "$OUT/invite.data.b64" "$OUT/invite.txt" || { say "the sealed invite did not open"; exit 1; }
  say "invite opened ($(wc -c < "$OUT/invite.txt") bytes); the guest page opens it now"
  drill --role guest --invite "@$OUT/invite.txt"
elif [ "$ROLE" = host ]; then
  [ -n "$GUEST_PUB" ] || { say "ROLE=host needs GUEST_PUB in config.env"; exit 1; }
  echo "$GUEST_PUB" | base64 -d > "$OUT/guest.pub"
  drill --role host --invite-out "$OUT/invite.txt" &
  DRILL_PID=$!
  for _ in $(seq 1 300); do [ -s "$OUT/invite.txt" ] && break; sleep 1; done
  [ -s "$OUT/invite.txt" ] || { say "the host page wrote no invite"; exit 1; }
  sleep 1
  seal "$OUT/guest.pub" "$OUT/invite.txt" "$OUT/invite"
  io_put invite.key.b64 "$OUT/invite.key.b64" && io_put invite.data.b64 "$OUT/invite.data.b64" || { say "could not write the sealed invite"; exit 1; }
  rm -f "$OUT/invite.txt"
  say "sealed invite on $IO_BRANCH at $RUN/; the host page stays $MINUTES min"
  wait "$DRILL_PID"
  DRILL_PID=
else
  say "ROLE must be guest or host"; exit 1
fi

say "--- node log, the lines that tell the story (addresses blanked) ---"
grep -E '📌|🚪|🔗|🤝|PRUNE|knock|Knock|dial|Dial|connect|Connect|linked|External address' "$OUT/node.log" | tail -150
say "--- end ---"
io_put summary.txt <(grep -E '📌|🚪|🔗|🤝|PRUNE|knock|dial|connect|linked' "$OUT/node.log" | tail -150; echo '--- page ---'; tail -60 "$OUT/drill.log") || true
