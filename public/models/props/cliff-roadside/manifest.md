# cliff-roadside

Self-made props for the CLIFF HEADLAND zone retheme.

- Source: generated in-repo by `make-chevron.mjs` (run it from the repo root
  with `fnm exec --using=22 -- node public/models/props/cliff-roadside/make-chevron.mjs`
  to regenerate). No third-party assets.
- License: CC0 (authored for this project, no attribution required).

| model | size | notes |
| --- | --- | --- |
| chevron-sign.glb | 13 KB | Yellow/black corner chevron board, ~2.6 m x 2.2 m native. Board faces local -Z, chevrons point local -X (set yaw = atan2(dirX, dirZ) of approaching traffic for a left-hander). Flat-shaded boxes, three materials (chevronYellow / chevronBlack / postSteel) — all opaque, so PropDef.tint applies if ever needed. |
