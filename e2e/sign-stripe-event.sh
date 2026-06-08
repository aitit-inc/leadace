#!/usr/bin/env bash
# Sign a Stripe webhook event body the way the backend verifies it
# (services/stripe-webhook.ts verifyStripeSignature): HMAC-SHA256 over
# "<timestamp>.<rawbody>" with the webhook secret, emitted as the
# `stripe-signature` header value `t=<unix>,v1=<hex>`. This is to the Stripe
# webhook what sign-unsubscribe-token.sh is to the unsubscribe route — a local
# HMAC mirror of the backend so the curl harness can forge valid (and
# deliberately invalid) signatures without a real Stripe account.
#
# The HMAC covers the request body byte-for-byte, so the caller MUST send the
# EXACT bytes passed here. Build the body once with `jq -c` (compact, no
# trailing newline after command substitution) and hand the same string to
# both this script and `curl --data`.
#
# Usage:
#   SIG="$(./e2e/sign-stripe-event.sh "$SECRET" "$BODY")"
#   curl -H "stripe-signature: $SIG" --data "$BODY" .../api/stripe/webhook
#
# Flags:
#   --stale     timestamp 400s in the past (outside the 300s tolerance → 401)
#   --bad-sig   correct timestamp, deliberately wrong v1 signature (→ 401)
#
# Output: the stripe-signature header value, single line on stdout.

set -euo pipefail

STALE=0
BAD=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stale)   STALE=1; shift ;;
    --bad-sig) BAD=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *)         ARGS+=("$1"); shift ;;
  esac
done

SECRET="${ARGS[0]:-}"
BODY="${ARGS[1]:-}"
[[ -n "$SECRET" ]] || { echo "usage: sign-stripe-event.sh [--stale|--bad-sig] <secret> <body>" >&2; exit 2; }

NOW="$(date +%s)"
TS="$NOW"
[[ "$STALE" == "1" ]] && TS="$((NOW - 400))"

# Node (not openssl) for the HMAC: identical primitive to the backend's
# crypto.subtle HMAC-SHA256, and no LibreSSL/OpenSSL output-format drift.
SECRET="$SECRET" BODY="$BODY" TS="$TS" BAD="$BAD" node -e '
const crypto = require("crypto");
const ts = process.env.TS;
const sig = crypto.createHmac("sha256", process.env.SECRET).update(`${ts}.${process.env.BODY}`).digest("hex");
const v1 = process.env.BAD === "1" ? "0".repeat(sig.length) : sig;
process.stdout.write(`t=${ts},v1=${v1}`);
'
