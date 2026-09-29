#!/usr/bin/env python3
"""
NA Full-Mesh Ping/Jitter/Loss Test: Linode North America + 3 existing Contabo VMs.

Scope (per plan):
  * Provision Linode VMs ONLY in North American regions
    (GET /v4/regions filtered to country in {us, ca, mx} +
    "Linodes" in capabilities -- live API is the source of truth,
    so Mexico/Canada regions are included automatically if present).
  * Reuse the 3 existing Contabo VMs (US-central 203582249,
    US-east 203579816, US-west 203582252) READ-ONLY.
    This script NEVER creates, reinstalls, reboots, or cancels
    Contabo instances. Contabo API access is GET-only, enforced
    in code (see ContaboReader).
  * Full mesh across ALL nodes (linode<->linode, contabo<->contabo,
    and cross-provider pairs in both directions).
  * Probe methodology identical to linode-skill mesh_test_v3.py:
    one `ping -c 100 -i 0.1` run per ordered pair -> avg/min/max +
    mdev (jitter) + loss% via icmp_seq dedup. Ping exit code never
    gates the result; SSH/transport failures return None so a
    resume run retries the pair.
  * Linode teardown in a finally block (also on Ctrl-C / crash).
    Contabo nodes are never touched by teardown.

Usage:
  # Safe, costs nothing: list Linode NA regions + Contabo inventory
  python3 scripts/na_linode_contabo_mesh_test.py --list-only

  # 2-region canary first (~5 nodes / 20 pairs, ~10 min)
  python3 scripts/na_linode_contabo_mesh_test.py --regions us-east,ca-central --yes

  # Full NA run (billed: N x g6-nanode-1 hourly while alive)
  python3 scripts/na_linode_contabo_mesh_test.py --yes

  # Remove leftover test Linodes + test firewalls (never touches Contabo)
  python3 scripts/na_linode_contabo_mesh_test.py --cleanup

  # Resume/reuse already-running mesh-na-* Linodes without creating new ones
  python3 scripts/na_linode_contabo_mesh_test.py --skip-provision --yes

Options:
  --yes             Required to provision billable Linode VMs. Without it
                    the script prints what it WOULD do and exits(2).
  --regions SLUGS   Limit Linode side to a comma-separated subset
                    (e.g. --regions us-east,ca-central). Must still be
                    a subset of the live NA set.
  --contabo-ids IDS Comma-separated Contabo instanceIds to use.
                    Default: 203582249,203579816,203579816's siblings
                    (US-central, US-east, US-west canary hosts).
  --skip-provision  Do not create Linodes; reuse running instances
                    tagged mesh-test-na (for resume).
  --list-only       Print Linode NA regions + Contabo inventory, exit 0.
  --cleanup         Destroy tagged Linodes + test firewalls, exit 0.

Credentials (never printed):
  Linode:  LINODE_PAT env var, else ../linode-skill/.env (LINODE_PAT=...)
  Contabo: CONTABO_CLIENT_ID / CONTABO_CLIENT_SECRET / CONTABO_API_USER /
           CONTABO_API_PASSWORD env vars, else contabo-local-secrets.yaml
           (repo root, same default as configuration.yaml)
"""

import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
import uuid

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)  # vultr-map/
REPO_ROOT = os.path.dirname(ROOT)  # contabo_measurement/ (canonical secrets location,
# same default as configuration.yaml's contabo_client_secret_file)

# -- Config (same probe methodology as Linode v3 / Vultr netlat) --
LINODE_TYPE = os.environ.get("NA_MESH_LINODE_TYPE", "g6-nanode-1")
LINODE_IMAGE = os.environ.get("NA_MESH_LINODE_IMAGE", "linode/debian12")
CREATE_BATCH = int(os.environ.get("NA_MESH_CREATE_BATCH", "5"))
PING_COUNT = int(os.environ.get("NA_MESH_PING_COUNT", "100"))
PING_INTERVAL = float(os.environ.get("NA_MESH_PING_INTERVAL", "0.1"))
MESH_TAG = "mesh-test-na"  # distinct from legacy "mesh-test" runs
RESULTS_FILE = os.path.join(SCRIPT_DIR, "na_mesh_results.json")
CSV_FILE = os.path.join(SCRIPT_DIR, "na_mesh_results.csv")
LINODE_KEY_FILE = os.path.join(ROOT, "linode-skill", "linode_mesh_key")
CONTABO_KEY_FILE = os.environ.get(
    "CONTABO_SSH_KEY",
    # Existing VMs were installed (I09 round) with Contabo SSH secret 480525
    # ("vmi3579816-ssh-1"), whose private half lives here -- NOT
    # scripts/contabo_mesh_key (that key belongs to older mesh runs).
    os.path.expanduser("~/.ssh/id_rsa"))
LINODE_ENV_FILE = os.path.join(ROOT, "linode-skill", ".env")
CONTABO_SECRETS_FILE = os.path.join(REPO_ROOT, "contabo-local-secrets.yaml")

# The 3 existing Contabo VMs (LOGS/canary-evidence-I01-I04.md).
# Override with --contabo-ids or CONTABO_INSTANCE_IDS env.
DEFAULT_CONTABO_IDS = os.environ.get("CONTABO_INSTANCE_IDS",
                                     "203582249,203579816,203582252").split(",")

# Linode /v4/regions `country` values for North America (lowercase per API).
NA_COUNTRIES = {"us", "ca", "mx"}

LINODE_BASE = "https://api.linode.com/v4"
CONTABO_TOKEN_URL = ("https://auth.contabo.com/auth/realms/contabo/"
                     "protocol/openid-connect/token")
CONTABO_API_BASE = "https://api.contabo.com"


# ---------------------------------------------------------------------------
# Credentials (values are never printed)
# ---------------------------------------------------------------------------
def load_linode_token():
    token = os.environ.get("LINODE_PAT", "").strip()
    if token:
        return token
    with open(LINODE_ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if k.strip() == "LINODE_PAT":
                    token = v.strip()
    if not token:
        raise SystemExit("missing LINODE_PAT (env or %s)" % LINODE_ENV_FILE)
    return token


def load_contabo_credentials():
    creds = {}
    try:
        import yaml  # type: ignore
        with open(CONTABO_SECRETS_FILE) as f:
            raw = yaml.safe_load(f) or {}
        for k, v in raw.items():
            creds[str(k).strip().upper()] = str(v).strip()
    except FileNotFoundError:
        pass
    except ImportError:
        with open(CONTABO_SECRETS_FILE) as f:
            for line in f:
                if ":" in line and not line.strip().startswith("#"):
                    k, v = line.split(":", 1)
                    creds[k.strip().upper()] = v.strip().strip('"').strip("'")
    out = {
        "client_id": os.environ.get("CONTABO_CLIENT_ID",
                                    creds.get("CONTABO_CLIENT_ID", "")),
        "client_secret": os.environ.get("CONTABO_CLIENT_SECRET",
                                        creds.get("CONTABO_CLIENT_SECRET", "")),
        "username": os.environ.get("CONTABO_API_USER",
                                   creds.get("CONTABO_API_USER", "")),
        "password": os.environ.get("CONTABO_API_PASSWORD",
                                   creds.get("CONTABO_API_PASSWORD", "")),
    }
    missing = [k for k, v in out.items() if not v]
    if missing:
        raise SystemExit("missing Contabo credentials: %s "
                         "(set env or %s)" % (missing, CONTABO_SECRETS_FILE))
    return out


# ---------------------------------------------------------------------------
# Linode API helpers (copied from linode-skill/mesh_test_v3.py)
# ---------------------------------------------------------------------------
class Linode:
    def __init__(self, token):
        self.headers = {"Authorization": "Bearer " + token,
                        "Content-Type": "application/json"}

    def api(self, method, path, data=None, retries=3):
        url = LINODE_BASE + path
        body = json.dumps(data).encode() if data else None
        req = urllib.request.Request(url, data=body,
                                     headers=self.headers, method=method)
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                err_body = ""
                try:
                    err_body = e.read().decode()
                    err = json.loads(err_body)
                    reason = "; ".join(x.get("reason", "")
                                       for x in err.get("errors", []))
                except Exception:
                    reason = err_body[:200]
                if e.code == 429:
                    print("    Rate limited, waiting 15s...", flush=True)
                    time.sleep(15)
                    continue
                if attempt < retries - 1:
                    time.sleep(3)
                    continue
                raise RuntimeError("Linode API error %s: %s" % (e.code, reason))
            except Exception:
                if attempt < retries - 1:
                    time.sleep(3)
                    continue
                raise
        raise RuntimeError("Max retries exceeded")

    def api_get_all(self, path):
        results, page = [], 1
        while True:
            sep = "&" if "?" in path else "?"
            resp = self.api("GET", "%s%spage=%d&page_size=500" % (path, sep, page))
            results.extend(resp.get("data", []))
            if page >= resp.get("pages", 1):
                break
            page += 1
        return results


def get_na_regions(api):
    """Live NA region list: country in {us,ca,mx} + Linodes capability.

    The live API is the source of truth, so Mexico/Canada regions are
    picked up automatically even if absent from older REGION_META snapshots.
    """
    regions = api.api_get_all("/regions")
    na_regions = [
        r for r in regions
        if str(r.get("country", "")).lower() in NA_COUNTRIES
        and "Linodes" in (r.get("capabilities") or [])
    ]
    return sorted(na_regions, key=lambda r: r["id"])


# ---------------------------------------------------------------------------
# Contabo READ-ONLY client.
#
# HARD SAFETY RULE: this class only performs GET requests. Any attempt to
# use POST/PUT/PATCH/DELETE raises immediately, so no code path in this
# script can create, reinstall, reboot, or cancel Contabo VMs.
# ---------------------------------------------------------------------------
class ContaboReader:
    def __init__(self, creds):
        self.creds = creds
        self.token = None
        self.expires_at = 0

    def get_token(self, force=False):
        if not force and self.token and time.time() < self.expires_at - 30:
            return self.token
        data = urllib.parse.urlencode({
            "client_id": self.creds["client_id"],
            "client_secret": self.creds["client_secret"],
            "username": self.creds["username"],
            "password": self.creds["password"],
            "grant_type": "password",
        }).encode()
        req = urllib.request.Request(
            CONTABO_TOKEN_URL, data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.load(r)
        self.token = body["access_token"]
        self.expires_at = time.time() + int(body.get("expires_in", 300))
        return self.token

    def read(self, path, params=None, retries=5):
        """GET-only JSON reader for api.contabo.com (paginated envelope)."""
        url = CONTABO_API_BASE + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        last_err = None
        for attempt in range(retries):
            token = self.get_token(force=(attempt > 0 and last_err == 401))
            req = urllib.request.Request(
                url, method="GET",
                headers={"Authorization": "Bearer " + token,
                         "x-request-id": str(uuid.uuid4()),
                         "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    raw = r.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 0:
                    last_err = 401
                    self.get_token(force=True)
                    continue
                if e.code == 429 or e.code >= 500:
                    time.sleep(min(2 ** attempt, 30))
                    last_err = e.code
                    continue
                try:
                    detail = e.read().decode()[:300]
                except Exception:
                    detail = ""
                raise RuntimeError("Contabo GET %s -> %s: %s" % (path, e.code, detail))
            except (urllib.error.URLError, TimeoutError) as e:
                time.sleep(min(2 ** attempt, 30))
                last_err = e
                continue
        raise RuntimeError("Contabo GET %s failed after %d retries: %r"
                           % (path, retries, last_err))

    def __getattr__(self, name):
        # Block every non-GET accessor: api/post/put/patch/delete/cancel/...
        if name != "read":
            raise AttributeError(
                "ContaboReader is GET-only: '%s' is blocked. "
                "This script must never create, reinstall, reboot, or "
                "cancel Contabo instances." % name)
        raise AttributeError(name)

    def list_all(self, path, size=100):
        out, page = [], 1
        while True:
            resp = self.read(path, params={"page": page, "size": size})
            out.extend(resp.get("data", []))
            pag = resp.get("_pagination", {})
            if page >= int(pag.get("totalPages", 1)):
                break
            page += 1
        return out

    def get_instance(self, instance_id):
        resp = self.read("/v1/compute/instances/%s" % instance_id)
        return resp["data"][0]


def get_contabo_inventory(reader, expected_ids):
    """Resolve the existing Contabo VMs read-only; assert all running + IPv4."""
    nodes = {}
    for iid in expected_ids:
        iid = str(iid).strip()
        if not iid:
            continue
        inst = reader.get_instance(iid)
        status = inst.get("status")
        ip = ((inst.get("ipConfig") or {}).get("v4") or {}).get("ip")
        region = inst.get("region") or inst.get("dataCenter") or "?"
        if status != "running" or not ip:
            raise SystemExit(
                "Contabo instance %s not usable: status=%s ip=%s. "
                "Aborting -- this script never reinstalls or reboots "
                "Contabo VMs; fix the VM manually and re-run." % (iid, status, ip))
        if inst.get("cancelDate"):
            # Scheduled end-of-period cancellation does not block measurement
            # while the VM is running; flag it so the report notes the date.
            print("  WARNING: Contabo instance %s is running but has cancelDate=%s"
                  % (iid, inst.get("cancelDate")), flush=True)
        print("  Contabo %s (%s) running at %s" % (iid, region, ip), flush=True)
        nodes["contabo-%s" % region] = {
            "provider": "contabo",
            "region": region,
            "instance_id": iid,
            "display": inst.get("displayName", ""),
            "ip": ip,
        }
    if len(nodes) != len([i for i in expected_ids if str(i).strip()]):
        raise SystemExit("Contabo inventory mismatch; aborting.")
    return nodes


# ---------------------------------------------------------------------------
# SSH (per-provider key selection)
# ---------------------------------------------------------------------------
SSH_BASE_OPTS = ["-o", "StrictHostKeyChecking=no",
                 "-o", "UserKnownHostsFile=/dev/null",
                 "-o", "GlobalKnownHostsFile=/dev/null",
                 "-o", "LogLevel=ERROR",
                 "-o", "ConnectTimeout=10",
                 "-o", "BatchMode=yes"]


def ssh_exec(ip, key_file, cmd, timeout=60):
    r = subprocess.run(
        ["ssh"] + SSH_BASE_OPTS + ["-i", key_file, "root@%s" % ip, cmd],
        capture_output=True, text=True, timeout=timeout)
    return r.stdout, r.stderr, r.returncode


def wait_ssh(ip, key_file, timeout=300, label=""):
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = subprocess.run(
                ["ssh", "-o", "StrictHostKeyChecking=no",
                 "-o", "UserKnownHostsFile=/dev/null",
                 "-o", "GlobalKnownHostsFile=/dev/null",
                 "-o", "LogLevel=ERROR",
                 "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
                 "-i", key_file, "root@%s" % ip, "echo ok"],
                capture_output=True, timeout=15)
            if r.returncode == 0:
                return True
        except Exception:
            pass
        time.sleep(10)
    print("  SSH FAIL: %s (%s)" % (label, ip), flush=True)
    return False


# ---------------------------------------------------------------------------
# Ping probe (identical methodology to linode-skill/mesh_test_v3.py)
# ---------------------------------------------------------------------------
RE_REPLY = re.compile(r"icmp_seq=(\d+)(?:\s+ttl=\d+)?\s+time[=<]\s*([\d.]+)\s*ms")
RE_RTT = re.compile(r"(?:rtt|round-trip) min/avg/max/(?:mdev|stddev)\s*=\s*"
                    r"([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+)")
RE_RTT_SIMPLE = re.compile(r"min/avg/max\s*=\s*([\d.]+)/([\d.]+)/([\d.]+)")


def parse_ping_output(output, expected_count):
    """Latency stats + jitter (mdev) + loss%; loss always computed.

    Loss comes from per-reply icmp_seq lines with duplicates collapsed.
    The ping exit code must never gate the result (exiting non-zero on
    any loss is normal); transport-level failures (no summary at all)
    are signalled by the caller returning None so a resume retries.
    """
    seqs = set()
    for m in RE_REPLY.finditer(output):
        seqs.add(int(m.group(1)))
    received = len(seqs)
    loss_pct = round(100.0 * (expected_count - received) / expected_count, 2)
    loss_pct = max(0.0, min(100.0, loss_pct))

    stats = {"loss_pct": loss_pct, "received": received}
    m = RE_RTT.search(output)
    if m:
        stats.update({
            "min_ms": float(m.group(1)),
            "avg_ms": float(m.group(2)),
            "max_ms": float(m.group(3)),
            "mdev_ms": float(m.group(4)),
        })
    else:
        m = RE_RTT_SIMPLE.search(output)
        if m:
            stats.update({
                "min_ms": float(m.group(1)),
                "avg_ms": float(m.group(2)),
                "max_ms": float(m.group(3)),
            })
    return stats


def run_probe(src_ip, src_key, dst_ip, count=PING_COUNT):
    est = int(count * PING_INTERVAL + 8) + 25
    try:
        out, _, _ = ssh_exec(src_ip, src_key,
                             "ping -c %d -i %s -W 5 %s"
                             % (count, PING_INTERVAL, dst_ip), timeout=est)
    except subprocess.TimeoutExpired:
        print(" ssh-timeout", end="", flush=True)
        return None
    except Exception as e:
        print(" ssh-error(%s)" % e, end="", flush=True)
        return None
    if "packets transmitted" not in out:
        print(" no-summary", end="", flush=True)
        return None
    return parse_ping_output(out, count)


# ---------------------------------------------------------------------------
# Results persistence (v3 shape + provider columns)
# ---------------------------------------------------------------------------
def load_results():
    if os.path.exists(RESULTS_FILE):
        with open(RESULTS_FILE) as f:
            return json.load(f)
    return {"version": 1, "scope": "linode-na + contabo-existing",
            "ping": {}, "jitter": {}, "loss": {}, "meta": {}}


def save_results(res):
    tmp = RESULTS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(res, f, indent=2)
    os.replace(tmp, RESULTS_FILE)


def write_csv(res):
    keys = sorted(res["meta"].keys())
    with open(CSV_FILE, "w") as f:
        f.write("src_provider,src_region,dst_provider,dst_region,"
                "src_ip,dst_ip,ping_avg_ms,ping_min_ms,ping_max_ms,"
                "ping_mdev_ms,jitter_ms,loss_pct,timestamp\n")
        for k in keys:
            m = res["meta"][k]
            p = res["ping"].get(k) or {}
            j = res["jitter"].get(k) or {}
            loss = res["loss"].get(k)
            f.write(",".join(str(x) for x in [
                m["src_provider"], m["src_region"],
                m["dst_provider"], m["dst_region"],
                m["src_ip"], m["dst_ip"],
                p.get("avg_ms", ""), p.get("min_ms", ""), p.get("max_ms", ""),
                p.get("mdev_ms", ""), j.get("jitter_ms", ""),
                "" if loss is None else loss.get("loss_pct", ""),
                m["timestamp"]]) + "\n")
    print("  wrote %s (%d rows)" % (CSV_FILE, len(keys)), flush=True)


def pair_key(src, dst):
    return "%s:%s->%s:%s" % (src["provider"], src["region"],
                             dst["provider"], dst["region"])


# ---------------------------------------------------------------------------
# Linode lifecycle (provision + destroy OUR tag only)
# ---------------------------------------------------------------------------
def create_linode(api, region_id, label, ssh_pub):
    payload = {
        "type": LINODE_TYPE,
        "region": region_id,
        "image": LINODE_IMAGE,
        "label": label,
        "tags": [MESH_TAG],
        "authorized_keys": [ssh_pub],
        "root_pass": secrets.token_urlsafe(18),
        "booted": True,
    }
    resp = api.api("POST", "/linode/instances", payload)
    return resp["id"]


def wait_boot(api, linode_id, timeout=300):
    start = time.time()
    while time.time() - start < timeout:
        resp = api.api("GET", "/linode/instances/%s" % linode_id)
        if resp.get("status") == "running" and resp.get("ipv4"):
            return resp["label"], resp["ipv4"][0]
        time.sleep(5)
    raise TimeoutError("Linode %s not ready in %ss" % (linode_id, timeout))


def destroy_linode(api, linode_id):
    try:
        api.api("DELETE", "/linode/instances/%s" % linode_id)
    except Exception as e:
        print("    Warning: could not destroy %s: %s" % (linode_id, e))


def destroy_tagged_leftovers(api):
    """Destroy ONLY instances carrying our MESH_TAG. Never touches Contabo."""
    n = 0
    for inst in api.api_get_all("/linode/instances"):
        if MESH_TAG in (inst.get("tags") or []):
            destroy_linode(api, inst["id"])
            print("  Destroyed %s (%s)" % (inst["id"], inst.get("label")), flush=True)
            n += 1
    return n


def load_ssh_pub(key_file):
    with open(key_file + ".pub") as f:
        key = f.read().strip()
    if "ssh-ed25519 " in key:
        return "ssh-ed25519 " + key.split("ssh-ed25519 ")[1]
    return key


# ---------------------------------------------------------------------------
# Linode firewall (ICMP open for the mesh, SSH locked to orchestrator)
# ---------------------------------------------------------------------------
def cleanup_old_firewalls(api):
    try:
        fw_list = api.api("GET", "/networking/firewalls")
        for fw in fw_list.get("data", []):
            if str(fw.get("label", "")).startswith("na-mesh-test"):
                api.api("DELETE", "/networking/firewalls/%s" % fw["id"])
    except Exception:
        pass


def setup_firewall(api, my_ip):
    cleanup_old_firewalls(api)
    rules = {
        "inbound_policy": "DROP",
        "outbound_policy": "ACCEPT",
        "inbound": [
            {"action": "ACCEPT", "protocol": "TCP", "ports": "22",
             "addresses": {"ipv4": ["%s/32" % my_ip]}},
            {"action": "ACCEPT", "protocol": "ICMP",
             "addresses": {"ipv4": ["0.0.0.0/0"]}},
        ],
    }
    fw = api.api("POST", "/networking/firewalls", {
        "label": "na-mesh-test-fw-%d" % int(time.time()),
        "rules": rules,
    })
    return fw["id"]


def add_firewall_device(api, fw_id, linode_id):
    try:
        api.api("POST", "/networking/firewalls/%s/devices" % fw_id, {
            "type": "linode", "id": linode_id,
        })
    except Exception as e:
        print("    Warning: firewall attach failed for %s: %s" % (linode_id, e))


def delete_firewall(api, fw_id):
    try:
        api.api("DELETE", "/networking/firewalls/%s" % fw_id)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args(argv):
    opts = {"regions": None, "contabo_ids": list(DEFAULT_CONTABO_IDS),
            "yes": False, "skip_provision": False,
            "list_only": False, "cleanup": False}
    for i, a in enumerate(argv):
        if a == "--yes":
            opts["yes"] = True
        elif a == "--skip-provision":
            opts["skip_provision"] = True
        elif a == "--list-only":
            opts["list_only"] = True
        elif a == "--cleanup":
            opts["cleanup"] = True
        elif a.startswith("--regions"):
            val = a.split("=", 1)[1] if "=" in a else argv[i + 1]
            opts["regions"] = [s.strip() for s in val.split(",") if s.strip()]
        elif a.startswith("--contabo-ids"):
            val = a.split("=", 1)[1] if "=" in a else argv[i + 1]
            opts["contabo_ids"] = [s.strip() for s in val.split(",") if s.strip()]
        elif a in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
    return opts


def main():
    opts = parse_args(sys.argv[1:])

    linode = Linode(load_linode_token())

    if opts["cleanup"]:
        n = destroy_tagged_leftovers(linode)
        cleanup_old_firewalls(linode)
        print("cleanup done (%d linodes destroyed; Contabo untouched)" % n,
              flush=True)
        return

    print("Fetching Linode regions (live)...", flush=True)
    na_regions = get_na_regions(linode)
    print("Linode NA regions with Linodes capability: %d" % len(na_regions),
          flush=True)
    for r in na_regions:
        print("  %s (%s, %s)" % (r["id"], r.get("label"), r.get("country")),
              flush=True)

    wanted = [r["id"] for r in na_regions]
    if opts["regions"]:
        unknown = [s for s in opts["regions"] if s not in wanted]
        if unknown:
            raise SystemExit(
                "not Linode NA regions with Linodes capability: %s" % unknown)
        wanted = list(opts["regions"])
        print("Limited to: %s" % wanted, flush=True)

    print("\nReading Contabo inventory (GET-only)...", flush=True)
    reader = ContaboReader(load_contabo_credentials())
    contabo_nodes = get_contabo_inventory(reader, opts["contabo_ids"])
    print("Contabo nodes: %d (existing only -- none will be created)" % len(contabo_nodes),
          flush=True)

    if opts["list_only"]:
        total = len(wanted) + len(contabo_nodes)
        print("\n--list-only: %d Linode NA + %d Contabo = %d nodes, %d ordered pairs. "
              "No VMs created." % (
                  len(wanted), len(contabo_nodes), total, total * (total - 1)),
              flush=True)
        return

    if not opts["yes"]:
        total = len(wanted) + len(contabo_nodes)
        print("\nRefusing to provision without --yes: would create %d Linode VM(s) "
              "(%s/%s) for %d nodes / %d ordered pairs. Re-run with --yes "
              "to accept the hourly charges. Contabo: 0 new VMs either way."
              % (len(wanted), LINODE_TYPE, LINODE_IMAGE,
                 total, total * (total - 1)), flush=True)
        sys.exit(2)

    for key_file, name in ((LINODE_KEY_FILE, "linode"), (CONTABO_KEY_FILE, "contabo")):
        if not os.path.exists(key_file):
            raise SystemExit("missing SSH private key for %s: %s" % (name, key_file))

    my_ip = subprocess.run(
        ["curl", "-s", "https://api.ipify.org"],
        capture_output=True, text=True, timeout=10).stdout.strip()
    print("Orchestrator public IP: %s" % my_ip, flush=True)

    linode_pub = load_ssh_pub(LINODE_KEY_FILE)
    results = load_results()
    created = []  # [(linode_id, region)]
    fw_id = None

    try:
        if opts["skip_provision"]:
            print("\n--skip-provision: reusing running %s Linodes..." % MESH_TAG,
                  flush=True)
            for inst in linode.api_get_all("/linode/instances"):
                if MESH_TAG in (inst.get("tags") or []):
                    ipv4 = (inst.get("ipv4") or [None])[0]
                    if inst.get("status") == "running" and ipv4:
                        created.append((inst["id"], inst.get("region")))
                        print("  reusing %s (%s) at %s"
                              % (inst.get("label"), inst.get("region"), ipv4),
                              flush=True)
            if not created:
                raise SystemExit("no running %s Linodes to reuse" % MESH_TAG)
        else:
            print("\nCleaning up leftover %s Linodes..." % MESH_TAG, flush=True)
            destroy_tagged_leftovers(linode)

            fw_id = setup_firewall(linode, my_ip)
            print("Firewall: %s" % fw_id, flush=True)

            print("\nPHASE 1: create %d Linode NA VMs (%s/%s)..."
                  % (len(wanted), LINODE_TYPE, LINODE_IMAGE), flush=True)
            for i in range(0, len(wanted), CREATE_BATCH):
                for region in wanted[i:i + CREATE_BATCH]:
                    label = "mesh-na-%s" % region
                    print("  creating %s ..." % region, end=" ", flush=True)
                    try:
                        lid = create_linode(linode, region, label, linode_pub)
                        add_firewall_device(linode, fw_id, lid)
                        print("id=%s" % lid, end=" ", flush=True)
                    except Exception as e:
                        print("FAILED: %s" % e, flush=True)
                        continue
                    try:
                        lbl, ipv4 = wait_boot(linode, lid)
                        print("-> %s" % ipv4, flush=True)
                        created.append((lid, region))
                    except TimeoutError as e:
                        print("TIMEOUT: %s" % e, flush=True)
                        destroy_linode(linode, lid)
                time.sleep(5)

        if not created:
            raise SystemExit("no Linode VMs available, aborting")

        # Resolve live node set: Linode (fresh) + Contabo (existing)
        nodes = {}
        for lid, region in created:
            info = linode.api("GET", "/linode/instances/%s" % lid)
            ip = (info.get("ipv4") or [None])[0]
            if not ip:
                print("  skipping %s: no IPv4" % region, flush=True)
                continue
            nodes["linode:%s" % region] = {
                "provider": "linode", "region": region,
                "instance_id": str(lid), "ip": ip,
                "key": LINODE_KEY_FILE,
            }
        for key, c in contabo_nodes.items():
            nodes["contabo:%s" % c["region"]] = {
                "provider": "contabo", "region": c["region"],
                "instance_id": c["instance_id"], "ip": c["ip"],
                "key": CONTABO_KEY_FILE,
            }

        print("\nPHASE 2: wait SSH on %d nodes..." % len(nodes), flush=True)
        live = {}
        for name, n in sorted(nodes.items()):
            ok = wait_ssh(n["ip"], n["key"], label="%s %s" % (n["provider"], n["region"]))
            print("  SSH %s: %s %s (%s)" % ("OK" if ok else "FAIL",
                                            n["provider"], n["region"], n["ip"]),
                  flush=True)
            if ok:
                live[name] = n
        if len(live) < 2:
            raise SystemExit("need >=2 SSH-live hosts, have %d" % len(live))

        # Canary: Contabo nodes must be pingable before the full mesh
        print("\nCanary: cross-provider ICMP check...", flush=True)
        linode_names = sorted(k for k in live if k.startswith("linode:"))
        contabo_names = sorted(k for k in live if k.startswith("contabo:"))
        if linode_names and contabo_names:
            a, b = live[linode_names[0]], live[contabo_names[0]]
            for src, dst in ((a, b), (b, a)):
                probe = run_probe(src["ip"], src["key"], dst["ip"], count=5)
                print("  %s:%s -> %s:%s %s" % (
                    src["provider"], src["region"], dst["provider"], dst["region"],
                    "OK" if probe else "FAIL -- check ICMP/firewall before full mesh"),
                    flush=True)
                if not probe:
                    raise SystemExit("canary ICMP failed; aborting before full mesh")

        print("\nPHASE 3: full mesh %d ordered pairs..." % (len(live) * (len(live) - 1)),
              flush=True)
        names = sorted(live)
        total = len(names) * (len(names) - 1)
        done = sum(1 for k in results["meta"]
                   if results["ping"].get(k) and results["loss"].get(k))
        print("  already completed (resume): %d/%d" % (done, total), flush=True)
        tested = 0
        for sname in names:
            for dname in names:
                if sname == dname:
                    continue
                src, dst = live[sname], live[dname]
                key = pair_key(src, dst)
                if results["ping"].get(key) and results["loss"].get(key):
                    continue
                print("  %s:%s -> %s:%s" % (src["provider"], src["region"],
                                            dst["provider"], dst["region"]),
                      end="", flush=True)
                probe = run_probe(src["ip"], src["key"], dst["ip"])
                if probe is None:
                    print(flush=True)
                    continue  # absent -> retried on next run
                ping = {f: probe[f] for f in ("min_ms", "avg_ms", "max_ms") if f in probe}
                if "mdev_ms" in probe:
                    ping["mdev_ms"] = probe["mdev_ms"]
                results["ping"][key] = ping or None
                results["jitter"][key] = ({"jitter_ms": probe["mdev_ms"]}
                                          if "mdev_ms" in probe else None)
                results["loss"][key] = {"loss_pct": probe["loss_pct"],
                                        "received": probe["received"]}
                results["meta"][key] = {
                    "src_provider": src["provider"], "src_region": src["region"],
                    "dst_provider": dst["provider"], "dst_region": dst["region"],
                    "src_ip": src["ip"], "dst_ip": dst["ip"],
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                save_results(results)
                write_csv(results)
                tested += 1
                lat = ("%.1fms" % probe["avg_ms"] if "avg_ms" in probe else "n/a")
                print("  ping=%s loss=%.0f%%" % (lat, probe["loss_pct"]), flush=True)
                done += 1
                if done % 50 == 0:
                    print("  --- Progress: %d/%d (%.1f%%) ---"
                          % (done, total, 100 * done / total), flush=True)
        print("mesh complete (%d tested this run)" % tested, flush=True)
    finally:
        # NEVER touch Contabo here: only our tagged Linodes + our firewall.
        if created and not opts["skip_provision"]:
            print("\nPHASE 4: destroying %d Linode test VMs..." % len(created),
                  flush=True)
            for lid, region in created:
                print("  destroying %s (%s)..." % (region, lid), flush=True)
                destroy_linode(linode, lid)
        elif opts["skip_provision"]:
            print("\nPHASE 4: --skip-provision, leaving reused Linodes running.",
                  flush=True)
        if fw_id is not None:
            delete_firewall(linode, fw_id)
            print("Test firewall deleted. Contabo untouched.", flush=True)

    # -- Summary --
    print("\nRESULTS SUMMARY", flush=True)
    results = load_results()
    pings = {k: v for k, v in results["ping"].items() if v}
    losses = {k: v for k, v in results["loss"].items() if v}
    if pings:
        rows = sorted(((k, v["avg_ms"]) for k, v in pings.items()), key=lambda x: x[1])
        print("\nPairs with ping data: %d" % len(rows), flush=True)
        print("Lowest 10:", flush=True)
        for k, lat in rows[:10]:
            print("  %s: %.1fms" % (k, lat), flush=True)
        print("Highest 10:", flush=True)
        for k, lat in rows[-10:]:
            print("  %s: %.1fms" % (k, lat), flush=True)
    if losses:
        rows = sorted(((k, v["loss_pct"]) for k, v in losses.items()), key=lambda x: -x[1])
        print("\nHighest loss 10:", flush=True)
        for k, lv in rows[:10]:
            print("  %s: %.1f%%" % (k, lv), flush=True)
        zero = sum(1 for _, lv in rows if lv == 0)
        print("Pairs with 0%% loss: %d/%d" % (zero, len(rows)), flush=True)
    print("\nSaved %s + %s" % (RESULTS_FILE, CSV_FILE), flush=True)


if __name__ == "__main__":
    main()
