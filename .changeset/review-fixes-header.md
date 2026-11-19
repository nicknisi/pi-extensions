---
'@nicknisi/pi-header': patch
---

The header now fits every row to the terminal width (dropping the art when too narrow) instead of crashing pi in narrow terminals, stops its animation and stops resetting the header when another extension replaces it, reads the git branch without blocking startup, and reports unknown `/nicknisi-header-size` arguments or config sizes instead of silently cycling or falling back.
