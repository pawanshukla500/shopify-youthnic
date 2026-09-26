/**
 * Pure TypeScript Code 128 Barcode Generator (Type B / C)
 * Generates an SVG string representation of Code 128 barcodes
 * Scannable on all 1D/2D thermal barcode scanners.
 */

const CODE128_PATTERNS: string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131',
  '211412', // 103: Start A
  '211214', // 104: Start B
  '211232', // 105: Start C
  '2331112' // 106: Stop
];

export function generateCode128Svg(
  text: string,
  options: { width?: number; height?: number; showText?: boolean; textBelow?: string } = {}
): string {
  const { width = 320, height = 75, showText = true, textBelow } = options;
  const clean = (text || '').replace(/[^0-9A-Za-z\-._]/g, '');
  if (!clean) return '';

  const startCode = 104; // Start B
  const codes: number[] = [startCode];

  for (let i = 0; i < clean.length; i++) {
    const charCode = clean.charCodeAt(i);
    if (charCode >= 32 && charCode <= 126) {
      codes.push(charCode - 32);
    } else {
      codes.push(0);
    }
  }

  let checksum = codes[0];
  for (let i = 1; i < codes.length; i++) {
    checksum += codes[i] * i;
  }
  codes.push(checksum % 103);
  codes.push(106); // Stop code

  let modules = '';
  for (const code of codes) {
    const pattern = CODE128_PATTERNS[code];
    if (!pattern) continue;
    let isBar = true;
    for (let j = 0; j < pattern.length; j++) {
      const runLen = parseInt(pattern[j], 10);
      modules += (isBar ? '1' : '0').repeat(runLen);
      isBar = !isBar;
    }
  }

  const barHeight = showText ? height - 16 : height;
  const moduleCount = modules.length;
  const moduleWidth = width / (moduleCount + 16);
  const startX = 8 * moduleWidth;

  let rects = '';
  let i = 0;
  while (i < modules.length) {
    if (modules[i] === '1') {
      let run = 0;
      while (i + run < modules.length && modules[i + run] === '1') {
        run++;
      }
      const x = (startX + i * moduleWidth).toFixed(1);
      const w = (run * moduleWidth).toFixed(1);
      rects += `<rect x="${x}" y="0" width="${w}" height="${barHeight}" fill="#000000" />`;
      i += run;
    } else {
      i++;
    }
  }

  const displayText = textBelow || clean.replace(/(\d{4})(?=\d)/g, '$1 ');
  const textElement = showText
    ? `<text x="${(width / 2).toFixed(1)}" y="${height - 2}" text-anchor="middle" font-family="'Courier New', Courier, monospace" font-size="13" font-weight="700" fill="#000000" letter-spacing="1.5">${displayText}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="max-width:100%;height:auto;display:block;margin:0 auto;">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${rects}
    ${textElement}
  </svg>`;
}
