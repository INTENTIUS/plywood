import { describe, expect, it, vi } from "vitest";

// A chant that predates `base` (chant#5445): its ci-image exports no CI_IMAGE_BASE_FLOOR, and renders every image as Debian.
vi.mock("@intentius/chant/ci-image", async (importOriginal) => {
  const { CI_IMAGE_BASE_FLOOR: _floor, ...rest } = (await importOriginal()) as Record<string, unknown>;
  return rest;
});

const images = await import("../src/images");

describe("on a chant with no base for CI images", () => {
  it("refuses the Chainguard set with a message that names the floor, rather than rendering it as Debian", () => {
    expect(images.chantHasImageBase()).toBe(false);
    expect(() => images.dockerfile("pulumi", "chainguard")).toThrow(/CI_IMAGE_BASE_FLOOR/);
    expect(() => images.dockerfiles()).toThrow(/Chainguard images/);
    expect(() => images.imageRecipe("pulumi", [], undefined, "chainguard")).toThrow(/CI_IMAGE_BASE_FLOOR/);
  });

  it("keeps the Debian set working", () => {
    expect(images.dockerfile("pulumi")).toContain("FROM node:22-bookworm-slim@sha256:");
    expect(images.imageRecipe("pulumi", [])).toContain("RUN chmod -R a+rX");
  });
});
