import { describe, expect, it } from "vitest";
import { formDataToObject } from "@/server/action";

describe("formDataToObject", () => {
  it("turns repeated keys into arrays, in order, and skips Next's own fields", () => {
    const fd = new FormData();
    fd.append("$ACTION_ID_abc", "");
    fd.append("title", "Hello");
    fd.append("ids", "a");
    fd.append("ids", "b");
    fd.append("ids", "c");
    fd.append("file", new File(["x"], "form.pdf"));
    expect(formDataToObject(fd)).toEqual({ title: "Hello", ids: ["a", "b", "c"], file: "form.pdf" });
  });

  it("treats fields named like Object's own properties as plain fields", () => {
    const fd = new FormData();
    fd.append("constructor", "x");
    fd.append("toString", "y");
    fd.append("toString", "z");
    fd.append("__proto__", "w");
    const out = formDataToObject(fd);
    expect(out.constructor).toBe("x");
    expect(out.toString).toEqual(["y", "z"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("stays fast with tens of thousands of repeated keys (a ~5 MB request used to take seconds)", () => {
    const fd = new FormData();
    for (let i = 0; i < 80_000; i++) fd.append("sponsorshipIds", `id-${i}`);
    const started = performance.now();
    const out = formDataToObject(fd);
    // Appending in place is linear (a few ms); copying the array for each value took ~5 s here.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(out.sponsorshipIds).toHaveLength(80_000);
    expect((out.sponsorshipIds as string[])[79_999]).toBe("id-79999");
  });
});
