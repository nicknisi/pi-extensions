---
'@nicknisi/pi-composer': patch
---

Include prompt-cache warming in the session cost. pi 1.5.1 warms caches between runs by default and records that spend as usage entries, which the cost item would otherwise skip. (Fixed in statusline on main; statusline is now retired and its footer lives in composer.)
