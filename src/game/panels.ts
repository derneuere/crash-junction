// Barrel: the detachable-body-panel implementation was split into ./panels/*
// sibling modules to keep each file small; this file preserves the original
// public import surface ("./panels") unchanged. The BP DeformationSpec-derived
// layout tables and panel-def assembly live in ./panels/defs; the scene-build
// pass (cutout repaint, mesh/pivot rigging) in ./panels/build; the runtime
// damage/flap/detach physics in ./panels/runtime.
export type { PanelDef } from './panels/defs';
export { panelDefs } from './panels/defs';
export { buildPanels } from './panels/build';
export { accumulatePanelDamage, updatePanelFlap, makePanelBody } from './panels/runtime';
