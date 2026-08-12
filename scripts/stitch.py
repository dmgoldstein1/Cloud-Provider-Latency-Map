#!/usr/bin/env python3
# stitch.py - merge per-run matrices (netlat.sh runs) into a single full matrix.
# Usage: python3 stitch.py OUTDIR RUN_DIR [RUN_DIR ...]
# Cell precedence: later run dirs overwrite earlier ones.
import csv, json, os, sys


def read_matrix(path):
    with open(path) as f:
        rows = list(csv.DictReader(f))
    cells = {}
    for row in rows:
        src = row["src"]
        for dst, v in row.items():
            if dst != "src" and v != "":
                cells[(src, dst)] = v
    return cells


def load_run(run):
    metrics = {}
    for name in ("latency", "jitter", "loss"):
        path = os.path.join(run, f"{name}_matrix.csv")
        if os.path.exists(path):
            metrics[name] = read_matrix(path)
    regions = set()
    meta_path = os.path.join(run, "instances.tsv")
    if os.path.exists(meta_path):
        with open(meta_path) as f:
            for line in f:
                regions.add(line.rstrip().split("\t")[0])
    return metrics, regions


def write_matrix(outdir, name, regions, cells):
    path = os.path.join(outdir, f"{name}_matrix.csv")
    filled = 0
    with open(path, "w", newline="") as f:
        w = csv.writer(f)  # nosemgrep: python.lang.security.use-defusedcsv
        w.writerow(["src"] + regions)
        for src in regions:
            row = [src]
            for dst in regions:
                v = cells.get((src, dst), "")
                if v != "":
                    filled += 1
                row.append(v)
            w.writerow(row)
    total = len(regions) * len(regions)
    print(f"wrote {path} ({filled}/{total} cells)")
    return {"filled": filled, "total": total}


def missing_latency(regions, latency):
    missing = []
    for s in regions:
        for d in regions:
            if latency.get((s, d)) == "" or (s, d) not in latency:
                missing.append((s, d))
    return missing


def main():
    if len(sys.argv) < 3:
        print("usage: stitch.py OUTDIR RUN_DIR [RUN_DIR ...]")
        sys.exit(1)
    outdir = sys.argv[1]
    runs = sys.argv[2:]
    merged = {"latency": {}, "jitter": {}, "loss": {}}
    all_regions = set()
    run_meta = {}
    for run in runs:
        metrics, regions = load_run(run)
        all_regions |= regions
        for name in merged:
            for (src, dst), v in metrics.get(name, {}).items():
                merged[name][(src, dst)] = v
        run_meta[run] = sorted(regions)
    regions = sorted(all_regions)
    os.makedirs(outdir, exist_ok=True)
    coverage = {}
    for name, cells in merged.items():
        coverage[name] = write_matrix(outdir, name, regions, cells)
    manifest = {
        "regions": regions,
        "runs": run_meta,
        "coverage": coverage,
        "note": "stitched from netlat.sh chunked runs",
    }
    with open(os.path.join(outdir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    missing = missing_latency(regions, merged["latency"])
    print(f"regions: {len(regions)}  missing latency cells: {len(missing)}")


if __name__ == "__main__":
    main()
