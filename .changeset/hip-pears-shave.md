---
'@nicknisi/pi-relay': patch
---

Resolve the relay root before opening it, so a symlinked pi home no longer disables relay entirely. The filesystem hardening refuses user-controlled ancestor symlinks, which is correct for ongoing operations but rejected the common dotfiles arrangement (`~/.pi -> ~/Developer/dotfiles/home/.pi`) — and since pi keeps everything under `~/.pi`, registration failed on every start. The root is now resolved once, up front, so later operations traverse only real directories and no user symlink remains in the path to swap. Startup failures are also recorded and reported instead of discarded, so the tools name the real cause rather than reporting that `session_start` has not run.
