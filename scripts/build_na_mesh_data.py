#!/usr/bin/env python3
# build_na_mesh_data.py - convert the NA cross-provider full-mesh ping results
# (scripts/na_mesh_results.csv from na_linode_contabo_mesh_test.py) into the
# same JSON shape the site inlines for Vultr/Linode/Contabo, so the frontend
# treats the NA mesh as a fourth provider:
#
#   * data/na_mesh_locations_measured.json - per-node latency/jitter/loss
#     matrices keyed by destination node code
#   * data/na_mesh_regions.json - node metadata (city/country/coords/continent)
#
# Node codes are prefixed (na-ln-... / na-cb-...) because app.js indexes every
# region by code GLOBALLY across providers -- reusing bare slugs like us-east
# would collide with the Linode/Contabo global meshes and corrupt lookups.
# Display names ("Newark · Linode") carry the human-readable form; map labels
# and chart axes render names, not codes.
#
# Coordinates are canonical city coords with a small deterministic
# provider-side display offset (Linode-NA -0.14 / Contabo-NA +0.42 lon) so the
# NA markers don't stack exactly on the global-mesh markers in the same city.
# Offsets are display-only and do not affect measured values.
#
# Regenerate after a new NA mesh CSV lands:
#   python3 scripts/build_na_mesh_data.py [--csv scripts/na_mesh_results.csv]
#   python3 scripts/build_data_js.py && npm run build
import argparse
import csv
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
DEFAULT_CSV = os.path.join(ROOT, "scripts", "na_mesh_results.csv")

# provider -> code prefix used in the site bundle
PREFIX = {"linode": "na-ln-", "contabo": "na-cb-"}

# (city, country, country_code, lat, lon) per raw region slug.
# Linode slugs are lowercase API ids; Contabo slugs keep their API case.
NODE_META = {
    ("linode", "ca-central"): ("Toronto", "Canada", "CA", 43.6532, -79.3832),
    ("linode", "us-central"): ("Dallas", "United States", "US", 32.7767, -96.7970),
    ("linode", "us-east"): ("Newark", "United States", "US", 40.7357, -74.1724),
    ("linode", "us-iad"): ("Washington DC", "United States", "US", 38.9072, -77.0369),
    ("linode", "us-iad-2"): ("Washington DC 2", "United States", "US", 38.9072, -77.0369),
    ("linode", "us-lax"): ("Los Angeles", "United States", "US", 34.0522, -118.2437),
    ("linode", "us-mia"): ("Miami", "United States", "US", 25.7617, -80.1918),
    ("linode", "us-ord"): ("Chicago", "United States", "US", 41.8781, -87.6298),
    ("linode", "us-sea"): ("Seattle", "United States", "US", 47.6062, -122.3321),
    ("linode", "us-southeast"): ("Atlanta", "United States", "US", 33.749, -84.388),
    ("linode", "us-west"): ("Fremont", "United States", "US", 37.5485, -121.9886),
    ("contabo", "US-central"): ("Dallas", "United States", "US", 32.7767, -96.7970),
    ("contabo", "US-east"): ("Newark", "United States", "US", 40.7357, -74.1724),
    ("contabo", "US-west"): ("Los Angeles", "United States", "US", 34.0522, -118.2437),
}

# Display-only lon offsets so NA markers don't stack on the global meshes
# (or, for the DC twins, on each other).
LON_OFFSET = {"linode": -0.14, "contabo": 0.42}
EXTRA_LON_OFFSET = {("linode", "us-iad-2"): -0.12}
PROVIDER_LABEL = {"linode": "Linode", "contabo": "Contabo"}


def node_code(provider, region):
    slug = region.lower() if provider == "contabo" else region
    return PREFIX[provider] + slug


def display_name(provider, region):
    city = NODE_META[(provider, region)][0]
    return "%s · %s" % (city, PROVIDER_LABEL[provider])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=DEFAULT_CSV)
    args = ap.parse_args()
    with open(args.csv) as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise SystemExit("empty CSV: %s" % args.csv)

    nodes = sorted({(r["src_provider"], r["src_region"]) for r in rows}
                   | {(r["dst_provider"], r["dst_region"]) for r in rows})
    missing = [(p, r) for p, r in nodes if (p, r) not in NODE_META]
    if missing:
        raise SystemExit("NODE_META missing entries: %s" % missing)
    codes = [node_code(p, r) for p, r in nodes]
    if len(set(codes)) != len(codes):
        raise SystemExit("duplicate site codes generated")

    latency, jitter, loss, count = {}, {}, {}, {}
    for r in rows:
        src = node_code(r["src_provider"], r["src_region"])
        dst = node_code(r["dst_provider"], r["dst_region"])
        if r.get("ping_avg_ms"):
            latency.setdefault(src, {})[dst] = round(float(r["ping_avg_ms"]), 1)
        if r.get("jitter_ms"):
            jitter.setdefault(src, {})[dst] = round(float(r["jitter_ms"]), 1)
        if (r.get("loss_pct") or "").strip() != "":
            loss.setdefault(src, {})[dst] = round(float(r["loss_pct"]), 1)
        count.setdefault(src, set()).add(dst)

    holes = [s for s in codes if set(count.get(s, ())) != set(codes) - {s}]
    if holes:
        raise SystemExit("incomplete mesh for: %s" % ", ".join(holes))

    retrieved = max(r["timestamp"] for r in rows)
    regions_out = [{
        "code": code,
        "location": display_name(p, r),
        "country": NODE_META[(p, r)][2],
        "country_name": NODE_META[(p, r)][1],
        "latency": {d: latency[code][d] for d in codes if d != code},
        "jitter": {d: jitter[code][d] for d in codes if d != code},
        "loss": {d: loss[code][d] for d in codes if d != code},
    } for (p, r), code in zip(nodes, codes)]
    measured = {
        "source": ("measured via NA full-mesh ping test "
                   "(11 linode NA regions + 3 existing contabo VMs, "
                   "all-pairs run %s)" % retrieved[:10]),
        "retrieved_at": retrieved[:10],
        "regions": regions_out,
    }

    meta_regions = []
    for (p, r), code in zip(nodes, codes):
        city, country, cc, lat, lon = NODE_META[(p, r)]
        lon += LON_OFFSET[p] + EXTRA_LON_OFFSET.get((p, r), 0.0)
        meta_regions.append({
            "code": code,
            "name": display_name(p, r),
            "country": country,
            "country_code": cc,
            "lat": lat,
            "lon": round(lon, 4),
            "continent": "North America",
        })
    meta = {
        "source": ("GeoNames (public domain); canonical city coords with a "
                   "small deterministic provider-side lon display offset so "
                   "NA markers don't stack on global-mesh markers"),
        "regions": meta_regions,
    }

    for name, obj in (("na_mesh_locations_measured.json", measured),
                      ("na_mesh_regions.json", meta)):
        path = os.path.join(DATA, name)
        with open(path, "w") as f:
            json.dump(obj, f, indent=2)
            f.write("\n")
        print("wrote %s (%d nodes, %d pairs)"
              % (path, len(codes), len(rows)))


if __name__ == "__main__":
    main()
