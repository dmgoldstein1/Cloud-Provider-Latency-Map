#!/usr/bin/env python3
# build_xmesh_data.py - extract the CROSS-provider pairs from the NA
# full-mesh run (scripts/na_mesh_results.csv) into the site bundle.
#
# The per-provider datasets (linode/contabo measured JSONs) can only hold
# links inside one provider's mesh, so the 66 linode<->contabo pairs need
# their own dataset: data/xmesh.json, shaped as
#   {"source": ..., "retrieved_at": ...,
#    "pairs": {"<srcCode>": {"<dstCode>": {"latency","jitter","loss"}}}}
# keyed by the GLOBAL region codes (linode lowercase, contabo as-is), only
# for pairs whose endpoints belong to different providers. The frontend
# (normalize.js loadXMesh + valueAt fallback in app.js) resolves these for
# the heatmap, arcs, scatter, boxes, and tooltips.
#
#   python3 scripts/build_xmesh_data.py [--csv scripts/na_mesh_results.csv]
#   python3 scripts/build_data_js.py && npm run build
import argparse
import csv
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
DEFAULT_CSV = os.path.join(ROOT, "scripts", "na_mesh_results.csv")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=DEFAULT_CSV)
    args = ap.parse_args()
    with open(args.csv) as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise SystemExit("empty CSV: %s" % args.csv)

    pairs = {}
    n_cross = 0
    for r in rows:
        if r["src_provider"] == r["dst_provider"]:
            continue  # same-provider pairs live in the provider datasets
        src, dst = r["src_region"], r["dst_region"]
        cell = {}
        if r.get("ping_avg_ms"):
            cell["latency"] = round(float(r["ping_avg_ms"]), 1)
        if r.get("jitter_ms"):
            cell["jitter"] = round(float(r["jitter_ms"]), 1)
        if (r.get("loss_pct") or "").strip() != "":
            cell["loss"] = round(float(r["loss_pct"]), 1)
        if not cell:
            raise SystemExit("cross pair %s->%s has no metrics" % (src, dst))
        pairs.setdefault(src, {})[dst] = cell
        n_cross += 1

    if n_cross == 0:
        raise SystemExit("no cross-provider pairs in %s" % args.csv)

    retrieved = max(r["timestamp"] for r in rows)[:10]
    obj = {
        "source": ("measured via NA full-mesh ping test "
                   "(11 linode NA regions + 3 existing contabo VMs, "
                   "all-pairs run %s; cross-provider pairs only)" % retrieved),
        "retrieved_at": retrieved,
        "pairs": pairs,
    }
    path = os.path.join(DATA, "xmesh.json")
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")
    print("wrote %s (%d cross-provider pairs)" % (path, n_cross))


if __name__ == "__main__":
    main()
