#!/usr/bin/env bash
# End-to-end run of sign-up email verification, churches (the sidebar switcher, the Churches page)
# and the People tab, driven through ego-browser so it plays out live in Ego Lite (watch the task
# space "CSP <env> E2E <run>"). Staging by default.
#
#   scripts/staging-e2e/run.sh            # fresh run, addresses tagged with the time
#   scripts/staging-e2e/run.sh 1430       # pick the tag yourself
#   scripts/staging-e2e/run.sh 1430 E     # resume run 1430 from stage E (A-G), reusing its state
#
# Stages: A  client sign-up stops at check-your-inbox; unverified login is refused
#         B  the client verifies and lands on its own church; a bookkeeper signs up
#         C  the bookkeeper verifies; the owner adds and renames a church, invites the bookkeeper
#            (an existing login) and a new address (an invite link)
#         D  the new address accepts the link
#         E  the bookkeeper's view and the cross-church guard; the owner lets them connect
#         F  the bookkeeper sees Integrations; the owner switches it off again
#         G  the owner removes the bookkeeper and deactivates the church
#
# A local stack instead (backend from this checkout on :8080, frontend on :3000):
#   E2E_ENV=development BASE=http://localhost:3000 BE=http://localhost:8080 scripts/staging-e2e/run.sh
# E2E_ENV is the NODE_ENV the helper reads the database with; its env file is .env for
# development and .env.<E2E_ENV> otherwise (E2E_ENV_FILE overrides). Two local traps:
#   - Serve a production build of the frontend, not `npm start`: React StrictMode runs the
#     verify page's effect twice, so a good link spends its token and then reads "expired".
#   - Sign-up hangs if the verification mail is refused (app.ts's SuperTokens error handler never
#     answers), so a backend with mail disabled needs @sendgrid/mail's send stubbed to succeed.
#
# On staging each run signs up three fresh plus-addresses on johnley00@gmail.com, so any mail
# SendGrid does deliver lands in that inbox. Verification links are minted through the SuperTokens
# SDK (the token the email carries) and the invite link is read off the People tab, so the run
# never waits on an inbox. Nothing here touches production.
set -euo pipefail
cd "$(dirname "$0")/../.."

RUN="${1:-$(date +%H%M%S)}"
FROM="${2:-A}"
stage() { [[ "$1" < "$FROM" ]] && return 1 || return 0; }
E2E_ENV="${E2E_ENV:-staging}"
BASE="${BASE:-https://csp-fe-n32ggvrsvq-uc.a.run.app}"
BE="${BE:-https://csp-be-n32ggvrsvq-uc.a.run.app}"
if [[ "$E2E_ENV" == development ]]; then
  E2E_ENV_FILE="${E2E_ENV_FILE:-.env}"
else
  E2E_ENV_FILE="${E2E_ENV_FILE:-.env.$E2E_ENV}"
fi
STATE_DIR=/tmp/csp-staging-e2e
STATE="$STATE_DIR/state.json"
mkdir -p "$STATE_DIR"

# It signs up accounts and invites people: never against production.
case "$E2E_ENV" in production|uat-prd|prd) echo "refusing: E2E_ENV=$E2E_ENV is production"; exit 2 ;; esac
[[ "$BASE$BE" == *-prd-* ]] && { echo "refusing: BASE/BE point at production"; exit 2; }

# The helper reads one database and the browser drives one site: refuse a run that mixes them.
is_local() { [[ "$1" == http://localhost* || "$1" == http://127.0.0.1* ]]; }
if [[ "$E2E_ENV" == development ]]; then
  if ! is_local "$BASE" || ! is_local "$BE"; then echo "E2E_ENV=development reads the local database: set BASE and BE to the local stack"; exit 2; fi
elif is_local "$BASE" || is_local "$BE"; then
  echo "BASE/BE are local, but E2E_ENV=$E2E_ENV reads another database: set E2E_ENV=development"; exit 2
fi
[[ -f "$E2E_ENV_FILE" ]] || { echo "no $E2E_ENV_FILE in $(pwd)"; exit 2; }
case "$E2E_ENV" in staging) ADDR=stg ;; development) ADDR=loc ;; *) ADDR="$E2E_ENV" ;; esac

helper() {
  { NODE_ENV="$E2E_ENV" DOTENV_CONFIG_PATH="$E2E_ENV_FILE" npx ts-node -r dotenv/config scripts/staging-e2e/helper.ts "$@" 2>/dev/null \
    | grep '^[{[]' | tail -1; } || echo '{"error": "helper printed nothing"}'
}
state_set() { # key, json-value
  python3 - "$STATE" "$1" "$2" <<'PY'
import json, sys
p, k, v = sys.argv[1:]
s = json.load(open(p)); s[k] = json.loads(v); json.dump(s, open(p, 'w'), indent=2)
PY
}
state_get() { python3 -c "import json,sys; print(json.load(open('$STATE')).get('$1'))"; }
pick() { # json, python expression over r (the json) and st (the state) -> json
  python3 - "$STATE" "$1" "$2" <<'PY'
import json, sys
p, raw, expr = sys.argv[1:]
try: print(json.dumps(eval(expr, {'r': json.loads(raw), 'st': json.load(open(p))})))
except Exception: print('null')
PY
}
verify() { # name, json, python expression over r and st that must hold, [python expression for the detail]
  python3 - "$STATE" "$STAGE" "$1" "$2" "$3" "${4:-}" <<'PY'
import json, sys
p, stage, name, raw, expr, dexpr = sys.argv[1:]
try: r = json.loads(raw)
except ValueError: r = {'unparsed': raw}
s = json.load(open(p))
env = {'r': r, 'st': s}
try: ok = bool(eval(expr, env))
except Exception: ok = False
try: detail = str(eval(dexpr, env)) if dexpr else ('' if ok else json.dumps(r))
except Exception as e: detail = repr(e)
s['results'].append({'phase': stage, 'name': name, 'ok': ok, 'detail': detail}); json.dump(s, open(p, 'w'), indent=2)
print(('PASS' if ok else 'FAIL') + '  ' + name + ('  (' + detail + ')' if detail else ''))
PY
}
browser() {
  state_set phase "\"$1\""
  echo; echo "── browser phase $1 ──"
  ego-browser nodejs < scripts/staging-e2e/browser.mjs
}

summary() {
echo; echo "══════════ RESULTS — run $RUN ($BASE) ══════════"
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

if [[ "$FROM" == "A" ]]; then
cat > "$STATE" <<EOF
{
  "run": "$RUN", "env": "$E2E_ENV", "base": "$BASE", "be": "$BE", "password": "StagingTest2026!",
  "space": "CSP $E2E_ENV E2E $RUN",
  "client": "johnley00+$ADDR$RUN-client@gmail.com",
  "bk": "johnley00+$ADDR$RUN-bk@gmail.com",
  "invitee": "johnley00+$ADDR$RUN-invitee@gmail.com",
  "nobody": "johnley00+$ADDR$RUN-nobody@gmail.com",
  "church": "E2E Church $RUN",
  "church2": "E2E Second $RUN",
  "church2New": "E2E Second $RUN renamed",
  "results": []
}
EOF
elif [[ ! -f "$STATE" || "$(state_get run)" != "$RUN" ]]; then
  echo "no state for run $RUN to resume from"; exit 2
elif [[ "$(state_get base)" != "$BASE" ]]; then
  echo "run $RUN was against $(state_get base), not $BASE"; exit 2
else
  # Re-running stages from $FROM: drop their earlier results so the table is not doubled.
  python3 - "$STATE" "$FROM" <<'PY'
import json, sys
p, f = sys.argv[1:]
s = json.load(open(p)); s['results'] = [r for r in s['results'] if r['phase'] < f]; s.pop('phase', None); json.dump(s, open(p, 'w'), indent=2)
PY
fi
trap summary EXIT
echo "Run $RUN on $BASE — accounts: $(state_get client), $(state_get bk), $(state_get invitee)"
echo "Watch it in Ego Lite: task space \"$(state_get space)\""

STAGE=A
stage A && browser A

if stage B; then
STAGE=B
MINT=$(helper mint "$(state_get client)")
state_set clientToken "$(pick "$MINT" "r.get('token')")"
verify "verification token minted for the client (the token the email carries)" "$MINT" \
  "bool(r.get('token')) or r.get('status') == 'EMAIL_ALREADY_VERIFIED_ERROR'" "r.get('status')"

browser B
fi

if stage C; then
STAGE=C
MINT=$(helper mint "$(state_get bk)")
state_set bkToken "$(pick "$MINT" "r.get('token')")"

browser C

CLIENT=$(helper churches "$(state_get client)")
state_set ownChurchId "$(pick "$CLIENT" "next(c['id'] for c in r['churches'] if c['ownerUserId'] == r['userId'])")"
state_set churchId "$(pick "$CLIENT" "next(c['id'] for c in r['churches'] if c['name'] == st['church2New'])")"
verify "the client's own church is filed under its own login, and it is the owner" "$CLIENT" \
  "any(c['name'] == st['church'] and c['ownerUserId'] == r['userId'] and c['memberRole'] == 'owner' and c['inviteAccepted'] for c in r['churches'])"
verify "the added church: client is its owner; filed under its own account row; renamed; active" "$CLIENT" \
  "any(c['id'] == st['churchId'] and c['memberRole'] == 'owner' and c['ownerUserId'] != r['userId'] and (c['accountEmail'] or '').endswith('@accounts.churchsyncpro.invalid') and c['isActive'] for c in r['churches'])"

BKM=$(helper member "$(state_get churchId)" "$(state_get bk)")
verify "existing login added straight away: an accepted bookkeeper member, no integration access" "$BKM" \
  "r.get('role') == 'bookkeeper' and r.get('inviteAccepted') is True and r.get('userId') is not None and r.get('integrationAccessEnabled') is False"

INV=$(helper member "$(state_get churchId)" "$(state_get invitee)")
verify "new address: a pending bookkeeper invite with a token and no login" "$INV" \
  "r.get('role') == 'bookkeeper' and r.get('inviteAccepted') is False and r.get('userId') is None and bool(r.get('invitationToken'))"
verify "the invite link shown on People carries that invite's token" "$INV" \
  "bool(r.get('invitationToken')) and ('invitationToken=' + r['invitationToken']) in (st.get('inviteLink') or '')" \
  "st.get('inviteLink')"
fi

if stage D; then
STAGE=D
browser D

INV=$(helper member "$(state_get churchId)" "$(state_get invitee)")
verify "invitation accepted and linked to the invitee's new bookkeeper login" "$INV" \
  "r.get('inviteAccepted') is True and r.get('userId') is not None and r.get('userRole') == 'bookkeeper'"
fi

if stage E; then
STAGE=E
browser E

BKM=$(helper member "$(state_get churchId)" "$(state_get bk)")
verify "access switch saved: integrationAccessEnabled is true" "$BKM" "r.get('integrationAccessEnabled') is True"
fi

if stage F; then
STAGE=F
browser F

BKM=$(helper member "$(state_get churchId)" "$(state_get bk)")
verify "access switch saved: integrationAccessEnabled is false again" "$BKM" "r.get('integrationAccessEnabled') is False"
fi

if stage G; then
STAGE=G
browser G

BKM=$(helper member "$(state_get churchId)" "$(state_get bk)")
verify "the bookkeeper's membership row is gone" "$BKM" "r.get('none') is True"
CH=$(helper church "$(state_get churchId)")
verify "the church is inactive in the database" "$CH" "r.get('isActive') is False"
fi
