// What bin.ts does before anything else: a .op.ts file plywood init writes into a project imports
// @intentius/chant, and Node resolves that import from the project's directory. The tests run init
// in temp directories with no node_modules, so they install the same fallback to plywood's own chant.
import { installChantResolveFallback } from "@intentius/chant/chant-install";

installChantResolveFallback(import.meta.url);
