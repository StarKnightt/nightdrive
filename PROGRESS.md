# Overnight progress log

One line per iteration: what changed, what was verified, pass/fail.
Newest at the bottom.

Standing rules for the night: every test script imports `./tame.mjs`; runs are
serial, never parallel; the browser is closed at the end of every run; the
60 fps cap and the medium-tier start are not touched; default quality is never
raised. If an iteration makes a previously-passing assertion fail, it is
reverted and the reason recorded here.

## Test scripts

| Script | What it is for |
|---|---|
| `assert-drive.mjs` | **The regression gate.** Permanent hard assertions for all five §0.4 bugs. Exits non-zero on any failure. Headless, ~90 s. |
| `playtest.mjs` | Headed, real GPU, closed-loop driving for two minutes. Catches what headless cannot (driver-side rendering, real frame pacing). |
| `camdiag.mjs` | Camera framing and chassis-shimmer measurement, per rendered frame. |
| `feel.mjs` | Handling characterisation over repeated runs, median-reported. |

`assert-drive.mjs` drives through the game's fixed-step simulator, which sets
`KEYS_DOWN` and calls `readInput()` — the real input path — but skips the
renderer. That is deliberate: driven by real-time key events under SwiftShader,
a full run advanced the simulation 206 steps in 100 seconds, because one frame
of this scene costs seconds on a software rasteriser. The car never moved and
every handling assertion passed trivially. The DOM listener that fills
`KEYS_DOWN` is the one link this skips, so it is asserted separately with real
key events.

---

## Phase 1 — the five bugs from FEEDBACK.md §0.4

### Iteration 1 — per-step invariant hook + regression gate
**Changed** `index.html`: added a `stepHook` seam at the end of `stepPhysics`,
called once per physics step and null in normal play, so assertions can be made
at the rate the claim is actually made. A probe polling from
`requestAnimationFrame` samples roughly every other step at 120 Hz, and a
one-step excursion under the ground is exactly what it would miss.
**Added** `assert-drive.mjs`, 23 permanent assertions.
**Verified** 23/23 pass over 14,683 physics steps. **PASS**

Three of the four failures the gate reported on its first run were flaws in the
gate itself, all found and fixed by looking at traces rather than at the game:
- steering direction was measured over 1.5 s of driving, during which the road's
  own curvature moves the car further sideways than the steering does. Now
  measured as the *difference* against a straight-ahead run over the identical
  stretch of road, so only the key differs. All five cameras now report an
  identical `dn +8.68 m` left / `-8.52 m` right, which is itself the proof that
  no camera convention leaks into input handling.
- the bonnet camera sits slightly ahead of the car's origin, so projecting the
  car to find which way `+n` points put the reference point behind the near
  plane, where `project()` mirrors the result. It read `+n` as screen-right in
  that one mode alone. Reference point moved 25 m up the road, in front of every
  rig.
- self-centring was asserted on road-relative yaw, which demands the car keep
  turning with the bend and so failed it for going straight. Hands off, the car
  should stop rotating in the *world*. Traced: `omega` holds at exactly 0.000
  through the release while the road curves away. Assertion moved to absolute.

Also: the summary printed `PASS` after the suite aborted three assertions in on
a `TypeError`. A suite that did not complete is now a failure regardless.

### Status of the five bugs
| # | Bug | Assertion | State |
|---|---|---|---|
| 1 | MSAA black screen | no-MSAA is the default, `#msaa` opts in | PASS |
| 2 | Falls through the world | 0 sinks in 14,683 steps, incl. 7 tier re-segmentations at 140 km/h | PASS |
| 3 | Steering reversed | identical correct sign in all 5 cameras | PASS |
| 4 | Uncontrollable at speed | tap / flick / brake-in-corner / full-lock all bounded; authority falls with speed | PASS |
| 5 | Blinding sunrise, twitchy spawn | spawns still and grounded; dawn bloom 0.35, exposure 0.91 | PASS |

Carried over from the previous session and re-verified by `playtest.mjs` on the
real GPU: 0 fall-throughs, 0 spins, 0 steering failures, 0 dead frames, 0 page
errors, startup 0.6% blown out.

---

## Phase 2 — polish

### Iteration 2 — sun flare no longer erases the car
**Changed** `index.html`: a soft shoulder on the car's own outgoing radiance,
applied via `tameHighlights()` to the paint, glass, carbon, chrome, trim, rim and
rotor materials only. Below the knee (2.6) nothing changes; above it the excess
compresses asymptotically toward twice the knee, so the highlight stays a bright
highlight but can no longer hand the bloom a value large enough to swallow the
car. The sun, sky, tarmac and headlights bloom exactly as before.

**Why it was needed**: the clearcoat is 0.045 roughness — very nearly a mirror —
so a low sun returned a specular lobe of effectively unbounded intensity and the
bloom smeared it across the whole upper body. Driving into the sun, the roof and
windscreen fused into one white shape with no bodywork in it, which is the shot
the chase camera spends most of its time framing.

**Verified**: `bloomcheck.mjs` drives until the road actually points at the sun
and measures mean luminance, contrast and blown pixels over the car's own screen
box. Bright/flat score 1.75 -> 1.60; blown pixels at dawn 1.5% -> 1.1%; contrast
73.8 -> 78.6 (higher is less flat). Visually the roofline, rear glass and spoiler
survive the glare where before they did not.
`shots/p2-01-sunflare-before.png` / `-after.png`.
Regression gate re-run: 23/23. **PASS**

Note on the measurement rig: two earlier versions of `bloomcheck.mjs` teleported
the car to a stretch of road pointing at the sun. That outruns the world
streamer — the tiles under the new position do not exist yet, `groundYAt` answers
from nothing and the rig ends up inside the tarmac. Both produced photographs of
the underside of the road. It now just drives and waits for the alignment to
happen, which is slower but real.

### Iteration 3 — softer foliage edges against the sky
**Changed** `index.html`: `softCutout()` + the `AA_ALPHA` shader chunk, applied to
`leafMat` (near canopy cards) and `farTreeMat` (distant impostors). `fwidth()` on
the sampled alpha estimates how much of each pixel the leaf actually covers, and
that becomes the output alpha, so the silhouette gets a real gradient instead of
a staircase. Multisampling would normally do this job, but it is off by default
because it black-screens the target machine's ANGLE/D3D11 driver, so coverage
has to be computed in the shader.

Both materials moved to the transparent queue, which is what puts a partial pixel
on screen at all. `depthWrite` stays on: the fringe is one pixel and the interior
is opaque, so the depth buffer resolves the ordering that back-to-front object
sorting cannot do within a single instanced draw.

**Guarded against this technique's usual failure**: at distance, minified foliage
has a steep alpha gradient inside every pixel, `fwidth` goes large, and the
coverage estimate collapses toward 0.5 across the whole canopy — the far treeline
turns to gauze. Anything more than 0.25 above the cutoff is now forced solid
regardless of the derivative. That costs some softening (18.1% -> 15.6%) and is
worth it.

**Verified** with `foliagecheck.mjs`, which walks scanlines through the sky band
and measures how many pixels each sky-to-leaf transition takes:
| | soft edges | mean transition | fps |
|---|---|---|---|
| before | 7.2 % | 1.13 px | 60 |
| after | 15.6 % | 1.27 px | 67 |

No sorting artifacts, no translucent canopies, no cost at the frame cap.
`shots/p2-02-foliage-before.png` / `-after.png`.
Regression gate re-run: 23/23. **PASS**

### Iteration 4 — cockpit camera
**Changed** `index.html`: a sixth camera rig (`COCKPIT`, on the `C` cycle) and the
interior it looks at — headlining, header rail, A-pillars, door tops, rear
bulkhead, floor, transmission tunnel, two seats, a fascia with a centre stack, a
binnacle with a tachometer and a 320 km/h speedometer on canvas-drawn faces, a
flat-bottomed three-spoke steering wheel on a tilted column, and a rear-view
mirror. Needles and rim are driven from `car.rpm`, `car.vLong` and `car.steerVis`
with first-order lag, because a gauge that snaps to its number reads as a
readout rather than an instrument. All of it lives under one group that is
hidden unless the interior camera is selected, so the other five views pay for
none of it.

**Three real bugs came out of building it**, none of them in the new geometry:

1. `mergeStatic()` — the draw-call optimiser — re-parents what it merges onto the
   root it is given, and it is given `carBody`. So the cabin was being lifted out
   of the cockpit group and welded to the bodywork: `cockpit.visible = false` no
   longer reached it, and every exterior camera was framing a car with a
   dashboard hanging in it. Diagnosed by trapping `Object3D.remove` and reading
   the stack trace; the group built 13 children and had 5 three seconds later.
   The cabin is now merged against itself first and then declared off-limits to
   the general sweep, so the saving survives without the reparenting. The two
   needles and the wheel rim are held out of both passes because they move.
2. The same mechanism made `stubDash.visible = false` a no-op — geometry welded
   into a shared batch keeps drawing whatever `visible` says about the object it
   came from. The crude stand-in blocks were showing through the real
   instruments as a second, wrong set of dials. The whole stand-in interior is
   now one group, kept out of the merge and swapped out in one line.
3. The stand-in cabin `tub` has its lid at y = 0.91 — eight centimetres under the
   eye and straight through the middle of the binnacle. It read as a black bar
   slicing both dials in half. It is part of the group from (2) and now goes with
   it; the interior grew a floor and tunnel of its own to replace what it was
   doing.

**Also corrected**: the headlining was originally displaced to follow `bodyTop()`,
which keeps falling past the header — that is the bonnet, not the roof — so the
front of the panel ended up half a metre low, hanging in front of the driver's
face as a black wall across the middle of the frame. It is flat now, and stops at
the header. The eye and the whole cabin were then rebalanced around a measured
body profile (top 1.20 over the seats, falling to 1.07 by z = 0.6): eye 1.048 ->
0.985, ceiling 1.152 -> 1.186, so headroom went from 10 cm to 20 cm and the roof
stopped eating the top 40% of the frame. Dash, binnacle, wheel and mirror all
came down with it. FOV 68 -> 62. Glass tint is nearly clear on its inner face —
the tint that stops the cabin looking like an empty shell from outside is a
blackout blind from the driver's seat.

**Verified**: `cockpitshot.mjs` photographs the seat at three speeds and light
levels and reads back the needle rotations against the car's own state. At
140 km/h / 6492 rpm both needles sit where the printed scales say they should,
the rim tracks `steerVis`, the road and horizon are visible over the dash, and
the dials self-illuminate at night. 66.7 fps in all three, no page errors.
`shots/p2-03-cockpit-cruise.png`, `-fast.png`, `-night.png`.
Regression gate re-run: **25/25** — the steering-direction test enumerates
`CAMS`, so the new rig added its own two assertions and passes them. **PASS**

### Iteration 5 — dust off the rear wheels under power
**Changed** `index.html`: the particle emitter had two sources — sideways slide
(`screech`) and the verge (`offroad`) — and no third for putting the power down.
Standing on the throttle out of a slow corner, or from rest, produced a silent
clean getaway, which a 250 kW rear-drive car cannot do. `car.wheelslip` was
already being computed for the friction circle (the share of drive force the rear
tyres could not put down) and read by nothing; it is now the third source, gated
on throttle so that engine braking and coasting stay clean.

Details that mattered:
- `max(screech, spin)` rather than a sum for those two, because a drift screeches
  *and* spins and adding both doubles the emission for one event — the
  900-particle ring wraps inside a second and starts eating its own tail.
  Off-road dust still adds, being a different surface rather than a harder
  version of the same one.
- Emission points jitter along the contact patch; from a single point a low rate
  reads as a dotted line of identical puffs.
- Three colours: brown for torn-up ground, pale rubber smoke for a spinning tyre
  on tarmac, darker grit for a scrubbing one.
- A spinning wheel throws its plume backwards, on top of the drift it already has
  from being left behind by the car.

**Fixed a long-standing artifact while in there**: the plume is emitted at the
rear axle, five metres from a chase camera it is drifting towards, so motes
routinely ended up close enough that one covered a tenth of the screen — pale,
circular, and reading as dirt on the lens rather than smoke behind the car. The
particle shader now fades on proximity (`smoothstep(1.0, 4.4, viewZ)`) and the
size cap came down 58 -> 42 px. Per-particle alpha 0.62 -> 0.46 as well, so
overlapping motes build a plume instead of each announcing itself as a circle.

**Verified** with `dustcheck.mjs`, which drives the real thing headed and counts
live particles through a new `dustLive` seam:
| phase | peak live | wheelslip | fps |
|---|---|---|---|
| idle, no throttle | 0 | 0.00 | 67 |
| standing-start launch | 87 | 0.21 | 67 |
| steady cruise, 129 km/h | 0 | 0.00 | 67 |
| standing burnout | 304 | 1.00 | 67 |
| handbrake drift | 498 | 1.00 | 67 |

Ordinary driving is exactly clean, the worst case is 498 of a 900 ring, and there
is no measurable frame cost at the cap. `shots/p2-04-dust-launch.png`,
`-burnout.png`, `-drift.png`. Regression gate re-run: 25/25. **PASS**

Note on the rig: two phases initially reported zero because their setup called
`resetCar()`, which puts the car back at s = 0 — after a kilometre and a half of
cruising that makes the streamer rebuild the whole world, the page fell to 1 fps
and both measurement windows landed inside the stall. It brakes to a stop now,
which keeps the car where the terrain already is.

### Iteration 6 — the back of the car
**Changed** `index.html`. This is the view the chase camera frames for most of
the run, and it was one unbroken light bar, one black valance, two round tips and
a plate-less panel. Now:

- **Segmented lamps.** Two blades per side with dark between them, plus a thin
  centre strip. At the distance the chase camera sits, an unbroken strip is four
  pixels tall and reads as a red line drawn on the tail; the same light split up
  still reads as separate objects, which is most of what makes a rear end look
  designed rather than extruded.
- **Corner wraps.** The tail is a flat cap, so without something turning the
  corner the lamps stopped dead at the silhouette edge and the car looked cut off
  from three-quarter angles — which is exactly where the camera is through every
  bend.
- **A second lamp material.** `tailRunMat` for the strip and the wraps, holding a
  steady low glow and taking only a small share of the brake pedal; `tailMat` for
  the blades, which flare. One material for the whole tail means the entire rear
  end flares as one, and that is the thing that makes a cluster read as a single
  glowing decal instead of as lamps.
- **A high-level brake light** under the wing, clear of the bodywork against the
  sky, which is what reads first at distance.
- **Bumper.** A plate recess with a lit plate, reversing lamps either side of it,
  low outboard reflectors, and a step under the cluster to break up what was a
  single flat panel from the lamps to the diffuser.
- **Quad tips** instead of two, each with a near-black bore behind the ring: a
  capped cylinder at this size is a metal peg, and the hole is the entire reason
  a tailpipe reads as a tailpipe. Flames still come from the inner pair only —
  two cones is a cost, four is that cost twice.

**Verified** with `rearshot.mjs` at four states. 67 fps in all of them, 201 draw
calls, no page errors. Under braking `tailMat` reaches 4.65 and the blades flare
while the strip holds; at night the high-level light is clearly a separate object
above the cluster; coasting, the segmentation and the four bores are legible.
`shots/p2-05-rear-coast.png`, `-braking.png`, `-night-braking.png`,
`-threequarter.png`. Regression gate re-run: 25/25. **PASS**

The rig needed two corrections worth recording: the chase rigs aim at a point
`lead` metres up the road, so at the default 14 m the "rear end" shots were
photographs of the road over the roof — `lead` has to come in to about 2 m for
the camera to look down at the car at all. And autopilot rewrites the input
vector every frame, so a held brake key never reached the car and the first
braking shots were taken with the lights off.

### Iteration 7 — weak-device pass
**Added** `weakcheck.mjs`. Real GPU, CPU throttled through the DevTools protocol,
driving on autopilot, sampling tier / render scale / fps / draw calls twice a
second. No change to `index.html` was needed: the tier system already behaves.

At the brief's **6x**, 45 s:
| | |
|---|---|
| opening tier | `low` (never above medium — that is the assertion) |
| settles at | `potato`, render scale 0.52 |
| tier changes | 1 in 45 s (settles, does not oscillate) |
| fps | median 45, worst 33 |
| frames drawn | 1858 in 45 s |
| context loss | none |
| frame content | mean luma 23.9, max 213 — a real frame, not a black one |
9/9 **PASS**. `shots/p2-06-weak-6x.png` is a dusk frame at 156 km/h with
headlights, tail lamps and road all present, drawn at potato tier.

Pushed to **12x** as a robustness check: opens straight at `potato`, holds it with
zero tier changes, ~21 fps median, still rendering, still driving at 157 km/h,
still not black, no context loss. That is the floor of the quality ladder rather
than a fault in it — there is nothing below `potato` to fall to — so the
playability assertion is enforced at the 6x target and merely reported above it.
Deliberately did not add a lower tier: outside the brief, and default quality is
not to be touched.

Worth noting what this run also demonstrates: the fixed-timestep accumulator
holds. At 12x throttle and ~10 fps in the worst samples, the car is still doing
157 km/h with no fall-throughs and no spins — handling is decoupled from frame
rate, which was §0.5 of the feedback.

---

## Both phases complete

| Phase | Item | State |
|---|---|---|
| 1 | no-MSAA default, `#msaa` opts in | PASS |
| 1 | car can never fall through the world | PASS |
| 1 | steering correct in every camera | PASS |
| 1 | planted at speed, no accidental spins | PASS |
| 1 | calm sunrise, settled spawn | PASS |
| 2 | sun flare no longer erases the car | PASS |
| 2 | softer foliage edges against the sky | PASS |
| 2 | cockpit camera, working instruments | PASS |
| 2 | dust off the rear wheels under power | PASS |
| 2 | detailed rear end | PASS |
| 2 | weak-device pass | PASS |

Regression gate `assert-drive.mjs`: 25 assertions, 25 passing, ~15,400 physics
steps per run. `dustcheck.mjs` 6/6, `weakcheck.mjs` 9/9. 60 fps cap and
medium-or-below start untouched throughout.

---

## Re-prioritised — matching @ChrisGPT's "Ridgeline Trail"

New direction: the build is being posted publicly and the bar is "worth a quarter
million impressions". Reference frames in `c:\Code\_ref\f1..f4.jpg`. What that
reference does better, in the order it matters: a **lit** forest interior with
dappled sun on the trail; far **denser** foliage packed right against the lens;
**ground clutter** everywhere (logs, branches, rocks, tufts, ruts); a **closer,
lower** camera; big soft **dust** plumes; a **committed colour grade**.

Strategic note carried into every judgement below: that demo picked a subject
procedural code is good at and a painterly look. Ours picked a photoreal
supercar, which is the hardest case. Where a choice arises, prefer density,
lighting and atmosphere over surface fidelity.

### Iteration 8 — stabilised before switching direction
Killed seven orphaned Playwright Chromium processes left rendering the game tab by
an interrupted `playtest.mjs`, confirmed `index.html` was not mid-edit (the last
change to it predated the previous green gate), and re-ran the gate cold:
**25/25 passing, 15,439 physics steps, exit 0**. Clean base for the new list.
**PASS**
