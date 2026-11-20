import { fileURLToPath } from "node:url";
import { runWordCountMain } from "./word-count.ts";

export {
  DEFAULT_MAX_WORDS,
  DEFAULT_REVIEW_WORDS,
  checkMarkdownWordCounts,
  collectMarkdownFiles,
  countMarkdownWords,
  formatWordCountReport,
  runWordCountCli,
} from "./word-count.ts";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWordCountMain();
}
