import * as THREE from 'three';
import type { VehicleSpec } from '../../types';
import { applyNormalSmoothing, buildNormalSmoothing } from '../../geometry';
import { panelDefs } from '../../panels';
import type { VehicleModel } from '../types';
import { applyHullGroups } from '../bake';
import { measurePanelMetrics } from '../metrics';
import { cutPanelTemplates } from '../cutting';
import { buildInterior } from '../interior';
import type { CarRecipe } from './recipe';
import { Soup, mergeSoups } from './soup';
import { buildLoft } from './loft';
import { buildFrontClip, buildMirrors } from './front';
import { buildRearClip } from './rear';
import { buildSide } from './side';
import { buildWheelPair } from './wheels';

// ────────────────────────────────────────────────────────────────────────────
// Assembler: recipe → VehicleModel. The generator only produces the merged
// vertex-colored body + role ranges + wheels; everything after that is the
// SAME pipeline tail the GLB bake runs, in the same order (bake.ts):
// metrics (probed off our hull — the probes are exact on generated
// geometry), interior blocks, normal smoothing, panel cutting, material
// groups. That identity is what makes a generated car indistinguishable
// from a baked one to panels/deformation/garage/replay.
// ────────────────────────────────────────────────────────────────────────────

// baked-GLB colour conventions: paint gets repainted per-spawn via
// paintRanges; glass is baked near-black (whitened in-game for the
// transmission material, lifted in the garage); lenses carry their tone.
const BASE_PAINT = 0x8a8f96;
const GLASS_TONE = 0x08090b;
const HEAD_TONE = 0xe8e2cc;
const TAIL_TONE = 0x7e120c;
const WELL_TONE = 0x0b0c0f;

export function buildProceduralModel(recipe: CarRecipe, spec: VehicleSpec): VehicleModel {
  const wheelY = -(spec.rideHeight - spec.wheelRadius);
  const soups = {
    paint: new Soup(),
    glass: new Soup(),
    head: new Soup(),
    tail: new Soup(),
    reverse: new Soup(),
    trim: new Soup(),
    lampTrim: new Soup(), // bezels, housings, sweeps — dressing, like the lenses
  };
  const colors = {
    paint: new THREE.Color(BASE_PAINT),
    glass: new THREE.Color(GLASS_TONE),
    head: new THREE.Color(HEAD_TONE),
    tail: new THREE.Color(TAIL_TONE),
    trim: new THREE.Color(recipe.trimColor),
    well: new THREE.Color(WELL_TONE),
  };

  buildLoft(recipe, wheelY, soups, colors);
  buildFrontClip(recipe, soups, colors);
  buildRearClip(recipe, soups, colors);
  buildSide(recipe, soups, colors);
  buildMirrors(recipe, soups.paint, colors.paint);

  // merge in role order; each soup's landing range is its role range
  const { geo, ranges } = mergeSoups([soups.paint, soups.glass, soups.head, soups.tail, soups.reverse, soups.trim, soups.lampTrim]);
  const [paintR, glassR, headR, tailR, reverseR, , lampTrimR] = ranges;
  const paintRanges: [number, number][] = [paintR];
  const glassRanges: [number, number][] = [glassR];
  const headRanges: [number, number][] = [headR];
  const tailRanges: [number, number][] = [tailR];
  const reverseRanges: [number, number][] = [reverseR];
  // every lamp part is dressing: lenses and their trim stay out of the
  // panel cuts (a torn bonnet must not take a headlight bezel with it)
  const dressRanges: [number, number][] = [headR, tailR, reverseR, lampTrimR];

  // PS2-style paint: curved panels smooth so reflections sweep, hard edges
  // keep their split normals — same pass, same order as the bake
  applyNormalSmoothing(
    geo.attributes.normal as THREE.BufferAttribute,
    buildNormalSmoothing(geo.attributes.position as THREE.BufferAttribute, geo.attributes.normal as THREE.BufferAttribute),
  );

  const arch = { x: recipe.wheels.archX, zFront: recipe.wheels.zFront, zRear: recipe.wheels.zRear };
  const metrics = measurePanelMetrics(geo, arch, spec, glassRanges);
  // The interior anchors its dash/wheel/seats off door.z0 (front arch + r) —
  // right for the cab-forward GLB bodies, but a recipe with a longer hood
  // puts its cabin further back; anchor the FURNITURE at the real cabin
  // front or the dash pokes up through the bonnet. Panels keep the true
  // arch-to-arch door band (model.panelMetrics is untouched).
  const interiorMetrics = {
    ...metrics,
    door: { ...metrics.door, z0: Math.max(metrics.door.z0, recipe.cabin.z0 - 0.12) },
  };
  const { wheelL, wheelR } = buildWheelPair(recipe.wheels.style, spec.wheelRadius);
  const coarse = buildWheelPair(recipe.wheels.style, spec.wheelRadius, 'coarse');

  const model: VehicleModel = {
    body: geo,
    paintRanges,
    glassRanges,
    headRanges,
    tailRanges,
    reverseRanges,
    dressRanges,
    wheelL,
    wheelR,
    wheelCoarseL: coarse.wheelL,
    wheelCoarseR: coarse.wheelR,
    showroomWheels: true, // parametric wheels — the garage should show THEM
    arch,
    wheelY,
    panelMetrics: metrics,
    panelCuts: [],
    // built BEFORE the panel cuts, so width probes still see the door skin
    interior: buildInterior(interiorMetrics, arch, spec, geo),
  };
  model.panelCuts = cutPanelTemplates(model, panelDefs(spec, model), dressRanges);
  applyHullGroups(geo, glassRanges, headRanges, tailRanges, reverseRanges); // after the cuts replace the index
  return model;
}
