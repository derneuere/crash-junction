import * as THREE from 'three';
import type { CarRecipe } from './recipe';
import type { Soup } from './soup';

// ────────────────────────────────────────────────────────────────────────────
// Front / rear clips + mirrors: the dressing bolted onto the loft's nose and
// tail faces — bumper slabs, grille, light lenses, exhaust tips. Everything
// is boxes, deliberately proud of the face by a few mm so it never z-fights.
// The bumper slabs land inside cutPanelTemplates' bumper regions, so they
// tear off WITH the fascia — the slab IS the detachable bumper's meat.
// ────────────────────────────────────────────────────────────────────────────

const PROUD = 0.012; // how far dressing floats off its face

interface ClipSoups {
  paint: Soup;
  trim: Soup;
  head: Soup;
  tail: Soup;
}

interface ClipColors {
  paint: THREE.Color;
  trim: THREE.Color;
  head: THREE.Color;
  tail: THREE.Color;
}

export function buildFrontClip(recipe: CarRecipe, soups: ClipSoups, colors: ClipColors): void {
  const nose = recipe.stations[0];
  const z = nose.z; // nose face plane (forward = -z)
  const w = nose.halfW;
  const bumperY = recipe.floorY + 0.16;

  // bumper slab wrapping the face
  const bumperSoup = recipe.parts.bumpers === 'painted' ? soups.paint : soups.trim;
  const bumperColor = recipe.parts.bumpers === 'painted' ? colors.paint : colors.trim;
  bumperSoup.box(0, bumperY, z - 0.02, w * 2 * 0.98, 0.17, 0.16, bumperColor);

  // grille between the lights
  const grilleY = (bumperY + nose.bodyY) / 2 + 0.02;
  if (recipe.parts.grille === 'bar') {
    soups.trim.box(0, grilleY, z - PROUD, w * 1.05, 0.1, 0.02, colors.trim);
  } else if (recipe.parts.grille === 'chrome') {
    soups.trim.box(0, grilleY, z - PROUD, w * 1.1, 0.13, 0.025, new THREE.Color(0xb9bfc6));
  } // 'closed' = nothing, the body face is the grille (EV style)

  // headlight lenses
  if (recipe.parts.headlights === 'strip') {
    soups.head.box(0, nose.bodyY - 0.07, z - PROUD, w * 1.5, 0.05, 0.02, colors.head);
  } else if (recipe.parts.headlights === 'quad-round') {
    for (const m of [-1, 1]) {
      soups.head.box(m * w * 0.62, grilleY + 0.07, z - PROUD, 0.16, 0.14, 0.02, colors.head);
      soups.head.box(m * w * 0.36, grilleY + 0.07, z - PROUD, 0.13, 0.12, 0.02, colors.head);
    }
  } else {
    // 'pods'
    for (const m of [-1, 1]) {
      soups.head.box(m * w * 0.58, nose.bodyY - 0.09, z - PROUD, 0.34, 0.11, 0.02, colors.head);
    }
  }
}

export function buildRearClip(recipe: CarRecipe, soups: ClipSoups, colors: ClipColors): void {
  const tail = recipe.stations[recipe.stations.length - 1];
  const z = tail.z;
  const w = tail.halfW;
  const bumperY = recipe.floorY + 0.16;

  const bumperSoup = recipe.parts.bumpers === 'painted' ? soups.paint : soups.trim;
  const bumperColor = recipe.parts.bumpers === 'painted' ? colors.paint : colors.trim;
  bumperSoup.box(0, bumperY, z + 0.02, w * 2 * 0.98, 0.17, 0.16, bumperColor);

  // taillight lenses
  if (recipe.parts.taillights === 'strip') {
    soups.tail.box(0, tail.bodyY - 0.07, z + PROUD, w * 1.5, 0.05, 0.02, colors.tail);
  } else {
    // 'pods' / 'quad-round' share the corner-lens look at the rear
    for (const m of [-1, 1]) {
      soups.tail.box(m * w * 0.62, tail.bodyY - 0.11, z + PROUD, 0.22, 0.1, 0.02, colors.tail);
    }
  }

  // exhaust tips under the bumper
  for (let i = 0; i < recipe.parts.exhaust; i++) {
    const x = recipe.parts.exhaust === 1 ? -0.32 : (i === 0 ? -1 : 1) * 0.34;
    soups.trim.box(x, recipe.floorY + 0.05, z + 0.04, 0.09, 0.07, 0.14, new THREE.Color(0x2c2f34));
  }
}

export function buildMirrors(recipe: CarRecipe, paint: Soup, color: THREE.Color): void {
  // door mirrors at the cabin's leading edge, on short stalks
  const zAt = recipe.cabin.z0 + 0.12;
  const s = recipe.stations.reduce((a, b) => (Math.abs(b.z - zAt) < Math.abs(a.z - zAt) ? b : a));
  for (const m of [-1, 1]) {
    const x = m * (s.halfW + 0.09);
    paint.box(x, s.bodyY + 0.1, zAt, 0.13, 0.08, 0.06, color);
    paint.box(m * (s.halfW - 0.01), s.bodyY + 0.07, zAt, 0.12, 0.025, 0.03, color);
  }
}
