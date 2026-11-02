# GymCoach — workout PWA

A lightweight, offline-capable workout player (plain HTML/JS, no build step).

**Live:** https://lyubostanev.github.io/workout-app/

## Features
- Default 3-day rotating split: **Push** (chest/upper chest, front & side delts, triceps) → **Pull** (back/lats, rear delts, traps, biceps) → **Legs & Core** (quads, hams, glutes, calves, glute med, abs/obliques); each ~45 min with warm-up, short conditioning finisher and mobility cool-down
- Timed work/rest player with "next up" preview; home card shows the rotation and the next workout
- Light theme (green primary, blue secondary)
- Per-exercise rep ranges (default 12–15; harder bodyweight moves 5–8; holds/carries/planks timed)
- Per-exercise tempo with audible + visual count (toggle in Settings)
- Equipment toggles (TRX, rower) and kettlebell inventory–aware load suggestions
- Swap / avoid exercises, installable PWA with offline cache

## Run locally
Serve the folder with any static server, e.g. `python3 -m http.server`, then open `http://localhost:8000/`.

## Credits & licenses
- Exercise photos: [free-exercise-db](https://github.com/yuhonas/free-exercise-db) by yuhonas,
  released under [The Unlicense](https://github.com/yuhonas/free-exercise-db/blob/main/LICENSE) (public domain).
- Some exercises use generated illustrations created for this app.
- "Watch demo" buttons link to third-party YouTube videos; those videos are not included or cached here.
