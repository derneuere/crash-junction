import * as THREE from 'three';

const _col = new THREE.Color();
export function toVec(c: THREE.ColorRepresentation): THREE.Vector3 {
  _col.set(c);
  return new THREE.Vector3(_col.r, _col.g, _col.b);
}

// ---- sun transmittance at the eye (JS port of skyscatter.glsl) ----
// The cloud march needs the sun's atmospheric transmittance at the eye — the
// ONE scattering value it can't compute on its own (it carries no atmosphere
// model). In the inline dome path the frag computes sunTransmittance(ro); the
// equirect cloud bake instead receives it as a uniform. This is a faithful,
// byte-for-byte-intent port of skyscatter.glsl's sunTransmittance/getScattering
// at ro = (0, groundRadius+0.2, 0): it depends only on the sun direction + the
// (per-time-of-day) scattering coefficients, so it is computed ONCE per
// configure() — zero per-frame cost — and matches what the dome computes inline.
const ATMO = {
  groundRadius: 6360.0,
  atmoRadius: 6460.0,
  rayleighScaleH: 8.0,
  mieScaleH: 1.2,
  ozoneCentre: 25.0,
  ozoneWidth: 15.0,
};

/** ray–sphere from skyscatter.glsl: returns through-length (0 on miss). */
function raySphereThrough(ro: THREE.Vector3, rd: THREE.Vector3, radius: number): number {
  const b = ro.dot(rd);
  const c = ro.dot(ro) - radius * radius;
  const d = b * b - c;
  if (d < 0) return 0;
  const s = Math.sqrt(d);
  const near = Math.max(0, -b - s);
  const far = -b + s;
  if (far < 0) return 0;
  return far - near;
}

/** Sun transmittance at the eye — exp(-∫extinction) over an 8-step march toward
 *  the sun, exactly mirroring skyscatter.glsl. rayleighCoeff/mieCoeff/ozoneCoeff
 *  are the SAME values written into the dome uniforms in configure(). */
export function computeSunTransmittance(
  sunDir: THREE.Vector3,
  rayleighCoeff: THREE.Vector3,
  mieCoeff: number,
  ozoneCoeff: THREE.Vector3,
): THREE.Vector3 {
  const ro = new THREE.Vector3(0, ATMO.groundRadius + 0.2, 0);
  const len = raySphereThrough(ro, sunDir, ATMO.atmoRadius);
  const STEPS = 8;
  const ds = len / STEPS;
  let opticalR = 0,
    opticalG = 0,
    opticalB = 0;
  const pos = ro.clone().addScaledVector(sunDir, ds * 0.5);
  for (let i = 0; i < STEPS; i++) {
    const h = pos.length() - ATMO.groundRadius;
    const rDensity = Math.exp(-h / ATMO.rayleighScaleH);
    const mDensity = Math.exp(-h / ATMO.mieScaleH);
    const oDensity = Math.max(0, 1 - Math.abs(h - ATMO.ozoneCentre) / ATMO.ozoneWidth);
    const mieS = mieCoeff * mDensity;
    const mieAbs = mieCoeff * 0.1 * mDensity;
    // extinction = rayleighS + mieS + mieAbsorption + ozone*oDensity
    opticalR += (rayleighCoeff.x * rDensity + mieS + mieAbs + ozoneCoeff.x * oDensity) * ds;
    opticalG += (rayleighCoeff.y * rDensity + mieS + mieAbs + ozoneCoeff.y * oDensity) * ds;
    opticalB += (rayleighCoeff.z * rDensity + mieS + mieAbs + ozoneCoeff.z * oDensity) * ds;
    pos.addScaledVector(sunDir, ds);
  }
  return new THREE.Vector3(Math.exp(-opticalR), Math.exp(-opticalG), Math.exp(-opticalB));
}
