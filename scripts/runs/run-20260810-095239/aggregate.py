import csv, json, os
base=os.path.dirname(os.path.abspath(__file__))
regions, ip2region = {}, {}
with open(os.path.join(base,"instances.tsv")) as f:
    for line in f:
        r,i,ip,p,s=line.rstrip().split("\t")
        regions[r]={"id":i,"ip":ip,"plan":p,"state":s}
        ip2region[ip]=r
metric={m:{} for m in ("latency","jitter","loss")}
meta={}
for root, _, files in os.walk(os.path.join(base,"raw")):
    for fname in files:
        if not fname.endswith(".csv"): continue
        region=fname[:-4]
        with open(os.path.join(root,fname)) as f:
            for row in csv.DictReader(f):
                dst=ip2region.get(row["dst"])
                if not dst: continue
                metric["latency"].setdefault(region,{})[dst]=float(row["avg"])
                metric["jitter"].setdefault(region,{})[dst]=float(row["jitter"])
                metric["loss"].setdefault(region,{})[dst]=float(row["loss_pct"])
                meta.setdefault((region,dst),row)
for name,mat in metric.items():
    path=os.path.join(base,f"{name}_matrix.csv")
    with open(path,"w",newline="") as f:
        w=csv.writer(f)
        w.writerow(["src"]+list(regions))
        for src in regions:
            w.writerow([src]+[mat.get(src,{}).get(dst,"") for dst in regions])
    print("wrote",path)
with open(os.path.join(base,"manifest.json"),"w") as f:
    json.dump({"regions":regions,"status":"ok"},f,indent=2)
print("done")
