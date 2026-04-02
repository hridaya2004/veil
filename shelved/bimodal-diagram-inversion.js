/* Bimodal Diagram Inversion - SHELVED (2026-04-02)
   * This code selectively inverted B/W diagrams (flowcharts, charts,
   * line drawings) in dark mode instead of protecting them. It
   * analyzed the brightness histogram of each image: if >70% of
   * pixels were either very bright (>200) or very dark (<55), and
   * >30% were white, the image was classified as a B/W diagram and
   * the CSS inversion was allowed to act on it. The result was
   * diagrams with dark backgrounds and light lines, readable in
   * dark mode instead of being bright white rectangles.
   *
   * The idea was proposed by AbanoubRodolf on Hacker News during
   * the launch thread, as a middle ground between never inverting
   * raster images (the current approach) and using a neural
   * classifier (proposed by gwern).
   *
   * It worked correctly on academic papers with simple diagrams,
   * but was removed after testing on Refactoring UI and other
   * image-heavy books because:
   *
   *   1. UI screenshots have the same bimodal brightness as
   *      diagrams: white background with dark UI elements. The
   *      histogram cannot distinguish a flowchart from a screenshot
   *      of a settings page or a website mockup. Most images in
   *      Refactoring UI were incorrectly inverted.
   *
   *   2. Protected images receive OCR in the web viewer, making
   *      text inside diagrams selectable and searchable. Inverting
   *      the image removes it from the protection list, and the OCR
   *      no longer runs on it. A white diagram with selectable text
   *      is more useful than a dark diagram with dead text.
   *
   *   3. The core promise of veil is "dark mode without destroying
   *      your images." Inverting any image, even one that looks
   *      better inverted, breaks this promise. The per-page toggle
   *      already covers users who want a specific page fully inverted.
   *
   * To restore: add the constants and isBimodalDiagram check below
   * to analyzeImageContent() in core.js (which currently only
   * returns isBlankPaper for Paper Capture detection), then add
   * the filtering logic to the regions filter in renderPageIfNeeded()
   * in app.js and exportPage() in export.js.
*/


// --- Constants (were in core.js) ---

// const IMAGE_BIMODAL_THRESHOLD = 0.70;
// const IMAGE_WHITE_RATIO_THRESHOLD = 0.30;


// --- Extended analyzeImageContent (was in core.js) ---
//
// The production version returns only { isBlankPaper }.
// This version also returned { isBimodalDiagram }.

// export function analyzeImageContent(pixelData, width, height) {
//   if (!pixelData || width <= 0 || height <= 0) {
//     return { isBlankPaper: false, isBimodalDiagram: false };
//   }
//
//   const stride = Math.max(1, Math.floor(Math.sqrt(width * height / 2500)));
//   let bright = 0;
//   let dark = 0;
//   let total = 0;
//
//   for (let y = 0; y < height; y += stride) {
//     for (let x = 0; x < width; x += stride) {
//       const idx = (y * width + x) * 4;
//       if (idx + 2 >= pixelData.length) continue;
//       const lum = 0.299 * pixelData[idx] + 0.587 * pixelData[idx + 1]
//                 + 0.114 * pixelData[idx + 2];
//       if (lum > 200) bright++;
//       if (lum < 55) dark++;
//       total++;
//     }
//   }
//
//   if (total === 0) return { isBlankPaper: false, isBimodalDiagram: false };
//
//   const brightRatio = bright / total;
//   const darkRatio = dark / total;
//   const bimodalRatio = (bright + dark) / total;
//
//   return {
//     isBlankPaper: brightRatio >= IMAGE_BLANK_PAPER_THRESHOLD,
//     isBimodalDiagram: bimodalRatio >= IMAGE_BIMODAL_THRESHOLD
//                    && brightRatio >= IMAGE_WHITE_RATIO_THRESHOLD,
//     brightRatio,
//     darkRatio,
//   };
// }


// --- Filtering logic (was in app.js renderPageIfNeeded
//     and export.js exportPage, after the Paper Capture check) ---

// const analysis = analyzeImageContent(imgData.data, rw, rh);
// if (analysis.isBimodalDiagram) {
//   return false; // remove from protection, CSS inverts it
// }