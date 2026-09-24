#!/usr/bin/env bash
# End-to-end run of sign-up email verification, the Clients page and bookkeeper
# invitations against STAGING, driven through ego-browser so it plays out live in
# Ego Lite (watch the task space "CSP staging E2E <run>").
#
#   scripts/staging-e2e/run.sh            # fresh run, addresses tagged with the time
#   scripts/staging-e2e/run.sh 1430       # pick the tag yourself
#
# Each run signs up three fresh plus-addresses on johnley00@gmail.com, so the real
# SendGrid mails land in that inbox. Verification links are minted through the
# SuperTokens SDK (identical to the emailed ones) so the run never waits on the inbox.
# Nothing here touches production.
set -euo pipefail
cd "$(dirname "$0")/../.."

RUN="${1:-$(date +%H%M%S)}"
BASE="https://csp-fe-n32ggvrsvq-uc.a.run.app"
BE="https://csp-be-n32ggvrsvq-uc.a.run.app"
STATE_DIR=/tmp/csp-staging-e2e
STATE="$STATE_DIR/state.json"
mkdir -p "$STATE_DIR"

helper() {
  NODE_ENV=staging DOTENV_CONFIG_PATH=.env.staging npx ts-node -r dotenv/config scripts/staging-e2e/helper.ts "$@" 2>/dev/null | grep '^{' | tail -1
}
state_set() { # key, json-value
  python3 - "$STATE" "$1" "$2" <<'PY'
import json, sys
p, k, v = sys.argv[1:]
s = json.load(open(p)); s[k] = json.loads(v); json.dump(s, open(p, 'w'), indent=2)
PY
}
state_get() { python3 -c "import json,sys; print(json.load(open('$STATE'))['$1'])"; }
browser() {
  state_set phase "\"$1\""
  echo; echo "── browser phase $1 ──"
  ego-browser nodejs < scripts/staging-e2e/browser.mjs
}
record() { # name, ok(true/false), detail
  python3 - "$STATE" "$1" "$2" "$3" <<'PY'
import json, sys
p, name, ok, detail = sys.argv[1:]
s = json.load(open(p)); s['results'].append({'phase': 'helper', 'name': name, 'ok': ok == 'true', 'detail': detail}); json.dump(s, open(p, 'w'), indent=2)
print(('PASS' if ok == 'true' else 'FAIL') + '  ' + name + ('  (' + detail + ')' if detail else ''))
PY
}

summary() {
echo; echo "══════════ RESULTS — run $RUN ══════════"
python3 - "$STATE" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
fails = [r for r in s['results'] if not r['ok']]
for r in s['results']:
    print(f"{'PASS' if r['ok'] else 'FAIL'}  [{r['phase']}] {r['name']}" + (f"  ({r['detail']})" if r['detail'] and not r['ok'] else ''))
print(f"\n{len(s['results']) - len(fails)} passed, {len(fails)} failed. Screenshot: /tmp/csp-staging-e2e/invitee-in-app.png")
sys.exit(1 if fails else 0)
PY
}
trap summary EXIT

cat > "$STATE" <<EOF
{
  "run": "$RUN", "base": "$BASE", "be": "$BE", "password": "StagingTest2026!",
  "client": "johnley00+stg$RUN-client@gmail.com",
  "bk": "johnley00+stg$RUN-bk@gmail.com",
  "invitee": "johnley00+stg$RUN-invitee@gmail.com",
  "church": "E2E Church $RUN",
  "results": []
}
EOF
echo "Run $RUN — accounts: $(state_get client), $(state_get bk), $(state_get invitee)"
echo "Watch it in Ego Lite: task space \"CSP staging E2E $RUN\""

browser A

CLIENT_MINT=$(helper mint "$(state_get client)")
state_set clientLink "$(python3 -c "import json,sys; print(json.dumps(json.loads(sys.argv[1])['link']))" "$CLIENT_MINT")"
record "verification token minted for the client (same link the email carries)" "$(python3 -c "import json,sys; print(str(bool(json.loads(sys.argv[1]).get('link'))).lower())" "$CLIENT_MINT")" ""

browser B

BK_MINT=$(helper mint "$(state_get bk)")
state_set bkLink "$(python3 -c "import json,sys; print(json.dumps(json.loads(sys.argv[1])['link']))" "$BK_MINT")"

browser C

CLIENT_ROW=$(helper client-row "$(state_get church) (via Clients page)")
record "Clients page wrote a client row linked to the bookkeeper" \
  "$(python3 -c "import json,sys; r=json.loads(sys.argv[1]); print(str(len(r)==1 and r[0]['role']=='client' and r[0]['bookkeeperUserId'] is not None and r[0]['inviteAccepted'] is True).lower())" "$CLIENT_ROW")" \
  "$(python3 -c "import json,sys; r=json.loads(sys.argv[1]); print(r[0]['email'] if r else 'no row')" "$CLIENT_ROW")"

browser D

INVITE=$(helper invite-link "$(state_get invitee)")
state_set inviteLink "$(python3 -c "import json,sys; print(json.dumps(json.loads(sys.argv[1])['link']))" "$INVITE")"
record "invitation row exists with a token, not yet accepted" \
  "$(python3 -c "import json,sys; r=json.loads(sys.argv[1]); print(str(bool(r.get('invitationToken')) and r.get('inviteAccepted') is False).lower())" "$INVITE")" ""

browser E

INVITEE=$(helper invitee-row "$(state_get invitee)")
record "invitation row now accepted and linked to the new bookkeeper login" \
  "$(python3 -c "import json,sys; r=json.loads(sys.argv[1]); print(str(r.get('inviteAccepted') is True and r.get('userId') is not None and r.get('role')=='bookkeeper').lower())" "$INVITEE")" \
  "$(python3 -c "import json,sys; print(json.dumps(json.loads(sys.argv[1])))" "$INVITEE")"

