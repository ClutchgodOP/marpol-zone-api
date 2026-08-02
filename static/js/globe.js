/**
 * globe.js — Three.js 3D rotating Earth for the hero section.
 * Imported as an ES module by index.html.
 * Renders onto #globe-canvas; auto-resizes via ResizeObserver.
 * Ship position pin is updated by dashboard.js via GlobeController.setPin().
 */
import * as THREE from 'three';

export class GlobeController {
  constructor(canvasId) {
    this._canvas  = document.getElementById(canvasId);
    this._pinLat  = null;
    this._pinLon  = null;
    this._pinMesh = null;
    this._running = true;

    this._initRenderer();
    this._initScene();
    this._initGlobe();
    this._initAtmosphere();
    this._initStars();
    this._initLights();
    this._bindResize();
    this._animate();
  }

  // ── Renderer ────────────────────────────────────────────────────────────
  _initRenderer() {
    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: true,
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(this._canvas.clientWidth, this._canvas.clientHeight);
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  // ── Scene & Camera ───────────────────────────────────────────────────────
  _initScene() {
    this._scene  = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(
      45,
      this._canvas.clientWidth / this._canvas.clientHeight,
      0.1,
      1000,
    );
    this._camera.position.set(0, 0, 2.8);
  }

  // ── Globe sphere ─────────────────────────────────────────────────────────
  _initGlobe() {
    const geo = new THREE.SphereGeometry(1, 64, 64);

    // Procedural ocean + land look using vertex shader colours (no texture fetch).
    // A real deployment can swap in a texture by replacing MeshPhongMaterial.
    const mat = new THREE.MeshPhongMaterial({
      color:     new THREE.Color('#0b2a4a'),
      emissive:  new THREE.Color('#00162b'),
      specular:  new THREE.Color('#1a6fa8'),
      shininess: 60,
      transparent: true,
      opacity: 0.97,
    });

    this._globe = new THREE.Mesh(geo, mat);
    this._scene.add(this._globe);

    // Ocean grid lines overlay for a nautical-chart aesthetic
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x1a4a7a,
      wireframe: true,
      transparent: true,
      opacity: 0.08,
    });
    this._scene.add(new THREE.Mesh(geo, wireMat));
  }

  // ── Atmosphere glow ───────────────────────────────────────────────────────
  _initAtmosphere() {
    const geo = new THREE.SphereGeometry(1.06, 64, 64);
    const mat = new THREE.MeshPhongMaterial({
      color:       new THREE.Color('#00aaff'),
      transparent: true,
      opacity:     0.08,
      side:        THREE.FrontSide,
      depthWrite:  false,
    });
    this._scene.add(new THREE.Mesh(geo, mat));
  }

  // ── Star field ────────────────────────────────────────────────────────────
  _initStars() {
    const count  = 1800;
    const verts  = [];
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 8 + Math.random() * 4;
      verts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const mat = new THREE.PointsMaterial({ color: 0xaaccff, size: 0.04, transparent: true, opacity: 0.7 });
    this._scene.add(new THREE.Points(geo, mat));
  }

  // ── Lights ────────────────────────────────────────────────────────────────
  _initLights() {
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(5, 3, 5);
    this._scene.add(sun);
    this._scene.add(new THREE.AmbientLight(0x112233, 1.2));
  }

  // ── Resize ────────────────────────────────────────────────────────────────
  _bindResize() {
    new ResizeObserver(() => {
      const w = this._canvas.clientWidth;
      const h = this._canvas.clientHeight;
      this._renderer.setSize(w, h, false);
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
    }).observe(this._canvas.parentElement);
  }

  // ── Animate ───────────────────────────────────────────────────────────────
  _animate() {
    if (!this._running) return;
    requestAnimationFrame(() => this._animate());
    this._globe.rotation.y += 0.0015;
    if (this._pinMesh) this._pinMesh.rotation.y += 0.0015;
    this._renderer.render(this._scene, this._camera);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Place / move the ship position pin on the globe.
   * @param {number} lat  Latitude  -90..90
   * @param {number} lon  Longitude -180..180
   * @param {string} status  "SAFE" | "RESTRICTED"
   */
  setPin(lat, lon, status = 'SAFE') {
    if (this._pinMesh) {
      this._scene.remove(this._pinMesh);
      this._pinMesh = null;
    }

    const phi   = (90 - lat)  * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    const r     = 1.05;

    const x = -r * Math.sin(phi) * Math.cos(theta);
    const y =  r * Math.cos(phi);
    const z =  r * Math.sin(phi) * Math.sin(theta);

    const color  = status === 'SAFE' ? 0x00e676 : 0xff6b35;
    const pinGeo = new THREE.SphereGeometry(0.028, 16, 16);
    const pinMat = new THREE.MeshBasicMaterial({ color });
    this._pinMesh = new THREE.Mesh(pinGeo, pinMat);
    this._pinMesh.position.set(x, y, z);
    this._scene.add(this._pinMesh);

    // Rotate globe so the pin faces the camera
    const targetY = -theta + Math.PI;
    this._globe.rotation.y  = targetY;
    if (this._pinMesh) this._pinMesh.rotation.y = targetY;
  }

  destroy() {
    this._running = false;
    this._renderer.dispose();
  }
}
