<!--
  SOURCE TEMPLATE — this file is the README for the PUBLIC capture tenant
  directory in the station-dashboard pages repo. It is shipped as README.md by
  scripts/deploy-capture.sh. Edit it HERE (in the private source repo), never
  in the public mirror. Keep it DATA-FREE: no real repo owner/name/branch and
  no token — those are runtime-only (see below), and naming them here would
  leak where the private data lives (ADR-0005 hosting amendment).
-->

# Capture

A static, browser-only tool for jotting freeform floor observations — and
"check tomorrow" **Follow-ups** — from a phone or desk browser at Station 849.

This directory is a **generated, data-free mirror** of the tool, published so
the page is installable and reachable on a phone mid-sort. It contains no
capture content, no credentials, and nothing about where any private data
lives.

> **Do not hand-edit this directory.** It is regenerated and pushed by
> `scripts/deploy-capture.sh` from the private source repository. Any change
> made directly here is overwritten on the next deploy.

## What it does

- One text box, a Save button, and an optional **Check tomorrow** toggle.
- Every capture is timestamped automatically — nothing to classify, nothing
  to decide while mid-sort.
- A capture flagged "check tomorrow" becomes a **Follow-up**: from the next
  local day onward it's pinned at the top until resolved with a one-line
  outcome. Unresolved for 14+ days, it's marked **stale** rather than dropped.
- With cross-device sync configured, captures merge across devices (union,
  tombstone-aware deletes) through a single JSON file in **your own private
  repository** — never in this public build.

Everything runs in the browser. With no sync configured, all state lives only
in that browser's local storage.

## Optional: cross-device sync

1. Open the page on each device.
2. **&#9881; Settings.**
3. Enter a **GitHub fine-grained personal access token** scoped to
   **Contents: Read and write** on the private repo that holds the data, plus
   the repo **owner**, **name**, and the dedicated **data branch**.
4. **Save.**

Notes:
- The token lives only in your browser's local storage and travels only in
  the request authorization header — it is **never** written into the synced
  file or into this code.
- Sync is **opt-in**: with no token + coordinates entered, the tool is purely
  local and contacts nothing.
- Capture content (what you write) is never written into this public build —
  it exists only in your browser and on your private data branch.

## Updating this site (maintainers)

From the private source repo, run the deploy script against a local clone of
the public pages repo and push:

```bash
scripts/deploy-capture.sh <path-to-pages-repo-clone> "deploy: <what changed>"
```

The script ships the data-free build into this directory (the tool as
`index.html` plus its `lib/` modules) and refuses to deploy if a real token,
name, email, phone number, or the private repo owner is detected in the
output. GitHub Pages republishes on push.

## Security / privacy

- Keep the page reachable but treat the **token** as a standing secret in
  whatever browser you enter it; scope it to the single private repo,
  Contents only.
- The private repo stays private; only this data-free static build is public.
- Capture DATA never ships here — it lives in localStorage and syncs only to
  the private repo's dedicated data branch.
