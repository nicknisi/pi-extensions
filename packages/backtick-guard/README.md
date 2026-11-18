# @nicknisi/pi-backtick-guard

Stops the agent's `bash` calls from running backtick command substitutions by accident, and helps it recover from macOS bash 3.2's heredoc bug.

Ported from the `backtick-guard` extension in [fitchmultz/pi-fitch-kit](https://github.com/fitchmultz/pi-fitch-kit).

## Install

```bash
pi install npm:@nicknisi/pi-backtick-guard
```

## What it adds

No commands, tools, or settings. It adds two event handlers.

### Backtick refusal (`tool_call`)

Models often put prose inside a double-quoted shell argument, such as a PR body or a commit message. The shell still expands that text, so a Markdown code span like `` `env` `` runs as a command and its output replaces the span. With `env`, the published text contains every environment variable.

The guard parses the command with [`sh-syntax`](https://github.com/un-ts/sh-syntax), a WebAssembly build of the `mvdan/sh` bash parser, and refuses the call before the shell starts if bash would run a backtick substitution. Nothing in a refused command runs.

| Command text                                                | Result  |
| ----------------------------------------------------------- | ------- |
| Backticks in double quotes or in an unquoted word           | Refused |
| Backticks in a heredoc with an unquoted delimiter (`<<EOF`) | Refused |
| A command with a backtick that the parser can't read        | Refused |
| Backticks in single quotes                                  | Runs    |
| Backticks in a heredoc with a quoted delimiter (`<<'EOF'`)  | Runs    |
| Backticks in a comment, or after a backslash                | Runs    |
| `$(...)` command substitution                               | Runs    |

An unreadable command is refused because bash runs the lines before a syntax error. Commands without a backtick are never parsed.

The refusal tells the model what to do instead:

```text
Blocked: backtick command substitution. The shell would run `env` as a command and paste its output into this one. Nothing ran. For a real substitution write $(...). To pass text that contains backticks, put the text in a file (a quoted heredoc, <<'EOF', keeps backticks literal) and pass the file, for example with --body-file.
```

`bash` calls made from a `codemode` script go through the same check.

### Heredoc hint (`tool_result`)

Pi runs commands with `/bin/bash` when it exists, which on macOS is bash 3.2. That version can't parse an apostrophe inside a heredoc nested in `$(...)`, the usual way agents pass a PR body:

```bash
gh pr create --body "$(cat <<'EOF'
It's ready.
EOF
)"
# /bin/bash: unexpected EOF while looking for matching `''
```

When a `bash` call fails with that error and the command has `$(cat <<`, the guard adds a hint to the error the model sees: write the text to a file first and pass it with `--body-file` or `git commit -F`. The command itself is unchanged and still fails; the hint only saves the model from guessing at quoting.

## Why

From an audit of about 97,000 `bash` calls in local Pi session logs:

- The guard would have refused 21 commands: about 20 correctly (bash would have run the backticks) and 1 falsely. In 7 of them, a code span in prose really ran and its output replaced the text. A span like `` `env` `` in a PR or issue body publishes that output.
- 63 of the 117 commands with a heredoc inside `$(...)` failed with the bash 3.2 error, and every one of those had an apostrophe in the heredoc text.

## Caveats

- Only the `bash` tool is checked. Commands you type yourself with `!` are not.
- The parser follows current bash rules, so it doesn't predict bash 3.2's heredoc bug; that's why the hint runs on the failure instead of refusing up front.
- Depends on `sh-syntax` (about 4 MB, mostly the WebAssembly parser).
