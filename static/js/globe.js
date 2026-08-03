/**
 * globe.js
 * Three.js rotating globe with pin support.
 * Gracefully degrades if WebGL is unavailable.
 * Never blocks dashboard initialization.
 */

'use strict';

const EARTH_TEXTURE = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg';
const GLOBE_RADIUS  = 1.0;
const ROTATE_SPEED  = 0.0013;

export class GlobeController {
  /**
   * @param {string} canvasId - id of the <canvas> element
   */
  constructor(canvasId) {
    this._canvasId  = canvasId;
    this._running   = false;
    this._renderer  = null;
    this._scene     = null;
    this._camera    = null;
    this._globe     = null;
    this._pin       = null;
    this._resizeObs = null;
    this._rafId     = null;
    this._ready     = false;

    try {
      this._canvas = document.getElementById(canvasId);
      if (!this._canvas) {
        console.warn(`[Globe] Canvas element #${canvasId} not found — globe disabled.`);
        return;
      }
      this._initRenderer();
      this._initScene();
      this._bindResize();
      this._running = true;
      this._ready   = true;
      this._animate();
      console.info('[Globe] Initialized successfully.');
    } catch (err) {
      console.error('[Globe] Initialization failed — dashboard continues.', err);
      this._running = false;
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _initRenderer() {
    if (!window.THREE) throw new Error('THREE.js not loaded.');

    // Detect WebGL support before creating renderer
    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL not available in this browser.');

    this._renderer = new THREE.WebGLRenderer({
      canvas              : this._canvas,
      antialias           : true,
      alpha               : true,
      powerPreference     : 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });

    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(
      this._canvas.clientWidth  || 400,
      this._canvas.clientHeight || 400,
    );
  }

  _initScene() {
    const THREE = window.THREE;

    this._scene  = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(
      45,
      this._aspectRatio(),
      0.1,
      100,
    );
    this._camera.position.set(0, 0, 2.8);

    // Lights
    const ambient = new THREE.AmbientLight(0x404060, 0.6);
    this._scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(5, 3, 5);
    this._scene.add(sun);

    const fill = new THREE.DirectionalLight(0x2244aa, 0.3);
    fill.position.set(-5, -3, -5);
    this._scene.add(fill);

    // Globe mesh
    const geo = new THREE.SphereGeometry(GLOBE_RADIUS, 64, 64);
    const loader = new THREE.TextureLoader();
    const mat = new THREE.MeshPhongMaterial({
      map        : loader.load(EARTH_TEXTURE, undefined, undefined, (err) => {
        console.warn('[Globe] Earth texture failed to load.', err);
      }),
      specular   : new THREE.Color(0x333333),
      shininess  : 15,
    });

    this._globe = new THREE.Mesh(geo, mat);
    this._scene.add(this._globe);

    // Atmosphere glow (additive sphere slightly larger)
    const atmGeo = new THREE.SphereGeometry(GLOBE_RADIUS * 1.02, 64, 64);
    const atmMat = new THREE.MeshPhongMaterial({
      color       : 0x1a6bff,
      side        : THREE.BackSide,
      transparent : true,
      opacity     : 0.12,
    });
    this._scene.add(new THREE.Mesh(atmGeo, atmMat));
  }

  _bindResize() {
    const parent = this._canvas.parentElement;
    if (!parent) return;

    this._resizeObs = new ResizeObserver(() => this._onResize());
    this._resizeObs.observe(parent);
  }

  _onResize() {
    if (!this._renderer || !this._camera) return;
    const w = this._canvas.clientWidth  || 400;
    const h = this._canvas.clientHeight || 400;
    this._renderer.setSize(w, h);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  _aspectRatio() {
    const w = this._canvas.clientWidth  || 400;
    const h = this._canvas.clientHeight || 400;
    return w / h;
  }

  _animate() {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(() => this._animate());

    if (this._globe) {
      this._globe.rotation.y += ROTATE_SPEED;
    }

    if (this._renderer && this._scene && this._camera) {
      this._renderer.render(this._scene, this._camera);
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Place a pin at geographic coordinates.
   * @param {number} lat
   * @param {number} lon
   */
  setPin(lat, lon) {
    if (!this._ready || !this._scene) return;

    try {
      const THREE = window.THREE;

      // Remove previous pin
      if (this._pin) {
        this._scene.remove(this._pin);
        this._pin.geometry?.dispose();
        this._pin.material?.dispose();
        this._pin = null;
      }

      // Convert lat/lon to 3-D Cartesian on unit sphere
      const phi   = (90 - lat)  * (Math.PI / 180);
      const theta = (lon + 180) * (Math.PI / 180);
      const r     = GLOBE_RADIUS + 0.04;

      const x = -r * Math.sin(phi) * Math.cos(theta);
      const y =  r * Math.cos(phi);
      const z =  r * Math.sin(phi) * Math.sin(theta);

      const geo = new THREE.SphereGeometry(0.025, 12, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0xff3333 });
      this._pin = new THREE.Mesh(geo, mat);
      this._pin.position.set(x, y, z);
      this._scene.add(this._pin);
    } catch (err) {
      console.warn('[Globe] setPin failed.', err);
    }
  }

  /**
   * Point the camera so lat/lon faces the viewer over `ms` milliseconds.
   * @param {number} lat
   * @param {number} lon
   * @param {number} [ms=800]
   */
  focusOn(lat, lon, ms = 800) {
    if (!this._ready || !this._globe) return;

    try {
      const targetY = -lon * (Math.PI / 180);
      const targetX = -lat * (Math.PI / 180) * 0.4;
      const startY  = this._globe.rotation.y;
      const startX  = this._globe.rotation.x;
      const start   = performance.now();

      const tick = (now) => {
        const t = Math.min((now - start) / ms, 1);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOut
        if (this._globe) {
          this._globe.rotation.y = startY + (targetY - startY) * ease;
          this._globe.rotation.x = startX + (targetX - startX) * ease;
        }
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (err) {
      console.warn('[Globe] focusOn failed.', err);
    }
  }

  /**
   * Stop the animation loop and release all GPU resources.
   */
  destroy() {
    this._running = false;

    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    if (this._resizeObs) {
      this._resizeObs.disconnect();
      this._resizeObs = null;
    }

    if (this._globe) {
      this._globe.geometry?.dispose();
      this._globe.material?.dispose();
    }

    if (this._pin) {
      this._pin.geometry?.dispose();
      this._pin.material?.dispose();
    }

    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }

    console.info('[Globe] Destroyed and GPU resources released.');
  }
}
