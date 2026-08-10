#!/usr/bin/env bash
# netlat.sh - all-to-all latency/jitter measurement across Vultr regions.
# Orchestrates provisioning, SSH-based measurement, collection, aggregation, teardown.
# Requires: VULTR_API_KEY, jq, curl, ssh, scp, python3, an SSH private key.
# Compatible with bash >= 3.2 (macOS default).
set -euo pipefail

# ---------------- config ----------------
API_BASE="https://api.vultr.com/v2"
SSH_KEY_PATH="${NETLAT_SSH_KEY:-$HOME/.ssh/id_ed25519_VultrAug022026}"
SSH_KEY_PUB="${NETLAT_SSH_KEY_PUB:-$SSH_KEY_PATH.pub}"
SSH_USER="${NETLAT_SSH_USER:-root}"
MIN_REGIONS="${NETLAT_MIN_REGIONS:-2}"
PACKETS="${NETLAT_PACKETS:-300}"
INTERVAL="${NETLAT_INTERVAL:-0.2}"
PROVISION_TIMEOUT="${NETLAT_PROVISION_TIMEOUT:-300}"   # sec
SSH_TIMEOUT="${NETLAT_SSH_TIMEOUT:-300}"               # sec
MEASURE_TIMEOUT="${NETLAT_MEASURE_TIMEOUT:-600}"       # sec
CREATE_THROTTLE="${NETLAT_CREATE_THROTTLE:-1}"         # sec between creates
MAX_INSTANCES="${NETLAT_MAX_INSTANCES:-30}"             # max concurrent instances (account limit)
RUN_ID="$(date +%Y%m%d-%H%M%S)"
TAG="netlat-$RUN_ID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/runs/run-$RUN_ID"
RAW_DIR="$DATA_DIR/raw"
# tuple arrays (key:value, colon-separated) - bash 3.2 compatible
REGIONS=()      # region codes
PLAN_MAP=()     # region:plan
PROVISIONED=()  # region:instance_id
IP_OF=()        # region:ip  (active)
CONFIRMED=()    # region:ip  (ssh reachable)
GROUP_A=()      # phase groups (region:plan)
GROUP_B=()
GROUP_C=()
PHASE_LIST=()   # region:plan pairs for the current phase
NEXT_REGION=0   # index of next PHASE_LIST entry to provision (phase cursor)
PHASE=0         # current phase number
PHASE_DIR=""    # raw subdir for the current phase (ab/ac/bc/all)

log()  { echo "[$(date +%H:%M:%S)] $*"; }
die()  { log "FATAL: $*"; exit 1; }

# arg parsing (die is defined above)
KEEP_INSTANCES=0
REGIONS_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP_INSTANCES=1 ;;
    --regions) shift; REGIONS_OVERRIDE="$1" ;;
    *) die "unknown arg: $1" ;;
  esac
  shift
done

# ---------------- Vultr API helper (retry on 429/5xx) ----------------
api() {
  local method="$1" path="$2" data="${3:-}"
  local tmp_body code attempt
  tmp_body="$(mktemp)"
  for attempt in $(seq 1 6); do
    code="$(curl -sS -o "$tmp_body" -w '%{http_code}' -X "$method" "$API_BASE$path" \
      -H "Authorization: Bearer $VULTR_API_KEY" -H "Content-Type: application/json" \
      ${data:+--data "$data"} 2>/dev/null)"
    if [ "$code" = 200 ] || [ "$code" = 202 ] || [ "$code" = 204 ]; then
      cat "$tmp_body"; rm -f "$tmp_body"; return 0
    fi
    if [ "$code" = 429 ] || [ "$code" -ge 500 ]; then
      log "  api $method $path -> $code, retry $attempt (backoff)" >&2
      sleep "$((attempt * 2))"; continue
    fi
    log "  api $method $path -> $code: $(tr -d '\n' < "$tmp_body")" >&2
    rm -f "$tmp_body"; return 1
  done
  rm -f "$tmp_body"; return 1
}

ssh_run() {  # ssh_run <ip> <remote-command>
  ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=8 \
      -o ServerAliveInterval=10 -o ServerAliveCountMax=6 -i "$SSH_KEY_PATH" \
      "$SSH_USER@$1" "$2"
}

# cheapest_plan <region> [exclude-plan-id] -> echoes the cheapest plan id with
# >=1GB RAM currently available in <region> (availability re-fetched live), or
# empty string if none. Prices come from PLANS_JSON (fetched in preflight).
cheapest_plan() {
  local region="$1" exclude="${2:-}" avail_resp avail p
  avail_resp="$(api GET "/regions/$region/availability")" || return 1
  avail="$(echo "$avail_resp" | jq -r '.available_plans[]')"
  p="$(echo "$PLANS_JSON" | jq -r --argjson ids "$(echo "$avail" | jq -R -s 'split("\n")[:-1]')" \
      --arg ex "$exclude" \
      '[.plans[] | select(.id as $p2 | $ids | index($p2)) | select(.id != $ex) | select(.ram >= 1024)] | sort_by(.monthly_cost) | .[0].id')"
  echo "$p"
}

make_instance_body() {  # make_instance_body <region> <plan>
  jq -n --arg r "$1" --arg p "$2" --argjson os "$OS_ID" \
    --arg s "$SSH_KEY_ID" --arg hn "netlat-$1" --arg tag "$TAG" \
    '{region:$r, plan:$p, os_id:$os, sshkey_id:[$s], hostname:$hn, tag:$tag}'
}

create_with_retries() {  # create_with_retries <region> <plan> [label] -> echoes instance id
  local region="$1" plan="$2" label="${3:-}" body resp id attempt
  body="$(make_instance_body "$region" "$plan")"
  for attempt in 1 2 3; do
    if resp="$(api POST /instances "$body")"; then
      id="$(echo "$resp" | jq -r '.instance.id')"
      echo "$id"
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      log "  $region ${label:+$label }attempt $attempt/3 failed, retrying in $((attempt * 5))s" >&2
      sleep "$((attempt * 5))"
    fi
  done
  return 1
}

# ---------------- Phase 0: preflight ----------------
preflight() {
  [ -n "${VULTR_API_KEY:-}" ] || die "VULTR_API_KEY not set"
  for tool in jq curl ssh scp python3; do
    command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
  done
  [ -f "$SSH_KEY_PATH" ] || die "SSH private key not found: $SSH_KEY_PATH"
  [ -f "$SSH_KEY_PUB"  ] || die "SSH public key not found:  $SSH_KEY_PUB"

  mkdir -p "$DATA_DIR" "$RAW_DIR"
  log "run $RUN_ID (tag=$TAG) -> $DATA_DIR"

  # status feed snapshot + risk triage
  if curl -sS --max-time 20 -o "$DATA_DIR/status_snapshot.json" https://status.vultr.com/status.json; then
    jq -r '[.regions | to_entries[] | select(.key!="global") |
            select((.value.alerts // []) | any(.status=="ongoing")) | .key] | .[]' \
      "$DATA_DIR/status_snapshot.json" > "$DATA_DIR/at_risk.txt" || true
    if [ -s "$DATA_DIR/at_risk.txt" ]; then
      log "  at-risk regions (advisory): $(tr '\n' ' ' < "$DATA_DIR/at_risk.txt")"
    else
      log "  no ongoing alerts in status feed"
    fi
  else
    log "  WARN: could not fetch status.json (continuing)"
  fi

  # region list (authoritative: locations.json; fallback: status.json)
  if [ -n "$REGIONS_OVERRIDE" ]; then
    IFS=, read -ra REGIONS <<< "$REGIONS_OVERRIDE"
  elif [ -f "$SCRIPT_DIR/locations.json" ]; then
    while IFS= read -r r; do REGIONS+=("$r"); done < <(jq -r '.regions[].code' "$SCRIPT_DIR/locations.json")
  else
    while IFS= read -r r; do REGIONS+=("$r"); done < <(jq -r '.regions | to_entries[] | select(.key!="global") | .key' \
      "$DATA_DIR/status_snapshot.json" 2>/dev/null || true)
  fi
  [ "${#REGIONS[@]}" -ge 2 ] || die "need >=2 regions to measure"
  log "  regions: ${#REGIONS[@]} (${REGIONS[*]})"

  # OS: newest Alpine x64
  OS_ID="$(api GET /os | jq -r '[.os[] | select(.family=="alpinelinux" and .arch=="x64")] | sort_by(.id) | reverse | .[0].id')"
  [ -n "$OS_ID" ] || die "could not determine Alpine os_id"
  log "  os_id=$OS_ID"

  # cheap plan per region (cheapest plan available in each region; latency
  # measurement is plan-independent, so no need for a plan common to all)
  PLANS_JSON="$(api GET /plans)"
  for region in "${REGIONS[@]}"; do
    if p="$(cheapest_plan "$region")"; then
      if [ -n "$p" ]; then
        PLAN_MAP+=("$region:$p")
      else
        log "  skip $region: no eligible plan"
      fi
    else
      log "  skip $region: availability check failed"
    fi
  done

  # ensure SSH key registered; reuse if matching public key already exists
  SSH_KEY_ID="$(api GET /ssh-keys | jq -r --arg k "$(tr -d '\n' < "$SSH_KEY_PUB")" \
    '.ssh_keys[] | select(.ssh_key == $k) | .id' | head -1)"
  if [ -z "${SSH_KEY_ID:-}" ]; then
    SSH_KEY_ID="$(api POST /ssh-keys "$(jq -n --arg n "netlat-$RUN_ID" --arg k "$(tr -d '\n' < "$SSH_KEY_PUB")" '{name:$n,ssh_key:$k}')" | jq -r '.ssh_key.id')"
    log "  registered SSH key $SSH_KEY_ID"
  else
    log "  reusing SSH key $SSH_KEY_ID"
  fi
}

# ---------------- Phase 1: provision (per phase) ----------------
# Provisions the current PHASE_LIST (region:plan pairs) from the NEXT_REGION
# cursor, at most MAX_INSTANCES at a time. With --keep, everything is
# provisioned in one phase over the full PLAN_MAP.
provision_chunk() {
  local region plan id alt pair budget remaining n made
  remaining=$(( ${#PHASE_LIST[@]} - NEXT_REGION ))
  [ "$remaining" -gt 0 ] || return 0
  if [ "$KEEP_INSTANCES" = 1 ]; then
    budget=$remaining
  else
    budget=$(( MAX_INSTANCES < remaining ? MAX_INSTANCES : remaining ))
  fi
  log "provisioning phase ${PHASE}: ${budget} instances (${remaining} remaining)..."
  n=0; made=0
  while [ "$n" -lt "$budget" ]; do
    pair="${PHASE_LIST[$NEXT_REGION]}"
    NEXT_REGION=$((NEXT_REGION + 1))
    region="${pair%%:*}"; plan="${pair#*:}"
    if id="$(create_with_retries "$region" "$plan")"; then
      PROVISIONED+=("$region:$id")
      made=$((made + 1))
      log "  $region -> $id (plan $plan)"
    else
      # 3 failed attempts: re-check availability and retry with the cheapest
      # plan available at the time of the call (excluding the failed plan)
      log "  $region create failed 3x with plan $plan; re-checking availability..."
      if alt="$(cheapest_plan "$region" "$plan")" && [ -n "$alt" ]; then
        log "  $region fallback to plan $alt (cheapest available now)"
        if id="$(create_with_retries "$region" "$alt" "fallback")"; then
          PROVISIONED+=("$region:$id")
          made=$((made + 1))
          log "  $region -> $id (fallback plan $alt)"
        else
          log "  $region FAILED to provision after 3 attempts (skipping)"
        fi
      else
        log "  $region no alternative plan available (skipping)"
      fi
    fi
    n=$((n + 1))
    sleep "$CREATE_THROTTLE"
  done
  [ "$made" -gt 0 ] || die "no instances provisioned in phase ${PHASE}"
}

# ---------------- Phase 2: wait for active + SSH ----------------
wait_ready() {
  local deadline region iid st ip all_ok resp pair ssh_deadline chunk_min
  chunk_min=$(( MIN_REGIONS < ${#PROVISIONED[@]} ? MIN_REGIONS : ${#PROVISIONED[@]} ))
  [ "$chunk_min" -gt 0 ] || chunk_min=1
  log "waiting for instances to become active (${PROVISION_TIMEOUT}s)..."
  deadline=$((SECONDS + PROVISION_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    all_ok=1
    IP_OF=()
    resp="$(api GET "/instances?tag=$TAG&per_page=100")"
    for pair in "${PROVISIONED[@]}"; do
      region="${pair%%:*}"; iid="${pair#*:}"
      st="$(echo "$resp" | jq -r --arg id "$iid" \
        '.instances[] | select(.id==$id) | "\(.status) \(.power_status) \(.main_ip)"' 2>/dev/null || true)"
      ip="$(echo "$st" | awk '{print $3}')"
      if [ "$(echo "$st" | awk '{print $1" "$2}')" = "active running" ] && [ -n "$ip" ] && [ "$ip" != "0.0.0.0" ]; then
        IP_OF+=("$region:$ip")
      else
        all_ok=0
      fi
    done
    [ $all_ok = 1 ] && break
    sleep 5
  done
  [ "${#IP_OF[@]}" -ge "$chunk_min" ] || die "only ${#IP_OF[@]} active; abort (min=$chunk_min)"

  log "waiting for SSH on ${#IP_OF[@]} hosts (${SSH_TIMEOUT}s)..."
  ssh_deadline=$((SECONDS + SSH_TIMEOUT))
  while [ $SECONDS -lt $ssh_deadline ]; do
    all_ok=1
    for pair in "${IP_OF[@]}"; do
      region="${pair%%:*}"; ip="${pair#*:}"
      # skip if already confirmed
      already=0
      for cp in "${CONFIRMED[@]+"${CONFIRMED[@]}"}"; do [ "$cp" = "$pair" ] && already=1; done
      [ $already = 1 ] && continue
      if ssh_run "$ip" "true" >/dev/null 2>&1; then
        CONFIRMED+=("$pair")
        log "  $region up ($ip)"
      else
        all_ok=0
      fi
    done
    [ $all_ok = 1 ] && break
    sleep 5
  done
  [ "${#CONFIRMED[@]}" -ge "$chunk_min" ] || die "only ${#CONFIRMED[@]} SSH-reachable; abort (min=$chunk_min)"
  log "confirmed live hosts: ${#CONFIRMED[@]}"
}

# ---------------- Phase 2.5: remote package bootstrap (Alpine) ----------------
# Alpine images are minimal: install python3 (runner) and iputils
# (iputils ping; busybox ping lacks -D). Idempotent; retried per host.
bootstrap_remote() {
  local pair ip pids p attempt
  log "bootstrapping ${#CONFIRMED[@]} hosts (apk add python3 iputils)..."
  pids=()
  for pair in "${CONFIRMED[@]}"; do
    ip="${pair#*:}"
    (
      attempt=0
      while ! ssh_run "$ip" "apk add --no-cache python3 iputils >/dev/null 2>&1"; do
        attempt=$((attempt + 1))
        [ "$attempt" -ge 3 ] && exit 1
        sleep 5
      done
    ) &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || log "  WARN: package install failed on one host"; done
}

# ---------------- Phases 3-5: push, measure, collect ----------------
run_measurement() {
  local region ip plan pids p deadline alive
  # manifest + peer list (only confirmed hosts). instances.tsv accumulates
  # across phases for aggregation; peers.txt is reset per phase. Results land
  # in $RAW_DIR/$PHASE_DIR/ so each phase's pairs are kept for merging.
  mkdir -p "$RAW_DIR/$PHASE_DIR"
  : > "$DATA_DIR/peers.txt"
  for pair in "${CONFIRMED[@]}"; do
    region="${pair%%:*}"; ip="${pair#*:}"
    plan=""
    for pp in "${PLAN_MAP[@]}"; do [ "${pp%%:*}" = "$region" ] && plan="${pp#*:}"; done
    iid=""
    for pr in "${PROVISIONED[@]}"; do [ "${pr%%:*}" = "$region" ] && iid="${pr#*:}"; done
    printf '%s\t%s\t%s\t%s\tconfirmed\n' "$region" "$iid" "$ip" "$plan" \
      >> "$DATA_DIR/instances.tsv"
    echo "$ip" >> "$DATA_DIR/peers.txt"
  done

  # embed worker
  cat > "$DATA_DIR/measure.py" <<'PYEOF'
import subprocess, re, sys, statistics, concurrent.futures, os
packets=int(os.environ.get("NETLAT_PACKETS","300")); interval=os.environ.get("NETLAT_INTERVAL","0.2")
peers=[l.strip() for l in open(sys.argv[1]) if l.strip()]
out=open("results.csv","w"); out.write("dst,min,avg,max,stddev,jitter,loss_pct,sent,received\n")
def run(dst):
    p=subprocess.Popen(["ping","-i",interval,"-c",str(packets),"-D",dst],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    times=[]
    for line in p.stdout:
        m=re.search(r"time=([0-9.]+)\s*ms", line)
        if m: times.append(float(m.group(1)))
    p.wait()
    if not times:
        return dst,0,0,0,0,0,100.0,packets,0
    jitter=statistics.mean(abs(times[i]-times[i-1]) for i in range(1,len(times)))
    loss=100.0*(packets-len(times))/packets
    return dst,min(times),statistics.mean(times),max(times),statistics.pstdev(times),jitter,loss,packets,len(times)
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
    for row in ex.map(run, peers):
        out.write(",".join(str(x) for x in row)+"\n")
out.close(); print("done", len(peers), "peers")
PYEOF

  log "pushing code to ${#CONFIRMED[@]} hosts..."
  pids=()
  for pair in "${CONFIRMED[@]}"; do
    ip="${pair#*:}"
    ( ssh_run "$ip" "mkdir -p /tmp/netlat" &&
      scp -q -o StrictHostKeyChecking=accept-new -o BatchMode=yes -i "$SSH_KEY_PATH" \
          "$DATA_DIR/measure.py" "$DATA_DIR/peers.txt" "$SSH_USER@$ip:/tmp/netlat/" ) &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || log "  WARN: push failed on one host"; done

  log "running measurement on ${#CONFIRMED[@]} hosts (${MEASURE_TIMEOUT}s cap)..."
  pids=()
  for pair in "${CONFIRMED[@]}"; do
    ip="${pair#*:}"
    ( ssh_run "$ip" \
        "cd /tmp/netlat && NETLAT_PACKETS=$PACKETS NETLAT_INTERVAL=$INTERVAL python3 measure.py peers.txt" ) &
    pids+=($!)
  done
  deadline=$((SECONDS + MEASURE_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    alive=0
    for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ $alive = 0 ] && break
    sleep 5
  done
  for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true

  log "collecting results..."
  for pair in "${CONFIRMED[@]}"; do
    region="${pair%%:*}"; ip="${pair#*:}"
    if scp -q -o StrictHostKeyChecking=accept-new -o BatchMode=yes -i "$SSH_KEY_PATH" \
        "$SSH_USER@$ip:/tmp/netlat/results.csv" "$RAW_DIR/$PHASE_DIR/$region.csv" 2>/dev/null; then
      log "  $region results collected"
    else
      log "  $region collection FAILED"
    fi
  done
}

# ---------------- Phase 6: aggregate ----------------
aggregate() {
  cat > "$DATA_DIR/aggregate.py" <<'PYEOF'
import csv, json, os
base=os.path.dirname(os.path.abspath(__file__))
regions, ip2region = {}, {}
with open(os.path.join(base,"instances.tsv")) as f:
    for line in f:
        r,i,ip,p,s=line.rstrip().split("\t")
        regions[r]={"id":i,"ip":ip,"plan":p,"state":s}
        ip2region[ip]=r
metric={m:{} for m in ("latency","jitter","loss")}
meta={}
for root, _, files in os.walk(os.path.join(base,"raw")):
    for fname in files:
        if not fname.endswith(".csv"): continue
        region=fname[:-4]
        with open(os.path.join(root,fname)) as f:
            for row in csv.DictReader(f):
                dst=ip2region.get(row["dst"])
                if not dst: continue
                metric["latency"].setdefault(region,{})[dst]=float(row["avg"])
                metric["jitter"].setdefault(region,{})[dst]=float(row["jitter"])
                metric["loss"].setdefault(region,{})[dst]=float(row["loss_pct"])
                meta.setdefault((region,dst),row)
for name,mat in metric.items():
    path=os.path.join(base,f"{name}_matrix.csv")
    with open(path,"w",newline="") as f:
        w=csv.writer(f)
        w.writerow(["src"]+list(regions))
        for src in regions:
            w.writerow([src]+[mat.get(src,{}).get(dst,"") for dst in regions])
    print("wrote",path)
with open(os.path.join(base,"manifest.json"),"w") as f:
    json.dump({"regions":regions,"status":"ok"},f,indent=2)
print("done")
PYEOF
  (cd "$DATA_DIR" && python3 aggregate.py)
  log "aggregation complete -> $DATA_DIR/{latency,jitter,loss}_matrix.csv"
}

# ---------------- Phase 7: teardown ----------------
teardown() {
  [ "$KEEP_INSTANCES" = 1 ] && { log "KEEP set - leaving instances up"; return; }
  [ "${#PROVISIONED[@]}" -eq 0 ] && { log "nothing provisioned - skipping teardown"; return; }
  local resp ids id
  log "tearing down instances (tag=$TAG)..."
  resp="$(api GET "/instances?tag=$TAG&per_page=100" 2>/dev/null || true)"
  ids=()
  while IFS= read -r id; do ids+=("$id"); done < <(echo "$resp" | jq -r '.instances[].id' 2>/dev/null || true)
  for id in "${ids[@]+"${ids[@]}"}"; do
    api DELETE "/instances/$id" >/dev/null 2>&1 || log "  WARN: delete $id failed"
  done
  log "teardown complete (${#ids[@]} instances)"
}

# per-phase teardown: frees the account quota before the next phase
teardown_chunk() {
  [ "$KEEP_INSTANCES" = 1 ] && return 0
  [ "${#PROVISIONED[@]}" -eq 0 ] && return 0
  local pair id
  log "tearing down ${#PROVISIONED[@]} instances (phase ${PHASE})..."
  for pair in "${PROVISIONED[@]}"; do
    id="${pair#*:}"
    api DELETE "/instances/$id" >/dev/null 2>&1 || log "  WARN: delete $id failed"
  done
  PROVISIONED=()
  IP_OF=()
  CONFIRMED=()
  log "  phase teardown complete"
}

# ---------------- group partitioning + phase runner ----------------
# Divides PLAN_MAP into three groups (A/B/C) of roughly equal size so the
# phases AB, AC, BC cover every pair of regions exactly once.
partition_groups() {
  local n gsize i pair
  n=${#PLAN_MAP[@]}
  gsize=$(( (n + 2) / 3 ))
  GROUP_A=(); GROUP_B=(); GROUP_C=()
  i=0
  for pair in "${PLAN_MAP[@]}"; do
    if [ "$i" -lt "$gsize" ]; then
      GROUP_A+=("$pair")
    elif [ "$i" -lt $((gsize * 2)) ]; then
      GROUP_B+=("$pair")
    else
      GROUP_C+=("$pair")
    fi
    i=$((i + 1))
  done
  log "  groups: A(${#GROUP_A[@]}) B(${#GROUP_B[@]}) C(${#GROUP_C[@]})"
}

run_phase() {  # run_phase <raw-dir-label> <group-a-var> <group-b-var>
  local label="$1" g1="$2" g2="$3"
  PHASE=$((PHASE + 1))
  PHASE_DIR="$label"
  eval 'PHASE_LIST=( "${'"$g1"'[@]}" "${'"$g2"'[@]}" )'
  NEXT_REGION=0
  log "=== phase $PHASE: $label (${#PHASE_LIST[@]} regions) ==="
  provision_chunk
  wait_ready
  bootstrap_remote
  run_measurement
  teardown_chunk
}

# ---------------- main ----------------
main() {
  trap 'teardown' EXIT
  preflight
  if [ "$KEEP_INSTANCES" = 1 ]; then
    PHASE=1
    PHASE_DIR="all"
    PHASE_LIST=("${PLAN_MAP[@]}")
    NEXT_REGION=0
    provision_chunk
    wait_ready
    bootstrap_remote
    run_measurement
  else
    partition_groups
    [ "${#GROUP_A[@]}" -gt 0 ] && [ "${#GROUP_B[@]}" -gt 0 ] && [ "${#GROUP_C[@]}" -gt 0 ] \
      || die "need at least 3 regions for the phased all-pairs schedule"
    run_phase "ab" GROUP_A GROUP_B
    run_phase "ac" GROUP_A GROUP_C
    run_phase "bc" GROUP_B GROUP_C
  fi
  aggregate
  log "run complete (${PHASE} phases). results in $DATA_DIR/"
}
main "$@"
