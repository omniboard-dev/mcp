import * as fs from 'node:fs';
import * as p from 'node:path';
import { DOMParser } from 'xmldom';

const REGEXP_MATCH_NOTHING = /a^/;

export function currentFolderName(): string {
  return p.basename(p.resolve(process.cwd()));
}

export function findFiles(
  includePattern: string,
  includeFlags?: string,
  excludePattern?: string,
  excludeFlags?: string
) {
  const results = [];
  const stack = ['.'];

  const includeRegexp = new RegExp(includePattern, includeFlags);
  const excludeRegexp = excludePattern
    ? new RegExp(excludePattern, excludeFlags)
    : REGEXP_MATCH_NOTHING;

  while (stack.length > 0) {
    const currentPath = stack.pop() as string;
    let paths: string[];

    try {
      paths = fs
        .readdirSync(currentPath)
        .map((nextPath) => p.join(currentPath, nextPath));
    } catch {
      continue;
    }

    const dirs = [];
    const files = [];

    for (const nextPath of paths) {
      const normalizedPath = nextPath.replace(/\\/g, '/');
      if (excludeRegexp.test(normalizedPath)) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(nextPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        continue;
      }

      if (stat.isDirectory()) {
        dirs.push(nextPath);
      } else if (stat.isFile() && includeRegexp.test(normalizedPath)) {
        files.push(nextPath);
      }
    }

    results.push(...files);
    stack.push(...dirs);
  }
  return results;
}

export function readJson(path: string) {
  try {
    const buffer = fs.readFileSync(path);
    return JSON.parse(buffer.toString());
  } catch (err) {
    return undefined;
  }
}

export function fileExists(path: string) {
  try {
    return fs.existsSync(path) && fs.lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function readXmlAsDom(path: string) {
  const buffer = fs.readFileSync(path);
  return new DOMParser().parseFromString(buffer.toString());
}

export function readFile(path: string) {
  const buffer = fs.readFileSync(path);
  return buffer.toString();
}
