#!/bin/bash
# Full-stack smoke: every new package in stack #19, in one combined extension
# environment (-ne isolates from installed third-party extensions).
#
# Requires: pi on PATH (npm i -g @earendil-works/pi-coding-agent) and an
# Anthropic provider key (ANTHROPIC_API_KEY) — every step spawns real pi runs
# against claude-haiku-4-5.
set -u
PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages" && pwd)"
EXTS="-ne -e $PKG/llm-council/index.ts -e $PKG/subagents/index.ts -e $PKG/codemode/index.ts -e $PKG/relay/index.ts"
export PI_RELAY_DIR=/tmp/smoke-relay
rm -rf /tmp/smoke-relay /tmp/smoke-a /tmp/smoke-b /tmp/smoke-council
mkdir -p /tmp/smoke-a /tmp/smoke-b /tmp/smoke-council/.pi/configs
cat > /tmp/smoke-council/.pi/configs/llm-council.json <<'EOF'
{
  "member": {
    "council": [
      { "model": "anthropic/claude-haiku-4-5", "displayName": "Haiku A", "label": "A" },
      { "model": "anthropic/claude-haiku-4-5", "displayName": "Haiku B", "label": "B" }
    ],
    "thinking": "low",
    "tools": []
  },
  "chairman": { "model": "anthropic/claude-haiku-4-5", "displayName": "Haiku Chair", "thinking": "low", "tools": [] }
}
EOF
PASS=0; FAIL=0
check() { # check <name> <logfile> <pattern>
  if grep -qi "$3" "$2"; then echo "✅ PASS: $1"; PASS=$((PASS+1)); else echo "❌ FAIL: $1 (see $2)"; FAIL=$((FAIL+1)); fi
}

echo "── 1/7 load: all four extensions together"
cd /tmp/smoke-a && pi -p --no-session $EXTS "Reply with exactly: LOAD-OK" > /tmp/smoke-1.log 2>&1
check "all extensions load, no tool conflicts" /tmp/smoke-1.log "LOAD-OK"

echo "── 2/7 dispatch: 2-way fan-out"
cd /tmp/smoke-a && pi -p --no-session $EXTS "Use the dispatch tool to run two parallel child agents, both with model anthropic/claude-haiku-4-5: one answers 'what is 5+5?', the other answers 'what is the capital of Japan?'. Report both answers." > /tmp/smoke-2.log 2>&1
check "dispatch fan-out returns both answers" /tmp/smoke-2.log "10"
grep -qi "tokyo" /tmp/smoke-2.log && echo "   (tokyo ✓)" || { echo "❌ FAIL: dispatch tokyo"; FAIL=$((FAIL+1)); }

echo "── 3/7 fleet: persisted runs visible"
cd /tmp/smoke-a && pi -p --no-session $EXTS "Use the fleet tool with action list. How many runs do you see and from which namespaces? Answer briefly." > /tmp/smoke-3.log 2>&1
check "fleet lists persisted dispatch runs" /tmp/smoke-3.log "subagents"

echo "── 4/7 codemode: spawn composition"
cd /tmp/smoke-a && pi -p --no-session $EXTS 'Use the codemode tool exactly once with this code (pass it through verbatim):
const [a, b] = await Promise.all([
  spawn({ prompt: "Answer with just the number: 6*7", model: "anthropic/claude-haiku-4-5", tools: [] }),
  spawn({ prompt: "Answer with just the word: opposite of hot", model: "anthropic/claude-haiku-4-5", tools: [] })
]);
export default { product: a.ok ? a.text : "ERR", opposite: b.ok ? b.text : "ERR" };
Report the result.' > /tmp/smoke-4.log 2>&1
check "codemode Promise.all spawn fan-out" /tmp/smoke-4.log "42"
grep -qi "cold" /tmp/smoke-4.log && echo "   (cold ✓)" || { echo "❌ FAIL: codemode cold"; FAIL=$((FAIL+1)); }

echo "── 5/7 codemode runWorkflow: 2-stage DAG with typed handoff"
cd /tmp/smoke-a && pi -p --no-session $EXTS 'Use the codemode tool exactly once with this code (pass it through verbatim):
const r = await runWorkflow({
  name: "smoke",
  stages: [
    { id: "a", needs: [], model: "anthropic/claude-haiku-4-5", tools: [], prompt: "Answer with just the number: 9*9" },
    { id: "b", model: "anthropic/claude-haiku-4-5", tools: [], prompt: (ctx) => `Stage a answered: "${ctx.results.a.ok ? ctx.results.a.output : "?"}" — restate the number and append DONE.` }
  ]
});
export default { ok: r.ok, b: r.outcomes.b.ok ? r.outcomes.b.output : "FAILED" };
Report what came back.' > /tmp/smoke-5.log 2>&1
check "runWorkflow typed handoff (81 + DONE)" /tmp/smoke-5.log "81"
grep -q "DONE" /tmp/smoke-5.log && echo "   (DONE ✓)" || { echo "❌ FAIL: workflow DONE"; FAIL=$((FAIL+1)); }

echo "── 6/7 llm-council: members + chairman synthesis"
cd /tmp/smoke-council && pi -p --no-session $EXTS "Use the llm_council tool with question: 'Is a hot dog a sandwich? One sentence verdict.' Report the chairman's synthesis." > /tmp/smoke-6.log 2>&1
check "council chairman synthesis" /tmp/smoke-6.log "sandwich"

echo "── 7/7 relay: live two-session delivery"
cd /tmp/smoke-b && pi -p --no-session $EXTS "Use the bash tool to run: sleep 25. Then say B-DONE." > /tmp/smoke-7b.log 2>&1 &
B_PID=$!
sleep 6
B_ADDR=$(ls $PI_RELAY_DIR 2>/dev/null | grep -o '^[a-f0-9]*' | head -1)
if [ -z "$B_ADDR" ]; then echo "❌ FAIL: relay B never registered"; FAIL=$((FAIL+1)); else
  cd /tmp/smoke-a && pi -p --no-session $EXTS "Use the relay tool to send this exact message to the session at address $B_ADDR: 'full-stack smoke says hi'. Report the exact verdict." > /tmp/smoke-7a.log 2>&1
  check "relay live delivery receipt" /tmp/smoke-7a.log "delivered"
  wait $B_PID; sleep 1
  check "relay B received the message mid-run" /tmp/smoke-7b.log "peer\|smoke-a\|another pi session"
fi

echo
echo "════════════════════════════════"
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
