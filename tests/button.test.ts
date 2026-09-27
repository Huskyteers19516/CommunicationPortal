import { describe, expect, it } from "vitest";
import { buttonClasses } from "@/components/ui/button";

const tokens = (classes: string) => classes.split(/\s+/);

// Tailwind picks between conflicting utilities by stylesheet order, not class order, so a caller's
// padding only works if the size's own padding is left out.
describe("buttonClasses", () => {
  it("uses each size's padding by default", () => {
    expect(tokens(buttonClasses("primary", "md"))).toEqual(expect.arrayContaining(["h-10", "px-4"]));
    expect(tokens(buttonClasses("secondary", "sm"))).toEqual(expect.arrayContaining(["h-8", "px-3"]));
    expect(tokens(buttonClasses("primary", "lg"))).toEqual(expect.arrayContaining(["h-12", "px-5"]));
  });

  it("makes icon buttons a 40px square with no padding", () => {
    const classes = tokens(buttonClasses("secondary", "icon"));
    expect(classes).toEqual(expect.arrayContaining(["size-10", "p-0", "shrink-0"]));
    expect(classes).not.toContain("px-4");
    expect(classes).not.toContain("h-10");
  });

  it("lets a caller's own padding replace the size's", () => {
    const tight = tokens(buttonClasses("ghost", "md", "px-2.5"));
    expect(tight).toContain("px-2.5");
    expect(tight).not.toContain("px-4");
    expect(tokens(buttonClasses("ghost", "md", "p-0 w-10"))).not.toContain("px-4");
  });

  it("keeps the size's padding next to responsive or unrelated classes", () => {
    expect(tokens(buttonClasses("ghost", "icon", "sm:w-auto sm:px-3"))).toEqual(expect.arrayContaining(["p-0", "sm:px-3"]));
    expect(tokens(buttonClasses("primary", "md", "w-full py-1 sm:w-auto"))).toContain("px-4");
  });
});
