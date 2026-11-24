# Fixed plan, fixed limits. Every operation is a fresh process of the signed QA app binary, as in the app.
import subprocess, sys, time, random, os, json, shutil, signal
app=sys.argv[1]; F="~/Documents/Developer/Developping/BillieWeather/billieweather-roadmap/clients/universal/test/ocr-fixtures/"
L="en-US,zh-Hans,zh-Hant"; OP=18; PREP=180; TOTAL=2400; t0=time.time(); random.seed(52)
exe=lambda a: a+"/Contents/MacOS/billieweather"
need={"us-debit-credit.png":"1,286.04","us-signed-amount.jpg":None,"zh-cn.png":None,"zh-tw.png":None,"us-blurred.png":None,"us-rotated-90.png":None,"us-skew-3.png":None}
def prepare(a=app, kill=None):
    s=time.time(); p=subprocess.Popen([exe(a),"--billie-vision-prepare"],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try: rc=p.wait(kill or PREP+5)
    except subprocess.TimeoutExpired: p.kill(); p.wait(); rc="killed"
    return rc, round(time.time()-s,2)
def start(page=1,a=app): return subprocess.Popen([exe(a),"--billie-vision-worker",L,str(page)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
def op(data,page=1,a=app):
    s=time.time(); p=start(page,a)
    try: out,_=p.communicate(data,timeout=OP)
    except subprocess.TimeoutExpired: p.kill(); p.communicate(); return "TIMEOUT",round(time.time()-s,2),None
    dt=round(time.time()-s,2)
    if p.returncode: return f"EXIT{p.returncode}",dt,None
    return "ok",dt,json.loads(out)
def img(n): return open(F+n,"rb").read()
def check(n,r): return r and r["pages"] and len(r["pages"][0]["lines"])>0 and (not need.get(n) or any(need[n] in l["text"] for l in r["pages"][0]["lines"]))
def report(name,res):
    c={}; ts=sorted(t for k,t in res)
    for k,_ in res: c[k]=c.get(k,0)+1
    print(f"{name}: n={len(res)} {c} min={ts[0]} p50={ts[len(ts)//2]} p95={ts[int(len(ts)*.95)-1]} max={ts[-1]}  elapsed={time.time()-t0:.0f}s",flush=True)
def guard(): 
    if time.time()-t0>TOTAL: print("TOTAL LIMIT"); sys.exit(9)
print("1 cold prepare",prepare(),flush=True); print("  warm prepare",prepare(),flush=True)
names=list(need); res=[]
for i in range(100):
    guard(); n=names[i%len(names)]; k,t,r=op(img(n)); res.append((k if k!="ok" else ("ok" if check(n,r) else "WRONG"),t))
report("2 sequential images",res); res=[]
for i in range(20):
    for pg in (1,2):
        guard(); k,t,r=op(img(f"multipage-{pg}.png"),pg); res.append((k if k!="ok" or r["pages"][0]["page"]==pg else "WRONGPAGE",t))
report("3 multi-page PDF page renders (20x2)",res); res=[]
for i in range(20):
    guard(); ps=[(time.time(),start()) for _ in range(3)]; d=img("us-debit-credit.png")
    import threading; out=[None]*3
    def go(j):
        s,p=ps[j]
        try: o,_=p.communicate(d,timeout=OP); out[j]=("ok" if p.returncode==0 and check("us-debit-credit.png",json.loads(o)) else f"EXIT{p.returncode}",round(time.time()-s,2))
        except subprocess.TimeoutExpired: p.kill(); p.communicate(); out[j]=("TIMEOUT",OP)
    th=[threading.Thread(target=go,args=(j,)) for j in range(3)]; [x.start() for x in th]; [x.join() for x in th]; res+=out
report("4 concurrent (20 rounds x 3)",res); res=[]
for i in range(20):
    guard(); p=start(); p.stdin.write(img("zh-cn.png")); p.stdin.close(); time.sleep(random.uniform(.01,.35)); p.kill(); p.wait(); p.stdout.close()
    k,t,r=op(img("us-debit-credit.png")); res.append((k if k!="ok" else ("ok" if check("us-debit-credit.png",r) else "WRONG"),t))
report("5 cancel then recognise",res); res=[]
bad=[b"not an image", b"\x89PNG\r\n\x1a\n"+b"\0"*64, img("us-debit-credit.png")[:2000], b"%PDF-1.7 junk"]
for i in range(20):
    k,t,r=op(bad[i%4]); res.append(("handled" if k=="ok" and (r["errors"] or not r["pages"][0]["lines"]) else k,t))
report("6 invalid input",res)
k,t,r=op(b""); print("  empty stdin:",k,t); res=[]
for i in range(30):
    rc,t=prepare(); res.append(("ok" if rc==0 else f"rc{rc}",t))
report("7 repeated prepare/shutdown",res)
upd=app.replace(".app"," update.app"); shutil.rmtree(upd,ignore_errors=True); shutil.copytree(app,upd,symlinks=True)
open(upd+"/Contents/Resources/update-marker","w").write("v2")
subprocess.run(["codesign","--force","--sign","-","--identifier","com.billieweather.roadmap.phase52",upd],check=True,capture_output=True)
print("8 re-signed update (same identifier): interrupted prepare",prepare(upd,5),flush=True)
print("   op during unprepared state (old behaviour, 18s)",op(img("us-debit-credit.png"),1,upd)[:2],flush=True)
print("   full prepare",prepare(upd),"then op",op(img("us-debit-credit.png"),1,upd)[:2],flush=True)
p=subprocess.run(["pgrep","-f","billie-vision"],capture_output=True,text=True).stdout.split(); print("9 leftover workers:",len(p),"total",round(time.time()-t0))
