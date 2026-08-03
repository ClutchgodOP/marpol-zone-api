/**
 * globe.js — Three.js 3D rotating Earth for the hero section.
 * Uses a real Earth day-map texture (public three.js example asset) with
 * cloud layer, animated atmosphere, starfield, and a pulsing ship pin.
 */
import * as THREE from 'three';

const EARTH_TEXTURE  = 'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg';
const EARTH_SPECULAR = 'https://threejs.org/examples/textures/planets/earth_specular_2048.jpg';
const EARTH_CLOUDS   = 'https://threejs.org/examples/textures/planets/earth_clouds_1024.png';

export class GlobeController {
  constructor(canvasId) {
    this._canvas  = document.getElementById(canvasId);
    this._pinMesh = null;
    this._running = true;

    this._initRenderer();
    this._initScene();
    this._initGlobe();
    this._initClouds();
    this._initAtmosphere();
    this._initStars();
    this._initLights();
    this._bindResize();
    this._animate();
  }

  _initRenderer() {
    this._renderer = new THREE.WebGLRenderer({ canvas: this._canvas, antialias: true, alpha: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(this._canvas.clientWidth, this._canvas.clientHeight);
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  _initScene() {
    this._scene  = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(45, this._canvas.clientWidth / this._canvas.clientHeight, 0.1, 1000);
    this._camera.position.set(0, 0, 2.8);
  }

  _initGlobe() {
    const loader = new THREE.TextureLoader();
    const geo = new THREE.SphereGeometry(1, 96, 96);
    const mat = new THREE.MeshPhongMaterial({
      map:       loader.load(EARTH_TEXTURE),
      specularMap: loader.load(EARTH_SPECULAR),
      specular:  new THREE.Color('#333333'),
      shininess: 12,
    });
    this._globe = new THREE.Mesh(geo, mat);
    this._scene.add(this._globe);
  }

  _initClouds() {
    const loader = new THREE.TextureLoader();
    const geo = new THREE.SphereGeometry(1.012, 96, 96);
    const mat = new THREE.MeshPhongMaterial({
      map: loader.load(EARTH_CLOUDS),
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    this._clouds = new THREE.Mesh(geo, mat);
    this._scene.add(this._clouds);
  }

  _initAtmosphere() {
    const geo = new THREE.SphereGeometry(1.06, 64, 64);
    const mat = new THREE.ShaderMaterial({
      uniforms: { glowColor: { value: new THREE.Color('#00d4ff') } },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vNormal;
        uniform vec3 glowColor;
        void main() {
          float intensity = pow(0.65 - dot(vNormal, vec3(0,0,1.0)), 3.0);
          gl_FragColor = vec4(glowColor, intensity * 0.9);
        }`,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this._scene.add(new THREE.Mesh(geo, mat));
  }

  _initStars() {
    const count = 2400;
    const verts = [];
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 8 + Math.random() * 6;
      verts.push(r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const mat = new THREE.PointsMaterial({ color: 0xaaccff, size: 0.045, transparent: true, opacity: 0.75 });
    this._scene.add(new THREE.Points(geo, mat));
  }

  _initLights() {
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(5, 3, 5);
    this._scene.add(sun);
    this._scene.add(new THREE.AmbientLight(0x223344, 1.1));
  }

  _bindResize() {
    new ResizeObserver(() => {
      const w = this._canvas.clientWidth, h = this._canvas.clientHeight;
      this._renderer.setSize(w, h, false);
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
    }).observe(this._canvas.parentElement);
  }

  _animate() {
    if (!this._running) return;
    requestAnimationFrame(() => this._animate());
    this._globe.rotation.y  += 0.0013;
    this._clouds.rotation.y += 0.0019;
    if (this._pinMesh) {
      this._pinMesh.rotation.y = this._globe.rotation.y;
      const t = performance.now() * 0.003;
      const scale = 1 + Math.sin(t) * 0.25;
      if (this._pinRing) this._pinRing.scale.setScalar(scale);
    }
    this._renderer.render(this._scene, this._camera);
  }

  setPin(lat, lon, status = 'SAFE') {
    if (this._pinMesh) { this._scene.remove(this._pinMesh); this._pinMesh = null; }

    const phi   = (90 - lat)  * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    const r = 1.05;
    const x = -r * Math.sin(phi) * Math.cos(theta);
    const y =  r * Math.cos(phi);
    const z =  r * Math.sin(phi) * Math.sin(theta);

    const color = status === 'SAFE' ? 0x00e676 : 0xff6b35;
    const group = new THREE.Group();

    const core = new THREE.Mesh(new THREE.SphereGeometry(0.026, 16, 16), new THREE.MeshBasicMaterial({ color }));
    core.position.set(x, y, z);
    group.add(core);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.035, 0.05, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
    );
    ring.position.set(x, y, z);
    ring.lookAt(new THREE.Vector3(x * 2, y * 2, z * 2));
    group.add(ring);
    this._pinRing = ring;

    this._pinMesh = group;
    this._scene.add(this._pinMesh);

    const targetY = -theta + Math.PI;
    this._globe.rotation.y  = targetY;
    this._clouds.rotation.y = targetY;
  }

  destroy() {
    this._running = false;
    this._renderer.dispose();
  }
}
