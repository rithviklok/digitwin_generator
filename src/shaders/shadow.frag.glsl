// Stylized flat ground shadow -- not real shadow-mapping: one colour at
// one opacity (ShadowLayer.js's BUILDING_SHADOW_COLOR/BUILDING_SHADOW_OPACITY).
// uOpacity is recomputed every frame from weather strength × the sun's
// height × camera-height fade (same curve buildings use) -- see
// ShadowLayer.updateLOD().
//
// logdepthbuf_pars_fragment/logdepthbuf_fragment pair with the same
// chunks in shadow.vert.glsl -- see that file's comment for why a raw
// ShaderMaterial needs these explicitly under logarithmicDepthBuffer:true.
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uColor;
uniform float uOpacity;

void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uColor, uOpacity);
}
