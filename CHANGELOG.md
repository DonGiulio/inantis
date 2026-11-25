# Changelog

## Unreleased

- Skip untracked nested Git repositories instead of failing the diff with "Unexpected git numstat output".
- Load diffs faster: up to 8 files are read concurrently and still listed in order (about 5x faster on a 260-file repository).
- Read each file's patch and line counts with one Git call instead of two.

## 0.1.3

- Navigate between discussions and see comment counts beside changed files.
- Highlight the lines and ranges associated with discussions.
- Collapse resolved threads in the Discussions tab while keeping them expandable.
- Preserve the selected comparison when returning from a file or restoring the view.

## 0.1.2

- Show comparison source and base on separate horizontally scrollable rows.
- Show the current branch before the comparison reference, matching the direction of a merge request.
- Set the comparison target at startup with `--base`.
- Keep comparison controls aligned when branch names are long.
- Highlight changed characters within replacement lines in unified and side-by-side diffs.

## 0.1.1

- Compare branch changes from the common ancestor with the target branch, excluding target changes already merged into the current branch.

## 0.1.0

Initial release of Inantis.

- Review repository changes in the browser, including uncommitted work and changes since the branch started.
- Navigate unified and side-by-side diffs, explore files, and adjust the file sidebar.
- Comment on lines, ranges, or the review as a whole; save drafts or send feedback immediately.
- Exchange messages with coding agents and resolve discussions locally.
- Install integrations for Pi, OMP, Claude Code, and Codex.
