#!/usr/bin/env bash
# End-to-end smoke test against a running server (see GETTING_STARTED.md).
# Requires: curl, openssl, node. Assumes `npm run cli -- seed` was run.
#
#   BASE=http://127.0.0.1:4000 bash examples/smoke.sh
#
# Steps: login -> create workflow (webhook -> branch -> parallel actions -> approval)
# -> publish -> trigger via signed webhook -> approve -> verify completion
# -> publish an every-minute schedule and wait for it to fire.
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:4000}"
PASSWORD="${PASSWORD:-Passw0rd!demo}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Reads a dotted path from JSON on stdin, e.g. `json token` or `json run.status`.
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let v=JSON.parse(d);for(const k of process.argv[1].split("."))v=v==null?v:v[k];console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
step() { printf '\n== %s\n' "$*"; }

login() {
  curl -sf -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" | json token
}

step "health"
curl -sf "$BASE/api/health"; echo

step "login as editor and operator"
EDITOR=$(login editor@example.com)
OPERATOR=$(login operator@example.com)
OPERATOR_ID=$(curl -sf "$BASE/api/auth/me" -H "authorization: Bearer $OPERATOR" | json id)
EDITOR_ID=$(curl -sf "$BASE/api/auth/me" -H "authorization: Bearer $EDITOR" | json id)
echo "editor=$EDITOR_ID operator=$OPERATOR_ID"

step "create workflow from examples/definitions/order-approval.json"
BODY=$(node -e 'const fs=require("fs");console.log(JSON.stringify({name:"Smoke: order approval",definition:JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}))' "$HERE/definitions/order-approval.json")
CREATED=$(curl -sf -X POST "$BASE/api/workflows" -H "authorization: Bearer $EDITOR" -H 'content-type: application/json' -d "$BODY")
WF=$(echo "$CREATED" | json id)
SECRET=$(echo "$CREATED" | json webhook.secret)
echo "workflow=$WF valid=$(echo "$CREATED" | json validation.valid)"

step "share with operator and publish"
curl -sf -X PUT "$BASE/api/workflows/$WF/acl" -H "authorization: Bearer $EDITOR" -H 'content-type: application/json' \
  -d "{\"entries\":[{\"userId\":\"$EDITOR_ID\",\"role\":\"editor\"},{\"userId\":\"$OPERATOR_ID\",\"role\":\"operator\"}]}" > /dev/null
curl -sf -X POST "$BASE/api/workflows/$WF/publish" -H "authorization: Bearer $EDITOR" -H 'content-type: application/json' -d '{"notes":"smoke"}' | json version

step "trigger via HMAC-signed webhook"
PAYLOAD='{"orderId":"PO-1001","amount":4200,"items":[{"sku":"A"},{"sku":"B"}]}'
TS=$(date +%s)
SIG="sha256=$(printf '%s' "$TS.$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"
RUN=$(curl -sf -X POST "$BASE/api/hooks/$WF" -H 'content-type: application/json' -H "x-ewb-timestamp: $TS" \
  -H "x-ewb-signature: $SIG" -H 'idempotency-key: smoke-po-1001' -d "$PAYLOAD" | json runId)
echo "run=$RUN"

step "wait for the approval step"
for _ in $(seq 1 50); do
  STATUS=$(curl -sf "$BASE/api/runs/$RUN" -H "authorization: Bearer $OPERATOR" | json run.status)
  [ "$STATUS" = "waiting" ] && break
  sleep 0.2
done
echo "run status: $STATUS"
APPROVAL=$(curl -sf "$BASE/api/approvals?mine=true&status=pending" -H "authorization: Bearer $OPERATOR" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d).find(x=>x.runId===process.argv[1]);console.log(a?a.id:"")})' "$RUN")
echo "approval=$APPROVAL"

step "approve as operator"
curl -sf -X POST "$BASE/api/approvals/$APPROVAL/decision" -H "authorization: Bearer $OPERATOR" -H 'content-type: application/json' \
  -d '{"decision":"approved","comment":"looks good"}' | json status

step "verify completion"
for _ in $(seq 1 50); do
  DETAIL=$(curl -sf "$BASE/api/runs/$RUN" -H "authorization: Bearer $OPERATOR")
  STATUS=$(echo "$DETAIL" | json run.status)
  [ "$STATUS" = "succeeded" ] && break
  sleep 0.2
done
echo "run status: $STATUS"
echo "run output: $(echo "$DETAIL" | json run.output)"
[ "$STATUS" = "succeeded" ] || { echo "FAILED: run did not complete"; exit 1; }

step "scheduled workflow (fires at the next minute boundary)"
BODY=$(node -e 'const fs=require("fs");console.log(JSON.stringify({name:"Smoke: every minute",definition:JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}))' "$HERE/definitions/every-minute.json")
SCHED=$(curl -sf -X POST "$BASE/api/workflows" -H "authorization: Bearer $EDITOR" -H 'content-type: application/json' -d "$BODY" | json id)
curl -sf -X POST "$BASE/api/workflows/$SCHED/publish" -H "authorization: Bearer $EDITOR" -H 'content-type: application/json' -d '{}' > /dev/null
echo "schedule workflow=$SCHED; waiting up to 75 s"
for _ in $(seq 1 75); do
  FIRED=$(curl -sf "$BASE/api/runs?workflowId=$SCHED" -H "authorization: Bearer $EDITOR" | json items.0.status)
  [ "$FIRED" = "succeeded" ] && break
  sleep 1
done
echo "scheduled run: $(curl -sf "$BASE/api/runs?workflowId=$SCHED" -H "authorization: Bearer $EDITOR" | json items.0.output)"
[ "$FIRED" = "succeeded" ] || { echo "FAILED: schedule did not fire"; exit 1; }

step "dashboard summary"
curl -sf "$BASE/api/metrics/summary?days=1" -H "authorization: Bearer $EDITOR" | json byStatus
echo; echo "SMOKE OK"
