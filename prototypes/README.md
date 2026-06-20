# Prototypes & Demos

This directory is for quick, throwaway code, proof-of-concepts, and playable demos to test game mechanics before implementing them properly in `src/`.

## Available Demos

| Demo | Description |
|---|---|
| [`01-core-loop-demo`](01-core-loop-demo/) | Phase 1 core loop: cinematic station approach, platform expansion, NPC movement |
| [`02-ortho-camera-demo`](02-ortho-camera-demo/) | Same as 01 but with orthographic (parallel) projection and a fully locked camera |
| [`03-character-model-demo`](03-character-model-demo/) | Same as 02 but replaces the floating Mars planet with a rigged voxel player character: hierarchical pivot joints, lerp-based state machine (idle / walk / sit), and 8-way decoupled visual snapping |
