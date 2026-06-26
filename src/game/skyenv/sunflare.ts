import * as THREE from 'three';

// ---------- sun lens flare ----------
// Ghost sprites strung along the screen-space sun→centre axis, occlusion-
// faded so the flare dies behind a building and blazes when the sun clears
// the rooftops — the footage beat. Hand-rolled instead of THREE.Lensflare:
// the stock one saves/restores the framebuffer around a depth probe
// (copyFramebufferToTexture), which is illegal from inside the composer's
// multisampled HDR buffer and smears black quads over the sky. Occlusion
// here is a single physics ray from Game instead — the collision boxes are
// exactly the chunky occluders a flare cares about.

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,240,210,0.55)');
  grad.addColorStop(0.6, 'rgba(255,220,160,0.12)');
  grad.addColorStop(1, 'rgba(255,210,140,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function ghostTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.78, 'rgba(255,255,255,0.35)');
  grad.addColorStop(0.92, 'rgba(255,255,255,0.1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface FlareElement {
  sprite: THREE.Sprite;
  /** 0 = on the sun, 1 = screen centre, >1 mirrored past centre */
  dist: number;
  /** screen-relative size (sizeAttenuation off: 1 ≈ viewport height) */
  size: number;
  opacity: number;
}

const _flareNdc = new THREE.Vector3();
const _flarePoint = new THREE.Vector3();

export class SunFlare {
  readonly group = new THREE.Group();
  private elements: FlareElement[] = [];
  private visibility = 0; // occlusion-faded 0..1
  private textures: THREE.Texture[] = [];

  constructor() {
    const glow = glowTexture();
    const ghost = ghostTexture();
    this.textures.push(glow, ghost);
    const make = (tex: THREE.Texture, dist: number, size: number, opacity: number, color: number) => {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        sizeAttenuation: false,
        fog: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(size, size, 1);
      sprite.renderOrder = 999; // over everything, under the DOM HUD
      this.group.add(sprite);
      this.elements.push({ sprite, dist, size, opacity });
    };
    make(glow, 0, 0.5, 0.85, 0xfff4dc); // halo on the sun itself
    make(ghost, 0.35, 0.09, 0.3, 0xa6c6ff);
    make(ghost, 0.55, 0.16, 0.35, 0xffd9a0);
    make(glow, 0.72, 0.06, 0.3, 0xffb380);
    make(ghost, 0.95, 0.24, 0.25, 0xb3e6ff);
    make(ghost, 1.25, 0.12, 0.2, 0xffc8a0);
    this.group.visible = false;
  }

  /** Re-aim the ghosts along the sun→centre axis and fade by occlusion.
   *  `occluded` is Game's physics ray (camera → sun). */
  update(camera: THREE.PerspectiveCamera, sunWorld: THREE.Vector3, dt: number, enabled: boolean, occluded: () => boolean): void {
    _flareNdc.copy(sunWorld).project(camera);
    const onScreen = enabled && _flareNdc.z < 1 && Math.abs(_flareNdc.x) < 1.3 && Math.abs(_flareNdc.y) < 1.3;
    const target = onScreen && !occluded() ? 1 : 0;
    this.visibility += (target - this.visibility) * Math.min(1, dt * 9);
    if (this.visibility < 0.01) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    // edge fade: flares die toward the screen border like a real lens
    const edge = Math.max(Math.abs(_flareNdc.x), Math.abs(_flareNdc.y));
    const fade = this.visibility * THREE.MathUtils.clamp(1.4 - edge, 0, 1);
    for (const e of this.elements) {
      // ghosts sit on the sun→centre line: ndc * (1 - dist)
      _flarePoint.set(_flareNdc.x * (1 - e.dist), _flareNdc.y * (1 - e.dist), 0.5).unproject(camera);
      e.sprite.position.copy(_flarePoint);
      (e.sprite.material as THREE.SpriteMaterial).opacity = e.opacity * fade;
    }
  }

  dispose(): void {
    for (const e of this.elements) (e.sprite.material as THREE.SpriteMaterial).dispose();
    for (const t of this.textures) t.dispose();
  }
}
