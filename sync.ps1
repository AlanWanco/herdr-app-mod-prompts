# Copy the live mod (the one Herdr runs, which hot-reloads) into this repo, then commit.
# Herdr's watcher does not follow directory junctions, so the repo is a copy, not a link.
$src = Join-Path $HOME '.config\herdr-app\mods\prompts'
$dst = Join-Path $PSScriptRoot 'mods\prompts'
Copy-Item (Join-Path $src 'main.js'), (Join-Path $src 'mod.json') -Destination $dst -Force
git -C $PSScriptRoot status --short
