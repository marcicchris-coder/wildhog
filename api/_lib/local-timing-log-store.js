import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../../data");
const START_LINE_LOG_FILE = path.join(DATA_DIR, "start-line-log.jsonl");
const FINISH_LINE_LOG_FILE = path.join(DATA_DIR, "finish-line-log.jsonl");

async function ensureDataDirectory() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readExistingEventIds(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return new Set();

    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce((ids, line) => {
        const parsed = JSON.parse(line);
        if (!parsed?.id) {
          throw new Error(`Timing log file ${path.basename(filePath)} contains an entry with no id.`);
        }
        ids.add(String(parsed.id));
        return ids;
      }, new Set());
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

async function appendEventsToFile(filePath, events = []) {
  if (!events.length) return 0;
  await ensureDataDirectory();
  const existingIds = await readExistingEventIds(filePath);
  const nextEvents = events.filter((event) => event?.id && !existingIds.has(String(event.id)));
  if (!nextEvents.length) return 0;
  const lines = `${nextEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await fs.appendFile(filePath, lines, "utf8");
  return nextEvents.length;
}

export async function appendTimingLogFiles({ startEvents = [], finishEvents = [] } = {}) {
  const [startCount, finishCount] = await Promise.all([
    appendEventsToFile(START_LINE_LOG_FILE, startEvents),
    appendEventsToFile(FINISH_LINE_LOG_FILE, finishEvents),
  ]);

  return {
    startCount,
    finishCount,
    files: {
      startLineLog: START_LINE_LOG_FILE,
      finishLineLog: FINISH_LINE_LOG_FILE,
    },
  };
}

