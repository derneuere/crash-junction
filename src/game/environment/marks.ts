import * as THREE from 'three';

/** Painted ground rectangles, one InstancedMesh per color. The road dashes
 *  and checkpoint stripes are all the default off-white, so the existing
 *  call sites still cost a single draw; level decals (DecalDef) ride the
 *  same path with their own colors and a lower y slot. Marks on the
 *  elevated north arc carry their own y (road elevation + slot) and a
 *  pitch about their length axis so a dash lies ON the grade instead of
 *  spearing through it — the coplanar z-order contract above only ever
 *  applied to the flat zones, which pass neither field and stay put. */
export function addMarkInstances(
  scene: THREE.Scene,
  marks: { x: number; z: number; w: number; l: number; yaw: number; color?: number; y?: number; pitch?: number }[],
  y = 0.015,
): void {
  const groups = new Map<number, typeof marks>();
  for (const mk of marks) {
    const key = mk.color ?? 0xd9dde2;
    let arr = groups.get(key);
    if (!arr) groups.set(key, (arr = []));
    arr.push(mk);
  }
  const mGeo = new THREE.PlaneGeometry(1, 1);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  for (const [color, mine] of groups) {
    const mMat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    const inst = new THREE.InstancedMesh(mGeo, mMat, mine.length);
    mine.forEach((mk, i) => {
      e.set(-Math.PI / 2 + (mk.pitch ?? 0), mk.yaw, 0, 'YXZ');
      q.setFromEuler(e);
      s.set(mk.w, mk.l, 1);
      m4.compose(new THREE.Vector3(mk.x, mk.y ?? y, mk.z), q, s);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.receiveShadow = true;
    scene.add(inst);
  }
}

/** Road ribbon for a section chain: a triangle strip between the left and
 *  right edges of every section. Closed chains (the main loop) wrap the
 *  seam; open chains (shortcut branches) just end at their last section.
 *  Each row rides its section's road elevation plus the z-order slot, so
 *  the strip IS the visual of the suspension base field's corridor. */
export function addRibbon(
  scene: THREE.Scene,
  secs: { x: number; z: number; y: number; dirX: number; dirZ: number }[],
  width: number,
  y: number,
  color: number,
  closed: boolean,
): void {
  const w2 = width / 2;
  const N = secs.length;
  const rows = closed ? N + 1 : N;
  const pos = new Float32Array(rows * 2 * 3);
  for (let i = 0; i < rows; i++) {
    const s = secs[i % N];
    const o = i * 6;
    pos[o] = s.x - s.dirZ * w2;
    pos[o + 1] = s.y + y;
    pos[o + 2] = s.z + s.dirX * w2;
    pos[o + 3] = s.x + s.dirZ * w2;
    pos[o + 4] = s.y + y;
    pos[o + 5] = s.z - s.dirX * w2;
  }
  const idx: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const ribbon = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, roughness: 0.95, side: THREE.DoubleSide }),
  );
  ribbon.receiveShadow = true;
  ribbon.name = 'cj-ribbon';
  scene.add(ribbon);
}
