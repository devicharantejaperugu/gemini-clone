/**
 * SoftAurora — WebGL Background Shader
 * Flowing aurora bands with noise, mouse interaction, and smooth colors.
 */
(function () {
    // ─── Config ────────────────────────────────────────────
    const CONFIG = {
        speed: 0.6,
        scale: 1.5,
        brightness: 1.0,
        color1: [0.969, 0.969, 0.969],    // #f7f7f7
        color2: [0.882, 0.0, 1.0],         // #e100ff
        noiseFrequency: 2.5,
        noiseAmplitude: 1.0,
        bandHeight: 0.5,
        bandSpread: 1.0,
        octaveDecay: 0.1,
        layerOffset: 0.0,
        colorSpeed: 1.0,
        mouseInfluence: 0.25,
    };

    // ─── Setup Canvas ──────────────────────────────────────
    const canvas = document.createElement('canvas');
    canvas.id = 'aurora-bg';
    document.body.prepend(canvas);

    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
    if (!gl) { console.warn('WebGL not supported'); return; }

    // ─── Mouse tracking ────────────────────────────────────
    let mouse = { x: 0.5, y: 0.5 };
    document.addEventListener('mousemove', (e) => {
        mouse.x = e.clientX / window.innerWidth;
        mouse.y = 1.0 - (e.clientY / window.innerHeight);
    });

    // ─── Shaders ───────────────────────────────────────────
    const vertSrc = `
        attribute vec2 a_position;
        void main() {
            gl_Position = vec4(a_position, 0.0, 1.0);
        }
    `;

    const fragSrc = `
        precision highp float;

        uniform float u_time;
        uniform vec2  u_resolution;
        uniform vec2  u_mouse;
        uniform float u_speed;
        uniform float u_scale;
        uniform float u_brightness;
        uniform vec3  u_color1;
        uniform vec3  u_color2;
        uniform float u_noiseFreq;
        uniform float u_noiseAmp;
        uniform float u_bandHeight;
        uniform float u_bandSpread;
        uniform float u_octaveDecay;
        uniform float u_layerOffset;
        uniform float u_colorSpeed;
        uniform float u_mouseInfluence;

        // Simplex-like noise helpers
        vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec2 mod289v2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

        float snoise(vec2 v) {
            const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                               -0.577350269189626, 0.024390243902439);
            vec2 i  = floor(v + dot(v, C.yy));
            vec2 x0 = v - i + dot(i, C.xx);
            vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
            vec4 x12 = x0.xyxy + C.xxzz;
            x12.xy -= i1;
            i = mod289v2(i);
            vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                           + i.x + vec3(0.0, i1.x, 1.0));
            vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
                                     dot(x12.zw,x12.zw)), 0.0);
            m = m * m;
            m = m * m;
            vec3 x_ = 2.0 * fract(p * C.www) - 1.0;
            vec3 h = abs(x_) - 0.5;
            vec3 ox = floor(x_ + 0.5);
            vec3 a0 = x_ - ox;
            m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
            vec3 g;
            g.x = a0.x * x0.x + h.x * x0.y;
            g.yz = a0.yz * x12.xz + h.yz * x12.yw;
            return 130.0 * dot(m, g);
        }

        float fbm(vec2 p, float t) {
            float value = 0.0;
            float amplitude = u_noiseAmp;
            float frequency = u_noiseFreq;
            for (int i = 0; i < 5; i++) {
                value += amplitude * snoise(p * frequency + t * 0.3);
                frequency *= 2.0;
                amplitude *= u_octaveDecay + 0.4;
            }
            return value;
        }

        void main() {
            vec2 uv = gl_FragCoord.xy / u_resolution;
            float aspect = u_resolution.x / u_resolution.y;
            vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * u_scale;

            float t = u_time * u_speed;

            // Mouse distortion
            vec2 mouseOffset = (u_mouse - 0.5) * u_mouseInfluence;
            p += mouseOffset;

            // Aurora band layers
            float aurora = 0.0;

            for (int i = 0; i < 3; i++) {
                float fi = float(i);
                float offset = fi * u_layerOffset + fi * 0.4;
                vec2 np = p + vec2(offset, fi * 0.2);
                
                float noise = fbm(np, t + fi * 1.3);
                
                // Band shape
                float band = uv.y + noise * u_bandSpread * 0.3;
                float center = 0.5 + sin(t * 0.5 + fi * 2.0) * 0.15;
                float dist = abs(band - center);
                float intensity = smoothstep(u_bandHeight, 0.0, dist);
                intensity *= intensity;
                
                aurora += intensity * (1.0 - fi * 0.25);
            }

            aurora = clamp(aurora, 0.0, 1.0);

            // Color mixing
            float colorPhase = sin(uv.x * 3.14159 + t * u_colorSpeed) * 0.5 + 0.5;
            vec3 auroraColor = mix(u_color1, u_color2, colorPhase);

            // Subtle secondary hue
            vec3 accent = vec3(0.263, 0.522, 0.957); // #4285f4
            float accentMix = sin(uv.y * 6.28 + t * 0.7) * 0.5 + 0.5;
            auroraColor = mix(auroraColor, accent, accentMix * 0.15);

            // Background base color (dark)
            vec3 bgColor = vec3(0.075, 0.075, 0.078); // matches --bg-main #131314

            // Composite
            float alpha = aurora * u_brightness * 0.35;
            vec3 finalColor = mix(bgColor, auroraColor, alpha);

            // Subtle vignette
            float vignette = 1.0 - length((uv - 0.5) * 1.2);
            vignette = smoothstep(0.0, 0.7, vignette);
            finalColor *= vignette * 0.3 + 0.7;

            gl_FragColor = vec4(finalColor, 1.0);
        }
    `;

    // ─── Compile shaders ───────────────────────────────────
    function createShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    const vert = createShader(gl.VERTEX_SHADER, vertSrc);
    const frag = createShader(gl.FRAGMENT_SHADER, fragSrc);
    if (!vert || !frag) return;

    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program));
        return;
    }
    gl.useProgram(program);

    // ─── Fullscreen quad ───────────────────────────────────
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // ─── Uniforms ──────────────────────────────────────────
    const uniforms = {};
    const uNames = [
        'u_time', 'u_resolution', 'u_mouse', 'u_speed', 'u_scale',
        'u_brightness', 'u_color1', 'u_color2', 'u_noiseFreq',
        'u_noiseAmp', 'u_bandHeight', 'u_bandSpread', 'u_octaveDecay',
        'u_layerOffset', 'u_colorSpeed', 'u_mouseInfluence'
    ];
    uNames.forEach(name => { uniforms[name] = gl.getUniformLocation(program, name); });

    // ─── Resize ────────────────────────────────────────────
    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = window.innerWidth * dpr;
        canvas.height = window.innerHeight * dpr;
        canvas.style.width = window.innerWidth + 'px';
        canvas.style.height = window.innerHeight + 'px';
        gl.viewport(0, 0, canvas.width, canvas.height);
    }
    window.addEventListener('resize', resize);
    resize();

    // ─── Render loop ───────────────────────────────────────
    let startTime = performance.now();

    function render() {
        const elapsed = (performance.now() - startTime) / 1000.0;

        gl.uniform1f(uniforms.u_time, elapsed);
        gl.uniform2f(uniforms.u_resolution, canvas.width, canvas.height);
        gl.uniform2f(uniforms.u_mouse, mouse.x, mouse.y);
        gl.uniform1f(uniforms.u_speed, CONFIG.speed);
        gl.uniform1f(uniforms.u_scale, CONFIG.scale);
        gl.uniform1f(uniforms.u_brightness, CONFIG.brightness);
        gl.uniform3fv(uniforms.u_color1, CONFIG.color1);
        gl.uniform3fv(uniforms.u_color2, CONFIG.color2);
        gl.uniform1f(uniforms.u_noiseFreq, CONFIG.noiseFrequency);
        gl.uniform1f(uniforms.u_noiseAmp, CONFIG.noiseAmplitude);
        gl.uniform1f(uniforms.u_bandHeight, CONFIG.bandHeight);
        gl.uniform1f(uniforms.u_bandSpread, CONFIG.bandSpread);
        gl.uniform1f(uniforms.u_octaveDecay, CONFIG.octaveDecay);
        gl.uniform1f(uniforms.u_layerOffset, CONFIG.layerOffset);
        gl.uniform1f(uniforms.u_colorSpeed, CONFIG.colorSpeed);
        gl.uniform1f(uniforms.u_mouseInfluence, CONFIG.mouseInfluence);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
        requestAnimationFrame(render);
    }

    render();
})();
