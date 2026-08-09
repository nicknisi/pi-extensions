---
'@nicknisi/pi-codemode': patch
---

Add a "Recipes" section to the codemode README with the Adversarial Gauntlet recipe: a `sharesTree` builder stage with a synchronous critic gate over the real `git diff HEAD` (revise loop, `maxGateAttempts: 3`) plus an independent downstream critic stage over the captured `treeDiffs`. Docs-only; no runtime change.
