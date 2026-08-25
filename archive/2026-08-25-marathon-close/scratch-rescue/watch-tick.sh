#!/bin/zsh
# coldrig 4-leg watch tick — read-only HTTPS. Writes l1..l4.json into cwd (scratchpad).
TOK=$(security find-generic-password -s admin-token -a coldrig -w) || { echo "NO ADMIN TOKEN"; exit 1; }
IK=$(security find-generic-password -s inboxkit-api-key -a coldrig -w) || { echo "NO INBOXKIT KEY"; exit 1; }
WS=c5188ced-33db-436f-b970-1860e6c8c66b
echo "L1 $(curl -sS -m 60 -o l1.json -w '%{http_code}' -H "Authorization: Bearer $TOK" https://api.coldrig.dev/admin/support/digest)"
echo "L2a $(curl -sS -m 30 -o l2a.json -w '%{http_code}' -X POST -H "Authorization: Bearer $IK" -H "X-Workspace-Id: $WS" -H 'Content-Type: application/json' -d '{"page":1}' https://api.inboxkit.com/v1/api/domains/list)"
echo "L2b $(curl -sS -m 30 -o l2b.json -w '%{http_code}' -X POST -H "Authorization: Bearer $IK" -H "X-Workspace-Id: $WS" -H 'Content-Type: application/json' -d '{"page":1}' https://api.inboxkit.com/v1/api/mailboxes/list)"
echo "L3 $(curl -sS -m 60 -o l3.json -w '%{http_code}' -H "Authorization: Bearer $TOK" 'https://api.coldrig.dev/admin/ops/checks?unhealthy=1')"
echo "L4 $(curl -sS -m 30 -o l4.json -w '%{http_code}' https://api.coldrig.dev/status)"
python3 - <<'EOF'
import json,re,time
def load(n):
    try: return json.load(open(n))
    except Exception as e: return {"_err":str(e),"_raw":open(n).read()[:400]}
st=json.load(open('/Users/yaakovscher/.claude/mordy-watch/last-seen.json'))
print("now(ms):",int(time.time()*1000),"| state:",st.get("updatedAt"))
l1=load('l1.json'); raw1=open('l1.json').read()
print("L1 counts:",l1.get("counts"))
ids=set(re.findall(r'sup_[0-9a-f]{8}',raw1)); known=set(re.findall(r'sup_[0-9a-f]{8}'," ".join(st["ids"])))
print("L1 tickets:",len(ids),"| NEW:",sorted(ids-known),"| gone:",sorted(known-ids))
mx=re.findall(r'"createdAt":\s*(\d{13})',raw1); print("L1 maxCreatedAt:",max(map(int,mx)) if mx else None,"| state:",st.get("maxCreatedAt"))
d=load("l2a.json"); rows=d.get("domains",[]) if isinstance(d,dict) else d
print("L2a domains:",[(r.get("name"),r.get("status"),r.get("dns_propagation_status")) for r in rows])
m=load("l2b.json"); rows=m.get("mailboxes",[]) if isinstance(m,dict) else m
mb=[(r.get("username"),r.get("domain_name"),r.get("status")) for r in rows]
print("L2b mailboxes:",len(mb),mb,"| all active:",all(s=="active" for *_,s in mb) if mb else None)
l3=load('l3.json')
print("L3 unhealthyCount:",l3.get("unhealthyCount"),"| count/total:",l3.get("count"),"/",l3.get("total"),"| truncated:",l3.get("truncated"),"| missing:",l3.get("missing"),"| sweepStale:",l3.get("sweepStale"),"| sweepAge:",l3.get("sweepAgeSeconds"))
for r in l3.get("checks",[]):
    print("  -",r.get("name"),"| lastAlertTs",r.get("lastAlertTs"),"| updatedAt",r.get("updatedAt"),"|",str(r.get("detail"))[:200])
print("L4:",json.dumps(load('l4.json'))[:300])
EOF
