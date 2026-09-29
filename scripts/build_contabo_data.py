#!/usr/bin/env python3
# build_contabo_data.py - convert Contabo mesh CSV into the site schema:
#   * data/contabo_locations_measured.json - per-region latency/jitter/loss
#   * data/contabo_regions.json - region metadata (city/coords/continent)
# Mirrors scripts/build_linode_data.py.
#
#   python3 scripts/build_contabo_data.py [--csv scripts/contabo_mesh_results.csv]
import argparse
import csv
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
DEFAULT_CSV = os.path.join(ROOT, "scripts", "contabo_mesh_results.csv")

# Display coords: canonical city +0.28 lon offset so Contabo markers
# don't stack exactly on Vultr/Linode markers in the same city.
REGION_META = {
    "EU": {"name": "Frankfurt", "country": "Germany", "country_code": "DE",
           "lat": 50.1109, "lon": 8.9621, "continent": "Europe"},
    "US-central": {"name": "Dallas", "country": "United States",
                   "country_code": "US", "lat": 32.7767, "lon": -96.517,
                   "continent": "North America"},
    "US-east": {"name": "Newark", "country": "United States",
                "country_code": "US", "lat": 40.7357, "lon": -73.8924,
                "continent": "North America"},
    "US-west": {"name": "Los Angeles", "country": "United States",
                "country_code": "US", "lat": 34.0522, "lon": -117.9637,
                "continent": "North America"},
    "SIN": {"name": "Singapore", "country": "Singapore", "country_code": "SG",
            "lat": 1.3521, "lon": 104.0998, "continent": "Asia"},
    "UK": {"name": "London", "country": "United Kingdom",
           "country_code": "GB", "lat": 51.5074, "lon": 0.1522,
           "continent": "Europe"},
    "AUS": {"name": "Sydney", "country": "Australia", "country_code": "AU",
            "lat": -33.8688, "lon": 151.4893, "continent": "Oceania"},
    "JPN": {"name": "Tokyo", "country": "Japan", "country_code": "JP",
            "lat": 35.6762, "lon": 139.9303, "continent": "Asia"},
    "IND": {"name": "Mumbai", "country": "India", "country_code": "IN",
            "lat": 19.076, "lon": 73.1577, "continent": "Asia"},
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=DEFAULT_CSV)
    args = ap.parse_args()
    with open(args.csv) as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise SystemExit("empty CSV: %s" % args.csv)

    codes = sorted({r["src_region"] for r in rows}
                   | {r["dst_region"] for r in rows})
    missing = [c for c in codes if c not in REGION_META]
    if missing:
        raise SystemExit("REGION_META missing: %s" % ", ".join(missing))

    latency, jitter, loss, count = {}, {}, {}, {}
    jitter_col = ("jitter_ms" if "jitter_ms" in rows[0] else "jitter_avg_ms")
    for r in rows:
        src, dst = r["src_region"], r["dst_region"]
        if r.get("ping_avg_ms"):
            latency.setdefault(src, {})[dst] = round(float(r["ping_avg_ms"]), 1)
        if r.get(jitter_col):
            jitter.setdefault(src, {})[dst] = round(float(r[jitter_col]), 1)
        if (r.get("loss_pct") or "").strip() != "":
            loss.setdefault(src, {})[dst] = round(float(r["loss_pct"]), 1)
        count.setdefault(src, set()).add(dst)

    holes = [s for s in codes
             if set(count.get(s, ())) != set(codes) - {s}]
    if holes:
        raise SystemExit("incomplete mesh for: %s" % ", ".join(holes))

    retrieved = max(r["timestamp"] for r in rows)
    regions_out = [{
        "code": c,
        "location": REGION_META[c]["name"],
        "country": REGION_META[c]["country_code"],
        "country_name": REGION_META[c]["country"],
        "latency": {d: latency[c][d] for d in codes if d != c},
        "jitter": {d: jitter[c][d] for d in codes if d != c},
        "loss": {d: loss[c][d] for d in codes if d != c},
    } for c in codes]
    measured = {
        "source": "measured via contabo full-mesh ping test "
                  "(all-pairs run %s)" % retrieved[:10],
        "retrieved_at": retrieved[:10],
        "regions": regions_out,
    }
    meta = {
        "source": "GeoNames (public domain); Contabo region slugs mapped "
                  "to city coords with +0.28 lon display offset",
        "regions": [dict({"code": c}, **REGION_META[c]) for c in codes],
    }

    for name, obj in (("contabo_locations_measured.json", measured),
                      ("contabo_regions.json", meta)):
        path = os.path.join(DATA, name)
        with open(path, "w") as f:
            json.dump(obj, f, indent=2)
            f.write("\n")
        print("wrote %s (%d regions)" % (path, len(codes)))


if __name__ == "__main__":
    main()
