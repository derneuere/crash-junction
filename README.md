# CRASH JUNCTION

A Burnout-style crash mode: launch your car into a junction, wreck as much
traffic as possible, steer the wreck with aftertouch, detonate the
Crashbreaker. React + TypeScript + three.js + cannon-es.

## Run it

Needs Node 18+ (use `fnm use 22` if the system Node is older).

```
npm install
npm run dev      # vite dev server
npm run build    # typecheck + production build into dist/
```

## Controls

| Input | Action |
| --- | --- |
| Click / Space | Launch |
| ↑ / W | Accelerate |
| ← → / A D | Steer |
| Space / Shift | **Boost** (meter refills from drifting and airtime) |
| ↓ / S | Brake — **tap while steering to drift**; the slide holds while you steer |
| Arrow keys (after crashing) | Aftertouch — steer the wreck mid-flight |
| **E** | **Crashbreaker** — detonate your wreck (1 charge) |
| B | Sandbox test explosion near the junction center |
| R | Restart |

Driving is grounded in Burnout Paradise's AttribSys vehicle-handling data
(steering lock curves, drift slip/countersteer behavior, boost
acceleration + kick — see `game/control.ts` for the attribute-by-attribute
mapping). Detachable panels (doors/bonnet/boot/bumpers, two-stage
loose-then-detach) mirror the DeformationSpec IK-part + joint model — see
`game/panels.ts`.

## Architecture

React renders the HUD only. The engine is plain TypeScript that owns the
canvas, the physics world and the game loop; the two sides talk through one
typed event emitter (`game/emitter.ts`), so neither imports the other's
internals.

```
src/
  main.tsx, App.tsx        React shell: mounts Game, subscribes to events
  ui/Hud.tsx               presentational HUD (damage, flash, report, cash floats)
  styles.css
  game/
    Game.ts                orchestrator: state machine, loop, collisions,
                           scoring, fuses, explosions (physics side)
    constants.ts           global tunables (speeds, slow-mo, explosion kick…)
    types.ts               shared types: Actor, LevelDef, PanelState, events
    emitter.ts             typed pub/sub bridge to React
    physics.ts             cannon-es world + materials
    suspension.ts          4-ray spring/damper model + downforce + wreck grip
    control.ts             player driving: steering, tap-to-drift, boost
                           (grounded in BP AttribSys handling attributes)
    traffic.ts             traffic AI: lane-keeping, junction yield, looping
                           streams; never wrecks itself — only you do
    vehicles.ts            SPECS (sedan/bus/tanker), vehicle assembly, crumple
                           deformation, wheel popping, charring
    panels.ts              detachable doors/bonnet/boot/bumpers (grounded in
                           BP DeformationSpec joints + thresholds)
    geometry/              hull/panel/wheel geometry builders + materials
    pickups.ts             floating score-multiplier rings
    environment.ts         roads, markings, buildings, ramps, height sampler
    camera.ts              idle orbit / chase cam / crash orbit + shake
    audio.ts               synthesized thumps, booms and pickup chimes
    effects/               pooled VFX: sparks, smoke, debris, scorch,
                           explosion (fireball/shockwave/light), index.ts
    levels/                data-driven levels + the LEVELS registry:
                           level1 (crash junction), driftTrack (practice pad)
```

Two levels ship, selectable on the idle screen:

- **CRASH JUNCTION** — the crash-mode event: ramps, traffic, the tanker,
  medals.
- **PROVING GROUND** — open practice pad for testing driving and drifting:
  a painted skidpad circle with multiplier rings to chase mid-drift, a
  pole slalom, a two-ramp jump line and a barrel corner. `practice: true`
  means you can never wreck — blasts and crashes scuff the car and rip
  panels, but you keep driving (tipped cars right themselves after a
  beat). R resets.

Adding a level = adding a `LevelDef` (no engine changes): traffic spawns
with direction/speed/`delay`, barrel and pole positions, ramps, buildings,
medal thresholds.

## Explosions

`Game.explode(position, power)` is the one entry point (power ≈ 1 barrel,
1.9 Crashbreaker, 2.4 tanker). It spawns the visuals (`effects/explosion.ts`:
white-hot core flash → rolling fireball that cools white→orange→deep red →
ground shockwave ring → dust donut → black smoke column → point-light flash),
plays the boom, then applies a radial impulse with upward bias to every body
in range — cars crumple, wheels pop, poles fly. Barrels in the radius get a
distance-staggered fuse, so clusters ripple instead of popping at once.

In-game triggers:
- red barrels detonate on hard impact or nearby blasts
- the fuel tanker cooks off after enough accumulated damage (or one huge hit)
- **E** fires the player's Crashbreaker once crashed

## Level 1 vs the old prototype

- ~120 m driveable approach: steer, drift, boost, pick your line
- two launch ramps: the main line into the T-bone and a stunt line over the
  corner barrels
- ×2/×3 multiplier rings floating over the ramp lines — collect mid-air,
  they scale all damage cash
- traffic is a living system: cars cruise, yield at the junction and loop
  back through the fog — and they never crash on their own; only you (and
  the chaos you cause) wreck them
- fuel tanker jackpot, city bus, explosive barrel clusters
- medal targets (bronze/silver/gold) on the wreckage report
- one queued car downrange catches overshooting players
