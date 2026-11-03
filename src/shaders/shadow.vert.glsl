// Shear-based building shadows.
//
// Geometry is baked ONCE, flat, at BUILDING_SHADOW_Y, with NO sun offset
// applied to any vertex position. Every vertex instead carries `aSlide`:
// 0 at the true footprint edge, that building's own height at the far
// (sun-facing) edge. Moving a shadow to match a new sun angle is then
// just changing uShadowShear and letting the GPU re-evaluate this shader
// on the next frame -- no CPU-side rebuild, ever.
//
// The other way -- the sun's offset baked into the vertex positions --
// means disposing and re-triangulating every shadow mesh whenever the sun
// moves (measured on Kanpur's buildings: ~2.2 s, once a minute). See
// ShadowLayer.js's computeShadowShear() for how uShadowShear is derived
// from the sun's elevation and azimuth.
//
// logdepthbuf_pars_vertex/logdepthbuf_vertex ARE REQUIRED here: the
// renderer runs with logarithmicDepthBuffer:true (needed at this scene's
// scale), which every one of THREE's OWN built-in materials gets for
// free, but a raw ShaderMaterial does not -- without these chunks this
// shader writes ordinary linear depth while everything else in the scene
// writes logarithmic depth, so depth-testing against it is essentially
// incoherent (this was a real, confirmed bug: shadows silently failed
// their depth test against nearby ground/roads almost everywhere except
// wide-open, close-range spots, which is exactly why it looked like
// "shadows just don't show up").
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aSlide;
uniform vec2 uShadowShear; // sunDirXZ(unit, away-from-sun) * (1 / tan(sunElevationDeg))

void main() {
  vec3 sheared = position;
  sheared.x += aSlide * uShadowShear.x;
  sheared.z += aSlide * uShadowShear.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(sheared, 1.0);
  #include <logdepthbuf_vertex>
}
