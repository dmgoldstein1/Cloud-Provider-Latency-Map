import json
import math
import sys
import statistics


def load_data(root):
    raw = json.load(open(f"{root}/locations_measured.json"))
    regions = {r["code"]: r for r in json.load(open(f"{root}/regions.json"))["regions"]}
    return raw, regions


def check_codes(raw, regions, errors):
    codes = [r["code"] for r in raw["regions"]]
    if len(codes) != len(set(codes)):
        errors.append("duplicate region codes")
    missing_meta = [c for c in codes if c not in regions]
    if missing_meta:
        errors.append(f"regions.json missing coords for: {missing_meta}")
    return codes


def check_value(code, metric, dst, v, errors):
    if not isinstance(v, (int, float)) or math.isnan(v):
        errors.append(f"{code}: {metric}[{dst}] not numeric: {v!r}")
    if v < 0:
        errors.append(f"{code}: {metric}[{dst}] negative: {v}")


def check_metric(code, metric, values, codes, errors):
    for dst in codes:
        if dst == code:
            continue
        if dst not in values:
            errors.append(f"{code}: {metric} missing dst {dst}")
        else:
            check_value(code, metric, dst, values[dst], errors)


def check_region(r, codes, errors):
    code = r["code"]
    for metric in ("latency", "jitter"):
        if metric not in r:
            errors.append(f"{code}: missing {metric}")
            continue
        check_metric(code, metric, r[metric], codes, errors)


def count_asymmetry(raw):
    asym = 0
    for a in raw["regions"]:
        for b in raw["regions"]:
            if a["code"] == b["code"]:
                continue
            la = a["latency"].get(b["code"])
            lb = b["latency"].get(a["code"])
            ja = a["jitter"].get(b["code"])
            jb = b["jitter"].get(a["code"])
            if la is not None and lb is not None and la != lb:
                asym += 1
            if ja is not None and jb is not None and ja != jb:
                asym += 1
    return asym


def report(raw, codes, asym):
    lat_vals = [v for r in raw["regions"] for v in r["latency"].values()]
    jit_vals = [v for r in raw["regions"] for v in r["jitter"].values()]
    print("VALIDATION OK")
    print(f"  regions: {len(codes)}")
    print(f"  pairs: {len(codes) * (len(codes) - 1)}")
    print(f"  asymmetric latency/jitter pairs: {asym}")
    print(f"  latency ms: min={min(lat_vals)} median={statistics.median(lat_vals):.0f} max={max(lat_vals)}")
    print(f"  jitter  ms: min={min(jit_vals)} median={statistics.median(jit_vals):.1f} max={max(jit_vals)}")


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "data"
    raw, regions = load_data(root)
    errors = []
    codes = check_codes(raw, regions, errors)
    for r in raw["regions"]:
        check_region(r, codes, errors)
    asym = count_asymmetry(raw)
    if errors:
        print("VALIDATION FAILED")
        for e in errors[:50]:
            print("  ", e)
        print(f"  ... {len(errors)} total")
        sys.exit(1)
    report(raw, codes, asym)


if __name__ == "__main__":
    main()
