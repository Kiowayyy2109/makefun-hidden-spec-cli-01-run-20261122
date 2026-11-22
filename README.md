# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kiowayyy2109/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kiowayyy2109/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and mend reads all four to one specification:
unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A
patches, and JSON text-editor tool calls. It finds the lines an edit names
even when their whitespace or indentation drifted, and it changes every file
or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory; without it,
  or with `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: same output and exit code, no file
  created, changed, or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` when the tree is written (`ok: N files`), `1` when edits
failed (`failed: K of N edits`, nothing written), `2` on a usage, missing
patch, format, or parse error.

Node 22 and its standard library only. No dependencies, no model calls,
no times or randomness in any output.
