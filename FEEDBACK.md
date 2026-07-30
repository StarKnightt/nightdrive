# Review feedback (from Claude, 2026-07-29 evening)

## 0. PERFORMANCE — NOW TOP PRIORITY
The user's whole system is lagging: CPU and GPU pinned at 99%, occasional black screens (WebGL context loss — the handlers added at index.html:4155 are good, but the root cause is GPU overload). Fix the load, not just the recovery:

- `sunLight.shadow.mapSize.set(3072,3072)` (index.html:1930) is very heavy. Default to 1024–2048 and only allow 3072 on a "high" quality preset.
- The post chain runs GodRays + UnrealBloom every frame. Make the auto-quality system (RSCALE / q.shadow, ~index.html:3956) MORE aggressive: if frame time exceeds ~20ms for a couple seconds, drop shadow size, disable god rays first, then bloom.
- Add an explicit FPS cap option (e.g. 60) so the GPU isn't rendering uncapped — uncapped rendering is likely why the whole system lags.
- Verify there's no runaway allocation per frame (new vectors/materials in the render loop) — session lag getting worse over time would indicate this.
- Target: smooth on a mid-range machine at default settings. Visual quality goals below are secondary to this.

Before hosting publicly: verify the low end, not just the fixes. Run the game with Chrome DevTools CPU throttling (6x) and at a small window size to simulate a weak laptop, confirm the tier system actually walks down to "potato" and stays playable (no context loss, >25fps). Also test that the first 5 seconds — before adaptQuality has data — never exceed the medium-tier load on any path (including after resetCar/restart). Weak visitor devices will hit the startup spike hardest.

Specific findings from code review (the adaptive quality system and context-loss recovery are well built — these are the remaining gaps):
- **Start at "medium" tier and step UP, not down.** Currently rIdx=0 / tier "high" / 3072 shadows from frame one, so the first seconds run max load before adaptQuality has any FPS data — likely the exact moment of the user's black screens. Probe upward after ~2s of confirmed headroom instead.
- **Add a frame cap (default 60fps).** The rAF loop runs at monitor refresh; on high-Hz displays that's why the GPU pins at 99% even when smooth. Skip frames to a 60fps budget by default, with an uncapped option.
- **Fixed-timestep physics accumulator.** frameBody uses variable clamped dt for stepPhysics; handling changes subtly with frame rate. Accumulate rawDt and step at fixed 1/120 or 1/60 (the probe harness already uses fixed 1/60, so the sim supports it). This also addresses the car-control complaint in section 0.5.

## 0.4 CONFIRMED BUGS from the user's live playtest (2026-07-29 ~10:30 PM) — fix before anything else
Tested on the RTX 4060 at localhost:8177. Graphics verdict: "nice". Everything else broken:

1. **MSAA black screen**: `#nomsaa` fixes rendering on this machine (ANGLE/D3D11 multisample resolve). Make no-MSAA the DEFAULT and let `#msaa` opt in — never ship a default that black-screens on a mainstream NVIDIA + ANGLE/D3D11 setup.
2. **Car falls through the road/terrain.** Ground collision is not reliable. Likely the car's ground-height sample misses at speed or during the tier-change terrain rebuilds (re-segmentation swaps meshes under the car). Clamp car Y to terrain height every physics step as a hard floor, whatever else happens.
3. **Controls are REVERSED** (user reports steering inverted). Verify left steers left in every camera mode — a chase-cam sign flip must not leak into input mapping.
4. **Any speed = instant loss of control**, car flies off into the forest. Stability must scale with speed: reduce steering authority as speed rises, add self-centering / yaw damping, and re-check the lateral grip numbers. Target feel: at 100+ km/h small inputs make small, smooth lane changes.
5. **Startup sunrise is blinding/washed out** and the car is unstable right at spawn. Tone down the dawn sun intensity/bloom at the starting time of day, and spawn the car settled (zero velocity, wheels on ground, a beat of input lockout while the scene fades in).

Test protocol before calling this fixed: drive interactively (headed browser, not just probes) for 2+ minutes at varying speed — no fall-throughs, no spins from small inputs, steering direction correct, start readable. The probe scripts passing is NOT sufficient; the user just played a build the probes were happy with.

## 0.5 CAR CONTROL / HANDLING — second priority (user request)
The user says car control needs work. After the performance fix (which itself will help a lot — handling always feels broken at low/stuttery FPS), review the driving feel:
- Make physics timestep-independent (fixed timestep or dt-clamped integration) so handling is consistent regardless of frame rate.
- Steering: smooth input ramp-up/return, reduced sensitivity at high speed.
- Grip/drift balance: car should feel planted in normal driving, with drift as a deliberate action, not something that happens accidentally.
- Test at both high and low FPS to confirm control feels the same.


Reviewed the latest screenshots in `shots/` (cam_*.png, p_*.png). Overall state is strong — lighting, road rendering, and HUD are all working well. Remaining polish items, in priority order:

## 1. Tree foliage edges (highest priority)
The leaf clusters have harsh pixelated/dithered edges, most visible against the bright sky in `cam_chase.png` and `cam_cinematic.png`. Soften the alpha cutoff on the foliage texture (or lower the alphaTest threshold), or use slightly larger, softer leaf billboards so the silhouettes read as foliage instead of noise.

## 2. Sun bloom washing out the car
In the chase cam the sun glare sits directly on the car and blows it out (`cam_chase.png`). Reduce bloom intensity, or occlude/attenuate the sun flare when the car is between the camera and the sun, so the car stays readable.

## 3. Car model polish (lower priority)
The car reads a bit boxy up close — exhaust/underside geometry is visibly simple. A little extra geometry or smoothing on the rear would help the close and hood cams.

Everything else (golden hour lighting, guardrails, road texture, HUD typography, the camera/state screenshot suite) is good — keep that approach and keep verifying visually via `shoot.mjs`.

## 4. Cockpit / interior camera (user's reference target)
The user wants the game to feel like ChrisGPT's "Ridgeline Trail" demo (x.com/ChrisGPT/status/2082168850968154352). The biggest missing piece vs that demo is a first-person COCKPIT camera: dashboard with speedometer/tach gauges (needles driven by actual speed/RPM), steering wheel that turns with input, rear-view mirror, simple radio panel. All geometry-only, no textures needed — flat-shaded boxes and cylinders with good lighting sell it. Secondary: denser roadside vegetation (ground clutter, grass tufts near the road edge) — but ONLY after the performance work in section 0, since more vegetation costs GPU.

Also from the reference video: small dust/dirt particles kicked up from the rear wheels when accelerating or drifting (cheap sprite particles, keep the count low), and detailed rear-end geometry on the vehicle (taillights, bumper, tailgate detail) — ties into section 3.
