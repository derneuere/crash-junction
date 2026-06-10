import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  AFTERTOUCH_F,
  CB_PER_WRECK,
  CRASHBREAKER_POWER,
  EXPLOSION_KICK,
  EXPLOSION_RADIUS_BASE,
  EXPLOSION_RADIUS_PER_POWER,
  FIXED_DT,
  SLOWMO,
  SLOWMO_HOLD,
  SUSP_MAX_COMP,
} from './constants';
import { GameState, type Actor, type CollideEvent, type GameEvents, type LevelDef, type Medal } from './types';
import { Emitter } from './emitter';
import { createPhysics, type PhysicsContext } from './physics';
import { buildEnvironment, makeHeightSampler } from './environment';
import { charActor, createBarrel, createPole, createVehicle, deformActor, popWheel, type LoosePart } from './vehicles';
import { accumulatePanelDamage, makePanelBody, updatePanelFlap } from './panels';
import type { PanelState } from './types';
import { applySuspension, type HeightSampler } from './suspension';
import { updateTraffic } from './traffic';
import { PlayerControl, BOOST_CAP } from './control';
import { RaceDirector } from './race';
import { Pickups } from './pickups';
import { Effects } from './effects';
import { GameAudio } from './audio';
import { CameraDirector } from './camera';

interface DeformJob {
  actor: Actor;
  p: THREE.Vector3;
  strength: number;
}

const _impact = new THREE.Vector3();
const _panelPos = new THREE.Vector3();
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

export class Game {
  readonly events = new Emitter<GameEvents>();

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private phys: PhysicsContext;
  private fx: Effects;
  private audio = new GameAudio();
  private director = new CameraDirector();
  private heightAt: HeightSampler;

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
  private accumulator = 0;
  private damage = 0;
  private displayedDamage = 0;
  private lastEmittedDamage = -1;
  private cbCharge = 0; // crashbreaker meter 0..1 — earned by wrecking cars
  private multiplier = 1;
  private pickups: Pickups;
  private control = new PlayerControl();
  private race: RaceDirector | null = null;
  private lastEmittedBoost = -1;
  private cashId = 0;

  private deformQueue: DeformJob[] = [];
  private pairCooldown = new Map<string, number>();
  private checked = new Map<number, number>(); // bodyId → simTime of the shunt
  private keys: Record<string, boolean> = {};

  private raf = 0;
  private rafIsTimeout = false;
  private last = performance.now();
  private disposed = false;
  private resizeObserver: ResizeObserver;

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

    this.scene.background = new THREE.Color(0xb6cde6);
    this.scene.fog = new THREE.Fog(0xb6cde6, 55, 150);

    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 400);
    this.camera.position.set(24, 11, 24);

    const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x4a4036, 1.45);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0dd, 2.2);
    sun.position.set(34, 44, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    sun.shadow.camera.far = 120;
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);

    this.heightAt = makeHeightSampler(level);
    this.phys = createPhysics();
    buildEnvironment(this.scene, this.phys, level);
    this.fx = new Effects(this.scene);
    this.pickups = new Pickups(this.scene, level.pickups);
    this.control.reset(Math.atan2(level.player.dir.x, level.player.dir.z));
    this.buildActors();

    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    container.addEventListener('pointerdown', this.onPointerDown);
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);

    this.schedule();

    // dev console handle: window.__game.explode(...), inspect state, etc.
    (window as unknown as { __game: Game }).__game = this;
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

  /** Detonate at a world position. power ≈ 1 is a barrel, ~2.4 a tanker. */
  explode(p: THREE.Vector3, power: number): void {
    this.fx.explosion.spawn(p, power);
    this.fx.sparks.spawn(p, 70, 8 + 5 * power);
    this.fx.debris.spawn(p, 14 + Math.round(6 * power), 9 * power);
    this.fx.scorch.add(p.x, p.z, 1.4 + 0.8 * power);
    this.audio.boom(power, this.timeScale);
    this.director.addShake(0.7 + 0.4 * power);
    this.director.focusTarget.copy(p);

    const R = EXPLOSION_RADIUS_BASE + EXPLOSION_RADIUS_PER_POWER * power;
    let payout = 1500 * power * this.multiplier; // one-shot per detonation

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
        new CANNON.Vec3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.8),
      );
      return fall;
    };

    for (const a of this.actors) {
      const massScale = Math.min(1, Math.max(0.35, 1100 / a.body.mass));
      const fall = kick(a.body, massScale);
      if (fall <= 0) continue;
      if (a.kind === 'vehicle') {
        if (!(a.isPlayer && this.level.practice)) this.markCrashed(a); // practice: blasted, not wrecked
        a.damageLvl += 12 * power * fall;
        this.deformQueue.push({ actor: a, p: p.clone(), strength: (6 + 7 * power) * fall });
        accumulatePanelDamage(a, p, (6 + 7 * power) * fall, this.detachPanel);
        if (fall > 0.55 && a.popped < 3 && Math.random() < 0.5) this.popLooseWheel(a, p);
        payout += this.drawCash(a, 950 * power * fall * a.valueMult * this.multiplier);
        if (a.spec?.explosive && !a.exploded && a.fuse === null && fall > 0.2) a.fuse = 0.25 + Math.random() * 0.2;
      } else if (a.kind === 'barrel' && !a.exploded && a.fuse === null) {
        // chain reaction: farther barrels pop later — the JC2 ripple
        a.fuse = 0.08 + (R - R * fall) * 0.05 + Math.random() * 0.15;
      }
    }
    for (const lp of this.looseParts) kick(lp.body, 1);

    this.damage += payout;
    this.emitCashAt(p, '+$' + Math.round(payout).toLocaleString('en-US'));

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
    this.deformQueue.length = 0;

    this.damage = 0;
    this.displayedDamage = 0;
    this.lastEmittedDamage = -1;
    this.timeScale = 1;
    this.slowTimer = 0;
    this.settleTimer = 0;
    this.crashElapsed = 0;
    this.simTime = 0;
    this.accumulator = 0;
    this.cbCharge = 0;
    this.multiplier = 1;
    this.pickups.reset();
    this.control.reset(Math.atan2(this.level.player.dir.x, this.level.player.dir.z));
    this.director.reset();
    this.state = GameState.Idle;
    this.buildActors();
    this.events.emit('state', this.state);
    this.events.emit('damage', 0);
    this.events.emit('crashbreaker', 0);
    this.events.emit('multiplier', 1);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafIsTimeout) clearTimeout(this.raf);
    else cancelAnimationFrame(this.raf);
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // dispose() alone leaks the WebGL
    // context; repeated HMR remounts would hit the browser's context cap
    this.renderer.domElement.remove();
    this.events.clear();
  }

  // ---------- setup ----------

  private buildActors(): void {
    const onCollide = (a: Actor, e: CollideEvent) => this.onCollide(a, e);
    this.player = createVehicle(this.scene, this.phys, onCollide, this.level.player, true);
    this.register(this.player);
    for (const spawn of this.level.traffic) this.register(createVehicle(this.scene, this.phys, onCollide, spawn, false));
    for (const p of this.level.poles) this.register(createPole(this.scene, this.phys, onCollide, p.x, p.z));
    for (const b of this.level.barrels) this.register(createBarrel(this.scene, this.phys, onCollide, b.x, b.z));

    if (this.level.race) {
      const rivals = this.level.race.rivals.map((r) => {
        const a = createVehicle(
          this.scene,
          this.phys,
          onCollide,
          { variant: 'sedan', color: r.color, x: 0, z: 0, dir: { x: 0, z: 1 }, speed: 0 },
          false,
        );
        a.scripted = null; // rivals are driven by the RaceDirector, not traffic AI
        a.body.allowSleep = false; // a dozing racer ignores velocity writes
        a.body.wakeUp();
        this.register(a);
        return { actor: a, skill: r.skill };
      });
      this.race = new RaceDirector(this.level.race, this.player, rivals, this.events, (pos) => this.finishRace(pos));
    } else {
      this.race = null;
    }
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
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    this.keys[e.code] = true;
    this.audio.init();
    this.audio.resume();
    if (e.code === 'Space') this.launch();
    if (e.code === 'KeyR') this.reset();
    if (e.code === 'KeyE') this.tryCrashbreaker();
    if (e.code === 'KeyB') {
      // sandbox firework: drop a test explosion near the junction center
      this.explode(new THREE.Vector3((Math.random() - 0.5) * 8, 0.6, (Math.random() - 0.5) * 8), 1.2);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys[e.code] = false;
  };

  private onPointerDown = (): void => {
    this.audio.init();
    this.audio.resume();
    if (this.state === GameState.Idle) this.launch();
    else if (this.state === GameState.Done) this.reset();
  };

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private tryCrashbreaker(): void {
    if (this.race) return; // no crashbreakers in a race, Burnout-style
    if (this.state !== GameState.Crash && this.state !== GameState.Settle) return;
    if (!this.player?.crashed || this.cbCharge < 1) return;
    this.cbCharge = 0; // spent — wreck more cars to charge it again
    this.events.emit('crashbreaker', 0);
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

    if (impact > 2.2 && !scenery) {
      const oa = this.byBody.get(other.id);
      // Burnout crash rules (burnout wiki: Takedown / Traffic Check / Wreck):
      // ramming a same-direction lighter vehicle is a SHUNT — they wreck,
      // you power through and the boost bar refills. Walls, oncoming
      // traffic and heavies wreck YOU. Poles and barrels are smashables —
      // they get batted aside and never trigger the crash sequence.
      const wall = !oa; // static non-scenery body = building
      if (self.isPlayer && !self.crashed && !this.level.practice && (oa?.kind === 'vehicle' || wall)) {
        let crashes = wall && impact > 5;
        if (oa?.kind === 'vehicle') {
          const v = self.body.velocity;
          const sp = Math.hypot(v.x, v.z);
          const ov = oa.body.velocity;
          const osp = Math.hypot(ov.x, ov.z);
          // their direction of travel — facing, if they're sitting still
          const odx = osp > 3 ? ov.x / osp : (oa.scripted?.dir.x ?? 0);
          const odz = osp > 3 ? ov.z / osp : (oa.scripted?.dir.z ?? 0);
          const align = sp > 2 ? ((v.x / sp) * odx + (v.z / sp) * odz) : 1;
          const heavy = (oa.spec?.mass ?? 0) > (self.spec?.mass ?? 1) * 1.6;
          // a car we just shunted is still tumbling clear — Revenge launches
          // the checked car harmlessly, so it can't wreck us for a beat
          const graced = this.simTime - (this.checked.get(oa.body.id) ?? -9) < 1.2;
          if ((align > 0.35 && !heavy) || graced) {
            // shunt takedown: no crash for the player
            if (impact > 4 && !oa.crashed) {
              this.checked.set(oa.body.id, this.simTime);
              this.events.emit('flash', 'TAKEDOWN');
              this.control.boostMeter = BOOST_CAP; // shunts steal their boost
              const bonus = this.drawCash(oa, 2500 * oa.valueMult * this.multiplier);
              if (bonus > 0) {
                this.damage += bonus;
                _impact.set(oa.body.position.x, oa.body.position.y + 1, oa.body.position.z);
                this.emitCashAt(_impact, '+$' + Math.round(bonus).toLocaleString('en-US'));
              }
            }
          } else if (align < -0.35 && osp > 3) {
            crashes = impact > 5; // head-on with oncoming
          } else if (heavy) {
            crashes = impact > 5; // the bus always wins
          } else {
            crashes = impact > 6.5; // T-boned by crossing traffic
          }
        }
        if (crashes) {
          this.markCrashed(self);
          if (this.state === GameState.Launch) this.enterCrashTime();
        }
      }
      // traffic only wrecks from player-made chaos: the player itself, an
      // existing wreck, or a prop sent flying by a blast — never from its
      // own driving
      const selfDangerous =
        self.isPlayer || self.crashed || (self.kind !== 'vehicle' && self.body.velocity.length() > 5);
      if (selfDangerous && oa && oa.kind === 'vehicle' && !oa.isPlayer && impact > 4) this.markCrashed(oa);
      if (!self.isPlayer && self.kind === 'vehicle' && oa && (oa.isPlayer || oa.crashed) && impact > 4) {
        this.markCrashed(self);
      }
    }
    if (self.kind === 'barrel' && impact > 4.5 && !self.exploded && self.fuse === null) self.fuse = 0.06;
    if (self.spec?.explosive && impact > 9.5 && !self.exploded && self.fuse === null) self.fuse = 0.18;

    if (impact < 1.4 || this.state === GameState.Idle) return;

    const key = `${self.body.id}>${other.id}`;
    if (this.simTime - (this.pairCooldown.get(key) ?? -1) < 0.12) return;
    this.pairCooldown.set(key, this.simTime);

    // world contact point
    const c = e.contact;
    let px: number, py: number, pz: number;
    if (c.bi === self.body) {
      px = c.bi.position.x + c.ri.x;
      py = c.bi.position.y + c.ri.y;
      pz = c.bi.position.z + c.ri.z;
    } else {
      px = c.bj.position.x + c.rj.x;
      py = c.bj.position.y + c.rj.y;
      pz = c.bj.position.z + c.rj.z;
    }
    const p = _impact.set(px, py, pz);

    // cash money — drawn from this actor's finite damage budget, so a car
    // (or a wreck grinding the road) can only ever pay out its full value
    const dmg = this.drawCash(
      self,
      impact * (scenery ? 80 : 135) * (0.85 + Math.random() * 0.3) * self.valueMult * this.multiplier,
    );
    this.damage += dmg;
    if (dmg > 800 && (scenery || self.body.id < other.id)) {
      this.emitCashAt(p, '+$' + Math.round(dmg).toLocaleString('en-US'));
    }

    // effects
    this.fx.sparks.spawn(p, Math.min(40, Math.round(impact * 5)), impact * 0.55);
    if (impact > 4.2 && self.deformables.length) {
      this.deformQueue.push({ actor: self, p: p.clone(), strength: impact });
      accumulatePanelDamage(self, p, impact, this.detachPanel);
      self.damageLvl += impact;
      if (self.spec?.explosive && self.damageLvl > self.spec.explosive.fuseDamage && !self.exploded && self.fuse === null) {
        self.fuse = 0.3;
      }
    }
    if (impact > 6 && !scenery) this.fx.debris.spawn(p, 4 + Math.round(impact * 0.8), impact);
    if (impact > 8) {
      this.fx.smoke.spawn(p, { big: true });
      this.fx.smoke.spawn(p, {});
    }
    if (impact > 9 && py < 1.6) this.fx.scorch.add(px, pz);
    if (impact > 9.5 && self.kind === 'vehicle' && self.popped < 3 && Math.random() < 0.75) this.popLooseWheel(self, p);

    this.audio.thump(impact, this.timeScale);
    this.director.addShake(impact * 0.045);
    if (impact > 5) this.director.focusTarget.copy(p);

    // crashtime extension (the trigger lives in the crash-marking block)
    if (this.state === GameState.Crash && impact > 7 && this.crashElapsed < 6) {
      this.slowTimer = Math.min(this.slowTimer + 0.8, 3.4);
    }
  }

  /** Wreck an actor: the full collision mask returns (wrecks tumble over
   *  ramps and plinths) and each non-player vehicle charges the
   *  crashbreaker a step, Burnout-Revenge style. */
  private markCrashed(a: Actor): void {
    if (a.crashed) return;
    a.crashed = true;
    a.body.collisionFilterMask = -1;
    if (!a.isPlayer && a.kind === 'vehicle') {
      this.cbCharge = Math.min(1, this.cbCharge + CB_PER_WRECK);
      this.events.emit('crashbreaker', this.cbCharge);
    }
  }

  /** Take up to `amount` from an actor's remaining damage-money budget. */
  private drawCash(a: Actor, amount: number): number {
    const pay = Math.min(a.cashLeft, amount);
    a.cashLeft -= pay;
    return pay;
  }

  private popLooseWheel(actor: Actor, p: THREE.Vector3): void {
    const part = popWheel(actor, p, this.scene, this.phys.world, this.phys.matCar);
    if (part) this.looseParts.push(part);
  }

  /** A panel crossed its detach threshold: door/bonnet/boot flies off. */
  private detachPanel = (actor: Actor, panel: PanelState): void => {
    this.scene.attach(panel.mesh); // keep the flapped world transform
    const body = makePanelBody(actor, panel, this.phys.matCar);
    this.phys.world.addBody(body);
    this.looseParts.push({ mesh: panel.mesh, body });
    panel.mesh.getWorldPosition(_panelPos);
    this.fx.sparks.spawn(_panelPos, 12, 4);
  };

  private collectMultiplier(mult: number, pos: THREE.Vector3): void {
    if (mult > this.multiplier) {
      this.multiplier = mult;
      this.events.emit('multiplier', mult);
    }
    this.fx.sparks.spawn(pos, 30, 4);
    this.audio.ding();
    this.emitCashAt(pos, `x${mult} MULTIPLIER`);
  }

  private emitCashAt(p: THREE.Vector3, text: string): void {
    const v = p.clone().project(this.camera);
    if (v.z > 1) return;
    this.events.emit('cash', {
      id: this.cashId++,
      x: (v.x * 0.5 + 0.5) * this.container.clientWidth,
      y: (-v.y * 0.5 + 0.5) * this.container.clientHeight,
      text,
    });
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

  private finish(): void {
    this.state = GameState.Done;
    const wrecked = this.actors.filter((a) => a.kind === 'vehicle' && !a.isPlayer && a.crashed).length;
    const m = this.level.medals;
    const medal: Medal =
      this.damage >= m.gold ? 'GOLD' : this.damage >= m.silver ? 'SILVER' : this.damage >= m.bronze ? 'BRONZE' : 'NONE';
    this.events.emit('state', this.state);
    this.events.emit('report', { total: Math.round(this.damage), wrecked, medal });
  }

  private finishRace(position: number): void {
    this.state = GameState.Done;
    const wrecked = this.actors.filter((a) => a.kind === 'vehicle' && !a.isPlayer && a.crashed).length;
    const medal: Medal = position === 1 ? 'GOLD' : position === 2 ? 'SILVER' : position === 3 ? 'BRONZE' : 'NONE';
    this.events.emit('state', this.state);
    this.events.emit('report', { total: Math.round(this.damage), wrecked, medal, position });
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
          if (this.race && this.player?.crashed) {
            // race mode: the crash cam is just a beat — reset-pair respawn
            // back onto the track and keep racing
            this.race.respawnPlayer(this.control);
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
      if ((speedSum < 2.5 && !fusesPending) || this.settleTimer > 8) this.finish();
    }
  }

  // ---------- simulation ----------

  private stepControls(): void {
    // the player drives for real (until they crash, then physics owns the wreck)
    const p = this.player;
    if (p && !p.crashed && this.state !== GameState.Idle && this.state !== GameState.Done) {
      this.control.update(
        p,
        {
          steer:
            (this.keys['ArrowRight'] || this.keys['KeyD'] ? 1 : 0) -
            (this.keys['ArrowLeft'] || this.keys['KeyA'] ? 1 : 0),
          throttle: !!(this.keys['ArrowUp'] || this.keys['KeyW']),
          boost: !!(this.keys['Space'] || this.keys['ShiftLeft'] || this.keys['ShiftRight']),
          brake: !!(this.keys['ArrowDown'] || this.keys['KeyS']),
        },
        this.heightAt,
      );
    }

    updateTraffic(this.actors, this.state, this.simTime, this.heightAt);
    this.race?.step(FIXED_DT, this.state);

    // aftertouch — nudge the wreck mid-flight, camera-relative
    if ((this.state === GameState.Crash || this.state === GameState.Settle) && this.player?.crashed) {
      let ix = 0;
      let iz = 0;
      if (this.keys['ArrowUp']) iz += 1;
      if (this.keys['ArrowDown']) iz -= 1;
      if (this.keys['ArrowLeft']) ix -= 1;
      if (this.keys['ArrowRight']) ix += 1;
      if (ix || iz) {
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

  private updateFuses(dt: number): void {
    for (const a of [...this.actors]) {
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
      deformActor(d.actor, d.p, d.strength);
    }
  }

  private syncMeshes(): void {
    for (const a of this.actors) {
      a.group.position.set(a.body.position.x, a.body.position.y, a.body.position.z);
      a.group.quaternion.set(a.body.quaternion.x, a.body.quaternion.y, a.body.quaternion.z, a.body.quaternion.w);
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
      }
    }
  }

  private updateHudDamage(dt: number): void {
    this.displayedDamage += (this.damage - this.displayedDamage) * Math.min(1, dt * 6);
    if (this.damage - this.displayedDamage < 1) this.displayedDamage = this.damage;
    const v = Math.round(this.displayedDamage);
    if (v !== this.lastEmittedDamage) {
      this.lastEmittedDamage = v;
      this.events.emit('damage', v);
    }
    const boost = Math.round((this.control.boostMeter / BOOST_CAP) * 100);
    if (boost !== this.lastEmittedBoost) {
      this.lastEmittedBoost = boost;
      this.events.emit('boost', boost / 100);
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

  // ---------- main loop ----------

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.schedule();
    // hidden tabs throttle timers to ~1 Hz — integrate the elapsed second
    // in one go there, so background time still passes at real speed
    const hidden = document.hidden;
    const dt = Math.min((now - this.last) / 1000, hidden ? 1.2 : 0.05);
    this.last = now;

    this.updateTimeScale(dt);
    const simDt = dt * this.timeScale;
    this.accumulator += simDt;
    let steps = 0;
    const maxSteps = hidden ? 160 : 8;
    while (this.accumulator >= FIXED_DT && steps < maxSteps) {
      this.stepControls();
      applySuspension(this.actors, this.state, this.heightAt);
      this.phys.world.step(FIXED_DT);
      // (no vertical-velocity clamp: live chassis ignore décor colliders, so
      // jumps are pure suspension + ballistics off the ramp's real slope)
      this.updateFuses(FIXED_DT);
      this.simTime += FIXED_DT;
      this.accumulator -= FIXED_DT;
      steps++;
    }

    this.syncMeshes();
    this.updateWheels(simDt);
    updatePanelFlap(this.actors, simDt);
    this.processDeforms();
    if (this.player) _pp.set(this.player.body.position.x, this.player.body.position.y, this.player.body.position.z);
    this.pickups.update(simDt, now / 1000, this.player ? _pp : null, (m, pos) => this.collectMultiplier(m, pos));
    this.updateSkid(simDt);
    this.fx.update(simDt);
    this.updateBurning(simDt);
    this.updateBoostFlames();
    this.director.update(
      dt,
      now / 1000,
      this.camera,
      this.state,
      this.player,
      this.control.boosting,
      this.control.drifting,
    );
    this.updateHudDamage(dt);
    // engine note: revs saw through the gears, drop on every upshift
    const driving = this.state === GameState.Launch && this.player && !this.player.crashed;
    this.audio.engine(
      this.control.rpm,
      driving ? (this.control.boosting ? 0.11 : this.keys['ArrowUp'] || this.keys['KeyW'] ? 0.085 : 0.05) : 0,
    );
    this.renderer.render(this.scene, this.camera);
  };
}
