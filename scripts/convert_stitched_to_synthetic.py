#!/usr/bin/env python3
# convert_stitched_to_synthetic.py - turn stitched measurement CSVs into
# data/locations_synthetic.json (the VML_DATA.synthetic schema the dashboard
# consumes). Run after stitching a new dataset:
#   python3 scripts/convert_stitched_to_synthetic.py
#
# Reads scripts/runs/stitched/{latency,jitter}_matrix.csv plus data/regions.json
# for location/country metadata. Skips the src (self) column and blank cells.
# Values are rounded to 1 decimal.
import argparse
import csv
import datetime
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", default=os.path.join(ROOT, "scripts/runs/stitched"))
    ap.add_argument("--regions", default=os.path.join(ROOT, "data/regions.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data/locations_synthetic.json"))
    ap.add_argument("--source-label", default="measured via netlat.sh (stitched chunked runs)")
    return ap.parse_args()


def read_matrix(path):
    with open(path) as f:
        rows = list(csv.reader(f))
    header = rows[0][1:]
    out = {}
    for row in rows[1:]:
        if not row:
            continue
        src = row[0]
        values = {}
        for dst, cell in zip(header, row[1:]):
            if not cell.strip():
                continue
            values[dst] = round(float(cell), 1)
        out[src] = values
    return header, out


def main():
    args = parse_args()

    latency_hdr, latency = read_matrix(os.path.join(args.source, "latency_matrix.csv"))
    jitter_hdr, jitter = read_matrix(os.path.join(args.source, "jitter_matrix.csv"))

    if latency_hdr != jitter_hdr:
        raise SystemExit("latency and jitter matrix headers differ")

    regions = {r["code"]: r for r in json.load(open(args.regions))["regions"]}
    missing = [c for c in latency_hdr if c not in regions]
    if missing:
        raise SystemExit("regions.json missing metadata for: %s" % missing)

    out_regions = []
    for code in latency_hdr:
        lat = {dst: v for dst, v in latency[code].items() if dst != code}
        jit = {dst: v for dst, v in jitter[code].items() if dst != code}
        meta = regions[code]
        out_regions.append({
            "code": code,
            "location": meta.get("city") or meta.get("name"),
            "country": meta.get("country_code"),
            "country_name": meta.get("country"),
            "latency": lat,
            "jitter": jit,
        })

    payload = {
        "source": args.source_label,
        "retrieved_at": datetime.date.today().isoformat(),
        "regions": out_regions,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")

    cells = len(latency_hdr) * (len(latency_hdr) - 1)
    lat_filled = sum(len(v) for v in latency.values())
    jit_filled = sum(len(v) for v in jitter.values())
    print("wrote %s" % args.out)
    print("  regions: %d  expected non-self cells: %d" % (len(latency_hdr), cells))
    print("  latency cells: %d  jitter cells: %d" % (lat_filled, jit_filled))


if __name__ == "__main__":
    main()
