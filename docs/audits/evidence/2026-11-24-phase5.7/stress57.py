# Phase 5.7: fixed plan and limits, headless. Each operation is a fresh process of the RC binary, as in the app.
# Cold identities are copies of the RC bundle under com.billieweather.client.qa.<suffix>; worker modes open no window, database or keychain.
import subprocess, sys, time, random, json, shutil, threading, os
rc,work,fx=sys.argv[1:4]; L="en-US,zh-Hans,zh-Hant"; OP=18; PREP=180; t0=time.time(); random.seed(57)
exe=lambda a:a+"/Contents/MacOS/billieweather"
def make(sfx):
    d=f"{work}/cold-{sfx}.app"; shutil.rmtree(d,ignore_errors=True); shutil.copytree(rc,d,symlinks=True)
    subprocess.run(["plutil","-replace","CFBundleIdentifier","-string",f"com.billieweather.client.qa.{sfx}",d+"/Contents/Info.plist"],check=True)
    subprocess.run(["codesign","--force","--sign","-","--identifier",f"com.billieweather.client.qa.{sfx}",d],check=True,capture_output=True); return d
def prepare(a,kill=None):
    s=time.time(); p=subprocess.Popen([exe(a),"--billie-vision-prepare"],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try: rcode=p.wait(kill or PREP+5)
    except subprocess.TimeoutExpired: p.kill(); p.wait(); rcode="killed"
    return rcode, round(time.time()-s,2)
def start(a,page=1): return subprocess.Popen([exe(a),"--billie-vision-worker",L,str(page)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
def op(a,data,page=1):
    s=time.time(); p=start(a,page)
    try: out,_=p.communicate(data,timeout=OP)
    except subprocess.TimeoutExpired: p.kill(); p.communicate(); return "TIMEOUT",round(time.time()-s,2),None
    return ("ok",round(time.time()-s,2),json.loads(out)) if p.returncode==0 else (f"EXIT{p.returncode}",round(time.time()-s,2),None)
img=lambda n:open(f"{fx}/{n}","rb").read()
names=["us-debit-credit.png","us-signed-amount.jpg","zh-cn.png","zh-tw.png","us-blurred.png","us-rotated-90.png","us-skew-3.png"]
def good(n,r): return bool(r and r["pages"] and r["pages"][0]["lines"]) and (n!="us-debit-credit.png" or any("1,286.04" in l["text"] for l in r["pages"][0]["lines"]))
def rep(name,res):
    c={}; ts=sorted(t for _,t in res)
    for k,_ in res: c[k]=c.get(k,0)+1
    print(f"{name}: n={len(res)} {c} min={ts[0]} p50={ts[len(ts)//2]} p95={ts[max(0,int(len(ts)*.95)-1)]} max={ts[-1]}",flush=True)
v1=make("v1"); print("1 fresh identity, uninterrupted cold preparation:",prepare(v1),"| warm preparation:",prepare(v1),flush=True)
k,t,r=op(v1,img(names[0])); print("2 first recognition after preparation:",k,t,"correct" if good(names[0],r) else "WRONG",flush=True)
v2=make("v2"); print("3 fresh identity, preparation stopped at 5 s:",prepare(v2,5),"| next 18 s request:",op(v2,img(names[0]))[:2],"| full preparation:",prepare(v2),"| recognition:",op(v2,img(names[0]))[:2],flush=True)
v3=make("v3"); out={}
th=threading.Thread(target=lambda:out.update(p=prepare(v3))); th.start(); time.sleep(1); out["o"]=op(v3,img(names[0])); th.join()
print("4 fresh identity, request 1 s into preparation:",out["o"][:2],"| preparation:",out["p"],"| after:",op(v3,img(names[0]))[:2],flush=True)
res=[]
for i in range(60):
    n=names[i%7]; k,t,r=op(v1,img(n)); res.append((k if k!="ok" else "ok" if good(n,r) else "WRONG",t))
rep("5 sequential images",res); res=[]
for i in range(15):
    for pg in (1,2): k,t,r=op(v1,img(f"multipage-{pg}.png"),pg); res.append((k if k!="ok" or r["pages"][0]["page"]==pg else "WRONGPAGE",t))
rep("6 two-page document pages",res); res=[]; d=img(names[0])
for i in range(15):
    ps=[(time.time(),start(v1)) for _ in range(3)]; got=[None]*3
    def go(j):
        s,p=ps[j]
        try: o,_=p.communicate(d,timeout=OP); got[j]=("ok" if p.returncode==0 and good(names[0],json.loads(o)) else f"EXIT{p.returncode}",round(time.time()-s,2))
        except subprocess.TimeoutExpired: p.kill(); p.communicate(); got[j]=("TIMEOUT",OP)
    ts=[threading.Thread(target=go,args=(j,)) for j in range(3)]; [x.start() for x in ts]; [x.join() for x in ts]; res+=got
rep("7 three at once",res); res=[]
for i in range(20):
    p=start(v1); p.stdin.write(img("zh-cn.png")); p.stdin.close(); time.sleep(random.uniform(.01,.35)); p.kill(); p.wait(); p.stdout.close()
    k,t,r=op(v1,d); res.append((k if k!="ok" else "ok" if good(names[0],r) else "WRONG",t))
rep("8 cancel, then recognise",res); res=[]
bad=[b"not an image",b"\x89PNG\r\n\x1a\n"+b"\0"*64,d[:2000],b"%PDF-1.7 junk"]
for i in range(20):
    k,t,r=op(v1,bad[i%4]); res.append(("handled" if k=="ok" and (r["errors"] or not r["pages"][0]["lines"]) else k,t))
rep("9 invalid input",res); print("  empty input:",op(v1,b"")[:2])
res=[]
for i in range(20): c,t=prepare(v1); res.append(("ok" if c==0 else f"rc{c}",t))
rep("10 repeated preparation",res)
u=f"{work}/cold-v1-update.app"; shutil.rmtree(u,ignore_errors=True); shutil.copytree(v1,u,symlinks=True); open(u+"/Contents/Resources/update-marker","w").write("2")
subprocess.run(["codesign","--force","--sign","-","--identifier","com.billieweather.client.qa.v1",u],check=True,capture_output=True)
print("11 approximate app update (same identity, re-signed, new path and hash): first recognition",op(u,d)[:2],"| preparation",prepare(u),flush=True)
p=start(v1); ppid=p.pid; p.stdin.write(d[:100]); p.stdin.flush(); s=time.time()
try: code=p.wait(30)
except subprocess.TimeoutExpired: code="still running"; p.kill(); p.wait()
print("12 worker never given its image ends by its own watchdog: exit",code,round(time.time()-s,1),"s",flush=True)
sh=subprocess.Popen(["/bin/sh","-c",f"'{exe(v1)}' --billie-vision-worker {L} 1 < /dev/zero >/dev/null 2>&1 & echo $!; sleep 0.5"],stdout=subprocess.PIPE,text=True); pid=int(sh.stdout.readline()); sh.wait(); time.sleep(3)
try: os.kill(pid,0); alive=True
except ProcessLookupError: alive=False
print("13 worker whose parent exited: alive after 3 s =",alive,flush=True)
left=[l for l in subprocess.run(["ps","-axo","comm="],capture_output=True,text=True).stdout.split("\n") if l.startswith(work)]
print("14 leftover workers:",len(left),"| total",round(time.time()-t0),"s")
