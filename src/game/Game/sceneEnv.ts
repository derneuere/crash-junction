import * as THREE from 'three';

/** The reflection world the cars see: a bright sky ceiling with one hot
 *  sun strip, sky-blue upper walls over a dark lower band (the horizon
 *  line that makes paint read as deep), and a near-black floor. Structured,
 *  high-contrast shapes — the streaks that sweep across smooth bodywork,
 *  Burnout-3 style. Captured once by PMREM, then discarded. */
export function makeCarEnvScene(): THREE.Scene {
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
export function makeNightEnvScene(): THREE.Scene {
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
export function makeSkySprite(tex: THREE.Texture, scale: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: false, transparent: true, depthWrite: false }));
  s.scale.set(scale, scale, 1);
  return s;
}
