/** The bundle's entry: runs the command line and exits with its code. */
import { installChantResolution } from "./chant-resolve";
import { main } from "./cli";

// plywood#22: the Op files plywood writes import chant; from a global install they resolve from plywood's own.
installChantResolution();
process.exitCode = await main(process.argv.slice(2));
