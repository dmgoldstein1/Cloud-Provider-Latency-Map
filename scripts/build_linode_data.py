#!/usr/bin/env python3
# build_linode_data.py - convert the Linode full-mesh ping results
# (linode-skill CSV from mesh_test_v3.py, or the legacy v2 CSV) into the same
# JSON shape the site's build_data_js.py inlines for Vultr, so the frontend
# can treat both providers uniformly:
#
#   * data/linode_locations_measured.json - per-region latency/jitter/loss
#     matrices keyed by destination region code. v3 adds packet loss (share
#     of probes with no reply, measured per pair); the legacy v2 CSV has no
#     loss column, in which case the "loss" section is simply omitted and the
#     frontend keeps treating Linode loss as no-data.
#   * data/linode_regions.json - the region metadata list (city/country/
#     coordinates/continent) the map and sources panel render from.
#
# Region slugs follow Linode's API (us-east, ap-south, ...). The city each slug
# maps to comes from the creation log of the mesh run itself
# (linode-skill/mesh_test_v2.log), which matters because two legacy slugs are
# counterintuitive: ap-south was created in Singapore and ap-southeast in
# Sydney.
#
# Regenerate after a new mesh CSV lands:
#   python3 scripts/build_linode_data.py [--csv linode-skill/linode_mesh_results_v3.csv]
import argparse
import csv
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
DEFAULT_CSVS = [
    os.path.join(ROOT, "linode-skill", "linode_mesh_results_v3.csv"),
    os.path.join(ROOT, "linode-skill", "linode_mesh_results.csv"),
]

# code -> display name, country code, country name, continent. Coordinates are
# the canonical city coordinates from GeoNames, with a small deterministic
# offset baked in where several provider regions sit on the exact same city
# point (three regions share Tokyo, for example) so the map markers never
# stack; the offsets are display-only and do not affect the measured values.
REGION_META = {
    "ap-northeast": {"name": "Tokyo 2", "country": "Japan", "country_code": "JP",
                     "lat": 35.6762, "lon": 139.5103, "continent": "Asia"},
    "jp-tyo-3": {"name": "Tokyo 3", "country": "Japan", "country_code": "JP",
                 "lat": 35.6762, "lon": 139.7903, "continent": "Asia"},
    "jp-osa": {"name": "Osaka", "country": "Japan", "country_code": "JP",
               "lat": 34.6937, "lon": 135.5023, "continent": "Asia"},
    "ap-south": {"name": "Singapore 3", "country": "Singapore", "country_code": "SG",
                 "lat": 1.3521, "lon": 103.6798, "continent": "Asia"},
    "sg-sin-2": {"name": "Singapore 2", "country": "Singapore", "country_code": "SG",
                 "lat": 1.3521, "lon": 103.9598, "continent": "Asia"},
    "id-cgk": {"name": "Jakarta", "country": "Indonesia", "country_code": "ID",
               "lat": -6.2088, "lon": 106.8456, "continent": "Asia"},
    "ap-west": {"name": "Mumbai 2", "country": "India", "country_code": "IN",
                "lat": 19.076, "lon": 72.7077, "continent": "Asia"},
    "in-bom-2": {"name": "Mumbai 3", "country": "India", "country_code": "IN",
                 "lat": 19.076, "lon": 73.0477, "continent": "Asia"},
    "in-maa": {"name": "Chennai", "country": "India", "country_code": "IN",
               "lat": 13.0827, "lon": 80.2707, "continent": "Asia"},
    "ap-southeast": {"name": "Sydney", "country": "Australia", "country_code": "AU",
                     "lat": -33.8688, "lon": 151.2093, "continent": "Oceania"},
    "br-gru": {"name": "S\u00e3o Paulo 2", "country": "Brazil", "country_code": "BR",
               "lat": -23.5505, "lon": -46.7733, "continent": "South America"},
    "ca-central": {"name": "Toronto 2", "country": "Canada", "country_code": "CA",
                   "lat": 43.6532, "lon": -79.2432, "continent": "North America"},
    "de-fra-2": {"name": "Frankfurt 2", "country": "Germany", "country_code": "DE",
                 "lat": 50.1109, "lon": 8.8621, "continent": "Europe"},
    "eu-central": {"name": "Frankfurt", "country": "Germany", "country_code": "DE",
                   "lat": 50.1109, "lon": 8.5021, "continent": "Europe"},
    "fr-par-2": {"name": "Paris 2", "country": "France", "country_code": "FR",
                 "lat": 48.8566, "lon": 2.6322, "continent": "Europe"},
    "gb-lon": {"name": "London 2", "country": "United Kingdom", "country_code": "GB",
               "lat": 51.5074, "lon": 0.1322, "continent": "Europe"},
    "nl-ams": {"name": "Amsterdam 2", "country": "Netherlands", "country_code": "NL",
               "lat": 52.3676, "lon": 5.1841, "continent": "Europe"},
    "it-mil": {"name": "Milan 2", "country": "Italy", "country_code": "IT",
               "lat": 45.4642, "lon": 9.55, "continent": "Europe"},
    "se-sto": {"name": "Stockholm", "country": "Sweden", "country_code": "SE",
               "lat": 59.3293, "lon": 18.0686, "continent": "Europe"},
    "us-east": {"name": "Newark 2", "country": "United States", "country_code": "US",
                "lat": 40.7357, "lon": -74.0224, "continent": "North America"},
    "us-central": {"name": "Dallas 2", "country": "United States", "country_code": "US",
                   "lat": 32.7767, "lon": -96.607, "continent": "North America"},
    "us-west": {"name": "Fremont", "country": "United States", "country_code": "US",
                "lat": 37.5485, "lon": -121.9886, "continent": "North America"},
    "us-southeast": {"name": "Atlanta 2", "country": "United States", "country_code": "US",
                     "lat": 33.749, "lon": -84.218, "continent": "North America"},
    "us-lax": {"name": "Los Angeles 2", "country": "United States", "country_code": "US",
               "lat": 34.0522, "lon": -118.0937, "continent": "North America"},
    "us-iad": {"name": "Washington DC", "country": "United States", "country_code": "US",
               "lat": 38.9072, "lon": -77.1869, "continent": "North America"},
    "us-iad-2": {"name": "Washington DC 2", "country": "United States", "country_code": "US",
                 "lat": 38.9072, "lon": -76.8869, "continent": "North America"},
    "us-ord": {"name": "Chicago 2", "country": "United States", "country_code": "US",
               "lat": 41.8781, "lon": -87.4498, "continent": "North America"},
    "us-mia": {"name": "Miami 2", "country": "United States", "country_code": "US",
               "lat": 25.7617, "lon": -80.0418, "continent": "North America"},
    "us-sea": {"name": "Seattle 2", "country": "United States", "country_code": "US",
               "lat": 47.6062, "lon": -122.1821, "continent": "North America"},
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="explicit mesh CSV path (default: newest v3 CSV, else v2)")
    args = ap.parse_args()
    csv_path = args.csv or next((p for p in DEFAULT_CSVS if os.path.exists(p)), None)
    if not csv_path:
        raise SystemExit("no mesh CSV found under linode-skill/")
    print("reading %s" % csv_path)

    with open(csv_path) as f:
        rows = list(csv.DictReader(f))
    has_loss = bool(rows) and "loss_pct" in rows[0] and any(
        (r.get("loss_pct") or "").strip() != "" for r in rows)

    codes = sorted({r["src_region"] for r in rows} | {r["dst_region"] for r in rows})
    missing = [c for c in codes if c not in REGION_META]
    if missing:
        raise SystemExit("REGION_META is missing entries: %s" % ", ".join(missing))

    # dense matrices: every source row gets an entry for every destination,
    # and the pair must exist in the mesh both ways to keep the matrix square
    latency = {}
    jitter = {}
    loss = {}
    count = {}
    jitter_col = "jitter_ms" if "jitter_ms" in rows[0] else "jitter_avg_ms"
    for r in rows:
        src, dst = r["src_region"], r["dst_region"]
        latency.setdefault(src, {})[dst] = round(float(r["ping_avg_ms"]), 1)
        jitter.setdefault(src, {})[dst] = round(float(r[jitter_col]), 1)
        if has_loss and (r.get("loss_pct") or "").strip() != "":
            loss.setdefault(src, {})[dst] = round(float(r["loss_pct"]), 1)
        count.setdefault(src, set()).add(dst)

    holes = []
    for src in codes:
        if len(count.get(src, ()) ) != len(codes) - 1 or set(count.get(src, ())) != set(codes) - {src}:
            holes.append(src)
    if holes:
        raise SystemExit("mesh matrix is not complete for: %s" % ", ".join(holes))

    retrieved = max(r["timestamp"] for r in rows)
    n = len(rows)
    regions_out = [
        {
            "code": c,
            "location": REGION_META[c]["name"],
            "country": REGION_META[c]["country_code"],
            "country_name": REGION_META[c]["country"],
            "latency": {d: latency[c][d] for d in codes if d != c},
            "jitter": {d: jitter[c][d] for d in codes if d != c},
        }
        for c in codes
    ]
    if has_loss:
        for entry in regions_out:
            entry["loss"] = {d: loss[entry["code"]][d] for d in codes if d != entry["code"]}
    measured = {
        "source": "measured via linode full-mesh ping test v3 (all-pairs run "
                  + retrieved[:10] + ")" if has_loss else
                  "measured via linode full-mesh ping test v2 (all-pairs run "
                  + retrieved[:10] + ")",
        "retrieved_at": retrieved[:10],
        "regions": regions_out,
    }

    regions_meta = {
        "source": "GeoNames (public domain); cities taken from the region list "
                  "of the mesh run log; coordinates offset where several "
                  "providers share one city point",
        "regions": [
            dict({"code": c}, **REGION_META[c]) for c in codes
        ],
    }

    def dump(name, obj):
        path = os.path.join(DATA, name)
        with open(path, "w") as f:
            json.dump(obj, f, indent=2, sort_keys=False)
            f.write("\n")
        print("wrote %s (%d regions, %d pairs)" % (
            path, len(obj["regions"]), n))

    dump("linode_locations_measured.json", measured)
    dump("linode_regions.json", regions_meta)

if __name__ == "__main__":
    main()
