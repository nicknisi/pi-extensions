---
'@nicknisi/pi-llm-council': patch
---

Project-local council config is now ignored in untrusted projects, failed councils are reported as tool errors (with a ✗ header and a "not run" synthesizer row), and malformed config files no longer crash the tool. The header spinner now stops when its tool call ends even if the component is discarded, and the README is updated to match current behavior.
