import { imageFor, imageReference, type EngineName } from "../src/images";

/**
 * The image a pipeline names for `engine`: by digest only, so the commit that
 * bumps the version, before the release's images are recorded in
 * image-digests.json, names none.
 */
export function publishedImage(engine: EngineName): string | undefined {
  const ref = imageFor(engine);
  return ref.digest ? imageReference(ref) : undefined;
}
