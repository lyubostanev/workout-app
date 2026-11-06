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
- **v16:** realistic session length (10 s setup + 5 s/rep per set, ×2 each-side, + ~15 s logging/transition per set, self-calibrating from recorded sessions); day-specific joint-friendly warm-ups with dynamic stretches; choose today's day from the ones left in the cycle (or any day via "Other day…")

## Run locally
Serve the folder with any static server, e.g. `python3 -m http.server`, then open `http://localhost:8000/`.

## Credits & licenses
- Exercise photos: [free-exercise-db](https://github.com/yuhonas/free-exercise-db) by yuhonas,
  released under [The Unlicense](https://github.com/yuhonas/free-exercise-db/blob/main/LICENSE) (public domain).
- Some exercises use generated illustrations created for this app.
- "Watch demo" buttons link to third-party YouTube videos; those videos are not included or cached here.

### New
- **Block preview** before each group: both exercises with start/end images, target sets × reps, last session's weight × reps per set and today's suggestion. Tap a card for the full preview.
- **Done ✓** on the work screen: finished early? Tap it to end the set and log weight/reps right away (⏭ skips without logging).
- Each exercise screen shows its **History**: the last 3 sessions with dates and weight × reps per set.
- Keeps the iPhone screen awake during a workout (Wake Lock API, with a muted inline-video fallback). Toggle: Settings › Keep screen awake (default on).
- Tempo removed completely (no counter, beeps, tile or setting).
- Tap any exercise on the Today overview for a big preview (start/end images, sets × reps, set time, rest, equipment, form cues, last few sessions, backup swap)
- Supersets: A → 10 s switch → B, then full rest after the round (default 60 s). Between groups: rest + set-up time (default +30 s) with the next group's exercises and equipment on screen. All three are in Settings. Spoken + beeped with next-exercise preview.
- Per-set logging of weight and reps on the rest screen, plus a big **Save & next exercise** button that stores the set and jumps straight to the next exercise. The rest keeps running while you enter numbers.
- iPhone sound fix (audio unlocked on Start, audio-file fallback) and Settings › Test sound. If silent, turn off silent mode.

### v15 timing + speech
- The workout length shown everywhere is the exact sum of all steps, and generated sessions fit 30/45/60 min within -3/+1 min.
- Spoken prompts are queued (no more cut-off words on iPhone); beeps wait until speech ends.

## v26
- Ending a workout before the last step asks **Save** or **Discard**. Save keeps the sets and weights already logged, writes a partial history row, and marks that day done for the cycle. Discard throws the session away (a test run): no history row, and the weights logged during it are removed, so the day stays up next. Finishing the whole workout still opens the same “Save session” screen.
- SW cache gymcoach-v26.

## v25
- Speech is one chain started inside the Start tap. Later names and form cues are spoken from the previous line's end, not from the workout timer (iOS ignores those). A paused hold keeps that chain alive between lines. resume() is never called in the same turn as speak() — that dropped the utterance and is why v24 still only said the first name. The silence loop, beep files, and wake video stay off while voice is on, because an `<audio>`/`<video>` element pauses speech for the rest of the session. Beeps play after the words.
- Main blocks reshuffle each new session of that day. The old draw was smaller than the "best muscle + heavier exercise" bonus, and it barely noticed the previous Push once Pull and Legs had been logged, so Block B came back the same. Repeats lose to another exercise that fits the slot, and the block order rotates. Pairing rules are unchanged. Warm-up and cool-down stay the fixed prep lists.
- SW cache gymcoach-v25.

## v24
- Narration was only the first exercise name. iOS leaves `speechSynthesis.paused` true after that line; later `speak()` calls queued and never started, and nothing called `resume()` afterwards. Each line is now spoken first and then `resume()` releases it, including the second and third exercises.
- Form cues were marked low priority and discarded while the name was still talking, and the app remembered them as already said. They are queued behind the name and spoken in full. Beeps wait until the words finish instead of cutting them off.
- SW cache gymcoach-v24.

## v23
- The block preview (the screen before each pair) has **⇄ Swap** on each exercise. Tap opens the same chooser used mid-workout; hold still avoids it.
- That chooser lists the usual backups plus one more exercise that fits the slot (same role, no station clash, no second max-effort finisher).
- SW cache gymcoach-v23.

## v22
- Between every block, including after the warm-up: 60 s rest then at least 30 s setup, and never under 90 s total. The warm-up used to hand off after only the 30 s setup.
- Rest after a round inside a block is 60 s. A heavier exercise’s own rest (75 s) or a 30 s library override no longer changes that minute.
- Every left/right move gets the halfway beep and “Switch sides”, including ones whose cue only says “then switch”. The beep plays at the midpoint even if a form cue is still speaking (that hold used to drop it).
- A finisher cannot pair two max-effort moves (burpee + thruster, and the other full-body / sprint / jump finishers). One of those goes with a lighter conditioner (quick steps or renegade row).
- Finishing a workout marks that split day done immediately, so the home picker moves to the days still left in the cycle. “Legs” counts as Legs & Core. After all three days, the cycle starts over.
- SW cache gymcoach-v22.

## v21
- Missed the first exercise during the 10 s switch? **Log previous** (on the second exercise, and on the rest after it) opens that set’s weight and reps. Saving stays on the current screen; the round timer does not rewind.
- SW cache gymcoach-v21.

## v20
- Kettlebell logging is no longer capped at the bells listed in Settings (25 and 35). The + button walks a normal bell ladder through 50 lb and on, with no ceiling, so a 50 lb suitcase carry (and heavier dumbbell or kettlebell work) can be saved. A weight he actually logged is not snapped back down to 35.
- Supersets skip any pair that shares a station but needs a different setup: Smith stops, cable pulley height or attachment, bench angle, BOSU side, TRX strap length, step height. Same setup (flat bench press + flat fly, low-pulley D-handle raises, squat + split squat) can still share a block.
- SW cache gymcoach-v20.

## v19
- Spoken cues play again on iPhone. iOS leaves `speechSynthesis.paused` true on an empty queue, and v18 waited for that flag to clear (calling `resume()`, which does not clear it) before `speak()` — so warm-up lines, set names, and rest/switch prompts were queued and never spoken. The queue now speaks directly and keeps each utterance referenced until it finishes, so the line is not dropped while iOS is still starting.
- Left/right exercises (unilateral, including “alternate legs”, single-leg RDL, hip abduction, lunges, step-ups) get a full rep interval per side, with a “Switch sides” cue at halfway.
- Rest after both exercises of a pair is 60 seconds for every category. Core and conditioning used to take half (30 s) whenever the pair ended on them.
- Between groups: that 60 s rest, then a distinct 30 s set-up window (spoken and labeled) for the next block.
- Supersets no longer pair two Smith moves that need different bar or bench settings (Romanian deadlift + calf raise). Same setup (squat + split squat) can still share a block.
- SW cache gymcoach-v19.

## v18
- Clipped first syllables: a near-silent continuous WebAudio tone (gain 0.0005, 30 Hz) keeps the iOS audio route warm for the whole workout (started once, never restarted mid-speech, stopped with keep-alive). Every utterance is prefixed with a short lead-in (", "), and after speechSynthesis.resume() we wait 200 ms before speak (SPEECH_LEAD / WARM in app.js). v17 queue rules unchanged.
- After the last exercise of a block, the weight/reps log renders ABOVE the next-block preview and is visible without scrolling.
- "✓ Save" only saves the set: the rest/switch timer keeps running (resumes if logging paused it), the form collapses to a "✓ Saved … edit" line, and rest + next exercise stay visible. Only ⏭ Skip cuts rest short.
- SW cache gymcoach-v18.
