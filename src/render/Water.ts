import * as THREE from 'three';
import { shared, PATCH_TEST_GLSL } from './uniforms';

/**
 * Harbour water: planar reflection (scene rendered from a mirrored camera into
 * a half-res HDR target) distorted by procedural waves, Fresnel, sun glint.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  private rt: THREE.WebGLRenderTarget;
  private mirrorCam = new THREE.PerspectiveCamera();
  private textureMatrix = new THREE.Matrix4();
  /** water surface height: kept 2 m below the land so the two never depth-fight from high altitude */
  static readonly LEVEL = -2;
  private clip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -Water.LEVEL - 0.05)];
  private material: THREE.ShaderMaterial;
  scale = 0.5;

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, samples: 0 });
    this.material = new THREE.ShaderMaterial({
      name: 'Water',
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        tReflection: { value: null }, textureMatrix: { value: null },
      }]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        uniform mat4 textureMatrix;
        varying vec4 vRefl;
        varying vec3 vWP;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWP = wp.xyz;
          vRefl = textureMatrix * wp;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D tReflection;
        uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uSunIntensity;
        uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uAmbient; uniform float uNight; uniform float uLights; uniform vec3 uMoonDir;
        varying vec4 vRefl; varying vec3 vWP;
        ${PATCH_TEST_GLSL}

        float gPx = 1.0; // metres per pixel, set in main()
        vec2 wave(vec2 p, vec2 dir, float freq, float speed){
          float ph = dot(p, dir) * freq + uTime * speed;
          // drop waves too small to be resolved at this pixel footprint (prevents moire)
          float w = 1.0 - smoothstep(0.4, 1.4, freq * gPx);
          return dir * cos(ph) * freq * w;
        }
        vec3 waterNormal(vec2 p, float fade){
          vec2 g = vec2(0.0);
          g += wave(p, normalize(vec2(1.0, 0.35)), 0.045, 1.1) * 0.9;
          g += wave(p, normalize(vec2(-0.6, 1.0)), 0.083, 1.5) * 0.6;
          g += wave(p, normalize(vec2(0.2, -1.0)), 0.21, 2.3) * 0.35;
          g += wave(p, normalize(vec2(-1.0, -0.3)), 0.47, 3.1) * 0.22 * fade;
          g += wave(p, normalize(vec2(0.7, 0.7)), 1.13, 4.7) * 0.12 * fade;
          g += wave(p, normalize(vec2(-0.3, 0.9)), 2.3, 6.1) * 0.06 * fade;
          return normalize(vec3(-g.x * 0.6, 1.0, -g.y * 0.6));
        }
        void main(){
          #include <logdepthbuf_fragment>
          if (onPatch(vWP.xz)) discard;
          vec3 toCam = cameraPosition - vWP;
          float dist = length(toCam);
          vec3 V = toCam / dist;
          float fade = 1.0 - smoothstep(400.0, 3500.0, dist);
          gPx = max(length(fwidth(vWP.xz)), 1e-3);
          vec3 N = waterNormal(vWP.xz, fade);
          N = normalize(mix(vec3(0,1,0), N, 0.35 + 0.65 * fade));
          float cosT = max(dot(N, V), 0.0);
          float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
          vec2 uv = vRefl.xy / vRefl.w + N.xz * 0.035 * (0.4 + 0.6 * fade);
          vec3 refl = texture2D(tReflection, uv).rgb;
          // water body colour: lit by sky ambient, deep green-blue harbour
          vec3 body = mix(vec3(0.016, 0.052, 0.075), vec3(0.010, 0.030, 0.075), uNight) * (0.6 + 0.6 * uAmbient);
          refl *= mix(vec3(1.0), vec3(0.82, 0.95, 1.18), uNight);
          vec3 col = mix(body, refl, clamp(fres * 0.9 + mix(0.08, 0.3, uNight), 0.0, 1.0));
          // full-moon glitter path
          vec3 Hm = normalize(uMoonDir + V);
          float ms = pow(max(dot(N, Hm), 0.0), 320.0) * 2.6 + pow(max(dot(N, Hm), 0.0), 60.0) * 0.025;
          col += vec3(0.75, 0.85, 1.0) * ms * uNight;
          // sun glint
          vec3 H = normalize(uSunDir + V);
          float spec = pow(max(dot(N, H), 0.0), 380.0) * 6.0 + pow(max(dot(N, H), 0.0), 40.0) * 0.08;
          col += uSunColor * uSunIntensity * spec * smoothstep(-0.02, 0.05, uSunDir.y);
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
    });
    Object.assign(this.material.uniforms, {
      uTime: shared.uTime, uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uSunIntensity: shared.uSunIntensity,
      uZenith: shared.uZenith, uHorizon: shared.uHorizon, uAmbient: shared.uAmbient, uNight: shared.uNight, uLights: shared.uLights, uMoonDir: shared.uMoonDir,
      uPatchOn: shared.uPatchOn, uPatchClass: shared.uPatchClass, uPatchOrigin: shared.uPatchOrigin, uPatchU: shared.uPatchU, uPatchV: shared.uPatchV, uPatchSizeM: shared.uPatchSizeM,
    });
    this.material.uniforms.tReflection.value = this.rt.texture;
    this.material.uniforms.textureMatrix.value = this.textureMatrix;
    const geo = new THREE.PlaneGeometry(120000, 120000, 1, 1).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = -10;
    this.mesh.receiveShadow = false;
  }

  setSize(w: number, h: number) { this.rt.setSize(Math.max(1, Math.floor(w * this.scale)), Math.max(1, Math.floor(h * this.scale))); }

  /** Follows the camera horizontally (keeps the plane centred) and renders the reflection. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, skyMesh: THREE.Object3D) {
    this.mesh.position.set(camera.position.x, Water.LEVEL, camera.position.z);
    const mc = this.mirrorCam;
    mc.copy(camera, false);
    mc.layers.set(0); // skip fine detail (trees) in the reflection
    mc.position.set(camera.position.x, 2 * Water.LEVEL - camera.position.y, camera.position.z);
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir); dir.y = -dir.y;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion); up.y = -up.y;
    mc.up.copy(up);
    mc.lookAt(mc.position.clone().add(dir));
    mc.updateMatrixWorld();
    mc.projectionMatrix.copy(camera.projectionMatrix);
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(mc.projectionMatrix).multiply(mc.matrixWorldInverse);

    const skyPos = skyMesh.position.clone();
    skyMesh.position.copy(mc.position);
    this.mesh.visible = false;
    const prevRT = renderer.getRenderTarget();
    const prevClip = renderer.clippingPlanes;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.clippingPlanes = this.clip;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, mc);
    renderer.setRenderTarget(prevRT);
    renderer.clippingPlanes = prevClip;
    renderer.shadowMap.autoUpdate = prevShadow;
    this.mesh.visible = true;
    skyMesh.position.copy(skyPos);
  }
}
