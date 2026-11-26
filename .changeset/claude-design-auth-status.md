---
'@nicknisi/pi-claude-design': patch
---

`/design-login` reports its code paste prompt as a login (`blockedKind: "auth"`), so terminals with program status (OSC 7501) show it as one instead of as a question. Needs pi 1.6.1 to take effect; older pi ignores the option.
