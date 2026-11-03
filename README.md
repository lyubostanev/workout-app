# GymCoach — workout PWA

A lightweight, offline-capable workout player (plain HTML/JS, no build step).

**Live:** https://lyubostanev.github.io/workout-app/

## Features
- Default 3-day rotating split: **Push** (chest/upper chest, front & side delts, triceps) → **Pull** (back/lats, rear delts, traps, biceps) → **Legs & Core** (quads, hams, glutes, calves, glute med, abs/obliques); each ~45 min with warm-up, short conditioning finisher and mobility cool-down
- Timed work/rest player with "next up" preview; home card shows the rotation and the next workout
- Light theme (white + light blue, darker-blue accents)
- Per-exercise rep ranges (default 12–15; harder bodyweight moves 5–8; holds/carries/planks timed)
- Per-exercise rep ranges; lift at your own pace (no tempo counting)
- Equipment toggles (TRX, rower) and kettlebell inventory–aware load suggestions
- Swap / avoid exercises, installable PWA with offline cache

## Run locally
Serve the folder with any static server, e.g. `python3 -m http.server`, then open `http://localhost:8000/`.

## Credits & licenses
- Exercise photos: [free-exercise-db](https://github.com/yuhonas/free-exercise-db) by yuhonas,
  released under [The Unlicense](https://github.com/yuhonas/free-exercise-db/blob/main/LICENSE) (public domain).
- Some exercises use generated illustrations created for this app.
- "Watch demo" buttons link to third-party YouTube videos; those videos are not included or cached here.

### New
- Each exercise screen shows its **History**: the last 3 sessions with dates and weight × reps per set.
- Keeps the iPhone screen awake during a workout (Wake Lock API, with a muted inline-video fallback). Toggle: Settings › Keep screen awake (default on).
- Tempo removed completely (no counter, beeps, tile or setting).
- Tap any exercise on the Today overview for a big preview (start/end images, sets × reps, set time, rest, equipment, form cues, last few sessions, backup swap)
- Supersets: A → 10 s switch → B, then full rest after the round (default 60 s). Between groups: rest + set-up time (default +30 s) with the next group's exercises and equipment on screen. All three are in Settings. Spoken + beeped with next-exercise preview.
- Per-set logging of weight and reps on the rest screen, plus a big **Save & next exercise** button that stores the set and jumps straight to the next exercise. The rest keeps running while you enter numbers.
- iPhone sound fix (audio unlocked on Start, audio-file fallback) and Settings › Test sound. If silent, turn off silent mode.
