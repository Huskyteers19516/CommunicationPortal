import { describe, expect, it } from "vitest";
import { normalizeLineBreaks, optionalText, text } from "@/lib/validation";
import { formDataToObject, runAction } from "@/server/action";
import { ConflictError } from "@/server/errors";

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

describe("text / optionalText line breaks", () => {
  // A textarea's maxLength counts a line break as one character, but browsers send each as CRLF.
  const typed = ["Team address: 123 Example Ave", "Contact: Ms. Rivera", "Links: https://example.com"].join("\n");
  const sent = typed.replace(/\n/g, "\r\n");

  it("turns CRLF and lone CR into \\n before trimming and counting", () => {
    expect(normalizeLineBreaks("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(text("Info", typed.length).parse(`${sent}\r\n`)).toBe(typed);
    expect(optionalText("Info", typed.length).parse(`\r\n${sent}`)).toBe(typed);
    expect(text("Info", typed.length - 1).safeParse(sent).success).toBe(false);
    expect(optionalText("Info", typed.length - 1).safeParse(sent).success).toBe(false);
  });

  it("still treats line breaks alone as empty", () => {
    expect(text("Info", 10).safeParse("\r\n\r\n").success).toBe(false);
    expect(optionalText("Info", 10).parse("\r\n \r")).toBeUndefined();
  });
});

describe("runAction", () => {
  it("passes an error's code on to the page (e.g. a task marked finished meanwhile), and only when there is one", async () => {
    const coded = await runAction(async () => {
      throw new ConflictError("Blake marked the whole task finished — it counts as done for you.", "taskFinishedCounted");
    });
    expect(coded).toMatchObject({ ok: false, code: "taskFinishedCounted", message: "Blake marked the whole task finished — it counts as done for you." });
    const plain = await runAction(async () => {
      throw new ConflictError("Already reviewed.");
    });
    expect(plain).toMatchObject({ ok: false, message: "Already reviewed." });
    expect(plain && "code" in plain).toBe(false);
  });
});
