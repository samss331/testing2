import { cleanFullResponse } from "@/ipc/utils/cleanFullResponse";
import { describe, it, expect } from "vitest";

describe("cleanFullResponse", () => {
  it("should replace < characters in ternary-write attributes", () => {
    const input = `<ternary-write path="src/file.tsx" description="Testing <a> tags.">content</ternary-write>`;
    const expected = `<ternary-write path="src/file.tsx" description="Testing ＜a＞ tags.">content</ternary-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should replace < characters in multiple attributes", () => {
    const input = `<ternary-write path="src/<component>.tsx" description="Testing <div> tags.">content</ternary-write>`;
    const expected = `<ternary-write path="src/＜component＞.tsx" description="Testing ＜div＞ tags.">content</ternary-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle multiple nested HTML tags in a single attribute", () => {
    const input = `<ternary-write path="src/file.tsx" description="Testing <div> and <span> and <a> tags.">content</ternary-write>`;
    const expected = `<ternary-write path="src/file.tsx" description="Testing ＜div＞ and ＜span＞ and ＜a＞ tags.">content</ternary-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle complex example with mixed content", () => {
    const input = `
      BEFORE TAG
  <ternary-write path="src/pages/locations/neighborhoods/louisville/Highlands.tsx" description="Updating Highlands neighborhood page to use <a> tags.">
import React from 'react';
</ternary-write>
AFTER TAG
    `;

    const expected = `
      BEFORE TAG
  <ternary-write path="src/pages/locations/neighborhoods/louisville/Highlands.tsx" description="Updating Highlands neighborhood page to use ＜a＞ tags.">
import React from 'react';
</ternary-write>
AFTER TAG
    `;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle other ternary tag types", () => {
    const input = `<ternary-rename from="src/<old>.tsx" to="src/<new>.tsx"></ternary-rename>`;
    const expected = `<ternary-rename from="src/＜old＞.tsx" to="src/＜new＞.tsx"></ternary-rename>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle ternary-delete tags", () => {
    const input = `<ternary-delete path="src/<component>.tsx"></ternary-delete>`;
    const expected = `<ternary-delete path="src/＜component＞.tsx"></ternary-delete>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should not affect content outside ternary tags", () => {
    const input = `Some text with <regular> HTML tags. <ternary-write path="test.tsx" description="With <nested> tags.">content</ternary-write> More <html> here.`;
    const expected = `Some text with <regular> HTML tags. <ternary-write path="test.tsx" description="With ＜nested＞ tags.">content</ternary-write> More <html> here.`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle empty attributes", () => {
    const input = `<ternary-write path="src/file.tsx">content</ternary-write>`;
    const expected = `<ternary-write path="src/file.tsx">content</ternary-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle attributes without < characters", () => {
    const input = `<ternary-write path="src/file.tsx" description="Normal description">content</ternary-write>`;
    const expected = `<ternary-write path="src/file.tsx" description="Normal description">content</ternary-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });
});
