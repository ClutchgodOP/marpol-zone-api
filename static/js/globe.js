/**
 * globe.js — Three.js 3D rotating Earth for the hero section.
 * Classic script (no ES module syntax). Exposes GlobeController globally.
 * Defensive: if THREE is missing, GlobeController becomes a no-op stub.
 */
(function (global) {
  'use strict';

  if (typeof THREE === 'undefined') {
    console.warn('[GlobeController] Three.js not available — globe disabled.');
    global.GlobeController = function () {
      this.setPin = function () {};
      this.destroy = function () {};
    };
    return;
  }

  var EARTH_TEXTURE  = 'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg';
  var EARTH_SPECULAR = 'https://threejs.org/examples/textures/planets/earth_specular_2048.jpg';
  var EARTH_CLOUDS   = 'https://threejs.org/examples/textures/planets/earth_clouds_1024.png';

  function GlobeController(canvasId) {
    this._canvas  = document.getElementById(canvasId);
    this._pinMesh = null;
    this._pinRing = null;
    this._running = true;

    if (!this._canvas) {
      console.warn('[GlobeController] Canvas element #' + canvasId + ' not found.');
      this._running = false;
      return;
    }

    try {
      this._initRenderer();
      this._initScene();
      this._initGlobe();
      this._initClouds();
      this._initAtmosphere();
      this._initStars();
      this._initLights();
      this._bindResize();
      this._animate();
    } catch (err) {
      console.error('[GlobeController] Initialization failed:', err);
      this._running = false;
    }
  }

  GlobeController.prototype._initRenderer = function () {
    this._renderer = new THREE.WebGLRenderer({ canvas: this._canvas, antialias: true, alpha: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(this._canvas.clientWidth || 800, this._canvas.clientHeight || 480);
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
  };

  GlobeController.prototype._initScene = function () {
    this._scene  = new THREE.Scene();
    var w = this._canvas.clientWidth || 800;
    var h = this._canvas.clientHeight || 480;
    this._camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    this._camera.position.set(0, 0, 2.8);
  };

  GlobeController.prototype._initGlobe = function () {
    var loader = new THREE.TextureLoader();
    var geo = new THREE.SphereGeometry(1, 96, 96);
    var mat = new THREE.MeshPhongMaterial({
      map:         loader.load(EARTH_TEXTURE),
      specularMap: loader.load(EARTH_SPECULAR),
      specular:    new THREE.Color('#333333'),
      shininess:   12,
    });
    this._globe = new THREE.Mesh(geo, mat);
    this._scene.add(this._globe);
  };

  GlobeController.prototype._initClouds = function () {
    var loader = new THREE.TextureLoader();
    var geo = new THREE.SphereGeometry(1.012, 96, 96);
    var mat = new THREE.MeshPhongMaterial({
      map: loader.load(EARTH_CLOUDS),
      transparent: true, opacity: 0.35, depthWrite: false,
    });
    this._clouds = new THREE.Mesh(geo, mat);
    this._scene.add(this._clouds);
  };

  GlobeController.prototype._initAtmosphere = function () {
    var geo = new THREE.SphereGeometry(1.06, 64, 64);
    var mat = new THREE.ShaderMaterial({
      uniforms: { glowColor: { value: new THREE.Color('#00d4ff') } },
      vertexShader: [
        'varying vec3 vNormal;',
        'void main() {',
        '  vNormal = normalize(normalMatrix * normal);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vNormal;',
        'uniform vec3 glowColor;',
        'void main() {',
        '  float intensity = pow(0.65 - dot(vNormal, vec3(0,0,1.0)), 3.0);',
        '  gl_FragColor = vec4(glowColor, intensity * 0.9);',
        '}'
      ].join('\n'),
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false,
    });
    this._scene.add(new THREE.Mesh(geo, mat));
  };

  GlobeController.prototype._initStars = function () {
    var count = 2400, verts = [];
    for (var i = 0; i < count; i++) {
      var theta = Math.random() * Math.PI * 2;
      var phi   = Math.acos(2 * Math.random() - 1);
      var r     = 8 + Math.random() * 6;
      verts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi)
      );
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    var mat = new THREE.PointsMaterial({ color: 0xaaccff, size: 0.045, transparent: true, opacity: 0.75 });
    this._scene.add(new THREE.Points(geo, mat));
  };

  GlobeController.prototype._initLights = function () {
    var sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(5, 3, 5);
    this._scene.add(sun);
    this._scene.add(new THREE.AmbientLight(0x223344, 1.1));
  };

  GlobeController.prototype._bindResize = function () {
    var self = this;
    if (typeof ResizeObserver !== 'undefined' && this._canvas.parentElement) {
      new ResizeObserver(function () {
        var w = self._canvas.clientWidth || 800;
        var h = self._canvas.clientHeight || 480;
        self._renderer.setSize(w, h, false);
        self._camera.aspect = w / h;
        self._camera.updateProjectionMatrix();
      }).observe(this._canvas.parentElement);
    }
  };

  GlobeController.prototype._animate = function () {
    if (!this._running) return;
    var self = this;
    requestAnimationFrame(function () { self._animate(); });
    this._globe.rotation.y  += 0.0013;
    this._clouds.rotation.y += 0.0019;
    if (this._pinMesh) {
      this._pinMesh.rotation.y = this._globe.rotation.y;
      var t = performance.now() * 0.003;
      var scale = 1 + Math.sin(t) * 0.25;
      if (this._pinRing) this._pinRing.scale.setScalar(scale);
    }
    this._renderer.render(this._scene, this._camera);
  };

  GlobeController.prototype.setPin = function (lat, lon, status) {
    if (!this._running || !this._scene) return;
    try {
      if (this._pinMesh) { this._scene.remove(this._pinMesh); this._pinMesh = null; }

      var phi   = (90 - lat)  * (Math.PI / 180);
      var theta = (lon + 180) * (Math.PI / 180);
      var r = 1.05;
      var x = -r * Math.sin(phi) * Math.cos(theta);
      var y =  r * Math.cos(phi);
      var z =  r * Math.sin(phi) * Math.sin(theta);

      var color = (status === 'SAFE') ? 0x00e676 : 0xff6b35;
      var group = new THREE.Group();

      var core = new THREE.Mesh(
        new THREE.SphereGeometry(0.026, 16, 16),
        new THREE.MeshBasicMaterial({ color: color })
      );
      core.position.set(x, y, z);
      group.add(core);

      var ring = new THREE.Mesh(
        new THREE.RingGeometry(0.035, 0.05, 32),
        new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
      );
      ring.position.set(x, y, z);
      ring.lookAt(new THREE.Vector3(x * 2, y * 2, z * 2));
      group.add(ring);
      this._pinRing = ring;

      this._pinMesh = group;
      this._scene.add(this._pinMesh);

      var targetY = -theta + Math.PI;
      this._globe.rotation.y  = targetY;
      this._clouds.rotation.y = targetY;
    } catch (err) {
      console.error('[GlobeController] setPin failed:', err);
    }
  };

  GlobeController.prototype.destroy = function () {
    this._running = false;
    if (this._renderer) this._renderer.dispose();
  };

  global.GlobeController = GlobeController;

}(window));
