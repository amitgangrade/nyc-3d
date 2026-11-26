import * as THREE from 'three';
import { SKY_FN_GLSL, SKY_UNIFORMS_GLSL } from './shaders/sky.glsl';
import { shared } from './uniforms';

function skyMaterial(withDiscs: boolean) {
  return new THREE.ShaderMaterial({
    name: 'Sky',
    uniforms: shared,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${SKY_UNIFORMS_GLSL}
      ${SKY_FN_GLSL}
      varying vec3 vDir;
      void main(){
        gl_FragColor = vec4(skyColor(vDir, ${withDiscs}), 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
}

/** Sky dome that follows the camera + a PMREM environment map generated from it. */
export class Sky {
  readonly mesh: THREE.Mesh;
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMaterial(true));
    this.mesh.scale.setScalar(30000);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    const envMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMaterial(false));
    envMesh.scale.setScalar(10);
    this.envScene.add(envMesh);
    // a dark "ground" hemisphere so reflections below the horizon are not sky-bright
    const ground = new THREE.Mesh(
      new THREE.SphereGeometry(9, 32, 16, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }),
    );
    this.groundMat = ground.material as THREE.MeshBasicMaterial;
    this.envScene.add(ground);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }
  private groundMat: THREE.MeshBasicMaterial;

  follow(camera: THREE.Camera) { this.mesh.position.copy(camera.position); }

  /** Re-render the environment map (call when the time of day changes). */
  updateEnvironment(scene: THREE.Scene, groundColor: THREE.Color) {
    this.groundMat.color.copy(groundColor);
    const rt = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 100);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    scene.environment = rt.texture;
  }
}
