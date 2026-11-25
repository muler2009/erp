const files = import.meta.glob(["../**/*.tsx", "!../**/*.test.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// Found in the real-browser pass: tab bars without wrapping pushed pages wider than a phone screen.
it("every tab bar can wrap onto a second line", () => {
  const bad: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    text.split("\n").forEach((line, i) => {
      const at = line.indexOf('role="tablist"');
      if (at < 0) return;
      const cls = /className="([^"]*)"/.exec(line.slice(at))?.[1] ?? "";
      if (!cls.includes("flex-wrap")) bad.push(`${file}:${i + 1}`);
    });
  }
  expect(Object.keys(files).length).toBeGreaterThan(100);
  expect(bad).toEqual([]);
});
