import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  AFTERTOUCH_F,
  BOOST_MAX_SEGMENTS,
  CRASHBREAKER_POWER,
  EXPLOSION_KICK,
  EXPLOSION_MASS_REF,
  EXPLOSION_RADIUS_BASE,
  EXPLOSION_RADIUS_PER_POWER,
  FIXED_DT,
  LIVE_CAR_CONTACT_VY,
  LIVE_VY_GAIN_PER_STEP,
  RAMP_LAUNCH_VY_MAX,
  SLOWMO,
  SLOWMO_HOLD,
  SUSP_MAX_COMP,
  TAKEDOWN_WALL_GRACE,
} from './constants';
import { GameState, type Actor, type CollideEvent, type LevelDef } from './types';
import type { GameEvents, ReportData } from './events';
import { contactPointOf } from './collision';
import { Emitter } from './emitter';
import { rollSeed, seedSim, simRand } from './rng';
import {
  CHECKSUM_EVERY, Recorder, bodySnap, downloadReplay, keysFromMask, maskFromKeys, worldHash,
  type Command, type Divergence, type ReplayFile, type ReplayResult, type ReplayStats, type Snapshot,
} from './replay';
import { LEVELS, type LevelId } from './levels';
import { createMode, type GameMode, type ModeHost } from './modes/mode';
import { GROUP_DECOR, createPhysics, type PhysicsContext } from './physics';
import { buildEnvironment, makeHeightSampler } from './environment';
import { setSeaCamera, type Sea } from './sea';
import type { GrassField } from './grass';
import { loadLevelProps } from './props';
import { BRAKE_INTENSITY, HEADLIGHT_INTENSITY, charActor, createBarrel, createPole, createVehicle, deformActor, popWheel, repairVehicle, shatterGlass, type LoosePart } from './vehicles';
import { applyCarEnvScale, applyGlassParams, glassParams, setCarEnvMap, setPlayerEnvMap, type GlassParams } from './geometry';
import { applyTimeOfDay, type TimeOfDay } from './daynight';
import { SKY_PRESETS, SkyRig, SunFlare } from './skyenv';
import { PlayerReflections } from './reflections';
import { Postfx } from './postfx';
import { makeGlowTexture } from './textures';
import { Perf, type PerfReport } from './perf';
import { resetModelPicker } from './models';
import { accumulatePanelDamage, makePanelBody, updatePanelFlap } from './panels';
import type { PanelState } from './types';
import { applySuspension, type HeightSampler } from './suspension';
import { PlayerControl, type ControlInput } from './control';
import { Pickups } from './pickups';
import { Effects } from './effects';
import { GameAudio, type AudioFrameState, type EngineFlavor } from './audio';
import { CameraDirector } from './camera';
import { classifyTakedown, TakedownTracker } from './takedowns';
import { GamepadInput, type GamepadIntent } from './gamepad';

interface DeformJob {
  actor: Actor;
  p: THREE.Vector3;
  strength: number;
  /** World direction the hitting matter travels — folds the crumple zone
   *  along the hit (BP-style); null falls back to core-inward shrink. */
  dir: THREE.Vector3 | null;
}

const _impact = new THREE.Vector3();
const _panelPos = new THREE.Vector3();
const _sagLp = new THREE.Vector3();
const _lean = new THREE.Euler();
const _leanQ = new THREE.Quaternion();
const _skidL = new THREE.Vector3();
const _skidR = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wFwd = new THREE.Vector3();
const _hood = new THREE.Vector3();
const _pp = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _atF = new CANNON.Vec3();
const _ctrlInput: ControlInput = { steer: 0, throttle: false, boost: false, brake: false }; // reused per fixed step
const _contactIds = new Set<number>(); // bodies with solver contacts this step
const NO_CMDS: Command[] = []; // shared empty — never mutated
const _shadowOrigin = new THREE.Vector3();
const _shadowRight = new THREE.Vector3();
const _shadowUp = new THREE.Vector3();
const _shadowTarget = new THREE.Vector3();

/** The reflection world the cars see: a bright sky ceiling with one hot
 *  sun strip, sky-blue upper walls over a dark lower band (the horizon
 *  line that makes paint read as deep), and a near-black floor. Structured,
 *  high-contrast shapes — the streaks that sweep across smooth bodywork,
 *  Burnout-3 style. Captured once by PMREM, then discarded. */
function makeCarEnvScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070a10);
  const card = (w: number, h: number, color: number, mult: number, x: number, y: number, z: number, rx: number, ry: number) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(mult), side: THREE.DoubleSide }),
    );
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    scene.add(m);
  };
  card(40, 40, 0xeaf2ff, 1.7, 0, 9, 0, Math.PI / 2, 0); // sky ceiling
  // a rank of showroom striplights — curved panels always catch one
  for (const z of [-6, 0, 6]) card(20, 1.5, 0xffffff, 6, 0, 8.6, z, Math.PI / 2, 0);
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const x = Math.sin(a) * 14;
    const z = Math.cos(a) * 14;
    // the sky band starts AT the horizon — vertical body sides must catch
    // it, with the dark ground right below (the beltline horizon split)
    card(30, 6.5, 0x9fb8dd, 1.3, x, 3.2, z, 0, a);
    card(30, 3, 0x0a0d12, 1, x, -1.6, z, 0, a);
  }
  card(60, 60, 0x04050a, 1, 0, -2.4, 0, -Math.PI / 2, 0); // floor
  return scene;
}

/** The night reflection world: near-black, with the lights the player
 *  actually sees downtown — streetlamp glints and warm lit-window grids
 *  around the horizon, a pale moon overhead. These are the shapes that
 *  glide across the paint at night. */
function makeNightEnvScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04060c);
  const card = (w: number, h: number, color: number, mult: number, x: number, y: number, z: number, rx: number, ry: number) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(mult), side: THREE.DoubleSide }),
    );
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    scene.add(m);
  };
  card(40, 40, 0x141d31, 1, 0, 9, 0, Math.PI / 2, 0); // faint navy sky
  card(3.4, 3.4, 0xdfe9ff, 4.5, 6, 8.5, -4, Math.PI / 2, 0); // the moon
  // dim moonlit horizon band so the beltline split survives the dark
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    card(30, 5, 0x121a2c, 1.2, Math.sin(a) * 14, 2.4, Math.cos(a) * 14, 0, a);
  }
  // lit building windows + streetlamp heads scattered around the skyline
  const spots: [number, number, number, number, number, number][] = [
    // [azimuth, height, w, h, color, mult]
    [0.4, 2.6, 1.4, 2.6, 0xffc97a, 3.2],
    [1.1, 3.4, 1.1, 2.0, 0xffd9a0, 2.6],
    [1.9, 2.2, 1.6, 2.8, 0xffc06a, 3.0],
    [2.6, 3.8, 1.0, 1.6, 0xfff0c8, 2.4],
    [3.4, 2.8, 1.5, 2.4, 0xffce85, 3.4],
    [4.2, 3.2, 1.2, 2.0, 0xffd9a0, 2.8],
    [5.0, 2.4, 1.5, 2.6, 0xffc97a, 3.0],
    [5.7, 3.6, 1.0, 1.8, 0xfff0c8, 2.5],
    // streetlamps: small, hot, lower
    [0.9, 1.6, 0.6, 0.6, 0xffd9a0, 7],
    [2.2, 1.4, 0.6, 0.6, 0xffe7bf, 7],
    [3.8, 1.5, 0.6, 0.6, 0xffd9a0, 7],
    [5.4, 1.6, 0.6, 0.6, 0xffe7bf, 7],
  ];
  for (const [a, y, w, h, color, mult] of spots) {
    card(w, h, color, mult, Math.sin(a) * 13, y, Math.cos(a) * 13, 0, a);
  }
  card(60, 60, 0x02030a, 1, 0, -2.4, 0, -Math.PI / 2, 0); // floor
  return scene;
}

/** A camera-facing glow disk pinned in the sky (fog must not eat it). */
function makeSkySprite(tex: THREE.Texture, scale: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: false, transparent: true, depthWrite: false }));
  s.scale.set(scale, scale, 1);
  return s;
}

/** Render path selector. The game ALWAYS renders in 'cine' (the film-look
 *  chain in postfx.ts + live player reflections in reflections.ts): the
 *  player-facing FAST/CINE tier choice was removed. 'fast' survives ONLY as
 *  the headless/determinism path — ?verify=1 replays and tools/refshot.mjs
 *  --gfx fast review captures force it so swiftshader doesn't pay for cine
 *  pixels nobody hashes. setGfx() is the seam that drives it (refshot calls
 *  it through window.__game); real play never reaches 'fast'. Pure visuals
 *  either way. */
export type GfxMode = 'cine' | 'fast';

/** Scene-light grading per time of day. The sun's direction feeds the
 *  follow-the-player shadow rig; the sky dome / IBL handles the rest. */
interface TodPreset {
  fog: number;
  hemiSky: number;
  hemiGround: number;
  hemiInt: number;
  sunColor: number;
  sunInt: number;
  /** scene.environment strength — the IBL share of ambient light */
  envInt: number;
}

const TOD_PRESETS: Record<TimeOfDay, TodPreset> = {
  // hemisphere runs lower than the pre-IBL 1.45 — the sky environment now
  // carries a share of the ambient
  day: { fog: 0xb6cde6, hemiSky: 0xbfd6ff, hemiGround: 0x4a4036, hemiInt: 0.85, sunColor: 0xfff0dd, sunInt: 2.2, envInt: 0.6 },
  dusk: { fog: 0xcfa98c, hemiSky: 0x8fa0c8, hemiGround: 0x4a4036, hemiInt: 0.55, sunColor: 0xffc88a, sunInt: 3.0, envInt: 0.65 },
  night: { fog: 0x0a0f1d, hemiSky: 0x33415c, hemiGround: 0x12141c, hemiInt: 0.55, sunColor: 0x9db6e8, sunInt: 0.55, envInt: 0.5 },
};

// PERF (perf-harbor): refresh the live player cube reflection every Nth
// rendered frame instead of every frame. 2 = 30 Hz on a 60 Hz display, which
// reads identically on the streaky clearcoat while roughly halving the
// reflection's whole-scene re-render cost — the dockyard's dominant frame cost.
const CUBE_EVERY_DEFAULT = 2;

export class Game {
  readonly events = new Emitter<GameEvents>();

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  private sunSprite!: THREE.Sprite;
  private moonSprite!: THREE.Sprite;
  private timeOfDay: TimeOfDay = 'day';
  private envTex: { day?: THREE.Texture; dusk?: THREE.Texture; night?: THREE.Texture } = {};
  private skyRig = new SkyRig();
  private reflections = new PlayerReflections();
  private postfx!: Postfx;
  private sunFlare = new SunFlare();
  private flareFrom = new CANNON.Vec3();
  private flareTo = new CANNON.Vec3();
  // The game always renders in CINE; 'fast' is only the headless/review path.
  // forceFast is the single gate cineActive() reads: ?verify=1 replays force it
  // on at boot (swiftshader never pays for cine pixels nobody hashes), and
  // tools/refshot.mjs flips it through setGfx() for its --gfx fast review
  // captures. Real play leaves it false — there is no player-facing tier.
  private forceFast = new URLSearchParams(location.search).get('verify') === '1';
  // never drawn into — exists so the warmup compile sees the render-target
  // program key (linear output, no tone mapping)
  private warmupRT = new THREE.WebGLRenderTarget(1, 1);
  private sunDirUnit = new THREE.Vector3(); // toward the sun/moon, unit
  private camera: THREE.PerspectiveCamera;
  private phys: PhysicsContext;
  private fx: Effects;
  private perf: Perf;
  private audio = new GameAudio();
  private director = new CameraDirector();
  private heightAt: HeightSampler;
  // the animated sea (coast levels); its waves run off RENDER time, never sim
  private sea: Sea | null = null;
  // the instanced blade grass (coast levels); wind runs off RENDER time too
  private grass: GrassField | null = null;

  private actors: Actor[] = [];
  private byBody = new Map<number, Actor>();
  private looseParts: LoosePart[] = [];
  private player: Actor | null = null;

  private state = GameState.Idle;
  private timeScale = 1;
  private slowTimer = 0;
  private crashElapsed = 0;
  private settleTimer = 0;
  private simTime = 0;
  private clock = 0; // take-local wall time (sum of recorded dts) — feeds the camera
  // RENDER-time accumulator for cloud drift — purely presentation, summed from
  // af.dt (real frame time), NOT recorded sim dts, so it never enters the
  // deterministic domain (replay/pins). Same pin-safe contract as sea/grass.
  private skyClock = 0;
  private accumulator = 0;
  private mode!: GameMode; // composed per level in buildActors()
  private pickups: Pickups;
  private control = new PlayerControl();
  private lastEmittedBoost = -1;
  private audioFrame!: AudioFrameState; // persistent — refilled every rendered frame

  private aftertouchActive = false;
  private lastGlance = -9; // simTime of the last wall-glance reroute
  private takedownCamT = 0; // seconds left on the takedown camera beat
  private takedownVictim: Actor | null = null;
  // B3-style takedown banner: classifier + revenge ledger + a monotonic key so
  // the HUD can stack/replace banners. PRESENTATION-ONLY — fed from sim reads
  // at the takedown, never read back by the sim (pin-safe). See takedowns.ts.
  private takedowns = new TakedownTracker();
  private takedownBannerKey = 0;
  private deformQueue: DeformJob[] = [];
  private pairCooldown = new Map<string, number>();
  private checked = new Map<number, number>(); // bodyId → simTime of the shunt
  // near-miss boost credit (B3/BP "Driving Skills"): bodyId → simTime a close
  // pass was last credited, so one fly-by earns once, not every step
  private nearMissAt = new Map<number, number>();
  private playerWallGraceUntil = 0; // takedown wall-grace (TAKEDOWN_WALL_GRACE)
  private keys: Record<string, boolean> = {}; // live key state (events land here any time)
  // The key state the SIM reads — frozen at frame start to exactly the mask
  // the recorder writes, so record == replay by construction. Without the
  // freeze, a key dispatched mid-advance (record scripts drive input from
  // onStep) steers the live take a substep before the tape says it did.
  private simKeys: Record<string, boolean> = {};
  // CONTROLLER (gamepad.ts): polled each LIVE frame; its synthetic held-key
  // flags are OR'd into the keyboard mask at the recorder sample point, so pad
  // input rides the existing recorded key path and is replay-deterministic. No
  // pad connected => poll() writes nothing => keyboard path (and both pins)
  // byte-exact. Never polled during a replay (the tape drives input).
  private gamepad = new GamepadInput();
  private detachGamepad: (() => void) | null = null;

  // bug-report capture: the tape is always rolling (see replay.ts)
  private levelId: LevelId;
  private recorder = new Recorder();
  private stepIndex = 0; // fixed steps since the take began
  private pendingCmds: Command[] = []; // keydown actions, executed at frame start
  private replay: {
    file: ReplayFile;
    frame: number;
    cmdIdx: number;
    sumIdx: number;
    hiddenSet: Set<number>;
    fast: boolean; // fast-forward (?verify=1): many recorded frames per tick
    checked: number;
    diverged: Divergence | null;
    lastTakedownAt: number; // simTime, for the takedown→player-crash stat
    stats: ReplayStats;
  } | null = null;

  /** Dev/diagnosis seam: called after every fixed physics step (live and
   *  replay) — install from the console to trace per-step sim state. */
  onStep: ((game: Game) => void) | null = null;

  // canonical take-start camera pose: the camera feeds back into the sim
  // (aftertouch is camera-relative), so every take must begin from the same
  // pose or a replayed take sees different forces than the recorded one
  private cam0 = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private vyBefore: number[] = []; // pre-step vy per actor (live vy-gain cap)

  private raf = 0;
  private rafIsTimeout = false;
  private last = performance.now();
  private disposed = false;
  private resizeObserver: ResizeObserver;
  // PERF (perf-harbor): render-frame counter + interval for throttling the
  // live player cube reflection. RENDER-only (presentation), never read by the
  // sim — both live in the pixels-only tail of frame(), so they can't touch a
  // pin. cubeEvery is a debug-tunable (setCubeEvery) for profiling A/Bs; ships
  // at CUBE_EVERY_DEFAULT.
  private renderFrame = 0;
  private cubeEvery = CUBE_EVERY_DEFAULT;

  constructor(
    private container: HTMLElement,
    private level: LevelDef,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.perf = new Perf(this.renderer, this.scene, () => ({
      tod: this.timeOfDay,
      gfx: this.cineActive() ? 'cine' : 'fast',
      cine: this.cineActive(),
      level: this.levelId,
      state: GameState[this.state],
      actors: this.actors.length,
      replaying: !!this.replay,
    }));

    // Burnout-3 gloss: every car material reflects a PMREM capture of a
    // purpose-built world — a bright showroom by day, lamp glints and lit
    // windows by night. Scoped to the cars (not scene.environment) so the
    // rest of the scene keeps its look.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    for (const [tod, makeScene] of [['day', makeCarEnvScene], ['night', makeNightEnvScene]] as const) {
      const envScene = makeScene();
      this.envTex[tod] = pmrem.fromScene(envScene, 0.035).texture;
      envScene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
      });
    }
    pmrem.dispose();
    setCarEnvMap(this.envTex.day!);
    // rivals' dusk showroom = the day bake (they're never close enough to
    // read the difference; the player runs the live cube map anyway)
    this.envTex.dusk = this.envTex.day;

    this.scene.background = new THREE.Color(0xb6cde6);
    this.scene.fog = new THREE.Fog(0xb6cde6, 55, 150);
    // the physical sky: visible background dome by day/dusk, and — PMREM
    // captured in setTimeOfDay — scene.environment, the world's IBL
    this.scene.add(this.skyRig.mesh);

    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 400);
    this.camera.position.set(24, 11, 24);
    this.cam0.pos.copy(this.camera.position);
    this.cam0.quat.copy(this.camera.quaternion);

    this.postfx = new Postfx(this.renderer, this.scene, this.camera, container.clientWidth, container.clientHeight);
    // size the half-res cloud buffer + the dome's screen-lookup resolution
    this.skyRig.setSize(container.clientWidth, container.clientHeight);

    this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0x4a4036, 1.45);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff0dd, 2.2);
    sun.position.set(34, 44, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    // Follow-rig frustum tightened from ±38 m to ±32 m. The chase cam sits
    // ~7–9 m behind the car and low (~2.3 m), looking ~8 m ahead, so the
    // shadows that actually READ on screen live within ~30 m of the player —
    // the box is player-centred, so ±32 m still covers the full visible apron
    // plus margin while culling the far cranes/sheds (whose shadows fell
    // outside the frame anyway) out of the depth pass. Paired with the 3072²
    // cine map (applyRenderPath) the texel pitch is 64 m / 3072 ≈ 20.8 mm,
    // essentially the old 76 m / 4096 ≈ 18.6 mm — PCFSoft blurs the ~2 mm
    // difference away, so shadow edges read identical for ~44% less shadow
    // raster + fewer shadow draws.
    sun.shadow.camera.left = -32;
    sun.shadow.camera.right = 32;
    sun.shadow.camera.top = 32;
    sun.shadow.camera.bottom = -32;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 180;
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);
    this.scene.add(sun.target); // the follow-shadow rig drives it per frame
    this.sun = sun;

    // the visible sun / moon disks, pinned along the key-light directions
    // (setTimeOfDay re-aims the sun disk along the sky preset's sun)
    this.sunSprite = makeSkySprite(makeGlowTexture('rgba(255,246,220,1)', 'rgba(255,212,130,0.5)'), 60);
    this.sunSprite.position.set(170, 220, 100);
    this.scene.add(this.sunSprite);
    this.moonSprite = makeSkySprite(makeGlowTexture('rgba(228,236,255,1)', 'rgba(170,190,235,0.35)'), 30);
    this.moonSprite.position.set(-150, 220, -120);
    this.scene.add(this.moonSprite);
    // lens flare ghosts hang off the sun disk; physics-ray occluded, so the
    // flare dies behind a building and blazes when the sun clears the roofs
    this.scene.add(this.sunFlare.group);

    if (level.mode.kind === 'race') {
      // the circuit is far bigger than the junction — orbit high and wide
      // so the level select actually shows the track, and push the fog out
      // so the far straight doesn't dissolve
      this.director.idleRadius = 95;
      this.director.idleHeight = 60;
      this.scene.fog = new THREE.Fog(0xb6cde6, 90, 340);
    }
    this.levelId = ((Object.keys(LEVELS) as LevelId[]).find((id) => LEVELS[id] === level) ?? 'junction') as LevelId;
    this.heightAt = makeHeightSampler(level);
    this.phys = createPhysics();
    const env = buildEnvironment(this.scene, this.phys, level);
    this.sea = env.sea;
    this.grass = env.grass;
    // SHARED FILE (grass agent owns grass.ts) — forced-cine touch only: the
    // game is always CINE, so seed the full blade budget (headless verify runs
    // get the sparse FAST subset via applyRenderPath below). Don't retune here.
    this.grass?.setTier(this.cineActive() ? 'cine' : 'fast');
    setSeaCamera(this.camera); // the sea reads the camera for fresnel/sparkle
    // prop colliders are synchronous and must exist before the first
    // physics step (their GLB visuals stream in whenever — see props.ts)
    loadLevelProps(this.scene, this.phys, level);
    // prop anchors double as pass-by whoosh triggers (sense-of-speed A5):
    // presentation only — static positions in, positioned one-shots out
    this.audio.setTrackside((level.props ?? []).map((p) => ({ x: p.x, y: 2, z: p.z })));
    this.fx = new Effects(this.scene);
    this.pickups = new Pickups(this.scene, level.pickups);
    this.control.reset(Math.atan2(level.player.dir.x, level.player.dir.z));
    this.beginTake();
    this.buildActors();

    // sound: fetch the recorded clips now (no AudioContext needed) so
    // they're decoded and ready by the first user gesture
    this.audio.prefetch();
    this.audioFrame = {
      dt: 0, timeScale: 1, cam: this.camera, driving: false, speed: 0,
      throttle: false, boosting: false, drifting: false, slip: 0, grounded: true, vy: 0,
      actors: this.actors, player: null,
    };

    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    this.detachGamepad = this.gamepad.attach(); // gamepadconnected/disconnected
    container.addEventListener('pointerdown', this.onPointerDown);
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);

    this.applyRenderPath(); // tone-map handoff + player env before first frame
    this.setTimeOfDay(this.timeOfDay); // sweep the freshly built scene

    this.schedule();

    // dev console handle: window.__game.explode(...), inspect state, etc.
    (window as unknown as { __game: Game }).__game = this;
  }

  /** Engine sound flavor (stock onboard recording / sampled V10 / V8).
   *  Pure audio — the sim, and so replay determinism, never sees it. */
  setEngineFlavor(f: EngineFlavor): void {
    this.audio.setEngineFlavor(f);
  }

  /** Time-of-day toggle (day / dusk / night): regrades the lights and fog,
   *  re-aims the sun (and so the follow-shadow rig), rebakes the sky into
   *  scene.environment, swaps the showroom reflection world and runs the
   *  emissive sweep. Pure visuals — the sim, and so replay determinism,
   *  never sees it. */
  setTimeOfDay(t: TimeOfDay): void {
    this.perf.tag(`tod:${t}`);
    this.timeOfDay = t;
    const night = t === 'night';
    const p = TOD_PRESETS[t];
    (this.scene.background as THREE.Color).setHex(p.fog);
    (this.scene.fog as THREE.Fog).color.setHex(p.fog);
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.hemi.intensity = p.hemiInt;
    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = p.sunInt;

    if (night) {
      // night now has a real scattered-blue dome (deep-blue gradient + stars +
      // a faint horizon glow) instead of a flat dark background, but the
      // lamp-glint showroom still drives scene.environment — the moon is a weak
      // key light and the dome's own IBL would be near-black, so cars/ocean
      // keep reading the established night reflections. The sun preset puts the
      // disc below the horizon (intensity 0), so the dome contributes only the
      // night sky, not a stray sun. Moon key-light direction unchanged.
      this.skyRig.mesh.visible = true;
      this.skyRig.configure(SKY_PRESETS.night);
      // re-bake the high-res cloud panorama for this tod's lighting (cheap moonlit
      // silhouettes); the dome samples it each frame instead of raymarching.
      this.skyRig.cloudBake(this.renderer);
      this.sunDirUnit.set(-30, 48, -24).normalize();
      this.scene.environment = this.envTex.night!;
    } else {
      this.skyRig.mesh.visible = true;
      this.skyRig.configure(SKY_PRESETS[t]);
      // re-bake the high-res cloud panorama for this tod's lighting (warm rims at
      // dusk, bright tops by day); the dome samples it each frame, no raymarch.
      this.skyRig.cloudBake(this.renderer);
      this.sunDirUnit.copy(this.skyRig.sunDir);
      this.scene.environment = this.skyRig.bake(this.renderer);
    }
    this.scene.environmentIntensity = p.envInt;
    this.updateShadowRig(); // re-aim immediately — don't wait a frame

    // re-tint the animated sea to the new time of day: it mirrors an analytic
    // sky built from the SAME palette as the dome (sky/horizon colours), with
    // a deeper body colour and a sun glint that dims at dusk/night. Visual
    // only — the sea is render-driven and never in the sim/replay hash.
    if (this.sea) {
      const SEA_DEEP: Record<TimeOfDay, number> = { day: 0x0a3c4e, dusk: 0x163a44, night: 0x040a14 };
      const SEA_GLINT: Record<TimeOfDay, number> = { day: 1.0, dusk: 0.85, night: 0.4 };
      const SEA_AMBIENT: Record<TimeOfDay, number> = { day: 1.0, dusk: 0.8, night: 0.32 };
      this.sea.setTimeOfDay({
        sky: p.hemiSky,
        horizon: p.fog,
        deep: SEA_DEEP[t],
        sun: p.sunColor,
        sunDir: this.sunDirUnit,
        sunStrength: SEA_GLINT[t],
        envIntensity: p.envInt,
        ambient: SEA_AMBIENT[t],
      });
    }

    // re-tint the blade grass to the same time of day (its lit base colour +
    // ambient level track the sky like the sea's). Visual only, render-driven.
    if (this.grass) {
      const GRASS_AMBIENT: Record<TimeOfDay, number> = { day: 1.0, dusk: 0.82, night: 0.42 };
      this.grass.setTimeOfDay({ ambient: GRASS_AMBIENT[t], tint: p.sunColor });
    }

    this.sunSprite.position.copy(this.sunDirUnit).multiplyScalar(290);
    this.sunSprite.visible = !night;
    this.moonSprite.visible = night;

    // swap the reflection world: showroom sky by day, lamp glints and lit
    // windows by night (its base is already dark — no extra dimming)
    const env = this.envTex[t];
    if (env) setCarEnvMap(env);
    applyCarEnvScale(night ? 1.15 : 1);
    this.refreshPlayerEnv();
    applyTimeOfDay(this.scene, t);

    // flip the vehicle/lamp lights for the new tod NOW (syncMeshes drives
    // them per frame) so the warmup below compiles against the real light
    // count, not last frame's
    const lightsOn = t !== 'day';
    for (const a of this.actors) {
      const nl = a.nightLights;
      if (!nl) continue;
      if (nl.lamp) nl.lamp.visible = lightsOn;
      if (nl.head) nl.head.visible = lightsOn;
      if (nl.brake) nl.brake.visible = lightsOn;
    }
    // warmup: pre-compile every material — including the pooled, still
    // invisible explosion/debris/glass sprites — under the new light
    // signature, so the first explosion never stalls on first-use shader
    // compiles. Programs are keyed on the bound render target too
    // (toneMapping + output color space), so compile both variants: the
    // screen one (fast tier) and the render-target one (cine composer
    // buffer and the reflection cube share that key). The relight already
    // churns programs; this rides it. Skipped under ?verify=1: headless
    // replays render pixels nobody sees.
    if (!this.forceFast) {
      this.renderer.compile(this.scene, this.camera);
      this.renderer.setRenderTarget(this.warmupRT);
      this.renderer.compile(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
    }
  }

  /** Headless / review render-path seam (see GfxMode). The player-facing
   *  FAST/CINE tier was removed — the game always renders in CINE — so this is
   *  NOT a player control: it exists so tools/refshot.mjs can flip into the
   *  bare-renderer 'fast' path for its --gfx fast review captures through
   *  window.__game. ?verify=1 already pins forceFast at boot; this lets the
   *  refshot tool reach it too. After flipping it, re-derive the render path. */
  setGfx(g: GfxMode): void {
    this.perf.tag(`gfx:${g}`);
    this.forceFast = g === 'fast';
    this.applyRenderPath();
  }

  /** Apply the active render path (CINE composer vs the bare renderer) to the
   *  renderer + scene: blade density, tone-mapping owner, shadow budget and
   *  the player's reflection source. Driven by cineActive() — CINE in all real
   *  play, FAST only under the headless/review bypass. */
  private applyRenderPath(): void {
    const cine = this.cineActive();
    // SHARED FILE (grass agent owns grass.ts) — forced-cine touch only: pass
    // the resolved tier so headless FAST gets the sparse subset; don't retune.
    this.grass?.setTier(cine ? 'cine' : 'fast');
    // with the composer, the renderer draws into an HDR buffer — ACES then
    // lives in the chain (postfx.ts); without it, back on the renderer
    this.renderer.toneMapping = cine ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    // Cine shadow map dropped 4096²→3072². With the ±32 m frustum the texel
    // pitch matches the old 4096²/±38 m rig (~20 mm), so edges look identical
    // while the depth pass rasterises 44% fewer texels (9.4M vs 16.8M).
    const size = cine ? 3072 : 2048;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.refreshPlayerEnv();
  }

  /** Live car-glass tweak surface for the debug overlay (tint / transmission /
   *  roughness / thickness / ior / reflection / frost). Pure visuals — the
   *  glass material is presentation-only, so this never touches the sim. The
   *  overlay reaches it through window.__game like the refshot poses. */
  setGlassParams(p: Partial<GlassParams>): GlassParams {
    const out = applyGlassParams(p);
    // a reflection-strength tweak must survive the next day/night swap, which
    // re-points the env scale — re-seed the player clone now
    this.refreshPlayerEnv();
    return out;
  }

  getGlassParams(): GlassParams {
    return { ...glassParams };
  }

  // The game always renders in CINE (the film-look composer is always on);
  // the player-facing FAST/CINE tier choice was removed. The ONLY thing that
  // takes the bare-renderer path now is the headless determinism bypass:
  // ?verify=1 replays (and tools/refshot.mjs --gfx fast review captures) set
  // forceFast so swiftshader doesn't pay for cine pixels nobody hashes. So
  // cineActive() collapses to "not forced fast" — true in all real play.
  private cineActive(): boolean {
    return !this.forceFast;
  }

  /** The player's paint reflects the live capture in cine, the showroom in
   *  fast — re-pointed on every gfx or time-of-day change. */
  private refreshPlayerEnv(): void {
    const fallback = this.envTex[this.timeOfDay] ?? this.envTex.day!;
    setPlayerEnvMap(this.cineActive() ? this.reflections.texture : fallback);
  }

  // ---------- follow-the-player shadow rig ----------
  // The old fixed ±34 m box only shadowed the junction block around the
  // origin — race circuits span hundreds of metres and most of every lap
  // simply had no shadows. The box now tracks the player (idle: the level
  // origin), snapped to shadow-texel steps in light space so the shadow
  // edges don't swim as the box glides.
  private updateShadowRig(): void {
    const t = this.player ? this.player.group.position : _shadowOrigin;
    const cam = this.sun.shadow.camera;
    const texel = (cam.right - cam.left) / this.sun.shadow.mapSize.x;
    // light-space basis (sun direction is constant per time of day)
    _shadowRight.crossVectors(UP, this.sunDirUnit).normalize();
    _shadowUp.crossVectors(this.sunDirUnit, _shadowRight);
    const px = Math.round(t.dot(_shadowRight) / texel) * texel;
    const py = Math.round(t.dot(_shadowUp) / texel) * texel;
    const pd = t.dot(this.sunDirUnit);
    _shadowTarget.set(0, 0, 0).addScaledVector(_shadowRight, px).addScaledVector(_shadowUp, py).addScaledVector(this.sunDirUnit, pd);
    this.sun.target.position.copy(_shadowTarget);
    this.sun.position.copy(_shadowTarget).addScaledVector(this.sunDirUnit, 60);
    this.sun.target.updateMatrixWorld();
  }

  /** rAF normally; setTimeout when the tab is hidden (rAF stops firing
   *  there, which would freeze the sim for backgrounded tabs and for
   *  headless/automated runs). */
  private schedule(): void {
    if (document.hidden) {
      this.rafIsTimeout = true;
      this.raf = window.setTimeout(() => this.frame(performance.now()), 33);
    } else {
      this.rafIsTimeout = false;
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  // ---------- public API ----------

  /** DEBUG-ONLY side-profile glass crash test (tools/glass-crash.mjs). Drops a
   *  static wall a few metres to the car's +X side, teleports the player onto
   *  the road facing the wall, marks it a wreck so the crumple + glass damage
   *  pipeline engages, and launches it LATERALLY at `speed` m/s straight into
   *  the wall. A locked side camera then watches the windscreen crack →
   *  frost → blow.
   *
   *  DETERMINISM: this writes physics state directly (body velocity/position,
   *  a one-off static body) and is NEVER called during a recorded take or a
   *  replay — only the headless harness reaches it through window.__game. The
   *  recorder records KEYS, not this method, so it cannot pollute a take; the
   *  replay verifier forces ?verify=1 (forceFast) and runs fixtures, never
   *  this. It is, by construction, the "clearly-isolated debug-only path the
   *  recorder never sees". Visual/diagnostic only. */
  crashTest(speed: number): void {
    const p = this.player;
    if (!p) return;
    this.state = GameState.Launch;
    this.timeScale = 1;
    this.slowTimer = 0;

    // banish every other actor far below the floor and freeze it asleep, so
    // the player crashes cleanly into OUR wall and the side shot stays empty
    // but for the car + wall (junction traffic includes an explosive tanker —
    // a stray T-bone there would fireball over the glass we're judging)
    for (const a of this.actors) {
      if (a === p) continue;
      a.body.velocity.set(0, 0, 0);
      a.body.angularVelocity.set(0, 0, 0);
      a.body.position.set(a.body.position.x, -200, a.body.position.z);
      a.body.sleep();
      a.group.visible = false;
    }

    // park the car on the road, nose along -z (its forward), a clear run-up to
    // the +X wall; lift slightly so the suspension settles, not clips. The
    // run-up scales with speed so a slow 8 m/s tap still reaches the wall
    // before damping stalls it, while a 40 m/s hit still gets an approach beat.
    const carX = -Math.max(7, Math.min(16, 2 + speed * 0.45));
    const carY = (p.spec?.rideHeight ?? 0.8) + 0.05;
    p.body.position.set(carX, carY, 0);
    p.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), 0);
    p.body.angularVelocity.set(0, 0, 0);
    // launch sideways into the wall at the requested speed (a pure +X shove —
    // a T-bone into the driver's door, the classic glass shot)
    p.body.velocity.set(speed, 0, 0);
    p.body.wakeUp();
    p.body.collisionFilterMask = -1; // hit the wall (and everything)
    this.markCrashed(p); // a wreck: crumple + glass break on contact
    p.damageLvl = 0;

    // a fresh static wall at +X. mass 0 = immovable; the full mask so the
    // chassis box actually collides. Only ever spawned by the harness, so the
    // leak across repeated calls is irrelevant (one process, one shot each).
    const wallX = 2.5;
    const wallHalf = new CANNON.Vec3(0.4, 2.2, 6);
    const wb = new CANNON.Body({ mass: 0, material: this.phys.matGround });
    wb.addShape(new CANNON.Box(wallHalf));
    wb.position.set(wallX, wallHalf.y, 0);
    this.phys.world.addBody(wb);
    const wallMesh = new THREE.Mesh(
      new THREE.BoxGeometry(wallHalf.x * 2, wallHalf.y * 2, wallHalf.z * 2),
      new THREE.MeshStandardMaterial({ color: 0x6b7178, roughness: 0.9 }),
    );
    wallMesh.position.copy(wb.position as unknown as THREE.Vector3);
    wallMesh.castShadow = wallMesh.receiveShadow = true;
    this.scene.add(wallMesh);
  }

  /** Debug-only accessors for tools/glass-crash.mjs (never used in play). */
  __debugPlayer(): Actor | null {
    return this.player;
  }
  __debugPlayerX(): number | null {
    return this.player ? this.player.body.position.x : null;
  }
  /** Reset the take so the next crashTest starts from an intact car. Reuses
   *  the same reset() the Done→Idle flow runs; harness-only. */
  __debugReset(): void {
    this.reset();
  }

  /** Park the player still at the world origin for a static glass close-up
   *  (tools/glass-crash.mjs --detail), facing the camera so the windscreen
   *  reads. Marks it crashed so a debug glass hit takes. Harness-only. */
  __debugParkForGlass(): void {
    const p = this.player;
    if (!p) return;
    this.state = GameState.Launch;
    this.timeScale = 1;
    this.slowTimer = 0;
    for (const a of this.actors) {
      if (a === p) continue;
      a.body.position.set(a.body.position.x, -200, a.body.position.z);
      a.body.sleep();
      a.group.visible = false;
    }
    p.body.position.set(0, (p.spec?.rideHeight ?? 0.8) + 0.05, 0);
    // yaw 180° so the NOSE (and windscreen) faces a +z camera — hull forward
    // is -z, so a half-turn points it at the lens
    p.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI);
    p.body.velocity.set(0, 0, 0);
    p.body.angularVelocity.set(0, 0, 0);
    this.markCrashed(p);
  }

  /** Apply one controlled glass hit at the windscreen (upper front), so the
   *  --detail sheet can step a single pane through crack → frost → blow.
   *  `power` drives the stage jump (≤3 cracks, >6 frosts/blows). Harness-only. */
  __debugGlassHit(power: number): number {
    const p = this.player;
    if (!p) return 0;
    p.group.updateMatrixWorld(true);
    // upper-front of the hull = the windscreen band (nose is -z, forward)
    const wp = new THREE.Vector3(0.2, 0.5, -0.6);
    p.group.localToWorld(wp);
    return shatterGlass(p, wp, 1.6, power);
  }

  /** Detonate at a world position. power ≈ 1 is a barrel, ~2.4 a tanker. */
  explode(p: THREE.Vector3, power: number): void {
    this.perf.tag('explosion');
    this.fx.explosion.spawn(p, power);
    this.fx.sparks.spawn(p, 70, 8 + 5 * power);
    this.fx.debris.spawn(p, 14 + Math.round(6 * power), 9 * power);
    this.fx.scorch.add(p.x, p.z, 1.4 + 0.8 * power);
    this.audio.explosion(power, p);

    const R = EXPLOSION_RADIUS_BASE + EXPLOSION_RADIUS_PER_POWER * power;
    // shake + refocus are the player's attention: a blast grabs the camera
    // only when it goes off ON TOP OF the player (their crashbreaker, or a
    // barrel/tanker in their own pileup — both land inside the blast radius).
    // A rival fireball across the junction stays audible-only and never yanks
    // the crash orbit off the player's wreck. (Gating this also keeps the
    // aftertouch axes stable: a distant blast no longer moves focusTarget,
    // so it can't perturb the camera-relative wreck steering.)
    const pp = this.player?.body.position;
    if (pp) {
      const dx = pp.x - p.x;
      const dy = pp.y - p.y;
      const dz = pp.z - p.z;
      if (dx * dx + dy * dy + dz * dz <= R * R) {
        this.director.addShake(0.7 + 0.4 * power);
        this.director.focusTarget.copy(p);
      }
    }

    this.mode.score?.beginBlast(power);

    const kick = (body: CANNON.Body, massScale: number): number => {
      const dx = body.position.x - p.x;
      const dy = body.position.y - p.y;
      const dz = body.position.z - p.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > R) return 0;
      const fall = 1 - d / R;
      const f = fall * (0.4 + 0.6 * fall);
      body.wakeUp();
      let nx = dx / d;
      let ny = dy / d;
      let nz = dz / d;
      if (d < 0.4) {
        nx = 0;
        ny = 1;
        nz = 0;
      }
      ny += 0.55; // JC2 lofts everything skyward
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const dv = EXPLOSION_KICK * (1 + power) * f * massScale;
      const j = (dv * body.mass) / nl;
      body.applyImpulse(
        new CANNON.Vec3(nx * j, ny * j, nz * j),
        new CANNON.Vec3((simRand() - 0.5) * 0.8, (simRand() - 0.5) * 0.5, (simRand() - 0.5) * 0.8),
      );
      return fall;
    };

    for (const a of this.actors) {
      const massScale = Math.min(1, Math.max(0.35, EXPLOSION_MASS_REF / a.body.mass));
      const fall = kick(a.body, massScale);
      if (fall <= 0) continue;
      if (a.kind === 'vehicle') {
        if (!a.isPlayer || this.mode.playerCanCrash()) this.markCrashed(a); // practice: blasted, not wrecked
        a.damageLvl += 12 * power * fall;
        // blast wave folds the near side outward-in: push along blast → car
        const bdir = new THREE.Vector3(a.body.position.x - p.x, 0, a.body.position.z - p.z);
        this.deformQueue.push({ actor: a, p: p.clone(), strength: (6 + 7 * power) * fall, dir: bdir.lengthSq() > 0.01 ? bdir.normalize() : null });
        accumulatePanelDamage(a, p, (6 + 7 * power) * fall, this.detachPanel);
        if (fall > 0.45 && shatterGlass(a, p, 999, 99) > 8) {
          _impact.set(a.body.position.x, a.body.position.y + 0.9, a.body.position.z);
          this.fx.glass.spawn(_impact, 26, 3 + power);
          this.audio.glassBreak(_impact, true);
        }
        if (fall > 0.55 && a.popped < 3 && a.crashed && simRand() < 0.5) this.popLooseWheel(a, p);
        this.mode.score?.blastDraw(a, power, fall);
        if (a.spec?.explosive && !a.exploded && a.fuse === null && fall > 0.2) a.fuse = 0.25 + simRand() * 0.2;
      } else if (a.kind === 'barrel' && !a.exploded && a.fuse === null) {
        // chain reaction: farther barrels pop later — the JC2 ripple
        a.fuse = 0.08 + (R - R * fall) * 0.05 + simRand() * 0.15;
      }
    }
    for (const lp of this.looseParts) kick(lp.body, 1);

    this.mode.score?.endBlast(p);

    if (this.player) {
      if (this.state === GameState.Launch && this.player.crashed) this.enterCrashTime();
      else if (this.state === GameState.Crash) this.slowTimer = Math.min(this.slowTimer + 1.1, 3.6);
      else if (this.state === GameState.Settle) {
        // a late detonation drags us back into cinematic crashtime
        this.state = GameState.Crash;
        this.slowTimer = 1.4;
        this.events.emit('state', this.state);
      }
    }
  }

  launch(): void {
    if (this.state !== GameState.Idle) return;
    this.state = GameState.Launch;
    this.events.emit('state', this.state);
    this.audio.resume();
    this.audio.launch();
  }

  reset(): void {
    for (const a of this.actors) this.removeActor(a, false);
    this.actors.length = 0;
    this.byBody.clear();
    for (const lp of this.looseParts) {
      this.scene.remove(lp.mesh);
      this.phys.world.removeBody(lp.body);
    }
    this.looseParts.length = 0;
    this.fx.reset();
    this.pairCooldown.clear();
    this.checked.clear();
    this.nearMissAt.clear();
    this.deformQueue.length = 0;

    this.timeScale = 1;
    this.slowTimer = 0;
    this.settleTimer = 0;
    this.crashElapsed = 0;
    this.simTime = 0;
    this.accumulator = 0;
    this.lastGlance = -9;
    if (this.takedownCamT > 0) this.events.emit('cine', false);
    this.takedownCamT = 0;
    this.takedownVictim = null;
    this.takedowns.reset(); // clear the revenge ledger for the fresh take
    this.playerWallGraceUntil = 0;
    this.pickups.reset();
    this.lastEmittedBoost = -1; // force a fresh boost HUD emit next frame
    this.control.reset(Math.atan2(this.level.player.dir.x, this.level.player.dir.z));
    this.director.reset();
    this.camera.position.copy(this.cam0.pos);
    this.camera.quaternion.copy(this.cam0.quat);
    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    this.state = GameState.Idle;
    this.beginTake();
    this.buildActors();
    this.events.emit('state', this.state);
    this.mode.score?.reset(); // resync the HUD zeros
  }

  /** Take boundary: re-seed the sim RNG and start a fresh tape. Replays
   *  reuse the recorded seed and keep the recorder disarmed instead. */
  private beginTake(): void {
    this.stepIndex = 0;
    this.clock = 0;
    if (this.replay) {
      seedSim(this.replay.file.seed);
      this.recorder.disarm();
    } else {
      const seed = rollSeed();
      seedSim(seed);
      this.recorder.begin(this.levelId, seed);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafIsTimeout) clearTimeout(this.raf);
    else cancelAnimationFrame(this.raf);
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    this.detachGamepad?.();
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.resizeObserver.disconnect();
    this.postfx.dispose();
    this.warmupRT.dispose();
    this.reflections.dispose();
    this.skyRig.dispose();
    this.sunFlare.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // dispose() alone leaks the WebGL
    // context; repeated HMR remounts would hit the browser's context cap
    this.renderer.domElement.remove();
    this.audio.dispose(); // AudioContexts are capped per page too
    this.events.clear();
  }

  // ---------- setup ----------

  private buildActors(): void {
    resetModelPicker(); // traffic dresses in the same models every take
    const onCollide = (a: Actor, e: CollideEvent) => this.onCollide(a, e);
    this.player = createVehicle(this.scene, this.phys, onCollide, this.level.player, true);
    this.register(this.player);
    for (const spawn of this.level.traffic) this.register(createVehicle(this.scene, this.phys, onCollide, spawn, false));
    // furniture rides the road-grade base field (elevation.md Phase 1) —
    // base() is literal 0 on flat levels, so only the GANTRY POINT north
    // arc actually lifts (the LOOKOUT LEDGE mouth barrels live at +6 m)
    for (const p of this.level.poles) this.register(createPole(this.scene, this.phys, onCollide, p.x, p.z, this.heightAt.base(p.x, p.z)));
    for (const b of this.level.barrels) this.register(createBarrel(this.scene, this.phys, onCollide, b.x, b.z, this.heightAt.base(b.x, b.z)));

    // the mode is recreated, not reset — a fresh strategy (and its rivals /
    // scoreboard) every run, same as the actors above
    this.mode = createMode(this.level, this.makeHost());
  }

  /** The narrow surface of Game a mode is allowed to touch. */
  private makeHost(): ModeHost {
    const game = this;
    return {
      events: this.events,
      get actors(): readonly Actor[] {
        return game.actors;
      },
      get player(): Actor {
        return game.player!;
      },
      control: this.control,
      heightAt: this.heightAt,
      project: (p) => this.projectToScreen(p),
      spawnVehicle: (spawn) => {
        const a = createVehicle(this.scene, this.phys, (act, e) => this.onCollide(act, e), spawn, false);
        this.register(a);
        return a;
      },
      repairActor: (a) => this.repairActor(a),
      finish: (report) => this.finishRun(report),
    };
  }

  /** Body-shop a vehicle: reclaim the loose parts that are its torn panels
   *  (they share meshes), then restore the car itself. Race respawns use
   *  this for the player AND for taken-down rivals. */
  private repairActor(a: Actor): void {
    const panelMeshes = new Set(a.panels.filter((pl) => pl.detached).map((pl) => pl.mesh));
    this.looseParts = this.looseParts.filter((lp) => {
      if (!panelMeshes.has(lp.mesh as THREE.Mesh)) return true;
      this.phys.world.removeBody(lp.body);
      return false;
    });
    repairVehicle(a);
  }

  private repairPlayer(): void {
    if (this.player) this.repairActor(this.player);
  }

  private register(a: Actor): void {
    this.actors.push(a);
    this.byBody.set(a.body.id, a);
  }

  private removeActor(a: Actor, splice = true): void {
    this.scene.remove(a.group);
    this.phys.world.removeBody(a.body);
    this.byBody.delete(a.body.id);
    for (const part of a.deformables) part.mesh.geometry.dispose();
    if (splice) {
      const i = this.actors.indexOf(a);
      if (i >= 0) this.actors.splice(i, 1);
    }
  }

  // ---------- input ----------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'KeyM') {
      // mute is pure presentation — fine to flip even while a tape plays
      this.events.emit('flash', this.audio.toggleMute() ? 'MUTED' : 'SOUND ON');
      return;
    }
    if (this.replay) {
      // the tape is driving — live input would desync it
      if (e.code === 'Escape') this.stopReplay(true);
      return;
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    this.keys[e.code] = true;
    this.audio.init();
    this.audio.resume();
    if (e.repeat) return; // OS auto-repeat must not respawn commands/reports
    // discrete actions go through the command queue: executed at the next
    // frame start and recorded there, so a replay fires them on the exact
    // same frame (key STATE rides the per-frame bitmask instead)
    if (e.code === 'Space') this.pendingCmds.push({ t: 'launch' });
    if (e.code === 'Enter' || e.code === 'NumpadEnter') this.reset();
    if (e.code === 'KeyR') this.captureReport();
    if (e.code === 'KeyE') this.pendingCmds.push({ t: 'cb' });
    if (e.code === 'KeyB') {
      // sandbox firework near the junction center — the position is rolled
      // here and recorded in the command, so replays reuse it verbatim
      this.pendingCmds.push({ t: 'explode', x: (Math.random() - 0.5) * 8, y: 0.6, z: (Math.random() - 0.5) * 8, power: 1.2 });
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.replay) return;
    this.keys[e.code] = false;
  };

  private onPointerDown = (): void => {
    if (this.replay) return;
    this.audio.init();
    this.audio.resume();
    if (this.state === GameState.Idle) this.pendingCmds.push({ t: 'launch' });
    else if (this.state === GameState.Done) this.reset();
  };

  private execCommand(c: Command): void {
    switch (c.t) {
      case 'launch':
        this.launch();
        break;
      case 'cb':
        this.tryCrashbreaker();
        break;
      case 'explode':
        this.explode(new THREE.Vector3(c.x, c.y, c.z), c.power);
        break;
    }
  }

  /** Route a one-shot controller action through the SAME paths the keyboard's
   *  keydown handler uses, so a pad press records identically to a key press:
   *  queued commands land in pendingCmds (executed + recorded at frame start),
   *  restart/mute mirror Enter/KeyM. Only ever called for the LIVE take — the
   *  caller (frame()) skips the poll entirely during a replay. */
  private dispatchGamepadIntent(intent: GamepadIntent): void {
    switch (intent) {
      case 'launch':
        this.pendingCmds.push({ t: 'launch' }); // == Space keydown
        break;
      case 'restart':
        this.reset(); // == Enter
        break;
      case 'crashbreaker':
        this.pendingCmds.push({ t: 'cb' }); // == KeyE
        break;
      case 'explode':
        // sandbox blast — position rolled here and recorded in the command, so
        // replays reuse it verbatim (mirrors the KeyB keydown handler exactly)
        this.pendingCmds.push({ t: 'explode', x: (Math.random() - 0.5) * 8, y: 0.6, z: (Math.random() - 0.5) * 8, power: 1.2 });
        break;
      case 'mute':
        this.events.emit('flash', this.audio.toggleMute() ? 'MUTED' : 'SOUND ON'); // == KeyM
        break;
    }
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.postfx.setSize(w, h);
    this.skyRig.setSize(w, h); // keep the cloud buffer at half the new size
  }

  private tryCrashbreaker(): void {
    if (!this.mode.allowCrashbreaker()) return;
    if (this.state !== GameState.Crash && this.state !== GameState.Settle) return;
    if (!this.player?.crashed || !this.mode.score?.spendCrashbreaker()) return;
    this.events.emit('flash', 'CRASHBREAKER');
    const p = this.player.body.position;
    this.explode(new THREE.Vector3(p.x, p.y + 0.6, p.z), CRASHBREAKER_POWER);
  }

  // ---------- collisions / scoring ----------

  private onCollide(self: Actor, e: CollideEvent): void {
    const other = e.body;
    if (!e.contact) return;
    const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
    const scenery = this.phys.noCrashIds.has(other.id); // ground, curbs, ramps

    const oa = this.byBody.get(other.id);
    // loose parts (torn panels, popped wheels) are dynamic and ownerless —
    // passed to the mode as `other: null` they'd be judged as a WALL. A
    // door shed by the player's own ram once read as a 14 m/s wall touch
    // and the glance rerouted the car 90° into the real barrier. Debris
    // pelts the bodywork (sparks + payout below), it never judges.
    const debris = !oa && other.type === CANNON.Body.DYNAMIC;

    let takedown = false;
    if (impact > 2.2 && !scenery && !debris) {
      // a wall met by a LIVE rival nobody knocked loose means the AI steered
      // it there — fixtures pin this at zero (shoved rivals are destabilized
      // first, so an earned slam into the barrier never counts)
      if (this.replay && !oa && self.kind === 'vehicle' && !self.isPlayer && !self.crashed && self.destabilized <= 0) {
        this.replay.stats.rivalWallHits++;
      }
      // poles and barrels are smashables — they get batted aside and never
      // trigger the crash sequence; the rules per mode live in collision.ts
      const wallDir = oa ? null : (this.phys.wallDirs.get(other.id) ?? null);
      const out = this.mode.resolveContact({
        self,
        other: oa ?? null,
        impact,
        simTime: this.simTime,
        shuntGrace: this.checked,
        wallDir,
        playerWallGraceUntil: this.playerWallGraceUntil,
      });
      if (out.takedown) {
        takedown = true;
        // junction: the shunted car; race: the rival that just met the wall
        const victim = out.wreckSelf && !self.isPlayer ? self : oa;
        // B3-style banner: classify HOW the takedown happened from the data the
        // sim already has at this contact — signature zone, aftertouch steer,
        // airborne victim, revenge grudge, slam geometry — and award the
        // type's points. The rammer is the player on a direct slam; on an
        // aftertouch the player's own wreck is doing the hitting (self is the
        // victim there, so the rammer is the player either way). Signature
        // zones (CRANE SMASH, CLIFF CRASH, …) are scoring-only circles in the
        // race def. ALL PRESENTATION — see takedowns.ts determinism contract.
        const info = classifyTakedown(
          {
            rammer: this.player ?? self,
            victim: victim ?? null,
            impact,
            aftertouch: this.aftertouchActive,
            signatureZone: victim ? this.signatureZone(victim) : null,
            junction: this.level.mode.kind !== 'race',
          },
          this.takedowns,
        );
        this.events.emit('takedown', {
          kind: info.kind,
          label: info.label,
          points: info.points,
          key: ++this.takedownBannerKey,
        });
        this.audio.kaching(); // takedowns pay — ring it up
        this.playerWallGraceUntil = this.simTime + TAKEDOWN_WALL_GRACE;
        if (this.replay) {
          this.replay.stats.takedowns++;
          this.replay.lastTakedownAt = this.simTime;
        }
        // B3 reward loop: the player's takedown EXTENDS the boost bar one
        // segment (up to 4x) and instantly refills the whole, longer bar —
        // chain takedowns to grow it. A takedown is the player's when they
        // rammed, or when the wreck was a rival the player set sliding.
        const playerTakedown =
          self.isPlayer || (victim ? victim.destabilizedByPlayer : false) || (oa ? oa.destabilizedByPlayer : false);
        if (playerTakedown) this.control.addBoostSegment();
        if (victim) {
          if (out.graceOther && oa) this.checked.set(oa.body.id, this.simTime);
          _impact.set(victim.body.position.x, victim.body.position.y + 1, victim.body.position.z);
          this.mode.score?.takedownBonus(victim, _impact);
          this.mode.score?.takedownPoints(info.points, _impact); // type-specific payout
          if (out.takedownCam) {
            this.takedownVictim = victim;
            this.takedownCamT = 1.7; // the autopilot drives while we watch
            this.events.emit('cine', true); // letterbox for the beat
          }
        }
      }
      if (out.destabilizeOther > 0 && oa && !oa.crashed) {
        if (oa.destabilized <= 0 && oa.isPlayer) this.events.emit('flash', 'SLAMMED');
        if (self.isPlayer && this.replay) this.replay.stats.rivalShunts++;
        // chain credit (#1): a victim knocked loose by a car the player set
        // sliding is still the player's takedown when it finds the wall
        if (self.isPlayer || self.destabilizedByPlayer) oa.destabilizedByPlayer = true;
        oa.destabilized = Math.max(oa.destabilized, out.destabilizeOther);
        oa.destabilizedBy = self.body.id;
        if (out.shoveOther > 0) {
          // the ram's kick — strictly horizontal, nobody gets lofted off a
          // bumper. Direction blends the rammer's line with rammer→victim,
          // so a flank hit sends the victim sideways into the wall instead
          // of just punting it down the road (#1: more lateral)
          const v = self.body.velocity;
          const sp = Math.hypot(v.x, v.z) || 1;
          const ob = oa.body;
          const ox = ob.position.x - self.body.position.x;
          const oz = ob.position.z - self.body.position.z;
          const ol = Math.hypot(ox, oz) || 1;
          let dx = v.x / sp + (ox / ol) * 0.8;
          let dz = v.z / sp + (oz / ol) * 0.8;
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl;
          dz /= dl;
          ob.velocity.x += dx * out.shoveOther;
          ob.velocity.z += dz * out.shoveOther;
          if (ob.velocity.y > 1.2) ob.velocity.y = 1.2;
          ob.wakeUp();
          if (v.y > 1.2) v.y = 1.2; // the rammer stays planted too
        }
      }
      if (out.destabilizeSelf > 0 && !self.crashed) {
        if (self.destabilized <= 0 && self.isPlayer) {
          this.events.emit('flash', 'SLAMMED');
          if (this.replay) this.replay.stats.playerSlams++;
        }
        if (oa?.isPlayer) self.destabilizedByPlayer = true;
        self.destabilized = Math.max(self.destabilized, out.destabilizeSelf);
        if (oa) self.destabilizedBy = oa.body.id;
        if (out.shoveSelf > 0 && oa) {
          // the slam's kick, shoveOther mirrored: oa is the shover, self the
          // victim — blended toward shover→victim so it reads as a sideways
          // barge, still strictly horizontal
          const v = oa.body.velocity;
          const sp = Math.hypot(v.x, v.z) || 1;
          const sb = self.body;
          const ox = sb.position.x - oa.body.position.x;
          const oz = sb.position.z - oa.body.position.z;
          const ol = Math.hypot(ox, oz) || 1;
          let dx = v.x / sp + (ox / ol) * 0.8;
          let dz = v.z / sp + (oz / ol) * 0.8;
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl;
          dz /= dl;
          sb.velocity.x += dx * out.shoveSelf;
          sb.velocity.z += dz * out.shoveSelf;
          if (sb.velocity.y > 1.2) sb.velocity.y = 1.2;
          sb.wakeUp();
        }
      }
      if (out.wreckOther && oa) this.markCrashed(oa);
      if (out.wreckSelf) {
        this.markCrashed(self);
        if (self.isPlayer && this.state === GameState.Launch) this.enterCrashTime();
      }
      if (out.wallGlance && self.isPlayer) this.applyWallGlance(e, wallDir);
    }
    if (self.kind === 'barrel' && impact > 4.5 && !self.exploded && self.fuse === null) self.fuse = 0.06;
    if (self.spec?.explosive && impact > 9.5 && !self.exploded && self.fuse === null) self.fuse = 0.18;

    if (impact < 1.4 || this.state === GameState.Idle) return;

    const key = `${self.body.id}>${other.id}`;
    if (this.simTime - (this.pairCooldown.get(key) ?? -1) < 0.12) return;
    this.pairCooldown.set(key, this.simTime);

    const p = contactPointOf(self, e, _impact);

    // cash money — both actors of a pair report the hit; only the lower
    // body id floats it, so a crash doesn't shower duplicate numbers
    this.mode.score?.impactPayout(self, impact, scenery, p, scenery || self.body.id < other.id);

    // effects — crumple, panel loss and the damage ledger belong to wrecks:
    // a car that's still being driven trades paint, not body panels
    this.fx.sparks.spawn(p, Math.min(40, Math.round(impact * 5)), impact * 0.55);
    if (impact > 4.2 && self.deformables.length && self.crashed) {
      // the crumple folds along the way the hitting matter moves relative
      // to us — a wall hit caves the nose backward, a T-bone caves the door
      const rel = new THREE.Vector3(
        other.velocity.x - self.body.velocity.x,
        (other.velocity.y - self.body.velocity.y) * 0.4, // mostly a road-plane event
        other.velocity.z - self.body.velocity.z,
      );
      this.deformQueue.push({ actor: self, p: p.clone(), strength: impact, dir: rel.lengthSq() > 4 ? rel.normalize() : null });
      accumulatePanelDamage(self, p, impact, this.detachPanel);
      self.damageLvl += impact;
      if (self.spec?.explosive && self.damageLvl > self.spec.explosive.fuseDamage && !self.exploded && self.fuse === null) {
        self.fuse = 0.3;
      }
      // windows near the hit crack, then frost, then blow as the tumble lands
      // more hits — a soft knock only spider-webs, a hard hit frosts/blows.
      // The shard burst + break sound only fire once a pane actually frosts or
      // lets go (broken verts at stage ≥2), not on the first hairline crack.
      if (impact > 4.2) {
        const broken = shatterGlass(self, p, 0.5 + impact * 0.09, impact);
        if (broken > 6 && impact > 5.5) {
          this.fx.glass.spawn(p, Math.min(40, broken >> 1), impact * 0.45);
          this.audio.glassBreak(p);
        }
      }
      // axle sag: a heavy hit close to a corner bends it — that corner
      // carries less spring load from now on, so the wreck settles leaning
      if (impact > 7 && self.susp.length) {
        self.group.worldToLocal(_sagLp.copy(p));
        for (const s of self.susp) {
          const dx = s.ax - _sagLp.x;
          const dz = s.az - _sagLp.z;
          if (dx * dx + dz * dz < 1.7) s.sag = Math.max(0.4, s.sag - 0.03 * (impact - 6));
        }
      }
    }
    if (impact > 6 && !scenery) this.fx.debris.spawn(p, 4 + Math.round(impact * 0.8), impact);
    if (impact > 8) {
      this.fx.smoke.spawn(p, { big: true });
      this.fx.smoke.spawn(p, {});
    }
    if (impact > 9 && p.y < 1.6) this.fx.scorch.add(p.x, p.z);
    // wheels belong to wrecks, like the crumple/panel ledger above — an
    // un-gated pop let every hard ram strip a LIVE car (three takedowns =
    // three of the player's own wheels gone = an undriveable hulk that
    // never gets the crash respawn)
    if (impact > 9.5 && self.kind === 'vehicle' && self.crashed && self.popped < 3 && simRand() < 0.75) {
      this.popLooseWheel(self, p);
    }

    this.audio.crash(impact, p, scenery);
    // shake AND focus are the player's attention — only their own contacts
    // (or a takedown they earned via a chain) rattle the camera or pull the
    // crash orbit's look target; rival-on-rival hits and rivals finding walls
    // across the junction stay audible-only. Before this gate, ANY impact > 5
    // anywhere on the map copied into focusTarget, so during the player's own
    // crashtime the orbit would drift off their wreck toward a distant rival
    // pileup. (focusTarget feeds the crash-orbit look, and the look feeds the
    // camera-relative aftertouch axes — so this gate is also what keeps a far
    // rival crash from perturbing the player's wreck steering.)
    const playerInvolved = self.isPlayer || oa?.isPlayer || takedown;
    if (playerInvolved) this.director.addShake(impact * 0.045);
    if (impact > 5 && playerInvolved) this.director.focusTarget.copy(p);

    // crashtime extension (the trigger lives in the crash-marking block)
    if (this.state === GameState.Crash && impact > 7 && this.crashElapsed < 6) {
      this.slowTimer = Math.min(this.slowTimer + 0.8, 3.4);
    }
  }

  /** The named signature theatre the victim wrecked inside, or null. Zones are
   *  circles in the race def with no colliders — the red/white wall stays the
   *  actual wrecking surface; the classifier turns a non-null name into a
   *  SIGNATURE takedown (takedowns.ts). */
  private signatureZone(victim: Actor): string | null {
    const sigs = this.level.mode.kind === 'race' ? this.level.mode.race.signatures : undefined;
    if (sigs) {
      const p = victim.body.position;
      for (const z of sigs) {
        if (Math.hypot(p.x - z.x, p.z - z.z) <= z.r) return z.name;
      }
    }
    return null;
  }

  /** Wreck an actor: the full collision mask returns (wrecks tumble over
   *  ramps and plinths) and each non-player vehicle charges the
   *  crashbreaker a step, Burnout-Revenge style. */
  private markCrashed(a: Actor): void {
    if (a.crashed) return;
    this.perf.tag('wreck');
    if (a.isPlayer && this.replay) {
      this.replay.stats.playerWrecks++;
      const dt = this.simTime - this.replay.lastTakedownAt;
      if (dt < this.replay.stats.takedownToPlayerCrashMin) this.replay.stats.takedownToPlayerCrashMin = +dt.toFixed(3);
    }
    // REVENGE ledger (presentation-only, takedowns.ts): if a rival just took
    // the player down, that rival now owes a REVENGE TAKEDOWN. The shover's
    // body id rides destabilizedBy until it's zeroed below; read it first.
    // Pure sim READ — never read back by the sim, so it can't move a pin.
    if (a.isPlayer) this.takedowns.rememberAggressor(this.byBody.get(a.destabilizedBy) ?? null);
    a.crashed = true;
    a.destabilized = 0; // a wreck is past losing control
    a.destabilizedByPlayer = false;
    a.destabilizedBy = 0;
    a.body.collisionFilterMask = -1;
    // B3: a crash collapses the earned (extended) boost bar back to 1x — the
    // chain reward you built up is the thing you lose when you wreck.
    if (a.isPlayer) this.control.resetBoostBar();
    if (!a.isPlayer && a.kind === 'vehicle') this.mode.score?.chargeCrashbreaker();
  }

  /** Shallow wall touch at racing speed: scrub a little speed and point the
   *  car back along the wall instead of grinding into it. */
  private applyWallGlance(e: CollideEvent, wallDir: { x: number; z: number } | null): void {
    const p = this.player;
    if (!p || p.crashed || p.destabilized > 0) return;
    if (this.simTime - this.lastGlance < 0.3) return;
    this.lastGlance = this.simTime;
    const v = p.body.velocity;
    let tx: number;
    let tz: number;
    if (wallDir) {
      // slide along the barrier, whichever way we're already going
      const s = Math.sign(v.x * wallDir.x + v.z * wallDir.z) || 1;
      tx = wallDir.x * s;
      tz = wallDir.z * s;
    } else {
      const c = e.contact;
      // contact normal, oriented to point from the wall into the car
      let nx = c.ni.x;
      let nz = c.ni.z;
      if (c.bi === p.body) {
        nx = -nx;
        nz = -nz;
      }
      const vn = v.x * nx + v.z * nz;
      tx = v.x - vn * nx;
      tz = v.z - vn * nz;
      const tl = Math.hypot(tx, tz);
      if (tl < 1) return; // square-on crawl — let physics sort that out
      tx /= tl;
      tz /= tl;
    }
    const speed = Math.hypot(v.x, v.z) * 0.82; // the wall takes its toll
    const heading = Math.atan2(tx, tz);
    this.control.heading = heading; // not control.reset() — that refills boost
    this.control.velAngle = heading;
    this.control.drifting = false;
    this.control.speed = speed;
    p.body.velocity.set(tx * speed, v.y, tz * speed);
    this.director.addShake(0.18);
  }

  private popLooseWheel(actor: Actor, p: THREE.Vector3): void {
    const part = popWheel(actor, p, this.scene, this.phys.world, this.phys.matCar);
    if (part) {
      this.perf.tag('wheel-pop');
      this.looseParts.push(part);
      this.audio.wheelPop(p);
    }
  }

  /** A panel crossed its detach threshold: door/bonnet/boot flies off. */
  private detachPanel = (actor: Actor, panel: PanelState): void => {
    this.perf.tag('panel-detach');
    this.scene.attach(panel.mesh); // keep the flapped world transform
    const body = makePanelBody(actor, panel, this.phys.matCar);
    this.phys.world.addBody(body);
    this.looseParts.push({ mesh: panel.mesh, body });
    panel.mesh.getWorldPosition(_panelPos);
    this.fx.sparks.spawn(_panelPos, 12, 4);
    this.audio.clank(_panelPos);
  };

  private collectMultiplier(mult: number, pos: THREE.Vector3): void {
    this.mode.score?.raiseMultiplier(mult);
    this.fx.sparks.spawn(pos, 30, 4);
    this.audio.ding(pos);
    this.mode.score?.floatAt(pos, `x${mult} MULTIPLIER`);
  }

  /** World point → HUD pixel coords for the cash floaters. */
  private projectToScreen(p: THREE.Vector3): { x: number; y: number } | null {
    const v = p.clone().project(this.camera);
    if (v.z > 1 || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    // (the finite guard matters: one NaN reaching a cash floater's CSS is a
    // React render error, and with no error boundary that unmounts the App)
    return {
      x: (v.x * 0.5 + 0.5) * this.container.clientWidth,
      y: (-v.y * 0.5 + 0.5) * this.container.clientHeight,
    };
  }

  // ---------- state machine ----------

  private enterCrashTime(): void {
    this.state = GameState.Crash;
    this.slowTimer = SLOWMO_HOLD;
    this.crashElapsed = 0;
    this.director.beginOrbit(this.camera);
    this.events.emit('state', this.state);
    this.events.emit('flash', 'CRASHTIME');
  }

  /** End the run — the shared tail of every mode's finish. */
  private finishRun(report: ReportData): void {
    this.state = GameState.Done;
    this.events.emit('state', this.state);
    this.events.emit('report', report);
    this.audio.fanfare(report.medal);
  }

  private updateTimeScale(dt: number): void {
    if (this.state === GameState.Crash) {
      this.crashElapsed += dt;
      if (this.slowTimer > 0) {
        this.slowTimer -= dt;
        this.timeScale += (SLOWMO - this.timeScale) * Math.min(1, dt * 10);
      } else {
        this.timeScale += dt * 0.45;
        if (this.timeScale >= 1) {
          this.timeScale = 1;
          if (this.player?.crashed && this.mode.onCrashTimeOver() === 'resume') {
            this.state = GameState.Launch;
          } else {
            this.state = GameState.Settle;
            this.settleTimer = 0;
          }
          this.events.emit('state', this.state);
        }
      }
    } else if (this.state === GameState.Settle) {
      this.settleTimer += dt;
      // only wrecks count — surviving traffic keeps cruising forever
      let speedSum = 0;
      for (const a of this.actors) if (a.kind === 'vehicle' && a.crashed) speedSum += a.body.velocity.length();
      const fusesPending = this.actors.some((a) => a.fuse !== null && !a.exploded);
      if ((speedSum < 2.5 && !fusesPending) || this.settleTimer > 8) this.mode.onSettled();
    }
  }

  // ---------- simulation ----------

  private stepControls(): void {
    if (this.takedownCamT > 0) {
      this.takedownCamT -= FIXED_DT;
      if (this.takedownCamT <= 0) {
        this.takedownCamT = 0;
        this.events.emit('cine', false);
        this.mode.onTakedownCamOver(); // may rescue a beached/halted player
      }
    }

    // shunt-mode timers: a destabilized car is physics-owned until it
    // recovers — or wrecks on whatever it slides into
    for (const a of this.actors) {
      if (a.destabilized <= 0) continue;
      // a shunt slide skids, it doesn't fly — keep the car planted
      if (a.body.velocity.y > 1.5) a.body.velocity.y = 1.5;
      // SLAMMED is degraded steering, not a dead wheel (#1): the slide is
      // physics-owned but the player can lean on it a little
      if (a.isPlayer && !a.crashed) {
        const steer =
          (this.simKeys['ArrowRight'] || this.simKeys['KeyD'] ? 1 : 0) -
          (this.simKeys['ArrowLeft'] || this.simKeys['KeyA'] ? 1 : 0);
        if (steer) {
          const v = a.body.velocity;
          const sp = Math.hypot(v.x, v.z);
          if (sp > 2) {
            const ang = Math.atan2(v.x, v.z) - steer * 0.35 * FIXED_DT; // ~20°/s of fight
            v.x = Math.sin(ang) * sp;
            v.z = Math.cos(ang) * sp;
          }
        }
      }
      a.destabilized -= FIXED_DT;
      if (a.destabilized > 0) continue;
      a.destabilized = 0;
      a.destabilizedByPlayer = false;
      a.destabilizedBy = 0;
      if (a.isPlayer && !a.crashed) {
        // hand the wheel back pointing the way we're sliding
        const v = a.body.velocity;
        const sp = Math.hypot(v.x, v.z);
        if (sp > 1) {
          const h = Math.atan2(v.x, v.z);
          this.control.heading = h;
          this.control.velAngle = h;
        }
        this.control.drifting = false;
        this.control.speed = Math.hypot(v.x, v.z);
      }
    }

    // the player drives for real (until they crash or get slammed loose —
    // then physics owns the car)
    const p = this.player;
    if (p && !p.crashed && p.destabilized <= 0 && this.state !== GameState.Idle && this.state !== GameState.Done) {
      // reuse a module-scope ControlInput — control.update() reads the fields
      // synchronously and never retains the reference, so mutating one object
      // each step is bit-identical to a fresh literal and saves the per-step alloc
      const input = _ctrlInput;
      input.steer =
        (this.simKeys['ArrowRight'] || this.simKeys['KeyD'] ? 1 : 0) -
        (this.simKeys['ArrowLeft'] || this.simKeys['KeyA'] ? 1 : 0);
      input.throttle = !!(this.simKeys['ArrowUp'] || this.simKeys['KeyW']);
      input.boost = !!(this.simKeys['Space'] || this.simKeys['ShiftLeft'] || this.simKeys['ShiftRight']);
      input.brake = !!(this.simKeys['ArrowDown'] || this.simKeys['KeyS']);
      if (this.takedownCamT > 0) {
        // takedown cam: the autopilot holds the middle of the road while
        // the camera is busy admiring your handiwork
        const aim = this.mode.autopilotHeading();
        if (aim !== null) {
          const err = Math.atan2(Math.sin(aim - this.control.heading), Math.cos(aim - this.control.heading));
          input.steer = Math.max(-1, Math.min(1, -err * 2.5));
          input.throttle = true;
          input.boost = false;
          input.brake = false;
        }
      }
      this.control.update(p, input, this.heightAt);
      this.creditNearMisses(p); // close passes at speed earn boost
    }

    this.mode.fixedStep(FIXED_DT, this.state, this.simTime);

    // aftertouch — nudge the wreck mid-flight, camera-relative
    this.aftertouchActive = false;
    if ((this.state === GameState.Crash || this.state === GameState.Settle) && this.player?.crashed) {
      let ix = 0;
      let iz = 0;
      if (this.simKeys['ArrowUp']) iz += 1;
      if (this.simKeys['ArrowDown']) iz -= 1;
      if (this.simKeys['ArrowLeft']) ix -= 1;
      if (this.simKeys['ArrowRight']) ix += 1;
      if (ix || iz) {
        this.aftertouchActive = true;
        this.camera.getWorldDirection(_fwd);
        _fwd.y = 0;
        _fwd.normalize();
        _right.crossVectors(_fwd, UP);
        const fx = (_fwd.x * iz + _right.x * ix) * AFTERTOUCH_F;
        const fz = (_fwd.z * iz + _right.z * ix) * AFTERTOUCH_F;
        this.player.body.applyForce(_atF.set(fx, 0, fz)); // at COM = pure push
      }
    }
  }

  /** Burnout "Driving Skills" boost: passing other traffic CLOSE and FAST
   *  without hitting it credits a pulse of boost. A pass earns once — a body
   *  is eligible again only after the per-body cooldown lapses. Deterministic
   *  (reads sim positions/velocities, writes control boost state). */
  private creditNearMisses(p: Actor): void {
    if (this.state !== GameState.Launch) return; // only while actually driving
    const v = p.body.velocity;
    const sp = Math.hypot(v.x, v.z);
    if (sp < 18) return; // a near-miss only thrills at speed (the drift band)
    const fwdX = v.x / sp;
    const fwdZ = v.z / sp;
    const px = p.body.position.x;
    const pz = p.body.position.z;
    for (const a of this.actors) {
      if (a === p || a.kind !== 'vehicle' || a.crashed) continue;
      const dx = a.body.position.x - px;
      const dz = a.body.position.z - pz;
      const along = dx * fwdX + dz * fwdZ; // +ahead / −behind along our line
      const lat = Math.abs(dx * -fwdZ + dz * fwdX); // perpendicular gap
      // a close shave: alongside (small |along|), a lane's width to the side,
      // but not a scrape (lat>1.2 keeps actual contacts out)
      const near = lat > 1.2 && lat < 3.2 && Math.abs(along) < 6;
      const last = this.nearMissAt.get(a.body.id);
      if (near && along <= 0.5 && (last === undefined || this.simTime - last > 1.0)) {
        // a completed pass (now alongside/just behind): credit once. Closer +
        // faster = a bigger thrill = more boost (capped).
        this.nearMissAt.set(a.body.id, this.simTime);
        const strength = Math.min(1.6, (sp / 30) * (1 + (3.2 - lat) * 0.25));
        this.control.nearMiss(strength);
        this.events.emit('flash', 'NEAR MISS');
      }
    }
  }

  private updateFuses(dt: number): void {
    // Fuses fire only when a barrel/explosive's countdown lapses — vanishingly
    // rare per step. The actors snapshot exists solely so removeActor() can
    // splice mid-iteration; allocating it every step is pure GC churn. Scan
    // first (no allocation) and bail when nothing is live, so the snapshot is
    // taken only on steps that actually have a pending fuse. Iteration order
    // and processing are bit-identical to the old [...this.actors] loop — the
    // snapshot, when taken, is the same array in the same order.
    let anyFuse = false;
    for (const a of this.actors) {
      if (a.fuse !== null && !a.exploded) {
        anyFuse = true;
        break;
      }
    }
    if (!anyFuse) return;
    for (const a of this.actors.slice()) {
      if (a.fuse === null || a.exploded) continue;
      a.fuse -= dt;
      if (a.fuse > 0) continue;
      a.exploded = true;
      a.fuse = null;
      const p = new THREE.Vector3(a.body.position.x, a.body.position.y, a.body.position.z);
      if (a.kind === 'barrel') {
        p.y += 0.2;
        this.removeActor(a); // the barrel becomes the fireball
        this.explode(p, 1.0);
      } else {
        p.y += 1.2;
        charActor(a); // burnt-out husk stays in the pileup
        this.explode(p, a.spec?.explosive?.power ?? 2.2);
      }
    }
  }

  private processDeforms(): void {
    while (this.deformQueue.length) {
      const d = this.deformQueue.shift()!;
      deformActor(d.actor, d.p, d.strength, d.dir);
    }
  }

  private syncMeshes(dt: number): void {
    const night = this.timeOfDay !== 'day'; // golden hour runs lights too
    // brake LIGHT (presentation, not hashed): include the pad's held brake flag
    // so LT/B lights the lamps too. During a replay heldKeys is empty, so the
    // tape's brake lights still read off the recorded keys alone.
    const playerBrakes = !!(this.keys['ArrowDown'] || this.keys['KeyS'] || this.gamepad.heldKeys['ArrowDown']);
    for (const a of this.actors) {
      a.group.position.set(a.body.position.x, a.body.position.y, a.body.position.z);
      a.group.quaternion.set(a.body.quaternion.x, a.body.quaternion.y, a.body.quaternion.z, a.body.quaternion.w);
      const nl = a.nightLights;
      if (nl) {
        // streetlamps just follow the night — even lying on their side
        if (nl.lamp) nl.lamp.visible = night;
        if (nl.head && nl.brake) {
          // a wreck dims its lights to zero, it never leaves the render
          // list: the visible-light COUNT keys every shader program, so one
          // flip recompiles the whole scene (at night a pileup fired
          // multi-second recompile storms right before the tanker blew).
          // Day keeps visible=false — that path stays at zero light cost,
          // and the tod toggle's one-time churn rides the full relight.
          const alive = night && !a.crashed && !a.exploded;
          if ((nl.head.intensity > 0) !== alive) this.perf.tag(alive ? 'vlight-on' : 'vlight-off');
          nl.head.visible = night;
          nl.brake.visible = night;
          nl.head.intensity = alive ? HEADLIGHT_INTENSITY : 0;
          // brake detection: the player's actual brake input; traffic by
          // measured deceleration, latched briefly so it doesn't flicker
          const sp = Math.hypot(a.body.velocity.x, a.body.velocity.z);
          const decel = dt > 1e-4 ? (a.lastSpeed - sp) / dt : 0;
          a.lastSpeed = sp;
          if (alive && (a.isPlayer ? playerBrakes && sp > 0.5 : decel > 3 && sp > 0.3)) a.brakeT = 0.22;
          else a.brakeT = Math.max(0, a.brakeT - dt);
          // intensity, not visibility — light-list churn recompiles shaders
          nl.brake.intensity = a.brakeT > 0 ? BRAKE_INTENSITY : 0;
        }
      }
    }
    // weight-transfer lean is purely visual — the physics body stays level
    // so the suspension rays and collision box are unaffected
    if (this.player && !this.player.crashed) {
      _lean.set(this.control.visualPitch, 0, this.control.visualRoll);
      _leanQ.setFromEuler(_lean);
      this.player.group.quaternion.multiply(_leanQ);
    }
    for (const lp of this.looseParts) {
      lp.mesh.position.set(lp.body.position.x, lp.body.position.y, lp.body.position.z);
      lp.mesh.quaternion.set(lp.body.quaternion.x, lp.body.quaternion.y, lp.body.quaternion.z, lp.body.quaternion.w);
    }
  }

  // wheel meshes ride the suspension and spin with road speed
  private updateWheels(simDt: number): void {
    for (const a of this.actors) {
      if (a.kind !== 'vehicle' || !a.spec) continue;
      _wFwd.set(0, 0, -1).applyQuaternion(a.group.quaternion); // hull forward
      const v = a.body.velocity;
      const spin = ((v.x * _wFwd.x + v.z * _wFwd.z) / a.spec.wheelRadius) * simDt;
      const ride = a.spec.rideHeight;
      for (let i = 0; i < a.wheels.length; i++) {
        const wh = a.wheels[i];
        const s = a.susp[i];
        const d = Math.min(Math.max(s.dist, ride - SUSP_MAX_COMP), ride + 0.14);
        wh.position.y += (-(d - a.spec.wheelRadius) - wh.position.y) * Math.min(1, simDt * 16);
        wh.rotation.x -= spin;
      }
    }
  }

  // post-crash: the most battered wrecks smolder
  private updateBurning(dt: number): void {
    if (this.state !== GameState.Crash && this.state !== GameState.Settle && this.state !== GameState.Done) return;
    let emitters = 0;
    for (const a of this.actors) {
      if (a.kind !== 'vehicle' || a.damageLvl < 18 || emitters >= 3) continue;
      emitters++;
      a.smokeT -= dt;
      if (a.smokeT <= 0) {
        a.smokeT = 0.3 + Math.random() * 0.25;
        _hood.set(0, 0.7, -(a.spec ? a.spec.length * 0.3 : 1.4));
        this.fx.smoke.spawn(a.group.localToWorld(_hood.clone()), { dark: true });
        if (Math.random() < 0.35) this.audio.crackle(a.group.position);
      }
    }
  }

  private updateHud(dt: number): void {
    this.mode.score?.update(dt);
    // segmented boost meter (B3 1x→4x): fill across the whole extended bar,
    // plus the segment count and Burnout state for the HUD to draw.
    const c = this.control;
    const fillPct = Math.round((c.boostMeter / c.boostCap) * 100);
    // dedup on a packed signature so we only emit when something visible
    // changes (fill %, segment count, or Burnout flag)
    const sig = fillPct + c.boostSegments * 1000 + (c.burnout ? 100000 : 0);
    if (sig !== this.lastEmittedBoost) {
      this.lastEmittedBoost = sig;
      this.events.emit('boost', {
        fill: fillPct / 100,
        segments: c.boostSegments,
        maxSegments: BOOST_MAX_SEGMENTS,
        burnout: c.burnout,
        chain: c.burnoutChain,
      });
    }
  }

  private skidSmokeT = 0;

  // rubber + tyre smoke off the rear wheels while drifting
  private updateSkid(simDt: number): void {
    const p = this.player;
    if (!p || p.crashed || !p.spec || !this.control.drifting || !p.susp.some((s) => s.grounded)) {
      this.fx.skid.lift();
      return;
    }
    _skidL.set(-p.spec.wheelX, -(p.spec.rideHeight - 0.02), p.spec.wheelZRear);
    _skidR.set(p.spec.wheelX, -(p.spec.rideHeight - 0.02), p.spec.wheelZRear);
    p.group.localToWorld(_skidL);
    p.group.localToWorld(_skidR);
    this.fx.skid.stamp(_skidL, _skidR);
    this.skidSmokeT -= simDt;
    if (this.skidSmokeT <= 0) {
      this.skidSmokeT = 0.12;
      this.fx.smoke.spawn(Math.random() < 0.5 ? _skidL : _skidR, {});
    }
  }

  // boost flames out of the exhaust while burning
  private updateBoostFlames(): void {
    const p = this.player;
    if (!p || p.crashed || this.state !== GameState.Launch || !this.control.boosting) return;
    _hood.set(0.35 * (Math.random() < 0.5 ? 1 : -1), 0.1, (p.spec ? p.spec.length / 2 : 2.3) + 0.15);
    this.fx.sparks.spawn(p.group.localToWorld(_hood.clone()), 4, 3.5);
  }

  // ---------- bug reports & replay ----------

  /** R key (or dev console): serialize the take so far into a downloadable
   *  JSON report that reproduces it exactly — see replay.ts. Saves instantly,
   *  no dialog: window.prompt() THROWS in Electron-style shells (and blocks
   *  the game everywhere else) — pass a note from the console if you want one.
   *  The file also lands on window.__lastReport and (best-effort) the
   *  clipboard, for shells that quietly swallow programmatic downloads. */
  captureReport(note = ''): ReplayFile {
    const file = this.recorder.export(note, this.buildSnapshot());
    (window as unknown as { __lastReport?: ReplayFile }).__lastReport = file;
    try {
      downloadReplay(file);
    } catch (err) {
      console.error('[crash-junction] report download failed — grab window.__lastReport instead', err);
    }
    try {
      navigator.clipboard?.writeText(JSON.stringify(file)).catch(() => {});
    } catch {
      // clipboard is a nice-to-have; the download + __lastReport remain
    }
    console.log('[crash-junction] physics report captured:', file);
    this.events.emit('flash', 'REPORT SAVED');
    return file;
  }

  /** Drive the sim from a recorded take (drag a report onto the page, or
   *  ?replay=<url>). fast = no real-time pacing, for automated verification
   *  (?verify=1) — the result lands in window.__replayResult either way. */
  startReplay(file: ReplayFile, fast = false): void {
    if (file.levelId !== this.levelId) throw new Error(`replay is for level '${file.levelId}', loaded '${this.levelId}'`);
    this.replay = {
      file, frame: 0, cmdIdx: 0, sumIdx: 0, hiddenSet: new Set(file.hidden), fast, checked: 0, diverged: null,
      lastTakedownAt: -999,
      stats: {
        maxAltitude: 0, maxUpwardSpeed: 0, maxTiltDeg: 0,
        takedowns: 0, takedownToPlayerCrashMin: 999, finalOffTrack: 0,
        playerSlams: 0, rivalShunts: 0, playerWrecks: 0, playerPopped: 0,
        rivalWallHits: 0,
      },
    };
    this.pendingCmds.length = 0;
    this.keys = {};
    this.simKeys = {};
    this.gamepad.reset(); // drop any held pad flags so the tape drives input alone
    this.reset(); // beginTake() sees this.replay: recorded seed, recorder disarmed
    this.events.emit('replay', true);
    this.events.emit('flash', fast ? 'VERIFYING REPLAY' : 'REPLAY');
  }

  private playReplayFrame(): boolean {
    const r = this.replay!;
    const f = r.frame;
    if (f >= r.file.dts.length) {
      this.stopReplay(false);
      return false;
    }
    r.frame++;
    this.keys = keysFromMask(r.file.keyMasks[f]);
    this.simKeys = this.keys; // nothing mutates keys mid-frame during a replay
    let cmds: Command[] = NO_CMDS;
    while (r.cmdIdx < r.file.commands.length && r.file.commands[r.cmdIdx].f === f) {
      if (cmds === NO_CMDS) cmds = [];
      cmds.push(r.file.commands[r.cmdIdx++].c);
    }
    this.advance(r.file.dts[f], r.hiddenSet.has(f), cmds);
    return true;
  }

  private stopReplay(aborted: boolean): void {
    const r = this.replay;
    if (!r) return;
    r.stats.finalOffTrack = +this.mode.playerOffTrackDistance().toFixed(1);
    this.replay = null;
    this.keys = {};
    this.simKeys = {};
    const result: ReplayResult = {
      ok: !aborted && !r.diverged,
      aborted,
      framesPlayed: r.frame,
      framesTotal: r.file.dts.length,
      checksumsChecked: r.checked,
      diverged: r.diverged,
      stats: r.stats,
    };
    (window as unknown as { __replayResult?: ReplayResult }).__replayResult = result;
    if (r.fast) document.title = result.ok ? 'REPLAY-OK' : 'REPLAY-FAIL'; // scrapeable verdict
    console.log('[replay] finished:', result);
    this.events.emit('replay', false);
    this.events.emit('flash', aborted ? 'REPLAY STOPPED' : result.ok ? 'REPLAY VERIFIED' : 'REPLAY DIVERGED');
  }

  /** World state at report time — a diagnosis target that needs no replay. */
  private buildSnapshot(): Snapshot {
    return {
      state: this.state,
      simTime: this.simTime,
      step: this.stepIndex,
      timeScale: this.timeScale,
      accumulator: this.accumulator,
      control: {
        heading: this.control.heading, velAngle: this.control.velAngle, speed: this.control.speed,
        drifting: this.control.drifting, boostMeter: this.control.boostMeter,
      },
      actors: this.actors.map((a) => ({
        kind: a.kind, variant: a.spec?.variant ?? null, isPlayer: a.isPlayer, crashed: a.crashed,
        destabilized: a.destabilized, damageLvl: a.damageLvl, popped: a.popped,
        exploded: a.exploded, fuse: a.fuse, body: bodySnap(a.body),
      })),
      looseParts: this.looseParts.map((lp) => bodySnap(lp.body)),
    };
  }

  /** Track the player's physics-sanity envelope while a tape plays. */
  private updateReplayStats(): void {
    const p = this.player;
    const r = this.replay;
    if (!p || !r) return;
    const b = p.body;
    const alt = b.position.y - this.heightAt(b.position.x, b.position.z);
    if (alt > r.stats.maxAltitude) r.stats.maxAltitude = alt;
    if (b.velocity.y > r.stats.maxUpwardSpeed) r.stats.maxUpwardSpeed = b.velocity.y;
    // body-up vs world-up: uy = 1 - 2(qx² + qz²) is the rotated Y axis' y
    const uy = 1 - 2 * (b.quaternion.x * b.quaternion.x + b.quaternion.z * b.quaternion.z);
    const tilt = (Math.acos(Math.max(-1, Math.min(1, uy))) * 180) / Math.PI;
    if (tilt > r.stats.maxTiltDeg) r.stats.maxTiltDeg = tilt;
    if (!p.crashed && p.popped > r.stats.playerPopped) r.stats.playerPopped = p.popped;
  }

  /** Record (live) or verify (replay) the world hash at checksum cadence. */
  private onChecksumStep(): void {
    const { h, bodies } = worldHash(this.actors, this.looseParts);
    const r = this.replay;
    if (!r) {
      this.recorder.checksum(this.stepIndex, h, bodies);
      return;
    }
    while (r.sumIdx < r.file.checksums.length && r.file.checksums[r.sumIdx].s < this.stepIndex) r.sumIdx++;
    const rec = r.file.checksums[r.sumIdx];
    if (rec && rec.s === this.stepIndex) {
      r.sumIdx++;
      r.checked++;
      if (rec.h !== h && !r.diverged) {
        // name the first body whose hash strayed — diagnosis gold
        let body: Divergence['body'] = null;
        const n = Math.max(rec.b?.length ?? 0, bodies.length);
        for (let i = 0; i < n; i++) {
          if (rec.b?.[i] !== bodies[i]) {
            const a = this.actors[i];
            const desc = a
              ? `${a.kind}${a.spec ? ':' + a.spec.variant : ''}${a.isPlayer ? ' (player)' : ''}`
              : `loosePart[${i - this.actors.length}]`;
            body = { index: i, desc, expected: rec.b?.[i] ?? null, actual: bodies[i] ?? null };
            break;
          }
        }
        r.diverged = { step: this.stepIndex, expected: rec.h, actual: h, body };
        console.warn(`[replay] diverged at step ${this.stepIndex} (t=${this.simTime.toFixed(2)}s)`, body);
      }
    }
  }

  // ---------- main loop ----------

  /** One recorded-frame's worth of game time. Everything in here sees only
   *  (dt, hidden, cmds) plus the key bitmask already in this.keys — exactly
   *  the tuple the recorder captures per frame — so feeding a recorded tuple
   *  back through reproduces the sim bit-for-bit. The scene-graph updates at
   *  the bottom are here because they feed back into physics: detached
   *  panels/wheels spawn from mesh world transforms, pickups gate the score
   *  multiplier. Camera, audio and rendering live in frame(). */
  private advance(dt: number, hidden: boolean, cmds: readonly Command[]): void {
    this.clock += dt;
    for (const c of cmds) this.execCommand(c);
    this.updateTimeScale(dt);
    const simDt = dt * this.timeScale;
    this.accumulator += simDt;
    let steps = 0;
    const maxSteps = hidden ? 160 : 8;
    while (this.accumulator >= FIXED_DT && steps < maxSteps) {
      this.stepControls();
      applySuspension(this.actors, this.state, this.heightAt);
      // live chassis can only gain upward speed at suspension rates — the
      // ground-plane contact solver would otherwise pole-vault a landing
      // car off its box corner (the controller keeps restoring horizontal
      // velocity, so that lever arm has an infinite energy budget). Décor
      // stays excluded, so ramp jumps remain pure suspension + ballistics.
      for (let i = 0; i < this.actors.length; i++) {
        const a = this.actors[i];
        this.vyBefore[i] = a.kind === 'vehicle' && !a.crashed ? a.body.velocity.y : Infinity;
      }
      this.phys.world.step(FIXED_DT);
      for (let i = 0; i < this.actors.length; i++) {
        const a = this.actors[i];
        if (a.crashed) continue; // wrecked mid-step — the collision fling is the point
        const cap = this.vyBefore[i] + LIVE_VY_GAIN_PER_STEP;
        if (a.body.velocity.y > cap) a.body.velocity.y = cap;
        // absolute roof: a DRIVEN car never rises faster than the biggest
        // designed launch — bounds anything not caught above (e.g. grinding
        // a barrier at forced speed slowly pole-vaults off its top edge)
        if (a.body.velocity.y > RAMP_LAUNCH_VY_MAX) a.body.velocity.y = RAMP_LAUNCH_VY_MAX;
      }
      // a LIVE car in solver contact with ANYTHING stays planted. Designed
      // jumps come from the suspension ground-follow — live chassis don't
      // even collide with ramps (décor-filtered) — so every upward kick a
      // contact equation produces is an artifact: climbing a rival's
      // bodywork (or the wreck it just became, or a shed panel), and the
      // wall-top box-corner pole-vault the old per-step budget only
      // bounded. A 48 m/s rammer rode all three 6 m over the barrier.
      // Crashed cars are exempt (flings belong to wrecks — a junction
      // player plowing into a pileup is wrecked by the judgment before
      // the fling); batted poles/barrels aren't vehicles and still fly.
      _contactIds.clear();
      for (const c of this.phys.world.contacts) {
        _contactIds.add(c.bi.id);
        _contactIds.add(c.bj.id);
      }
      for (const a of this.actors) {
        if (a.kind !== 'vehicle' || a.crashed || !_contactIds.has(a.body.id)) continue;
        if (a.body.velocity.y > LIVE_CAR_CONTACT_VY) a.body.velocity.y = LIVE_CAR_CONTACT_VY;
      }
      this.updateFuses(FIXED_DT);
      this.simTime += FIXED_DT;
      this.accumulator -= FIXED_DT;
      this.stepIndex++;
      if (this.stepIndex % CHECKSUM_EVERY === 0) this.onChecksumStep();
      if (this.replay) this.updateReplayStats();
      this.onStep?.(this);
      steps++;
    }

    this.syncMeshes(simDt);
    this.updateWheels(simDt);
    updatePanelFlap(this.actors, simDt);
    this.processDeforms();
    if (this.player) _pp.set(this.player.body.position.x, this.player.body.position.y, this.player.body.position.z);
    this.pickups.update(simDt, this.simTime, this.player ? _pp : null, (m, pos) => this.collectMultiplier(m, pos));
    this.updateSkid(simDt);
    this.fx.update(simDt);
    this.updateBurning(simDt);
    this.updateBoostFlames();
    this.updateHud(dt);
    // the camera is part of the deterministic domain, not presentation:
    // aftertouch pushes the wreck along camera-relative axes, so the
    // director must see the recorded dts (and the take-local clock)
    this.director.update(
      dt,
      this.clock,
      this.camera,
      this.state,
      this.player,
      this.control.boosting,
      this.control.drifting,
      this.aftertouchActive,
      this.takedownCamT > 0 && this.takedownVictim ? this.takedownVictim.group.position : null,
    );
    // peripheral wind streaks (sense-of-speed A3), after the director so
    // they track THIS frame's camera. Presentation only: reads the camera
    // and controller speed, rolls Math.random, writes nothing the sim or
    // worldHash can see — replays and both pins are untouched.
    // CINE supplies the real per-pixel motion blur (postfx.ts), so the streaks
    // — the cheap radial-blur stand-in — stay gated OFF whenever it's active
    // (both at once would double-count the speed cue). The game always renders
    // CINE now, so in real play this passes speed 0 and the streaks never spawn;
    // they only light up under the headless/FAST bypass. The pool is still
    // walked every frame (speed 0) so any live streaks fade out, never freeze.
    this.fx.streaks.frame(
      simDt,
      this.camera,
      !this.cineActive() && this.state === GameState.Launch && this.player && !this.player.crashed
        ? this.control.speed
        : 0,
      this.control.boosting,
    );
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.schedule();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.perf.beginFrame();
    const tSim = performance.now();

    if (this.replay) {
      // pace the tape 1:1 with its recorded dts via the rAF cadence; fast
      // mode instead chews through a work-budget per tick (sized so verify
      // still finishes quickly in a timer-throttled hidden tab)
      const deadline = performance.now() + 25;
      do {
        if (!this.playReplayFrame()) break;
      } while (this.replay?.fast && performance.now() < deadline);
    } else {
      // hidden tabs throttle timers to ~1 Hz — integrate the elapsed second
      // in one go there, so background time still passes at real speed
      const hidden = document.hidden;
      const dt = Math.min(elapsed, hidden ? 1.2 : 0.05);
      // CONTROLLER: poll the pad for THIS live frame, BEFORE we drain pendingCmds
      // and sample the mask. Discrete pad presses queue commands (launch/cb/
      // explode) that join this frame's cmds; held flags (steer/accel/boost/
      // brake) get OR'd into the keyboard mask below. With no pad connected this
      // is a no-op (no intents, no held flags) so the keyboard mask — and both
      // determinism pins — are byte-identical. Never polled during a replay.
      const padIntents = this.gamepad.poll({ idle: this.state === GameState.Idle });
      if (this.gamepad.isConnected()) {
        // any pad input is a user gesture — unlock/resume audio (a pad-only
        // player never produces the keydown/pointerdown that normally does this)
        this.audio.init();
        this.audio.resume();
        for (const it of padIntents) this.dispatchGamepadIntent(it);
      }
      const cmds = this.pendingCmds.length ? this.pendingCmds.splice(0) : NO_CMDS;
      // OR the pad's synthetic held-key flags into the keyboard bitmask: pad
      // steer/accel/boost/brake flow through the EXACT recorded key path, fully
      // interchangeable with the keyboard and replay-deterministic by construction.
      const mask = maskFromKeys(this.keys) | maskFromKeys(this.gamepad.heldKeys);
      this.recorder.frame(dt, mask, hidden, cmds);
      this.simKeys = keysFromMask(mask);
      this.advance(dt, hidden, cmds);
    }
    this.perf.simMs = performance.now() - tSim;

    // audio: one sim readout per rendered frame — engine/skid/boost/wind
    // loops, the slow-mo warp, landing thumps and near-miss whooshes all
    // hang off it. Presentation only: reads state, never writes back.
    const p = this.player;
    const af = this.audioFrame;
    af.dt = Math.min(elapsed, 0.1);
    af.timeScale = this.timeScale;
    af.driving = this.state === GameState.Launch && !!p && !p.crashed;
    af.speed = this.control.speed;
    // engine/skid audio reads the held controls (presentation only — never
    // feeds back into the sim, so the pad OR here can't move a pin); the pad's
    // held flags are all-false during a replay, so the tape's audio is unchanged
    const hg = this.gamepad.heldKeys;
    af.throttle = !!(this.keys['ArrowUp'] || this.keys['KeyW'] || hg['ArrowUp']);
    af.boosting = this.control.boosting;
    af.drifting = this.control.drifting;
    const slipA = this.control.heading - this.control.velAngle;
    const slip = Math.abs(Math.atan2(Math.sin(slipA), Math.cos(slipA))) / 0.7; // 0.7 rad ≈ the 40° drift cap
    af.slip = this.control.drifting
      ? Math.min(1, slip)
      : (this.keys['ArrowDown'] || this.keys['KeyS'] || hg['ArrowDown']) && this.control.speed > 15
        ? 0.3 // hard braking at speed chirps the tyres
        : 0;
    af.grounded = !p || p.crashed || p.susp.some((s) => s.grounded);
    af.vy = p ? p.body.velocity.y : 0;
    af.player = p;
    this.audio.frame(af);

    // presentation pixels only from here down — the sim never reads back
    this.sea?.update(af.dt); // animate the waves off RENDER time (pin-safe)
    this.grass?.update(af.dt, this.camera.position); // sway + distance-cull off RENDER time (pin-safe)
    this.skyClock += af.dt; // scroll the baked cloud lookup off RENDER time (pin-safe)
    this.skyRig.setCloudTime(this.skyClock);
    // Clouds are PRERENDERED once per time-of-day into a high-res equirect
    // panorama (skyRig.cloudBake, in setTimeOfDay) — the dome just samples it by
    // view direction each frame (a texture fetch, no raymarch). setCloudTime above
    // slowly scrolls that lookup for a cheap sense of motion. Presentation-only,
    // RENDER-time driven — pin-safe, same contract as the sea/grass drift above.
    this.updateShadowRig();
    this.sunFlare.update(this.camera, this.sunSprite.position, af.dt, this.sunSprite.visible, () => this.flareOccluded());
    if (this.cineActive()) {
      this.renderFrame++;
      // PERF (perf-harbor): the live cube reflection is the single biggest
      // per-frame cost in the dockyard — it re-renders the WHOLE scene into 6
      // cube faces, so at ~388 scene draws that is ~2300 draws a frame, and
      // each face pays the full DUSK/NIGHT light set (19 lights vs 5 by day),
      // which is exactly why the harbor lags hardest after dark. The capture is
      // a STREAKY CLEARCOAT reflection, not a mirror — refreshing it every
      // other render frame is indistinguishable on a moving car (the render
      // target persists, so the off frame reuses last capture) and halves the
      // cube cost. Standard reflection-probe throttling; pure presentation —
      // the counter and the gate live below the sim's read-back line, so
      // determinism is untouched. (cubeEvery is tunable via setCubeEvery — drop
      // to 1 for an every-frame capture.)
      if (p && this.renderFrame % this.cubeEvery === 0) {
        // the world sweeps through the player's paint: re-capture the cube
        // map (the car must not reflect itself; the flare is screen dressing)
        const tCube = performance.now();
        this.reflections.update(this.renderer, this.scene, p.group.position, [p.group, this.sunFlare.group]);
        this.perf.cubeMs = performance.now() - tCube;
      }
      const tPost = performance.now();
      this.postfx.render(af.dt);
      this.perf.postMs = performance.now() - tPost;
    } else {
      const tPost = performance.now();
      this.renderer.render(this.scene, this.camera);
      this.perf.postMs = performance.now() - tPost;
    }
    this.perf.endFrame(elapsed * 1000);
  };

  /** Lag-spike tracker readout (see perf.ts): the frame ring, the rolling
   *  median and every captured spike report. window.__lagSpikes holds the
   *  same spike list live. */
  perfReport(): PerfReport {
    return this.perf.report();
  }

  /** Debug/profiling knob (perf-harbor): how often the live player cube
   *  reflection re-captures the scene — 1 = every render frame, 2 = every
   *  other (the ship default), etc. Pure presentation; the harbor-probe flips
   *  it to A/B the reflection-throttle win. Clamped to ≥ 1. */
  setCubeEvery(n: number): void {
    this.cubeEvery = Math.max(1, Math.floor(n));
  }

  /** One physics ray camera → sun: is something chunky in the way? The
   *  player's own body is ignored — at dusk the sun sits dead ahead and the
   *  chase ray passes straight through the chassis box. */
  private flareOccluded(): boolean {
    this.flareFrom.set(this.camera.position.x, this.camera.position.y, this.camera.position.z);
    this.flareTo.set(this.sunSprite.position.x, this.sunSprite.position.y, this.sunSprite.position.z);
    let hit = false;
    this.phys.world.raycastAll(
      this.flareFrom,
      this.flareTo,
      { skipBackfaces: true, collisionFilterMask: ~GROUP_DECOR },
      (result) => {
        if (result.body !== this.player?.body) {
          hit = true;
          result.abort();
        }
      },
    );
    return hit;
  }
}
