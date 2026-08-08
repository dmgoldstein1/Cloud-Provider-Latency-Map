import subprocess, re, sys, statistics, concurrent.futures, os
packets=int(os.environ.get("NETLAT_PACKETS","300")); interval=os.environ.get("NETLAT_INTERVAL","0.2")
peers=[l.strip() for l in open(sys.argv[1]) if l.strip()]
out=open("results.csv","w"); out.write("dst,min,avg,max,stddev,jitter,loss_pct,sent,received\n")
def run(dst):
    p=subprocess.Popen(["ping","-i",interval,"-c",str(packets),"-D",dst],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    times=[]
    for line in p.stdout:
        m=re.search(r"time=([0-9.]+)\s*ms", line)
        if m: times.append(float(m.group(1)))
    p.wait()
    if not times:
        return dst,0,0,0,0,0,100.0,packets,0
    jitter=statistics.mean(abs(times[i]-times[i-1]) for i in range(1,len(times)))
    loss=100.0*(packets-len(times))/packets
    return dst,min(times),statistics.mean(times),max(times),statistics.pstdev(times),jitter,loss,packets,len(times)
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
    for row in ex.map(run, peers):
        out.write(",".join(str(x) for x in row)+"\n")
out.close(); print("done", len(peers), "peers")
