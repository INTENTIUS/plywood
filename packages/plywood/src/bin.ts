/** The bundle's entry: runs the command line and exits with its code. */
import { main } from "./cli";

process.exitCode = await main(process.argv.slice(2));
