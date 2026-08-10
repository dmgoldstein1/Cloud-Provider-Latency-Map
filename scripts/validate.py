import json
import math
import sys
import statistics


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "data"
    raw = json.load(open(f"{root}/locations_measured.json"))
    regions = {r["code"]: r for r in json.load(open(f"{root}/regions.json"))["regions"]}
    meta = json.load(open(f"{root}/regions.json"))["meta"] if False else {}

    errors = []
    codes = [r["code"] for r in raw["regions"]]

    if len(codes) != len(set(codes)):
        errors.append("duplicate region codes")

    missing_meta = [c for c in codes if c not in regions]
    if missing_meta:
        errors.append(f"regions.json missing coords for: {missing_meta}")

    for r in raw["regions"]:
        code = r["code"]
        for metric in ("latency", "jitter"):
            if metric not in r:
                errors.append(f"{code}: missing {metric}")
                continue
            m = r[metric]
            for dst in codes:
                if dst == code:
                    continue
                if dst not in m:
                    errors.append(f"{code}: {metric} missing dst {dst}")
                else:
                    v = m[dst]
                    if not isinstance(v, (int, float)) or math.isnan(v):
                        errors.append(f"{code}: {metric}[{dst}] not numeric: {v!r}")
                    if v < 0:
                        errors.append(f"{code}: {metric}[{dst}] negative: {v}")

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

    if errors:
        print("VALIDATION FAILED")
        for e in errors[:50]:
            print("  ", e)
        print(f"  ... {len(errors)} total")
        sys.exit(1)

    lat_vals = [v for r in raw["regions"] for v in r["latency"].values()]
    jit_vals = [v for r in raw["regions"] for v in r["jitter"].values()]
    print("VALIDATION OK")
    print(f"  regions: {len(codes)}")
    print(f"  pairs: {len(codes) * (len(codes) - 1)}")
    print(f"  asymmetric latency/jitter pairs: {asym}")
    print(f"  latency ms: min={min(lat_vals)} median={statistics.median(lat_vals):.0f} max={max(lat_vals)}")
    print(f"  jitter  ms: min={min(jit_vals)} median={statistics.median(jit_vals):.1f} max={max(jit_vals)}")


if __name__ == "__main__":
    main()
