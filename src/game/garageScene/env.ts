import * as THREE from 'three';

/** A sink for GL resources created here that the caller must dispose later. */
type Track = (...items: { dispose(): void }[]) => void;

/** A tiny procedural environment map so the clearcoat has something bright to
 *  reflect (B3 gloss needs streaks to sweep). Built from a gradient scene via
 *  PMREM, captured once, then the generator is freed. The captured env texture
 *  is assigned to `scene.environment` and registered with `track`. */
export function buildEnv(renderer: THREE.WebGLRenderer, scene: THREE.Scene, track: Track): void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  // a dark room with a few bright strip-light panels overhead and a warm
  // floor bounce — gives the paint horizontal showroom streaks
  envScene.background = new THREE.Color(0x05070a);
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 1.4),
    new THREE.MeshBasicMaterial({ color: 0xeaf2ff }),
  );
  for (const sx of [-3, 0, 3]) {
    const s = strip.clone();
    s.position.set(sx, 6, 0);
    s.rotation.x = Math.PI / 2;
    envScene.add(s);
  }
  const warmFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshBasicMaterial({ color: 0x2a1c10 }),
  );
  warmFloor.position.y = -4;
  warmFloor.rotation.x = -Math.PI / 2;
  envScene.add(warmFloor);
  const rimPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 6),
    new THREE.MeshBasicMaterial({ color: 0x14213a }),
  );
  rimPanel.position.set(0, 2, -8);
  envScene.add(rimPanel);

  const env = pmrem.fromScene(envScene, 0.04).texture;
  scene.environment = env;
  track(env);
  // free the throwaway env scene + the generator
  envScene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  });
  strip.geometry.dispose();
  (strip.material as THREE.Material).dispose();
  pmrem.dispose();
}
