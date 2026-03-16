/* ═══════════════════════════════════════
   VEIL LANDING — Vanilla JS
   ═══════════════════════════════════════ */

(function () {
  "use strict";

  const isMobile = () => window.innerWidth < 700;

  /* ═══ NAVBAR SCROLL ═══ */
  const nav = document.getElementById("navbar");
  window.addEventListener("scroll", () => {
    nav.classList.toggle("scrolled", window.scrollY > 50);
  }, { passive: true });

  /* ═══ REDUCED MOTION CHECK ═══ */
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ═══ ROTATING TEXT ═══ */
  const WORDS = [
    "histology slides", "research charts", "circuit diagrams",
    "X-ray scans", "architecture plans", "data visualizations",
    "patient records", "scientific figures", "technical manuals",
    "financial reports", "lecture slides", "legal documents",
    "lab notebooks", "scanned books", "textbook chapters",
  ];
  let wordIdx = 0;
  const rotEl = document.getElementById("rotating-text");
  if (!prefersReducedMotion) {
    setInterval(() => {
      rotEl.classList.add("fade-out");
      setTimeout(() => {
        wordIdx = (wordIdx + 1) % WORDS.length;
        rotEl.textContent = WORDS[wordIdx];
        rotEl.classList.remove("fade-out");
      }, 350);
    }, 2600);
  }

  /* ═══ BEFORE/AFTER BAR CHARTS ═══ */
  const veilColors = ["#e74c3c", "#2ecc71", "#3498db", "#9b59b6", "#f39c12", "#1abc9c"];
  const othersColors = ["#18b3c3", "#d1338e", "#cb6724", "#64a649", "#0c63ed", "#e54363"];
  const heights = [0.6, 0.85, 0.45, 0.72, 0.9, 0.55];

  function buildBars(container, colors) {
    heights.forEach((h, i) => {
      const bar = document.createElement("div");
      bar.style.cssText = `flex:1;height:${h * 100}%;background:${colors[i]};border-radius:2px 2px 0 0;opacity:0.9`;
      container.appendChild(bar);
    });
  }
  buildBars(document.getElementById("veil-bars"), veilColors);
  buildBars(document.getElementById("others-bars"), othersColors);

  /* ═══ BEFORE/AFTER SLIDER ═══ */
  let pos = 50;
  const baContainer = document.getElementById("ba-container");
  const baVeil = document.getElementById("ba-veil");
  const baSlider = document.getElementById("ba-slider");
  let dragging = false;
  let touchStartPos = null;
  let directionLocked = null;

  function updateSlider() {
    baVeil.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
    baSlider.style.left = pos + "%";
    baSlider.setAttribute("aria-valuenow", Math.round(pos));
  }

  function moveSlider(cx) {
    const r = baContainer.getBoundingClientRect();
    pos = Math.max(0, Math.min(100, ((cx - r.left) / r.width) * 100));
    updateSlider();
  }

  // Keyboard: arrow keys on focused slider
  baSlider.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { pos = Math.max(0, pos - 2); updateSlider(); e.preventDefault(); }
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { pos = Math.min(100, pos + 2); updateSlider(); e.preventDefault(); }
  });

  // Desktop: click anywhere
  baContainer.addEventListener("mousedown", () => { dragging = true; });
  window.addEventListener("mousemove", (e) => { if (dragging) moveSlider(e.clientX); });
  window.addEventListener("mouseup", () => { dragging = false; });

  // Mobile: touch only on slider, with direction detection
  baSlider.addEventListener("touchstart", (e) => {
    touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (!touchStartPos) return;
    const dx = Math.abs(e.touches[0].clientX - touchStartPos.x);
    const dy = Math.abs(e.touches[0].clientY - touchStartPos.y);
    if (!directionLocked && (dx > 4 || dy > 4)) {
      directionLocked = dx >= dy ? "horizontal" : "vertical";
      if (directionLocked === "horizontal") dragging = true;
    }
    if (directionLocked === "horizontal") {
      e.preventDefault();
      moveSlider(e.touches[0].clientX);
    }
  }, { passive: false });

  window.addEventListener("touchend", () => {
    dragging = false;
    touchStartPos = null;
    directionLocked = null;
  });

  /* ═══ EXPLODED LAYERS ═══ */
  const layersSection = document.getElementById("layers-section");
  const layersStack = document.getElementById("layers-stack");
  const annotLeft = document.getElementById("annot-left");
  const annotRight = document.getElementById("annot-right");
  const mobileAnnot = document.getElementById("mobile-annot");
  let scrollProgress = 0;
  let replayProgress = null;
  let replayRaf = null;

  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  function buildLayers() {
    const mob = isMobile();
    const winW = window.innerWidth;
    const LW = mob ? Math.min(winW - 48, 280) : 290;
    const LH = mob ? Math.round(LW * 0.69) : 200;
    const p = ease(replayProgress !== null ? replayProgress : scrollProgress);
    const spread = 1 - p;
    const layerGap = spread * (mob ? 65 : 90);
    const tiltX = spread * 12;
    const stackHeight = LH + layerGap * 2 + 40;
    const annoOpacity = Math.max(0, (p - 0.3) / 0.7);

    layersStack.style.width = LW + "px";
    layersStack.style.height = stackHeight + "px";
    layersStack.style.perspective = (mob ? 600 : 800) + "px";

    // Build inner HTML
    let html = "";

    // Layer 1: Original PDF
    html += buildDocLayer(0, layerGap * 2 + 20, LW, LH, tiltX, spread,
      "Original PDF", "#9a8878", "0 8px 24px rgba(0,0,0,0.15)",
      "#f5f0ea", "#3a3028", 0.25, 0.18, mob, false);

    // Layer 2: Dark Inversion
    html += buildDocLayer(1, layerGap + 10, LW, LH, tiltX, spread,
      "Dark Inversion", "#7a6b5e", `0 12px 32px rgba(0,0,0,${0.2 + spread * 0.15})`,
      "#1e1915", "#c4b5a3", 0.35, 0.25, mob, true);

    // Layer 3: Image + Text Layer
    html += buildTransparentLayer(2, 0, LW, LH, tiltX, spread, mob);

    // Connectors
    if (spread > 0.15) {
      const a = spread * 0.3;
      html += `<div class="layer-connector" style="left:${LW/2}px;top:${LH-2}px;height:${layerGap+12}px;background:rgba(212,163,115,${a})"></div>`;
      html += `<div class="layer-connector" style="left:${LW/2}px;top:${LH+layerGap+8}px;height:${layerGap+12}px;background:rgba(212,163,115,${a})"></div>`;
    }

    // Result badge
    const badgeOp = p > 0.85 ? (p - 0.85) / 0.15 : 0;
    html += `<div class="layers-result" style="opacity:${badgeOp}">Dark mode <span class="sep">/</span> Images protected <span class="sep">/</span> Text selectable</div>`;

    layersStack.innerHTML = html;

    // Annotations opacity
    if (annotLeft) {
      annotLeft.style.opacity = annoOpacity;
      annotLeft.style.transform = `translateX(${(1 - annoOpacity) * -20}px)`;
    }
    if (annotRight) {
      annotRight.style.opacity = annoOpacity;
      annotRight.style.transform = `translateX(${(1 - annoOpacity) * 20}px)`;
    }
    if (mobileAnnot) {
      mobileAnnot.style.opacity = annoOpacity;
      mobileAnnot.style.transform = `translateY(${(1 - annoOpacity) * 12}px)`;
    }
  }

  function buildDocLayer(idx, top, w, h, tiltX, spread, label, labelColor, shadow, bg, lineColor, opTop, opBot, mob, inverted) {
    const n1 = mob ? 3 : 4, n2 = mob ? 1 : 2;
    const imgH = mob ? 40 : 60;
    const labelOp = spread > 0.2 ? 1 : 0;
    let border = inverted ? "border:1px solid rgba(212,163,115,0.1);border-radius:10px;" : "";
    let lines1 = docLinesHtml(lineColor, opTop, n1, mob);
    let lines2 = docLinesHtml(lineColor, opBot, n2, mob);
    let img = imgBlockHtml(inverted, imgH, mob);
    return `<div class="doc-layer" style="top:${top}px;width:${w}px;height:${h}px;transform:rotateX(${tiltX}deg);box-shadow:${shadow}">
      <div style="background:${bg};width:100%;height:100%;${border}">${lines1}${img}${lines2}</div>
      <div class="doc-layer-label" style="color:${labelColor};opacity:${labelOp}">${label}</div>
    </div>`;
  }

  function buildTransparentLayer(idx, top, w, h, tiltX, spread, mob) {
    const imgH = mob ? 40 : 60;
    const borderOp = 0.08 + spread * 0.12;
    const labelOp = spread > 0.2 ? 1 : 0;
    const pad = mob ? "6px 12px" : "8px 16px";
    const dotH = mob ? 3 : 4;
    const spacerH = mob ? 46 : 68;
    const shadow = `0 16px 40px rgba(0,0,0,${0.15 + spread * 0.1})`;
    const sunSize = mob ? 9 : 13;
    const mtnBH = mob ? 28 : 42;
    const mtnFH = mob ? 22 : 33;
    return `<div class="doc-layer" style="top:${top}px;width:${w}px;height:${h}px;transform:rotateX(${tiltX}deg);box-shadow:${shadow}">
      <div style="background:transparent;width:100%;height:100%;border:1px solid rgba(212,163,115,${borderOp});border-radius:10px">
        <div style="height:${spacerH}px"></div>
        <div style="margin:0 ${mob?12:16}px;height:${imgH}px;border-radius:5px;background:linear-gradient(180deg,#5ba3d9,#87CEEB);position:relative;overflow:hidden;box-shadow:0 2px 12px rgba(135,206,235,0.15)">
          <div style="position:absolute;bottom:0;left:8%;width:0;height:0;border-left:24px solid transparent;border-right:24px solid transparent;border-bottom:${mtnBH}px solid #6b7b8a"></div>
          <div style="position:absolute;bottom:0;right:12%;width:0;height:0;border-left:18px solid transparent;border-right:18px solid transparent;border-bottom:${mtnFH}px solid #556270"></div>
          <div style="position:absolute;bottom:0;left:0;right:0;height:18%;background:#7a8a6a"></div>
          <div style="position:absolute;top:14%;right:20%;width:${sunSize}px;height:${sunSize}px;border-radius:50%;background:#ffd700"></div>
        </div>
        <div style="padding:${pad};display:flex;flex-direction:column;gap:${mob?3:4}px">
          <div style="height:${dotH}px;width:70%;background:rgba(212,163,115,0.12);border-radius:2px"></div>
          <div style="height:${dotH}px;width:55%;background:rgba(212,163,115,0.08);border-radius:2px"></div>
        </div>
      </div>
      <div class="doc-layer-label" style="color:#D4A373;opacity:${labelOp}">Image + Text Layer</div>
    </div>`;
  }

  function docLinesHtml(color, opacity, n, mob) {
    let html = `<div class="doc-lines">`;
    for (let i = 0; i < n; i++) {
      const h = i === 0 ? (mob ? 5 : 7) : (mob ? 4 : 5);
      const w = i === 0 ? 50 : 60 + Math.sin(i * 2.3) * 20;
      const o = i === 0 ? opacity + 0.1 : opacity;
      html += `<div class="doc-line" style="height:${h}px;width:${w}%;background:${color};opacity:${o}"></div>`;
    }
    html += `</div>`;
    return html;
  }

  function imgBlockHtml(inverted, h, mob) {
    const margin = mob ? "0 12px" : "0 16px";
    const bg = inverted
      ? "linear-gradient(180deg,#a45c26,#572715)"
      : "linear-gradient(180deg,#5ba3d9,#87CEEB)";
    const mtnB = inverted ? "#948475" : "#6b7b8a";
    const mtnF = inverted ? "#aa9d8f" : "#556270";
    const ground = inverted ? "#857595" : "#7a8a6a";
    const sun = inverted ? "#0028ff" : "#ffd700";
    const bL = Math.round(h * 0.5), bR = bL, bB = Math.round(h * 0.7);
    const fL = Math.round(h * 0.38), fR = fL, fB = Math.round(h * 0.55);
    const sS = Math.round(h * 0.22);
    return `<div class="doc-img-block" style="height:${h}px;background:${bg};margin:${margin}">
      <div style="position:absolute;bottom:0;left:8%;width:0;height:0;border-left:${bL}px solid transparent;border-right:${bR}px solid transparent;border-bottom:${bB}px solid ${mtnB}"></div>
      <div style="position:absolute;bottom:0;right:12%;width:0;height:0;border-left:${fL}px solid transparent;border-right:${fR}px solid transparent;border-bottom:${fB}px solid ${mtnF}"></div>
      <div style="position:absolute;bottom:0;left:0;right:0;height:18%;background:${ground}"></div>
      <div style="position:absolute;top:14%;right:20%;width:${sS}px;height:${sS}px;border-radius:50%;background:${sun}"></div>
    </div>`;
  }

  // Scroll listener
  window.addEventListener("scroll", () => {
    if (!layersSection) return;
    const rect = layersSection.getBoundingClientRect();
    const vh = window.innerHeight;
    scrollProgress = Math.max(0, Math.min(1, 1 - (rect.top - vh * -0.05) / (vh * 0.7 - vh * -0.05)));
    if (replayProgress === null) buildLayers();
  }, { passive: true });

  // Replay on click (disabled for reduced motion)
  if (!prefersReducedMotion) {
    layersStack.addEventListener("click", () => {
      if (replayRaf) cancelAnimationFrame(replayRaf);
      const start = performance.now();
      replayProgress = 0;
      function go(now) {
        const t = Math.min(1, (now - start) / 2000);
        replayProgress = t;
        buildLayers();
        if (t < 1) {
          replayRaf = requestAnimationFrame(go);
        } else {
          setTimeout(() => { replayProgress = null; buildLayers(); }, 800);
        }
      }
      replayRaf = requestAnimationFrame(go);
    });
  }

  // Initial build
  buildLayers();

  // Rebuild on resize
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => buildLayers(), 100);
  });

})();
