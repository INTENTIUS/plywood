import { imageFor, imageReference, type EngineName } from "../src/images";

/**
 * The image a pipeline names for `engine`, when the build carries the
 * release's digests (a release's build, from CHANT_RELEASE_DIGESTS); a build
 * outside a release names none.
 */
export function publishedImage(engine: EngineName): string | undefined {
  const ref = imageFor(engine);
  return ref.digest ? imageReference(ref) : undefined;
}
