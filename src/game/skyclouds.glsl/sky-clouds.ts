import { CLOUD_NOISE_GLSL } from './noise.glsl';
import { CLOUD_DENSITY_GLSL } from './density.glsl';
import { CLOUD_MARCH_GLSL } from './march.glsl';

// Reassemble the volumetric-cloud GLSL chunk from its cohesive sub-chunks.
//
// Each chunk module is a backtick string whose opening "`" and closing "`;" sit
// on their own lines, so every chunk carries a leading AND a trailing "\n". The
// original SKY_CLOUDS separated its sections with exactly one blank line, i.e. a
// "\n\n" seam — and that seam is reproduced for free by one chunk's trailing
// "\n" meeting the next chunk's leading "\n". So a PLAIN concatenation (no extra
// characters) yields byte-identical shader text: leading "\n", noise, blank,
// density, blank, march, trailing "\n".
export const SKY_CLOUDS = CLOUD_NOISE_GLSL + CLOUD_DENSITY_GLSL + CLOUD_MARCH_GLSL;
