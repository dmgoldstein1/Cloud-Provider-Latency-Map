#!/usr/bin/env python3
# merge_na_mesh_data.py - fold the NA full-mesh results
# (scripts/na_mesh_results.csv) into the per-provider site datasets.
#
# The site models one mesh per cloud provider, so only same-provider pairs
# have a home there: linode<->linode pairs overwrite the matching entries
# in data/linode_locations_measured.json, contabo<->contabo pairs overwrite
# data/contabo_locations_measured.json. Cross-provider pairs (linode<->
# contabo, 66 of 182) cannot be represented in the per-provider model and
# stay available only in the raw CSV (linked from the page footer).
#
# Overwrite (not average) is deliberate: the probe methodology is identical
# to the global runs (ping -c 100 -i 0.1, mdev as jitter, loss from
# de-duplicated icmp_seq), so the newer run simply supersedes those pairs.
# Provenance is recorded in each dataset's `source` string.
#
#   python3 scripts/merge_na_mesh_data.py [--csv scripts/na_mesh_results.csv]
#   python3 scripts/build_data_js.py && npm run build
import argparse
import csv
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
DEFAULT_CSV = os.path.join(ROOT, "scripts", "na_mesh_results.csv")

TARGETS = {
    "linode": os.path.join(DATA, "linode_locations_measured.json"),
    "contabo": os.path.join(DATA, "contabo_locations_measured.json"),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=DEFAULT_CSV)
    args = ap.parse_args()
    with open(args.csv) as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise SystemExit("empty CSV: %s" % args.csv)

    retrieved = max(r["timestamp"] for r in rows)[:10]
    merged = {"linode": 0, "contabo": 0}
    shown = 0

    for provider, path in TARGETS.items():
        with open(path) as f:
            dataset = json.load(f)
        by_code = {r["code"]: r for r in dataset["regions"]}
        for r in rows:
            if r["src_provider"] != provider or r["dst_provider"] != provider:
                continue
            src, dst = r["src_region"], r["dst_region"]
            if src not in by_code or dst not in by_code[src]["latency"]:
                raise SystemExit(
                    "%s pair %s->%s has no slot in %s"
                    % (provider, src, dst, os.path.basename(path)))
            entry = by_code[src]
            old = entry["latency"][dst]
            entry["latency"][dst] = round(float(r["ping_avg_ms"]), 1)
            if r.get("jitter_ms"):
                entry["jitter"][dst] = round(float(r["jitter_ms"]), 1)
            if (r.get("loss_pct") or "").strip() != "":
                entry.setdefault("loss", {})[dst] = round(float(r["loss_pct"]), 1)
            merged[provider] += 1
            if shown < 6:
                print("  %s %s->%s latency %s -> %s"
                      % (provider, src, dst, old, entry["latency"][dst]))
                shown += 1
        dataset["source"] = (
            dataset["source"].rstrip()
            + "; NA pairs re-measured %s via NA full-mesh run "
              "(11 linode NA regions + 3 existing contabo VMs, all-pairs; "
              "raw: scripts/na_mesh_results.csv)" % retrieved)
        if dataset.get("retrieved_at", "") < retrieved:
            dataset["retrieved_at"] = retrieved
        with open(path, "w") as f:
            json.dump(dataset, f, indent=2)
            f.write("\n")
        print("updated %s (%d pairs overwritten, retrieved_at=%s)"
              % (path, merged[provider], dataset["retrieved_at"]))

    cross = sum(1 for r in rows if r["src_provider"] != r["dst_provider"])
    print("cross-provider pairs (kept in raw CSV only, not representable "
          "per-provider): %d" % cross)


if __name__ == "__main__":
    main()
