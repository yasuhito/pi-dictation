import { shellQuote } from "../../src/extensions/shell.js";

const quoted: number = shellQuote("value");
void quoted;
