import { generateMSDF } from '@zephyr3d/scene';
import type { GlyphData } from '@zephyr3d/scene';

describe('generateMSDF', () => {
  test('encodes distances in output pixel units instead of font units', () => {
    const glyph: GlyphData = {
      glyphIndex: 1,
      advanceWidth: 1000,
      leftSideBearing: 0,
      xMin: 0,
      yMin: 0,
      xMax: 1000,
      yMax: 1000,
      contours: [
        [
          { x: 0, y: 0, onCurve: true },
          { x: 1000, y: 0, onCurve: true },
          { x: 1000, y: 1000, onCurve: true },
          { x: 0, y: 1000, onCurve: true }
        ]
      ]
    };

    const bitmap = generateMSDF(glyph, {
      width: 16,
      height: 16,
      padding: 2,
      range: 4
    });

    const justOutside = ((8 * bitmap.width + 1) * 4) | 0;
    const justInside = ((8 * bitmap.width + 2) * 4) | 0;

    expect(bitmap.pixels[justOutside + 3]).toBeGreaterThanOrEqual(108);
    expect(bitmap.pixels[justOutside + 3]).toBeLessThanOrEqual(116);
    expect(bitmap.pixels[justInside + 3]).toBeGreaterThanOrEqual(140);
    expect(bitmap.pixels[justInside + 3]).toBeLessThanOrEqual(146);
  });
});
